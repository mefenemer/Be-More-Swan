// src/utils/prospect-erasure.ts
// Erase one PROSPECT's personal data across the Lead Generator, on request.
//
// ── Who this is for, and why it is not admin-gdpr-erase.ts ───────────────────
// `admin-gdpr-erase.ts` erases a Be More Swan USER — someone with an account, a login and a
// contractual relationship with us. A prospect has none of those. They never signed up, never agreed
// to anything, and in most cases first heard of the tenant when a cold email arrived. They are a
// third-party data subject whose details were scraped from their own website or bought from a broker,
// which is the weakest footing any data in this product sits on — and until now there was no route to
// erase them at all. The request will arrive by reply to the tenant, not to us, which is why the
// action that calls this is a TENANT action rather than an admin one.
//
// ── The governing decision: erasure KEEPS the opt-out ────────────────────────
// ⚠️ This is the one thing to understand before changing anything here. `lead_opt_outs` is the record
// that STOPS us contacting them, and it is keyed on the very address the request asks us to forget.
// Erase that too and the next discovery run re-finds the same company, re-scrapes the same address,
// and emails the person who asked to be forgotten — the erasure would directly cause the harm it was
// meant to end. So the opt-out row is retained, and one is CREATED if none exists: "erase me" from
// someone we cold-emailed means "and do not come back", and honouring only the first half is worse
// than useless. This is the standard suppression-list carve-out, and it is why the summary reports
// `optOutRetained` rather than staying silent about the row it deliberately left behind.
//
// ── Redaction, not deletion, and why that is the honest choice ───────────────
// Rows are redacted in place rather than deleted. Deleting the `assistant_records` row would cascade
// into the tenant's own funnel history — the ledger events that say a lead was found, approved,
// emailed and lost are the org's records about its OWN activity, and destroying them to erase a third
// party takes something that was never the prospect's. What is removed is everything that identifies
// the person: their address, their name, their words, the intel gathered about them, the social
// profiles found for them, and the embedded memory built from their messages. What remains is a
// shape — "a lead at this company reached this stage" — carrying no personal data.
//
// `scope: 'full'` additionally strips the COMPANY identity (name, domain, website). A limited company
// is not a data subject, so the default leaves it; a sole trader whose company IS their name is, and
// for them the domain is personal data. The caller decides, because only a human can tell those apart.
//
// ── Two keys, because a third of leads have no address ───────────────────────
// The address is the natural key: it is what `lead_opt_outs`, the threads and the enrolments are all
// matched on. But enrichment finds an address for roughly one lead in three, and the other two still
// carry a person — a name, their job title, the colleagues found on their site, a paragraph of
// research quoting them. A request from one of those people had nowhere to go while the only key was
// an address they never gave us. So the erasure also runs from the LEAD RECORD, and every step below
// matches on the address OR the record, whichever the caller had.
//
// ⚠️ That changes what the BLOCK can be, and the block is the part that must not be got wrong. With
// an address, `lead_opt_outs` stops us contacting them and nothing else is needed: the company stays
// a legitimate prospect, and only that person is off limits. With no address there is no such grain —
// the only handle on "and do not come back" is the company's DOMAIN, so the erasure adds it to every
// search's exclusion list. That is a heavier block than the request strictly asked for, and it is
// reported (`domainExcluded`, `campaignsBlocked`) rather than done quietly, because the tenant needs
// to know the whole company just left their pipeline.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// Every step is independent and failures are collected, not raised. A partial erasure that reports
// exactly which tables it could not reach is far more useful to whoever must answer the data subject
// than an exception that leaves them guessing how far it got.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    accountMemory, accountNodes, assistantRecords, discoveredLeads, discoveryGuardrails,
    leadMessages, leadOptOuts, leadThreads, sequenceEnrolments,
} from '../../db/schema';
import { mintReplyToken } from './reply-address';

type Db = ReturnType<typeof getDb>;

/**
 * What replaces a redacted free-text field.
 *
 * Deliberately readable rather than blank. A user opening a thread after an erasure needs to know the
 * message is gone BECAUSE someone asked, not that the product lost it — an empty body reads as a bug
 * and generates a support ticket about data loss.
 */
export const ERASED_TEXT = '[erased at the request of the recipient]';

/** Keys on `assistant_records.data` that can identify the person rather than the company. */
const PERSONAL_RECORD_KEYS = [
    'contactEmail',     // the address itself
    'contactName',
    'emailKind',        // 'personal' vs 'role' — a statement about who the address belongs to
    'emailSource',
    'socialHandles',    // their profiles
    'people',           // named decision-makers found by deep enrichment
    'intel',            // free-text research, which quotes and names individuals
    'hooks',            // personalised openers built from that research
    'notes',            // the tenant's own notes about the person
    'outreachDraft',    // an email written TO them, naming them
    'draftOriginal',
    'lead',             // the raw submitted blob on a hand-added lead
] as const;

/** Additionally removed when the company identity is itself personal data (a sole trader). */
const COMPANY_RECORD_KEYS = ['website', 'companyName', 'domain'] as const;

export interface EraseProspectInput {
    organisationId: number;
    /** The address to erase, any case. Everything is matched on its normalised form. */
    email?: string | null;
    /**
     * The lead record to erase, for a request that names a person we hold no address for.
     *
     * Supply either this or `email` — or both, which is the ordinary case from a screen where the
     * user is looking at the lead. Given only this, an address is looked up from the record, its
     * discovery row and its conversations before the record-keyed path is used, because an erasure
     * that can reach `lead_opt_outs` is always the better one.
     */
    assistantRecordId?: number | null;
    /** 'contact' (default) removes the person; 'full' also removes the company identity. */
    scope?: 'contact' | 'full';
    /** Who asked, for the audit trail. Never stored beside the erased data. */
    requestedBy?: number | null;
}

export interface EraseProspectResult {
    /** The address this ran against, or null when the lead had none and the record was the key. */
    email: string | null;
    assistantRecordId: number | null;
    scope: 'contact' | 'full';
    /** Counts per table, so the tenant can answer "what did you actually remove?". */
    redacted: Record<string, number>;
    /** True when an opt-out now exists for this address — retained or newly created. */
    optOutRetained: boolean;
    /** The domain now excluded from discovery, when the block had to be taken at company grain. */
    domainExcluded: string | null;
    /** How many searches that exclusion was written to. */
    campaignsBlocked: number;
    /**
     * What now stands between this person and the next discovery run.
     *
     * 'none' is a real and legitimate answer, not a failure: a hand-added lead with neither an
     * address nor a website cannot be contacted or re-found by anything, so there is nothing to
     * block. It is reported so that "we blocked nothing" is never inferred from silence.
     */
    blockedBy: 'opt_out' | 'domain_exclusion' | 'none';
    /** Steps that could not be completed. Empty on a clean run. */
    failures: string[];
}

/** Address grain, lowercased and trimmed — the same normalisation lead_opt_outs stores. */
function normalise(email: string): string {
    return String(email || '').trim().toLowerCase();
}

/**
 * Erase one prospect across the lead pipeline.
 *
 * Ordered so the most harmful data goes first: if the process dies halfway, what has already gone is
 * the message content and the addresses, not the counts.
 */
export async function eraseProspect(db: Db, input: EraseProspectInput): Promise<EraseProspectResult> {
    const scope = input.scope === 'full' ? 'full' : 'contact';
    const orgId = input.organisationId;
    const recordId = Number.isInteger(input.assistantRecordId) ? Number(input.assistantRecordId) : null;
    let email = normalise(input.email || '');
    const redacted: Record<string, number> = {};
    const failures: string[] = [];
    let optOutRetained = false;
    let domainExcluded: string | null = null;
    let campaignsBlocked = 0;

    const result = (): EraseProspectResult => ({
        email: email || null,
        assistantRecordId: recordId,
        scope,
        redacted,
        optOutRetained,
        domainExcluded,
        campaignsBlocked,
        blockedBy: optOutRetained ? 'opt_out' : (domainExcluded ? 'domain_exclusion' : 'none'),
        failures,
    });

    const step = async (name: string, fn: () => Promise<number>) => {
        try { redacted[name] = await fn(); }
        catch (err) {
            failures.push(name);
            console.error(`[prospect-erasure] ${name} failed for org ${orgId}`, err);
        }
    };

    // An address that is not one is worse than none at all: it would key an opt-out row on junk and
    // report a block that protects nobody. A caller who has only a record says so by passing only a
    // record.
    if (email && !email.includes('@')) {
        return { ...result(), email: null, failures: ['invalid_email'] };
    }
    if (!email && recordId === null) {
        return { ...result(), failures: ['no_target'] };
    }

    // Match on whichever keys the caller had. ⚠️ Both, whenever both exist: the record's `data` and
    // its discovery row disagree more often than you would like — an address edited by hand on one
    // and not mirrored to the other — and matching on only one of them leaves the other's copy of
    // the address in place, which is an erasure that erases nothing.
    const recordMatch = recordId === null ? undefined : eq(assistantRecords.id, recordId);
    const emailMatch = email ? sql`lower(${assistantRecords.data} ->> 'contactEmail') = ${email}` : undefined;
    const leadEmailMatch = email ? sql`lower(${discoveredLeads.contactEmail}) = ${email}` : undefined;
    const leadRecordMatch = recordId === null ? undefined : eq(discoveredLeads.assistantRecordId, recordId);

    // ── 0. An address, if the record is carrying one we were not given ───────
    // Worth the lookup: an erasure that can write `lead_opt_outs` blocks the person at address grain
    // and leaves the company alone, where the record-keyed path has to block the whole domain. The
    // record's own `data` is the caller's job (they are looking at it); this covers the two copies a
    // screen does not show — the discovery row, and the thread we actually wrote to.
    const [leadRow] = await db
        .select({
            id: discoveredLeads.id,
            domain: discoveredLeads.domain,
            contactEmail: discoveredLeads.contactEmail,
        })
        .from(discoveredLeads)
        .where(and(eq(discoveredLeads.organisationId, orgId), or(leadEmailMatch, leadRecordMatch)))
        .limit(1);

    if (!email && recordId !== null) {
        const [rec] = await db
            .select({ data: assistantRecords.data })
            .from(assistantRecords)
            .where(and(eq(assistantRecords.id, recordId), eq(assistantRecords.organisationId, orgId)))
            .limit(1);
        const data = (rec?.data && typeof rec.data === 'object' && !Array.isArray(rec.data))
            ? rec.data as Record<string, unknown> : {};
        const [threadRow] = await db
            .select({ contactEmail: leadThreads.contactEmail })
            .from(leadThreads)
            .where(and(eq(leadThreads.organisationId, orgId), eq(leadThreads.assistantRecordId, recordId)))
            .limit(1);
        email = normalise(
            (typeof data.contactEmail === 'string' ? data.contactEmail : '')
            || leadRow?.contactEmail
            || threadRow?.contactEmail
            || '',
        );
        if (email && !email.includes('@')) email = '';
    }

    // The company's website, for the block below and for nothing else. Taken from the discovery row
    // first — it is normalised there (lowercased, no www) and it is the value the exclusion list is
    // compared against.
    const recordDomain = await (async () => {
        if (leadRow?.domain) return leadRow.domain;
        if (recordId === null) return null;
        const [rec] = await db
            .select({ data: assistantRecords.data })
            .from(assistantRecords)
            .where(and(eq(assistantRecords.id, recordId), eq(assistantRecords.organisationId, orgId)))
            .limit(1);
        const data = (rec?.data && typeof rec.data === 'object' && !Array.isArray(rec.data))
            ? rec.data as Record<string, unknown> : {};
        return normaliseDomainish(data.domain ?? data.website);
    })();

    // ── 1. The BLOCK comes first, and it is a WRITE, not a deletion ──────────
    // Before anything is removed, make sure the thing that stops us coming back exists. Doing this
    // first means an erasure that fails halfway still leaves them protected — the opposite order
    // could strip every trace and leave nothing to prevent the next run re-finding them.
    if (email) {
        try {
            await db.insert(leadOptOuts).values({
                organisationId: orgId,
                email,
                reason: 'erasure_request',
                // 'manual' is in the source CHECK constraint's vocabulary; a new value would need DDL,
                // and this file must not require a migration to protect someone.
                source: 'manual',
                matchedRule: null,
                evidence: 'Recorded automatically when this address was erased on request.',
            }).onConflictDoNothing();
            optOutRetained = true;
        } catch (err) {
            failures.push('opt_out');
            console.error(`[prospect-erasure] could not record the opt-out for org ${orgId} — ERASURE ABORTED`, err);
            // ⚠️ Hard stop. Erasing their data while failing to record "do not contact" is the one
            // outcome that is strictly worse than doing nothing at all: the trace that protects them
            // would be gone and the address would be re-discoverable. Return with nothing removed.
            return result();
        }
    }

    // The domain exclusion, in the two cases where the opt-out is not the right grain or is not
    // available at all:
    //   • NO ADDRESS. There is no address-grain block to take, so the only way to honour "and do not
    //     come back" is to stop the searches re-finding the company.
    //   • scope 'full'. The caller has told us the company IS the person. It also makes the domain
    //     safe to remove below: `discovered_leads` dedupes on (campaign, domain), so nulling it would
    //     otherwise let the very next run insert the same company as a brand-new lead.
    if (recordDomain && (!email || scope === 'full')) {
        try {
            campaignsBlocked = await excludeDomainOrgWide(db, orgId, recordDomain);
            domainExcluded = recordDomain;
        } catch (err) {
            failures.push('domain_exclusion');
            console.error(`[prospect-erasure] could not exclude ${recordDomain} for org ${orgId} — ERASURE ABORTED`, err);
            // Same hard stop, same reason. Without an opt-out to fall back on, this exclusion is the
            // only thing standing between an erased person and the next discovery run.
            if (!optOutRetained) return result();
        }
    }

    // ⚠️ Neither block available, and that is allowed — but only when there is genuinely nothing to
    // block. No address means nothing can be emailed; no domain means no search can re-find them and
    // nothing can be scraped. A lead with both missing is a name somebody typed in, and erasing it is
    // safe. `blockedBy: 'none'` says so out loud rather than letting the caller assume a block.

    // ── 2. Their words ───────────────────────────────────────────────────────
    // Message bodies are the most sensitive thing here — free text a person wrote, quoted verbatim.
    const threads = await db
        .select({ id: leadThreads.id, assistantRecordId: leadThreads.assistantRecordId, discoveredLeadId: leadThreads.discoveredLeadId })
        .from(leadThreads)
        .where(and(
            eq(leadThreads.organisationId, orgId),
            or(
                email ? eq(leadThreads.contactEmail, email) : undefined,
                recordId === null ? undefined : eq(leadThreads.assistantRecordId, recordId),
            ),
        ));
    const threadIds = threads.map((t) => t.id);

    if (threadIds.length) {
        await step('lead_messages', async () => {
            const rows = await db.update(leadMessages)
                .set({ fromEmail: null, subject: ERASED_TEXT, body: ERASED_TEXT, generatedBody: null })
                .where(and(eq(leadMessages.organisationId, orgId), inArray(leadMessages.leadThreadId, threadIds)))
                .returning({ id: leadMessages.id });
            return rows.length;
        });

        await step('lead_threads', async () => {
            const rows = await db.update(leadThreads)
                .set({
                    contactEmail: null,
                    // ⚠️ The alias token is ROTATED, not cleared — the column is NOT NULL and unique.
                    // Rotating it revokes the old address: mail to the alias they were given no longer
                    // resolves to anything, which is the point. A fresh unguessable value satisfies the
                    // constraint without leaving a live inbound route to an erased conversation.
                    replyToken: mintReplyToken(),
                    state: 'closed',
                    updatedAt: new Date(),
                })
                .where(inArray(leadThreads.id, threadIds))
                .returning({ id: leadThreads.id });
            return rows.length;
        });
    }

    // ── 3. The embedded memory built from those messages ─────────────────────
    // account_memory stores message text AND its vector. A redacted message with a live embedding is
    // still a searchable copy of what they said, so these rows are DELETED rather than blanked.
    //
    // ⚠️ Reachable by address only: the contact node is LABELLED with the email. With no address
    // there is no node to find, and there is also nothing for one to have been built from — the
    // memory is written from messages, and a lead we could not email has none.
    if (email) {
        await step('account_memory', async () => {
            const nodes = await db
                .select({ id: accountNodes.id })
                .from(accountNodes)
                .where(and(
                    eq(accountNodes.organisationId, orgId),
                    eq(accountNodes.nodeType, 'contact'),
                    sql`lower(${accountNodes.label}) = ${email}`,
                ));
            const nodeIds = nodes.map((n) => n.id);
            if (!nodeIds.length) return 0;
            const rows = await db.delete(accountMemory)
                .where(and(eq(accountMemory.organisationId, orgId), inArray(accountMemory.accountNodeId, nodeIds)))
                .returning({ id: accountMemory.id });
            // The contact node itself is the person — remove it too. The ACCOUNT node (the company)
            // stays unless the caller asked for 'full': a company is not a data subject.
            await db.delete(accountNodes).where(inArray(accountNodes.id, nodeIds));
            return rows.length;
        });
    }

    // ── 4. The lead records ──────────────────────────────────────────────────
    // Matched two ways because the same person reaches these tables by two routes: discovery stores
    // the address on `discovered_leads`, and everything else reads it off the record's `data` blob.
    await step('discovered_leads', async () => {
        const patch: Record<string, unknown> = {
            contactName: null,
            contactEmail: null,
            // Signals carry the scraped social handles and any addresses found alongside.
            //
            // ⚠️ `enrichAttemptedAt` is STAMPED, not cleared, and it is the whole reason this write
            // still matters after the address has gone. The nightly enrichment batch selects rows
            // with `contact_email IS NULL` and no stamp — which is precisely what an erased lead now
            // looks like — and would walk back to their website and scrape the address again. The
            // stamp is what makes an erased lead permanently ineligible for that pass.
            signals: sql`COALESCE(${discoveredLeads.signals}, '{}'::jsonb) - 'socialHandles' - 'contactEmail' - 'people' - 'emails'
                         || jsonb_build_object('enrichAttemptedAt', ${new Date().toISOString()}::text)`,
            updatedAt: new Date(),
        };
        // Safe only because the exclusion above was written first: the dedupe key is (campaign,
        // domain), so a null domain would make the same company re-insertable on the next run.
        if (scope === 'full') { patch.companyName = ERASED_TEXT; patch.domain = null; }
        const rows = await db.update(discoveredLeads)
            .set(patch)
            .where(and(eq(discoveredLeads.organisationId, orgId), or(leadEmailMatch, leadRecordMatch)))
            .returning({ id: discoveredLeads.id });
        return rows.length;
    });

    await step('assistant_records', async () => {
        const keys = scope === 'full'
            ? [...PERSONAL_RECORD_KEYS, ...COMPANY_RECORD_KEYS]
            : [...PERSONAL_RECORD_KEYS];
        // `- 'key'` per key, chained: removes each from the jsonb without reading and rewriting the
        // blob in JS, which would race the Review Queue, the edit form and the enrichment pass.
        const strip = keys.map((k) => sql` - ${k}`);
        const patch: Record<string, unknown> = {
            data: sql`COALESCE(${assistantRecords.data}, '{}'::jsonb)${sql.join(strip, sql``)}
                      || jsonb_build_object('erasedAt', ${new Date().toISOString()}::text)`,
            updatedAt: new Date(),
        };
        if (scope === 'full') patch.title = ERASED_TEXT;
        const rows = await db.update(assistantRecords)
            .set(patch)
            .where(and(
                eq(assistantRecords.organisationId, orgId),
                eq(assistantRecords.recordType, 'lead'),
                or(emailMatch, recordMatch),
            ))
            .returning({ id: assistantRecords.id });
        return rows.length;
    });

    // ── 5. Anything still queued to email them ───────────────────────────────
    // Belt and braces: the opt-out above already blocks every send, and closing the threads stops the
    // worker. This removes the address from the enrolment row as well, so no copy of it survives in a
    // table the sender reads.
    await step('sequence_enrolments', async () => {
        const rows = await db.update(sequenceEnrolments)
            .set({ contactEmail: null, state: 'cancelled', updatedAt: new Date() })
            .where(and(
                eq(sequenceEnrolments.organisationId, orgId),
                or(
                    email ? sql`lower(${sequenceEnrolments.contactEmail}) = ${email}` : undefined,
                    recordId === null ? undefined : eq(sequenceEnrolments.assistantRecordId, recordId),
                ),
            ))
            .returning({ id: sequenceEnrolments.id });
        return rows.length;
    });

    return result();
}

/**
 * Domain grain, matching what `discovery_guardrails.excluded_domains` is compared against.
 *
 * The discovery side normalises on insert (lowercase, no scheme, no www, no path) and compares the
 * exclusion list against that form, so an entry written in any other shape silently never matches —
 * a block that reads as applied and stops nothing.
 */
function normaliseDomainish(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim().toLowerCase();
    if (!raw) return null;
    const host = raw.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].trim();
    return host.includes('.') ? host : null;
}

/**
 * Add one domain to every search this organisation runs.
 *
 * ⚠️ ORG-WIDE, not campaign-wide, and that is deliberate. `excluded_domains` lives per campaign, so
 * excluding it on the one search that found them leaves every other search free to find them again
 * next week — and "do not come back" is not a statement about one saved search. This is the same
 * grain `lead_opt_outs` already works at, which is what makes the two blocks equivalent promises.
 *
 * Idempotent: a domain already on a list is left alone, so a second erasure on the same company is
 * not an error and does not grow the array.
 *
 * Returns how many searches were changed, which is what the caller reports to the tenant — "this
 * company will not be found again" is a claim that should come with a number behind it.
 */
async function excludeDomainOrgWide(db: Db, orgId: number, domain: string): Promise<number> {
    const rows = await db
        .select({ id: discoveryGuardrails.id, excludedDomains: discoveryGuardrails.excludedDomains })
        .from(discoveryGuardrails)
        .where(eq(discoveryGuardrails.organisationId, orgId));

    let changed = 0;
    for (const row of rows) {
        const current = Array.isArray(row.excludedDomains)
            ? (row.excludedDomains as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
        if (current.some((d) => normaliseDomainish(d) === domain)) continue;
        await db.update(discoveryGuardrails)
            .set({ excludedDomains: [...current, domain], updatedAt: new Date() })
            .where(eq(discoveryGuardrails.id, row.id));
        changed++;
    }
    return changed;
}
