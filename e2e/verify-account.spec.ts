import { test, expect } from './fixtures';

const LINK = '/verify-account.html?token=abc&r=7.sig&b=proof';

test('the browser that asked for the link goes straight in, with no click', async ({ page, api }) => {
    api.set('verify', { success: true, redirect: '/login.html?arrived=1' });
    await page.goto(LINK);

    await expect(page).toHaveURL(/arrived=1/);
    const [call] = api.called('verify');
    expect(call.body).toMatchObject({ token: 'abc', auto: true, b: 'proof', r: '7.sig' });
});

test('anyone else sees Continue, and only the click asks to log in', async ({ page, api }) => {
    api.set('verify', { confirm: true, email: 'c•••@hotmail.co.uk' });
    await page.goto(LINK);

    await expect(page.getByText('Continue as c•••@hotmail.co.uk')).toBeVisible();
    // This is all a scanner ever does: the check on load, and nothing more.
    expect(api.called('verify')).toHaveLength(1);
    expect(api.called('verify')[0].body).toMatchObject({ auto: true });

    api.set('verify', { success: true, redirect: '/login.html?arrived=1' });
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/arrived=1/);
    expect(api.called('verify')[1].body).toMatchObject({ token: 'abc', auto: false });
});

test('a used link offers a new one without asking for the address', async ({ page, api }) => {
    api.set('verify', { status: 400, json: { error: 'Invalid or expired verification link.', spent: true, canRequestNew: true } });
    api.set('login', { message: 'If an account exists, a link was sent.' });
    await page.goto('/verify-account.html?token=abc&r=7.sig&tier=saver');

    await expect(page.getByRole('heading', { name: 'This link has already been used or has expired' })).toBeVisible();
    await expect(page.getByText('Verification Failed')).toHaveCount(0);
    await page.getByRole('button', { name: 'Email me a new link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a new link' })).toBeHidden();
    const [call] = api.called('login');
    expect(call.body).toMatchObject({ ref: '7.sig', tier: 'saver' });
});

test('a used link we can\'t trace sends them back to login', async ({ page, api }) => {
    api.set('verify', { status: 400, json: { error: 'Invalid or expired verification link.', spent: true, canRequestNew: false } });
    await page.goto('/verify-account.html?token=abc');

    await expect(page.getByRole('button', { name: 'Email me a new link' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Back to login' })).toBeVisible();
});

test('a locked account sees why, not an offer of a new link', async ({ page, api }) => {
    api.set('verify', { status: 403, json: { error: 'Your account has been locked.' } });
    await page.goto(LINK);

    await expect(page.getByRole('heading', { name: "We couldn't log you in" })).toBeVisible();
    await expect(page.getByText('Your account has been locked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a new link' })).toBeHidden();
});

test('if the check on load fails, the button is still there', async ({ page, api }) => {
    api.set('verify', async (route) => { await route.abort(); });
    await page.goto(LINK);

    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});
