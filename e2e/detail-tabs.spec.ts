// The assistant's page, every role (owner, 2026-11-06): items in a tab start closed and open with a click; the
// Website Assistant's tabs are the page's tabs with the chat on the right; a new name reaches the page without a
// refresh; no "Chat with …" button where there is a chat panel; the Business Mentor has the same header as the rest.

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
const mentorData = { checklist: [{ key: 'a', label: 'Your customers', done: false }], visibility: { sees: ['Your plan'], never: ['Passwords'] }, dismissed: [], open: [{ id: 5, kind: 'x', title: 'Post more often' }], week: { used: 1, cap: 3 }, recommended: { picks: [], capacity: {} } };

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 1000 } });

    test('the Mentor: hero beside Needs you, chat panel on Overview, cards closed until opened and open through a repaint', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'business_mentor');
        api.set('mentor', mentorData);
        await open(page);
        const hero = await page.locator('#detail-hero').boundingBox();
        const strip = page.locator('#detail-top-row > #detail-needs-you');
        await expect(strip).toContainText('Needs you: 1 waiting in Overview');
        await expect(strip).toContainText('Post more often');
        expect(hero!.x + hero!.width).toBeLessThanOrEqual((await strip.boundingBox())!.x);
        await expect(page.locator('#mentoroverview-chat-host [data-chat-input]')).toBeVisible();

        const week = page.locator('details[data-fold*="Suggestions this week"]');
        await expect(week).toHaveCount(1);
        await expect(week).not.toHaveAttribute('open', '');
        await expect(week.getByText('of 3 used')).toBeHidden();
        await week.locator('summary').click();
        await expect(week.getByText('of 3 used')).toBeVisible();
        await page.evaluate(() => (window as any).AssistantMentorOverview.activate());   // a repaint
        await expect(page.locator('details[data-fold*="Suggestions this week"]').getByText('of 3 used')).toBeVisible();
        await page.locator('details[data-fold*="Suggestions this week"] summary').click();
        await expect(page.getByText('of 3 used')).toBeHidden();
        expect(pageErrors).toEqual([]);
    });

    test('a new name reaches the chat panel and the settings title as the save lands', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'business_mentor');
        api.set('mentor', mentorData);
        api.set('update-assistant-context', { ok: true });
        await open(page);
        const title = page.locator('#mentoroverview-chat-host [data-chatpane-title]');
        await expect(title).toHaveText('Chat with Mira');
        await page.locator('#detail-name-input').fill('Nova');
        await expect(title).toHaveText('Chat with Nova');
        await expect(page.locator('#mentoroverview-chat-host [data-chat-name]')).toHaveText('Nova');
        expect(await page.evaluate(() => (window as any)._assistantProfileTitle)).toBe("Nova's Settings");
        await expect(page.locator('#mentoroverview-chat-host [data-chatpane-avatar]')).toContainText('N');
        expect(pageErrors).toEqual([]);
    });

    test('no "Chat with …" button on a tab: the menu\'s Chat brings the panel back after its ✕', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'video_producer');
        await open(page);
        const input = page.locator('#videos-chat-host [data-chat-input]');
        await expect(input).toBeVisible();
        await expect(page.locator('#maintab-videos button', { hasText: /^💬? ?Chat with/ })).toHaveCount(0);
        await page.locator('#videos-chat-host [data-chatpane-close]').click();
        await expect(input).toBeHidden();
        await page.locator('#rm-chat').click();
        await expect(input).toBeVisible();
        await expect(page.locator('.bms-chat-panel')).toHaveCount(0);   // not the pop-up as well
        expect(pageErrors).toEqual([]);
    });

    test('a role with no chat panel on this tab still gets the pop-up from the menu', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'crm_enricher');
        await open(page);
        await page.locator('#rm-chat').click();
        await expect(page.locator('.bms-chat-panel')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
