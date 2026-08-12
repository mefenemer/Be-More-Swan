// src/lib/discovery-query-gen.ts
// The inversion at the heart of the outbound engine: turn a user's "Idea / Blueprint"
// into ARRAYS OF SEARCH QUERIES a scraper will run — NOT a list of invented companies.
// (The old lead-generation.ts:approve_idea asked the LLM to fabricate companies; this
// replaces that with real query generation.) Design: docs/lead-generator-discovery-plan.md §3.
//
// One Anthropic call per run; the result is cached on discovery_jobs.cursor so retries
// don't re-pay for it.

import Anthropic from '@anthropic-ai/sdk';
import {
    excludedDomainsByCategory, EXCLUDED_SUBDOMAINS, EXCLUDED_TITLE_SHAPES,
} from './discovery-domain-filter';

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
    /**
     * Queries a human approved for this campaign on a previous run (Phase 0).
     *
     * ⚠️ Used as STEERING, never replayed. Re-issuing the same query strings returns substantially
     * the same domains, and the (campaign_id, domain) dedupe then discards every one — a weekly
     * campaign would find leads once and nothing ever again. So the approved plan is shown to the
     * model as the shape of query this user wants, and fresh queries are generated within it.
     */
    approvedQueries?: string[];
}

/** How many example domains to quote per blocked category. Enough to teach the rule, not the list. */
const EXAMPLES_PER_CATEGORY = 6;

/** Human labels for each exclusion category, in the order the prompt should state them. */
const CATEGORY_LABELS: Record<string, string> = {
    social: 'social networks and UGC platforms',
    aggregator: 'directories, marketplaces, review and listing sites',
    media: 'news sites, magazines and publishers',
    reference: 'encyclopaedic and data platforms',
    jobs: 'job boards and recruitment sites',
};

/**
 * The prohibition block, BUILT from src/lib/discovery-domain-filter.ts rather than retyped.
 *
 * ⚠️ This exists because the prompt used to ask for exactly what the filter drops — it
 * described niche_scrape as "directories, maps, best X in Y style" and intent_signal as
 * "hiring pages, recent press, public reviews". A prod run then generated
 * `site:trustpilot.com OR site:g2.com`, `site:linkedin.com/jobs`, `inurl:careers OR inurl:jobs`
 * and `best social media agencies UK ... directories`; all 35 results were discarded or scored
 * cold, at full search-and-token cost. Generating this text from the filter's own tables means
 * a category added there reaches the prompt on the next run, with no second edit to forget.
 */
function buildExclusionRules(): string {
    const grouped = excludedDomainsByCategory();
    const lines = Object.entries(CATEGORY_LABELS).map(([category, label]) => {
        const examples = (grouped[category as keyof typeof grouped] ?? []).slice(0, EXAMPLES_PER_CATEGORY);
        return `- ${label}${examples.length ? ` (e.g. ${examples.join(', ')})` : ''}`;
    });

    return `HARD EXCLUSIONS — results from these are thrown away before scoring, so a query aimed at them is wasted spend, not a near miss:
${lines.join('\n')}
Never write site: operators pointing at them, and never ask for the kind of page they host:
reviews, job adverts, press coverage, forum threads or "best/top" roundups.

Also excluded are these subdomains of any host, because they are a company's publishing or
support surface rather than the company itself: ${EXCLUDED_SUBDOMAINS.join(', ')}.

Finally, results whose TITLE reads as one of these are dropped, so do not ask for them:
${EXCLUDED_TITLE_SHAPES.map((s) => `- ${s}`).join('\n')}`;
}

/**
 * The system prompt, as a pure function of the two things that vary.
 *
 * Exported so tests can assert what the model is actually told — the last defect here was
 * entirely in this text (it asked for directories, hiring pages, press and reviews), and a
 * test that greps the source file rather than the built string would not have caught it.
 */
export function buildSystemPrompt(perStrategy: number, negatives: string[], approvedQueries: string[] = []): string {
    const exclusionRules = buildExclusionRules();
    const steering = approvedQueries.length
        ? `\nA human previously reviewed and approved this campaign's search plan. These are the queries they signed off:\n${approvedQueries.map((q) => `- ${q}`).join('\n')}\nMatch their SHAPE, phrasing and level of specificity — they are what this user considers a good query.\n⚠️ Do NOT reuse them. Identical queries return the same companies, and companies already found by this campaign are discarded as duplicates, so a repeat of the list above finds nothing at all. Write NEW queries that the same reviewer would have approved.\n`
        : '';
    return (
`You are a B2B lead-discovery query strategist. Turn the user's business hypothesis into search queries a scraper will run against Google. Output ONLY queries — never name or invent companies.

THE SINGLE RULE THAT MATTERS: every result must be a SELLABLE COMPANY'S OWN WEBSITE.
The pipeline takes the domain of each search result and treats it as the prospect. A result on
someone else's site therefore becomes a lead for THAT site, not for the company it discusses.
A query that surfaces an article about your market produces a lead for the magazine; a query
that surfaces a job advert produces a lead for the job board. Both are then discarded. So aim
every query at the prospect's own domain — their services, products, locations or about pages.

Produce exactly three query arrays, each a distinct ANGLE on finding those company websites:
- "niche_scrape": the trade language a business in this niche uses to describe ITSELF — the
  words that appear on its own services or about page.
- "intent_signal": the pain or gap stated in the company's OWN words on its OWN site.
- "footprint": omission queries — phrases implying the manual process the solution replaces,
  with -inurl:/-site: operators used to push away vendors and platforms.

${exclusionRules}
${steering}
Rules:
- Up to ${perStrategy} queries per array. Fewer, high-precision queries beat many vague ones.
- Use real Google search operators where they help (inurl:, -inurl:, -site:, quoted phrases).
- NEVER target these excluded terms/competitors: ${negatives.length ? JSON.stringify(negatives) : '(none provided)'}.
- Ground every query in the idea, persona and ICP below.

Return STRICT JSON only (no markdown):
{ "niche_scrape": ["..."], "intent_signal": ["..."], "footprint": ["..."] }`
    );
}

/**
 * Generate search queries for a discovery run. Never throws on a bad LLM response —
 * returns empty arrays so the worker can fail the job cleanly with a clear message.
 */
export async function generateQueries(input: QueryGenInput): Promise<QueryGenResult> {
    const perStrategy = Math.max(1, Math.min(input.perStrategy ?? 5, 10));
    const negatives = (input.negativeKeywords ?? []).filter(Boolean).slice(0, 50);
    const approved = (input.approvedQueries ?? []).filter(Boolean).slice(0, 30);
    const system = buildSystemPrompt(perStrategy, negatives, approved);

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

    return { queries, flat: flattenQueries(queries), inputTokens, outputTokens };
}

/**
 * Interleave the three strategies into the order the worker runs them.
 *
 * Interleaved rather than concatenated so an early budget cut still samples all three — a run that
 * halts at query four should have tried each angle once, not spent everything on niche_scrape.
 *
 * ⚠️ Exported because a user-EDITED plan has to be flattened by the same rule that flattened the
 * generated one (Phase 0: discovery-campaigns.ts `approve_brief` seeds the first job's cursor from
 * this). Two implementations would mean the queries a user approved ran in a different order from
 * the ones they were shown, and a budget cut would then drop a different set.
 */
export function flattenQueries(queries: GeneratedQueries): QueryGenResult['flat'] {
    const flat: QueryGenResult['flat'] = [];
    const strategies: DiscoveryStrategy[] = ['niche_scrape', 'intent_signal', 'footprint'];
    const max = Math.max(...strategies.map((s) => queries[s].length), 0);
    for (let i = 0; i < max; i++) {
        for (const s of strategies) {
            const q = queries[s][i];
            if (q) flat.push({ query: q, strategy: s });
        }
    }
    return flat;
}
