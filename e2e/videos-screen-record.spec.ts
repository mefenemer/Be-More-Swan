// "Record my screen" on the Videos tab (docs/video-producer-screen-walkthrough-plan.md Phase 3). The browser's
// share picker can't be driven from a test, so getDisplayMedia hands back a canvas stream: everything after it
// (MediaRecorder, watch back, upload, the footage reader, the screen list) is the real code. Functions stubbed.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <button class="main-tab-btn" data-maintab="videos" type="button">Videos</button>
  <div class="page-wide p-4"><div id="maintab-videos"><div id="videos-host"></div></div></div>
  <div id="chat-cards"></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script><script src="/src/components/tab-head.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script>
  <script src="/src/components/presenter-picker.js"></script><script src="/src/components/footage-reader.js"></script>
  <script src="/src/components/video-recorder.js"></script><script src="/src/components/screen-recorder.js"></script>
  <script src="/src/components/assistant-videos.js"></script>
  <script>AssistantVideos.init({ assistantId: 6, assistantName: 'Cleo', setup: {} }); setTimeout(() => AssistantVideos.activate(), 50);</script>
</body></html>`;

/** A moving canvas in place of the shared screen. */
async function fakeScreen(page: Page) {
    await page.addInitScript(() => {
        const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia: unknown };
        (window as unknown as { __shared: number }).__shared = 0;
        md.getDisplayMedia = async () => {
            (window as unknown as { __shared: number }).__shared++;
            const c = document.createElement('canvas');
            c.width = 640; c.height = 360;
            const g = c.getContext('2d')!;
            let n = 0;
            setInterval(() => { g.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(`Dashboard ${n}`, 40, 180); }, 33);
            return c.captureStream(30);
        };
    });
}

/** Stubs: the footage list grows once a recording is read. */
function stubApi(api: ApiStub) {
    const store = { videos: [] as Array<Record<string, unknown>>, prepared: [] as Array<Record<string, unknown>> };
    api.set('video-projects', () => ({ projects: [], aiPresenter: true }));
    api.set('content-upload-url', () => ({ mock: true, storageKey: 'k/screen.webm', storageUrl: 'https://example.invalid/screen.webm' }));
    api.set('content-assets', (_r, body) => ({ asset: { id: 501, name: (body as { name: string }).name } }));
    api.set('footage', (route, body) => {
        if (route.request().method() === 'GET') return { videos: store.videos, status: [] };
        const b = body as Record<string, unknown>;
        if (b.action === 'prepare') {
            store.prepared.push(b);
            store.videos.unshift({ id: 501, name: 'Booking a class.webm', durationS: b.durationS, url: null, needsReading: false });
        }
        return { ok: true };
    });
    return store;
}

async function record(page: Page, name: string) {
    const dlg = page.locator('[data-screen-recorder]');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Only share the window or tab you need.');
    await expect(dlg.locator('[data-sound]')).not.toBeChecked();   // D-W6
    await dlg.locator('[data-name]').fill(name);
    await dlg.locator('[data-start]').click();
    await expect(dlg.locator('[data-status]')).toHaveText('Recording');
    await page.waitForTimeout(1600);
    await dlg.locator('[data-stop]').click();
    await expect(dlg.locator('[data-use]')).toBeVisible();
    await dlg.locator('[data-use]').click();
    await expect(dlg).toHaveCount(0);
}

test('a screen recorded for the AI presenter is uploaded, read once and ticked under Screen recordings', async ({ page, api, pageErrors }) => {
    await fakeScreen(page);
    const store = stubApi(api);
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');
    await page.locator('[data-vid-act="new"]').first().click();
    // Choose a presenter the way the picker does: set its field and say so.
    await page.evaluate(() => {
        const i = document.querySelector('[data-vid-form] input[name="presenterId"]') as HTMLInputElement;
        i.value = 'priya'; i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('[data-vid-screens-list]')).toContainText('No videos of your own yet');
    const btn = page.locator('[data-vid-act="record-screen-presenter"]');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('[data-screen-recorder] [data-mic]')).not.toBeChecked();   // the presenter does the talking
    await record(page, 'Booking a class');

    await expect.poll(() => store.prepared.length, { timeout: 20000 }).toBe(1);
    const asset = api.called('content-assets')[0].body as Record<string, unknown>;
    expect(asset).toMatchObject({ assetType: 'video', name: expect.stringMatching(/^Booking a class\.(webm|mp4)$/) });
    expect(Number(asset.durationS)).toBeGreaterThan(1);
    const prep = store.prepared[0] as { assetId: number; durationS: number; frames: unknown[]; audioKey: unknown };
    expect(prep.assetId).toBe(501);
    expect(prep.frames.length).toBeGreaterThan(0);
    expect(prep.audioKey).toBeNull();   // no sound recorded
    await expect(page.locator('[data-vid-screens-note]')).toContainText('to My Content and ticked below');
    await expect(page.locator('[data-vid-screens-list] input[name="screenIds"][value="501"]')).toBeChecked();
    // A ticked screen with a presenter opens the long lengths.
    await expect(page.locator('[data-vid-new-length] option[value="300"]')).toBeEnabled();
    expect(pageErrors).toEqual([]);
});

test('"Record my screen" in the footage form records the voice too and adds the video', async ({ page, api, pageErrors }) => {
    await fakeScreen(page);
    stubApi(api);
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');
    await page.locator('[data-vid-act="footage"]').first().click();
    await expect(page.locator('[data-vid-footage-form]')).toContainText('Videos up to 10 minutes');
    await page.locator('[data-vid-act="record-screen"]').click();
    const mic = page.locator('[data-screen-recorder] [data-mic]');
    await expect(mic).toBeChecked();
    await mic.uncheck();   // the test browser has no microphone
    await record(page, 'Walkthrough');
    await expect(page.locator('[data-vid-footage-pick="501"]')).toBeChecked();
    expect(pageErrors).toEqual([]);
});

test('the chat card opens the recorder on the Videos tab', async ({ page, api, pageErrors }) => {
    await fakeScreen(page);
    stubApi(api);
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');
    await page.evaluate(() => {
        const el = (window as unknown as { DisruptiveUIRegistry: { render(u: unknown): HTMLElement } }).DisruptiveUIRegistry.render({ type: 'screen_recording_proposal', purpose: 'presenter' });
        document.getElementById('chat-cards')!.appendChild(el);
    });
    await expect(page.locator('#chat-cards')).toContainText('Record your screen');
    await page.locator('[data-srp-go]').click();
    await expect(page.locator('[data-screen-recorder]')).toBeVisible();
    await expect(page.locator('[data-vid-form]')).toBeVisible();   // the New video form, where the screen is ticked
    await expect(page.locator('[data-srp-status]')).toContainText('The recorder is open on the Videos tab.');
    expect(await page.evaluate(() => (window as unknown as { __shared: number }).__shared)).toBe(0);   // nothing shared until they choose
    expect(pageErrors).toEqual([]);
});

test('on a tablet the reason shows instead of the button', async ({ page, api, pageErrors }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148' });
    });
    stubApi(api);
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');
    await page.locator('[data-vid-act="footage"]').first().click();
    await expect(page.locator('[data-vid-act="record-screen"]')).toHaveCount(0);
    await expect(page.locator('[data-vid-footage-form]')).toContainText('On a phone or tablet, use its own screen recorder');
    expect(pageErrors).toEqual([]);
});
