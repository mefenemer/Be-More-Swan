// Blog Studio opened onto a BLANK panel on prod (2026-11-12): blog-posts 502'd (two columns missing on
// the prod DB), and the error was written into a banner inside the still-hidden workspace. A failed
// open — a new draft or an existing article — must say so on screen and offer Try again.

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/public/marked-bms-directives.js"></script><script src="/src/components/markdown-editor.js"></script>
  <script src="/src/generated/platform-constants.js"></script><script src="/src/components/blog-studio-modal.js"></script>
</body></html>`;

async function open(page: Page, opts: object) {
    await page.route('**/e2e-blog-studio-err.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-blog-studio-err.html');
    await page.evaluate((o) => (window as unknown as { openBlogStudio(o: object): void }).openBlogStudio(o), opts);
}

test('a new draft that cannot be created says so, and Try again opens the editor once it works', async ({ page, api }) => {
    api.set('blog-posts', { status: 502, json: { errorType: 'Error', errorMessage: 'An unknown error has occurred' } });
    await open(page, {});
    const box = page.locator('#bs-open-error');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Could not start a new draft');
    await expect(page.locator('#bs-workspace')).toBeHidden();

    api.set('blog-posts', { post: { id: 9, title: 'Untitled draft', status: 'draft', bodyMarkdown: '' } });
    await page.locator('#bs-open-retry').click();
    await expect(box).toBeHidden();
    await expect(page.locator('#bs-workspace')).toBeVisible();
});

test('an existing article that cannot load says so instead of a blank panel', async ({ page, api }) => {
    api.set('blog-posts', { status: 502, json: { errorType: 'Error', errorMessage: 'Failed query: select …' } });
    await open(page, { postId: 132 });
    await expect(page.locator('#bs-open-error')).toContainText('Could not open this article');
    await expect(page.locator('#bs-workspace')).toBeHidden();
});
