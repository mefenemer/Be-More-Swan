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
const mentorData = { checklist: [{ key: 'a', label: 'Your customers', done: false }], visibility: { sees: ['Your plan'], never: ['Passwords'] }, dismissed: [], open: [{ id: 5, kind: 'x', title: 'Post more often' }], week: { used: 1, cap: 3 }, recommended: { picks: [], capacity: {} }, customers: {} };

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

        const list = page.locator('details[data-fold*="Set-up checklist"]');
        await expect(list).toHaveCount(1);
        await expect(list).not.toHaveAttribute('open', '');
        await expect(list.getByText('Your customers')).toBeHidden();
        await list.locator('summary').click();
        await expect(list.getByText('Your customers')).toBeVisible();
        await page.evaluate(() => (window as any).AssistantMentorOverview.activate());   // a repaint
        await expect(page.locator('details[data-fold*="Set-up checklist"]').getByText('Your customers')).toBeVisible();
        await page.locator('details[data-fold*="Set-up checklist"] summary').click();
        await expect(list.getByText('Your customers')).toBeHidden();
        expect(pageErrors).toEqual([]);
    });

    test('the Mentor: Suggestions is one open card with a pill per stage, and the other panels moved tab', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'business_mentor');
        api.set('mentor', mentorData);
        await open(page);
        const card = page.locator('#maintab-mentor [data-mentor-panel="suggestions"]');
        await expect(card.getByText('Post more often')).toBeVisible();
        await expect(card.getByRole('button', { name: 'Review all' })).toBeVisible();
        await expect(card.getByText('1 of 3 used since Monday')).toBeVisible();
        await card.getByRole('tab', { name: /^Dismissed/ }).click();
        await expect(card.getByText('Nothing dismissed.')).toBeVisible();
        await expect(card.getByRole('tab', { name: /^Dismissed/ })).toHaveAttribute('aria-selected', 'true');
        await expect(card.getByRole('tab', { name: /^Dismissed/ })).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(card.getByRole('tab', { name: /^Accepted/ })).toBeFocused();
        await expect(card.getByText('Post more often')).toBeHidden();

        const tab = page.locator('#maintab-mentor');
        for (const moved of ['Reviews', 'Customers', 'Get feedback', 'What I can see']) await expect(tab.getByRole('heading', { name: moved, exact: true })).toHaveCount(0);
        await expect(page.locator('#mentor-results-host [data-mentor-panel="reviews"]')).toHaveCount(1);
        await expect(page.locator('#mentor-results-host [data-mentor-panel="customers"]')).toHaveCount(1);
        await expect(page.locator('#mentor-plan-host [data-mentor-panel="feedback"]')).toHaveCount(1);
        await expect(page.locator('#rm-items .rm-item', { hasText: 'What I can see' })).toHaveCount(1);
        await page.locator('#rm-items [data-rm-tab="mentorsees"]').click();
        await expect(page.locator('#brief-drawer-title')).toHaveText('What I can see');
        await expect(page.locator('#mentor-sees-host').getByText('Passwords')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('another role has none of the Mentor\'s panels', async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, 'video_producer');
        await open(page);
        await expect(page.locator('#mentor-results-host')).toBeHidden();
        await expect(page.locator('#rm-items [data-rm-tab="mentorsees"]')).toHaveCount(0);
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
