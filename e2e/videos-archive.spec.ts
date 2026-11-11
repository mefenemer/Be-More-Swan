// Bulk archive / restore / delete on the Video Producer's Videos tab (owner, 2026-11-10). The tab's real
// modules on a bare page, with every function stubbed.

import { test, expect } from './fixtures';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-videos"><div id="videos-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script><script src="/src/components/tab-head.js"></script>
  <script src="/src/components/assistant-videos.js"></script>
  <script>AssistantVideos.init({ assistantId: 6, assistantName: 'Cleo', setup: {} }); setTimeout(() => AssistantVideos.activate(), 50);</script>
</body></html>`;

const video = (id: number, title: string, status: string, archivedAt: string | null = null) =>
    ({ id, aiAssistantId: 6, title, status, origin: 'user', brief: { lengthS: 30 }, sceneThumbs: {}, storyboard: null, archivedAt });

test('tick videos, archive them, restore one, delete one after confirming', async ({ page, api, pageErrors }) => {
    const videos = [video(1, 'Summer roast', 'ready'), video(2, 'Winter blend', 'ready'), video(3, 'Being made', 'building')];
    api.set('video-projects', (route, body) => {
        if (route.request().method() === 'GET') return { projects: videos };
        const b = body as { action: string; ids: number[] };
        for (const id of b.ids) {
            const v = videos.find((x) => x.id === id)!;
            if (b.action === 'archive') v.archivedAt = '2026-11-10T10:00:00Z';
            if (b.action === 'restore') v.archivedAt = null;
            if (b.action === 'delete') videos.splice(videos.indexOf(v), 1);
        }
        return { done: b.ids, skipped: [] };
    });
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');

    await page.locator('[data-vid-stage="made"]').click();
    await expect(page.locator('[data-vid-pick]')).toHaveCount(2);
    await page.locator('[data-vid-act="pick-all"]').click();
    await expect(page.locator('[data-vid-bulkbar]')).toContainText('2 selected');
    await page.locator('[data-vid-act="bulk-archive"]').click();
    await expect(page.locator('[role="status"]')).toContainText('Archived 2 videos.');
    const sent = api.called('video-projects').filter((c) => c.body).map((c) => c.body);
    expect(sent[0]).toEqual({ action: 'archive', ids: [1, 2] });

    // A video being made can't be ticked.
    await page.locator('[data-vid-stage="making"]').click();
    await expect(page.locator('[data-vid-pick="3"]')).toBeDisabled();

    await page.locator('[data-vid-stage="archived"]').click();
    await expect(page.locator('[data-video]')).toHaveCount(2);
    await page.locator('[data-vid-pick="1"]').check();
    await page.locator('[data-vid-act="bulk-restore"]').click();
    await expect(page.locator('[role="status"]')).toContainText('Restored 1 video.');

    await page.locator('[data-vid-pick="2"]').check();
    await page.locator('[data-vid-act="bulk-delete"]').click();
    const dialog = page.locator('#aura-confirm-modal');
    await expect(dialog).toContainText('stays in My Content');
    await dialog.getByRole('button', { name: 'Delete 1' }).click();
    await expect(page.locator('[role="status"]')).toContainText('Deleted 1 video.');
    await expect(page.locator('[data-video]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
});
