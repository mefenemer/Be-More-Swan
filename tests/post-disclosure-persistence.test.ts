// tests/post-disclosure-persistence.test.ts
// The AI disclosure survives a caption being REPLACED.
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// The footer is not appended at publish time. It is written INTO the caption when the post is
// drafted (deterministically — see disclosure-footer.ts), which is what makes the per-post opt-out
// possible: the exact string is known, so it can be stripped and restored.
//
// The cost of that design is that anything replacing the caption wholesale deletes the disclosure
// with it, while `disclosure_footer_disabled` still reads false — so the editor's checkbox goes on
// reporting that the post carries a disclosure that is no longer in it. Ticked box, no text.
//
// Reported from chat: talk a post through, press "Yes, add it to my draft", and the assistant's
// caption replaces the post's own — footer included. But chat is not special; an assistant rewrite,
// an applied quality suggestion, and a person deleting the line by hand all do the same thing, which
// is why the guard lives on the WRITE.
//
// Run:  npx tsx tests/post-disclosure-persistence.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appendFooter, stripFooter, resolveDisclosureFooter } from '../src/utils/disclosure-footer';
import { keepDisclosureOnCaption } from '../src/utils/post-disclosure';

let passed = 0, total = 0;
const deferred: Array<() => Promise<void>> = [];
/** Queued, not awaited inline: tsx compiles these to CJS, which has no top-level await. */
function check(name: string, fn: () => void | Promise<void>) {
    total++;
    deferred.push(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
    });
}

const ROOT = path.resolve(import.meta.dirname, '..');

const FOOTER = 'Composed with Ava, our Be More Swan Digital Assistant.';

/**
 * Stands in for the two tables resolvePostFooter reads. `select({...}).from(T).where().limit()`
 * resolves to whichever row the caller asked for — org first, assistant second.
 */
function fakeDb(org: { enabled: boolean; text: string | null }, asst: { name: string; disclosureText: string | null } | null) {
    let call = 0;
    return {
        select() {
            const which = call++;
            const chain: any = {
                from: () => chain,
                where: () => chain,
                limit: async () => (which === 0 ? [org] : asst ? [asst] : []),
            };
            return chain;
        },
    };
}
const ORG_ON = { enabled: true, text: 'Composed with {assistant}, our Be More Swan Digital Assistant.' };
const ASST = { name: 'Ava', disclosureText: null };
const POST = { organisationId: 1, assistantId: 7, disclosureFooterDisabled: false };

console.log('\npost disclosure persistence\n');

// ── The rule, on the write path ─────────────────────────────────────────────────────────────────
check('a replacement caption gets the disclosure put back', async () => {
    // Exactly what chat's "add it to my draft" writes: the model's text, with no footer on it.
    const out = await keepDisclosureOnCaption(fakeDb(ORG_ON, ASST) as any, 'A brand new caption from chat', POST);
    assert.ok(String(out).includes(FOOTER), `the disclosure was lost — got: ${out}`);
    assert.ok(String(out).startsWith('A brand new caption from chat'), 'the user’s words must come first');
});

check('it is not appended twice when the caption still has it', async () => {
    const already = appendFooter('Still has its footer', FOOTER);
    const out = await keepDisclosureOnCaption(fakeDb(ORG_ON, ASST) as any, already, POST);
    assert.strictEqual(out, already, 'appendFooter is idempotent — a second copy is a visible bug');
    assert.strictEqual(String(out).split(FOOTER).length - 1, 1, 'exactly one disclosure');
});

check('a post that opted OUT is left exactly as written', async () => {
    const out = await keepDisclosureOnCaption(
        fakeDb(ORG_ON, ASST) as any, 'No disclosure wanted here',
        { ...POST, disclosureFooterDisabled: true });
    assert.strictEqual(out, 'No disclosure wanted here', 'the checkbox is the opt-out; it must win');
});

check('nothing is invented when the workspace has no footer', async () => {
    const out = await keepDisclosureOnCaption(
        fakeDb({ enabled: false, text: null }, { name: 'Ava', disclosureText: null }) as any,
        'Plain caption', POST);
    assert.strictEqual(out, 'Plain caption');
});

check('an empty caption is still given its disclosure', async () => {
    const out = await keepDisclosureOnCaption(fakeDb(ORG_ON, ASST) as any, '', POST);
    assert.ok(String(out).includes(FOOTER), 'clearing the words must not clear the legal line');
});

check('a caption that was never sent is untouched', async () => {
    // PATCH only sets what it is given; an edit to the link alone must not rewrite the caption.
    assert.strictEqual(await keepDisclosureOnCaption(fakeDb(ORG_ON, ASST) as any, undefined, POST), undefined);
    assert.strictEqual(await keepDisclosureOnCaption(fakeDb(ORG_ON, ASST) as any, null, POST), null);
});

check('a lookup failure does not block the edit', async () => {
    const broken = { select() { throw new Error('db down'); } };
    const out = await keepDisclosureOnCaption(broken as any, 'The user still gets to save', POST);
    assert.strictEqual(out, 'The user still gets to save', 'the save must not fail over a footer');
});

check('the opt-out toggle still round-trips', () => {
    // The other half of the contract: strip must undo exactly what append does, or toggling the
    // checkbox twice would leave debris in the caption.
    const body = 'Autumn menu is here';
    const on = appendFooter(body, FOOTER);
    assert.strictEqual(stripFooter(on, FOOTER).trim(), body);
    assert.strictEqual(appendFooter(stripFooter(on, FOOTER), FOOTER), on);
});

check('{assistant} is filled, so the stored line is the real one', () => {
    const footer = resolveDisclosureFooter({ orgEnabled: true, orgText: ORG_ON.text, assistantName: 'Ava' });
    assert.ok(!String(footer).includes('{assistant}'), 'an unfilled token would publish literally');
    assert.strictEqual(footer, FOOTER);
});

// ── The wiring ──────────────────────────────────────────────────────────────────────────────────
check('the caption write path re-asserts the footer', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/scheduled-posts.ts'), 'utf8');
    assert.match(src, /updates\.caption = await keepDisclosureOnCaption\(db, updates\.caption, existing\)/,
        'a PATCH that replaces the caption must put the disclosure back');
});

check('chat saves a new post WITH its disclosure', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/chat-orchestrator.ts'), 'utf8');

    // Scoped to the insert's own values, not the whole file. The rule is about what is STORED as the
    // post's caption; `draft.caption` is read legitimately elsewhere in the same function — the brand
    // card derives its headline from the un-footered text on purpose, since a disclosure line has no
    // business being set as display type on a picture. A file-wide regex read that as the bug.
    const at = src.indexOf('db.insert(scheduledPosts).values({');
    assert.notStrictEqual(at, -1, 'the chat draft insert moved — this test is guarding nothing');
    const end = src.indexOf('.returning(', at);
    assert.notStrictEqual(end, -1, 'could not find the end of the insert — widen the slice, do not drop it');
    const values = src.slice(at, end);

    assert.ok(!/caption: draft\.caption,/.test(values),
        'the raw model caption carries no footer — every other drafting route appends one');
    assert.match(values, /caption: captionWithFooter,/);
    assert.match(src, /resolvePostFooter\(db, orgId, aiAssistantId\)/);
});

check('the precedence rule has exactly one implementation', () => {
    // Two copies of "org footer wins when enabled, else the assistant's" is how a post ends up
    // published with no disclosure on it.
    const toggle = readFileSync(path.join(ROOT, 'netlify/functions/toggle-post-disclosure.ts'), 'utf8');
    assert.ok(!/resolveDisclosureFooter\(\{/.test(toggle),
        'the toggle must share resolvePostFooter, not re-derive the precedence');
    assert.match(toggle, /resolvePostFooter\(db, orgId, post\.assistantId\)/);
});

// ── The client half ─────────────────────────────────────────────────────────────────────────────
// Re-appending on the server is only half the fix. The editor cached the caption it SENT, so the
// preview would have gone on showing the version with no disclosure — beside a ticked checkbox —
// until a reload. Which is the symptom as reported.
check('the editor caches what the SERVER stored, not what it sent', () => {
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    const save = ws.slice(ws.indexOf('async function rqReviewSaveAmend('));
    const head = save.slice(0, 2600);
    assert.ok(!/_rqPostCache\[tid\]\.caption = caption;/.test(head),
        'echoing our own text back hides the footer the server just added');
    assert.match(head, /savedPost && typeof savedPost\.caption === 'string' \? savedPost\.caption : caption/,
        'the stored caption is the truth; ours is the fallback when the response has none');
});

check('the chat apply confirms by prefix, so a longer saved caption is not a failure', () => {
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    const apply = ws.slice(ws.indexOf('async function _pceApplyChatCaption('));
    const head = apply.slice(0, 1400);
    assert.ok(!/!== caption\) \{\n\s+throw new Error\('Could not save that to your draft/.test(head),
        'exact equality now fails on EVERY successful save — the server appends the disclosure');
    assert.match(head, /saved\.startsWith\(caption\.replace\(\/\\s\+\$\/, ''\)\)/,
        'appendFooter right-trims before appending, so the sent text is a prefix of the stored one');
});

(async () => {
    for (const run of deferred) await run();
    console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
    if (passed !== total) process.exit(1);
})();
