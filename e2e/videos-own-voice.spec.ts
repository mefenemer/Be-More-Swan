// The owner's own voice on the Videos tab (owner, 2026-11-10; docs/video-producer-manual-controls-plan.md Phase 3):
// record or upload each line, "Make the video" waits for them, and "Record a video" sits in the footage form.
// Every function stubbed; the upload goes through the real WAV conversion in the browser.

import { test, expect } from './fixtures';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-videos"><div id="videos-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script><script src="/src/components/tab-head.js"></script>
  <script src="/src/components/audio-recorder.js"></script><script src="/src/components/video-recorder.js"></script>
  <script src="/src/components/footage-reader.js"></script><script src="/src/components/assistant-videos.js"></script>
  <script>AssistantVideos.init({ assistantId: 6, assistantName: 'Cleo', setup: {} }); setTimeout(() => AssistantVideos.activate(), 50);</script>
</body></html>`;

/** A second of quiet, as a real WAV the browser can decode. */
function wav(seconds = 1, rate = 8000): Buffer {
    const n = seconds * rate, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    return b;
}

test('record line by line: upload a line, Make the video waits until all are done', async ({ page, api, pageErrors }) => {
    const scene = (n: number, o: Record<string, unknown> = {}) => ({ id: `s${n}`, beat: 'value', targetS: 4, source: 'stock_video', voiceover: `Line ${n} of the script.`, keywords: 'coffee', ...o });
    const project: Record<string, unknown> = {
        id: 21, aiAssistantId: 6, title: 'Summer roast', status: 'planned', origin: 'user', estimate: 0, unit: 'task', sceneThumbs: {},
        brief: { lengthS: 15, shape: '9:16', voiceover: true, ownVoice: true }, voiceoverAssetId: null, voiceUrls: {},
        storyboard: { title: 'Summer roast', caption: 'x', scriptApprovedAt: '2026-11-10T10:00:00Z', scenes: [scene(1, { voiceAssetId: 40, voiceS: 2.1 }), scene(2), scene(3)] },
    };
    const posts: Array<Record<string, unknown>> = [];
    api.set('video-projects', (route, body) => {
        if (route.request().method() === 'GET') return { projects: [project], brand: { accent: '#FFD400', font: 'Impact' } };
        const b = body as Record<string, unknown>;
        posts.push(b);
        if (b.action === 'set_line_voice') {
            const sb = project.storyboard as { scenes: Array<Record<string, unknown>> };
            const s = sb.scenes.find((x) => x.id === b.sceneId)!;
            s.voiceAssetId = b.assetId; s.voiceS = 1;
            return { project, differs: true };
        }
        return { project };
    });
    api.set('content-upload-url', () => ({ mock: true, storageKey: 'k/voice.wav', storageUrl: 'https://example.invalid/voice.wav' }));
    api.set('content-assets', () => ({ asset: { id: 77, name: 'voice.wav' } }));
    await page.addInitScript(() => localStorage.setItem('bms-video-open:6', '[21]'));
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');

    const panel = page.locator('[data-vid-record="21"]');
    await expect(panel).toContainText('2 lines to record');
    await expect(panel).toContainText('✓ recorded, 2.1s');
    await expect(page.locator('[data-vid-act="build"]')).toHaveCount(0);
    await expect(page.locator('[data-video="21"]')).toContainText('Record every line above, then “Make the video”.');
    await expect(page.locator('[data-video="21"]')).toContainText('Voice: your own.');

    // Upload scene 2's line: converted to WAV in the browser, uploaded as audio, attached to the line.
    await panel.locator('[data-vid-act="voice-upload"][data-scene="s2"]').click();
    await page.locator('[data-vid-voice-file]').setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: wav() });
    await expect.poll(() => posts.filter((p) => p.action === 'set_line_voice').length).toBe(1);
    expect(posts.find((p) => p.action === 'set_line_voice')).toEqual({ action: 'set_line_voice', id: 21, sceneId: 's2', assetId: 77 });
    const asset = api.called('content-assets')[0].body as Record<string, unknown>;
    expect(asset).toMatchObject({ assetType: 'audio', mimeType: 'audio/wav' });
    await expect(page.locator('[data-vid-record="21"]')).toContainText('1 line to record');
    await expect(page.locator('[data-vid-record="21"]')).toContainText('says something different from this line');
    expect(pageErrors).toEqual([]);
});

test('"Record a video" is in the footage form', async ({ page, api, pageErrors }) => {
    api.set('video-projects', () => ({ projects: [] }));
    api.set('footage', () => ({ videos: [] }));
    await page.route('**/e2e-videos.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-videos.html');
    await page.locator('[data-vid-act="footage"]').click();
    await expect(page.locator('[data-vid-act="record-video"]')).toBeVisible();
    expect(await page.evaluate(() => typeof (window as unknown as { VideoRecorder?: { open: unknown } }).VideoRecorder?.open)).toBe('function');
    expect(pageErrors).toEqual([]);
});
