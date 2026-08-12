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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
    assistantName: string,
): Promise<ClassifyResult> {
    const empty = candidates.map(() => ({ prospectType: null, rationale: null }));
    if (candidates.length === 0) return { results: [], inputTokens: 0, outputTokens: 0 };

    const system =
`You classify companies discovered on the public web for "${assistantName}", a business using Be More Swan. Decide only what each candidate IS. Do not score or rank them.

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
    assistantName: string,
): Promise<ScoreResult> {
    if (candidates.length === 0) return { cards: [], inputTokens: 0, outputTokens: 0 };

    const system =
`You qualify OUTBOUND leads discovered on the public web for "${assistantName}", a business using Be More Swan. Score each candidate below against the ideal customer profile — strong fit + buying intent scores high; poor fit or no intent scores low. Your reasons must name which profile criteria each candidate met or missed. Only the public info provided is known — do not invent facts about a company.

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
