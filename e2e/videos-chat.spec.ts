// The Video Producer's docked chat (owner, 2026-11-05: the Website tab's chat pane, on the Videos tab). The
// tab's real modules on a bare page, with every function stubbed.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-videos"><div id="videos-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/tab-head.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/components/assistant-videos.js"></script>
  <script>AssistantVideos.init({ assistantId: 6, assistantName: 'Cleo', setup: {} }); setTimeout(() => AssistantVideos.activate(), 50);</script>
</body></html>`;

const scene = (n: number) => ({ id: `s${n}`, beat: n === 1 ? 'hook' : 'value', targetS: 5, source: 'stock_video', voiceover: `Line ${n} of the script.`, onScreenText: n === 1 ? 'Fresh roast' : '', keywords: 'coffee' });

function stubVideos(api: ApiStub, status = 'planned') {
    const store = {
        edits: [] as Record<string, unknown>[],
        builds: 0,
        project: { id: 21, aiAssistantId: 6, title: 'Summer roast', status, origin: 'user', brief: { lengthS: 30 }, estimate: 1, unit: 'task', sceneThumbs: {}, storyboard: { title: 'Summer roast', caption: 'x', scenes: [scene(1), scene(2), scene(3)] } } as Record<string, unknown>,
    };
    api.set('video-projects', (route, body) => {
        if (route.request().method() === 'GET') return { projects: [store.project] };
        const b = (body || {}) as Record<string, unknown>;
        if (b.action === 'edit_scene') { store.edits.push(b); return { project: store.project }; }
        if (b.action === 'build') store.builds++;
        return { ok: true };
    });
    return store;
}

async function openTab(page: Page) {
    // Videos start closed (owner, 2026-11-06); these tests are about what is inside one.
    await page.addInitScript(() => localStorage.setItem('bms-video-open:6', '[21]'));
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');
    await expect(page.locator('[data-video="21"]')).toBeVisible();
}

const input = (page: Page) => page.locator('#videos-chat-host [data-chat-input]');
const selectScene = (page: Page, i: number) => page.locator(`[data-vid-act="select-scene"][data-index="${i}"]`);
const sent = (api: ApiStub, i = 0) => api.called('chat-orchestrator')[i].body as { message: string };
async function ask(page: Page, text: string) { await input(page).fill(text); await input(page).press('Enter'); }
const CARD = {
    type: 'video_scene_edit', projectId: 21, scene: 1, sceneId: 's1', summary: 'A punchier opening.',
    patch: { voiceover: 'Our summer roast is back.' }, now: { voiceover: 'Line 1 of the script.', onScreenText: 'Fresh roast' },
};

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the videos on the left, the chat docked on the right, with no button for it', async ({ page, api, pageErrors }) => {
        stubVideos(api);
        await openTab(page);
        await expect(input(page)).toBeVisible();
        const card = await page.locator('[data-video="21"]').boundingBox();
        const box = await input(page).boundingBox();
        expect(card!.x + card!.width).toBeLessThanOrEqual(box!.x);
        await expect(page.locator('[data-vid-act="chat-toggle"]')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('Select a scene → the card changes it → it saves, and nothing is made', async ({ page, api, pageErrors }) => {
        const store = stubVideos(api);
        api.set('chat-orchestrator', { chatSessionId: 8, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: CARD } });
        await openTab(page);
        await selectScene(page, 0).click();
        await ask(page, 'Punchier');
        const go = page.getByRole('button', { name: 'Change the scene' });
        await expect(go).toBeVisible();
        expect(sent(api).message).toContain('About this scene of my video 21 “Summer roast”: scene 1 (Hook), voiceover “Line 1 of the script.”, on screen “Fresh roast”');
        await page.screenshot({ path: 'test-results/videos-chat-card.png' });
        await go.click();
        await expect(page.getByText('The scene is changed in your storyboard.')).toBeVisible();
        expect(store.edits[0]).toMatchObject({ action: 'edit_scene', id: 21, sceneId: 's1', patch: { voiceover: 'Our summer roast is back.' } });
        expect(store.builds).toBe(0);
        expect(pageErrors).toEqual([]);
    });

    test('a refused change says why, and can be tried again', async ({ page, api, pageErrors }) => {
        stubVideos(api);
        await page.route('**/.netlify/functions/video-projects', (route) => {
            if (route.request().method() === 'POST') return route.fulfill({ status: 409, json: { error: 'This video can no longer be changed here.' } });
            return route.fallback();
        });
        api.set('chat-orchestrator', { chatSessionId: 8, message: { id: 1, role: 'assistant', content: 'Here.', uiElement: CARD } });
        await openTab(page);
        await ask(page, 'Punchier');
        await page.getByRole('button', { name: 'Change the scene' }).click();
        await expect(page.getByText('This video can no longer be changed here.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Change the scene' })).toBeEnabled();
        expect(pageErrors).toEqual([]);
    });

    test('"🎯 Select" puts the whole video into the chat', async ({ page, api, pageErrors }) => {
        stubVideos(api);
        api.set('chat-orchestrator', { chatSessionId: 8, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await page.locator('[data-vid-act="talk"]').click();
        await ask(page, 'Thoughts?');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain('About my video 21 “Summer roast”.');
        expect(await page.evaluate(() => localStorage.getItem('bms-video-chat:6'))).toBe('8');
        expect(pageErrors).toEqual([]);
    });

    test('a video being made has no scenes to select, but can still be talked about', async ({ page, api, pageErrors }) => {
        stubVideos(api, 'built');
        await openTab(page);
        await expect(selectScene(page, 0)).toHaveCount(0);
        await expect(page.locator('[data-vid-act="talk"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('narrow screens', () => {
    test.use({ viewport: { width: 1100, height: 850 } });

    test('off by default; Select opens it over the right edge; the ✕ closes it', async ({ page, api, pageErrors }) => {
        stubVideos(api);
        await openTab(page);
        await expect(input(page)).toBeHidden();
        await selectScene(page, 1).click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(1100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(input(page)).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 800 } });

    test('Select works, the chat fills the width, and the ✕ gets back to the video', async ({ page, api, pageErrors }) => {
        stubVideos(api);
        await openTab(page);
        await selectScene(page, 0).click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        await page.screenshot({ path: 'test-results/videos-chat-phone.png' });
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(selectScene(page, 0)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
