// src/utils/halt-tightening.ts
// The new description a halt decision proposes for a lead search that keeps finding the wrong
// companies.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Until 2026-11-03 a halt's `narrow_targeting` order carried no new description at all, and its
// executor answered "Search targeting tightened" while changing nothing — the owner approved a real
// halt on "Small creative & professional services firms" (84 found, 38 cold) and the search ran on
// exactly as before. A halt now either carries the concrete wording it will write, shown on the card
// before anyone approves it, or carries `pauseSearch` and says so.
//
// ── Where the wording comes from ─────────────────────────────────────────────
// The scorer already wrote down why each cold lead was cold: free-text `reasons`, plus three
// structured fields (prospectType, excludedBy, outsideArea). Two sources, best first:
//   1. A model reads the current description and those reasons and rewrites the description to
//      leave out what keeps coming back. Grounded: it sees only what the scorer recorded, and is
//      told to keep the sector and area the user chose.
//   2. If the model is unavailable or declines, a fixed sentence built from the structured fields
//      alone — "Only businesses of this kind themselves, not directories, news sites or articles."
// Neither → null, and the halt pauses the search instead of pretending to tighten it.
//
// Fails soft everywhere: this runs inside the proposer and inside a restore, and neither may fail
// because a model call did.

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte } from 'drizzle-orm';
import { discoveredLeads, discoveryCampaigns } from '../../db/schema';
import { logMessageUsage } from './ai-usage';
import { parseModelJson } from './model-json';
import type { mirrorDecision } from './campaign-mirror';
import { adaptForModel, replyText } from '../config/model-options';

type Db = Parameters<typeof mirrorDecision>[0];

const MODEL = 'claude-haiku-5-5';

/** Cold leads read per search. Enough for a pattern; small enough for one cheap call. */
export const COLD_SAMPLE = 30;

/** How many cold leads must share a structured reason before it is worth writing into the search. */
export const MIN_PATTERN_LEADS = 2;

/** The longest description written back — campaign-plan.ts BRIEF_TEXT_FIELDS.idea. */
const MAX_IDEA = 1000;

export interface ColdLead {
    companyName: string;
    reasons: string[];
    prospectType: string | null;
    excludedBy: string | null;
    outsideArea: string | null;
}

export interface Tightening {
    /** The search's description now — shown as "Search now" so the change is visible. */
    previousIdea: string;
    /** What it will read after approval, or null when nothing dependable could be worked out. */
    idea: string | null;
}

/** Cold, actually-scored leads a search found since `since`, newest first. */
export async function loadColdLeads(db: Db, discoveryCampaignId: number, since: Date): Promise<ColdLead[]> {
    const rows = await db.select({ companyName: discoveredLeads.companyName, card: discoveredLeads.scoringCard })
        .from(discoveredLeads)
        .where(and(
            eq(discoveredLeads.campaignId, discoveryCampaignId),
            eq(discoveredLeads.rating, 'cold'),
            gte(discoveredLeads.createdAt, since),
        ))
        .orderBy(desc(discoveredLeads.createdAt))
        .limit(COLD_SAMPLE * 2);
    return rows.map((r) => toColdLead(r.companyName, r.card)).filter((c): c is ColdLead => !!c).slice(0, COLD_SAMPLE);
}

/** One scoring card as evidence, or null for a card nobody judged (scoringFailed) — unscored is not cold. */
export function toColdLead(companyName: string, card: unknown): ColdLead | null {
    const c = (card && typeof card === 'object' ? card : {}) as Record<string, unknown>;
    if (c.scoringFailed === true) return null;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    return {
        companyName: String(companyName || '').slice(0, 120),
        reasons: Array.isArray(c.reasons) ? c.reasons.map(s).filter((x): x is string => !!x).slice(0, 4) : [],
        prospectType: s(c.prospectType),
        excludedBy: s(c.excludedBy),
        outsideArea: s(c.outsideArea),
    };
}

const NOT_A_CUSTOMER: Record<string, string> = {
    supplier_to_target: 'businesses that sell to them',
    aggregator: 'directories or listing sites',
    media: 'news sites or magazines',
    content_page: 'articles or guides',
    platform: 'social networks, forums or job boards',
};

/**
 * The fallback: a fixed sentence per structured reason that at least MIN_PATTERN_LEADS cold leads
 * share, appended to the user's own description. Pure, for the test. Null when no reason repeats.
 */
export function structuredTightening(idea: string, cold: ColdLead[]): string | null {
    const count = (vals: Array<string | null>) => {
        const m = new Map<string, number>();
        for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
        return [...m].filter(([, n]) => n >= MIN_PATTERN_LEADS).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    const sentences: string[] = [];

    const types = count(cold.map((c) => c.prospectType)).filter((t) => NOT_A_CUSTOMER[t]);
    if (types.length) {
        sentences.push(`Only businesses of this kind themselves — not ${types.map((t) => NOT_A_CUSTOMER[t]).join(', ')}.`);
    }
    const abroad = cold.filter((c) => c.outsideArea).length;
    if (abroad >= MIN_PATTERN_LEADS) sentences.push('Only businesses based in the area named above.');
    const excluded = count(cold.map((c) => c.excludedBy)).slice(0, 3);
    if (excluded.length) sentences.push(`Leave out ${excluded.map((e) => `"${e}"`).join(', ')}.`);

    if (!sentences.length) return null;
    return `${idea.trim().replace(/\s+$/, '')}${/[.!?]$/.test(idea.trim()) ? '' : '.'} ${sentences.join(' ')}`.slice(0, MAX_IDEA);
}

const SYSTEM =
`You tighten the description of a saved B2B lead search. The search is mostly finding companies that are not a fit, and you are given the scorer's own reasons for each company it rated cold.

Rewrite the description so the search stops finding those companies:
- Keep the user's sector, location and size wording. You are narrowing their search, not choosing a new market.
- Add only exclusions or qualifiers that at least two of the cold reasons support. Never invent a reason.
- Plain English, one short paragraph, under 600 characters, written as a description of who to find (not as instructions to a search engine).
- If the cold reasons share no pattern you can turn into a clearer description, return null.

Return STRICT JSON only: { "idea": "<the tightened description>" | null }`;

/** The model's rewrite, or null. Never throws. */
export async function modelTightening(idea: string, cold: ColdLead[]): Promise<string | null> {
    if (!process.env.ANTHROPIC_API_KEY || cold.length < MIN_PATTERN_LEADS) return null;
    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const evidence = cold.map((c, i) => {
            const tags = [
                c.prospectType && c.prospectType !== 'target_business' ? `type: ${c.prospectType}` : '',
                c.excludedBy ? `matches exclusion: ${c.excludedBy}` : '',
                c.outsideArea ? `located: ${c.outsideArea}` : '',
            ].filter(Boolean).join('; ');
            return `${i + 1}. ${c.companyName}${tags ? ` (${tags})` : ''} — ${c.reasons.join(' / ') || 'no reason recorded'}`;
        }).join('\n');
        const resp = await anthropic.messages.create(adaptForModel({
            model: MODEL,
            max_tokens: 400,
            system: SYSTEM,
            messages: [{
                role: 'user',
                content: `Current description:\n${idea.slice(0, MAX_IDEA)}\n\nCompanies it found that were rated cold, with the scorer's reasons:\n${evidence.slice(0, 8000)}`,
            }],
        }, MODEL, 'low') as Anthropic.MessageCreateParamsNonStreaming);
        await logMessageUsage(resp, MODEL, { sessionId: 'halt-tightening' });
        const raw = replyText(resp.content);
        const parsed = parseModelJson<Record<string, unknown>>(raw);
        return usableIdea(parsed?.idea, idea);
    } catch (err) {
        console.warn('[halt-tightening] model rewrite failed', err);
        return null;
    }
}

/** A proposed description worth showing: non-empty, bounded, and actually different. Pure. */
export function usableIdea(value: unknown, current: string): string | null {
    if (typeof value !== 'string') return null;
    const next = value.trim().replace(/\s+/g, ' ').slice(0, MAX_IDEA);
    if (next.length < 10) return null;
    if (next.toLowerCase() === current.trim().replace(/\s+/g, ' ').toLowerCase()) return null;
    return next;
}

/**
 * The tightening a halt on this search should propose. Null only when the search itself is gone.
 * `idea: null` means nothing dependable could be worked out — the halt then pauses instead.
 */
export async function proposeTightening(
    db: Db, organisationId: number, discoveryCampaignId: number, since: Date,
    rewrite: (idea: string, cold: ColdLead[]) => Promise<string | null> = modelTightening,
): Promise<Tightening | null> {
    const [search] = await db.select({ idea: discoveryCampaigns.idea })
        .from(discoveryCampaigns)
        .where(and(eq(discoveryCampaigns.id, discoveryCampaignId), eq(discoveryCampaigns.organisationId, organisationId)))
        .limit(1);
    if (!search) return null;
    const cold = await loadColdLeads(db, discoveryCampaignId, since);
    const idea = (await rewrite(search.idea, cold)) ?? usableIdea(structuredTightening(search.idea, cold), search.idea);
    return { previousIdea: search.idea, idea };
}
