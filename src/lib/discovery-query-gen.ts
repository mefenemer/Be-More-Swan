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

STEP ONE — NAME THE PROSPECT'S TRADE. Do this before writing a single query.

The hypothesis below will usually describe the PROBLEM being solved or the PRODUCT being sold.
Searching for either finds the vendors, not the buyers:
  WRONG "social media scheduling tool"      → returns Buffer, Hootsuite, Later
  WRONG "user-generated content platform"   → returns UGC software companies
  WRONG "lead generation outreach tool"     → returns sales software
  WRONG "content calendar tool uk"          → returns more software
The prospect is the business that HAS that problem, and it does not describe itself by the
problem. A bakery calls itself a bakery. Name the trade, then search for it:
  RIGHT "independent skincare brand"
  RIGHT "small batch homeware brand UK"
  RIGHT "family law firm Manchester"
  RIGHT "boutique letting agency"
If the hypothesis names no trade, infer several concrete ones from the industries and size band
and cover each. Four specific trades beat one abstract category every time.

⚠️ ANALYST JARGON IS NOT A TRADE. "DTC", "D2C", "direct-to-consumer", "e-commerce brand",
"omnichannel retailer", "SaaS company" are how the market is DESCRIBED by people writing about
it. Almost no business writes them on its own homepage — so a query built on one finds the
people who write about the market rather than the market. Measured on a live run: queries using
"direct-to-consumer apparel" returned 13 companies of which 1 was sellable, while "small batch
homeware" returned 14 of which 9 were. Same run, same campaign, same operators.
  WRONG "direct-to-consumer apparel"   RIGHT "womenswear label", "organic cotton t-shirts"
  WRONG "e-commerce brand"             RIGHT "independent skincare brand", "ceramics studio"
Say what they SELL, in the words they would print on their own shop.

Produce exactly three query arrays, each a distinct ANGLE on finding those company websites:
- "niche_scrape": the trade term itself, as a business in that trade writes it on its own
  services or about page. This array should read like a list of trades, not a list of topics.
- "intent_signal": the trade term PLUS a COMMERCIAL MARKER that only appears on a real trading
  company's own site — stockists, wholesale or trade enquiries, trade pricing, "our story",
  "founded in", "made in", a town or county, opening hours, a returns or shipping page.
  ⚠️ NOT the customer's pain, and NOT a phrase in their own voice. A quoted phrase like
  "spending too much" or "converting followers" is copywriting, and copywriting lives in
  ARTICLES ABOUT the market, never on the trading company's own pages. Measured on a live run:
  every query containing a quoted experiential phrase returned zero sellable companies.
- "footprint": the trade term PLUS -inurl:/-site: operators pushing away the hosts and page types
  that keep winning — blogs, marketplaces, social profiles, help centres.
  ⚠️ The operators do not rescue a bad trade term; they only prune a good one. On the same run
  the identical operator pattern returned five real companies with one trade term and none with
  another. Choose the trade term first.

⚠️ Every array must be anchored to the trade. A query with no trade term in it is almost always
a query about the product category, and will be thrown away.

${exclusionRules}
${steering}
Rules:
- Up to ${perStrategy} queries per array. Fewer, high-precision queries beat many vague ones.
- Use real Google search operators where they help (inurl:, -inurl:, -site:, quoted phrases).
- ⚠️ site: and -site: take a FULL DOMAIN and nothing else: -site:medium.com, -site:linkedin.com.
  A bare word after -site: is silently ignored by the search engine, so it costs you a filter you
  thought you had. To exclude a word in a URL PATH use -inurl: instead:
    WRONG  -site:blog   -site:agency   -site:medium   -site:recruitment
    RIGHT  -inurl:blog  -inurl:agency  -site:medium.com   -inurl:recruitment
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
