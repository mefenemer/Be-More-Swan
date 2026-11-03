// Approving an assistant's draft from Review: the step customers use most.
//
// Review card → post editor (opens on the decision step for a waiting draft) → Approve →
// approve-post → "✓ Approved" panel, and the draft is gone from To approve. The gates on the way
// (rqReviewApprove in workspace.html) are the browser's half; approve-post re-checks on the server.
import { test, expect, openWorkspace, type ApiStub } from './fixtures';

const slot = new Date(Date.now() + 2 * 86400_000);
slot.setHours(10, 0, 0, 0);

const draft = {
    id: 501,
    assistantId: 7,
    assistantName: 'Social Assistant',
    platform: 'linkedin',
    status: 'pending_approval',
    caption: 'Spring opening hours start Monday.',
    publishDate: slot.toISOString(),
    generatedAt: new Date(Date.now() - 3600_000).toISOString(),
};

/** One waiting draft until approve-post is called, then none — as the server would answer. */
function stubQueue(api: ApiStub, connected: string[]) {
    let approved = false;
    api.set('check-capacity', { connectedPlatforms: connected });
    api.set('get-social-drafts', (route) => {
        const status = new URL(route.request().url()).searchParams.get('status');
        return status === 'pending_approval' && !approved
            ? { drafts: [draft], total: 1, hasMore: false }
            : { drafts: [], total: 0, hasMore: false };
    });
    api.set('approve-post', () => {
        approved = true;
        return { ok: true, post: { ...draft, status: 'scheduled' } };
    });
}

test('approving a draft schedules it and takes it off To approve', async ({ page, api, signedIn, pageErrors }) => {
    stubQueue(api, ['linkedin']);
    await openWorkspace(page, 'review-queue');

    await page.locator('#rq-groups').getByText('LinkedIn post').click();
    const editor = page.locator('#post-review-modal');
    await expect(editor).toBeVisible();
    await editor.locator('#post-review-reschedule').getByRole('button', { name: /^Approve/ }).click();

    const when = slot.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    await expect(page.locator('#post-review-approved-msg')).toHaveText(`Social Assistant will schedule this for ${when}.`);
    const calls = api.called('approve-post');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ postId: 501, action: 'approve', acknowledgeWarnings: false });

    // Done → back on the list, where the draft has gone and the count with it.
    await page.locator('#post-review-approved').getByRole('button', { name: 'Done' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByText('You’re all caught up')).toBeVisible();
    await expect(page.locator('#rq-col-count-review')).toBeHidden();
    expect(pageErrors).toEqual([]);
});

test('a draft for a platform that is not connected is never sent for approval', async ({ page, api, signedIn }) => {
    stubQueue(api, []);
    await openWorkspace(page, 'review-queue');

    await page.locator('#rq-groups').getByText('LinkedIn post').click();
    await page.locator('#post-review-reschedule').getByRole('button', { name: /^Approve/ }).click();

    // The connection gate re-reads capacity once before refusing.
    await expect.poll(() => api.called('check-capacity').length).toBeGreaterThan(1);
    expect(api.called('approve-post')).toHaveLength(0);
    await expect(page.locator('#post-review-approved')).toBeHidden();
});
