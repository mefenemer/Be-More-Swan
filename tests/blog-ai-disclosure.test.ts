// tests/blog-ai-disclosure.test.ts
// Locks the AI transparency disclosure on blog posts (EU AI Act Art. 50) across every surface.
// Pure: no network, no DB.
// Run:  npx tsx tests/blog-ai-disclosure.test.ts
//
// Two live bugs are pinned here:
//   1. OVER-disclosure — every publish stamps provenance_content_id, and the widget/permalink read
//      that column, so a hand-written post went out badged as AI-written on the customer's domain.
//   2. UNDER-disclosure — the interactive "generate with AI" path writes only body_markdown, so an
//      assistant-drafted post satisfied none of `jobId || blueprintId || isAutonomous` and recorded
//      itself as human-authored. A syndicated copy carried no disclosure at all.

import assert from 'node:assert';
import { isAiAssisted, BLOG_AI_NOTICE, ASSISTANT_DRAFT_REASON } from '../src/utils/blog-ai-assisted';
import { projectPost } from '../src/utils/blog-destinations/syndicate';
import { renderBlogPage } from '../src/utils/blog-seo';
import { DISCLOSURE } from '../src/config/compliance';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
async function checkAsync(name: string, fn: () => Promise<void>) { await fn(); console.log(`  ✓ ${name}`); passed++; }

/** A renderBlogPage payload with only the disclosure inputs varying. */
function page(over: { aiAssisted: boolean; badgeEnabled: boolean }) {
    return renderBlogPage({
        title: 'Post', description: 'D', pageUrl: 'https://app.test/b/k/s', canonicalUrl: null,
        robots: 'index,follow', imageUrl: null, imageAlt: null, tags: [], publishedAt: null,
        modifiedAt: null, authorName: null, publisher: { name: 'P', logoUrl: null }, siteName: 'S',
        bodyHtml: '<p>x</p>', ...over,
    });
}

(async () => {
    // ── the predicate ────────────────────────────────────────────────────────
    console.log('\nisAiAssisted\n');

    check('a hand-authored post is NOT AI-assisted', () => {
        assert.equal(isAiAssisted({ jobId: null, blueprintId: null, isAutonomous: false, generationReason: null }), false);
    });

    check('an empty row is NOT AI-assisted (nothing is disclosed by accident)', () => {
        assert.equal(isAiAssisted({}), false);
    });

    check('an autopilot draft is AI-assisted', () => {
        assert.equal(isAiAssisted({ jobId: 'job_1', isAutonomous: true, generationReason: 'autopilot_schedule' }), true);
    });

    check('an INTERACTIVE Studio draft is AI-assisted on generation_reason alone', () => {
        // The regression that mattered: this row has no jobId, no blueprintId, isAutonomous false.
        assert.equal(isAiAssisted({ generationReason: ASSISTANT_DRAFT_REASON }), true);
    });

    check('a blueprint-linked post is AI-assisted', () => {
        assert.equal(isAiAssisted({ blueprintId: 7 }), true);
    });

    check('an unrecognised generation_reason still discloses (fails towards disclosure)', () => {
        assert.equal(isAiAssisted({ generationReason: 'some_future_route' }), true);
    });

    // ── one sentence, every surface ──────────────────────────────────────────
    console.log('\nshared copy\n');

    check('compliance.DISCLOSURE surfaces the same notice the blog surfaces render', () => {
        assert.equal(DISCLOSURE.blogAiNotice, BLOG_AI_NOTICE);
    });

    check('the permalink badge renders the shared notice verbatim', () => {
        assert.ok(page({ aiAssisted: true, badgeEnabled: true }).includes(BLOG_AI_NOTICE));
    });

    check('a hand-authored permalink carries no notice', () => {
        assert.ok(!page({ aiAssisted: false, badgeEnabled: true }).includes(BLOG_AI_NOTICE));
    });

    // ── syndicated copies ────────────────────────────────────────────────────
    console.log('\nsyndication\n');

    const body = '# Title\n\nReal prose the author wrote.';

    await checkAsync('an AI-drafted post carries the notice to external platforms', async () => {
        const p = await projectPost({ id: 1, title: 'T', bodyMarkdown: body, generationReason: ASSISTANT_DRAFT_REASON });
        assert.ok(p, 'projected');
        assert.ok(p!.bodyMarkdown.includes(BLOG_AI_NOTICE), 'markdown adapters (Dev.to, Hashnode)');
        assert.ok((p!.bodyHtml || '').includes(BLOG_AI_NOTICE), 'HTML adapters (WordPress, Ghost)');
    });

    await checkAsync('a hand-authored post carries NO notice', async () => {
        const p = await projectPost({ id: 1, title: 'T', bodyMarkdown: body });
        assert.ok(p, 'projected');
        assert.ok(!p!.bodyMarkdown.includes(BLOG_AI_NOTICE));
        assert.ok(!(p!.bodyHtml || '').includes(BLOG_AI_NOTICE));
    });

    await checkAsync('the workspace badge toggle suppresses the syndicated notice too', async () => {
        const p = await projectPost(
            { id: 1, title: 'T', bodyMarkdown: body, isAutonomous: true },
            { badgeEnabled: false },
        );
        assert.ok(p && !p.bodyMarkdown.includes(BLOG_AI_NOTICE));
    });

    await checkAsync('an unknown badge preference DISCLOSES rather than staying silent', async () => {
        const p = await projectPost({ id: 1, title: 'T', bodyMarkdown: body, isAutonomous: true }, {});
        assert.ok(p && p.bodyMarkdown.includes(BLOG_AI_NOTICE));
    });

    await checkAsync('the notice never replaces the prose, and stays a separate block', async () => {
        const p = await projectPost({ id: 1, title: 'T', bodyMarkdown: body, isAutonomous: true });
        assert.ok(p!.bodyMarkdown.startsWith(body), 'author prose survives byte-for-byte');
        assert.ok(p!.bodyMarkdown.includes(`\n\n*${BLOG_AI_NOTICE}*`), 'appended as its own paragraph');
    });

    await checkAsync('a media-only post is still dropped, notice or not', async () => {
        assert.equal(await projectPost({ id: 1, title: 'T', bodyMarkdown: '   ', isAutonomous: true }), null);
    });

    console.log(`\n${passed} checks passed.`);
})();
