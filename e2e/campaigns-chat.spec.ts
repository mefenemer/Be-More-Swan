// The Campaign Orchestrator's docked chat (owner, 2026-11-05: the Website tab's chat pane, on the Campaigns
// tab). The tab's real modules on a bare page, with every function stubbed. It has no card of its own: Select
// puts a campaign, a piece of its work or a person's task into the chat, and the chat's existing campaign
// cards make the change.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="campaign-control-strip"></div><div id="maintab-campaigns"><div id="campaigns-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/components/assistant-campaigns.js"></script>
  <script>AssistantCampaigns.init({ assistantId: 4, assistantName: 'Cora', cfg: { label: 'Campaigns' } }); setTimeout(() => AssistantCampaigns.activate(), 50);</script>
</body></html>`;

const CAMPAIGN = {
    id: 31, objective: 'Get 20 sign-ups for the spring workshop', status: 'active', funnelStage: 'conversion',
    outcomeMetric: 'signups', targetValue: 20, mode: 'organic', assets: [], tests: [],
    orders: { open: 1, inReview: 0, delivered: 0 },
    work: [{ orderId: 501, position: 1, label: 'Social posts', text: 'Drafting: 3 of 10 done', state: 'working' }],
    humanTasks: [{ orderId: 502, status: 'issued', waiting: 0, assignee: 'Sam (designer)', task: 'Film a 20-second clip of the room', dueDate: '2026-11-20', ticketReachable: true }],
};

function stubCampaigns(api: ApiStub) {
    const store = { calls: [] as Record<string, unknown>[] };
    api.set('campaigns', (_route, body) => {
        const b = (body || {}) as Record<string, unknown>;
        store.calls.push(b);
        if (b.action === 'list') return { campaigns: [CAMPAIGN], planGate: null, availableOrderActions: [] };
        if (b.action === 'complete_task') return { ok: true };
        return {};
    });
    return store;
}

async function openTab(page: Page) {
    await page.route('**/e2e-campaigns.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-campaigns.html');
    await expect(page.locator('[data-cmp-row="31"]')).toBeVisible();
}

const input = (page: Page) => page.locator('#campaigns-chat-host [data-chat-input]');
const sent = (api: ApiStub, i = 0) => api.called('chat-orchestrator')[i].body as { message: string };
async function ask(page: Page, text: string) { await input(page).fill(text); await input(page).press('Enter'); }

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the campaigns on the left, the chat docked on the right; the button hides it', async ({ page, api, pageErrors }) => {
        stubCampaigns(api);
        await openTab(page);
        await expect(input(page)).toBeVisible();
        const row = await page.locator('[data-cmp-row="31"]').boundingBox();
        const box = await input(page).boundingBox();
        expect(row!.x + row!.width).toBeLessThanOrEqual(box!.x);
        const toggle = page.locator('[data-cmp-chat-toggle]');
        await expect(toggle).toHaveText(/Chat with Cora/);
        await toggle.click();
        await expect(input(page)).toBeHidden();
        await toggle.click();
        await expect(input(page)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('Select a campaign puts its id into the chat', async ({ page, api, pageErrors }) => {
        stubCampaigns(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await page.locator('[data-cmp-select="31"]').click();
        await ask(page, 'Push the end date a week');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain('About my campaign 31 “Get 20 sign-ups for the spring workshop”.');
        expect(await page.evaluate(() => localStorage.getItem('bms-campaign-chat:4'))).toBe('9');
        expect(pageErrors).toEqual([]);
    });

    test('Select a piece of work says what it is and how far it has got', async ({ page, api, pageErrors }) => {
        stubCampaigns(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await page.locator('[data-cmp-select-work="501"]').click();
        await ask(page, 'When will these be ready?');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain('About this piece of work on my campaign 31');
        expect(sent(api).message).toContain('item 1, Social posts — Drafting: 3 of 10 done Its state: Working.');
        expect(pageErrors).toEqual([]);
    });

    test('Select a task → the existing task card marks it done → the tab reloads', async ({ page, api, pageErrors }) => {
        const store = stubCampaigns(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Shall I mark it done?', uiElement: { type: 'campaign_task_update', orderId: 502, outcome: 'done', note: 'Sam sent the clip.' } } });
        await openTab(page);
        await page.locator('[data-cmp-select-task="502"]').click();
        await ask(page, 'Sam has sent the clip');
        expect(sent(api).message).toContain('About this task for a person on my campaign 31');
        expect(sent(api).message).toContain('orderId 502, Sam (designer) — “Film a 20-second clip of the room”, due 2026-11-20.');
        const go = page.locator('#campaigns-chat-host [data-ctu-confirm]');
        await expect(go).toBeVisible();
        await page.screenshot({ path: 'test-results/campaigns-chat-card.png' });
        const lists = store.calls.filter((c) => c.action === 'list').length;
        await go.click();
        await expect(page.getByText('Done — your Campaigns tab shows it.')).toBeVisible();
        expect(store.calls.find((c) => c.action === 'complete_task')).toBeTruthy();
        await expect.poll(() => store.calls.filter((c) => c.action === 'list').length).toBeGreaterThan(lists);
        // Nothing here starts a campaign or places an order.
        expect(store.calls.some((c) => c.action === 'start' || c.action === 'place_order')).toBe(false);
        expect(pageErrors).toEqual([]);
    });
});

test.describe('narrow screens', () => {
    test.use({ viewport: { width: 1100, height: 850 } });

    test('off by default; Select opens it over the right edge; the ✕ closes it', async ({ page, api, pageErrors }) => {
        stubCampaigns(api);
        await openTab(page);
        await expect(input(page)).toBeHidden();
        await page.locator('[data-cmp-select="31"]').click();
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

    test('Select works, the chat fills the width, and the ✕ gets back to the campaign', async ({ page, api, pageErrors }) => {
        stubCampaigns(api);
        await openTab(page);
        await page.locator('[data-cmp-select-task="502"]').click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/campaigns-chat-phone.png' });
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(page.locator('[data-cmp-select-task="502"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
