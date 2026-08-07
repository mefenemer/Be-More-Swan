// src/utils/text-search.ts
// One implementation of "match chunks containing ANY of these words", shared by every
// full-text fallback in the app.
//
// THE BUG THIS EXISTS TO PREVENT. Postgres' two safe tsquery parsers — websearch_to_tsquery and
// plainto_tsquery — both CONJOIN every content word. A question like
//
//     "Announce that we now turn around every new client quote the same day"
//
// compiles to 'announc' & 'turn' & 'around' & 'everi' & 'new' & 'client' & 'quot' & 'day':
// eight terms that must ALL appear inside one ~700-char chunk. Measured on staging 2026-08-07
// against a 10-chunk corpus, that query matched 0 chunks while the single word 'ship' matched 9.
// Every real query on these paths is sentence-length — a support question, a chat turn, a content
// pillar, a context prompt — so the fallbacks were returning nothing essentially always.
//
// It failed silently, which is why it survived so long: zero rows is indistinguishable from
// "nothing relevant here", so the feature just quietly stops contributing and every caller's
// "degrade gracefully when there's no match" path handles it perfectly.
//
// AND THESE FALLBACKS ARE PRODUCTION PATHS, not dev conveniences. They run whenever the
// environment has no embedding provider configured OR the query-embedding call fails at runtime —
// a 429 or a provider blip is enough. Both were observed locally on 2026-08-07.
//
// The fix rewrites the conjunction to a disjunction at the tsquery level. It deliberately does NOT
// hand-build a tsquery from split words: the parsers also normalise, stem and strip stop words, and
// they are what makes untrusted input safe to interpolate (to_tsquery would raise a syntax error on
// a stray ':' or '&'). So parse first, then loosen. ts_rank does the real work afterwards, scoring
// each chunk by how many terms actually hit — which is the behaviour callers wanted all along.

import { sql, type SQL } from 'drizzle-orm';

/**
 * A tsquery matching rows that contain ANY term of `query`, for use with both `@@` and `ts_rank`.
 *
 * `parser` picks how the raw text is parsed, and callers should keep whichever one they already
 * used — the two differ in ways that matter for their inputs:
 *   - 'websearch' honours quoted phrases and leading-minus negation. Right for text a human typed
 *     as a search.
 *   - 'plain' ignores all operators and treats the input as literal words. Right for arbitrary
 *     text that was never meant as a query, where a stray hyphen must not become a NOT.
 *
 * Both render their text form with ' & ' separators, so one replace covers them.
 */
export function anyTermTsQuery(query: string, parser: 'websearch' | 'plain' = 'websearch'): SQL {
    const parsed = parser === 'plain'
        ? sql`plainto_tsquery('english', ${query})`
        : sql`websearch_to_tsquery('english', ${query})`;
    // Phrase operators (<->) are left alone on purpose: a quoted phrase is an explicit request for
    // adjacency, and only the implicit AND between separate terms is the thing that was too strict.
    return sql`replace((${parsed})::text, ' & ', ' | ')::tsquery`;
}
