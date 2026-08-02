// src/lib/discovery-scoring.ts
// Qualifies discovered candidates against the ICP and emits the same lead_scoring_card
// wire shape the chat route / lead-generation.ts produce — so a promoted discovered_lead
// renders identically in the Data Hub / Review Queue (disruptive-ui-registry.js →
// renderLeadScoringCard). Batches candidates into one Anthropic call to keep run cost low.

import Anthropic from '@anthropic-ai/sdk';
import { OUTREACH_SUBJECT_RULES } from '../constants/outreach-subject';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export const SCORING_MODEL = 'claude-haiku-4-5-20251001';

const SCORING_BANDS =
    'Scoring bands: 70-100 = "hot" (strong profile fit + buying intent), 40-69 = "warm" (partial fit or unclear intent), 0-39 = "cold" (poor fit or no intent).';

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
    const score = Math.max(0, Math.min(100, Math.round(Number(ui.score)) || 0));
    const rating: LeadScoringCard['rating'] =
        ui.rating === 'hot' || ui.rating === 'warm' || ui.rating === 'cold' ? ui.rating
        : score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
    const reasons = Array.isArray(ui.reasons)
        ? ui.reasons.filter((r) => typeof r === 'string').slice(0, 6).map((r) => String(r).slice(0, 300))
        : [];
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
        outreachDraft: doNotContact ? null : outreachDraft,
        doNotContact,
        doNotContactReason: doNotContact ? str(ui.doNotContactReason, 300) : null,
    };
}

/** Render the ICP block from the campaign's snapshot (same fields the chat route uses). */
export function icpBlock(icp: Record<string, unknown>): string {
    return [
        `- Target industries: ${icp.targetIndustries ? JSON.stringify(icp.targetIndustries) : 'not specified — treat as neutral'}`,
        `- Minimum company headcount: ${icp.minHeadcount ?? 'not specified — treat as neutral'}`,
        `- Sales tone: ${icp.salesTone ?? 'professional'} — write outreach and next steps in this tone.`,
    ].join('\n');
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

FIRST, for each candidate ask: is this an actual company we could SELL TO? Search results are full of pages that are merely ABOUT the target market rather than a business in it. Score 0-10 and rate "cold" for any of these, however topically relevant they look:
- a directory, marketplace, listing or review site that AGGREGATES businesses of the target type
- an article, blog post, guide, listicle, PDF or template about the target market
- a news outlet, magazine or publisher covering the sector
- a software vendor or agency that SELLS TO the target market (a competitor or peer supplier, not a customer)
- a social network, forum, wiki or job board
Topical relevance is NOT fit. "An article listing the best wedding venues" is not a wedding venue; "software for managing hotels" is not a hotel. Say so plainly in reasons.

Ideal customer profile (from setup):
${icpBlock(icp)}

${SCORING_BANDS}

Return STRICT JSON only (no markdown): an array with ONE object per candidate, in the SAME ORDER as given:
[
  {
    "leadName": "<company name>",
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
