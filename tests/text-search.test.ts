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
// No database: source-consistency checks only.
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

console.log(`\n${passed} checks passed.`);
