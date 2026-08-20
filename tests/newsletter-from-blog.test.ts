// tests/newsletter-from-blog.test.ts
// "Your blog post went out to your subscribers on Thursday, and you didn't do anything."
//
// The sentence is the feature and also the risk, because every word of it describes something
// happening without a person present. Five ways it goes wrong:
//
//   1. IT SENDS. A hand-off is exactly where a product quietly stops honouring "you approve every
//      issue" — the issue must land in pending_approval and go nowhere until a human says so.
//   2. THE EMAIL DOESN'T LINK TO THE POST. An issue about a post that fails to link to it is worse
//      than no issue: it is a newsletter that wasted the send. Models paraphrase URLs, so the link
//      is appended in code and the model is told not to write one.
//   3. A REPUBLISH DRAFTS IT AGAIN. Unpublish → republish is a supported round trip on blog_posts,
//      and it fires the hand-off a second time.
//   4. THE WRONG ARTIFACT. Every other hand-off enqueues a content job, which drafts a SOCIAL post.
//      A Newsletter Assistant produces newsletter_issues; the hub has always offered it as a target.
//   5. A DRAFT ABOUT A POST NOBODY CAN READ. "drafts a post" has no public URL to point at.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { appendSourceLink } from '../src/utils/newsletter-generate';
import { excerptForPrompt } from '../src/utils/newsletter-from-post';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const FROM_POST = read('src/utils/newsletter-from-post.ts');
const ORCH = read('src/utils/orchestration.ts');
const ORCH_API = read('netlify/functions/orchestrations.ts');
const GEN = read('src/utils/newsletter-generate.ts');
const SQL = read('db/newsletter-from-blog.sql');
const PUBLISH = read('src/utils/blog-publish.ts');
const UI = read('newsletter.js');
const HUB = read('orchestrations-content.html');

async function main() {

// ── 1. It drafts. It never sends. ───────────────────────────────────────────

await check('the issue lands in pending_approval, waiting for a person', () => {
    assert.match(FROM_POST, /status: 'pending_approval'/);
    // Nothing on this path may touch the send ledger or move an issue past approval.
    assert.ok(!FROM_POST.includes('newsletterSends'), 'a hand-off must never write a send row');
    for (const forbidden of ["'approved'", "'scheduled'", "'sending'", "'sent'"]) {
        assert.ok(!FROM_POST.includes(forbidden), `a hand-off must never set status ${forbidden}`);
    }
});

await check('a placeholder row is created BEFORE the model runs, and removed if it fails', () => {
    // Otherwise a failed generation leaves a blank issue in the review queue — and, worse, holds
    // the unique key so the next republish is refused by a row nobody wanted.
    const fn = FROM_POST.slice(landmark(FROM_POST, 'export async function draftIssueFromPost'));
    assert.ok(landmark(fn, 'db.insert(newsletterIssues)') < landmark(fn, 'await generateIssueBody'));
    const fail = fn.slice(landmark(fn, '} catch (err) {'));
    assert.match(fail, /db\.delete\(newsletterIssues\)/);
    assert.match(fail, /reason: 'generation_failed'/);
});

// ── 2. The link to the post ─────────────────────────────────────────────────

await check('the link is appended in code, and the model is told not to write one', () => {
    const prompt = GEN.slice(landmark(GEN, 'Do NOT write an unsubscribe line'), landmark(GEN, 'messages: [{ role:'));
    assert.match(prompt, /Do NOT write the link to the post/,
        'a model that writes its own URL will sometimes write a wrong one');
    assert.match(GEN, /export function appendSourceLink/);
});

await check('appendSourceLink adds the link exactly once', () => {
    const link = { url: 'https://example.com/post', title: 'How we did it' };
    const out = appendSourceLink('Body text.', link);
    assert.match(out, /\[How we did it\]\(https:\/\/example\.com\/post\)/);
    assert.strictEqual(out.split('https://example.com/post').length - 1, 1);
    // The model wrote the URL anyway: appending a second copy is the failure this prevents.
    const already = appendSourceLink('Read it at https://example.com/post now.', link);
    assert.strictEqual(already.split('https://example.com/post').length - 1, 1);
});

await check('a relative or missing URL yields no link rather than a broken one', () => {
    // There is no page for an email to be relative TO. A draft with no link is visible to the
    // human reviewing it; a link that goes nowhere is not.
    assert.strictEqual(appendSourceLink('Body.', { url: '/blog/post', title: 'T' }), 'Body.');
    assert.strictEqual(appendSourceLink('Body.', null), 'Body.');
    assert.strictEqual(appendSourceLink('Body.', { url: 'javascript:alert(1)', title: 'T' }), 'Body.');
});

await check('brackets in a title cannot break out of the markdown link', () => {
    const out = appendSourceLink('Body.', { url: 'https://example.com/p', title: 'A [weird] title' });
    assert.match(out, /\[A weird title\]\(https:\/\/example\.com\/p\)/);
});

// ── 3. One issue per post ───────────────────────────────────────────────────

await check('a republish cannot draft the same post twice', () => {
    // publishBlogPost fires the hand-off on EVERY publish, and unpublish → republish is supported.
    assert.match(SQL, /newsletter_issues_source_post_uidx[\s\S]{0,200}\(assistant_id, source_blog_post_id\)/);
    assert.match(FROM_POST, /onConflictDoNothing\(\)/);
    assert.match(FROM_POST, /reason: 'already_drafted'/);
});

await check('the column survives the post being deleted', () => {
    // The issue may already have been sent to a few thousand people.
    assert.match(SQL, /source_blog_post_id INTEGER REFERENCES blog_posts\(id\) ON DELETE SET NULL/);
});

await check('the migration is named as a prerequisite of the code that reads it', () => {
    // db.select() on newsletter_issues names every column, so the single-issue GET 500s on an
    // environment where this has not been applied.
    assert.match(SQL, /APPLY BEFORE DEPLOYING THE CODE/);
    assert.match(SQL, /RAISE EXCEPTION/, 'and it refuses to run before db/newsletter.sql');
});

// ── 4. The target's role decides the artifact ───────────────────────────────

await check('a newsletter target drafts an issue instead of enqueuing a content job', () => {
    const loop = ORCH.slice(landmark(ORCH, 'for (const link of links)'));
    const branch = loop.slice(landmark(loop, 'if (roleById.get(link.targetAssistantId) === NEWSLETTER_ROLE)'));
    assert.match(branch, /draftIssueFromPost/);
    // ⚠️ Before the blueprint lookup, and it must not fall through to it: that path drafts a
    // SOCIAL post, which is the wrong artifact for this assistant entirely.
    assert.ok(landmark(loop, 'draftIssueFromPost') < landmark(loop, 'db.select({ id: aiBlueprints.id })'));
    assert.match(branch.slice(0, landmark(branch, 'const [bp]')), /continue;/);
});

await check('a hand-off that drafted nothing is recorded as skipped, not as a hand-off', () => {
    // "Why is there no issue for that post?" has to be answerable from the run row.
    const loop = ORCH.slice(landmark(ORCH, 'for (const link of links)'));
    const branch = loop.slice(landmark(loop, 'if (roleById.get(link.targetAssistantId) === NEWSLETTER_ROLE)'), landmark(loop, 'const [bp]'));
    assert.match(branch, /status: 'skipped'/);
    assert.match(branch, /firedToday--/, 'and the daily cap is given back, since no model call was made');
});

await check('the source kind is passed from the blog publish, not inferred', () => {
    assert.match(PUBLISH, /sourcePostKind: 'blog_post'/);
    assert.match(ORCH, /sourcePostKind\?: 'blog_post' \| 'social_post' \| null/);
    // blog_posts.id and scheduled_posts.id are different id spaces; reading the wrong table would
    // ground the issue in an unrelated post.
    assert.match(FROM_POST, /args\.sourcePostKind === 'blog_post'/);
});

// ── 5. Only a published post ────────────────────────────────────────────────

await check('the API refuses a newsletter target on any event but "publishes a post"', () => {
    const post = ORCH_API.slice(landmark(ORCH_API, "if (method === 'POST')"));
    assert.match(post, /targetIsNewsletter && sourceEvent !== 'publishes_a_post'/);
    assert.match(post, /can only pick one up once it is published/);
});

await check('and the runtime refuses it too, for links built before that rule', () => {
    const branch = ORCH.slice(landmark(ORCH, 'if (roleById.get(link.targetAssistantId) === NEWSLETTER_ROLE)'));
    assert.match(branch.slice(0, landmark(branch, 'draftIssueFromPost')), /event !== 'publishes_a_post'/);
});

await check('the hub stops offering the combination it would reject', () => {
    assert.match(HUB, /_orchSyncTargetRules/);
    assert.match(HUB, /roleKey === 'newsletter_editor'/);
    assert.match(HUB, /o\.disabled = newsletter && o\.value !== 'publishes_a_post'/);
});

// ── 6. The brief the model is given ─────────────────────────────────────────

await check('the excerpt drops what a model cannot use', () => {
    const md = '---\ntitle: X\n---\n\n# Heading\n\n![alt](https://img/x.png)\n\nReal [words](https://a.b) here.\n\n```js\ncode();\n```\n';
    const out = excerptForPrompt(md);
    assert.ok(!out.includes('title: X'), 'front matter reads as content and has been quoted in a draft');
    assert.ok(!out.includes('img/x.png'), 'the model cannot see an image');
    assert.ok(!out.includes('code()'), 'and has no use for a code block in an email brief');
    assert.match(out, /Real words here\./, 'link text survives; the URL does not');
});

await check('a long post is cut at a paragraph break, not mid-sentence', () => {
    const para = 'x'.repeat(400);
    const md = Array(20).fill(para).join('\n\n');
    const out = excerptForPrompt(md, 1000);
    assert.ok(out.length <= 1000);
    assert.ok(!out.endsWith('\n\n'));
    assert.strictEqual(out.slice(-1), 'x', 'it should end on a whole paragraph');
});

await check("the link's own wording steers the draft", () => {
    // The freeform action is the only place the user says HOW the post should be covered.
    assert.match(FROM_POST, /What the business asked for when they set this up/);
    assert.match(ORCH, /targetAction: link\.targetAction/);
});

// ── 7. The reviewer is told where it came from ──────────────────────────────

await check('an issue that appeared on its own says why it exists', () => {
    assert.match(UI, /Drafted from your blog post/);
    assert.match(UI, /generationReason !== 'blog_post_handoff'/);
    assert.match(UI, /Nothing is sent until you approve it/);
    assert.match(read('newsletter.html'), /id="nl-source"/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
