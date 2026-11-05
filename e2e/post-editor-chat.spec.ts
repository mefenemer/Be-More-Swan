// The social post editor's docked chat (owner, 2026-11-05: the Website tab's chat pane, for the Social
// Media assistant): the post on the left, the chat on the right, "Select" putting the caption, the picture
// or a text box into the chat, and cards that change it. The real workspace; every function is stubbed.

import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PICTURE = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#8a9a8f"/></svg>',
)}`;
const CAPTION = 'Holding the whole business in your head is exhausting.';
const FACEBOOK_ID = 602;

function stubPost(api: ApiStub, opts: { status?: string; roleKey?: string; caption?: string } = {}) {
    const slot = new Date(Date.now() + 2 * 86400_000).toISOString();
    const store = { caption: opts.caption ?? CAPTION, overlaySaves: [] as unknown[], patches: [] as { id: string | null; body: { caption?: string } }[] };
    const drafts = () => ['instagram', 'facebook'].map((platform, i) => ({
        id: 601 + i, assistantId: 7, assistantName: 'Felix', platform, status: opts.status ?? 'pending_approval', crosspostGroupId: 'g1',
        thumbnailUrl: PICTURE, caption: store.caption, publishDate: slot, generatedAt: slot,
        overlays: [{ id: 'ov1', text: 'Summer sale', x: 0.5, y: 0.2, size: 0.06, color: '#ffffff' }],
    }));
    api.set('get-assistants', { assistants: [{ id: 7, name: 'Felix', role: 'Social Media Assistant', roleKey: opts.roleKey ?? 'social_media_manager', isActive: true, status: 'active' }] });
    api.set('check-capacity', { connectedPlatforms: ['instagram', 'facebook'] });
    api.set('get-social-drafts', (route) => (
        new URL(route.request().url()).searchParams.get('status') === (opts.status ?? 'pending_approval')
            ? { drafts: drafts(), total: 2, hasMore: false }
            : { drafts: [], total: 0, hasMore: false }
    ));
    api.set('scheduled-posts', (route, body) => {
        const b = (body || {}) as { caption?: string };
        store.patches.push({ id: new URL(route.request().url()).searchParams.get('id'), body: b });
        if (typeof b.caption === 'string') store.caption = b.caption;
        return { post: { caption: store.caption } };
    });
    api.set('save-post-overlays', (_route, body) => { store.overlaySaves.push(body); return { ok: true }; });
    return store;
}

async function openPost(page: Page, status = 'pending_approval') {
    await openWorkspace(page, 'review-queue');
    await page.waitForFunction(() => typeof (window as any).openPostReview === 'function');
    await page.evaluate(async (s) => {
        const w = window as any;
        const res = await fetch(`/.netlify/functions/get-social-drafts?status=${s}`);
        w.rqGroupSocialDrafts((await res.json()).drafts);
        await w.openPostReview(601);
    }, status);
    await expect(page.locator('#post-review-body [data-media-img]')).toBeVisible();
}

const chat = (page: Page) => page.locator('#pce-chat-host');
const input = (page: Page) => page.locator('#pce-chat-host [data-chat-input]');
const sent = (api: ApiStub, i = 0) => api.called('chat-orchestrator')[i].body as { message: string; forPostId?: number };
async function ask(page: Page, text: string) {
    await input(page).fill(text);
    await input(page).press('Enter');
}

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the post on the left, the chat docked on the right; the button hides it', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        await openPost(page);
        await expect(input(page)).toBeVisible();
        const card = await page.locator('#post-review-body [data-mockup-card]').boundingBox();
        const box = await input(page).boundingBox();
        expect(card!.x + card!.width).toBeLessThanOrEqual(box!.x);
        await expect(page.locator('#pce-chat-toggle')).toContainText('Chat with Felix');
        await page.screenshot({ path: 'test-results/post-editor-chat.png' });
        await page.locator('#pce-chat-toggle').click();
        await expect(input(page)).toBeHidden();
        await page.locator('#pce-chat-toggle').click();
        await expect(input(page)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('every turn says which post it is about, so a draft is offered rather than saved as a new post', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        const store = stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Try this.', uiElement: {
            type: 'social_post_draft', caption: 'You don’t have to carry it all.', hashtags: '', platforms: ['instagram'], forPostId: 601,
        } } });
        await openPost(page);
        await ask(page, 'Make it punchier');
        await page.getByRole('button', { name: 'Yes, add it to my draft' }).click();
        await expect(page.getByText('✓ Added to your draft')).toBeVisible();
        expect(sent(api).forPostId).toBe(601);
        expect(store.caption).toBe('You don’t have to carry it all.');
        await expect(page.getByRole('button', { name: 'Back to the post' })).toHaveCount(0);   // it's right there
        expect(pageErrors).toEqual([]);
    });

    test('the target survives the pop-up chat opening and closing over the editor', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openPost(page);
        await page.evaluate(() => { const w = window as any; w.openAssistantChatModal(7, 'Felix', 'Social', 'social_media_manager'); w.closeAssistantChatModal(); });
        await ask(page, 'Anything else?');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).forPostId).toBe(601);
        expect(pageErrors).toEqual([]);
    });

    test('Select the caption: the whole of it reaches the assistant, and the caption does not open for typing', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openPost(page);
        await page.locator('#pce-select').click();
        await page.locator('#post-review-body [data-caption-host]').click();
        await expect(page.locator('#pce-select')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('#pce-inline-caption')).toHaveCount(0);
        await ask(page, 'Shorter');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain(`About this part of my post #601: the caption “${CAPTION}”.`);
        expect(sent(api).message).toContain('Shorter');
        expect(pageErrors).toEqual([]);
    });

    test('Select a text box: it does not drag, and "Use this" changes and saves only that box', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        const store = stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'How about this?', uiElement: {
            type: 'post_text_edit', postId: 601, find: 'Summer sale', replace: 'Big summer sale', summary: 'Adds a word.',
        } } });
        await openPost(page);
        const box = page.locator('#post-review-body [data-overlay-layer] > *', { hasText: 'Summer sale' });
        await expect(box).toBeVisible();
        await page.locator('#pce-select').click();
        await box.click();
        await ask(page, 'Make it bolder');
        await expect(page.getByRole('button', { name: 'Use this' })).toBeVisible();
        expect(sent(api).message).toContain('the text box “Summer sale”');
        expect(store.overlaySaves).toHaveLength(0);     // the click selected; it did not move anything
        await page.screenshot({ path: 'test-results/post-editor-chat-card.png' });
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.getByText('Done — the text box is changed.')).toBeVisible();
        await expect(page.locator('#post-review-body [data-overlay-layer]')).toContainText('Big summer sale');
        const saved = store.overlaySaves[0] as { overlays: { text: string }[] };
        expect(saved.overlays[0].text).toBe('Big summer sale');
        expect(pageErrors).toEqual([]);
    });

    test('text boxes show when the picture is already in the browser cache (the list behind has just shown it)', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        await openPost(page);
        await expect(page.locator('#post-review-body [data-overlay-layer] > *', { hasText: 'Summer sale' })).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('a text box changed since the card was written: nothing happens', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        const store = stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Here.', uiElement: {
            type: 'post_text_edit', postId: 601, find: 'Winter sale', replace: 'Big sale', summary: 'A change.',
        } } });
        await openPost(page);
        await ask(page, 'Change it');
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.getByText('changed since', { exact: false })).toBeVisible();
        expect(store.overlaySaves).toHaveLength(0);
        expect(pageErrors).toEqual([]);
    });

    test('Select the picture → a card → "Find stock photos" searches in the post\'s own picture window', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: {
            type: 'post_picture', postId: 601, kind: 'image', description: 'A busy café counter',
        } } });
        api.set('pexels-search', { candidates: [] });
        await openPost(page);
        await page.locator('#pce-select').click();
        await page.locator('#post-review-body [data-media-host]').click();
        await ask(page, 'Swap this');
        await page.getByRole('button', { name: 'Find stock photos' }).click();
        await expect(page.locator('#gp-ai-find-query')).toHaveValue('A busy café counter');
        await expect(page.locator('#gp-ai-find-box')).toBeVisible();
        expect(sent(api).message).toContain('the picture.');
        await page.screenshot({ path: 'test-results/post-editor-chat-picture.png' });
        expect(pageErrors).toEqual([]);
    });

    test('a shorter card beside the open post: the editor shows the new caption, and can\'t save the old one back', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        const store = stubPost(api);
        const SHORT = 'It’s exhausting.';
        api.set('rewrite-post-text', { caption: SHORT });
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: {
            type: 'post_action_proposal', action: 'shorter', postId: 601, postIds: [601, FACEBOOK_ID], platforms: ['instagram', 'facebook'], status: 'pending_approval', text: CAPTION,
        } } });
        await openPost(page);
        await ask(page, 'Shorter');
        await page.locator('#pce-chat-host [data-action-go], #pce-chat-host button').filter({ hasText: /shorter/i }).first().click();
        await expect(page.locator('#post-review-body [data-caption-host]')).toContainText(SHORT);
        await expect(page.locator('#post-review-caption')).toHaveValue(SHORT, { timeout: 5000 });
        expect(store.caption).toBe(SHORT);
        expect(pageErrors).toEqual([]);
    });

    test('a remove card closes the editor and says so, because the chat closes with it', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        api.set('scheduled-posts', { cancelledIds: [601, FACEBOOK_ID] });
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: {
            type: 'post_action_proposal', action: 'remove', postId: 601, postIds: [601, FACEBOOK_ID], platforms: ['instagram', 'facebook'], status: 'pending_approval', text: CAPTION,
        } } });
        await openPost(page);
        await ask(page, 'Remove it');
        await page.locator('#pce-chat-host button').filter({ hasText: /^Remove/ }).first().click();
        await expect(page.locator('#post-review-modal')).toBeHidden();
        await expect(chat(page)).toBeEmpty();
        expect(await page.evaluate(() => (window as any).ChatDockedDraftTarget)).toBeNull();
        expect(pageErrors).toEqual([]);
    });

    test('a post that has gone out: the chat is there, but nothing to select', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api, { status: 'published' });
        await openPost(page, 'published');
        await expect(input(page)).toBeVisible();
        await expect(page.locator('#pce-select')).toBeHidden();
        expect(await page.evaluate(() => (window as any).ChatDockedDraftTarget)).toBeNull();
        expect(pageErrors).toEqual([]);
    });

    test('another assistant\'s post keeps the editor as it was: no pane', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api, { roleKey: 'campaign_orchestrator' });
        await openPost(page);
        await expect(page.locator('#pce-chat-toggle')).toBeHidden();
        await expect(page.locator('#pce-chat-col')).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('narrower screens', () => {
    test.use({ viewport: { width: 1100, height: 850 } });

    test('off by default; opens over the right edge without the page scrolling sideways', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        await openPost(page);
        await expect(input(page)).toBeHidden();
        await page.locator('#pce-chat-toggle').click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(1100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/post-editor-chat-narrow.png' });
        expect(pageErrors).toEqual([]);
    });
});

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 800 } });

    test('the chat fills the width and the header still fits', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        await openPost(page);
        await page.locator('#pce-chat-toggle').click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/post-editor-chat-phone.png' });
        expect(pageErrors).toEqual([]);
    });

    test('Select: the chat steps aside so the post can be clicked, then comes back with the part in it', async ({ page, api, signedIn: _signedIn, pageErrors }) => {
        stubPost(api);
        await openPost(page);
        await page.locator('#pce-chat-toggle').click();
        await expect(input(page)).toBeVisible();
        await page.locator('#pce-select').click();
        await expect(input(page)).toBeHidden();
        await page.locator('#post-review-body [data-caption-host]').click();
        await expect(input(page)).toBeVisible();
        await expect(page.locator('#pce-chat-host').getByText('Caption “', { exact: false })).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
