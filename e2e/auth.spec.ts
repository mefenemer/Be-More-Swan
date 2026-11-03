import { test, expect } from './fixtures';

test('signed out, the workspace sends you to the login page', async ({ page }) => {
    await page.goto('/workspace.html');
    await expect(page).toHaveURL(/\/login(\.html)?$/);
});

test('login posts the email and shows "Check your email" whatever the answer', async ({ page, api }) => {
    // The page must not reveal whether an account exists, so a 404 from the function still reads
    // as success.
    api.set('login', { status: 404, json: { error: 'no such user' } });
    await page.goto('/login.html');
    await page.getByLabel('Email Address').fill('  Owner@Example.com ');
    await page.getByRole('button', { name: 'Send Magic Link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.locator('#loginForm')).toBeHidden();
    const [call] = api.called('login');
    expect(call.method).toBe('POST');
    expect(call.body).toMatchObject({ email: 'owner@example.com' });
});
