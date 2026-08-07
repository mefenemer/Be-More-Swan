// tests/inspo-surfaces.test.ts
// Every seam that writes the user's copy must inject the Inspo block.
//
// WHY THIS EXISTS. Inspo shipped wired into exactly one seam — process-content-jobs.ts — and
// nobody noticed the others for three weeks. Measured on prod 2026-08-07: an org with a fully
// ingested, embedded 10-item library had received exactly ONE post shaped by it. Posts drafted in
// chat ignored the library completely; the admin smoke test rendered a prompt no customer gets; and
// every scheduled draft skipped top-K retrieval because the topic argument was `job.context_prompt`,
// which is null on an autopilot job whenever the idea queue is empty (7 of 7 jobs, in that org).
//
// None of that failed. Nothing threw, nothing logged, every draft was produced and published on
// time — they just quietly didn't sound like anything the user had taught. That is the failure mode
// this file guards, and it is the same one inspo-tab-build warned about in the first place: the
// content roles have MORE THAN ONE generation seam, so a feature injected once silently no-ops for
// the rest. tests/campaign-prompt-surfaces.test.ts exists for the identical reason.
//
// Deliberately NOT guarded, so the exclusions stay explicit rather than looking like more of the
// same oversight:
//   - rewrite-post-text 'grammar'   — instructed not to change the tone; a style directive fights it
//   - rewrite-post-text 'hashtags'  — returns no prose for a prose style directive to shape
//   - apply-post-suggestions        — a copy editor applying requested edits "and nothing more"
//   - suggest-overlay-text          — ~40 chars anchored to a caption that already carries the voice
//
// No database: source-consistency checks only.
// Run:  npx tsx tests/inspo-surfaces.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
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

/**
 * Blank out comments, preserving length and newlines so line numbers stay exact.
 *
 * Load-bearing here, not hygiene: every file this test scans carries a comment explaining why it
 * calls buildInspoBlock, so a scan counting comment text would find the call it is looking for
 * inside the prose about the call, and pass a file that deleted it.
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The source span between `start` and `end`, or a failure naming what moved. */
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone. Update this test's anchors.`);
    const b = text.indexOf(end, a);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone. Update this test's anchors.`);
    return text.slice(a, b);
}

// ── Coverage: the seams that write copy all reach the library ────────────────

/** Seam → why a user would rightly expect their Inspo to apply there. */
const COPY_SEAMS: Array<{ file: string; why: string }> = [
    { file: 'netlify/functions/process-content-jobs.ts', why: 'autopilot and composer drafts — the original seam' },
    { file: 'netlify/functions/chat-orchestrator.ts', why: 'posts drafted by talking to the assistant' },
    { file: 'netlify/functions/rewrite-post-text.ts', why: 'the in-editor "rewrite in a different tone" action' },
    { file: 'netlify/functions/admin-test-generate-background.ts', why: 'the admin smoke test, which must render the customer prompt' },
    { file: 'src/utils/blog-generate.ts', why: 'blog drafts — the second content seam, which never touches the blueprint' },
    { file: 'src/utils/blog-topic-ideation.ts', why: 'blog topic ideation' },
];

check('every copy-writing seam calls buildInspoBlock', () => {
    for (const { file, why } of COPY_SEAMS) {
        const src = stripComments(read(file));
        assert.match(src, /buildInspoBlock\s*\(/,
            `${file} does not call buildInspoBlock — ${why}. A content seam that skips it produces copy in `
            + 'a voice the user never taught, and nothing fails: the draft is still written, still saved, '
            + 'still published. Add the call, or if the omission is deliberate move the seam into this '
            + "file's documented exclusion list so the next person knows it was a decision.");
    }
});

// ── Channel B: retrieval needs a topic, and autopilot has no context prompt ───
// The subtle half. Channel A (the style profile) is injected unconditionally, so a seam can call
// buildInspoBlock, pass topic: null, and look wired while the exemplars are never read. That is
// precisely what shipped: `topic: job.context_prompt` on a job type whose context prompt is
// routinely null. The block is injected, the profile applies, and retrieval silently never runs.

check('scheduled jobs fall back to a real topic when there is no context prompt', () => {
    const src = stripComments(read('netlify/functions/process-content-jobs.ts'));
    const call = span(src, 'const inspoTopic', 'buildInspoBlock', 'the inspo topic resolution');

    assert.match(call, /job\.context_prompt/,
        'The user\'s own context prompt must still win when there is one.');
    assert.match(call, /rotatedPillar|pillarList/,
        'process-content-jobs must fall back to the slot\'s content pillar when context_prompt is null. '
        + 'Without a fallback, top-K retrieval is skipped on every autopilot draft — the exact bug '
        + 'measured on prod 2026-08-07, where 7 of 7 scheduled jobs ran with no topic and the org\'s '
        + 'embedded chunks were never once read.');
});

check('chat ranks retrieval on the user\'s message', () => {
    const src = stripComments(read('netlify/functions/chat-orchestrator.ts'));
    const call = span(src, 'route.usesInspo', 'buildRolePrompt', 'the chat inspo retrieval');
    assert.match(call, /topic:\s*message/,
        'Chat must pass the user\'s message as the retrieval topic. In chat the brief IS the turn, '
        + 'which makes it the one seam where channel B always has something real to rank on — '
        + 'passing null here would inject the style profile and quietly retrieve nothing.');
});

// ── Ordering: the exemplars must not out-rank the output contract ────────────
// Channel B hands the model up to four excerpts that are themselves finished social posts. In a
// seam whose reply must be a JSON envelope, that material is a plausible template for the wrong
// thing — the shape of the reply. So the format instruction has to come after it.

check('chat puts the Inspo block before the JSON contract', () => {
    const src = stripComments(read('netlify/functions/chat-orchestrator.ts'));
    const route = span(src, 'social_media_manager: {', 'parseResponse: parseStructuredReply', 'the social_media_manager route');
    const inspoAt = route.indexOf('rc.inspoBlock');
    const contractAt = route.indexOf('Return STRICT JSON');

    assert.notStrictEqual(inspoAt, -1, 'The social route must inject rc.inspoBlock.');
    assert.notStrictEqual(contractAt, -1, 'The social route must still state its JSON contract.');
    assert.ok(inspoAt < contractAt,
        'The Inspo block must come BEFORE the "Return STRICT JSON" contract in the role prompt. It ends '
        + 'with excerpts that are finished social posts, so it must never be the last thing the model '
        + 'reads before writing — the envelope instruction has to have the final word on reply shape.');
});

check('the social route opts in explicitly', () => {
    const src = stripComments(read('netlify/functions/chat-orchestrator.ts'));
    const route = span(src, 'social_media_manager: {', 'buildRolePrompt', 'the social_media_manager route header');
    assert.match(route, /usesInspo:\s*true/,
        'social_media_manager must set usesInspo — without the flag the handler builds no block and '
        + 'rc.inspoBlock is undefined, which renders nothing and fails silently.');
});

// ── Smoke-test parity ────────────────────────────────────────────────────────
// A test that assembles a different prompt from production reports on a prompt no customer ever
// receives. This file already drifted once that way (see its own header comment) and drifted again
// one layer up: the blueprint render was brought back to parity, the blocks appended AFTER it
// were not.

check('the admin smoke test renders the same appended blocks as production', () => {
    const admin = stripComments(read('netlify/functions/admin-test-generate-background.ts'));
    for (const block of ['buildInspoBlock', 'CONTENT_QUALITY_STANDARDS', 'AURA_SAFE_CONTENT_BENCHMARK']) {
        assert.ok(admin.includes(block),
            `The admin smoke test must append ${block} like process-content-jobs does. Missing it means `
            + 'an admin testing an assistant sees output the real generation path would never produce.');
    }
});

// ── The bounded-channel rule ─────────────────────────────────────────────────
// inspo-tab-build's standing constraint: raw library content must never become a blueprint section,
// because sections are dumped into the prompt wholesale and prompt cost would scale with library size.

check('Inspo is never rendered as a blueprint section', () => {
    const renderer = stripComments(read('src/utils/blueprint-prompt.ts'));
    assert.doesNotMatch(renderer, /inspo/i,
        'The blueprint renderer must not know about Inspo. Sections are dumped into the prompt whole, so '
        + 'inspo living there would grow every prompt with the size of the user\'s library — the one '
        + 'thing the two-channel design (capped profile + top-K retrieval) exists to prevent.');
});

console.log(`\n${passed} checks passed.`);
