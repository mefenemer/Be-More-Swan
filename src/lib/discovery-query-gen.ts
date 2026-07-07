// src/lib/discovery-query-gen.ts
// The inversion at the heart of the outbound engine: turn a user's "Idea / Blueprint"
// into ARRAYS OF SEARCH QUERIES a scraper will run — NOT a list of invented companies.
// (The old lead-generation.ts:approve_idea asked the LLM to fabricate companies; this
// replaces that with real query generation.) Design: docs/lead-generator-discovery-plan.md §3.
//
// One Anthropic call per run; the result is cached on discovery_jobs.cursor so retries
// don't re-pay for it.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export const QUERY_GEN_MODEL = 'claude-haiku-4-5-20251001';

// The three discovery strategies map 1:1 to discovered_leads.discovered_via.
export type DiscoveryStrategy = 'niche_scrape' | 'intent_signal' | 'footprint';

export interface GeneratedQueries {
    niche_scrape: string[];
    intent_signal: string[];
    footprint: string[];
}

export interface QueryGenResult {
    queries: GeneratedQueries;
    /** Flattened to { query, strategy } pairs in run order — what the worker iterates. */
    flat: Array<{ query: string; strategy: DiscoveryStrategy }>;
    inputTokens: number;
    outputTokens: number;
}

const EMPTY: GeneratedQueries = { niche_scrape: [], intent_signal: [], footprint: [] };

function cleanList(v: unknown, max: number): string[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 300))
        .slice(0, max);
}

/** Strip accidental ```json fences and parse; null (not throw) on bad JSON. */
function parseJson<T = unknown>(raw: string): T | null {
    const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(text) as T; } catch { return null; }
}

export interface QueryGenInput {
    idea: string;
    targetPersona?: Record<string, unknown> | null;
    icpSnapshot?: Record<string, unknown> | null;
    negativeKeywords?: string[];
    /** Max queries per strategy (default 5). Keep small — each query is a paid search call. */
    perStrategy?: number;
}

/**
 * Generate search queries for a discovery run. Never throws on a bad LLM response —
 * returns empty arrays so the worker can fail the job cleanly with a clear message.
 */
export async function generateQueries(input: QueryGenInput): Promise<QueryGenResult> {
    const perStrategy = Math.max(1, Math.min(input.perStrategy ?? 5, 10));
    const negatives = (input.negativeKeywords ?? []).filter(Boolean).slice(0, 50);

    const system =
`You are a B2B lead-discovery query strategist. Turn the user's business hypothesis into search queries a scraper will run against Google (and Google-indexed maps, directories and registries). Output ONLY queries — never name or invent companies.

Produce exactly three query arrays, each covering a distinct strategy:
- "niche_scrape": direct discovery of businesses that fit the profile (directories, maps, "best X in Y" style, site: operators).
- "intent_signal": queries that surface buying/pain signals — hiring pages, tech-stack mentions, recent press, public reviews naming the pain.
- "footprint": negative-match / omission queries that surface the ABSENCE the solution fixes (e.g. -inurl: operators, phrases implying a manual process).

Rules:
- Up to ${perStrategy} queries per array. Fewer, high-precision queries beat many vague ones.
- Use real Google search operators where they help (site:, inurl:, -inurl:, quoted phrases).
- NEVER target these excluded terms/competitors: ${negatives.length ? JSON.stringify(negatives) : '(none provided)'}.
- Ground every query in the idea, persona and ICP below.

Return STRICT JSON only (no markdown):
{ "niche_scrape": ["..."], "intent_signal": ["..."], "footprint": ["..."] }`;

    const userMsg =
`Idea / hypothesis:
${input.idea}

Target persona:
${JSON.stringify(input.targetPersona ?? {})}

Ideal customer profile (from setup):
${JSON.stringify(input.icpSnapshot ?? {})}`;

    let inputTokens = 0;
    let outputTokens = 0;
    let queries = EMPTY;

    try {
        const resp = await anthropic.messages.create({
            model: QUERY_GEN_MODEL,
            max_tokens: 1024,
            system,
            messages: [{ role: 'user', content: userMsg }],
        });
        inputTokens = resp.usage.input_tokens;
        outputTokens = resp.usage.output_tokens;
        const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
        const parsed = parseJson<Record<string, unknown>>(raw);
        if (parsed) {
            queries = {
                niche_scrape: cleanList(parsed.niche_scrape, perStrategy),
                intent_signal: cleanList(parsed.intent_signal, perStrategy),
                footprint: cleanList(parsed.footprint, perStrategy),
            };
        }
    } catch (err) {
        console.error('[discovery-query-gen] generation failed:', err);
    }

    // Interleave strategies so an early budget cut still samples all three.
    const flat: QueryGenResult['flat'] = [];
    const strategies: DiscoveryStrategy[] = ['niche_scrape', 'intent_signal', 'footprint'];
    const max = Math.max(...strategies.map((s) => queries[s].length), 0);
    for (let i = 0; i < max; i++) {
        for (const s of strategies) {
            const q = queries[s][i];
            if (q) flat.push({ query: q, strategy: s });
        }
    }

    return { queries, flat, inputTokens, outputTokens };
}
