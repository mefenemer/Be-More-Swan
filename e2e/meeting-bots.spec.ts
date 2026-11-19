// The Note Taker joins a call (docs/note-taker-bot-plan.md step 3): the Inbox's "Send to a call" button, its dialog and
// the Live & upcoming strip, on a bare page with the real component and the chat card, every function stubbed.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4">
    <div class="tab-head-right flex flex-wrap gap-2">
      <button type="button" id="detail-rq-bot-btn" style="display:none" class="hidden btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg">Send to a call</button>
    </div>
    <div id="meeting-bots-strip" class="hidden" style="display:none"></div>
    <div id="chat-card"></div>
  </div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script>
  <script src="/src/components/meeting-bots.js"></script>
  <script>window.MeetingBots.mount({ assistantId: 21, assistantName: 'Nora' });</script>
</body></html>`;

const now = Date.now();
const BOTS = [
    { id: 1, assistantId: 21, platform: 'google_meet', platformLabel: 'Google Meet', title: 'Weekly team call', meetingUrl: 'https://meet.google.com/abc-defg-hij', joinAt: new Date(now - 6 * 60_000).toISOString(), status: 'in_call', statusWords: 'In the call', statusReason: null, joinedAt: null, leftAt: null, minutesInCall: null, recordId: null },
    { id: 2, assistantId: 21, platform: 'teams', platformLabel: 'Microsoft Teams', title: 'Board meeting with a rather long name that has to wrap on a phone', meetingUrl: 'https://teams.microsoft.com/meet/1', joinAt: new Date(now + 26 * 3600_000).toISOString(), status: 'scheduled', statusWords: 'Booked', statusReason: null, joinedAt: null, leftAt: null, minutesInCall: null, recordId: null },
];

function stub(api: ApiStub, opts: { available?: boolean; dpaAccepted?: boolean } = {}) {
    const posts: Record<string, unknown>[] = [];
    api.set('meeting-bots', async (route, body) => {
        if (route.request().method() === 'GET') return { available: opts.available ?? true, dpaAccepted: opts.dpaAccepted ?? true, tasksPer5Min: 1, bots: BOTS };
        posts.push(body as Record<string, unknown>);
        return { bot: { ...BOTS[0], id: 3, status: 'joining', statusWords: 'Joining the call' }, alreadySent: false };
    });
    return posts;
}

async function open(page: Page) {
    await page.route('**/e2e-meeting-bots.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-meeting-bots.html');
}

async function noSideScroll(page: Page) {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw);
}

for (const [name, viewport] of [['wide screen', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
    test.describe(name, () => {
        test.use({ viewport });

        test('the strip lists the live and booked bots with the right buttons, and fits the screen', async ({ page, api, pageErrors }) => {
            stub(api);
            await open(page);
            await expect(page.locator('#detail-rq-bot-btn')).toBeVisible();
            const live = page.locator('[data-mb-bot="1"]');
            const booked = page.locator('[data-mb-bot="2"]');
            await expect(live).toContainText('In the call');
            await expect(live.getByRole('button', { name: 'Remove from call' })).toBeVisible();
            await expect(booked.getByRole('button', { name: 'Cancel' })).toBeVisible();
            await noSideScroll(page);
            if (viewport.width < 640) {
                const h = (await live.getByRole('button').boundingBox())!.height;
                expect(h).toBeGreaterThanOrEqual(44);
            }
            expect(pageErrors).toEqual([]);
        });

        test('the dialog sends one bot through the server action, with the cost and consent words', async ({ page, api, pageErrors }) => {
            const posts = stub(api);
            await open(page);
            await page.locator('#detail-rq-bot-btn').click();
            const dialog = page.getByRole('dialog', { name: 'Send to a call' });
            await expect(dialog).toBeVisible();
            await expect(dialog).toContainText('about 12 an hour');
            await expect(dialog).toContainText('Tell everyone in the meeting');
            await noSideScroll(page);
            await dialog.getByLabel('Meeting link').fill('https://meet.google.com/abc-defg-hij');
            await dialog.getByRole('button', { name: 'Send the Note Taker' }).click();
            await expect(dialog).toBeHidden();
            expect(posts).toHaveLength(1);
            expect(posts[0]).toMatchObject({ action: 'send', assistantId: 21, meetingUrl: 'https://meet.google.com/abc-defg-hij', joinAt: null, source: 'link', lengthLimitMinutes: 120 });
            expect(pageErrors).toEqual([]);
        });

        test('without DPA 1.2 the dialog says so and cannot send', async ({ page, api }) => {
            const posts = stub(api, { dpaAccepted: false });
            await open(page);
            await page.locator('#detail-rq-bot-btn').click();
            const dialog = page.getByRole('dialog', { name: 'Send to a call' });
            await expect(dialog).toContainText('version 1.2');
            await expect(dialog.getByRole('button', { name: 'Send the Note Taker' })).toBeDisabled();
            expect(posts).toHaveLength(0);
        });

        test('the chat card sends through the same action with source chat; a blocked card has no button', async ({ page, api, pageErrors }) => {
            const posts = stub(api);
            await open(page);
            await page.evaluate(() => {
                const w = window as unknown as { DisruptiveUIRegistry: { render: (ui: unknown) => HTMLElement | null } };
                const host = document.getElementById('chat-card')!;
                const card = w.DisruptiveUIRegistry.render({ type: 'meeting_bot_proposal', action: 'send', assistantId: 21, meetingUrl: 'https://meet.google.com/abc-defg-hij', platformLabel: 'Google Meet', title: 'Standup', joinAt: null, tasksPer5Min: 1 });
                if (card) host.appendChild(card);
                const blocked = w.DisruptiveUIRegistry.render({ type: 'meeting_bot_proposal', action: 'send', assistantId: 21, meetingUrl: 'https://zoom.us/j/1', title: null, joinAt: null, blocked: 'Zoom is coming soon.' });
                if (blocked) { blocked.setAttribute('data-blocked', ''); host.appendChild(blocked); }
            });
            const card = page.locator('[data-meeting-bot="send"]').first();
            await expect(card).toContainText('Needs your OK');
            await card.getByRole('button', { name: 'Send it now' }).click();
            await expect(card).toContainText('On its way');
            expect(posts[0]).toMatchObject({ action: 'send', assistantId: 21, source: 'chat' });
            await expect(page.locator('[data-blocked]')).toContainText('Can’t be done');
            await expect(page.locator('[data-blocked] button')).toHaveCount(0);
            await noSideScroll(page);
            expect(pageErrors).toEqual([]);
        });

        test('nothing shows while the flag is off', async ({ page, api }) => {
            stub(api, { available: false });
            await open(page);
            await page.waitForTimeout(300);
            await expect(page.locator('#detail-rq-bot-btn')).toBeHidden();
            await expect(page.locator('#meeting-bots-strip')).toBeHidden();
        });
    });
}
