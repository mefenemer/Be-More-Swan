// Text on a Video Producer scene (owner, 2026-11-10; docs/video-producer-manual-controls-plan.md Phase 2):
// the Change form's "Text on the video" group, its preview, and what is saved. Every function stubbed.

import { test, expect } from './fixtures';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-videos"><div id="videos-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script><script src="/src/components/tab-head.js"></script>
  <script src="/src/components/assistant-videos.js"></script>
  <script>AssistantVideos.init({ assistantId: 6, assistantName: 'Cleo', setup: {} }); setTimeout(() => AssistantVideos.activate(), 50);</script>
</body></html>`;

const scene = (n: number, o: Record<string, unknown> = {}) => ({ id: `s${n}`, beat: n === 1 ? 'hook' : 'value', targetS: 5, source: n === 2 ? 'stock_photo' : 'stock_video', voiceover: `Line ${n}.`, onScreenText: n === 1 ? 'Fresh roast' : '', keywords: 'coffee', ...o });

test('choose where, when and how the words look; only the changes are saved', async ({ page, api, pageErrors }) => {
    const edits: Array<Record<string, unknown>> = [];
    const project = { id: 21, aiAssistantId: 6, title: 'Summer roast', status: 'planned', origin: 'user', brief: { lengthS: 30, shape: '9:16' }, estimate: 1, unit: 'task', sceneThumbs: {},
        storyboard: { title: 'Summer roast', caption: 'x', scenes: [scene(1), scene(2), scene(3)] } };
    api.set('video-projects', (route, body) => {
        if (route.request().method() === 'GET') return { projects: [project], brand: { accent: '#FFD400', font: 'Impact' } };
        const b = body as Record<string, unknown>;
        if (b.action === 'edit_scene') edits.push(b.patch as Record<string, unknown>);
        return { project };
    });
    await page.addInitScript(() => localStorage.setItem('bms-video-open:6', '[21]'));
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');

    // Moving or still, said on each scene.
    await expect(page.locator('[data-vid-scene-row="s1"]')).toContainText('▶ Moving');
    await expect(page.locator('[data-vid-scene-row="s2"]')).toContainText('Still');

    await page.locator('[data-vid-act="edit-scene"][data-scene="s1"]').click();
    const form = page.locator('[data-vid-scene-form]');
    const preview = form.locator('[data-vid-text-preview] span').last();
    await expect(preview).toHaveText('Fresh roast');
    await expect(preview).toHaveAttribute('style', /top:20%/);

    // Bottom is where the captions are: the form says so.
    await form.locator('select[name="textPos"]').selectOption('bottom');
    await expect(form.locator('[data-vid-text-clash]')).toBeVisible();
    await form.locator('select[name="textPos"]').selectOption('middle');
    await expect(form.locator('[data-vid-text-clash]')).toBeHidden();
    await form.locator('select[name="textStyle"]').selectOption('brand');
    await expect(form.locator('[data-vid-text-preview] span').last()).toHaveAttribute('style', /top:50%.*background:#FFD400/);
    await form.locator('input[name="onScreenText"]').fill('Back for July');
    await expect(form.locator('[data-vid-text-preview] span').last()).toHaveText('Back for July');

    await form.getByRole('button', { name: 'Save scene' }).click();
    await expect.poll(() => edits.length).toBe(1);
    expect(edits[0]).toMatchObject({ onScreenText: 'Back for July', textPos: 'middle', textStyle: 'brand' });
    expect(edits[0]).not.toHaveProperty('textWhen');
    expect(edits[0]).not.toHaveProperty('textAnim');
    expect(pageErrors).toEqual([]);
});
