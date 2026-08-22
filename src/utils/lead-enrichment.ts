// src/utils/lead-enrichment.ts
// The ONE writer of an enrichment outcome, and the on-demand pass that a user can trigger.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `recordEnrichment` lived inside netlify/functions/process-discovery-jobs.ts, because the
// discovery worker was the only thing that had ever enriched a lead. That is no longer true:
// "Send back for enrichment" on the Deleted section runs a pass on one lead, immediately, outside
// any job. The obvious move — copy the persistence out of the worker — would have created a
// second writer of `enrichAttemptedAt`, `contactEmail`, `emailKind`, `emailSource` and
// `socialHandles`, across TWO tables that have to agree (src/config/lead-contact-state.ts holds
// the Searches aggregate and the Enrichment table in step by reading both).
//
// The notify.ts rule applies: one write path, or the vocabularies stop being enforceable. So the
// function moved here whole and the worker imports it.
//
// ── What enrichment could not reach before ───────────────────────────────────
// `enrichBatch` selects `FROM discovered_leads`, so a CSV-imported or hand-added lead had never
// been enriched by anything, ever — there is no discovery row to select. `enrichOneLead` below
// takes the domain from whichever source has one, so those leads are reachable for the first time.

import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { assistantRecords, discoveredLeads } from '../../db/schema';
import { recordEvent } from './revenue-ledger';
import { enrichLeadContact } from '../lib/discovery-enrich';
import { isEnrichProviderConfigured, lookupProviderContact } from '../lib/discovery-enrich-provider';
import { gatherLeadIntel, nameAppearsInSources, hasIntelWorthScoring, LEAD_INTEL_SEARCHES } from '../lib/lead-intel';
import { rescoreWithIntel, normaliseLeadCard, type LeadScoringCard, type DecisionMaker, type InterpretedSignal } from '../lib/discovery-scoring';
import type { SenderIdentity } from '../config/sender-identity';

type Db = ReturnType<typeof getDb>;

export interface EnrichmentLedgerContext {
    organisationId: number;
    aiAssistantId: number;
    blueprintVersion?: string | null;
    icpSnapshot?: Record<string, unknown> | null;
}

export interface EnrichmentFound {
    contact: { email: string; kind: string; source: string; foundOn: string } | null;
    handles: Record<string, string>;
}

/**
 * Persist one enrichment outcome. Always stamps `enrichAttemptedAt` (so a miss isn't
 * retried forever) and mirrors that stamp — plus, on a hit, the address — onto the linked
 * assistant_record, so lead-generation.ts `send_outreach` resolves `data.contactEmail` with no
 * change there and the Enrichment tab can say which leads have actually been looked at.
 *
 * `socialHandles` rides the SAME merge as the address, deliberately. A handle is worth most on the
 * leads where the email search MISSED — "no published address, here is their LinkedIn" — so it must
 * survive the miss path, which the existing `stamp` object already does. It is written only when a
 * profile was actually found; an empty object would make `socialHandles` present-but-useless and
 * every UI check would then have to test the object's size rather than its existence.
 *
 * `leadId` is nullable now that this is shared: a hand-added lead has no `discovered_leads` row,
 * and the discovery-side write is simply skipped for it. The record-side write is the one that
 * every UI surface reads, and it happens either way.
 */
export async function recordEnrichment(
    db: Db, leadId: number | null, assistantRecordId: number | null,
    found: EnrichmentFound,
    ledger?: EnrichmentLedgerContext,
    paidAttempted = false,
): Promise<void> {
    const hit = found.contact;
    const handles = found.handles ?? {};
    const stamp: Record<string, unknown> = { enrichAttemptedAt: new Date().toISOString() };
    // ⚠️ Written on a MISS as well as a hit, and that is the point: this stamp is what the
    // per-run cap counts, so it has to record money SPENT rather than addresses found. It also
    // stops a later slice paying a second time for a domain the provider already had nothing for.
    if (paidAttempted) stamp.paidLookupAt = new Date().toISOString();
    if (hit) {
        stamp.emailKind = hit.kind;        // 'role' | 'personal' — personal needs a closer look
        stamp.emailSource = hit.source;    // 'scrape' | 'provider' — drives the personal-inbox gate
        stamp.emailFoundOn = hit.foundOn;  // provenance for the Review Queue
    }
    if (Object.keys(handles).length > 0) stamp.socialHandles = handles;

    if (leadId !== null) {
        await db.update(discoveredLeads)
            .set({
                ...(hit ? { contactEmail: hit.email } : {}),
                // Merge into signals rather than replacing — it already holds the SERP snippet.
                signals: sql`COALESCE(${discoveredLeads.signals}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
                updatedAt: new Date(),
            })
            .where(eq(discoveredLeads.id, leadId));
    }

    // Revenue ledger: only a HIT is an enrichment event. A miss is not a fact about the lead worth
    // aggregating — it is a fact about our scraper — and emitting it would make "enrichment rate"
    // read as 100% of attempts. `emailKind` rides along because the personal-inbox gate keys off it,
    // so the ledger can later answer whether role addresses convert better than personal ones.
    //
    // ⚠️ A handles-only outcome emits NOTHING, on purpose. `lead_enriched` is the metric for "this
    // lead became contactable by the machine", and a social profile does not make one contactable —
    // no code path in this platform can send to it. Counting it would inflate the one number that
    // says whether tier-1 enrichment is worth its fetches.
    if (hit && ledger) {
        await recordEvent(db, 'lead_enriched', {
            organisationId: ledger.organisationId,
            aiAssistantId: ledger.aiAssistantId,
            discoveredLeadId: leadId,
            assistantRecordId,
            actor: 'agent',
            blueprintVersion: ledger.blueprintVersion ?? null,
            icpSnapshot: ledger.icpSnapshot ?? null,
            payload: { emailKind: hit.kind, emailSource: hit.source },
        });
    }

    if (!assistantRecordId) return;

    // Same merge on the mirrored record's scoring card, so the Review Queue and the
    // outreach send both see the address.
    //
    // ⚠️ The ATTEMPT stamp crosses over on a MISS too — `stamp` already carries
    // `enrichAttemptedAt` either way. Without it the Enrichment tab could not tell "we looked and
    // this company publishes no address" from "nobody has looked yet", and those are different
    // facts with different remedies: the first sends the user off to find an address by hand, the
    // second says the lead scored cold and it is the TARGETING that needs fixing. The Contact
    // column (assistant-data-hub.js `contactState`) reads exactly this key.
    //
    // Deliberately unlike the revenue ledger above, which stays hit-only. That measures our
    // scraper's hit RATE; counting misses there would report every attempt as a success. Mirroring
    // state onto the record the UI reads is a different job from emitting a fact to aggregate.
    await db.update(assistantRecords)
        .set({
            data: sql`COALESCE(${assistantRecords.data}, '{}'::jsonb) || ${JSON.stringify({
                ...stamp,
                ...(hit ? { contactEmail: hit.email } : {}),
            })}::jsonb`,
            updatedAt: new Date(),
        })
        .where(eq(assistantRecords.id, assistantRecordId));
}

export interface OnDemandEnrichmentResult {
    /** Did we end up with an address we did not have before? */
    found: boolean;
    email: string | null;
    /** 'role' | 'personal', when an address was found. */
    kind: string | null;
    /** Social profiles picked up along the way — links for a human, never a send target. */
    handles: Record<string, string>;
    /** Was the paid provider actually called? False whenever it is unconfigured (the normal state). */
    paidAttempted: boolean;
}

/**
 * Enrich ONE lead, right now, on a user's say-so.
 *
 * The same two tiers the worker runs, in the same order — read the company's own site, then buy an
 * address only if that found nothing and a provider is configured — so a lead enriched from a
 * button is indistinguishable from one enriched by a run. Anything else would mean two definitions
 * of "enriched" and two hit rates to reconcile.
 *
 * ⚠️ NEVER THROWS on a scrape or provider failure. The caller is a request handler answering a
 * button press: the correct outcome of "we looked and the site was down" is a lead that reads
 * "we looked and found nothing", not a 500 over a lead the user was trying to rescue. Only a
 * database write is allowed to fail loudly, because that one means the state on screen is a lie.
 *
 * ⚠️ SPENDS MONEY, with no run budget above it. Inside a job, the paid tier is capped per run
 * (maxEnrichmentCallsPerRun) because a run enriches a batch unattended. This path is one lead per
 * deliberate human click, which is its own cap — but it means a user clicking twenty times spends
 * twenty lookups. If that ever needs a ceiling it belongs at the call site, where the identity of
 * the clicker is known, not in here.
 */
export async function enrichOneLead(
    db: Db,
    opts: {
        domain: string | null;
        discoveredLeadId: number | null;
        assistantRecordId: number | null;
        ledger?: EnrichmentLedgerContext;
        /** Skip the paid tier even when one is configured. */
        allowPaid?: boolean;
    },
): Promise<OnDemandEnrichmentResult> {
    const empty: OnDemandEnrichmentResult = { found: false, email: null, kind: null, handles: {}, paidAttempted: false };
    if (!opts.domain) return empty;

    // ── Tier 1: read their own site ──
    let found: EnrichmentFound = { contact: null, handles: {} };
    try {
        found = await enrichLeadContact(opts.domain) as EnrichmentFound;
    } catch {
        // Best-effort, exactly as the worker treats it.
    }

    // ── Tier 2: buy one, only on a miss ──
    let paidAttempted = false;
    if (!found.contact && opts.allowPaid !== false && isEnrichProviderConfigured()) {
        paidAttempted = true;
        try {
            const bought = await lookupProviderContact(opts.domain);
            if (bought) {
                found = {
                    // `foundOn` is the provider's name for a bought address — the same shape the
                    // worker writes, so `emailSource: 'provider'` and the personal-inbox gate
                    // downstream behave identically whichever path produced the lead.
                    contact: { email: bought.email, kind: bought.kind, source: 'provider', foundOn: bought.provider },
                    handles: found.handles,
                };
            }
        } catch {
            // The provider contract is never-throws, but a caller must not depend on a third
            // party's promise about its own error handling.
        }
    }

    await recordEnrichment(db, opts.discoveredLeadId, opts.assistantRecordId, found, opts.ledger, paidAttempted);

    return {
        found: Boolean(found.contact),
        email: found.contact?.email ?? null,
        kind: found.contact?.kind ?? null,
        handles: found.handles ?? {},
        paidAttempted,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// DEEP ENRICHMENT — the pass that can change a lead's TEMPERATURE
// ────────────────────────────────────────────────────────────────────────────
//
// Contact enrichment above answers "can we reach them?". This answers "are they worth reaching?",
// which is the question the Lead Generator's whole funnel turns on and which nothing in this
// product could previously revisit. A lead scored 42 from one thin SERP snippet held that 42 for
// the life of the account.
//
// Three stages, and the boundary between the first two is load-bearing:
//   1. GATHER   (src/lib/lead-intel.ts)      — no model, extraction only, every claim has a URL.
//   2. INTERPRET(src/lib/discovery-scoring.ts rescoreWithIntel) — one model call over that evidence.
//   3. PERSIST  (here)                       — verify, merge, emit.
//
// Stage 3 is not a formality. It is where the fabrication guard actually bites: a person the model
// returned is dropped unless their name appears verbatim in the page text stage 1 collected. See
// `verifyPeople` below.

/** Per-lead ceiling on search spend, operator-set. Never surfaced to or chosen by the user. */
const DEEP_SEARCHES_PER_LEAD = Math.max(0, Number(process.env.LEAD_INTEL_SEARCHES_PER_LEAD ?? String(LEAD_INTEL_SEARCHES)));

/** Where the gathered intel lives on the record's `data`. */
export const INTEL_FIELD = 'intel';

export interface DeepEnrichmentResult {
    /** Did the pass actually run? False when there was no domain, or nothing worth scoring. */
    ran: boolean;
    /** Did the score or rating change? */
    changed: boolean;
    previous: { score: number; rating: string } | null;
    next: { score: number; rating: string } | null;
    signals: InterpretedSignal[];
    people: DecisionMaker[];
    hooks: string[];
    searchCallsMade: number;
    costGbp: number;
    /** A sentence for the user. Always set, including on the paths where nothing happened. */
    message: string;
}

const NOT_RUN = (message: string): DeepEnrichmentResult => ({
    ran: false, changed: false, previous: null, next: null,
    signals: [], people: [], hooks: [], searchCallsMade: 0, costGbp: 0, message,
});

/**
 * Keep only the people whose names genuinely appear in the pages we read.
 *
 * ⚠️ THE FABRICATION GUARD, and the reason stage 1 returns source text at all. Asked for the
 * leadership of a company whose team page it could not read, a model will happily produce a
 * plausible managing director. That name would then be shown to the user as fact, and — worse —
 * fed to the outreach drafter, which would address a real company by a person who does not work
 * there. Verification is cheap and absolute: the string was in the page, or the person goes.
 *
 * The dropped names are logged rather than silently discarded, because a rate that climbs is the
 * signal that the prompt has drifted.
 */
function verifyPeople(people: DecisionMaker[], sources: Array<{ url: string; text: string }>): DecisionMaker[] {
    const kept: DecisionMaker[] = [];
    const dropped: string[] = [];
    for (const p of people) {
        if (nameAppearsInSources(p.name, sources)) kept.push(p); else dropped.push(p.name);
    }
    if (dropped.length) {
        console.warn(`[lead-enrichment] dropped ${dropped.length} unverifiable name(s): ${dropped.join(', ')}`);
    }
    return kept;
}

/**
 * Run the deep pass on ONE lead: gather evidence, re-read the lead against it, persist.
 *
 * ⚠️ NEVER THROWS on gathering or scoring. Both callers are user-facing (a button, a nightly
 * sweep), and the correct outcome of "the search provider was down" is a lead that did not change,
 * not a 500. Only the database write is allowed to fail loudly.
 *
 * ⚠️ SPENDS MONEY: up to DEEP_SEARCHES_PER_LEAD searches plus one model call, per lead. The caller
 * owns the decision to spend it — this function has no idea whether it is being called once from a
 * button or five hundred times from a sweep, so the per-run ceiling belongs at the call site.
 */
export async function deepEnrichLead(
    db: Db,
    opts: {
        assistantRecordId: number;
        discoveredLeadId: number | null;
        domain: string | null;
        // Who the workspace's own business is — see src/config/sender-identity.ts. Was
        // `assistantName`, which named the ASSISTANT rather than the business it works for.
        sender: SenderIdentity;
        icp: Record<string, unknown>;
        ledger?: EnrichmentLedgerContext;
        maxSearches?: number;
    },
): Promise<DeepEnrichmentResult> {
    if (!opts.domain) {
        return NOT_RUN('There is no website on file for this company, so there was nothing to research.');
    }

    // The card as it stands. Read fresh rather than taken from the caller: this row is written by
    // the Review Queue, the Edit form and the contact-enrichment pass, and re-scoring from a stale
    // copy would silently revert whichever of them committed most recently.
    const [rec] = await db
        .select({ id: assistantRecords.id, title: assistantRecords.title, data: assistantRecords.data })
        .from(assistantRecords)
        .where(eq(assistantRecords.id, opts.assistantRecordId))
        .limit(1);
    if (!rec) return NOT_RUN('That lead no longer exists.');

    const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data))
        ? rec.data as Record<string, unknown> : {};
    const current: LeadScoringCard = normaliseLeadCard(data, rec.title || 'Unnamed lead');

    const intel = await gatherLeadIntel(opts.domain, rec.title || opts.domain, {
        maxSearches: opts.maxSearches ?? DEEP_SEARCHES_PER_LEAD,
    });

    if (!hasIntelWorthScoring(intel)) {
        // Stamp the attempt even so. Without it the cadence sweep would revisit this lead every
        // night forever, paying for the same four searches to learn the same nothing.
        await stampIntel(db, opts.assistantRecordId, {
            gatheredAt: intel.gatheredAt, signals: [], people: [], hooks: [],
            platforms: intel.fingerprint.platforms, hasCareersPage: intel.fingerprint.hasCareersPage,
            pagesRead: intel.fingerprint.pagesRead, changeSummary: null,
        });
        return {
            ...NOT_RUN('We looked, and there is nothing new published about this company that would change its rating.'),
            searchCallsMade: intel.searchCallsMade,
            costGbp: intel.costGbp,
        };
    }

    const rescored = await rescoreWithIntel(current, {
        evidence: intel.evidence,
        peopleSources: intel.peopleSources,
        fingerprint: { platforms: intel.fingerprint.platforms, hasCareersPage: intel.fingerprint.hasCareersPage },
    }, opts.icp, opts.sender, { domain: opts.domain });

    // A failed or unusable re-score leaves the lead exactly as it was. Deliberately NOT a fallback
    // to some default: the existing score is a real judgement, and overwriting it with a guess
    // produces a number that looks just as authoritative and is not.
    if (!rescored.card) {
        await stampIntel(db, opts.assistantRecordId, {
            gatheredAt: intel.gatheredAt, signals: [], people: [], hooks: [],
            platforms: intel.fingerprint.platforms, hasCareersPage: intel.fingerprint.hasCareersPage,
            pagesRead: intel.fingerprint.pagesRead, changeSummary: null,
        });
        return {
            ...NOT_RUN('We gathered new information but could not re-read the lead just now. Its rating is unchanged.'),
            searchCallsMade: intel.searchCallsMade,
            costGbp: intel.costGbp,
        };
    }

    const people = verifyPeople(rescored.people, intel.peopleSources);
    const next = rescored.card;
    const changed = next.score !== current.score || next.rating !== current.rating;

    // Merge, never replace. `data` also carries the contact address, the emailKind provenance, the
    // retention stamp and the deal outcome — none of which this pass has any business rewriting.
    // The card fields are updated; everything else on the object survives untouched.
    await db.update(assistantRecords)
        .set({
            data: sql`COALESCE(${assistantRecords.data}, '{}'::jsonb) || ${JSON.stringify({
                score: next.score,
                rating: next.rating,
                reasons: next.reasons,
                suggestedNextStep: next.suggestedNextStep,
                // The refreshed draft only replaces the old one when the model wrote one. A cold
                // re-score returns null, and nulling a draft a human may have edited would destroy
                // their work to record a downgrade.
                ...(next.outreachDraft ? { outreachDraft: next.outreachDraft } : {}),
                [INTEL_FIELD]: {
                    gatheredAt: intel.gatheredAt,
                    signals: rescored.signals,
                    people,
                    hooks: rescored.hooks,
                    platforms: intel.fingerprint.platforms,
                    hasCareersPage: intel.fingerprint.hasCareersPage,
                    pagesRead: intel.fingerprint.pagesRead,
                    // What moved, in one sentence, kept beside the evidence that moved it. This is
                    // the whole answer to "why is this warm now when it was cold last week?".
                    changeSummary: changed
                        ? `${current.rating} ${current.score} → ${next.rating} ${next.score}`
                        : null,
                    previousScore: current.score,
                    previousRating: current.rating,
                },
            })}::jsonb`,
            // The rating column is the Enrichment table's own "Rating" cell and the Searches
            // aggregate reads it too — leaving it stale would show a cold chip over a card that now
            // says 78.
            status: next.rating,
            updatedAt: new Date(),
        })
        .where(eq(assistantRecords.id, opts.assistantRecordId));

    // Keep the discovery row in step. `enrichBatch` and the Searches aggregate both read it, and a
    // lead that is warm on one surface and cold on the other is the drift src/config/
    // lead-contact-state.ts exists to prevent.
    if (opts.discoveredLeadId !== null) {
        await db.update(discoveredLeads)
            .set({ score: next.score, rating: next.rating, scoringCard: next, updatedAt: new Date() })
            .where(eq(discoveredLeads.id, opts.discoveredLeadId));
    }

    // `lead_scored` again, not a new event type. The vocabulary is CHECK-constrained in
    // db/revenue-events.sql and applied by hand, so a new value would be code ahead of schema on
    // whichever environment had not been migrated — and "how did this lead's score move over time?"
    // is answerable by ordering the lead_scored rows, which is what the Strategy Agent wants.
    // `rescore: true` and the previous score are what distinguish this from the original.
    if (opts.ledger && changed) {
        await recordEvent(db, 'lead_scored', {
            organisationId: opts.ledger.organisationId,
            aiAssistantId: opts.ledger.aiAssistantId,
            discoveredLeadId: opts.discoveredLeadId,
            assistantRecordId: opts.assistantRecordId,
            actor: 'agent',
            blueprintVersion: opts.ledger.blueprintVersion ?? null,
            icpSnapshot: opts.ledger.icpSnapshot ?? null,
            payload: {
                score: next.score, rating: next.rating,
                previousScore: current.score, previousRating: current.rating,
                rescore: true, signalCount: rescored.signals.length, source: 'deep_enrichment',
            },
        });
    }

    return {
        ran: true,
        changed,
        previous: { score: current.score, rating: current.rating },
        next: { score: next.score, rating: next.rating },
        signals: rescored.signals,
        people,
        hooks: rescored.hooks,
        searchCallsMade: intel.searchCallsMade,
        costGbp: intel.costGbp,
        message: changed
            ? `Re-read this lead against ${rescored.signals.length} new finding${rescored.signals.length === 1 ? '' : 's'}: ${current.rating} ${current.score} → ${next.rating} ${next.score}.`
            : `Re-read this lead against what we found. Its rating is unchanged at ${next.rating} ${next.score}.`,
    };
}

/**
 * Record that we looked, even when we found nothing.
 *
 * Without this the cadence sweep has no memory of a barren lead and would pay for the same four
 * searches against the same silent company every night for the life of the account.
 */
async function stampIntel(db: Db, assistantRecordId: number, intel: Record<string, unknown>): Promise<void> {
    await db.update(assistantRecords)
        .set({
            data: sql`jsonb_set(
                COALESCE(${assistantRecords.data}, '{}'::jsonb),
                '{${sql.raw(INTEL_FIELD)}}',
                ${JSON.stringify(intel)}::jsonb,
                true
            )`,
            // ⚠️ updated_at is deliberately NOT touched here. It is the retention clock
            // (src/config/lead-retention.ts), and a nightly sweep that bumped it would keep every
            // lead alive forever — the 30-day countdown would never reach zero on any lead the
            // enrichment cadence had looked at, which is every lead.
        })
        .where(eq(assistantRecords.id, assistantRecordId));
}
