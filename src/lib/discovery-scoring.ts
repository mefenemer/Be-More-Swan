// src/lib/discovery-scoring.ts
// Qualifies discovered candidates against the ICP and emits the same lead_scoring_card
// wire shape the chat route / lead-generation.ts produce — so a promoted discovered_lead
// renders identically in the Data Hub / Review Queue (disruptive-ui-registry.js →
// renderLeadScoringCard). Batches candidates into one Anthropic call to keep run cost low.

import Anthropic from '@anthropic-ai/sdk';
import { OUTREACH_SUBJECT_RULES } from '../constants/outreach-subject';
import {
    DISQUALIFIED_MAX_SCORE,
    EXCLUDE_PROFILE_DNC_RULE,
    EXCLUDE_PROFILE_RULE,
    PROSPECT_TYPES,
    PROSPECT_TYPE_RULE,
    SCORING_BANDS,
    icpBlock,
    isDisqualifyingProspectType,
    type ProspectType,
} from '../config/icp-profile';
import {
    SENDER_IDENTITY_RULE,
    senderIdentityBlock,
    type SenderIdentity,
} from '../config/sender-identity';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * How the three prompts below refer to the business they are working for.
 *
 * ⚠️ This used to interpolate the ASSISTANT's name plus the platform's, and nothing else — see
 * src/config/sender-identity.ts, which is where the whole story of why approved drafts carried the
 * wrong sign-off lives. Only scoreCandidates writes prose a prospect reads, so only it carries the
 * full identity block and the rule; the other two just need to know whose profile they judge against.
 */
function senderPhrase(sender: SenderIdentity): string {
    const name = (sender.businessName || '').trim();
    return name ? `"${name}"` : 'the business that owns this workspace';
}
export const SCORING_MODEL = 'claude-haiku-4-5-20251001';

export interface ScoreCandidate {
    companyName: string;
    domain?: string | null;
    snippet?: string | null;
    sourceUrl?: string | null;
    signals?: Record<string, unknown> | null;
}

export interface LeadScoringCard {
    type: 'lead_scoring_card';
    leadName: string;
    score: number;
    rating: 'hot' | 'warm' | 'cold';
    reasons: string[];
    suggestedNextStep: string;
    outreachDraft: { to: string | null; subject: string; body: string } | null;
    /** Hard block on emailing this lead at all — enforced by evaluateDoNotContact(). */
    doNotContact: boolean;
    doNotContactReason: string | null;
    /**
     * What the candidate IS, per the prospect-type gate — null on surfaces that do not ask for it
     * (the manual score_lead path) and on cards written before the gate existed.
     *
     * Kept on the card rather than thrown away after the clamp: "why is this fintech cold?" is a
     * question the Leads tab has to be able to answer without a re-run, and the reasons prose is
     * the model's, not ours. Lives in the `scoring_card` jsonb, so no migration.
     */
    prospectType?: ProspectType | null;
}

export interface ScoreResult {
    cards: LeadScoringCard[];   // aligned by index to the input candidates
    inputTokens: number;
    outputTokens: number;
}

function str(v: unknown, max = 300): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function parseJson<T = unknown>(raw: string): T | null {
    const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(text) as T; } catch { return null; }
}

/** Coerce whatever the LLM returned into a safe lead_scoring_card. */
export function normaliseLeadCard(raw: unknown, fallbackName: string): LeadScoringCard {
    const ui = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const claimed = Math.max(0, Math.min(100, Math.round(Number(ui.score)) || 0));

    // ── The prospect-type gate, enforced ─────────────────────────────────────
    // An UNRECOGNISED or absent prospectType must never clamp. The manual score_lead path and
    // every card written before the gate existed have no such field, and the filter this belongs
    // to is explicitly biased towards false negatives: letting a supplier through costs one
    // triage slot, silently freezing a real customer at 10 costs a customer and looks like a
    // scoring opinion rather than a bug.
    const disqualifiedAs = isDisqualifyingProspectType(ui.prospectType) ? ui.prospectType : null;
    const prospectType: ProspectType | null =
        disqualifiedAs ?? (ui.prospectType === 'target_business' ? 'target_business' : null);

    const score = disqualifiedAs ? Math.min(claimed, DISQUALIFIED_MAX_SCORE) : claimed;
    const rating: LeadScoringCard['rating'] =
        disqualifiedAs ? 'cold'
        : ui.rating === 'hot' || ui.rating === 'warm' || ui.rating === 'cold' ? ui.rating
        : score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';

    const reasons = Array.isArray(ui.reasons)
        ? ui.reasons.filter((r) => typeof r === 'string').slice(0, 6).map((r) => String(r).slice(0, 300))
        : [];
    // Only when the clamp actually contradicted the model. A candidate it classified AND scored as
    // a supplier has already explained itself in its own reasons; duplicating that adds noise. A
    // 76 clamped to 10 has not, and the gap is the whole story.
    if (disqualifiedAs && claimed > score) {
        reasons.unshift(`Scored ${claimed} on profile fit, but classified "${disqualifiedAs}" — not a business we can sell to, so capped at ${DISQUALIFIED_MAX_SCORE}.`);
        reasons.length = Math.min(reasons.length, 6);
    }

    let outreachDraft: LeadScoringCard['outreachDraft'] = null;
    if (ui.outreachDraft && typeof ui.outreachDraft === 'object') {
        const d = ui.outreachDraft as Record<string, unknown>;
        if (str(d.body)) outreachDraft = { to: str(d.to, 200), subject: str(d.subject, 300) ?? '', body: String(d.body).slice(0, 4000) };
    }
    // A do-not-contact verdict must survive normalisation or the gate downstream never fires — it
    // reads this card, not the raw model output. Only `true` counts: an absent field means the
    // scoring pass predates the flag, and evaluateDoNotContact() falls back to the prose instead.
    const doNotContact = ui.doNotContact === true;
    return {
        type: 'lead_scoring_card',
        leadName: str(ui.leadName, 300) ?? fallbackName,
        score,
        rating,
        reasons,
        suggestedNextStep: str(ui.suggestedNextStep, 500) ?? '',
        // A disqualified candidate drops its draft as well as its score. Note it is NOT promoted to
        // doNotContact: that flag means sending would be WRONG (a competitor, our own staff, an
        // opt-out), and a fulfilment provider is merely a bad prospect. Conflating "not worth
        // emailing" with "must never be emailed" would quietly poison the do-not-contact gate.
        outreachDraft: (doNotContact || disqualifiedAs) ? null : outreachDraft,
        doNotContact,
        doNotContactReason: doNotContact ? str(ui.doNotContactReason, 300) : null,
        prospectType,
    };
}


/**
 * Re-apply the prospect-type gate to a card that has already been scored.
 *
 * Deliberately routed back through normaliseLeadCard rather than reimplementing the clamp: there
 * must be exactly one place that decides what a disqualified card looks like, or a backfill and a
 * live run will eventually disagree about the same lead. Idempotent — a card that has already been
 * clamped passes through unchanged, so a re-run after a partial failure is safe.
 */
export function applyProspectType(card: LeadScoringCard, prospectType: ProspectType | null): LeadScoringCard {
    return normaliseLeadCard({ ...card, prospectType }, card.leadName);
}

export interface ProspectClassification {
    /** null when the model returned nothing usable for this candidate — the caller must not clamp. */
    prospectType: ProspectType | null;
    rationale: string | null;
}

export interface ClassifyResult {
    results: ProspectClassification[];   // aligned by index to the input candidates
    inputTokens: number;
    outputTokens: number;
}

/**
 * Classify candidates WITHOUT scoring them — the gate on its own.
 *
 * Exists for retro-fitting the gate to leads that were scored before it existed. A full re-score
 * would re-roll every number in the batch, so a lead could move from cold to hot for reasons that
 * have nothing to do with the gate, and the operator reading the diff could not tell which changes
 * were the fix and which were the model's nondeterminism. This pass can only ever demote.
 *
 * Never throws: a failed call yields nulls, and a null must leave its card alone.
 */
export async function classifyProspects(
    candidates: ScoreCandidate[],
    icp: Record<string, unknown>,
    sender: SenderIdentity,
): Promise<ClassifyResult> {
    const empty = candidates.map(() => ({ prospectType: null, rationale: null }));
    if (candidates.length === 0) return { results: [], inputTokens: 0, outputTokens: 0 };

    const system =
`You classify companies discovered on the public web for ${senderPhrase(sender)}. Decide only what each candidate IS. Do not score or rank them.

${PROSPECT_TYPE_RULE}

⚠️ This pass returns the CLASSIFICATION ONLY. Ignore the sentence above about scores and ratings — those are applied downstream from your answer. Return no score.

Ideal customer profile (from setup):
${icpBlock(icp)}

Return STRICT JSON only (no markdown): an array with ONE object per candidate, in the SAME ORDER as given:
[
  { "index": <the index given>, "prospectType": "target_business" | "supplier_to_target" | "aggregator" | "media" | "content_page" | "platform", "rationale": "<one short sentence>" }
]`;

    const compact = candidates.map((c, i) => ({
        index: i,
        companyName: c.companyName,
        domain: c.domain ?? null,
        publicSnippet: (c.snippet ?? '').slice(0, 500),
    }));

    let inputTokens = 0;
    let outputTokens = 0;
    let parsed: unknown[] = [];

    try {
        const resp = await anthropic.messages.create({
            model: SCORING_MODEL,
            max_tokens: 1536,
            // Low variance on purpose, unlike scoreCandidates: this is a closed-vocabulary
            // classification, not a judgement with a range of defensible answers.
            //
            // ⚠️ temperature 0 is NOT determinism, and it was measured here rather than assumed —
            // nationalgeographic.org still came back "media" on one staging run and
            // "target_business" on the very next identical one. Anything that needs the same answer
            // twice must persist the FIRST answer, not re-ask; that is why the backfill applies from
            // a saved plan instead of re-classifying (scripts/rescore-lead-prospect-type.ts).
            temperature: 0,
            system,
            messages: [{ role: 'user', content: `Classify these ${candidates.length} candidates:\n${JSON.stringify(compact)}` }],
        });
        inputTokens = resp.usage.input_tokens;
        outputTokens = resp.usage.output_tokens;
        const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
        const p = parseJson<unknown[]>(raw);
        if (Array.isArray(p)) parsed = p;
    } catch (err) {
        console.error('[discovery-scoring] classification failed:', err);
        return { results: empty, inputTokens, outputTokens };
    }

    // Keyed on the echoed `index`, with position as the fallback. scoreCandidates aligns purely by
    // position because a desync there costs one run; this pass writes over stored prod cards, where
    // a one-off shift would stamp treyd.io's verdict onto the lead that happened to follow it.
    const results = candidates.map((_, i) => {
        const byIndex = parsed.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).index === i);
        const row = (byIndex ?? parsed[i]) as Record<string, unknown> | undefined;
        const value = row?.prospectType;
        const prospectType = typeof value === 'string' && (PROSPECT_TYPES as readonly string[]).includes(value)
            ? value as ProspectType
            : null;
        return { prospectType, rationale: str(row?.rationale, 300) };
    });

    return { results, inputTokens, outputTokens };
}

/**
 * Score a batch of discovered candidates in one call. Returns cards aligned by index;
 * a missing/garbled entry falls back to a cold card so the arrays never desync.
 * Never throws — on failure every candidate gets a neutral cold card.
 */
export async function scoreCandidates(
    candidates: ScoreCandidate[],
    icp: Record<string, unknown>,
    sender: SenderIdentity,
): Promise<ScoreResult> {
    if (candidates.length === 0) return { cards: [], inputTokens: 0, outputTokens: 0 };

    const system =
`You qualify OUTBOUND leads discovered on the public web for ${senderPhrase(sender)}, and write the outreach email for the ones worth contacting. Score each candidate below against the ideal customer profile — strong fit + buying intent scores high; poor fit or no intent scores low. Your reasons must name which profile criteria each candidate met or missed. Only the public info provided is known — do not invent facts about a company.

WHO THE EMAIL IS FROM:
${senderIdentityBlock(sender)}

${SENDER_IDENTITY_RULE}

${PROSPECT_TYPE_RULE}

Ideal customer profile (from setup):
${icpBlock(icp)}

${EXCLUDE_PROFILE_RULE} ${EXCLUDE_PROFILE_DNC_RULE}

${SCORING_BANDS}

Return STRICT JSON only (no markdown): an array with ONE object per candidate, in the SAME ORDER as given:
[
  {
    "leadName": "<company name>",
    "prospectType": "target_business" | "supplier_to_target" | "aggregator" | "media" | "content_page" | "platform",
    "score": <0-100>,
    "rating": "hot" | "warm" | "cold",
    "reasons": ["<reason tied to a profile criterion>", ...],
    "suggestedNextStep": "<one concrete next action>",
    "outreachDraft": { "to": null, "subject": "<subject>", "body": "<personalised outreach in the sales tone>" } | null,
    "doNotContact": <true|false>,
    "doNotContactReason": "<short reason, or null>"
  }
]
Write an outreachDraft for hot/warm leads; use null for cold leads.

Set "doNotContact": true when this candidate must not be emailed AT ALL — an internal or test account,
our own staff or domain, a competitor, an existing customer, or anyone who has asked not to be
contacted. This is stronger than a low score: a cold lead is a poor prospect we may still contact,
whereas doNotContact means sending would be wrong. When it is true, set outreachDraft to null.

${OUTREACH_SUBJECT_RULES}`;

    const compact = candidates.map((c, i) => ({
        index: i,
        companyName: c.companyName,
        domain: c.domain ?? null,
        publicSnippet: (c.snippet ?? '').slice(0, 500),
        signals: c.signals ?? {},
    }));

    let inputTokens = 0;
    let outputTokens = 0;
    let parsed: unknown[] = [];

    try {
        const resp = await anthropic.messages.create({
            model: SCORING_MODEL,
            max_tokens: 2048,
            system,
            messages: [{ role: 'user', content: `Score these ${candidates.length} candidates:\n${JSON.stringify(compact)}` }],
        });
        inputTokens = resp.usage.input_tokens;
        outputTokens = resp.usage.output_tokens;
        const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
        const p = parseJson<unknown[]>(raw);
        if (Array.isArray(p)) parsed = p;
    } catch (err) {
        console.error('[discovery-scoring] scoring failed:', err);
    }

    const cards = candidates.map((c, i) => normaliseLeadCard(parsed[i], c.companyName));
    return { cards, inputTokens, outputTokens };
}

// ────────────────────────────────────────────────────────────────────────────
// RE-SCORING ON NEW EVIDENCE
// ────────────────────────────────────────────────────────────────────────────
//
// The interpretation half of deep enrichment. src/lib/lead-intel.ts gathers evidence without a
// model; this reads that evidence and decides what it means for a lead we have already scored.
//
// ── Why re-scoring had to exist ─────────────────────────────────────────────
// Nothing in this product could move a lead's TEMPERATURE. A company scored 42 from one thin SERP
// snippet stayed 42 for the life of the account, however much changed — enrichment only ever
// changed whether we had an address for it. So "convert the lead from cold to warm" was not a
// thing the system could do, in either direction: a lead that had visibly stopped trading held its
// hot rating just as stubbornly.
//
// ── The two rules that make it safe ─────────────────────────────────────────
//  1. IT MAY ONLY REASON FROM THE EVIDENCE SUPPLIED. The model gets headlines, dates, URLs and the
//     text of the company's own pages, and is told outright that its own recollection of the
//     company is not admissible. It has one job it cannot do without evidence: justify a change.
//  2. EVERY PERSON IT RETURNS IS VERIFIED AGAINST THE SOURCE TEXT. A returned name that does not
//     appear verbatim in the pages it was given is dropped by the caller
//     (`nameAppearsInSources`). This is the same hard rule discovery-enrich.ts applies to
//     addresses, and it matters more here: an invented address emails the wrong stranger, an
//     invented managing director puts a fabricated person in front of a real one.

export interface IntelForScoring {
    evidence: Array<{ kind: string; title: string; url: string; snippet: string; date: string | null }>;
    peopleSources: Array<{ url: string; text: string }>;
    fingerprint: { platforms: string[]; hasCareersPage: boolean };
}

export interface DecisionMaker {
    name: string;
    /** Their role as printed on the page, or null when the page named them without one. */
    title: string | null;
    /** The page they were found on — provenance, and what the verification ran against. */
    sourceUrl: string;
}

export interface InterpretedSignal {
    /** One short sentence, in the model's words, about what this evidence means commercially. */
    summary: string;
    /** The evidence URL it came from. Never null — a signal with no source is not shown. */
    url: string;
    /** Does this make them MORE likely to buy, less, or is it context? */
    direction: 'positive' | 'negative' | 'neutral';
}

export interface RescoreResult {
    /** null when the call failed or produced nothing usable — the caller must leave the lead alone. */
    card: LeadScoringCard | null;
    signals: InterpretedSignal[];
    people: DecisionMaker[];
    /** Concrete things the outreach could open with, each tied to something we can point at. */
    hooks: string[];
    inputTokens: number;
    outputTokens: number;
}

const EMPTY_RESCORE: RescoreResult = {
    card: null, signals: [], people: [], hooks: [], inputTokens: 0, outputTokens: 0,
};

/**
 * Re-read one lead in the light of newly gathered evidence.
 *
 * ⚠️ NEVER THROWS, and returns `card: null` rather than a guess on any failure. A lead whose
 * re-score failed must keep the score it had: silently rewriting a rating from a failed parse is
 * worse than not re-scoring at all, because the number looks just as authoritative afterwards.
 *
 * ⚠️ The do-not-contact verdict on the existing card is NOT re-litigated here. It is carried
 * forward untouched by the caller. A model re-reading cheerful press coverage about a company we
 * have flagged as a competitor or an opt-out must not be able to talk itself into clearing that
 * flag; the only path out is the audited `override_do_not_contact` action.
 */
export async function rescoreWithIntel(
    current: LeadScoringCard,
    intel: IntelForScoring,
    icp: Record<string, unknown>,
    sender: SenderIdentity,
    opts: { domain?: string | null } = {},
): Promise<RescoreResult> {
    const hasEvidence = intel.evidence.length > 0
        || intel.peopleSources.length > 0
        || intel.fingerprint.platforms.length > 0
        || intel.fingerprint.hasCareersPage;
    if (!hasEvidence) return EMPTY_RESCORE;

    const system =
`You are re-reading ONE lead for ${senderPhrase(sender)}. This company was scored ${current.score}/100 (${current.rating}) some time ago, from a single search-result snippet. Since then we have gathered real evidence about them. Decide what that evidence changes.

⚠️ EVIDENCE ONLY. Reason exclusively from the EVIDENCE block in the user message. You may know nothing else about this company, and anything you believe you remember about it is INADMISSIBLE — say nothing that the supplied evidence does not support. If the evidence is thin, the correct answer is a small change or none.

⚠️ NAMED PEOPLE. You may only list a person whose name appears, spelled exactly that way, in the "teamPages" text supplied. Never infer a name from a company name, an email address, or a role that a company of this type usually has. Never invent an email address for anyone. If the team pages name nobody, return an empty list — that is a normal and useful answer.

WHAT MOVES A SCORE:
- UP: recent evidence they are growing or spending — funding, acquisitions, hiring, new sites or locations, product launches, awards, expansion. Recency matters: a funding round dated this year is a buying signal, one from years ago is history.
- DOWN: evidence they are a poor fit after all, are contracting, have closed, or were misidentified — including evidence they are the wrong KIND of organisation (a supplier, an aggregator, a directory, a news site) rather than a business we can sell to.
- NOT AT ALL: marketing copy, boilerplate, undated pages, or anything that is merely evidence the company exists. A website is not a buying signal.

${SCORING_BANDS}

Ideal customer profile (from setup):
${icpBlock(icp)}

Return STRICT JSON only (no markdown):
{
  "score": <0-100>,
  "rating": "hot" | "warm" | "cold",
  "reasons": ["<why the score is what it is now — name the specific evidence, not the category>", ...],
  "changeSummary": "<one sentence: what changed and why, or that nothing did>",
  "signals": [{ "summary": "<what this means commercially, one sentence>", "url": "<the evidence url it came from>", "direction": "positive" | "negative" | "neutral" }],
  "people": [{ "name": "<exactly as printed on the page>", "title": "<their role as printed, or null>", "sourceUrl": "<which team page>" }],
  "hooks": ["<a concrete opening line the outreach could use, tied to something in the evidence>", ...],
  "suggestedNextStep": "<one concrete next action>",
  "outreachDraft": { "to": null, "subject": "<subject>", "body": "<personalised outreach in the sales tone, referencing the strongest hook>" } | null
}

Every "url" in "signals" must be one of the evidence urls given to you. Write an outreachDraft for hot/warm leads only; use null for cold. Keep "hooks" to at most three, and only include one if the evidence genuinely supports it.

WHO THE EMAIL IS FROM:
${senderIdentityBlock(sender)}

${SENDER_IDENTITY_RULE}

${OUTREACH_SUBJECT_RULES}`;

    const payload = {
        companyName: current.leadName,
        domain: opts.domain ?? null,
        previousScore: current.score,
        previousRating: current.rating,
        previousReasons: current.reasons,
        evidence: intel.evidence.map((e) => ({
            searchedFor: e.kind, title: e.title, url: e.url, snippet: e.snippet, published: e.date,
        })),
        teamPages: intel.peopleSources.map((p) => ({ url: p.url, text: p.text })),
        siteFingerprint: intel.fingerprint,
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let parsed: Record<string, unknown> | null = null;

    try {
        const resp = await anthropic.messages.create({
            model: SCORING_MODEL,
            max_tokens: 2048,
            system,
            messages: [{ role: 'user', content: `Re-read this lead:\n${JSON.stringify(payload)}` }],
        });
        inputTokens = resp.usage.input_tokens;
        outputTokens = resp.usage.output_tokens;
        const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
        parsed = parseJson<Record<string, unknown>>(raw);
    } catch (err) {
        console.error('[discovery-scoring] rescore failed:', err);
        return { ...EMPTY_RESCORE, inputTokens, outputTokens };
    }
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_RESCORE, inputTokens, outputTokens };

    // Routed through normaliseLeadCard so a re-score cannot produce a card shape that the original
    // scoring pass could not — including the prospect-type clamp, which is carried forward from the
    // existing card rather than re-asked (this pass is not a classification, and re-rolling the
    // gate here would let a lead quietly escape a disqualification it already earned).
    //
    // doNotContact is taken from the CURRENT card, never from the model's answer. See the header.
    const card = normaliseLeadCard({
        ...parsed,
        leadName: current.leadName,
        prospectType: current.prospectType ?? null,
        doNotContact: current.doNotContact,
        doNotContactReason: current.doNotContactReason,
    }, current.leadName);

    // Signals are kept only when they point at evidence we actually supplied. A summary with an
    // invented or empty URL is an assertion the user cannot check, and the whole design here is
    // that every claim on screen has a link beside it.
    const allowedUrls = new Set(intel.evidence.map((e) => e.url));
    const rawSignals = Array.isArray(parsed.signals) ? parsed.signals : [];
    const signals: InterpretedSignal[] = rawSignals
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s): InterpretedSignal => ({
            summary: str(s.summary, 300) ?? '',
            url: str(s.url, 500) ?? '',
            // Anything the model did not clearly mark as helping or hurting is context, not a
            // verdict. Defaulting to 'neutral' rather than 'positive' matters: these chips are read
            // as "reasons to chase this lead", and an unparseable direction must not become one.
            direction: s.direction === 'positive' || s.direction === 'negative' ? s.direction : 'neutral',
        }))
        .filter((s) => s.summary && allowedUrls.has(s.url))
        .slice(0, 8);

    // People are returned unverified here — `nameAppearsInSources` is applied by the caller, which
    // is the only place that holds the source text. Shape-cleaning only at this layer.
    const rawPeople = Array.isArray(parsed.people) ? parsed.people : [];
    const people: DecisionMaker[] = rawPeople
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({
            name: str(p.name, 120) ?? '',
            title: str(p.title, 160),
            sourceUrl: str(p.sourceUrl, 500) ?? '',
        }))
        .filter((p) => p.name)
        .slice(0, 8);

    const hooks = (Array.isArray(parsed.hooks) ? parsed.hooks : [])
        .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
        .map((h) => h.trim().slice(0, 300))
        .slice(0, 3);

    return { card, signals, people, hooks, inputTokens, outputTokens };
}
