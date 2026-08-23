// src/lib/territory-split.ts
// Turn one query about a big area into many queries about small ones.
//
// ── The arithmetic that makes this necessary ─────────────────────────────────
// "primary school kent surrey sussex" is ONE search against roughly 1,500 schools. Even paginated
// to its limit it reads a few dozen. The problem is not depth — it is that the query addresses a
// population three orders of magnitude larger than any single result set can represent, so what
// comes back is whatever ranks, not whatever matches.
//
// Splitting by territory changes the shape of the question: 19 South East local authorities, each
// with a query of its own, means each search addresses a population small enough for its results to
// be a meaningful fraction of it. That is the difference between sampling a market and covering it,
// and it is the only lever here that changes the ORDER of the answer rather than a multiple of it.
//
// ── Why this is a separate, user-visible step ────────────────────────────────
// ⚠️ NOT folded into the query-generation prompt. That prompt already carries a tension between
// "STEP ONE — name the prospect's trade" and "return STRICT JSON only" which cost seven of nine
// runs on 2026-08-22 (see src/utils/model-json.ts). Adding a second reasoning task to it would put
// a much larger change through the most fragile surface in the pipeline. This runs on demand,
// returns a plan the user reads before approving, and cannot affect a run nobody asked to expand.
//
// The model is asked ONLY to name the territories — a factual recall task. It never writes the
// expanded queries; that is string substitution, done here, where it is inspectable.

import Anthropic from '@anthropic-ai/sdk';
import { parseModelJson } from '../utils/model-json';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

/** Above this, a split stops being a plan and becomes a bill. */
export const MAX_TERRITORIES = 40;

export interface TerritorySplit {
    /** What the area was understood to be, e.g. "South East England". */
    area: string;
    /** The sub-areas, e.g. ["Kent", "Surrey", "West Sussex", …]. */
    territories: string[];
    /** How they were divided, e.g. "counties and unitary authorities". */
    basis: string;
}

const SYSTEM =
`You break a geographic area into the sub-areas a business would use to work it systematically.

Given a description of who someone wants to find, identify the geographic area named in it and list the standard administrative sub-areas that COMPLETELY cover it, with no overlaps and no gaps.

Rules:
- Use the standard administrative divisions for that country — UK counties or unitary authorities, US states or counties, and so on. Never invent groupings of your own.
- COMPLETE COVERAGE matters more than granularity. Every part of the area must fall in exactly one sub-area.
- Respect any exclusion in the description: if it says "excluding Essex", Essex must not appear.
- If the description names no geographic area, or names one already small enough to search directly (a single town or borough), return an empty list. That is a normal answer, not a failure.
- Never return more than ${MAX_TERRITORIES} sub-areas. If the area would need more, use the coarser level of division instead.

Return STRICT JSON only:
{ "area": "<the area as you understood it>", "basis": "<what these divisions are>", "territories": ["<sub-area>", ...] }`;

/**
 * Never throws. Returns null when there is no useful split — no area named, an area already small
 * enough, or any failure at all. The caller shows nothing in that case.
 */
export async function splitTerritories(idea: string): Promise<TerritorySplit | null> {
    const text = String(idea ?? '').trim();
    if (!text || !process.env.ANTHROPIC_API_KEY) return null;

    try {
        const resp = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 700,
            system: SYSTEM,
            messages: [{ role: 'user', content: `Who they want to find:\n${text.slice(0, 1000)}` }],
        });
        const parsed = parseModelJson<Record<string, unknown>>(
            resp.content[0]?.type === 'text' ? resp.content[0].text : '',
        );
        if (!parsed) return null;

        const territories = Array.isArray(parsed.territories)
            ? parsed.territories
                .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                .map((t) => t.trim().slice(0, 80))
                .slice(0, MAX_TERRITORIES)
            : [];
        // One sub-area is not a split — it is the same query wearing a hat, and offering it would
        // spend a model call to tell the user nothing.
        if (territories.length < 2) return null;

        return {
            area: typeof parsed.area === 'string' ? parsed.area.trim().slice(0, 120) : '',
            basis: typeof parsed.basis === 'string' ? parsed.basis.trim().slice(0, 120) : '',
            territories,
        };
    } catch (err) {
        console.error('[territory-split] split failed (non-fatal):', err);
        return null;
    }
}

/**
 * Rewrite one query per territory, in code rather than by asking a model to do it.
 *
 * ⚠️ The model names territories; it does not write queries. Query strings carry operators the
 * pipeline depends on (`-site:`, `-inurl:`) and a regenerated set would quietly drop or mangle
 * them — the exclusions are half of what the user approved. Substitution keeps every operator
 * exactly as reviewed.
 *
 * The area phrase is replaced where it appears, so `-site:` operators at the tail are untouched.
 * When the phrase is not found verbatim, the territory is appended instead — a query that names
 * the area only loosely still becomes territory-specific.
 */
export function expandQueryAcrossTerritories(query: string, area: string, territories: string[]): string[] {
    const q = String(query ?? '').trim();
    if (!q || territories.length === 0) return q ? [q] : [];

    const needle = String(area ?? '').trim();
    const at = needle ? q.toLowerCase().indexOf(needle.toLowerCase()) : -1;

    return territories.map((t) => (
        at === -1
            ? `${q} ${t}`
            : `${q.slice(0, at)}${t}${q.slice(at + needle.length)}`.replace(/\s{2,}/g, ' ').trim()
    ));
}
