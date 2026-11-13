// Issue #45: the owner answered "What does your business offer?" from a chat card on the Mentor's page, but
// the Set-up checklist beside it still said "To do". The save worked; the checklist just never re-read it,
// because the Suggestions/Plan tabs reloaded on bizinfo:profileChanged / productsChanged only, and the
// offer, intro-offer and call-to-action saves announce themselves as bizinfo:offer / introOffer /
// callToAction (chat-session.js).

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div hidden><div id="mentor-overview-host"></div></div>
  <div class="page-wide p-4"><div id="maintab-mentorplan"><div id="mentor-plan-host"></div></div></div>
  <script>window._tabHead = () => '';</script>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/mentor-apply.js"></script>
  <script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/components/assistant-mentor-overview.js"></script>
  <script src="/src/components/assistant-mentor-plan.js"></script>
  <script>
    AssistantMentorOverview.init({ assistantId: 50, assistantName: 'Iris' });
    AssistantMentorPlan.init({ assistantId: 50, assistantName: 'Iris' });
    setTimeout(() => AssistantMentorPlan.activate(), 50);
  </script>
</body></html>`;

function stub(api: ApiStub) {
    const store = { offerAnswered: false };
    const checklist = () => [
        { key: 'description', label: 'Business description', done: true, optional: false, why: 'Every assistant writes from it.', tab: 'profile' },
        { key: 'offer', label: 'What your business offers', done: store.offerAnswered, optional: false, why: 'Decides which details your assistants ask for and use.', tab: 'products' },
        { key: 'website', label: 'Website', done: false, optional: false, why: 'Assistants link to it and read it for your details.', tab: 'profile' },
    ];
    api.set('mentor', (route) => {
        const q = new URL(route.request().url()).searchParams;
        if (q.get('plan')) {
            return {
                ready: true, stage: 'existing', canApprove: true, breakEvenInputs: {}, research: [], drafting: [], researchReady: true, playbook: null,
                kinds: {
                    idea_check: { label: 'Idea check', sections: [{ key: 'problem', label: 'The problem', hint: 'What hurts.', max: 1500, group: 'interview' }], hasAssumptions: true },
                    business_plan: { label: 'Business plan', sections: [{ key: 'offer', label: 'The offer', hint: 'What you sell.', max: 1500 }] },
                    marketing_plan: { label: 'Marketing plan', sections: [] },
                },
                docs: { business_plan: { draft: { version: 1, updatedAt: '2026-11-04T10:00:00Z', body: { sections: { offer: 'Grooming visits.' } } }, diff: [] } },
            };
        }
        if (q.get('reviews')) return { ready: true, reviews: [], settings: {}, canRun: true, trackRecord: [], trackReady: true };
        if (q.get('customers')) return { customers: [] };
        return { checklist: checklist(), visibility: { sees: [], never: [] }, dismissed: [], week: { used: 0, cap: 3 }, open: [], recommended: null };
    });
    api.set('org-products', (route, body) => {
        if (route.request().method() === 'PATCH' && (body as { offer?: unknown })?.offer) {
            store.offerAnswered = true;
            return { offer: { offers: (body as { offer: string[] }).offer, answered: true } };
        }
        return {};
    });
    api.set('chat-orchestrator', {
        chatSessionId: 11,
        message: { id: 1, role: 'assistant', content: 'Shall I save what you offer?', uiElement: { type: 'offer_profile', summary: 'You provide services and take bookings.', offers: ['services', 'bookings'] } },
    });
    return store;
}

const todo = (page: Page, label: string) => page.locator('[data-mentor-panel="checklist"] [data-mentor-open-field]', { hasText: label });

test.use({ viewport: { width: 1600, height: 950 } });

test('ticking what the business offers in chat ticks it on the Set-up checklist', async ({ page, api }) => {
    const store = stub(api);
    await page.route('**/e2e-repro-45.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-repro-45.html');
    await expect(todo(page, 'What your business offers')).toBeVisible();

    const input = page.locator('#mentorplan-chat-host [data-chat-input]');
    await input.fill('We do grooming visits by appointment.');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Save this' }).click();
    await expect(page.getByText('Saved — Business Information now shows the fields that fit.')).toBeVisible();
    expect(store.offerAnswered).toBe(true);

    // The answer is saved, so the checklist must stop saying it isn't.
    await expect(todo(page, 'What your business offers')).toHaveCount(0);
    await expect(page.locator('[data-mentor-panel="checklist"]')).toContainText('2 of 3 done');
    await expect(todo(page, 'Website')).toBeVisible();
});
