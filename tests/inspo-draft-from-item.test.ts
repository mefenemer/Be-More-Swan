// tests/inspo-draft-from-item.test.ts
// The Inspo tab's "Write a … from this" button: click an inspo item and the assistant drafts from
// it, in its own chat, through its own drafting path.
//
// Before it existed the tab was write-only in practice — inspo steered whatever the assistant
// happened to draft next on its schedule, and there was no way to say "this idea, now".
//
// TWO KINDS OF CHECK, because two different things can break:
//
//   · The SEED is built by pure functions, so they are called for real. The wording is chosen by
//     roleKey, and "please write a social post" sent to a Blog Writer is a wrong-artifact bug that
//     renders perfectly and reads fine in the diff.
//   · The WIRING is markup and a querySelector agreeing on one attribute, which no compiler sees.
//     Rename one and the button goes visibly present and completely inert — the same failure the
//     record chip had for months (see lead-calendar-items.test.ts).
//
// Run:  npx tsx tests/inspo-draft-from-item.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

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

const inspoSrc = read('src/components/assistant-inspo.js');

// ── Load the component for real ──────────────────────────────────────────────
// It is a browser IIFE, but nothing at load time touches the DOM — it only defines functions and
// assigns window.AssistantInspo — so a bare stub window is enough to call the pure half.
type Seed = { noun: string; button: string };
const sandbox: any = {
    window: {}, document: {}, fetch: () => {}, setTimeout, console,
};
createContext(sandbox);
runInContext(inspoSrc, sandbox);
const api = sandbox.window.AssistantInspo;
const t: { buildSeed: (item: unknown, roleKey?: string | null) => string; draftNoun: (roleKey?: string | null) => Seed } =
    api && api._test;

check('the component still exposes its seed helpers', () => {
    assert.ok(t && typeof t.buildSeed === 'function' && typeof t.draftNoun === 'function',
        'window.AssistantInspo._test is gone — every behavioural check below is vacuous without it.');
});

// ── The wording follows the role ─────────────────────────────────────────────
check('a Blog Writer is asked for a blog post, never a social one', () => {
    const seed = t.buildSeed({ title: 'Punchy openers', body: 'No corporate waffle.' }, 'blog_writer');
    assert.ok(/write a blog post/i.test(seed), `Blog Writer seed does not ask for a blog post:\n${seed}`);
    assert.ok(!/social post/i.test(seed), `Blog Writer seed asks for a SOCIAL post:\n${seed}`);
    assert.equal(t.draftNoun('blog_writer').button, 'Write a blog from this');
});

check('a Social Media Manager is asked for a social post', () => {
    const seed = t.buildSeed({ title: 'Punchy openers', body: 'x' }, 'social_media_manager');
    assert.ok(/write a social post/i.test(seed), `Social seed does not ask for a social post:\n${seed}`);
    assert.equal(t.draftNoun('social_media_manager').button, 'Write a post from this');
});

check('an unknown role falls back to the NEUTRAL noun, not a social one', () => {
    // The Inspo tab is registry-driven: a role that gains one later must not inherit "social post"
    // by default, the way an unknown roleKey inherits social_media_manager elsewhere in the app.
    const seed = t.buildSeed({ title: 'x', body: 'y' }, 'newsletter_manager');
    assert.ok(/write a post based on this idea/i.test(seed), `Unknown-role seed is not neutral:\n${seed}`);
    assert.ok(!/social post|blog post/i.test(seed), `Unknown-role seed guessed an artifact:\n${seed}`);
});

// ── The seed carries the item, honestly ──────────────────────────────────────
check('the note is included when there is one, and invented when there is not', () => {
    const withNote = t.buildSeed({ title: 'T', userNote: 'Warm but sharp', body: 'B' }, 'blog_writer');
    assert.ok(withNote.includes('Warm but sharp'),
        'The user note — the strongest signal on the item — is missing from the seed.');

    const without = t.buildSeed({ title: 'T', body: 'B' }, 'blog_writer');
    assert.ok(!/What I like about it/.test(without),
        'The seed prints a "What I like about it" heading with nothing under it when the user '
        + 'never wrote a note — putting words in their mouth.');
});

check('a very long item is trimmed, and says so', () => {
    const long = 'x'.repeat(9000);
    const seed = t.buildSeed({ title: 'T', body: long }, 'blog_writer');
    assert.ok(seed.length < 6000, `Seed is ${seed.length} chars — the body is not being trimmed.`);
    assert.ok(/trimmed/.test(seed),
        'The seed is truncated silently. The assistant should be told the item continues, or it '
        + 'will draft from a fragment cut mid-sentence as though that were the whole idea.');
});

check('the body is not dropped when it is short', () => {
    const seed = t.buildSeed({ title: 'T', body: 'Short and whole.' }, 'blog_writer');
    assert.ok(seed.includes('Short and whole.'), 'The item body is missing from the seed.');
});

// ── The wiring ───────────────────────────────────────────────────────────────
check('the button markup and its click listener agree on one attribute', () => {
    assert.ok(/data-inspo-draft="\$\{i\.id\}"/.test(inspoSrc),
        'The card no longer renders a [data-inspo-draft] button.');
    assert.ok(/querySelectorAll\('\[data-inspo-draft\]'\)/.test(inspoSrc),
        'Nothing binds a click handler to [data-inspo-draft] — the button renders and does nothing.');
    assert.ok(/draftFromItem\(Number\(btn\.getAttribute\('data-inspo-draft'\)\)\)/.test(inspoSrc),
        'The [data-inspo-draft] handler no longer calls draftFromItem with the item id.');
});

check('the button is hidden when the chat modal is not on the page', () => {
    // assistant-inspo.js also loads on surfaces without workspace.html's chat modal. Rendering a
    // button that throws on click is worse than not offering it.
    assert.ok(/const canDraft = swanAvailable\(\)/.test(inspoSrc)
        && /\$\{canDraft && i\.isActive \?/.test(inspoSrc),
        'The draft button is no longer gated on swanAvailable() && isActive.');
    assert.ok(/typeof window\.openAssistantChatModal === 'function'/.test(inspoSrc),
        'swanAvailable() no longer checks for the chat modal.');
});

check('the seed is built from the FULL item, not the truncated preview', () => {
    // The list response carries bodyPreview/notePreview (truncated server-side). Seeding from those
    // hands the assistant an idea cut off mid-sentence.
    const fn = inspoSrc.slice(inspoSrc.indexOf('async function draftFromItem'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    assert.notEqual(body.length, 0, 'draftFromItem was renamed — this slice is empty.');
    assert.ok(/\$\{API\}\?id=\$\{id\}/.test(body),
        'draftFromItem no longer re-reads the full item by id.');
    // Property access only — the // comment above it NAMES those fields to explain why they are
    // not used, and matching prose instead of code is how a scan like this quietly stops testing
    // anything.
    assert.ok(!/\.(body|note)Preview\b/.test(body),
        'draftFromItem reads a *Preview field — the seed must use the full body and note.');
});

check('assistants.js passes the role through, or every seed is neutral', () => {
    const assistants = read('assistants.js');
    const call = assistants.slice(assistants.indexOf('window.AssistantInspo?.init('));
    const args = call.slice(0, call.indexOf('});'));
    assert.notEqual(args.length, 0, 'The AssistantInspo.init call site moved — this slice is empty.');
    assert.ok(/roleKey: data\.roleKey/.test(args),
        'init() is no longer given the roleKey, so every assistant gets the neutral wording and '
        + 'the Blog Writer stops being asked for a blog post.');
    assert.ok(/assistantName: data\.name/.test(args) && /assistantRole: data\.role/.test(args),
        'init() is no longer given the name/role, so the seeded chat opens with a blank header.');
});

console.log(`\n${passed} checks passed`);
