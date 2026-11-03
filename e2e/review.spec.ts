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
