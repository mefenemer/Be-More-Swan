// tests/text-search.test.ts
// Full-text fallbacks must match ANY term, never all of them.
//
// WHY THIS EXISTS. Three retrieval paths independently wrote `content_tsv @@
// websearch_to_tsquery(...)` (or plainto_tsquery), and all three were wrong in the same way: both
// parsers conjoin every content word, so a sentence-length query needs every one of its words
// inside a single chunk. Measured on staging 2026-08-07:
//
//   KB, "what is your refund policy for annual plans" → AND 0 hits, OR 1
//        (the chunk WAS the right answer; the single absent word 'policy' zeroed the match)
//   account_memory, a recalled sentence                → AND 0 hits, OR 2
//   inspo, "Announce that we now turn around every…"   → AND 0 of 10 chunks, 'ship' alone → 9
//
// Nothing errored and nothing logged. Zero rows is indistinguishable from "nothing relevant", so
// each caller's graceful-degradation path handled it perfectly and the features simply stopped
// contributing — the support agent answering with no KB grounding being the worst case.
//
// These are production paths, not dev conveniences: they run whenever the environment has no
// embedding provider OR the query embedding fails at runtime (a 429 is enough — observed).
//
// A SECOND defect, found re-verifying on 2026-08-07: the rewrite turned `'card' & !'refund'` into
// `'card' | !'refund'`, and "lacks refund" is true of nearly every row, so one negated term matched
// the whole corpus. Reachable from ordinary prose — a dash used as punctuation binds to the next
// word, so "my card - the one ending 4242 - stopped working" carries a !'stop' and matched 10 of 10
// chunks, 7 at rank 0.00000. Negated clauses are now stripped with querytree().
//
// Source-consistency checks, then behavioural checks against a real Postgres. The behavioural half
// is READ-ONLY and table-free — the corpus is built inline with VALUES — and skips when
// NETLIFY_DATABASE_URL is unset. It cannot read the real KB: staging's kb_chunks was EMPTY on
// 2026-08-07, which is why source checks alone were never enough to catch the negation bug.
// Run:  npx tsx tests/text-search.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Blank out comments, preserving length — every file here explains the trap in prose, and a scan
 *  that counted comment text would find the forbidden call inside the warning about it. */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Every .ts file under src/ and netlify/, recursively. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) sourceFiles(rel, acc);
        else if (entry.name.endsWith('.ts')) acc.push(rel);
    }
    return acc;
}

const HELPER = 'src/utils/text-search.ts';

check('the helper strips negated clauses instead of ORing them', () => {
    // `'card' & !'refund'` ORed becomes `'card' | !'refund'` — and "lacks refund" is true of nearly
    // every row, so ONE negated term matches the whole corpus. Reachable from ordinary prose,
    // because a dash used as punctuation binds to the next word: "my card - the one ending 4242 -
    // stopped working" parses with !'stop' and matched 10 of 10 chunks before this.
    const src = stripComments(read(HELPER));
    assert.match(src, /querytree\(/,
        'anyTermTsQuery must drop negated clauses with querytree(), which returns only the positive '
        + 'remainder. Do not strip them by regexing the tsquery text.');
    assert.match(src, /NULLIF\(querytree\([^)]*\), 'T'\)/,
        "querytree() returns the sentinel 'T' when a query was ALL negation. Cast to tsquery it "
        + "becomes a search for the LEXEME 'T', matching any document containing that token — it "
        + 'must be mapped to the empty tsquery instead.');
});

check('the shared helper builds a disjunction, not a conjunction', () => {
    const src = stripComments(read(HELPER));
    assert.match(src, /replace\(/,
        'anyTermTsQuery must rewrite the parsed tsquery. Splitting the raw string on whitespace '
        + 'instead would lose stemming, stop-word removal and — critically — the parser\'s sanitising '
        + 'of untrusted input, which is what makes interpolation safe here.');
    assert.match(src, /' & '/,
        'The rewrite keys on the \' & \' separator that both parsers emit in their ::text form.');
    assert.match(src, /' \| '/, 'The replacement must be the OR operator.');
    assert.match(src, /websearch_to_tsquery/, 'The websearch parser must still be available.');
    assert.match(src, /plainto_tsquery/,
        "The 'plain' parser must remain available — account-memory searches arbitrary stored text, "
        + 'where a hyphen must stay literal instead of becoming a negation.');
});

check('no retrieval site parses a tsquery itself', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles('src'), ...sourceFiles('netlify')]) {
        if (file === HELPER) continue;
        const src = stripComments(read(file));
        if (/(websearch_to_tsquery|plainto_tsquery|to_tsquery)\s*\(/.test(src)) offenders.push(file);
    }
    assert.deepStrictEqual(offenders, [],
        `These files build a tsquery directly instead of using anyTermTsQuery() from ${HELPER}: `
        + `${offenders.join(', ')}. Both safe parsers AND every content word, so a sentence-length `
        + 'query matches nothing — silently. Route it through the helper, which parses first (keeping '
        + 'stemming and input sanitising) and then loosens the conjunction.');
});

check('every known fallback uses the helper', () => {
    const sites = [
        ['src/utils/inspo-profile.ts', 'Inspo channel-B retrieval'],
        ['netlify/functions/chat-orchestrator.ts', 'the support agent\'s knowledge-base fallback'],
        ['src/utils/account-memory.ts', 'account memory recall'],
    ];
    for (const [file, what] of sites) {
        const src = stripComments(read(file));
        assert.match(src, /anyTermTsQuery\s*\(/,
            `${file} must use anyTermTsQuery — it owns ${what}, whose keyword fallback returned `
            + 'nothing for realistic multi-word queries before this was shared.');
    }
});

check('both @@ and ts_rank use the same query object', () => {
    // Ranking on a different tsquery than the one that filtered would order by a score unrelated
    // to why each row matched — and it is an easy thing to half-fix when touching these lines.
    for (const file of ['src/utils/inspo-profile.ts', 'netlify/functions/chat-orchestrator.ts', 'src/utils/account-memory.ts']) {
        const src = stripComments(read(file));
        assert.match(src, /content_tsv @@ \$\{anyTerm\}/,
            `${file} must filter with the shared anyTerm fragment.`);
        assert.match(src, /ts_rank\(content_tsv, \$\{anyTerm\}\)/,
            `${file} must rank with the SAME fragment it filtered on.`);
    }
});

// ── Behavioural checks against a real Postgres ───────────────────────────────────────────────────
// READ-ONLY and table-free: the corpus is built inline with VALUES, so this writes nothing and does
// not depend on staging having any KB rows (it has none — kb_chunks was empty on 2026-08-07, which
// is exactly why the source checks above cannot be the only guard).
//
// These exercise the REAL anyTermTsQuery, rendered by drizzle, rather than a re-implementation —
// a copy of the SQL in the test would keep passing after the helper regressed.

/** KB-shaped support content, the sort tier1_support_agent retrieves over. */
const CHUNKS = [
    'You can update the payment card on file at any time from Settings then Billing. Choose Update payment method, enter the new card details and save.',
    'Refunds are available within 14 days of an annual charge. Contact support and we will process the return to the original payment method.',
    'To cancel, open Settings then Plan and choose Cancel subscription. Your workspace stays active until the end of the current billing period.',
    'Create your first assistant from the Assistants page. Pick a role and answer the onboarding questions.',
    'Connect a social account from the Connections page. We support LinkedIn, Facebook, Instagram, X, Threads and YouTube.',
    'The entry plan includes a monthly task allowance. When it runs out work pauses until the next period.',
    'Drafts wait in the Review Queue until you approve or reject them.',
    'All data is encrypted in transit and at rest. Request erasure from Settings then Privacy.',
    'Invite colleagues from Settings then Team. Members can be admin or standard access.',
    'If a scheduled post fails, open the post and read the failure reason. Most are an expired connection.',
];

async function behavioural(): Promise<void> {
    const { config } = await import('dotenv');
    config({ path: join(root, '.env') });
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) {
        console.log('\n  ⊘ behavioural checks skipped — NETLIFY_DATABASE_URL not set');
        return;
    }

    const [{ default: postgres }, { drizzle }, { sql }, { anyTermTsQuery }] = await Promise.all([
        import('postgres'), import('drizzle-orm/postgres-js'),
        import('drizzle-orm'), import('../src/utils/text-search'),
    ]);

    const client = postgres(url, { max: 1, connect_timeout: 15 });
    // `drizzle({ client })`, never `drizzle(client)` — matching db/client.ts. In drizzle 1.0 the
    // positional form is read as connection CONFIG, so a client passed that way is ignored and a
    // fresh one is built against the default localhost, failing with a bare ECONNREFUSED.
    const db = drizzle({ client });

    // VALUES rows one parameter at a time. Interpolating a JS array into drizzle's sql`` renders a
    // ROW constructor, not an array literal, and fails with 42809 — see the `= ANY()` trap.
    // The ::text casts are required: a bare parameter in VALUES gives Postgres nothing to infer
    // from, and it rejects the statement with 42P18 "could not determine data type of parameter".
    const rows = sql.join(CHUNKS.map((c) => sql`(${c}::text)`), sql`, `);
    const corpus = sql`(
        SELECT v.c AS content, to_tsvector('english', v.c) AS content_tsv
          FROM (VALUES ${rows}) AS v(c)
    ) AS k`;

    /** Rows matching `q` through the real helper, with the rank the callers order by. */
    async function hits(q: string, parser: 'websearch' | 'plain' = 'websearch') {
        const anyTerm = anyTermTsQuery(q, parser);
        const out = await db.execute<{ content: string; rank: number }>(sql`
            SELECT content, ts_rank(content_tsv, ${anyTerm})::float8 AS rank
              FROM ${corpus}
             WHERE content_tsv @@ ${anyTerm}
             ORDER BY ts_rank(content_tsv, ${anyTerm}) DESC`);
        return Array.from(out as Iterable<{ content: string; rank: number }>);
    }

    try {
        await acheck('a dash in ordinary prose no longer matches the whole corpus', async () => {
            // THE REGRESSION CASE. websearch reads the second '- ' as NOT, giving !'stop'; ORed,
            // that matched 10 of 10 chunks with 7 at rank 0.00000.
            const got = await hits('my card - the one ending 4242 - stopped working');
            assert.ok(got.length > 0, 'the positive terms must still retrieve something');
            assert.ok(got.length < CHUNKS.length,
                `matched all ${CHUNKS.length} chunks — the negated term is being ORed in again.`);
            const zero = got.filter((r) => !(r.rank > 0));
            assert.deepStrictEqual(zero.map((r) => r.content.slice(0, 40)), [],
                'every matched row must have matched a real term, so ts_rank must be > 0. A row '
                + 'ranked 0.00000 got in on a negation being true, not on relevance.');
            assert.match(got[0].content, /payment card on file/,
                'the billing article must still rank first.');
        });

        await acheck('an explicit negation is dropped, not honoured and not ORed', async () => {
            const withNeg = await hits('card -refund');
            const plain = await hits('card');
            assert.deepStrictEqual(withNeg.map((r) => r.content), plain.map((r) => r.content),
                '"card -refund" must retrieve exactly what "card" does. More rows means the NOT was '
                + 'ORed in; fewer means it was honoured, re-introducing an AND-shaped filter.');
        });

        await acheck('an all-negation query matches nothing rather than everything', async () => {
            const got = await hits('-refund');
            assert.deepStrictEqual(got, [],
                "querytree() returns 'T' here; cast straight to tsquery it becomes a search for the "
                + "lexeme 'T' and matches whatever contains that token.");
        });

        await acheck('multi-word queries still match ANY term (the original fix)', async () => {
            const got = await hits('what is your refund policy for annual plans');
            assert.ok(got.length > 0,
                'no chunk contains all of refund+policy+annual+plan — this is the AND bug returning.');
            assert.match(got[0].content, /^Refunds are available/,
                'the refunds article must rank first.');
        });

        await acheck('quoted phrases keep their adjacency', async () => {
            const phrase = await hits('"payment method"');
            assert.ok(phrase.length > 0, 'the phrase appears verbatim in two chunks.');
            for (const r of phrase) assert.match(r.content, /payment method/,
                'a quoted phrase must stay a <-> phrase, not decay into ORed words.');
        });

        await acheck("the 'plain' parser leaves punctuation literal", async () => {
            // account-memory recalls arbitrary stored text, where '-' must never become a NOT.
            const got = await hits('my card - the one ending 4242 - stopped working', 'plain');
            assert.ok(got.length > 0 && got.every((r) => r.rank > 0),
                'plainto_tsquery cannot emit a negation, so querytree() must be a no-op here.');
        });
    } finally {
        await client.end();
    }
}

async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        // Drizzle's "Failed query:" wrapper hides the actual Postgres error — the code and message
        // live on err.cause, and without it a type or syntax fault reads as an assertion failure.
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause ? `\n    pg ${cause.code}: ${cause.message}` : '';
        console.error(`  ✗ ${name}\n    ${(err as Error).message}${detail}`);
        process.exitCode = 1;
    }
}

behavioural()
    .catch((err) => {
        console.error(`  ✗ behavioural checks could not run\n    ${(err as Error).message}`);
        process.exitCode = 1;
    })
    .finally(() => console.log(`\n${passed} checks passed.`));
