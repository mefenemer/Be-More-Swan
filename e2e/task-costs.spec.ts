// Admin → Revenue → Task costs, the owner's review prompt, and live figures on Pricing and in cards.
import { test, expect, openWorkspace } from './fixtures';

const REVIEW = 'task-cost-review';
const change = (over: Record<string, unknown> = {}) => ({
    id: 7, date: '6 December 2026', inForce: false,
    reason: 'The AI music model costs us more to run.', summary: 'AI music: 20 tasks → 25 tasks.', ...over,
});
const FIGURES = {
    weights: { ai_image: 2, ai_video: 30, ai_music: 25, ai_music_shared: 15, x_link_post: 11, site_audit: 3 },
    videoTasksPerSecond: 5, chatMessagesPerTask: 10, videoPricedBySecond: false, basicWorkCharged: false,
};

test.describe('the owner reviews a change', () => {
    test('before the date it can wait until later, and stays quiet for the session', async ({ page, signedIn, api, pageErrors }) => {
        api.set(REVIEW, { changes: [change()], mustAccept: false, canAccept: true });
        await openWorkspace(page);
        const modal = page.locator('#modal-task-cost-review');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('AI music: 20 tasks → 25 tasks.');
        await expect(modal).toContainText('From 6 December 2026');
        await expect(modal).toContainText('The AI music model costs us more to run.');
        await page.locator('#tcr-later').click();
        await expect(modal).toBeHidden();
        await page.reload();
        await page.waitForFunction(() => !!(window as any)._currentViewKey);
        await expect(modal).toBeHidden();
        expect(pageErrors).toEqual([]);
    });

    test('accepting needs the tick, sends the ids, and closes it', async ({ page, signedIn, api }) => {
        api.set(REVIEW, { changes: [change()], mustAccept: false, canAccept: true });
        await openWorkspace(page);
        await expect(page.locator('#tcr-accept')).toBeDisabled();
        await page.locator('#tcr-agree').check();
        await page.locator('#tcr-accept').click();
        await expect(page.locator('#modal-task-cost-review')).toBeHidden();
        const post = api.called(REVIEW).find((c) => c.method === 'POST');
        expect(post?.body).toEqual({ ids: [7] });
    });

    test('once it has started it cannot be put off, and comes back after visiting Billing', async ({ page, signedIn, api, pageErrors }) => {
        api.set(REVIEW, { changes: [change({ inForce: true })], mustAccept: true, canAccept: true });
        await openWorkspace(page);
        const modal = page.locator('#modal-task-cost-review');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('Since 6 December 2026');
        await expect(page.locator('#tcr-later')).toBeHidden();
        await page.locator('#tcr-billing').click();
        await page.waitForFunction(() => (window as any)._currentViewKey === 'billing');
        await expect(modal).toBeHidden();
        await page.evaluate(() => (window as any).loadView('notifications'));
        await expect(modal).toBeVisible({ timeout: 8000 });
        expect(pageErrors).toEqual([]);
    });

    test('a team member gets no prompt', async ({ page, signedIn, api }) => {
        api.set(REVIEW, { changes: [], mustAccept: false, canAccept: false });
        await openWorkspace(page);
        await expect(page.locator('#modal-task-cost-review')).toBeHidden();
    });

    test('a fault reading it never blocks the workspace', async ({ page, signedIn, api, pageErrors }) => {
        api.set(REVIEW, { status: 500 });
        await openWorkspace(page);
        await expect(page.locator('#modal-task-cost-review')).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('figures on the page follow the admin setting', () => {
    test('Pricing shows the live numbers', async ({ page, api, pageErrors }) => {
        api.set('task-costs', FIGURES);
        await page.goto('/pricing.html');
        const music = page.locator('li:has-text("An AI music track") [data-task-cost="ai_music"]');
        await expect(music).toHaveText('25 tasks');
        await expect(page.locator('li:has-text("An AI video") [data-task-cost="ai_video"]').first()).toHaveText('30 tasks');
        await expect(page.locator('li:has-text("post to X") [data-task-cost="x_link_post"]')).toHaveText('11 tasks');
        expect(pageErrors).toEqual([]);
    });

    test('Pricing keeps its text if the figures cannot be fetched', async ({ page, api }) => {
        api.set('task-costs', { status: 500 });
        await page.goto('/pricing.html');
        await expect(page.locator('li:has-text("An AI video") [data-task-cost="ai_video"]').first()).toHaveText('20 tasks');
    });

    test('a video priced by the second reads that way', async ({ page, api }) => {
        api.set('task-costs', { ...FIGURES, videoPricedBySecond: true });
        await page.goto('/pricing.html');
        await expect(page.locator('li:has-text("An AI video") [data-task-cost="ai_video"]').first()).toHaveText('5 tasks a second');
    });

    test('scripts in the workspace read the same figures', async ({ page, signedIn, api }) => {
        api.set('task-costs', FIGURES);
        await openWorkspace(page);
        await page.waitForFunction(() => (window as any).taskCost('site_audit') === '3 tasks');
    });
});

const STATE = (changes: unknown[], openChangeId: number | null) => ({
    costs: [
        { key: 'ai_music', label: 'AI music', value: 20, text: '20 tasks', min: 0, max: 1000, inUse: true },
        { key: 'ai_image', label: 'AI images', value: 1, text: '1 task', min: 0, max: 1000, inUse: true },
        { key: 'chat_messages', label: 'Chat (each charge)', value: 1, text: '1 task', min: 0, max: 1000, inUse: false },
    ],
    openChangeId, changes,
    earliest: { rise: '2026-12-06', reduction: '2026-11-07' },
    minNoticeDays: 30, emailsGoToCustomers: false, you: 'admin@example.test',
});
const DRAFT = {
    id: 7, status: 'draft', effectiveDate: '2026-12-06', reason: 'The AI music model costs us more to run.', announcedAt: null, createdAt: '2026-11-06',
    items: [{ key: 'ai_music', oldUnits: 20, newUnits: 25 }], waiting: 12,
    inApp: { title: 'Task costs change on 6 December 2026: please review', message: 'From 6 December 2026: AI music: 20 tasks → 25 tasks.' },
    email: { subject: 'Task costs change on 6 December 2026: please review', html: '<p>Email body</p>' },
};
const ANNOUNCED = {
    ...DRAFT, status: 'announced', announcedAt: '2026-11-06', sent: 10, waiting: 2,
    acceptance: { workspaces: 8, accepted: 3, waiting: [{ id: 4, name: 'Love Cat', ownerEmail: 'owner@example.test' }] },
};

async function openAdmin(page: any, api: any) {
    api.set('admin-api', { permissions: ['manage_task_costs'] });
    await page.goto('/admin.html');
    await page.waitForFunction(() => typeof (window as any).adminNav === 'function');
    await page.evaluate(() => (window as any).adminNav('task-costs'));
}

test.describe('Admin → Revenue → Task costs', () => {
    test('saving a draft sends only what changed, with the date and reason', async ({ page, signedIn, api, pageErrors }) => {
        let saved = false;
        api.set('admin-task-costs', (route: any) => (route.request().method() === 'POST' ? (saved = true, { id: 7 }) : (saved ? STATE([DRAFT], 7) : STATE([], null))));
        await openAdmin(page, api);
        await page.locator('[data-tc-key="ai_music"]').fill('25');
        await page.locator('#tc-reason').fill('The AI music model costs us more to run.');
        await page.locator('#tc-save').click();
        await expect(page.locator('#tc-open')).toContainText('Draft: starts 6 December 2026');
        const post = api.called('admin-task-costs').find((c: any) => c.method === 'POST')!;
        expect(post.url).toContain('resource=save');
        expect(post.body).toEqual({ items: { ai_music: 25 }, effectiveDate: '2026-12-06', reason: 'The AI music model costs us more to run.' });
        expect(pageErrors).toEqual([]);
    });

    test('announcing needs the number typed, and the server is told it', async ({ page, signedIn, api }) => {
        api.set('admin-task-costs', (route: any) => (route.request().method() === 'POST' ? { started: true, waiting: 12, emailsGoToCustomers: false } : STATE([DRAFT], 7)));
        await openAdmin(page, api);
        const go = page.locator('#tc-announce');
        await expect(go).toBeDisabled();
        await page.locator('#tc-confirm').fill('11');
        await expect(go).toBeDisabled();
        await page.locator('#tc-confirm').fill('12');
        await go.click();
        await expect(page.locator('#tc-status')).toContainText('Announced');
        const post = api.called('admin-task-costs').find((c: any) => c.method === 'POST')!;
        expect(post.url).toContain('resource=announce');
        expect(post.body).toEqual({ id: 7, expected: 12 });
    });

    test('an announced change locks the costs and shows who has accepted', async ({ page, signedIn, api }) => {
        api.set('admin-task-costs', STATE([ANNOUNCED], 7));
        await openAdmin(page, api);
        await expect(page.locator('#tc-open')).toContainText('Announced: starts 6 December 2026');
        await expect(page.locator('#tc-open')).toContainText('3 of 8 workspaces accepted');
        await page.locator('#tc-open summary').click();
        await expect(page.locator('#tc-open')).toContainText('Love Cat');
        await expect(page.locator('[data-tc-key="ai_music"]')).toBeDisabled();
        await expect(page.locator('#tc-save')).toHaveCount(0);
    });

    test('a cost nobody is charged saves on its own, with no notice', async ({ page, signedIn, api }) => {
        api.set('admin-task-costs', (route: any) => (route.request().method() === 'POST' ? { id: 8 } : STATE([], null)));
        await openAdmin(page, api);
        await page.locator('[data-tc-key="chat_messages"]').fill('2');
        await page.locator('[data-tc-unused="chat_messages"]').click();
        await expect(page.locator('#tc-status')).toContainText('no notice went out');
        const post = api.called('admin-task-costs').find((c: any) => c.method === 'POST')!;
        expect(post.url).toContain('resource=set_unused');
        expect(post.body).toEqual({ key: 'chat_messages', value: 2 });
    });

    test('the server\'s refusal is shown, not swallowed', async ({ page, signedIn, api }) => {
        api.set('admin-task-costs', (route: any) => {
            if (route.request().method() === 'POST') { route.fulfill({ status: 400, json: { error: 'A cost going up needs 30 days\' notice (terms 5.2).' } }); return undefined; }
            return STATE([], null);
        });
        await openAdmin(page, api);
        await page.locator('[data-tc-key="ai_music"]').fill('25');
        await page.locator('#tc-save').click();
        await expect(page.locator('#tc-status')).toContainText('30 days');
    });
});
