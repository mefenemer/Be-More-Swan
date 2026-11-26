// Issue #95 (2026-11-26): "Text box outline colour won't change in post editor" — reported from an Android
// phone. Tapping a text box on the picture only selected it (a pink dashed outline, nothing else); the
// outline control sat behind a small grey "Aa" on a row a scroll away, and the Social chat said it could
// only change a box's words. The real workspace; every function is stubbed.

import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PICTURE = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#8a9a8f"/></svg>',
)}`;

function stubPost(api: ApiStub) {
    const store = { overlaySaves: [] as { overlays: Record<string, unknown>[] }[] };
    const slot = new Date(Date.now() + 2 * 86400_000).toISOString();
    const drafts = () => [{
        id: 601, assistantId: 7, assistantName: 'Felix', platform: 'instagram', status: 'scheduled', crosspostGroupId: null,
        thumbnailUrl: PICTURE, caption: 'Keep walking.', publishDate: slot, generatedAt: slot,
        overlays: [{ id: 'ov1', text: 'Keep going', x: 0.5, y: 0.3, fontSizePct: 0.07, color: '#ffffff', boxStroke: null, boxFill: '#000000', boxOpacity: 0.5 }],
    }];
    api.set('get-assistants', { assistants: [{ id: 7, name: 'Felix', role: 'Social Media Assistant', roleKey: 'social_media_manager', isActive: true, status: 'active' }] });
    api.set('check-capacity', { connectedPlatforms: ['instagram'] });
    api.set('get-social-drafts', (route) => (
        new URL(route.request().url()).searchParams.get('status') === 'scheduled'
            ? { drafts: drafts(), total: 1, hasMore: false }
            : { drafts: [], total: 0, hasMore: false }
    ));
    api.set('scheduled-posts', { post: {} });
    api.set('save-post-overlays', (_route, body) => { store.overlaySaves.push(body as { overlays: Record<string, unknown>[] }); return { ok: true }; });
    return store;
}

async function openPost(page: Page) {
    await openWorkspace(page, 'review-queue');
    await page.waitForFunction(() => typeof (window as any).openPostReview === 'function');
    await page.evaluate(async () => {
        const w = window as any;
        const res = await fetch('/.netlify/functions/get-social-drafts?status=scheduled');
        w.rqGroupSocialDrafts((await res.json()).drafts);
        await w.openPostReview(601);
    });
    await expect(page.locator('#post-review-body [data-media-img]')).toBeVisible();
}

const box = (page: Page) => page.locator('#post-review-body [data-overlay-layer] .ioe-ov', { hasText: 'Keep going' });

test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

    test('tap a text box on the picture → "Aa Style" → set its outline to black → it shows and saves', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        const store = stubPost(api);
        await openPost(page);
        await box(page).click();
        const door = page.locator('#post-review-body [data-pce-canvas-style]');
        await expect(door).toBeVisible();
        await door.click();
        const panel = page.locator('#pce-text-style');
        await expect(panel).toBeVisible();
        await panel.getByRole('button', { name: 'Font, colour, outline and background' }).click();
        await panel.locator('input[type="color"][data-f="boxStroke"]').fill('#000000');
        await expect(box(page)).toHaveCSS('border-top-color', 'rgb(0, 0, 0)');
        await expect.poll(() => store.overlaySaves.length).toBeGreaterThan(0);
        expect(store.overlaySaves.at(-1)!.overlays[0].boxStroke).toBe('#000000');
        await expect(panel.locator('input[data-f="boxStroke"]')).toHaveCSS('opacity', '1');   // the swatch stops looking switched off
        await page.screenshot({ path: 'test-results/repro-issue-95-phone.png' });
        expect(pageErrors).toEqual([]);
    });
});

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the chat\'s card makes the outline black, words untouched', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        const store = stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Here it is.', uiElement: {
            type: 'post_text_edit', postId: 601, find: 'Keep going', style: { boxStroke: '#000000' }, summary: 'A black outline on the box.',
        } } });
        await openPost(page);
        const input = page.locator('#pce-chat-host [data-chat-input]');
        await input.fill('Change the outline on the text box to black');
        await input.press('Enter');
        await expect(page.getByText('Change to how the text box looks')).toBeVisible();
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.getByText('Done — the text box is changed.')).toBeVisible();
        await expect(box(page)).toHaveCSS('border-top-color', 'rgb(0, 0, 0)');
        const saved = store.overlaySaves.at(-1)!.overlays[0];
        expect(saved.boxStroke).toBe('#000000');
        expect(saved.text).toBe('Keep going');
        expect(pageErrors).toEqual([]);
    });
});
