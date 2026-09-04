// tests/overlay-text-assistant.test.ts
// "Suggest wording" / "Improve this" on a text overlay.
//
// Overlay text is not a caption: it is read at a glance, on mute, over a picture, in about a
// second. A caption model left to itself writes a sentence, which wraps to three lines on a 1080
// canvas and stops being readable — so the length ceiling is enforced on the way OUT, not merely
// requested in the prompt. These are the invariants worth protecting.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const fn = readFileSync(path.join(ROOT, 'netlify/functions/suggest-overlay-text.ts'), 'utf8');
const editor = readFileSync(path.join(ROOT, 'src/components/image-overlay-editor.js'), 'utf8');
const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');

console.log('\noverlay wording from the assistant\n');

check('the model call is metered as a task', () => {
    // A button that can be pressed indefinitely, each press costing a model call. Unmetered, the
    // plan's cap quietly stops being a cap.
    assert.match(fn, /consumeTaskCredit\(db, ctx\.organisationId\)/, 'every model call on the user\'s behalf is a task');
    // ...and a cap that could not be EVALUATED must not be reported as a plan limit.
    assert.match(fn, /if \(credit\.failed\) return json\(503/, 'a server fault must not tell the user to upgrade');
    assert.match(fn, /return json\(403, \{ error: credit\.limitMessage/, 'a real limit still gets the paywall answer');
});

check('the post is tenant-guarded before anything is spent', () => {
    const guardAt = fn.indexOf('eq(scheduledPosts.organisationId, ctx.organisationId)');
    // The CALL, not the import at the top of the file.
    const spendAt = landmark(fn, 'await consumeTaskCredit(');
    assert.ok(guardAt > 0, 'the post must be scoped to the caller\'s org');
    assert.ok(guardAt < spendAt, 'spending a credit before proving ownership bills the wrong workspace');
});

check('the length ceiling is enforced, not just requested', () => {
    assert.match(fn, /const MAX_OVERLAY_CHARS = 80/, 'a readable overlay is short');
    assert.match(fn, /if \(text\.length > MAX_OVERLAY_CHARS\) text = text\.slice\(0, MAX_OVERLAY_CHARS\)/,
        'a model asked to be brief is not a model that is brief');
    // One line, no quotes, no fences — the user must not have to tidy the result by hand.
    assert.match(fn, /text\.split\('\\n'\)\[0\]/, 'multi-line output would break the overlay');
    assert.match(fn, /replace\(\/\^\["'“”'\]\+\|\["'“”'\]\+\$\/g, ''\)/, 'a quoted hook prints its own quotes');
});

check('improve with nothing to improve is refused up front', () => {
    // Asking a model to improve an empty string returns an apology, which would then be pasted onto
    // the picture as the overlay.
    assert.match(fn, /if \(mode === 'improve' && !currentText\) return json\(400/, 'refuse before spending a credit');
    assert.match(editor, /data-ai="improve"[^>]*\$\{String\(ov\.text \|\| ''\)\.trim\(\) \? '' : ' disabled'\}/,
        'and the button starts disabled so it cannot be reached');
});

check('the editor stays DOM-agnostic — no post ids inside it', () => {
    assert.ok(!/postId/.test(editor), 'this component is reused by hosts with no post behind them');
    assert.match(editor, /function open\(\{ imageUrl, overlays, onDone, suggestText \}\)/, 'the host injects the capability');
    assert.match(editor, /if \(aiRow && typeof suggestText !== 'function'\) \{\s*\n\s*aiRow\.remove\(\)/,
        'a button that cannot work is worse than no button');
});

check('a failure shows the server\'s own message', () => {
    // "Monthly task limit reached" and "AI is temporarily unavailable" are both things the user can
    // act on; "something went wrong" is not.
    assert.match(editor, /msg\.textContent = \(err && err\.message\)/, 'surface the real reason');
    assert.match(ws, /throw new Error\(d\.error \|\| 'Could not write that wording\.'\)/, 'and pass it through from the response');
    assert.match(editor, /finally \{/, 'the buttons must re-enable even when the call throws');
});

check('an accepted suggestion updates the textarea AND the canvas', () => {
    // The textarea is the model the rest of the panel reads from; the canvas is what the user is
    // looking at. Writing one and not the other leaves them disagreeing.
    const block = editor.slice(landmark(editor, "const text = await suggestText("));
    assert.match(block.slice(0, 400), /ov\.text = text/);
    assert.match(block.slice(0, 400), /if \(ta\) ta\.value = text/);
    assert.match(block.slice(0, 400), /rerender\(\)/);
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
// The runner (scripts/run-tests.mjs) decides pass/fail from this process's exit status alone.
// Without this line a failed check prints its ✗ and the file still reports green.
if (passed !== total) process.exitCode = 1;
