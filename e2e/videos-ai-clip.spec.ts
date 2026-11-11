// An AI clip on its own (owner, 2026-11-11; src/lib/ai-clip.ts): New AI clip → save (free) → see the first
// frame (1 task) → Make the clip. Every function stubbed.

import { test, expect } from './fixtures';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-videos"><div id="videos-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script><script src="/src/components/tab-head.js"></script>
  <script src="/src/components/assistant-videos.js"></script>
  <script>AssistantVideos.init({ assistantId: 6, assistantName: 'Cleo', setup: {} }); setTimeout(() => AssistantVideos.activate(), 50);</script>
</body></html>`;

test('save a clip, see its first frame, then make it', async ({ page, api, pageErrors }) => {
    const projects: Array<Record<string, unknown>> = [];
    const posts: Array<Record<string, unknown>> = [];
    api.set('video-projects', (route, body) => {
        if (route.request().method() === 'GET') return { projects, brand: { accent: '#FFD400', font: 'Impact' } };
        const b = body as Record<string, unknown>;
        posts.push(b);
        if (b.action === 'clip_create') {
            projects.unshift({ id: 50, aiAssistantId: 6, title: 'AI clip — Steam', status: 'planned', origin: 'user', estimate: 20, unit: 'task', sceneThumbs: {}, clipFrameUrl: null,
                brief: { shape: '9:16', voiceover: false, clip: { style: b.style, lengthS: b.lengthS, description: b.description } },
                storyboard: { title: 'AI clip — Steam', caption: '', scenes: [{ id: 's1', beat: 'value', voiceover: '', source: 'ai_video', targetS: 4.7 }] } });
            return { project: projects[0] };
        }
        if (b.action === 'clip_frame') { projects[0].clipFrameUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; return { project: projects[0] }; }
        return { project: projects[0] };
    });
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');

    await page.locator('[data-vid-act="clip-new"]').click();
    const form = page.locator('[data-vid-clip-form]');
    await form.locator('textarea[name="description"]').fill('Steam rising from a cup of coffee on a sunny café table');
    await form.locator('select[name="style"]').selectOption('cinematic');
    await form.getByRole('button', { name: 'Save the clip — free' }).click();
    await expect.poll(() => posts.find((p) => p.action === 'clip_create')).toMatchObject({ assistantId: 6, style: 'cinematic', lengthS: 5, shape: '9:16' });

    const card = page.locator('[data-video="50"]');
    await expect(card).toContainText('Cinematic · 5 seconds · no sound · AI clip');
    await expect(card.locator('[data-vid-act="build"]')).toHaveCount(0);
    await card.getByRole('button', { name: 'See the first frame — 1 task' }).click();
    await expect.poll(() => posts.some((p) => p.action === 'clip_frame')).toBe(true);
    await expect(card.getByRole('button', { name: 'Make the clip — uses 20 tasks' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Try another frame — 1 task' })).toBeVisible();
    expect(pageErrors).toEqual([]);
});
