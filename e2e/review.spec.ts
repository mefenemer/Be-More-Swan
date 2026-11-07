import { test, expect, openWorkspace } from './fixtures';

const draft = {
    id: 501,
    assistantId: 7,
    assistantName: 'Social Assistant',
    platform: 'linkedin',
    status: 'pending_approval',
    content: 'Spring opening hours start Monday.',
    generatedAt: new Date(Date.now() - 3600_000).toISOString(),
};

test('a waiting draft shows on Review with its count', async ({ page, api, signedIn, pageErrors }) => {
    api.set('get-social-drafts', (route) => {
        // Only the To approve column (RQ_COLUMNS.review in workspace.html) has the draft.
        return new URL(route.request().url()).searchParams.get('status') === 'pending_approval'
            ? { drafts: [draft], total: 1, hasMore: false }
            : { drafts: [], total: 0, hasMore: false };
    });
    await openWorkspace(page, 'review-queue');

    await expect(page.locator('#rq-groups').getByText('LinkedIn post')).toBeVisible();
    await expect(page.locator('#rq-col-count-review')).toHaveText('1');
    await expect(page.getByText('You’re all caught up')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
});

test('when drafts fail to load, Review says so instead of "all caught up"', async ({ page, api, signedIn }) => {
    api.set('get-social-drafts', { status: 500 });
    await openWorkspace(page, 'review-queue');

    await expect(page.getByRole('alert')).toContainText("We couldn't load this list");
    await expect(page.getByText('You’re all caught up')).toHaveCount(0);
});

test('every assistant’s waiting work is on the Review page, and each row opens that assistant’s tab', async ({ page, api, signedIn, pageErrors }) => {
    api.set('review-waiting', { total: 7, groups: [
        { key: 'lead-9', assistantId: 9, assistantName: 'Mira', label: 'Outreach emails to approve', tab: 'review-queue', count: 6, items: [{ id: 1, title: 'Acme Ltd', at: '2026-11-06T09:00:00.000Z' }] },
        { key: 'brief-4', assistantId: 4, assistantName: 'Dot', label: 'Designs to choose from', tab: 'briefs', count: 1, items: [{ id: 2, title: 'Summer flyer', at: null }] },
    ] });
    await openWorkspace(page, 'review-queue');
    await expect(page.getByText('Outreach emails to approve · Mira')).toBeVisible();
    await expect(page.getByText('Designs to choose from · Dot')).toBeVisible();
    await expect(page.locator('#rq-col-count-review')).toHaveText('7');
    api.set('get-assistant-context', { id: 4, name: 'Dot', role: 'Role', roleKey: 'brand_designer', status: 'working', lifecycleStatus: 'active', context: {}, goals: [], configuration: {} });
    await page.getByRole('button', { name: /Summer flyer/ }).click();
    await expect(page.locator('#maintab-btn-briefs')).toHaveAttribute('aria-selected', 'true');
    expect(pageErrors).toEqual([]);
});

test('Review still lists what it has when the waiting feed fails', async ({ page, api, signedIn, pageErrors }) => {
    api.set('review-waiting', async (route) => { await route.fulfill({ status: 500, body: '{}' }); });
    await openWorkspace(page, 'review-queue');
    await expect(page.getByText('You’re all caught up')).toBeVisible();
    expect(pageErrors).toEqual([]);
});
