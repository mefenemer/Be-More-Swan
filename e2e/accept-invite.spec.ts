import { test, expect } from './fixtures';

const LINK = '/accept-invite.html?token=abc&orgId=42&role=viewer&sig=signed';

test('opening an invite only reads it, and only the click accepts', async ({ page, api }) => {
    api.set('accept-invite', { orgName: 'Acme', role: 'viewer', email: 's•••@example.test' });
    await page.goto(LINK);

    await expect(page.getByRole('heading', { name: 'Join Acme' })).toBeVisible();
    await expect(page.getByText("You'll join as a viewer, using s•••@example.test.")).toBeVisible();
    // This is all a scanner ever does: read the invite, and nothing more.
    expect(api.called('accept-invite').map((c) => c.method)).toEqual(['GET']);
    expect(api.called('accept-invite')[0].url).toContain('sig=signed');

    api.set('accept-invite', { success: true, redirect: '/login.html?arrived=1' });
    await page.getByRole('button', { name: 'Join workspace' }).click();

    await expect(page).toHaveURL(/arrived=1/);
    const [, accept] = api.called('accept-invite');
    expect(accept.method).toBe('POST');
    expect(accept.body).toEqual({ token: 'abc', orgId: '42', role: 'viewer', sig: 'signed' });
});

test('a bad link says so and offers no button', async ({ page, api }) => {
    api.set('accept-invite', { status: 400, json: { error: 'Invalid invite link. Please ask your workspace admin to send a new invite.' } });
    await page.goto(LINK);

    await expect(page.getByText('Invalid invite link.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join workspace' })).toBeHidden();
    expect(api.called('accept-invite').map((c) => c.method)).toEqual(['GET']);
});

test('an expired invite says so', async ({ page, api }) => {
    api.set('accept-invite', { status: 410, json: { error: 'Please ask your workspace admin to send a new invite.', expired: true } });
    await page.goto(LINK);

    await expect(page.getByRole('heading', { name: 'This invite has expired' })).toBeVisible();
});

test('if accepting fails, it shows why', async ({ page, api }) => {
    api.set('accept-invite', { orgName: 'Acme', role: 'member', email: 's•••@example.test' });
    await page.goto(LINK);
    api.set('accept-invite', { status: 400, json: { error: 'Invalid invite link.' } });
    await page.getByRole('button', { name: 'Join workspace' }).click();

    await expect(page.getByText('Invalid invite link.')).toBeVisible();
});

test('a link missing its token asks nothing of the server', async ({ page, api }) => {
    await page.goto('/accept-invite.html?orgId=42');

    await expect(page.getByText('Invalid invite link.')).toBeVisible();
    expect(api.called('accept-invite')).toHaveLength(0);
});
