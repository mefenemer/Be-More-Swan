// tests/blog-refusal-never-saved.test.ts
// A blog post's body must never be the drafter refusing, or asking questions back.
//
// Seen on staging 2026-10-26 (workspace 58, blog post 39): a draft titled "Mentor Phase 2 test —
// delete me" came back as "I can't write this post as briefed…" plus a list of questions. The plain-
// Markdown path saved it as the article and the job was charged as a finished article. Now
// generateBlogBody throws before the write: the job fails (and retries) through process-blog-jobs.ts's
// failJob, the post is left as it was, and recordCompletedWork — which runs only after a completed
// draft — is never reached.
//
// Run:  npx tsx tests/blog-refusal-never-saved.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_AN_ARTICLE_MESSAGE, notAnArticle } from '../src/utils/blog-generate';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

// The reply seen on staging, verbatim in shape.
const seen = `I can't write this post as briefed.

The title says "Mentor Phase 2 test — delete me", which signals this isn't a real assignment.

If you'd like me to write an article about why they make films about true stories, I'm ready. Just give me:

- A real article title
- What you want the piece to do
- A real call to action

What would help?`;

console.log('blog: a refusal is never saved as the article');

check('the staging refusal is caught', () => assert.strictEqual(notAnArticle(seen), 'refusal'));

check('other refusal openings are caught', () => {
    for (const t of ['I cannot write about this topic.', 'I’m sorry, but I can’t help with that.', 'Sorry, I need more detail.', 'Unfortunately, I can’t draft this one.', 'I won’t write this as asked.']) {
        assert.strictEqual(notAnArticle(t), 'refusal', t);
    }
});

check('a reply that only asks questions back is caught', () => {
    assert.strictEqual(notAnArticle('Happy to help with this.\n\nBefore I write it, could you tell me who the article is for and what it should lead to?'), 'questions');
});

check('real articles pass, including ones that open "I can’t…"', () => {
    const article = `# Why we make films about true stories

I can't tell you how often someone asks why we don't just make things up.

## The difference a true story makes

When you watch a film based on real events, you're connecting with something that happened.

## What to do next

Follow us to see what we're working on next.`;
    assert.strictEqual(notAnArticle(article), null);
    assert.strictEqual(notAnArticle('A short post with no headings that ends by asking the reader something?'), null, 'a rhetorical question is not asking the author for more');
    assert.strictEqual(notAnArticle(''), null);
});

check('it is checked before the body is written, and says nothing was charged', () => {
    const src = read('src/utils/blog-generate.ts');
    const check = src.indexOf('const notArticle = notAnArticle(raw);');
    const write = src.indexOf('await db.update(blogPosts)');
    assert.ok(check > 0 && check < write, 'the check must run before the write');
    assert.match(src.slice(check, check + 400), /throw new Error\(NOT_AN_ARTICLE_MESSAGE\)/);
    assert.match(NOT_AN_ARTICLE_MESSAGE, /Nothing was charged/);
    // The task is charged only after a completed draft (process-blog-jobs.ts), so a throw spends nothing.
    const worker = read('netlify/functions/process-blog-jobs.ts');
    assert.ok(worker.indexOf('await generateBlogBody(db, {') < worker.indexOf("recordCompletedWork(db, job.organisation_id, 'blog_article'"));
});

console.log(`\n${passed}/5 passed`);
