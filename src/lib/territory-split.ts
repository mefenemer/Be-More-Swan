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

/** Word-boundary, case-insensitive test/locate for a literal phrase. */
function escapeRegExp(v: string): string {
    return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function locate(haystack: string, needle: string): { at: number; length: number } | null {
    if (!needle) return null;
    const m = new RegExp(`(?<![\\w-])${escapeRegExp(needle)}(?![\\w-])`, 'i').exec(haystack);
    return m ? { at: m.index, length: m[0].length } : null;
}

/**
 * The names a territory might appear under in a query.
 *
 * Multi-word counties get their distinctive last word too: the query generator writes "primary
 * school Sussex" while the register says "East Sussex" and "West Sussex", and without the short
 * form that query looks geographically unanchored and gets a second county bolted onto it.
 *
 * ⚠️ Short forms are only taken from names of 2-3 words, and only the final word. "Isle of Wight"
 * must never reduce to "Wight" as a separate concept, and no short form is derived from a
 * single-word name — "Reading" stays "Reading".
 */
function aliasesOf(territory: string): string[] {
    const parts = territory.trim().split(/\s+/);
    const out = [territory.trim()];
    if (parts.length >= 2 && parts.length <= 3) {
        const last = parts[parts.length - 1];
        // Skip the joining words that make a compound name, so "Brighton and Hove" does not
        // contribute "Hove" as though it were the county.
        if (last.length > 3 && !/^(of|and|the)$/i.test(parts[parts.length - 2])) out.push(last);
    }
    return out;
}

/**
 * Every place in `query` that already names one of `territories`, earliest first.
 *
 * ⚠️ Longest alias first at each position, so "East Sussex" is matched as one span rather than
 * leaving a stray "East " behind when the short form "Sussex" is swapped out.
 */
function namedTerritorySpans(query: string, territories: string[]): Array<{ at: number; length: number }> {
    const aliases = [...new Set(territories.flatMap(aliasesOf))].sort((a, b) => b.length - a.length);
    const spans: Array<{ at: number; length: number }> = [];
    for (const alias of aliases) {
        const hit = locate(query, alias);
        if (!hit) continue;
        // Skip anything overlapping a span already claimed by a longer alias.
        if (spans.some((s) => hit.at < s.at + s.length && s.at < hit.at + hit.length)) continue;
        spans.push(hit);
    }
    return spans.sort((a, b) => a.at - b.at);
}

/** The area, and the area with a trailing exclusion clause removed. */
function areaPhrases(area: string): string[] {
    const a = String(area ?? '').trim();
    if (!a) return [];
    const trimmed = a.replace(/[,;]?\s*\b(excluding|except|but not|other than)\b.*$/i, '').trim();
    return trimmed && trimmed !== a ? [a, trimmed] : [a];
}

/** Replace the span at `at` with `replacement`, tidying the whitespace it leaves behind. */
function spliceSpan(q: string, at: number, length: number, replacement: string): string {
    return `${q.slice(0, at)}${replacement}${q.slice(at + length)}`.replace(/\s{2,}/g, ' ').trim();
}

/**
 * How cleanly a query can be expanded — used to CHOOSE which query to expand, rather than
 * blindly taking the first of each group.
 *
 * ⚠️ This exists because "replace the territory it names" only strips territories the split
 * actually enumerated. A query naming a place OUTSIDE that list — a unitary authority when the
 * split came back at county level — keeps it, and the two-county bug returns by the back door:
 * "primary school Kent Medway" becomes "primary school Surrey Medway". Rather than pretend a
 * gazetteer is available, prefer a query the substitution can handle exactly.
 *
 *   'area'      — names the area itself; substitution is unambiguous. Best.
 *   'territory' — names only territories the split knows; they can all be stripped. Good.
 *   'none'      — geographically unanchored; the territory is appended. Safe, if blunt.
 *   'unknown'   — names a place the split did not enumerate. AVOID: expanding this is what
 *                 produces a query about two different places.
 */
export function expansionAnchor(query: string, area: string, territories: string[]): 'area' | 'territory' | 'none' | 'unknown' {
    const q = String(query ?? '').trim();
    const list = territories.map((t) => String(t ?? '').trim()).filter(Boolean);
    if (!q || list.length === 0) return 'none';

    for (const phrase of areaPhrases(area)) if (locate(q, phrase)) return 'area';

    const spans = namedTerritorySpans(q, list);
    if (spans.length === 0) return 'none';

    // Anything left that looks like a place once the KNOWN territories are removed. Detected by
    // re-running the alias scan over the residue is impossible (the residue has no vocabulary), so
    // this instead asks the cheap question: after stripping every known span, does a capitalised
    // word survive outside quotes and operators?
    let residue = q;
    for (let i = spans.length - 1; i >= 0; i--) residue = spliceSpan(residue, spans[i].at, spans[i].length, '');
    const suspicious = residue
        .replace(/"[^"]*"/g, ' ')          // quoted phrases are the user's wording, not a place
        .replace(/-\w+:[^\s]+/g, ' ')      // -site:/-inurl: operators
        .split(/\s+/)
        .some((w) => /^[A-Z][a-z]{3,}$/.test(w));
    return suspicious ? 'unknown' : 'territory';
}

/**
 * Pick the query in a group that expands most cleanly, preferring an exact anchor over the first
 * one written. Returns its index; -1 when the group is empty.
 */
export function pickExpansionSource(queries: string[], area: string, territories: string[]): number {
    if (queries.length === 0) return -1;
    const rank = { area: 0, territory: 1, none: 2, unknown: 3 } as const;
    let best = 0;
    for (let i = 1; i < queries.length; i++) {
        if (rank[expansionAnchor(queries[i], area, territories)] < rank[expansionAnchor(queries[best], area, territories)]) best = i;
    }
    return best;
}

/**
 * Rewrite one query per territory, in code rather than by asking a model to do it.
 *
 * ⚠️ The model names territories; it does not write queries. Query strings carry operators the
 * pipeline depends on (`-site:`, `-inurl:`) and a regenerated set would quietly drop or mangle
 * them — the exclusions are half of what the user approved. Substitution keeps every operator
 * exactly as reviewed.
 *
 * ── Three anchors, tried in order ────────────────────────────────────────────
 *
 * 1. A TERRITORY THE QUERY ALREADY NAMES. This case was missed when this shipped, and a live plan
 *    walked straight into it: the query generator had already sliced geographically on its own, so
 *    the first query of each group read "primary school Surrey" while the area string was "South
 *    East England excluding Essex". Neither matched, everything fell to the append branch, and the
 *    expansion produced "primary school Surrey Kent" — two counties in one query — and "primary
 *    school Surrey Surrey". Roughly a third of the plan would have been nonsense, one paid search
 *    each. So a named territory is REPLACED, and any further ones are dropped: a query for one
 *    county must not still be asking about another.
 *
 * 2. THE AREA PHRASE. Also matched against the area with a trailing "excluding …" clause removed,
 *    because "South East England excluding Essex" never appears verbatim in a query that simply
 *    says "south east England".
 *
 * 3. APPEND. Only when the query is geographically unanchored, which is the one case where adding
 *    a territory cannot contradict anything already in it.
 */
export function expandQueryAcrossTerritories(query: string, area: string, territories: string[]): string[] {
    const q = String(query ?? '').trim();
    const list = territories.map((t) => String(t ?? '').trim()).filter(Boolean);
    if (!q || list.length === 0) return q ? [q] : [];

    const spans = namedTerritorySpans(q, list);

    const rewrite = (t: string): string => {
        if (spans.length) {
            // Replace the first, delete the rest — right to left so earlier offsets stay valid.
            let out = q;
            for (let i = spans.length - 1; i >= 1; i--) out = spliceSpan(out, spans[i].at, spans[i].length, '');
            return spliceSpan(out, spans[0].at, spans[0].length, t);
        }
        for (const phrase of areaPhrases(area)) {
            const hit = locate(q, phrase);
            if (hit) return spliceSpan(q, hit.at, hit.length, t);
        }
        return `${q} ${t}`;
    };

    // Deduped: two territories can collapse to the same string once a query naming several of them
    // has the extras stripped, and paying twice for one query is the waste this exists to end.
    return [...new Set(list.map(rewrite))];
}
