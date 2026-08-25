// tests/discovery-query-gen-exclusions.test.ts
// The query generator must not ask for the things the domain filter throws away.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// A prod run on 2026-08-08 produced 35 leads, every one of them cold, every one discarded:
// adobe.com, hubspot.com, salesforce.com, hootsuite.com, huffingtonpost.co.uk, digiday.com,
// podcasts.apple.com, anchor.fm, feeds.libsyn.com, startup.jobs, builtinnyc.com. The queries
// behind them included `site:trustpilot.com OR site:g2.com`, `site:linkedin.com/jobs`,
// `inurl:careers OR inurl:jobs` and `best social media agencies UK ... directories`.
//
// The model was not misbehaving. The system prompt TOLD it to do this — niche_scrape was
// described as "directories, maps, 'best X in Y' style" and intent_signal as "hiring pages,
// tech-stack mentions, recent press, public reviews". Meanwhile discovery-domain-filter.ts
// blocks aggregators, media and job boards, and rejects titles matching /directory/ and
// /top \d+|best \d+/. The two halves of the pipeline were working against each other, and we
// paid Serper and Haiku for every collision.
//
// ⚠️ THE INVARIANTS WORTH DEFENDING:
//
//   1. The prompt must never ASK for a blocked category. Grepping the source file is not
//      enough — the defect lived in the assembled string, so these assertions run against
//      buildSystemPrompt() output.
//
//   2. The prohibition text is BUILT from the filter's own tables. Add a category to
//      discovery-domain-filter.ts and it must reach the prompt with no second edit; that is
//      the only thing stopping this drifting apart again.
//
//   3. Every result must resolve to a sellable company's OWN domain. This is architectural,
//      not stylistic: the worker takes the SERP hit's domain as the prospect, so a query that
//      surfaces a third-party page produces a lead for the third party.
//
// Run:  npx tsx tests/discovery-query-gen-exclusions.test.ts

import assert from 'node:assert';
import { buildSystemPrompt } from '../src/lib/discovery-query-gen';
import {
    excludedDomainsByCategory, EXCLUDED_SUBDOMAINS, EXCLUDED_TITLE_SHAPES,
    CONTENT_TITLE_REASONS, classifyCandidate, PROMPT_EXAMPLE_DOMAINS,
} from '../src/lib/discovery-domain-filter';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const PROMPT = buildSystemPrompt(5, []);

// ── 1. The prompt no longer prescribes the noise ─────────────────────────────

check('the prompt no longer ASKS for directories, listicles, jobs, press or reviews', () => {
    // These are the exact phrases that produced the 2026-08-08 run. Each one instructed the
    // model to aim at a category the filter drops.
    const banned: Array<[RegExp, string]> = [
        [/directories, maps/i, 'niche_scrape still asks for directories and maps'],
        [/"best X in Y"/i, 'niche_scrape still asks for "best X in Y" roundups'],
        [/hiring pages/i, 'intent_signal still asks for hiring pages — job boards are blocklisted'],
        // Added 2026-08-12 from per-query yield on prod campaign 2. The 08-08 fix removed the
        // hiring/press/reviews asks and the next run went from 0 sellable companies out of 15 to
        // 14 out of 50 — but three queries still returned nothing, and all three were built on a
        // quoted experiential phrase or on analyst jargon. Both are now prohibited by name.
        [/pain in the prospect's own words/i,
            'intent_signal still asks for the pain in the prospect\'s own words — that phrasing lives in articles, not on company sites'],
        [/a phrase implying the manual process/i,
            'footprint still asks for a phrase implying the manual process — measured at zero sellable companies'],
        [/recent press/i, 'intent_signal still asks for press — media is blocklisted'],
        [/public reviews/i, 'intent_signal still asks for reviews — review sites are blocklisted'],
    ];
    for (const [re, msg] of banned) assert.ok(!re.test(PROMPT), msg);
});

check('the prompt makes naming the prospect’s TRADE step one', () => {
    // ⚠️ Second failure mode, found by previewing two REAL prod campaigns after the exclusions
    // were fixed. Both briefs aimed at the product category rather than the buyer:
    // "social media scheduling tool" returns Buffer and Hootsuite; "user-generated content
    // platform" returns UGC vendors. One campaign's idea contained a product pitch, the other
    // was the user's own prose about the customer's PAIN — so this was never an idea-writing
    // problem. The instruction said "the trade language a business in this niche uses", and
    // given an idea about social-media pain, "this niche" reads as social media.
    assert.ok(/NAME THE PROSPECT'S TRADE/.test(PROMPT), 'the trade-first step is gone');
    assert.ok(/the business that HAS that problem/i.test(PROMPT),
        'the prompt no longer distinguishes the buyer from the problem');
    // Concrete examples of the inversion, in both directions. The model demonstrably knew vendors
    // were a hazard (it was excluding hootsuite.com by itself) while still aiming at them, which
    // is a missing instruction rather than a weak model — so the examples have to be explicit.
    for (const wrong of ['social media scheduling tool', 'user-generated content platform']) {
        assert.ok(PROMPT.includes(wrong), `the prompt no longer shows "${wrong}" as a wrong query`);
    }
    for (const right of ['independent skincare brand', 'family law firm Manchester']) {
        assert.ok(PROMPT.includes(right), `the prompt no longer shows "${right}" as a right query`);
    }
    // Analyst jargon is a distinct failure from the vendor inversion above: "direct-to-consumer
    // apparel" IS the buyer, described in the words of someone writing about the buyer. It reads
    // like a correct query and returns commentary. On prod campaign 2 it scored 1 sellable company
    // from 13, against 9 from 14 for "small batch homeware" in the same run.
    assert.ok(/ANALYST JARGON IS NOT A TRADE/.test(PROMPT), 'the jargon rule is gone');
    for (const jargon of ['direct-to-consumer', 'e-commerce brand']) {
        assert.ok(PROMPT.includes(jargon), `the prompt no longer names "${jargon}" as jargon to avoid`);
    }
    assert.ok(/anchored to the trade/i.test(PROMPT),
        'the all-arrays anchoring rule is gone — intent and footprint queries drift back to the product category');
});

check('the four faults measured on 2026-08-25 are prohibited by name', () => {
    // Per-query yield on a live account, jobs 4-23. Every one of these reads like a sensible query
    // and every one returned near-zero sellable companies, so none of them is inferable from the
    // rules that were already here — they have to be named.
    //
    //   "primary school Kent head teacher email" ×3  → 21 results,  0 companies
    //   "children's residential care home staff training" → 10 results, 0 companies
    //     …against "children's residential care home" alone → 9 results, 7 companies
    //   "children's care home Ofsted"                →  4 results,  0 companies
    //   five queries carrying -site:.uk, searching for UK schools
    assert.ok(/NEVER SEARCH FOR CONTACT DETAILS/.test(PROMPT),
        'the contact-details rule is gone — "head teacher email" finds the harvesters, not the schools');
    assert.ok(/head teacher email/.test(PROMPT), 'the measured wrong example is no longer shown');

    assert.ok(/NEVER PUT WHAT THE BUSINESS SELLS INTO THE QUERY/.test(PROMPT),
        'the own-service rule is gone — this survives naming the trade correctly, so STEP ONE does not cover it');
    assert.ok(/staff training/.test(PROMPT), 'the measured own-service example is no longer shown');

    assert.ok(/NEVER SEARCH A REGULATOR, INSPECTORATE OR VACANCY TERM/.test(PROMPT),
        'the regulator rule is gone — a company does not rank for its own inspection, the inspector does');
    assert.ok(/Ofsted/.test(PROMPT), 'the measured regulator example is no longer shown');

    assert.ok(/NEVER EXCLUDE A TOP-LEVEL DOMAIN/.test(PROMPT),
        'nothing stops -site:.uk any more — that operator deletes the whole target market on a UK search');
    assert.ok(/-site:\.uk/.test(PROMPT), 'the TLD-exclusion example is no longer shown');

    assert.ok(/THE PLAINEST QUERY USUALLY WINS/.test(PROMPT),
        'the brevity rule is gone — stacked operators drift back towards pages about the market');
});

check('the TLD-exclusion ban is wired into the site:-operator rule too', () => {
    // The operator rule and the prohibition are one page apart and contradicted each other in an
    // earlier draft: "use -site: where it helps" sitting above "never use -site:.uk". A model
    // reading only the Rules block must still be told.
    const rules = PROMPT.slice(PROMPT.indexOf('\nRules:'));
    assert.ok(/-site:\.uk/.test(rules), 'the Rules block no longer names a TLD exclusion as WRONG');
    assert.ok(!/RIGHT[^\n]*-site:\.\w/.test(rules), 'a bare TLD is being shown as a RIGHT example');
});

check('the prompt spells out that site: takes a full domain', () => {
    // The model was emitting `-site:blog`, `-site:agency`, `-site:medium` — bare words that the
    // search engine silently ignores, so every one was a filter the query only appeared to have.
    assert.ok(/take a FULL DOMAIN/.test(PROMPT), 'the site:-operator rule is gone');
    assert.ok(/-inurl:blog/.test(PROMPT), 'the -inurl: alternative is no longer offered');
});

check('the prompt states the architectural rule that makes all this necessary', () => {
    // Without the WHY, a future edit re-adds "search LinkedIn for companies hiring X" because
    // it sounds like a good intent signal. It is — but the lead it produces is linkedin.com.
    assert.ok(/SELLABLE COMPANY'S OWN WEBSITE/.test(PROMPT), 'the own-domain rule is gone');
    assert.ok(/takes the domain of each search result and treats it as the prospect/i.test(PROMPT),
        'the prompt no longer explains WHY third-party sources are useless here');
});

check('the three strategy keys and the JSON contract survive', () => {
    // The parser reads exactly these keys; renaming one in the prompt yields empty arrays and
    // a job that fails with "Could not generate search queries for this idea."
    for (const key of ['niche_scrape', 'intent_signal', 'footprint']) {
        assert.ok(PROMPT.includes(`"${key}"`), `the ${key} strategy is missing from the prompt`);
    }
    assert.ok(/Return STRICT JSON only/.test(PROMPT), 'the JSON-only instruction is gone');
});

// ── 2. The prohibition is generated, not retyped ─────────────────────────────

check('every blocked category reaches the prompt with real example domains', () => {
    const grouped = excludedDomainsByCategory();
    // The categories that name concrete domains. content_page/non_company are shape rules and
    // are covered by the title/subdomain sections instead.
    for (const category of ['social', 'aggregator', 'media', 'reference', 'jobs'] as const) {
        const examples = grouped[category] ?? [];
        assert.ok(examples.length > 0, `no domains are blocked under "${category}" any more`);
        assert.ok(PROMPT.includes(examples[0]),
            `the prompt does not quote ${examples[0]} — category "${category}" is not reaching the model`);
    }
});

check('the specific domains that polluted the prod run are named in the prompt', () => {
    // Not decorative: these are the ones the generator actually aimed at.
    for (const d of ['linkedin.com', 'trustpilot.com', 'g2.com', 'reddit.com', 'facebook.com']) {
        assert.ok(PROMPT.includes(d), `${d} is not named as excluded — it was targeted in prod`);
    }
});

check('the publishing/support subdomains are listed', () => {
    for (const sub of ['blog', 'careers', 'jobs', 'community']) {
        assert.ok(EXCLUDED_SUBDOMAINS.includes(sub), `"${sub}." is no longer filtered`);
    }
    assert.ok(/careers/.test(PROMPT) && /blog/.test(PROMPT),
        'the prompt no longer warns off publishing subdomains — inurl:careers came back last time');
});

check('every distinct title heuristic has a phrase the model can act on', () => {
    // A RegExp is not an instruction. Adding a pattern with a new reason must fail here until
    // someone writes the English for it, or the filter silently drops results the prompt still
    // asks for — which is exactly how this bug happened.
    assert.equal(EXCLUDED_TITLE_SHAPES.length, CONTENT_TITLE_REASONS.length,
        `${CONTENT_TITLE_REASONS.length} distinct title rules but ${EXCLUDED_TITLE_SHAPES.length} phrases — add the missing description to EXCLUDED_TITLE_SHAPES`);
    for (const shape of EXCLUDED_TITLE_SHAPES) {
        assert.ok(PROMPT.includes(shape), `the prompt omits the title shape "${shape}"`);
    }
});

// ── 3. The prompt and the filter agree about the same examples ───────────────

check('every curated prompt example is genuinely in the blocklist', () => {
    // Naming a domain in the prompt that the filter then keeps is worse than saying nothing:
    // it trains the model away from a lead we would have accepted.
    const all = new Set(Object.values(excludedDomainsByCategory()).flat());
    for (const d of PROMPT_EXAMPLE_DOMAINS) {
        assert.ok(all.has(d), `${d} is quoted as an example but is not in BLOCKED_DOMAINS`);
    }
});

check('every example domain the prompt quotes is genuinely excluded by the filter', () => {
    // Guards the embarrassing inverse: telling the model to avoid something we happily keep.
    const grouped = excludedDomainsByCategory();
    for (const [, domains] of Object.entries(grouped)) {
        for (const d of domains.slice(0, 6)) {
            if (!PROMPT.includes(d)) continue;
            const verdict = classifyCandidate({ domain: d, url: `https://${d}/`, title: 'Acme Ltd' });
            assert.ok(verdict.excluded,
                `the prompt tells the model to avoid ${d}, but classifyCandidate() keeps it`);
        }
    }
});

check('a genuine SMB prospect is still kept — the filter has not become a wall', () => {
    // The stated bias is false negatives over false positives; a query change that made the
    // filter reject real companies would be a far worse bug than the one being fixed.
    for (const d of ['quendonhall.co.uk', 'broughtonsanctuary.co.uk', 'tank2create.co.uk']) {
        const verdict = classifyCandidate({ domain: d, url: `https://${d}/services`, title: 'Our services' });
        assert.ok(!verdict.excluded, `${d} is now excluded — the filter is dropping real prospects`);
    }
});

// ── 4. Negatives and sizing still work ───────────────────────────────────────

check('campaign negative keywords still reach the prompt', () => {
    const withNegatives = buildSystemPrompt(3, ['hootsuite', 'buffer']);
    assert.ok(withNegatives.includes('hootsuite') && withNegatives.includes('buffer'),
        'guardrail negative keywords are no longer passed through');
    assert.ok(withNegatives.includes('Up to 3 queries per array'), 'perStrategy is no longer honoured');
    assert.ok(PROMPT.includes('(none provided)'), 'the empty-negatives case lost its placeholder');
});

console.log(`\n${passed} checks passed.`);
