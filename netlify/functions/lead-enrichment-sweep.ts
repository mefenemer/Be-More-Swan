// netlify/functions/lead-enrichment-sweep.ts
// Re-enrich leads whose intel has gone stale, so a lead's verdict is not frozen at whatever the
// first thin SERP snippet said months ago. Daily cron (netlify.toml, 05:30 UTC).
//
// ── The gap this closes ──────────────────────────────────────────────────────
// Deep enrichment on demand (lead-generation.ts `enrich_lead`) requires someone to press a button
// on a lead they are already looking at — which means it only ever reaches the leads a user already
// suspects are worth more. The leads that most need re-reading are the ones nobody is looking at:
// scored cold in June, sitting in the Enrichment tab, and now hiring, funded, or opening a second
// site. Nothing would ever revisit them.
//
// ── Why this is a separate function from the retention sweep ─────────────────
// They pull in opposite directions and must not share a run. Retention MOVES leads that nobody has
// acted on; this one RE-READS leads to find out whether they should have been acted on. Running
// them together would mean one job deciding a lead is worthless while the other is still finding
// out — and, worse, the ordering would silently determine the answer.
//
// ⚠️ THIS ONE SPENDS REAL MONEY, unattended. Every other sweep in this codebase moves rows about.
// This makes external API calls: up to four searches plus a model call per lead. Every ceiling
// below is therefore an operator env var, never a per-tenant setting the user can raise —
// discovery spend caps are operator-only, and this is the same class of decision.
//
// Config:
//   LEAD_ENRICH_SWEEP_ENABLED    — 'true' to run at all. DEFAULT OFF (see below).
//   LEAD_ENRICH_SWEEP_MAX_LEADS  — leads per run across all tenants (default 25)
//   LEAD_ENRICH_SWEEP_STALE_DAYS — how old intel must be before a re-read (default 30)

import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, adminAuditLog, discoveredLeads, masterAssistants, organisations } from '../../db/schema';
import { deepEnrichLead, INTEL_FIELD } from '../../src/utils/lead-enrichment';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { getIcpSnapshot } from '../../src/utils/icp-snapshot';
import { isSearchConfigured } from '../../src/lib/discovery-search';
import { isRetentionDeleted } from '../../src/config/lead-retention';
import type { SenderIdentity } from '../../src/config/sender-identity';
import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * DEFAULT OFF, and deliberately unlike every other cron in netlify.toml.
 *
 * The others are free — they move rows. This one bills a third party per lead, unattended, on every
 * tenant at once. A default that started spending the moment the file shipped would be the wrong
 * shape of mistake, and it is exactly the reasoning discovery-enrich-provider.ts already applies to
 * the paid address lookup. An operator turns it on once they have looked at what one run costs.
 */
const ENABLED = (process.env.LEAD_ENRICH_SWEEP_ENABLED ?? 'false').toLowerCase() === 'true';

/** Leads per run, across every tenant. Small: this is a trickle, not a backfill. */
const MAX_LEADS = Math.max(0, Number(process.env.LEAD_ENRICH_SWEEP_MAX_LEADS ?? '25'));

/** How stale intel has to be before it is worth paying to refresh. */
const STALE_DAYS = Math.max(1, Number(process.env.LEAD_ENRICH_SWEEP_STALE_DAYS ?? '30'));

type Db = ReturnType<typeof getDb>;

interface Candidate {
    id: number;
    title: string;
    organisationId: number;
    aiAssistantId: number;
    // The workspace's own business, not the assistant's name — see src/config/sender-identity.ts.
    // rescoreWithIntel rewrites the outreach draft, so this pass signs emails too.
    sender: SenderIdentity;
    onboardingContext: unknown;
    data: unknown;
    discoveredLeadId: number | null;
    domain: string | null;
}

/**
 * Which leads are worth paying to re-read.
 *
 * The ordering here IS the product decision, so it is worth stating plainly. Priority goes to leads
 * that are still in play and whose rating is the thing standing between them and being worked:
 *
 *   • Never enriched at all, oldest first — the cohort most likely to be mis-scored, because their
 *     rating came from one search-result snippet and nothing since.
 *   • Then the stalest intel.
 *
 * And the exclusions, each of which would otherwise be money spent on a foregone conclusion:
 *   • RETENTION-DELETED leads. The user's route back for those is the explicit "Send back for
 *     enrichment" button, which already runs this pass. Paying to re-read a graveyard nightly is
 *     the clearest possible waste, and it would also quietly resurrect nothing — the lead stays in
 *     Deleted whatever we learn.
 *   • DO-NOT-CONTACT leads. We may not email them whatever the evidence says.
 *   • Leads with an outcome recorded. The deal is over; its score is history, not a forecast.
 *   • Leads with no domain. Nothing to research.
 */
async function collectCandidates(db: Db, staleBefore: Date): Promise<Candidate[]> {
    const rows = await db
        .select({
            id: assistantRecords.id,
            title: assistantRecords.title,
            organisationId: assistantRecords.organisationId,
            aiAssistantId: assistantRecords.aiAssistantId,
            orgName: organisations.name,
            orgDescription: organisations.businessDescription,
            orgIndustry: organisations.industry,
            orgWebsite: organisations.websiteUrl,
            onboardingContext: aiAssistants.onboardingContext,
            data: assistantRecords.data,
            discoveredLeadId: discoveredLeads.id,
            domain: discoveredLeads.domain,
        })
        .from(assistantRecords)
        .innerJoin(aiAssistants, eq(aiAssistants.id, assistantRecords.aiAssistantId))
        // Joined rather than looked up per lead: the sweep spans orgs, and one join beats
        // twenty-five round trips for a row we are already selecting the assistant's half of.
        .innerJoin(organisations, eq(organisations.id, assistantRecords.organisationId))
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .leftJoin(discoveredLeads, eq(discoveredLeads.assistantRecordId, assistantRecords.id))
        .where(and(
            eq(assistantRecords.recordType, 'lead'),
            // Only roles that actually do this work. A lead record on some other assistant is not
            // this sweep's business.
            eq(masterAssistants.roleKey, 'lead_qualifier'),
            // Archived or deactivated assistants are not working, and spending their owner's money
            // to refresh leads nobody is looking at is the definition of waste. `archivedAt` is
            // checked as well as `isActive`: an archived assistant sits in its 14-day reinstate
            // window still flagged active (purge-archived-assistants.ts is what eventually removes
            // it), so isActive alone would keep billing for a workspace the user has closed down.
            eq(aiAssistants.isActive, true),
            sql`${aiAssistants.archivedAt} IS NULL`,
            isNotNull(discoveredLeads.domain),
            // Never enriched, or enriched long enough ago to have gone stale.
            or(
                sql`${assistantRecords.data} -> '${sql.raw(INTEL_FIELD)}' IS NULL`,
                // ⚠️ `.toISOString()`, NOT the Date. This is a hand-written template, so it bypasses
                // the column mapper that makes the query-builder predicates around it safe — a Date
                // here throws ERR_INVALID_ARG_TYPE inside postgres-js Bind, client-side, and drizzle
                // rethrows it as a "Failed query" that reads like a schema fault. Latent until now
                // only because the sweep reports `skipped: disabled`; it would have failed on the
                // first run after enrichment was switched on.
                sql`(${assistantRecords.data} #>> '{${sql.raw(INTEL_FIELD)},gatheredAt}')::timestamptz < ${staleBefore.toISOString()}`,
            ),
            // Excluded, per the block comment above.
            sql`${assistantRecords.data} ->> 'doNotContact' IS DISTINCT FROM 'true'`,
            sql`${assistantRecords.data} -> 'dealOutcome' IS NULL`,
        ))
        // NULLS FIRST: never-enriched leads before merely-stale ones.
        .orderBy(sql`(${assistantRecords.data} #>> '{${sql.raw(INTEL_FIELD)},gatheredAt}') ASC NULLS FIRST`)
        .limit(MAX_LEADS);

    // The retention exclusion is applied here rather than in SQL. It is a shared predicate
    // (src/config/lead-retention.ts) with one definition, and re-expressing it as a second jsonb
    // path in this query is precisely the hand-copied rule that file exists to prevent. The set is
    // already capped at MAX_LEADS, so filtering in JS costs nothing.
    return rows
        .filter((r) => !isRetentionDeleted(r.data))
        .map(({ orgName, orgDescription, orgIndustry, orgWebsite, ...rest }) => ({
            ...rest,
            sender: {
                businessName: orgName ?? '',
                businessDescription: orgDescription,
                industry: orgIndustry,
                websiteUrl: orgWebsite,
            },
        }));
}

function onboardingOf(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { /* an unparseable context is an empty ICP, not a failed run */ }
    }
    return {};
}

/**
 * The sweep itself, exported so the staging trigger can run it over HTTP (run-lead-sweeps.ts).
 *
 * ⚠️ Netlify fires scheduled functions on the PRODUCTION deploy only, so until this was extractable
 * the deep-enrichment sweep had never run outside prod — and it is the one job in this role that
 * spends money per lead with nobody watching. Being able to exercise it against staging first is the
 * point. Same shape as drainDiscoveryJobs / ingestAccountMemory.
 *
 * Returns a `skipped` reason rather than throwing when either switch is off: the two env gates
 * (LEAD_ENRICH_SWEEP_ENABLED, a configured search provider) are normal states, not failures.
 */
export async function sweepLeadEnrichment(): Promise<Record<string, unknown>> {
    if (!ENABLED) {
        console.log('[lead-enrich-sweep] disabled (LEAD_ENRICH_SWEEP_ENABLED is not "true")');
        return { skipped: 'disabled' };
    }
    // A run with no search provider would still make a model call per lead over an empty evidence
    // set — paying to be told nothing changed. gatherLeadIntel would return only the site
    // fingerprint, which on its own is not grounds for re-rating anyone.
    if (!isSearchConfigured()) {
        console.log('[lead-enrich-sweep] no search provider configured — nothing to gather');
        return { skipped: 'no_search_provider' };
    }

    const db = getDb();
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);

    const candidates = await collectCandidates(db, staleBefore);
    if (!candidates.length) {
        console.log('[lead-enrich-sweep] nothing stale enough to re-read');
        return { enriched: 0 };
    }

    let ran = 0;
    let changed = 0;
    let searchCalls = 0;
    let costGbp = 0;
    const movements: Array<{ lead: string; from: string; to: string }> = [];

    // Sequential, not concurrent. Four searches and a model call per lead, fanned out across
    // twenty-five leads at once, is a burst against two rate-limited third parties — and the
    // failure mode is being throttled mid-run and banking a partial result while the audit row
    // claims a clean sweep. A trickle is the right shape for an unattended spender.
    for (const c of candidates) {
        try {
            const outcome = await deepEnrichLead(db, {
                assistantRecordId: c.id,
                discoveredLeadId: c.discoveredLeadId,
                domain: c.domain,
                sender: c.sender,
                icp: onboardingOf(c.onboardingContext),
                ledger: {
                    organisationId: c.organisationId,
                    aiAssistantId: c.aiAssistantId,
                    blueprintVersion: await getBlueprintVersion(db, c.aiAssistantId),
                    icpSnapshot: await getIcpSnapshot(db, {
                        discoveredLeadId: c.discoveredLeadId,
                        aiAssistantId: c.aiAssistantId,
                    }),
                },
            });
            if (outcome.ran) ran++;
            searchCalls += outcome.searchCallsMade;
            costGbp += outcome.costGbp;
            if (outcome.changed && outcome.previous && outcome.next) {
                changed++;
                movements.push({
                    lead: c.title,
                    from: `${outcome.previous.rating} ${outcome.previous.score}`,
                    to: `${outcome.next.rating} ${outcome.next.score}`,
                });
            }
        } catch (err) {
            // One lead's failure must not cost the other twenty-four theirs. deepEnrichLead already
            // swallows gathering and scoring failures; this catches the database write, which is
            // the only thing in there allowed to throw.
            console.error(`[lead-enrich-sweep] lead ${c.id} failed:`, err);
        }
    }

    await db.insert(adminAuditLog).values({
        adminId: null,
        action: 'lead_enrichment_sweep',
        targetType: 'assistant_records',
        targetId: null,
        newState: {
            staleDays: STALE_DAYS,
            considered: candidates.length,
            enriched: ran,
            ratingsChanged: changed,
            searchCalls,
            // Rounded to the penny it is actually billed in. The point of logging it is so an
            // operator can answer "what is this costing us a month?" without instrumenting anything.
            costGbp: Math.round(costGbp * 1000) / 1000,
            movements: movements.slice(0, 50),
            maxLeads: MAX_LEADS,
            hitCap: candidates.length === MAX_LEADS,
        },
    });

    console.log(`[lead-enrich-sweep] re-read ${ran} lead(s), ${changed} rating(s) changed, £${costGbp.toFixed(3)}`);
    return { enriched: ran, ratingsChanged: changed, costGbp };
}

export default withLambda(async () => {
    const result = await sweepLeadEnrichment();
    return { statusCode: 200, body: JSON.stringify(result) };
});
