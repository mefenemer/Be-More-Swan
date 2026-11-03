import { test, expect, openWorkspace } from './fixtures';

test('the workspace opens on the dashboard with no script errors', async ({ page, signedIn, pageErrors }) => {
    await openWorkspace(page);
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    expect(pageErrors).toEqual([]);
});

// Every sidebar view loads, gets its title and throws nothing. Catches a view whose fragment or
// init script broke — the injected <script> blocks run only in a browser.
for (const view of ['notifications', 'assistants', 'review-queue', 'calendar', 'audience', 'settings', 'help', 'billing']) {
    test(`the ${view} view loads without script errors`, async ({ page, signedIn, pageErrors }) => {
        await openWorkspace(page, view);
        expect(pageErrors).toEqual([]);
    });
}
