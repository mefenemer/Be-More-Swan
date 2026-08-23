// tests/model-json-preamble.test.ts
// A model that narrates before it answers must not cost us the answer.
//
// The bug this pins: seven of nine discovery runs for one campaign failed on 2026-08-22 with
// "Could not generate search queries for this idea." Every one of them had called the model, been
// billed for a complete and correct set of queries, and thrown it away — because four modules kept
// their own extractor, and that copy stripped a ```json fence only when the fence was the FIRST
// thing in the reply:
//
//     raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
//
// The query-gen prompt opens with "STEP ONE — NAME THE PROSPECT'S TRADE. Do this before writing a
// single query." and closes with "Return STRICT JSON only (no markdown)". Roughly one reply in six
// resolves that tension by doing Step One out loud above the fence. The anchored strip then left
// the prose in place, JSON.parse threw, and null was indistinguishable from a model that produced
// nothing at all.
//
// ⚠️ src/utils/model-json.ts already handled this — its brace balancer finds the object wherever
// it sits — and had done since it was written for the same class of bug on the caption seams. The
// four private copies were the whole problem. The fix was deleting them, so what this file guards
// is that they stay deleted.
//
// PREAMBLE_REPLY is a real capture from a live run of the production prompt with the failing
// campaign's own inputs — not a constructed example.

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelJson, parseModelJsonArray } from '../src/utils/model-json';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nModel JSON: preamble tolerance\n');

const QUERIES = '{"niche_scrape":["primary school Kent"],"intent_signal":["primary school Kent email"],"footprint":["primary school Kent -inurl:jobs"]}';

const PREAMBLE_REPLY = `# Step One: Name the Prospect's Trade

Primary schools in South East England (excluding Essex) operating as independent institutions.
The prospect is the school itself, not a training provider.

\`\`\`json
${QUERIES}
\`\`\``;

// ── The regression ─────────────────────────────────────────────────────────────────────────────

check('a reply that narrates STEP ONE above the fence still yields its queries', () => {
    const parsed = parseModelJson<Record<string, string[]>>(PREAMBLE_REPLY);
    assert.ok(parsed, 'the preambled reply parsed as null — this is the exact production failure');
    assert.deepStrictEqual(parsed.niche_scrape, ['primary school Kent']);
    assert.deepStrictEqual(parsed.intent_signal, ['primary school Kent email']);
    assert.deepStrictEqual(parsed.footprint, ['primary school Kent -inurl:jobs']);
});

check('the deleted implementation genuinely failed this, so the test is not vacuous', () => {
    // Pinning the BUG as well as the fix: without this, a future refactor could reintroduce the
    // anchored strip and the check above might still pass for an unrelated reason.
    const deleted = (raw: string) => {
        const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        try { return JSON.parse(text); } catch { return null; }
    };
    assert.strictEqual(deleted(PREAMBLE_REPLY), null, 'the old extractor should fail this input');
    assert.ok(parseModelJson(PREAMBLE_REPLY), 'the shared one should not');
});

check('a preambled ARRAY parses too', () => {
    // scoreCandidates and classifyProspects both ask for a top-level array, one object per
    // candidate — a different code path from the object case above.
    const arr = parseModelJsonArray('Here are the scores:\n\n```json\n[{"leadName":"A"},{"leadName":"B"}]\n```');
    assert.ok(Array.isArray(arr) && arr.length === 2, 'array reply must survive a preamble');
});

check('tolerant of WRAPPING, never of CONTENT', () => {
    // The helper recovers the model's answer; it must never invent one. A reply truncated by
    // max_tokens has to stay a failure the caller can fall back from.
    for (const bad of ['{"niche_scrape": ["a", ', 'no json here at all', '']) {
        assert.strictEqual(parseModelJson(bad), null, `expected null for ${JSON.stringify(bad.slice(0, 30))}`);
    }
});

// ── The four seams that used to keep their own copy ────────────────────────────────────────────

const CONVERTED = [
    'src/lib/discovery-query-gen.ts',
    'src/lib/discovery-scoring.ts',
    'netlify/functions/lead-generation.ts',
    'src/utils/blog-topic-ideation.ts',
];

for (const file of CONVERTED) {
    check(`${file} parses through the shared helper`, () => {
        const src = read(file);
        assert.match(src, /from '.*model-json'/, `${file} must import from model-json`);
        assert.ok(
            !/replace\(\/\^```/.test(src),
            `${file} strips fences itself again — that is the bug, see the header of this file`,
        );
        assert.ok(
            !/function parseJson\b/.test(src),
            `${file} has re-grown a private parseJson`,
        );
    });
}

// ── Nobody keeps a private copy ────────────────────────────────────────────────────────────────

check('no module anywhere strips code fences by hand', () => {
    // Twelve modules did: four JSON parsers (one of which was the outage), five more JSON parsers
    // in chat / translate / commands / media / sequence follow-ups, and three that strip fences off
    // plain prose. All now route through src/utils/model-json.ts. A thirteenth copy is the next
    // outage, so this is repo-wide with no exemption list — an exemption list is how the first four
    // survived long enough to fail.
    const offenders: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) { walk(full); continue; }
            if (!full.endsWith('.ts')) continue;
            const rel = full.slice(root.length + 1);
            // model-json.ts owns the one legitimate strip; this file quotes the dead one on purpose.
            if (rel === 'src/utils/model-json.ts' || rel === 'tests/model-json-preamble.test.ts') continue;
            if (/replace\(\/\^```/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
        }
    };
    for (const d of ['src', 'netlify', 'scripts', 'tests']) walk(join(root, d));
    assert.deepStrictEqual(offenders, [], `private fence-strippers found: ${offenders.join(', ')}`);
});

check('the five other JSON seams parse through the shared helper', () => {
    // Each of these used to keep its own extractor. process-sequence-sends is the one that mattered
    // most: it drafts the follow-up emails, and a null there skips a cadence step silently.
    for (const file of [
        'netlify/functions/assistant-command.ts',
        'netlify/functions/autonomous-media-suggestions.ts',
        'netlify/functions/chat-orchestrator.ts',
        'netlify/functions/process-sequence-sends.ts',
        'netlify/functions/translate.ts',
    ]) {
        assert.match(read(file), /from '.*model-json'/, `${file} must import from model-json`);
    }
});

check('a broken media reply never persists JSON scaffolding as a caption', () => {
    // ⚠️ autonomous-media-suggestions.ts fell back to `caption: res.text` — the raw reply, fences
    // and braces included, saved as the post caption and shown to users. That is the failure
    // model-json.ts was written to end, and this seam had never been converted to it.
    const src = read('netlify/functions/autonomous-media-suggestions.ts');
    assert.match(src, /toCaptionText\(/, 'the fallback must salvage a caption, not hand back the raw reply');
    assert.ok(!/caption: res\.text/.test(src), 'the raw-reply fallback is back');
});

check('model-json.ts remains the one hardened implementation', () => {
    const src = read('src/utils/model-json.ts');
    // The brace balancer is what actually rescues a preamble. A "simplification" back to a plain
    // regex would reintroduce the outage without failing anything else here.
    assert.match(src, /function balancedObject/, 'the object brace balancer must survive');
    assert.match(src, /function balancedArray/, 'the array balancer must survive');
});

console.log(`\n${passed} checks passed\n`);
