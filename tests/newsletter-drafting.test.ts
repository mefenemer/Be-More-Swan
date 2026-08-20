// tests/newsletter-drafting.test.ts
// Drafting an issue, and turning it into the email a subscriber actually receives.
//
// The failures here all ship. There is no staging inbox that catches them:
//
//   1. A merge tag the send worker cannot resolve. `{{first_name}}` — un-namespaced, the tag a
//      model reaches for by habit — renders as nothing, so every recipient reads "Hi ," and the
//      tenant finds out from a customer. A malformed one is worse: the literal braces arrive.
//   2. A snapshot with the tags already resolved. Personalisation happens per recipient at SEND
//      time; if approval resolved them, all 5,000 people get whatever the sample contact was called.
//   3. Be More Swan's branding on a tenant's newsletter. renderMasterTemplate is our shell, with
//      our logo and our privacy links, and it is one import away from being used here by mistake.
//   4. A missing unsubscribe line. The model is told not to write one because the footer is
//      appended in code — so if the code stops appending it, nothing else does.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubMergeTags } from '../src/utils/newsletter-generate';
import { renderForRecipient, renderIssueSnapshot, newsletterUnsubscribeUrl } from '../src/utils/newsletter-render';
import {
    applyDefaultFallbacks, contactMergeContext, NEWSLETTER_MERGE_KEYS,
} from '../src/config/newsletter-merge-vars';
import { renderMergeVars } from '../src/utils/email-template';
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

const GEN = read('src/utils/newsletter-generate.ts');
const RENDER = read('src/utils/newsletter-render.ts');
const ISSUES = read('netlify/functions/newsletter-issues.ts');

async function main() {

// ── 1. Merge tags ────────────────────────────────────────────────────────────

await check('a bare name tag gains its fallback, so a nameless subscriber reads a sentence', () => {
    const out = applyDefaultFallbacks('Hi {{contact.first_name}}, welcome.');
    assert.equal(out, 'Hi {{contact.first_name | "there"}}, welcome.');
    // Rendering it proves the point rather than just asserting the string.
    const ctx = contactMergeContext({ firstName: null, email: 'x@y.com' }, 'Acme Ltd');
    assert.equal(renderMergeVars(out, ctx), 'Hi there, welcome.');
});

await check('an author-supplied fallback is left alone', () => {
    const src = 'Hi {{contact.first_name | "friend"}},';
    assert.equal(applyDefaultFallbacks(src), src);
});

await check('the un-namespaced tag a model reaches for by habit is REMOVED, not shipped', () => {
    // {{first_name}} is well-formed and resolves to nothing, which is the silent version of
    // this bug: the sentence quietly loses a word in every inbox.
    const { text, warnings } = scrubMergeTags('Hi {{first_name}}, here is the news.');
    assert.ok(!text.includes('{{'), `no tag may survive: ${text}`);
    assert.equal(text, 'Hi , here is the news.'.replace('{{first_name}}', ''));
    assert.ok(warnings.some((w) => w.includes('first_name')), 'and the reviewer is told');
});

await check('a malformed tag never reaches an inbox as literal braces', () => {
    for (const bad of ['Hi {{contact first_name}},', 'Hi {{ }},', 'Hi {{contact.first_name,']) {
        const { text, warnings } = scrubMergeTags(bad);
        assert.ok(!text.includes('{{'), `literal braces survived: ${text}`);
        assert.ok(warnings.length > 0, `and it must be reported: ${bad}`);
    }
});

await check('supported tags survive scrubbing untouched', () => {
    const src = 'Hi {{contact.first_name | "there"}}, news for {{contact.company | "your team"}} from {{sender.name}}.';
    const { text, warnings } = scrubMergeTags(src);
    assert.equal(text, src);
    assert.deepEqual(warnings, []);
});

await check('every key the prompt advertises is one renderMergeVars can actually resolve', () => {
    // The four-reader problem: prompt, editor, preview and send worker must agree, or the tag the
    // model was told to write is the tag that renders empty.
    const ctx = contactMergeContext(
        { firstName: 'Jane', lastName: 'Okafor', company: 'Acme Ltd', email: 'jane@acme.com' }, 'Acme Ltd');
    for (const key of NEWSLETTER_MERGE_KEYS) {
        const rendered = renderMergeVars(`[{{${key}}}]`, ctx);
        assert.notEqual(rendered, '[]', `${key} resolved to nothing — the context shape does not match the key`);
    }
});

await check('a subscriber whose name breaks HTML does not break the email', () => {
    const ctx = contactMergeContext({ firstName: "O'Brien & <Sons>", email: 'x@y.com' }, 'Acme');
    const html = renderMergeVars('Hi {{contact.first_name}},', ctx, true);
    assert.ok(!html.includes('<Sons>'), 'HTML must be escaped in the HTML part');
    const text = renderMergeVars('Hi {{contact.first_name}},', ctx, false);
    assert.ok(text.includes("O'Brien & <Sons>"), 'and NOT escaped in the plain-text part, or people read &amp;');
});

// ── 2. The snapshot ──────────────────────────────────────────────────────────

await check('the approval snapshot keeps merge tags UNRESOLVED', async () => {
    // If approval resolved them, every recipient would receive whichever contact happened to be
    // rendered against — the single most damaging bug this pipeline could have.
    const snap = await renderIssueSnapshot({
        bodyMarkdown: 'Hi {{contact.first_name | "there"}}, welcome to the news.',
        preheader: 'This week in brief',
        senderName: 'Acme Ltd',
    });
    assert.ok(snap.html.includes('{{contact.first_name'), 'the HTML part must still carry the tag');
    assert.ok(snap.text.includes('{{contact.first_name'), 'and so must the text part');
});

await check('the snapshot carries a preheader, hidden in the body', async () => {
    const snap = await renderIssueSnapshot({ bodyMarkdown: 'Body.', preheader: 'This week in brief', senderName: 'Acme Ltd' });
    assert.ok(snap.html.includes('This week in brief'));
    assert.match(snap.html, /display:none;max-height:0/, 'it belongs in the inbox list, not on the page');
});

await check('a tenant newsletter carries NO Be More Swan branding', async () => {
    const snap = await renderIssueSnapshot({ bodyMarkdown: 'Body.', senderName: 'Acme Ltd' });
    for (const ours of ['Be More Swan', 'bemoreswan.com/privacy', 'bemoreswan.com/terms']) {
        assert.ok(!snap.html.includes(ours), `${ours} must not appear in a tenant's own newsletter`);
    }
    assert.ok(snap.html.includes('Acme Ltd'), 'the sender is the tenant');
    // And the module must not reach for our branded shell by mistake. Asserted on the IMPORT, not
    // on any mention — the header comment names it precisely to warn the next reader off it.
    const imports = RENDER.slice(0, landmark(RENDER, 'export function newsletterUnsubscribeUrl'));
    assert.ok(!/import[^;]*renderMasterTemplate/.test(imports),
        'renderMasterTemplate is OUR shell — importing it here signs a tenant\'s mail with our brand');
});

await check('markdown is rendered and sanitised, not passed through', async () => {
    const snap = await renderIssueSnapshot({
        bodyMarkdown: '## Heading\n\nSome **bold** copy.\n\n<script>alert(1)</script>',
        senderName: 'Acme Ltd',
    });
    assert.ok(snap.html.includes('<h2') || snap.html.includes('<h2>'), 'markdown must be rendered');
    assert.ok(!snap.html.includes('<script>alert(1)'), 'a pasted script tag must not survive into an inbox');
});

// ── 3. The per-recipient render ──────────────────────────────────────────────

const snapshot = await renderIssueSnapshot({
    bodyMarkdown: 'Hi {{contact.first_name | "there"}}, here is the news.',
    preheader: 'This week',
    senderName: 'Acme Ltd',
});

await check('the footer is appended in code, inside the document', () => {
    const out = renderForRecipient({
        snapshot,
        contact: { firstName: 'Jane', email: 'jane@acme.com' },
        senderName: 'Acme Ltd',
        unsubscribeUrl: newsletterUnsubscribeUrl('https://bemoreswan.com', 'tok_abc'),
        postalAddress: '12 King Street, Manchester, M2 6AG',
    });
    assert.ok(out.html.includes('Unsubscribe'), 'every commercial email needs a way out');
    assert.ok(out.html.includes('tok_abc'), 'and it must carry THIS recipient\'s token');
    assert.ok(out.html.indexOf('Unsubscribe') < out.html.indexOf('</html>'),
        'the footer must sit inside the document — some clients drop anything after </html>');
    assert.ok(out.text.includes('Unsubscribe: https://'), 'the text part needs it too');
    assert.equal(out.listUnsubscribe, '<https://bemoreswan.com/api/newsletter/unsubscribe?t=tok_abc>',
        'RFC 8058 one-click is what Gmail and Yahoo require of bulk senders');
});

await check('the postal address appears only when it is a real address', () => {
    const withBad = renderForRecipient({
        snapshot, contact: { email: 'x@y.com' }, senderName: 'Acme Ltd',
        unsubscribeUrl: 'https://x/y', postalAddress: 'UK',
    });
    // "UK" satisfies a non-empty check and satisfies no regulator — isUsablePostalAddress is the
    // shared rule, so this stays in step with the outreach gate rather than drifting from it.
    assert.ok(!withBad.text.includes('UK\n'), 'a junk address must not be presented as compliance');

    const withGood = renderForRecipient({
        snapshot, contact: { email: 'x@y.com' }, senderName: 'Acme Ltd',
        unsubscribeUrl: 'https://x/y', postalAddress: '12 King Street, Manchester, M2 6AG',
    });
    assert.ok(withGood.text.includes('12 King Street'));
});

await check('the recipient sees their own name, and a nameless one sees the fallback', () => {
    const named = renderForRecipient({
        snapshot, contact: { firstName: 'Jane', email: 'jane@acme.com' }, senderName: 'Acme Ltd', unsubscribeUrl: 'https://x/y',
    });
    assert.ok(named.text.includes('Hi Jane,'));
    const nameless = renderForRecipient({
        snapshot, contact: { email: 'x@y.com' }, senderName: 'Acme Ltd', unsubscribeUrl: 'https://x/y',
    });
    assert.ok(nameless.text.includes('Hi there,'), 'never "Hi ,"');
    assert.ok(!nameless.html.includes('{{'), 'and no tag may survive the send-time render');
});

// ── 4. What the drafting prompt promises ─────────────────────────────────────

await check('the model is told not to write the footer that code appends', () => {
    // Otherwise every issue carries two unsubscribe lines, one of which is fiction.
    const prompt = GEN.slice(landmark(GEN, 'system:'), landmark(GEN, 'messages: ['));
    assert.match(prompt, /Do NOT write an unsubscribe line/);
    assert.match(prompt, /postal address/);
});

await check('the date block leads the prompt, as on every other content surface', () => {
    const prompt = GEN.slice(landmark(GEN, 'system:'), landmark(GEN, 'messages: ['));
    assert.ok(prompt.indexOf('currentDatePromptBlock') < prompt.indexOf('You are writing an email newsletter'),
        'drafts that self-date to last year are visible in every inbox');
});

await check('the model is told not to invent facts', () => {
    const prompt = GEN.slice(landmark(GEN, 'system:'), landmark(GEN, 'messages: ['));
    assert.match(prompt, /Do NOT invent statistics/);
});

await check('the draft is stamped as machine-written in the same write as the body', () => {
    const write = GEN.slice(landmark(GEN, 'await db.update(newsletterIssues)'));
    assert.ok(write.includes('generationReason'), 'a machine draft must never exist without the marker');
    assert.match(write, /COALESCE/, 'and an autopilot run\'s more specific reason must win');
});

// ── 5. Approval is a decision about real people ──────────────────────────────

await check('approval snapshots the rendered payload', () => {
    const approve = ISSUES.slice(landmark(ISSUES, "if (action === 'approve')"), landmark(ISSUES, "if (action === 'reject')"));
    assert.ok(approve.includes('renderIssueSnapshot'), 'approval is where the words are frozen');
    assert.ok(approve.includes('renderedPayload: snapshot'));
});

await check('editing an approved issue clears the approval', () => {
    const update = ISSUES.slice(landmark(ISSUES, "if (action === 'update')"), landmark(ISSUES, "if (action === 'generate')"));
    assert.ok(update.includes("patch.status = 'draft'"), 'the words a human signed off no longer match the file');
    assert.ok(update.includes('patch.renderedPayload = null'));
});

await check('a sent issue can no longer be changed', () => {
    const gate = ISSUES.slice(landmark(ISSUES, "const LOCKED ="), landmark(ISSUES, "if (action === 'update')"));
    assert.match(gate, /'sending', 'sent'/);
    assert.match(gate, /409/, 'rewriting what was already delivered is not an edit, it is a false record');
});

await check('approving is restricted to owner/admin', () => {
    assert.match(ISSUES, /const APPROVE_ROLES = \['owner', 'admin'\]/);
    const approve = ISSUES.slice(landmark(ISSUES, "if (action === 'approve')"), landmark(ISSUES, "if (action === 'reject')"));
    assert.ok(approve.includes('APPROVE_ROLES.includes(ctx.role)'), 'the gate has to be IN the branch, not merely defined');
});

await check('the audience number is presented as an estimate, never as a promise', () => {
    const fn = ISSUES.slice(landmark(ISSUES, 'async function estimateAudience'), landmark(ISSUES, 'export default withLambda'));
    assert.match(fn, /subscribed/);
    // The opt-out and suppression checks run per address at send time, so the real figure can only
    // be lower. The name and the comment both have to say so.
    assert.match(fn, /ESTIMATE|estimate/);
    assert.ok(ISSUES.includes('audienceEstimate'), 'and the field the UI reads is named for it');
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
