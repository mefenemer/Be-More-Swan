import { test, expect, openWorkspace } from './fixtures';

const TOKEN = 'a'.repeat(64);
const VIEW = {
    kind: 'social_post',
    workspaceName: 'Acme <b>Bakery</b>',
    trialOffer: true,
    versions: [
        { platform: 'facebook', caption: 'Fresh bread <script>window.__hacked = 1</script>', hashtags: '#bread', link: '', plannedFor: '2026-12-01T10:00:00.000Z', pictureWords: ['Sale today'], media: [] },
        { platform: 'instagram', caption: 'Instagram words', hashtags: '', link: '', plannedFor: null, pictureWords: [], media: [] },
    ],
};

test.beforeEach(async ({ page }) => {
    // The static server has no netlify.toml rewrites, so serve the page at its real address here.
    await page.route(`**/r/${TOKEN}`, (route) => route.fulfill({ path: 'shared-review.html', contentType: 'text/html' }));
});

const actions = (api: { called: (fn: string) => Array<{ body: unknown }> }) =>
    api.called('review-link-public').map((c) => (c.body as { action: string }).action);

test('opening the link records no view, and guest text stays text', async ({ page, api }) => {
    api.set('review-link-public', VIEW);
    await page.goto(`/r/${TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Acme <b>Bakery</b> would like your thoughts' })).toBeVisible();
    await expect(page.getByText('Fresh bread <script>')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __hacked?: number }).__hacked)).toBeUndefined();
    await expect(page.getByText('Sale today')).toBeVisible();
    // A scanner runs this script too: it may read the post and must record nothing.
    expect(actions(api)).toEqual(['view']);
    await expect(page.getByRole('heading', { name: 'Want an AI team of your own?' })).toBeHidden();
});

test('a person can approve, and only then sees the trial offer', async ({ page, api }) => {
    api.set('review-link-public', VIEW);
    await page.goto(`/r/${TOKEN}`);
    await page.getByRole('tab', { name: 'Instagram' }).click();
    await expect(page.getByText('Instagram words')).toBeVisible();
    await expect.poll(() => actions(api)).toContain('opened');

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('alert')).toHaveText('Please add your name.');
    expect(actions(api)).not.toContain('respond');

    await page.getByLabel('Your name').fill('Sarah');
    api.set('review-link-public', { ok: true });
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    const sent = api.called('review-link-public').find((c) => (c.body as { action: string }).action === 'respond');
    expect(sent?.body).toMatchObject({ token: TOKEN, name: 'Sarah', decision: 'approved' });
    await expect(page.getByRole('link', { name: 'Start your free trial' })).toHaveAttribute('href', /src=review-link&cmp=social_post/);
});

test('pressing Enter in the name box does not approve', async ({ page, api }) => {
    api.set('review-link-public', VIEW);
    await page.goto(`/r/${TOKEN}`);
    await page.getByLabel('Your name').fill('Sarah');
    await page.getByLabel('Your name').press('Enter');
    await page.waitForTimeout(200);
    expect(actions(api)).not.toContain('respond');
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeHidden();
});

test('asking for changes needs a comment', async ({ page, api }) => {
    api.set('review-link-public', VIEW);
    await page.goto(`/r/${TOKEN}`);
    await page.getByLabel('Your name').fill('Sarah');
    await page.getByRole('button', { name: 'Ask for changes' }).click();
    await expect(page.getByRole('alert')).toHaveText('Please say what you would like changed.');
    expect(actions(api)).not.toContain('respond');
});

test('a dead link says only that it is no longer active', async ({ page, api }) => {
    api.set('review-link-public', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'gone' }) }));
    await page.goto(`/r/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'This link is no longer active' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeHidden();
});

test('no horizontal scroll at phone width', async ({ page, api }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    api.set('review-link-public', { ...VIEW, versions: [{ ...VIEW.versions[0], caption: 'x'.repeat(400) }] });
    await page.goto(`/r/${TOKEN}`);
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(fits).toBe(true);
});

test('the subscriber shares a post, sees the response, and nothing acts until they press a button', async ({ page, api, signedIn, pageErrors }) => {
    const slot = new Date(Date.now() + 2 * 86400_000).toISOString();
    const draft = { id: 601, assistantId: 7, assistantName: 'Social Assistant', platform: 'facebook', status: 'pending_approval', caption: 'Hello there', publishDate: slot, generatedAt: slot };
    api.set('check-capacity', { connectedPlatforms: ['facebook'] });
    api.set('get-social-drafts', (route) => (
        new URL(route.request().url()).searchParams.get('status') === 'pending_approval'
            ? { drafts: [draft], total: 1, hasMore: false }
            : { drafts: [], total: 0, hasMore: false }
    ));
    api.set('review-link', (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === 'POST') return { url: `https://example.test/r/${TOKEN}`, linkId: 1, expiresAt: slot, emailed: false };
        if (url.searchParams.get('postIds')) return { statuses: { 601: { label: 'Sarah <b>asked for changes', at: slot } } };
        return { links: [{ id: 1, label: 'for Sarah', state: 'live', viewed: true, createdAt: slot, expiresAt: slot, responses: [
            { id: 9, guestName: 'Sarah <img src=x onerror=window.__hacked=1>', decision: 'changes', body: 'Shorter <b>please</b>', createdAt: slot, changedSince: true },
        ] }] };
    });

    await openWorkspace(page, 'review-queue');
    // The chip on the card: a guest's name stays text.
    await expect(page.getByText('Sarah <b>asked for changes')).toBeVisible();
    await page.getByRole('button', { name: /^Review all/ }).click();

    const share = page.locator('#post-review-share');
    await expect(share.getByText('Changed since this response')).toBeVisible();
    await expect(share.getByText('Shorter <b>please</b>')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __hacked?: number }).__hacked)).toBeUndefined();

    await share.getByRole('button', { name: 'Share for review' }).click();
    await share.getByLabel(/Who's it for/).fill('for Sarah');
    await share.getByRole('button', { name: 'Create link' }).click();
    await expect(share.getByRole('textbox', { name: 'Review link' })).toHaveValue(`https://example.test/r/${TOKEN}`);
    const created = api.called('review-link').find((c) => c.method === 'POST');
    expect(created?.body).toMatchObject({ action: 'create', postId: 601, label: 'for Sarah' });

    // Using a comment only fills the user's own box. No rewrite starts until they press Regenerate.
    await share.getByRole('button', { name: 'Use these comments' }).click();
    await expect(page.locator('#post-review-feedback')).toHaveValue('Shorter <b>please</b>');
    expect(api.called('request-post-changes')).toEqual([]);
    expect(api.called('approve-post')).toEqual([]);
    expect(pageErrors).toEqual([]);
});
