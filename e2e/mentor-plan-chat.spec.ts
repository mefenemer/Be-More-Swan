// The Business Mentor's docked chat on the Plan tab (owner, 2026-11-05: the Website tab's chat pane). The tab's
// real modules on a bare page, with every function stubbed. No card of its own: Select puts a part of a plan
// into the chat, and the Mentor's existing strategy_proposal ("revise") card saves the change as a draft.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-mentorplan"><div id="mentor-plan-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/mentor-apply.js"></script>
  <script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/components/assistant-mentor-plan.js"></script>
  <script>AssistantMentorPlan.init({ assistantId: 50, assistantName: 'Iris' }); setTimeout(() => AssistantMentorPlan.activate(), 50);</script>
</body></html>`;

const BUSINESS = {
    label: 'Business plan',
    sections: [
        { key: 'customer', label: 'Who the customer is', hint: 'Who buys.', max: 1500 },
        { key: 'offer', label: 'The offer', hint: 'What you sell.', max: 1500 },
    ],
};
const IDEA = { label: 'Idea check', sections: [{ key: 'problem', label: 'The problem', hint: 'What hurts.', max: 1500, group: 'interview' }], hasAssumptions: true };

function stubMentor(api: ApiStub) {
    const store = {
        saves: [] as Record<string, unknown>[],
        sections: { customer: 'Cat owners in Leeds.', offer: 'Weekly home visits.' } as Record<string, string>,
    };
    const plan = () => ({
        ready: true, stage: 'trading', canApprove: true, breakEvenInputs: {}, research: [], drafting: [], researchReady: true, playbook: null,
        kinds: { idea_check: IDEA, business_plan: BUSINESS, marketing_plan: { label: 'Marketing plan', sections: [] } },
        docs: { business_plan: { draft: { version: 2, updatedAt: '2026-11-04T10:00:00Z', body: { sections: { ...store.sections } } }, diff: [] } },
    });
    api.set('mentor', (route, body) => {
        if (route.request().method() === 'GET') return plan();
        const b = (body || {}) as Record<string, unknown>;
        if (b.action === 'strategy_save') {
            store.saves.push(b);
            Object.assign(store.sections, b.sections as Record<string, string>);
            return { ok: true };
        }
        return { ok: true };
    });
    return store;
}

async function openTab(page: Page) {
    await page.route('**/e2e-mentor-plan.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-mentor-plan.html');
    await expect(page.locator('[data-mplan-field="business_plan:offer"]')).toBeVisible();
}

const input = (page: Page) => page.locator('#mentorplan-chat-host [data-chat-input]');
const sent = (api: ApiStub, i = 0) => api.called('chat-orchestrator')[i].body as { message: string };
async function ask(page: Page, text: string) { await input(page).fill(text); await input(page).press('Enter'); }
const CARD = {
    type: 'strategy_proposal', op: 'revise', kind: 'business_plan', kindLabel: 'Business plan', summary: 'A sharper offer.', why: null,
    sections: { offer: 'Weekly home visits, with a photo report after each one.' },
    changes: [{ key: 'offer', label: 'The offer', now: 'Weekly home visits.', next: 'Weekly home visits, with a photo report after each one.' }],
};

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the plans on the left, the chat docked on the right; the button hides it', async ({ page, api, pageErrors }) => {
        stubMentor(api);
        await openTab(page);
        await expect(input(page)).toBeVisible();
        const field = await page.locator('[data-mplan-field="business_plan:offer"]').boundingBox();
        const box = await input(page).boundingBox();
        expect(field!.x + field!.width).toBeLessThanOrEqual(box!.x);
        const toggle = page.locator('[data-mplan-chat-toggle]');
        await expect(toggle).toHaveText(/Chat with Iris/);
        await toggle.click();
        await expect(input(page)).toBeHidden();
        await toggle.click();
        await expect(input(page)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('Select a part sends its whole text, unsaved typing included', async ({ page, api, pageErrors }) => {
        stubMentor(api);
        api.set('chat-orchestrator', { chatSessionId: 11, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await page.locator('[data-mplan-field="business_plan:offer"]').fill('Weekly home visits and nail trims.');
        await page.locator('[data-mplan-select="business_plan:offer"]').click();
        await ask(page, 'Challenge this');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain('About this part of my Business plan (section offer, “The offer”), as I have typed it (not saved yet): “Weekly home visits and nail trims.”.');
        expect(await page.evaluate(() => localStorage.getItem('bms-mentorplan-chat:50'))).toBe('11');
        expect(pageErrors).toEqual([]);
    });

    test('the revise card saves a draft; the chat’s words replace typing in that part only', async ({ page, api, pageErrors }) => {
        const store = stubMentor(api);
        api.set('chat-orchestrator', { chatSessionId: 11, message: { id: 1, role: 'assistant', content: 'Here is a sharper offer.', uiElement: CARD } });
        await openTab(page);
        // Unsaved typing in two parts; the chat then changes one of them.
        await page.locator('[data-mplan-field="business_plan:offer"]').fill('Something I typed.');
        await page.locator('[data-mplan-field="business_plan:customer"]').fill('Cat owners in Leeds and York.');
        await page.locator('[data-mplan-select="business_plan:offer"]').click();
        await ask(page, 'Make it sharper');
        const go = page.getByRole('button', { name: 'Save to my draft' });
        await expect(go).toBeVisible();
        await page.screenshot({ path: 'test-results/mentor-plan-chat-card.png' });
        await go.click();
        await expect(page.getByText('Saved to your draft on the Plan tab.')).toBeVisible();
        expect(store.saves[0]).toMatchObject({ action: 'strategy_save', kind: 'business_plan', sections: { offer: CARD.sections.offer } });
        await expect(page.locator('[data-mplan-field="business_plan:offer"]')).toHaveValue(CARD.sections.offer);
        await expect(page.locator('[data-mplan-field="business_plan:customer"]')).toHaveValue('Cat owners in Leeds and York.');
        // Nothing is approved from the chat.
        expect(api.called('mentor').some((c) => (c.body as { action?: string } | null)?.action === 'strategy_approve')).toBe(false);
        expect(pageErrors).toEqual([]);
    });

    test('Select an assumption on the idea check', async ({ page, api, pageErrors }) => {
        stubMentor(api);
        api.set('chat-orchestrator', { chatSessionId: 11, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await page.locator('[data-mplan-kind="idea_check"]').click();
        await page.locator('[data-mplan-add-assumption]').click();
        await page.locator('[data-mplan-assumption="0:assumption"]').fill('People will pay £20 a visit.');
        await page.locator('[data-mplan-select-assumption="0"]').click();
        await ask(page, 'How do I test this?');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain('About riskiest assumption 1 in my Idea check: “People will pay £20 a visit.”, with no test yet.');
        expect(pageErrors).toEqual([]);
    });
});

test.describe('narrow screens', () => {
    test.use({ viewport: { width: 1100, height: 850 } });

    test('off by default; Select opens it over the right edge; the ✕ closes it', async ({ page, api, pageErrors }) => {
        stubMentor(api);
        await openTab(page);
        await expect(input(page)).toBeHidden();
        await page.locator('[data-mplan-select="business_plan:customer"]').click();
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

    test('Select works, the chat fills the width, and the ✕ gets back to the plan', async ({ page, api, pageErrors }) => {
        stubMentor(api);
        await openTab(page);
        await page.locator('[data-mplan-select="business_plan:offer"]').click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/mentor-plan-chat-phone.png' });
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(page.locator('[data-mplan-select="business_plan:offer"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
