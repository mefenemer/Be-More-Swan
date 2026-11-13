// Issue #47: on the Blog Writing Assistant, the "Open Blogs →" button in the Needs-you card (top right,
// beside the chat) went nowhere. The Blogs tab is where that assistant lands, so the button only
// re-opened the tab already on screen. It now brings the Blogs list into view.

import { test, expect, openWorkspace } from './fixtures';

test.use({ viewport: { width: 1280, height: 720 } });

test('"Open Blogs →" takes the user to their blogs', async ({ page, api, signedIn, pageErrors }) => {
    api.set('get-assistant-context', { id: 9, name: 'Mira', role: 'Blog Writing Assistant', roleKey: 'blog_writer', status: 'working', lifecycleStatus: 'active', context: {}, goals: [], configuration: {} });
    const now = new Date().toISOString();
    const posts = Array.from({ length: 8 }, (_, i) => ({
        id: 100 + i, assistantId: 9, title: `Waiting article ${i + 1}`, status: 'pending_approval',
        excerptSource: 'A short piece about coffee beans, roasting and the people who drink it every morning.',
        wordCount: 900, updatedAt: now, createdAt: now,
    }));
    api.set('blog-posts', { posts });

    await openWorkspace(page);
    await page.evaluate(() => (window as any).loadView('assistant-detail', 9));
    await expect(page.locator('#maintab-btn-review-queue')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-rq-blog="100"]')).toBeAttached();

    const go = page.locator('#needs-you-go');
    await expect(go).toBeVisible();
    await expect(go).toHaveText(/Open Blogs/);

    const panelTop = () => page.locator('#maintab-review-queue').evaluate((el) => el.getBoundingClientRect().top);
    const before = await panelTop();
    expect(before).toBeGreaterThan(120);

    await go.click();
    // The Blogs list is brought up to the top of the screen.
    await expect.poll(panelTop, { timeout: 5000 }).toBeLessThan(120);
    await expect(page.locator('[data-rq-blog="100"]')).toBeInViewport();
    expect(pageErrors).toEqual([]);
});
