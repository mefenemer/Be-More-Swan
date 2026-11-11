// The chat panel beside a role's work tabs (owner, 2026-11-06): the Social Media Assistant's Posts, the Blog Writer's
// Blogs, and the Lead Generator's Searches, All leads and Outreach. One conversation across those tabs; its ✕ closes it and the right-hand
// menu's Chat brings it back. On any other tab the panel steps aside and Chat opens the pop-up.

import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

function stubRole(api: ApiStub, roleKey: string) {
    api.set('get-assistant-context', { id: 9, name: 'Mira', role: 'Role', roleKey, status: 'working', lifecycleStatus: 'active', context: {}, goals: [], configuration: {} });
}
async function open(page: Page) {
    await openWorkspace(page);
    await page.evaluate(() => (window as any).loadView('assistant-detail', 9));
    await expect(page.locator('#assistant-detail-content')).toBeVisible();
}
const input = (page: Page) => page.locator('#tabchat-chat-host [data-chat-input]');
const closeBtn = (page: Page) => page.locator('#tabchat-chat-host [data-chatpane-close]');

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 1000 } });

    test('Social Media Assistant: the chat sits beside Posts and steps aside on the Calendar', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'social_media_manager');
        await open(page);
        await expect(page.locator('#maintab-btn-review-queue')).toHaveAttribute('aria-selected', 'true');
        await expect(input(page)).toBeVisible();
        const list = await page.locator('#maintab-review-queue').boundingBox();
        const chat = await page.locator('#tabchat-chat-col').boundingBox();
        expect(list!.x + list!.width).toBeLessThanOrEqual(chat!.x);

        await page.locator('#maintab-btn-calendar').click();
        await expect(page.locator('#maintab-calendar')).toBeVisible();
        await expect(input(page)).toBeHidden();
        await page.locator('#maintab-btn-review-queue').click();
        await expect(input(page)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('✕ closes it, the right-hand menu’s Chat brings it back, and the choice is remembered', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'social_media_manager');
        await open(page);
        await closeBtn(page).click();
        await expect(input(page)).toBeHidden();
        await expect(page.locator('#assistant-chat-modal')).toHaveCount(0);

        await page.locator('#rm-chat').click();
        await expect(input(page)).toBeVisible();
        await expect(page.locator('#assistant-chat-modal')).toHaveCount(0);

        await closeBtn(page).click();
        await page.evaluate(() => (window as any).loadView('assistant-detail', 9));
        await expect(page.locator('#maintab-btn-review-queue')).toHaveAttribute('aria-selected', 'true');
        await expect(input(page)).toBeHidden();
        expect(pageErrors).toEqual([]);
    });

    test('a post asked for here is not tied to any post, and Full screen keeps the chat beside the list', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'social_media_manager');
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'On it.', uiElement: null } });
        await open(page);
        await page.evaluate(() => { (window as any).ChatDraftTarget = { postId: 77 }; });
        await input(page).fill('Draft a post about our opening hours');
        await input(page).press('Enter');
        await expect(page.locator('#tabchat-chat-host').getByText('On it.')).toBeVisible();
        expect((api.called('chat-orchestrator')[0].body as { forPostId?: number }).forPostId).toBeUndefined();
        expect(await page.evaluate(() => localStorage.getItem('bms-tab-chat:9'))).toBe('9');

        await page.locator('#detail-rq-full-btn').click();
        await expect(input(page)).toBeVisible();
        const hit = await input(page).evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + 5, r.y + 5)); });
        expect(hit).toBe(true);
        const box = await page.locator('#detail-rq-full-btn').boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual((await page.locator('#tabchat-chat-col').boundingBox())!.x);
        expect(pageErrors).toEqual([]);
    });

    test('Lead Generator: one conversation across Searches, All leads and Outreach', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'lead_qualifier');
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'You have two hot leads.', uiElement: null } });
        await open(page);
        await expect(page.locator('#maintab-btn-signals')).toHaveAttribute('aria-selected', 'true');
        await expect(input(page)).toBeVisible();
        await input(page).fill('How many hot leads?');
        await input(page).press('Enter');
        const reply = page.locator('#tabchat-chat-host').getByText('You have two hot leads.');
        await expect(reply).toBeVisible();

        for (const tab of ['datahub', 'review-queue', 'signals']) {
            await page.locator(`#maintab-btn-${tab}`).click();
            await expect(page.locator(`#maintab-${tab}`)).toBeVisible();
            await expect(reply).toBeVisible();
        }
        await expect(page.locator('#tabchat-chat-host [data-chat-input]')).toHaveCount(1);
        await page.locator('#maintab-btn-calendar').click();
        await expect(input(page)).toBeHidden();
        expect(pageErrors).toEqual([]);
    });

    test('All leads keeps its description readable beside the chat, on the narrowest screen it docks on', async ({ page, api, signedIn, pageErrors }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        stubRole(api, 'lead_qualifier');
        await open(page);
        await page.locator('#maintab-btn-datahub').click();
        const about = page.locator('#datahub-toolbar p').first();
        await expect(about).toBeVisible();
        expect((await about.boundingBox())!.width).toBeGreaterThan(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        expect(pageErrors).toEqual([]);
    });

    test('a post the chat saves reaches the Posts list beside it', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'social_media_manager');
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Saved it for review.', uiElement: { type: 'social_post_draft', caption: 'Open late on Friday', hubLink: { tab: 'review-queue', postId: 55 } } } });
        await open(page);
        await page.waitForLoadState('networkidle');
        const before = api.called('get-social-drafts').length;
        await input(page).fill('Draft a post about our opening hours');
        await input(page).press('Enter');
        await expect(page.locator('#tabchat-chat-host').getByText('Saved it for review.')).toBeVisible();
        await expect.poll(() => api.called('get-social-drafts').length).toBeGreaterThan(before);
        expect(pageErrors).toEqual([]);
    });

    test('Blog Writer: the chat sits beside Blogs and steps aside on the Calendar', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'blog_writer');
        await open(page);
        await expect(page.locator('#maintab-btn-review-queue')).toHaveAttribute('aria-selected', 'true');
        await expect(input(page)).toBeVisible();
        await expect(input(page)).toHaveAttribute('placeholder', 'Ask for an article or a change…');
        const list = await page.locator('#maintab-review-queue').boundingBox();
        const chat = await page.locator('#tabchat-chat-col').boundingBox();
        expect(list!.x + list!.width).toBeLessThanOrEqual(chat!.x);

        await page.locator('#maintab-btn-calendar').click();
        await expect(input(page)).toBeHidden();
        await page.locator('#maintab-btn-review-queue').click();
        await expect(input(page)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('Blog Writer: an article opened mid-rewrite stays locked and shows the rewrite, with its own chat over the list', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'blog_writer');
        const store = { body: 'The old words.', saves: 0 };
        let finish = false;
        api.set('blog-posts', () => ({ post: { id: 41, assistantId: 9, title: 'Fresh beans', status: 'draft', bodyMarkdown: store.body }, posts: [] }));
        api.set('save-widget-config', { config: { publicKey: 'e2e-key' } });
        api.set('save-blog-draft', (_route, body) => {
            if (typeof (body as { bodyMarkdown?: string }).bodyMarkdown === 'string') store.saves += 1;
            return { ok: true, updatedAt: new Date().toISOString() };
        });
        api.set('generate-blog', (route) => {
            if (route.request().method() === 'POST') return { jobId: 'j1' };
            if (!finish) return { status: 'processing' };
            store.body = 'The worker wrote this.';
            return { status: 'completed' };
        });
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: {
            type: 'blog_action_proposal', action: 'revise', postId: 41, title: 'Fresh beans', status: 'draft', instruction: 'Make it punchier', timezone: 'Europe/London',
        } } });
        await open(page);
        await input(page).fill('Make article 41 punchier');
        await input(page).press('Enter');
        await page.locator('#tabchat-chat-host').getByRole('button', { name: 'Rewrite it' }).click();
        await expect.poll(() => api.called('generate-blog').length).toBeGreaterThan(0);

        await page.evaluate(() => (window as any).openBlogStudio({ postId: 41, assistantId: 9 }));
        await expect(page.locator('#bs-editor')).toContainText('The old words.');
        await expect.poll(() => page.locator('#bs-editor').evaluate((e) => (e as HTMLElement).style.pointerEvents)).toBe('none');
        await expect(page.locator('#bs-chat-host [data-chat-input]')).toBeVisible();
        const studioChat = page.locator('#bs-chat-host [data-chat-input]');
        const hit = await studioChat.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + 5, r.y + 5)); });
        expect(hit).toBe(true);

        finish = true;
        await expect(page.locator('#bs-editor')).toContainText('The worker wrote this.', { timeout: 15000 });
        await expect.poll(() => page.locator('#bs-editor').evaluate((e) => (e as HTMLElement).style.pointerEvents)).toBe('');
        expect(store.saves).toBe(0);
        expect(pageErrors).toEqual([]);
    });

    test('a role with a chat of its own gets no second one', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'business_mentor');
        await open(page);
        await expect(page.locator('#mentoroverview-chat-host [data-chat-input]')).toBeVisible();
        await expect(page.locator('#tabchat-layout')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });
});

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 800 } });

    test('closed until asked for, and the header’s Chat opens it over the tab', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'lead_qualifier');
        await open(page);
        await expect(input(page)).toBeHidden();
        await page.locator('#btn-detail-chat').click();
        await expect(input(page)).toBeVisible();
        await expect(page.locator('#assistant-chat-modal')).toHaveCount(0);
        await closeBtn(page).click();
        await expect(input(page)).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        expect(pageErrors).toEqual([]);
    });
});
