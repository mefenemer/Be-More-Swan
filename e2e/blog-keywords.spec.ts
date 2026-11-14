// Blog keywords (2026-11-14): the article's keyword box in Blog Studio, and Blog setup ▸ Keywords
// renaming / merging / removing one on every article. Real modules on a bare page, every function
// stubbed, with an in-memory blog standing in for blog_posts.tags.

import { test, expect } from './fixtures';
import type { ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const POST_ID = 51;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/public/marked-bms-directives.js"></script><script src="/src/components/markdown-editor.js"></script>
  <script src="/src/generated/platform-constants.js"></script><script src="/src/components/blog-studio-modal.js"></script>
</body></html>`;

/** A small blog: three articles, keyword lists the stubs below keep up to date. */
function stubBlog(api: ApiStub) {
    const posts: Record<number, { status: string; tags: string[] }> = {
        [POST_ID]: { status: 'draft', tags: ['employee engagement', 'wellbeing'] },
        52: { status: 'published', tags: ['employee engagement', 'staff retention'] },
        53: { status: 'published', tags: ['wellbeing'] },
    };
    const list = () => {
        const m = new Map<string, { keyword: string; articles: number; published: number }>();
        for (const p of Object.values(posts)) for (const k of p.tags) {
            const r = m.get(k) ?? { keyword: k, articles: 0, published: 0 };
            r.articles++; if (p.status === 'published') r.published++;
            m.set(k, r);
        }
        return [...m.values()].sort((a, b) => b.published - a.published || b.articles - a.articles || a.keyword.localeCompare(b.keyword));
    };
    api.set('get-assistants', { assistants: [{ id: 7, name: 'Quill', role: 'Blog Writer', roleKey: 'blog_writer', isActive: true, status: 'active' }] });
    api.set('blog-posts', () => ({ post: { id: POST_ID, assistantId: 7, title: 'Planning your first year of retirement', status: 'draft',
        bodyMarkdown: '## A new chapter\n\nSome words.', tags: posts[POST_ID].tags } }));
    api.set('save-widget-config', { config: { publicKey: 'e2e-key' } });
    api.set('save-blog-draft', (_r, body) => {
        const b = body as { id: number; tags?: string[] };
        if (Array.isArray(b.tags)) posts[b.id].tags = b.tags.map((t) => t.trim().toLowerCase()).slice(0, 3);
        return { ok: true, updatedAt: new Date().toISOString(), ...(Array.isArray(b.tags) ? { tags: posts[b.id].tags } : {}) };
    });
    api.set('blog-keywords', (_r, body) => {
        const b = body as { action?: string; from?: string; to?: string; keyword?: string } | null;
        let n = 0;
        if (b?.action === 'rename') for (const p of Object.values(posts)) {
            if (!p.tags.includes(b.from!)) continue;
            n++; p.tags = [...new Set(p.tags.map((t) => (t === b.from ? b.to! : t)))];
        }
        if (b?.action === 'remove') for (const p of Object.values(posts)) {
            if (!p.tags.includes(b.keyword!)) continue;
            n++; p.tags = p.tags.filter((t) => t !== b.keyword);
        }
        return b?.action ? { ok: true, articles: n, keywords: list() } : { keywords: list() };
    });
    return posts;
}

async function load(page: Page) {
    await page.route('**/e2e-blog-keywords.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-blog-keywords.html');
}

test('an article: see its keywords, remove one, add one — each saved straight away', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 950 });
    const posts = stubBlog(api);
    await load(page);
    await page.evaluate((id) => (window as unknown as { openBlogStudio(o: object): void }).openBlogStudio({ postId: id, assistantId: 7 }), POST_ID);
    const sec = page.locator('[data-bs-sec="seo"]');
    await sec.locator('summary').click();
    await expect(sec.locator('.bs-sec-title')).toHaveText('Keywords, SEO & social preview');
    await expect(page.locator('#bs-kw-list .bs-kw-chip')).toHaveCount(2);
    await expect(page.locator('#bs-kw-count')).toHaveText('2/3');

    await page.getByRole('button', { name: 'Remove keyword employee engagement' }).click();
    await expect(page.locator('#bs-kw-status')).toHaveText('Removed “employee engagement”');
    expect(posts[POST_ID].tags).toEqual(['wellbeing']);

    await page.locator('#bs-kw-input').fill('Retirement Planning, Life after work');
    await page.locator('#bs-kw-input').press('Enter');
    await expect(page.locator('#bs-kw-count')).toHaveText('3/3');
    expect(posts[POST_ID].tags).toEqual(['wellbeing', 'retirement planning', 'life after work']);
    await expect(page.locator('#bs-kw-input')).toBeHidden();
    await expect(page.locator('#bs-kw-full')).toHaveText('That’s the most an article can have. Remove one to add another.');
    await sec.scrollIntoViewIfNeeded();
    await page.locator('#bs-kw-field').screenshot({ path: 'test-results/blog-keywords-article.png' });

    // A keyword card pressed in chat updates the open article instead of leaving the old chips.
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent('blog:keywordsChanged', { detail: { postId: id, tags: ['retirement'] } })), POST_ID);
    await expect(page.locator('#bs-kw-list .bs-kw-chip')).toHaveCount(1);
    await expect(page.locator('#bs-kw-status')).toHaveText('Updated from chat');
    expect(pageErrors).toEqual([]);
});

test('Blog setup: rename merges, remove asks first, both change every article', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1200, height: 950 });
    const posts = stubBlog(api);
    await load(page);
    await page.evaluate(() => (window as unknown as { openBlogStudio(o: object): void }).openBlogStudio({ mode: 'setup', assistantId: 7 }));
    const sec = page.locator('[data-bs-sec="keywords"]');
    await expect(sec).toBeVisible();
    await expect(page.locator('[data-bs-sec="seo"]')).toBeHidden();
    await sec.locator('summary').click().catch(() => {});
    if (!(await sec.evaluate((d) => (d as HTMLDetailsElement).open))) await sec.locator('summary').click();
    await expect(sec.locator('.bs-kw-table tr')).toHaveCount(3);
    await expect(sec.locator('tr', { hasText: 'employee engagement' })).toContainText('2 articles · 1 live');
    await sec.screenshot({ path: 'test-results/blog-keywords-setup.png' });

    // Rename onto an existing keyword: the button says Merge before the click.
    await page.getByRole('button', { name: 'Rename employee engagement' }).click();
    await page.locator('#bs-kwm-input').fill('wellbeing');
    await expect(sec.locator('[data-kwm="save"]')).toHaveText('Merge');
    await expect(page.locator('#bs-kwm-hint')).toContainText('Merges “employee engagement” into “wellbeing”');
    await sec.screenshot({ path: 'test-results/blog-keywords-merge.png' });
    await sec.locator('[data-kwm="save"]').click();
    await expect(page.locator('#bs-kwm-status')).toHaveText('Merged into “wellbeing” on 2 articles.');
    expect(posts[POST_ID].tags).toEqual(['wellbeing']);
    expect(posts[52].tags).toEqual(['wellbeing', 'staff retention']);

    // Remove: asks, then removes everywhere.
    await page.getByRole('button', { name: 'Remove staff retention' }).click();
    await expect(sec).toContainText('Remove “staff retention” from 1 article · 1 live?');
    await sec.getByRole('button', { name: 'Remove keyword' }).click();
    await expect(page.locator('#bs-kwm-status')).toHaveText('Removed “staff retention” on 1 article.');
    expect(posts[52].tags).toEqual(['wellbeing']);
    await expect(sec.locator('.bs-kw-table tr')).toHaveCount(1);
    expect(pageErrors).toEqual([]);
});

test('phone width: the Keywords list fits without sideways scrolling', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    stubBlog(api);
    await load(page);
    await page.evaluate(() => (window as unknown as { openBlogStudio(o: object): void }).openBlogStudio({ mode: 'setup', assistantId: 7 }));
    const sec = page.locator('[data-bs-sec="keywords"]');
    if (!(await sec.evaluate((d) => (d as HTMLDetailsElement).open))) await sec.locator('summary').click();
    await expect(sec.locator('.bs-kw-table tr')).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await sec.screenshot({ path: 'test-results/blog-keywords-phone.png' });
    expect(pageErrors).toEqual([]);
});
