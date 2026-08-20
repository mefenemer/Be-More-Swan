// tests/newsletter-chat-draft.test.ts
// Saving an issue written in chat.
//
// The Blog Writer's version of this shipped after the route spent months telling users to copy an
// article out of the transcript and retype it. The failure modes are known, and all four are here:
//
//   1. A REPLY THAT CLAIMS A DRAFT THE TURN NEVER PRODUCED. "That's saved to your issues" over a
//      null uiElement sends the user looking for something that does not exist.
//   2. A SECOND ROW ON EVERY RELOAD. A stored uiElement re-renders its buttons for as long as the
//      transcript lives, so Save can be pressed again next week.
//   3. A DRAFT SAVED WITHOUT ITS AI MARKER. An issue with no generationReason is indistinguishable
//      from one a human typed.
//   4. A MERGE TAG THAT SURVIVES TO AN INBOX. The model is told the vocabulary; the normaliser is
//      what enforces it.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newsletterDraftFromUiElement, NEWSLETTER_ISSUE_DRAFT_TYPE } from '../src/utils/newsletter-chat-draft';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const ORCH = read('netlify/functions/chat-orchestrator.ts');
const REGISTRY_UI = read('src/components/disruptive-ui-registry.js');
const SESSION = read('src/components/chat-session.js');
const ISSUES = read('netlify/functions/newsletter-issues.ts');

async function main() {

// ── 1. The normaliser ───────────────────────────────────────────────────────

await check('a draft with no body is refused outright', () => {
    // Nothing to keep — the caller falls back to a text-only reply rather than rendering a card
    // with a Save button that would create an empty issue.
    assert.equal(newsletterDraftFromUiElement({ type: NEWSLETTER_ISSUE_DRAFT_TYPE, subject: 'Hi' }), null);
    assert.equal(newsletterDraftFromUiElement({ type: 'something_else', bodyMarkdown: 'x' }), null);
    assert.equal(newsletterDraftFromUiElement(null), null);
});

await check('an unresolvable merge tag never reaches the card', () => {
    const d = newsletterDraftFromUiElement({
        type: NEWSLETTER_ISSUE_DRAFT_TYPE,
        subject: 'News for {{first_name}}',
        bodyMarkdown: 'Hi {{first_name}}, here is the news.',
    });
    assert.ok(d);
    assert.ok(!d!.bodyMarkdown.includes('{{'), 'the body must carry no tag the send worker cannot resolve');
    assert.ok(!d!.subject.includes('{{'));
    assert.ok(d!.warnings.length > 0, 'and the card must be able to say what it changed');
});

await check('a supported tag survives, and gains its fallback', () => {
    const d = newsletterDraftFromUiElement({
        type: NEWSLETTER_ISSUE_DRAFT_TYPE,
        subject: 'This month',
        bodyMarkdown: 'Hi {{contact.first_name}}, here is the news.',
    });
    assert.ok(d!.bodyMarkdown.includes('{{contact.first_name | "there"}}'),
        'a bare name tag renders as nothing for a subscriber with no name on file');
    assert.deepEqual(d!.warnings, []);
});

await check('a missing subject is derived rather than left blank', () => {
    const d = newsletterDraftFromUiElement({
        type: NEWSLETTER_ISSUE_DRAFT_TYPE,
        bodyMarkdown: '## Later on Thursdays\n\nFrom next week we are open until 8pm.',
    });
    assert.equal(d!.subject, 'Later on Thursdays', 'the heading marks are stripped');
});

// ── 2. The turn does not write ──────────────────────────────────────────────

await check('the route emits a card and persists nothing on the turn', () => {
    // Three redrafts in one conversation would be three rows in the Studio otherwise.
    const route = ORCH.slice(landmark(ORCH, 'newsletter_editor: {'), landmark(ORCH, 'blog_writer: {'));
    assert.match(route, /newsletter_issue_draft/);
    assert.match(route, /parseResponse: parseStructuredReply/);
    assert.ok(!route.includes('db.insert'), 'the route itself must not write a row');
    assert.match(route, /does NOT save anything/, 'and the prompt must say so to the model');
});

await check('the uiElement is normalised before it is persisted to the transcript', () => {
    // uiElementJson is stored verbatim and re-rendered on every reload, so a half-formed object
    // comes back as a broken card with a Save button for as long as the conversation lives.
    assert.match(ORCH, /const newsletterDraft = route === ROUTES\.newsletter_editor \? newsletterDraftFromUiElement\(uiElement\) : null;/);
    assert.match(ORCH, /uiElement = newsletterDraft \? \{ type: NEWSLETTER_ISSUE_DRAFT_TYPE, \.\.\.newsletterDraft \} : null;/);
});

await check('a reply claiming a draft it did not write is replaced', () => {
    const guard = ORCH.slice(landmark(ORCH, 'route === ROUTES.newsletter_editor && !newsletterDraft'));
    assert.match(guard.slice(0, 400), /honestDraftReply/);
    // And the shared sentence must name no surface, or it would point a newsletter user at Blogs.
    const claims = read('src/utils/chat-draft-claims.ts');
    // The returned STRING only — the `case 'blog_no_draft':` label itself obviously contains the
    // word, and comments in the block explain the wording. Neither is what reaches a user.
    const block = claims.slice(landmark(claims, "case 'blog_no_draft':"), landmark(claims, "case 'not_saved_here':"));
    const returned = block.slice(landmark(block, 'return "')).replace(/\/\/.*$/gm, '');
    assert.ok(!/blog/i.test(returned),
        'the shared reply must not name the blog surfaces — the newsletter route uses it too');
});

// ── 3. The client writes, once ──────────────────────────────────────────────

await check('the card asks the client to write, and reports the outcome back', () => {
    const card = REGISTRY_UI.slice(landmark(REGISTRY_UI, 'function renderNewsletterIssueDraftCard'), landmark(REGISTRY_UI, "register('newsletter_issue_draft'"));
    assert.match(card, /newsletter:createDraft/);
    assert.match(card, /respond\(\{ ok, deduped, error \}\)/, 'a create can fail, and a card that always claims success is worse than none');
    assert.match(card, /setBusy\(false\)/, 'a transient failure must not strand the only copy behind two dead buttons');
    // The two surface names it promises have to be the real ones.
    const reg = read('src/components/assistant-dashboard-registry.js');
    const entry = reg.slice(landmark(reg, 'newsletter_editor: {'), landmark(reg, 'blog_writer: {'));
    assert.match(entry, /label: 'Issues'/, 'the card says "Issues tab" — the registry has to agree');
    assert.match(card, /Issues tab/);
    assert.match(card, /Newsletter Studio/);
});

await check('nothing is sent by saving, and the card says so', () => {
    // The single most damaging misreading available here: Save is a filing action, not a send.
    const card = REGISTRY_UI.slice(landmark(REGISTRY_UI, 'function renderNewsletterIssueDraftCard'), landmark(REGISTRY_UI, "register('newsletter_issue_draft'"));
    assert.match(card, /Nothing is sent to anyone until you approve it/);
});

await check('the client posts to the newsletter endpoint with the assistant it belongs to', () => {
    const handler = SESSION.slice(landmark(SESSION, 'function onNewsletterDraftCreate'), landmark(SESSION, 'The composer does not exist in read-only mode'));
    assert.match(handler, /newsletter-issues/);
    assert.match(handler, /action: 'create'/);
    assert.match(handler, /if \(!assistantId\)/, 'a chat with no assistant cannot file an issue anywhere');
    assert.match(handler, /newsletter:created/, 'the Issues tab behind the modal has no other way to learn about this write');
    // Bound and unbound in the same places as its blog sibling, or a re-mounted chat leaks a listener.
    assert.match(SESSION, /addEventListener\('newsletter:createDraft'/);
    assert.match(SESSION, /removeEventListener\('newsletter:createDraft'/);
});

// ── 4. The write itself ─────────────────────────────────────────────────────

await check('saving the same draft twice produces one issue', () => {
    const create = ISSUES.slice(landmark(ISSUES, "if (action === 'create')"), landmark(ISSUES, "const id = Number(body.id"));
    assert.match(create, /deduped: true/);
    assert.match(create, /eq\(newsletterIssues\.subject, subject\)/);
    assert.match(create, /eq\(newsletterIssues\.bodyMarkdown, bodyMarkdown\)/);
});

await check('a chat-saved issue is stamped as machine-written', () => {
    // isAiAssisted-style provenance: an issue with no generationReason is indistinguishable from
    // one a human typed, and every disclosure downstream derives from it.
    const create = ISSUES.slice(landmark(ISSUES, "if (action === 'create')"), landmark(ISSUES, "const id = Number(body.id"));
    assert.match(create, /generationReason: NEWSLETTER_DRAFT_REASON/);
    assert.match(create, /bodyMarkdown \? \{ generationReason/, 'only when a body actually arrived — an empty issue the user started is theirs');
});

await check('the body is scrubbed on the way in as well as on the way out', () => {
    const create = ISSUES.slice(landmark(ISSUES, "if (action === 'create')"), landmark(ISSUES, "const id = Number(body.id"));
    assert.match(create, /scrubMergeTags/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
