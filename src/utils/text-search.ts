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
//
// ── NEGATION MUST BE DROPPED, NOT LOOSENED ───────────────────────────────────
// A negated term cannot survive that rewrite. `'card' & !'refund'` means "has card, lacks refund";
// ORed, `'card' | !'refund'` means "has card OR lacks refund" — and "lacks refund" is TRUE of
// almost every row, so one negated term drags in the whole corpus.
//
// This is reachable from ORDINARY PROSE, not just deliberate search syntax. websearch_to_tsquery
// reads a leading '-' as NOT, and a dash used as punctuation binds to the word after it. Measured
// on the 10-chunk corpus 2026-08-07:
//
//     "my card - the one ending 4242 - stopped working"
//       → 'card' & 'one' & 'end' & '4242' & !'stop' & 'work'      (note !'stop')
//       → ORed: matched 10 of 10 chunks, 7 of them at ts_rank 0.00000
//
// ts_rank still floats the genuine hits to the top, so the practical cost was junk excerpts padding
// the support agent's prompt rather than a wrong answer outright — but they are junk the model has
// to read past, and on a sparser query there is less real signal to outrank them.
//
// So: strip the negated clauses via querytree() and OR what remains. Dropping them is the
// conservative reading — "exclude X" degraded to "no opinion about X" simply widens recall, which
// is the whole point of a fallback, whereas honouring the NOT would re-introduce a hard AND-shaped
// filter through the back door. Only the 'websearch' parser can produce a negation at all;
// plainto_tsquery treats '-' as literal, so for 'plain' callers querytree() is a no-op.

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

    // querytree() drops the negated clauses and hands back the positive remainder AS TEXT (so no
    // ::text cast is needed here). See the NEGATION note above for why they cannot survive the
    // rewrite. It also leaves phrase operators (<->) intact, which is what we want: a quoted phrase
    // is an explicit request for adjacency, and only the implicit AND between separate terms was
    // ever too strict.
    //
    // 'T' is querytree's sentinel for "nothing indexable is left" — a query that was ALL negation
    // ("-refund"). It must not reach ::tsquery, where it would silently become a search for the
    // lexeme 'T' and match any document containing that token. Map it to the empty tsquery, which
    // matches nothing: a purely negative query has no positive terms to retrieve on, and returning
    // nothing is the honest answer.
    const positive = sql`COALESCE(NULLIF(querytree(${parsed}), 'T'), '')`;
    return sql`replace(${positive}, ' & ', ' | ')::tsquery`;
}
