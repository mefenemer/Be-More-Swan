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
// the Searches aggregate and the All leads table in step by reading both).
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
import { enrichLeadContact, type FoundEmail } from '../lib/discovery-enrich';
import { isEnrichProviderConfigured, lookupProviderContact, findPersonEmail, ENRICH_COST_GBP_PER_LOOKUP } from '../lib/discovery-enrich-provider';
import { isCompaniesHouseConfigured, lookupCompaniesHouse, type CompaniesHouseCompany } from '../lib/companies-house';
import { pickLeadPerson, matchPersonEmail, nameParts, samePerson, isDecisionMakerTitle, type LeadPerson } from '../config/lead-person';
import { gatherLeadIntel, nameAppearsInSources, hasIntelWorthScoring, LEAD_INTEL_SEARCHES } from '../lib/lead-intel';
import { logAiUsage } from './ai-usage';
import { loadRoleModel } from './assistant-model';
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
 * The named-person half of an enrichment outcome (docs/lead-search-one-pass-plan.md §2): who to
 * address, their own address when one was published or found, and the evidence behind both.
 * Optional on every writer — a pass that learned nothing about people passes nothing.
 */
export interface NamedContact {
    /** Every address the company's own pages printed. */
    emails?: FoundEmail[];
    person?: LeadPerson | null;
    /** The person's OWN address. Never `contactEmail` unless no other address exists — see below. */
    personEmail?: { email: string; source: 'scrape' | 'provider'; foundOn: string } | null;
    companiesHouse?: CompaniesHouseCompany | null;
}

/** The record keys a named contact is written to. Listed once so erasure (prospect-erasure.ts) can clear them all. */
export const NAMED_CONTACT_RECORD_KEYS = [
    'contactName', 'contactTitle', 'contactNameSource', 'contactNameSourceUrl',
    'contactPersonEmail', 'contactPersonEmailSource', 'foundEmails', 'companiesHouse',
] as const;

/**
 * The jsonb fragments for a named contact, split by whether a human's edit must win.
 *
 * ⚠️ `contactName` is also typed by hand (Edit lead → "Contact name") and read by the CRM hand-off
 * and the won-customer audience. A search that overwrote it would silently replace the person the
 * user chose with the one a register listed — so the name block is merged ONLY when the record has
 * no name yet, and the evidence block (addresses seen, the register entry) always.
 */
function namedContactJson(named: NamedContact | undefined): { evidence: Record<string, unknown>; name: Record<string, unknown> } {
    const evidence: Record<string, unknown> = {};
    const name: Record<string, unknown> = {};
    if (!named) return { evidence, name };
    if (named.emails && named.emails.length) evidence.foundEmails = named.emails.slice(0, 12);
    if (named.companiesHouse) {
        evidence.companiesHouse = {
            number: named.companiesHouse.number, name: named.companiesHouse.name, url: named.companiesHouse.url,
            officers: named.companiesHouse.officers.slice(0, 8), matchedBy: named.companiesHouse.matchedBy,
        };
    }
    if (named.person) {
        name.contactName = named.person.name;
        name.contactTitle = named.person.title;
        name.contactNameSource = named.person.source;
        name.contactNameSourceUrl = named.person.sourceUrl;
        if (named.personEmail) {
            name.contactPersonEmail = named.personEmail.email;
            name.contactPersonEmailSource = named.personEmail.source;
        }
    }
    return { evidence, name };
}

/**
 * Persist one enrichment outcome. Always stamps `enrichAttemptedAt` (so a miss isn't
 * retried forever) and mirrors that stamp — plus, on a hit, the address — onto the linked
 * assistant_record, so lead-generation.ts `send_outreach` resolves `data.contactEmail` with no
 * change there and the All leads tab can say which leads have actually been looked at.
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
    /**
     * Set when the paid provider was called and DID NOT ANSWER (no credits, rate limited, timed
     * out, unparseable). Mutually exclusive with `paidAttempted` — see the stamp below.
     */
    paidFailedReason: string | null = null,
    named?: NamedContact,
): Promise<void> {
    const hit = found.contact;
    const { evidence, name } = namedContactJson(named);
    const handles = found.handles ?? {};
    const stamp: Record<string, unknown> = { enrichAttemptedAt: new Date().toISOString() };
    // ⚠️ Written on a MISS as well as a hit, and that is the point: this stamp is what the
    // per-run cap counts, so it has to record money SPENT rather than addresses found. It also
    // stops a later slice paying a second time for a domain the provider already had nothing for.
    if (paidAttempted) stamp.paidLookupAt = new Date().toISOString();
    // ⚠️ A FAILED lookup is stamped DIFFERENTLY, and never as `paidLookupAt`. Nothing was bought,
    // nothing was learned about this company, and the cap must not count it — the cap exists to
    // bound SPEND, and a rejected request costs nothing. Recording it as a purchase is what made
    // the 2026-08-27 outage invisible (see discovery-enrich-provider.ts).
    //
    // `enrichAttemptedAt` above IS still written, deliberately: the free scrape genuinely ran, and
    // the worker's "any leads left to enrich?" query counts unstamped rows — leaving them unstamped
    // would mean a run whose provider is down never reaches `remaining === 0` and never completes.
    // The retry route is the once-per-run sweep in process-discovery-jobs.ts, which finds leads by
    // THIS key and clears the attempt stamp at the start of the next run on the campaign.
    if (paidFailedReason) {
        stamp.paidLookupFailedAt = new Date().toISOString();
        stamp.paidLookupFailedReason = paidFailedReason;
    }
    if (hit) {
        stamp.emailKind = hit.kind;        // 'role' | 'personal' — personal needs a closer look
        stamp.emailSource = hit.source;    // 'scrape' | 'provider' — drives the personal-inbox gate
        stamp.emailFoundOn = hit.foundOn;  // provenance for the Review Queue
    }
    if (Object.keys(handles).length > 0) stamp.socialHandles = handles;

    if (leadId !== null) {
        // Signals keys for the named half: `emails` and `person` are the names prospect-erasure.ts
        // already strips from this column, plus `companiesHouse`, which it now strips too.
        const signalsNamed: Record<string, unknown> = {};
        if (evidence.foundEmails) signalsNamed.emails = evidence.foundEmails;
        if (evidence.companiesHouse) signalsNamed.companiesHouse = evidence.companiesHouse;
        if (named?.person) signalsNamed.person = { ...named.person, email: named.personEmail?.email ?? null };
        await db.update(discoveredLeads)
            .set({
                ...(hit ? { contactEmail: hit.email } : {}),
                // The column is only ever filled, never replaced — the same rule as the record below.
                ...(named?.person ? { contactName: sql`COALESCE(NULLIF(${discoveredLeads.contactName}, ''), ${named.person.name})` } : {}),
                // Merge into signals rather than replacing — it already holds the SERP snippet.
                signals: sql`COALESCE(${discoveredLeads.signals}, '{}'::jsonb) || ${JSON.stringify({ ...stamp, ...signalsNamed })}::jsonb`,
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
    // `enrichAttemptedAt` either way. Without it the All leads tab could not tell "we looked and
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
            data: sql`(COALESCE(${assistantRecords.data}, '{}'::jsonb) || ${JSON.stringify({
                ...stamp,
                ...(hit ? { contactEmail: hit.email } : {}),
                ...evidence,
            })}::jsonb) || CASE WHEN COALESCE(${assistantRecords.data} ->> 'contactName', '') = ''
                               THEN ${JSON.stringify(name)}::jsonb ELSE '{}'::jsonb END`,
            updatedAt: new Date(),
        })
        .where(eq(assistantRecords.id, assistantRecordId));
}

// ────────────────────────────────────────────────────────────────────────────
// THE CONTACT WATERFALL — docs/lead-search-one-pass-plan.md §2 steps 1–6
// ────────────────────────────────────────────────────────────────────────────
//
// One order, used by the discovery worker AND the per-lead buttons, so a lead enriched by a click is
// indistinguishable from one enriched by a search:
//
//   1. the company's own website, read fully            free
//   2. Companies House officers (UK leads)              free
//   3. pick the person                                   —
//   4. match them to an address the site printed         free
//   5. Hunter Email Finder for that person               paid, only when it finds one
//   6. Hunter Domain Search                              paid, ONLY when 1–5 produced no address at all
//
// The owner's rule (2026-10-27): Hunter is the LAST option. Steps 5 and 6 run only when `allowPaid`.

export interface ContactWaterfallResult {
    found: EnrichmentFound;
    named: NamedContact;
    /** At least one paid call was ANSWERED (hit or miss). Drives `paidLookupAt`. */
    paidAttempted: boolean;
    /** A paid call went unanswered and nothing paid was answered. Drives `paidLookupFailedAt`. */
    paidFailedReason: string | null;
    /** What the answered paid calls cost, for the run's budget. */
    costGbp: number;
}

export async function runContactWaterfall(opts: {
    domain: string;
    companyName: string;
    /** The search itself is a UK search. A `.uk` domain or a UK postcode on the site also counts. */
    ukSearch?: boolean;
    allowPaid: boolean;
    /** Epoch ms; steps that would start after it are skipped (and paid ones reported as `no_budget`). */
    deadline?: number;
    usage?: { workspaceId?: number | null; assistantId?: number | null };
}): Promise<ContactWaterfallResult> {
    const left = () => (opts.deadline === undefined ? Infinity : opts.deadline - Date.now());
    const named: NamedContact = { emails: [], person: null, personEmail: null, companiesHouse: null };

    // ── 1. Website ──
    let scraped: Awaited<ReturnType<typeof enrichLeadContact>> = { contact: null, handles: {}, emails: [], postcodes: [] };
    try {
        scraped = await enrichLeadContact(opts.domain);
    } catch {
        // Best-effort: a scrape failure must never fail the run.
    }
    let found: EnrichmentFound = { contact: scraped.contact, handles: scraped.handles ?? {} };
    named.emails = scraped.emails ?? [];

    // ── 2. Companies House ──
    const uk = !!opts.ukSearch || /\.uk$/i.test(opts.domain) || (scraped.postcodes ?? []).length > 0;
    if (uk && isCompaniesHouseConfigured() && left() > 1000) {
        const ch = await lookupCompaniesHouse(opts.companyName, scraped.postcodes ?? [], {
            timeoutMs: Math.min(3000, left()), usage: opts.usage,
        });
        if (ch.status === 'hit') named.companiesHouse = ch.company;
    }

    // ── 3 + 4. The person, and an address already in hand ──
    const officers = named.companiesHouse?.officers ?? [];
    named.person = pickLeadPerson({ site: [], officers, officersUrl: named.companiesHouse?.url ?? null, hunter: [] });
    const pick = (person: LeadPerson | null) => {
        const own = person ? matchPersonEmail(person, named.emails ?? []) : null;
        return own ? { email: own.email, source: 'scrape' as const, foundOn: own.foundOn } : null;
    };
    named.personEmail = pick(named.person);

    let paidAttempted = false;
    let paidFailedReason: string | null = null;
    let costGbp = 0;
    const paid = opts.allowPaid && isEnrichProviderConfigured();

    // ── 5. Email Finder, for a named person with no address of their own ──
    const parts = named.person ? nameParts(named.person.name) : null;
    if (paid && named.person && parts && !named.personEmail) {
        const outcome = await findPersonEmail(opts.domain, parts, { timeoutMs: Math.min(5000, left()), usage: opts.usage });
        if (outcome.status === 'error') paidFailedReason = outcome.reason;
        else {
            paidAttempted = true;
            if (outcome.status === 'hit') {
                costGbp += ENRICH_COST_GBP_PER_LOOKUP;
                named.personEmail = { email: outcome.contact.email, source: 'provider', foundOn: 'hunter' };
                // Their own address becomes the CONTACT only when there is no other address at all.
                // A published role inbox stays the send target (bulk send, no personal-inbox gate);
                // the person's address sits beside it for the user to choose.
                if (!found.contact) {
                    found = { ...found, contact: { email: outcome.contact.email, kind: outcome.contact.kind, source: 'provider', foundOn: 'hunter' } };
                }
            }
        }
    }

    // ── 6. Domain Search — the last resort ──
    if (paid && !found.contact) {
        try {
            const outcome = await lookupProviderContact(opts.domain, { timeoutMs: Math.min(5000, left()), usage: opts.usage });
            if (outcome.status === 'error') paidFailedReason = paidFailedReason ?? outcome.reason;
            else {
                paidAttempted = true;
                costGbp += ENRICH_COST_GBP_PER_LOOKUP;
                if (outcome.status === 'hit') {
                    found = {
                        ...found,
                        contact: { email: outcome.contact.email, kind: outcome.contact.kind, source: 'provider', foundOn: outcome.contact.provider },
                    };
                    const hunterPeople = outcome.contact.people ?? [];
                    if (!named.person) {
                        named.person = pickLeadPerson({ site: [], officers, officersUrl: named.companiesHouse?.url ?? null, hunter: hunterPeople });
                    }
                    if (named.person && !named.personEmail) {
                        const who = named.person.name;
                        const theirs = hunterPeople.find((p) => samePerson(p.name, who));
                        if (theirs) named.personEmail = { email: theirs.email, source: 'provider', foundOn: 'hunter' };
                    }
                }
            }
        } catch {
            paidFailedReason = paidFailedReason ?? 'threw';
        }
    }

    // An answered call settles the lead; an unanswered one only counts when nothing paid answered.
    if (paidAttempted) paidFailedReason = null;
    return { found, named, paidAttempted, paidFailedReason, costGbp };
}

/** Is this person worth a paid lookup on a lead that already has a role inbox? Only someone who can say yes. */
export function worthFindingAddressFor(person: LeadPerson | null | undefined): boolean {
    return !!person && (person.source === 'companies_house' || isDecisionMakerTitle(person.title));
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
        /** For the Companies House lookup; read from the record's title when omitted. */
        companyName?: string;
    },
): Promise<OnDemandEnrichmentResult> {
    const empty: OnDemandEnrichmentResult = { found: false, email: null, kind: null, handles: {}, paidAttempted: false };
    if (!opts.domain) return empty;

    // The company name the register is searched by. The record's title is the company as the
    // search (or the user) named it; nothing here is a person.
    let companyName = opts.companyName ?? '';
    if (!companyName && opts.assistantRecordId) {
        const [r] = await db.select({ title: assistantRecords.title }).from(assistantRecords)
            .where(eq(assistantRecords.id, opts.assistantRecordId)).limit(1);
        companyName = r?.title ?? '';
    }

    // ⚠️ NO PROSPECT-TYPE GATE on the paid steps, and that is deliberate — it differs from the
    // worker on purpose. enrichBatch buys only for a confirmed `target_business` because it is
    // spending unattended across a whole run (PAID_ENRICH_ELIGIBLE_SQL). This path is one lead,
    // chosen by a human who pressed a button on it. The refusal that DOES apply is in
    // lead-generation.ts `look_again`, which turns down the types no address can help.
    //
    // The same waterfall as the search (runContactWaterfall above): website, Companies House, then
    // Hunter last — so a lead enriched by a click is indistinguishable from one enriched by a run.
    const result = await runContactWaterfall({
        domain: opts.domain,
        companyName,
        allowPaid: opts.allowPaid !== false,
        usage: { workspaceId: opts.ledger?.organisationId ?? null, assistantId: opts.ledger?.aiAssistantId ?? null },
    });
    const found = result.found;
    const paidAttempted = result.paidAttempted;

    await recordEnrichment(db, opts.discoveredLeadId, opts.assistantRecordId, found, opts.ledger, paidAttempted, result.paidFailedReason, result.named);

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
        /**
         * Further named-people evidence, beside the team pages gathered here — the Companies House
         * officer list (one-pass plan §5.6). Goes through the same fabrication guard: a person the
         * model returns must appear in one of these texts or the team pages.
         */
        extraPeopleSources?: Array<{ url: string; text: string }>;
        /** Epoch ms; gathering stops starting new reads after it (gatherLeadIntel `deadline`). */
        deadline?: number;
    },
): Promise<DeepEnrichmentResult> {
    if (!opts.domain) {
        return NOT_RUN('There is no website on file for this company, so there was nothing to research.');
    }

    // The card as it stands. Read fresh rather than taken from the caller: this row is written by
    // the Review Queue, the Edit form and the contact-enrichment pass, and re-scoring from a stale
    // copy would silently revert whichever of them committed most recently.
    const [rec] = await db
        .select({
            id: assistantRecords.id, title: assistantRecords.title, data: assistantRecords.data,
            organisationId: assistantRecords.organisationId, aiAssistantId: assistantRecords.aiAssistantId,
        })
        .from(assistantRecords)
        .where(eq(assistantRecords.id, opts.assistantRecordId))
        .limit(1);
    if (!rec) return NOT_RUN('That lead no longer exists.');

    const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data))
        ? rec.data as Record<string, unknown> : {};
    const current: LeadScoringCard = normaliseLeadCard(data, rec.title || 'Unnamed lead');

    const intel = await gatherLeadIntel(opts.domain, rec.title || opts.domain, {
        maxSearches: opts.maxSearches ?? DEEP_SEARCHES_PER_LEAD,
        usage: { workspaceId: rec.organisationId ?? null, assistantId: rec.aiAssistantId ?? null },
        deadline: opts.deadline,
    });
    if (opts.extraPeopleSources?.length) intel.peopleSources.push(...opts.extraPeopleSources);

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
    }, opts.icp, opts.sender, { domain: opts.domain, modelChoice: await loadRoleModel(db, 'lead_qualifier') });
    // rescoreWithIntel reports its tokens and logs nothing itself; nor did anything else.
    if (rescored.inputTokens || rescored.outputTokens) {
        void logAiUsage({
            workspaceId: rec.organisationId ?? null, assistantId: rec.aiAssistantId ?? null,
            model: rescored.model, inputTokens: rescored.inputTokens, outputTokens: rescored.outputTokens,
            sessionId: 'lead-deep-enrichment', dataCategories: ['business_context'],
        });
    }

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
            // The rating column is the All leads table's own "Rating" cell and the Searches
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

// ────────────────────────────────────────────────────────────────────────────
// RESEARCH + NAME — docs/lead-search-one-pass-plan.md §2 steps 3–5 and 7, after the deep pass
// ────────────────────────────────────────────────────────────────────────────
//
// The contact waterfall above can only name someone from the register (it has no model to read a
// team page). The deep pass reads the team pages anyway, so the best person is chosen again here,
// from the people it verified plus the register — and, for a decision-maker with no address of
// their own, Hunter's Email Finder is asked once. Used by the search's research pass and by the
// "Research this lead" button, so both name people by the same rule.

export interface ResearchAndNameResult {
    deep: DeepEnrichmentResult;
    person: LeadPerson | null;
    personEmail: string | null;
    /** A paid Email Finder call was answered. */
    paidAttempted: boolean;
    costGbp: number;
}

export async function researchAndName(
    db: Db,
    opts: Parameters<typeof deepEnrichLead>[1] & { allowPaid: boolean },
): Promise<ResearchAndNameResult> {
    const [rec] = await db.select({ data: assistantRecords.data }).from(assistantRecords)
        .where(eq(assistantRecords.id, opts.assistantRecordId)).limit(1);
    const data = (rec?.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) ? rec.data as Record<string, unknown> : {};
    const ch = (data.companiesHouse && typeof data.companiesHouse === 'object') ? data.companiesHouse as {
        url?: string; name?: string; officers?: Array<{ name: string; role: string }>;
    } : null;
    const officers = Array.isArray(ch?.officers) ? ch!.officers! : [];
    const chUrl = typeof ch?.url === 'string' ? ch.url : null;

    // The register as evidence text, so the model may return an officer and the guard can verify it.
    const extraPeopleSources = chUrl && officers.length
        ? [{ url: chUrl, text: `Companies House register for ${ch!.name ?? 'this company'} — active officers: ${officers.map((o) => `${o.name} (${o.role})`).join('; ')}.` }]
        : [];

    const deep = await deepEnrichLead(db, { ...opts, extraPeopleSources });
    let costGbp = deep.costGbp;
    let paidAttempted = false;

    // People named on the company's OWN pages — the register entry is the other half of the picker.
    const site = deep.people.filter((p) => p.sourceUrl !== chUrl).map((p) => ({ name: p.name, title: p.title, sourceUrl: p.sourceUrl }));
    const person = pickLeadPerson({ site, officers, officersUrl: chUrl, hunter: [] });
    if (!person) return { deep, person: null, personEmail: null, paidAttempted, costGbp };

    // A name a human typed is theirs; a name a search chose may be replaced by a better-evidenced one
    // (a director named on their own site beats the register's sole officer, who may be a silent one).
    const humanName = typeof data.contactName === 'string' && data.contactName.trim() !== '' && !data.contactNameSource;
    if (humanName) return { deep, person: null, personEmail: null, paidAttempted, costGbp };
    const current = typeof data.contactName === 'string' ? data.contactName : '';
    const sameAsCurrent = current !== '' && samePerson(current, person.name);
    if (current && !sameAsCurrent && !(person.source === 'website' && data.contactNameSource !== 'website')) {
        return { deep, person: null, personEmail: null, paidAttempted, costGbp };
    }

    // Their own address: one the site already printed, else what we stored for them, else Hunter.
    const emails = Array.isArray(data.foundEmails) ? data.foundEmails as Array<{ email: string; kind: string; foundOn: string }> : [];
    const printed = matchPersonEmail(person, emails);
    let personEmail: { email: string; source: 'scrape' | 'provider'; foundOn: string } | null =
        printed ? { email: printed.email, source: 'scrape', foundOn: printed.foundOn } : null;
    if (!personEmail && sameAsCurrent && typeof data.contactPersonEmail === 'string') {
        personEmail = { email: data.contactPersonEmail, source: data.contactPersonEmailSource === 'scrape' ? 'scrape' : 'provider', foundOn: 'stored' };
    }
    const parts = nameParts(person.name);
    if (!personEmail && parts && opts.allowPaid && isEnrichProviderConfigured() && worthFindingAddressFor(person)) {
        const outcome = await findPersonEmail(opts.domain, parts, {
            timeoutMs: opts.deadline ? Math.max(0, Math.min(5000, opts.deadline - Date.now())) : 5000,
            usage: { workspaceId: opts.ledger?.organisationId ?? null, assistantId: opts.ledger?.aiAssistantId ?? null },
        });
        if (outcome.status !== 'error') paidAttempted = true;
        if (outcome.status === 'hit') {
            costGbp += ENRICH_COST_GBP_PER_LOOKUP;
            personEmail = { email: outcome.contact.email, source: 'provider', foundOn: 'hunter' };
        }
    }

    const hasContact = typeof data.contactEmail === 'string' && data.contactEmail.trim() !== '';
    const patch: Record<string, unknown> = {
        contactName: person.name,
        contactTitle: person.title,
        contactNameSource: person.source,
        contactNameSourceUrl: person.sourceUrl,
        ...(personEmail ? { contactPersonEmail: personEmail.email, contactPersonEmailSource: personEmail.source } : {}),
        // No address at all until now: the person's own becomes the contact, stamped with its kind
        // like every other writer of contactEmail (lead-email-kind.ts — an unstamped address reads
        // as a role inbox, the unsafe default).
        ...(!hasContact && personEmail ? {
            contactEmail: personEmail.email,
            emailKind: 'personal',
            emailSource: personEmail.source,
            emailFoundOn: personEmail.source === 'provider' ? 'hunter' : personEmail.foundOn,
        } : {}),
    };
    // ⚠️ updated_at is NOT touched: it is the retention clock (see stampIntel).
    await db.update(assistantRecords)
        .set({ data: sql`COALESCE(${assistantRecords.data}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(assistantRecords.id, opts.assistantRecordId));
    if (opts.discoveredLeadId !== null) {
        await db.update(discoveredLeads)
            .set({
                contactName: person.name,
                ...(!hasContact && personEmail ? { contactEmail: personEmail.email } : {}),
                signals: sql`COALESCE(${discoveredLeads.signals}, '{}'::jsonb) || ${JSON.stringify({ person: { ...person, email: personEmail?.email ?? null } })}::jsonb`,
            })
            .where(eq(discoveredLeads.id, opts.discoveredLeadId));
    }
    return { deep, person, personEmail: personEmail?.email ?? null, paidAttempted, costGbp };
}
