// netlify/functions/process-account-memory.ts
// Populates the account graph and memory from what the pipeline already recorded. Phase 3, §5.3.
//
// Nothing calls into the graph on the hot path. Outreach sends, replies land, deals close — and
// this worker turns that history into structure afterwards. That is deliberate: memory is an
// OBSERVER, and putting an embedding round trip inside the send path would make a provider outage
// into a failure to email a prospect.
//
// Three passes per tick, cheapest first:
//   1. RESOLVE — discovered_leads with a domain but no account node get one, plus a contact node
//      and a works_at edge when there is a contact email.
//   2. MESSAGES — lead_messages with no account_memory row get one, embedded in a single batch.
//   3. OUTCOMES — terminal revenue_events (won/lost/disqualified) get a memory row, because "we
//      lost this one on price in March" is exactly what the Phase 5 strategy agent needs to recall.
//
// ── Idempotency is structural, not bookkept ─────────────────────────────────
// There is no cursor and no "ingested" column. Each pass LEFT JOINs its source table against
// account_memory on (source_type, source_id) and takes what is missing, and
// account_memory_source_uidx makes a concurrent double-insert impossible. So a crashed tick, a
// replayed tick and a manual re-run all converge — and adding a marker column later would be a
// strictly weaker guarantee that can drift from the rows it claims to describe.
//
// Never throws out of the drain loop: one bad organisation must not stop the rest.

import { withLambda } from '@netlify/aws-lambda-compat';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { upsertAccountNode, upsertContactNode, domainFromEmail, normaliseAccountDomain } from '../../src/utils/account-graph';
import { writeMemories } from '../../src/utils/account-memory';
import { INGEST_BATCH_SIZE, INGEST_BUDGET_MS } from '../../src/config/account-graph';

type Db = ReturnType<typeof getDb>;

export interface IngestResult { resolved: number; messages: number; outcomes: number }

// ── Pass 1: identity resolution ──────────────────────────────────────────────

interface LeadRow extends Record<string, unknown> {
    id: number; organisation_id: number; company_name: string;
    domain: string | null; contact_name: string | null; contact_email: string | null;
}

/**
 * Give every discovered lead with a usable domain an account node.
 *
 * Only leads that have progressed past `discovered` are resolved. A raw discovery hit is a
 * candidate, not a company we have a relationship with — building nodes for all of them would fill
 * the graph with companies nobody ever contacted and make every traversal noisier.
 */
async function resolveIdentities(db: Db, limit: number): Promise<number> {
    const rows = await db.execute<LeadRow>(sql`
        SELECT dl.id, dl.organisation_id, dl.company_name, dl.domain,
               dl.contact_name, dl.contact_email
          FROM discovered_leads dl
         WHERE dl.status IN ('qualified','promoted')
           AND (dl.domain IS NOT NULL OR dl.contact_email IS NOT NULL)
           AND NOT EXISTS (
                SELECT 1 FROM account_nodes n
                 WHERE n.organisation_id = dl.organisation_id
                   AND n.node_type = 'account'
                   AND n.domain = COALESCE(dl.domain, split_part(dl.contact_email, '@', 2)))
         ORDER BY dl.id
         LIMIT ${limit}
    `);

    let resolved = 0;
    for (const lead of Array.from(rows as unknown as LeadRow[])) {
        // The lead's own domain wins; an email domain is the fallback. A free-mail address is a
        // person, not a company — resolving gmail.com as an ACCOUNT would collapse every unrelated
        // prospect who used a personal address into one node.
        const domain = normaliseAccountDomain(lead.domain) ?? domainFromEmail(lead.contact_email);
        if (!domain || FREE_MAIL.has(domain)) continue;

        const account = await upsertAccountNode(db, lead.organisation_id, {
            domain,
            label: lead.company_name,
            attributes: { discoveredLeadId: lead.id },
        });
        if (!account) continue;
        resolved++;

        if (lead.contact_email || lead.contact_name) {
            await upsertContactNode(db, lead.organisation_id, {
                label: lead.contact_name || lead.contact_email || 'Unknown contact',
                email: lead.contact_email,
                accountNodeId: account.id,
            });
        }
    }
    return resolved;
}

/**
 * Free-mail domains never become ACCOUNT nodes.
 *
 * Without this, every prospect who replied from a personal address collapses into a single
 * "gmail.com" account holding hundreds of unrelated companies' memory — which then poisons every
 * kNN search scoped to that node.
 */
const FREE_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
    'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com',
    'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com',
]);

// ── Pass 2: messages ─────────────────────────────────────────────────────────

interface MessageRow extends Record<string, unknown> {
    id: number; organisation_id: number; direction: string; subject: string | null;
    body: string; occurred_at: Date; contact_email: string | null; domain: string | null;
}

async function ingestMessages(db: Db, limit: number): Promise<number> {
    const rows = await db.execute<MessageRow>(sql`
        SELECT m.id, m.organisation_id, m.direction, m.subject, m.body, m.occurred_at,
               COALESCE(m.from_email, t.contact_email) AS contact_email,
               n.domain
          FROM lead_messages m
          JOIN lead_threads t ON t.id = m.lead_thread_id
          LEFT JOIN account_nodes n
                 ON n.organisation_id = m.organisation_id
                AND n.node_type = 'account'
                AND n.domain = split_part(COALESCE(t.contact_email, ''), '@', 2)
         WHERE NOT EXISTS (
                SELECT 1 FROM account_memory am
                 WHERE am.organisation_id = m.organisation_id
                   AND am.source_type = 'message'
                   AND am.source_id = m.id)
         ORDER BY m.id
         LIMIT ${limit}
    `);

    const list = Array.from(rows as unknown as MessageRow[]);
    if (!list.length) return 0;

    // Resolve each message's account node once, then write the whole batch in ONE embedding call.
    const inputs = [] as Array<Parameters<typeof writeMemories>[1][number]>;
    for (const m of list) {
        const domain = normaliseAccountDomain(m.domain) ?? domainFromEmail(m.contact_email);
        let nodeId: number | null = null;
        if (domain && !FREE_MAIL.has(domain)) {
            const node = await upsertAccountNode(db, m.organisation_id, { domain, label: domain });
            nodeId = node?.id ?? null;
        }

        // Direction is prefixed into the CONTENT, not left to a column, because the embedding is
        // what retrieval matches on: "we told them" and "they told us" are different facts, and a
        // vector built from the body alone cannot distinguish them.
        const who = m.direction === 'outbound' ? 'We wrote' : 'They replied';
        const subject = m.subject ? `about "${m.subject}"` : '';
        inputs.push({
            organisationId: m.organisation_id,
            accountNodeId: nodeId,
            sourceType: 'message',
            sourceId: m.id,
            content: `${who} ${subject}\n\n${m.body}`.trim(),
            occurredAt: m.occurred_at instanceof Date ? m.occurred_at : new Date(m.occurred_at),
        });
    }

    const written = await writeMemories(db, inputs);
    return written.filter((id) => id !== null).length;
}

// ── Pass 3: outcomes ─────────────────────────────────────────────────────────

interface OutcomeRow extends Record<string, unknown> {
    id: number; organisation_id: number; outcome: string; loss_reason: string | null;
    value_gbp: string | null; cycle_days: number | null; occurred_at: Date;
    discovered_lead_id: number | null; domain: string | null;
}

async function ingestOutcomes(db: Db, limit: number): Promise<number> {
    const rows = await db.execute<OutcomeRow>(sql`
        SELECT re.id, re.organisation_id, re.outcome, re.loss_reason, re.value_gbp,
               re.cycle_days, re.occurred_at, re.discovered_lead_id, dl.domain
          FROM revenue_events re
          LEFT JOIN discovered_leads dl ON dl.id = re.discovered_lead_id
         WHERE re.outcome IS NOT NULL
           AND NOT EXISTS (
                SELECT 1 FROM account_memory am
                 WHERE am.organisation_id = re.organisation_id
                   AND am.source_type = 'outcome'
                   AND am.source_id = re.id)
         ORDER BY re.id
         LIMIT ${limit}
    `);

    const list = Array.from(rows as unknown as OutcomeRow[]);
    if (!list.length) return 0;

    const inputs = [] as Array<Parameters<typeof writeMemories>[1][number]>;
    for (const o of list) {
        const domain = normaliseAccountDomain(o.domain);
        let nodeId: number | null = null;
        if (domain && !FREE_MAIL.has(domain)) {
            const node = await upsertAccountNode(db, o.organisation_id, { domain, label: domain });
            nodeId = node?.id ?? null;
        }

        // Written as a sentence rather than a JSON blob: this row gets EMBEDDED, and "we lost this
        // deal because the price was too high" retrieves for a question about pricing objections
        // where {"outcome":"lost","loss_reason":"price"} does not.
        const parts = [`This deal was ${o.outcome}.`];
        if (o.loss_reason) parts.push(`The reason recorded was ${o.loss_reason.replace(/_/g, ' ')}.`);
        if (o.value_gbp) parts.push(`Value: £${o.value_gbp}.`);
        if (o.cycle_days !== null) parts.push(`It took ${o.cycle_days} days from first touch.`);

        inputs.push({
            organisationId: o.organisation_id,
            accountNodeId: nodeId,
            sourceType: 'outcome',
            sourceId: o.id,
            content: parts.join(' '),
            occurredAt: o.occurred_at instanceof Date ? o.occurred_at : new Date(o.occurred_at),
        });
    }

    const written = await writeMemories(db, inputs);
    return written.filter((id) => id !== null).length;
}

// ── The drain loop ───────────────────────────────────────────────────────────

export async function ingestAccountMemory(): Promise<IngestResult> {
    const result: IngestResult = { resolved: 0, messages: 0, outcomes: 0 };
    const startedAt = Date.now();

    let db: Db;
    try { db = getDb(); } catch (err) {
        console.error('[account-memory-worker] no database handle', err);
        return result;
    }

    const passes: Array<[keyof IngestResult, (db: Db, limit: number) => Promise<number>]> = [
        ['resolved', resolveIdentities],
        ['messages', ingestMessages],
        ['outcomes', ingestOutcomes],
    ];

    for (const [key, fn] of passes) {
        if (Date.now() - startedAt > INGEST_BUDGET_MS) {
            console.log('[account-memory-worker] budget reached, stopping cleanly', result);
            break;
        }
        try {
            result[key] = await fn(db, INGEST_BATCH_SIZE);
        } catch (err) {
            // A missing table means db/account-graph.sql has not been applied. Log and continue
            // rather than erroring the scheduled invocation.
            const pg = err as { code?: string; cause?: { code?: string } };
            const code = pg?.code ?? pg?.cause?.code;
            if (code === '42P01') {
                console.error('[account-memory-worker] account graph tables missing — apply db/account-graph.sql');
                break;
            }
            console.error(`[account-memory-worker] pass "${key}" failed`, { pgCode: code, cause: pg?.cause }, err);
        }
    }

    return result;
}

export default withLambda(async () => {
    const r = await ingestAccountMemory();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) };
});
