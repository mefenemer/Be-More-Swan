// Runs in the `phone` project only (Pixel 7, see playwright.config.ts).
//
// No sideways scroll on a phone. Compares documentElement.scrollWidth with clientWidth — NOT
// innerWidth, which mobile emulation widens to the overflow, so it would hide the very thing tested.
// The stubbed data is empty, so this catches fixed-width layout, not a wide table of real rows.
import { test, expect, openWorkspace } from './fixtures';

const pages = ['/', '/login.html', '/pricing.html', '/how-it-works.html', '/faq.html'];
for (const path of pages) {
    test(`public page ${path} has no sideways scroll`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const { scroll, client } = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
        }));
        expect(scroll, `${path} is ${scroll - client}px wider than the screen`).toBeLessThanOrEqual(client);
    });
}

for (const view of ['dashboard', 'notifications', 'assistants', 'review-queue', 'calendar', 'audience', 'settings', 'billing']) {
    test(`workspace ${view} has no sideways scroll`, async ({ page, signedIn }) => {
        await openWorkspace(page, view);
        await page.waitForLoadState('networkidle');
        const { scroll, client } = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
        }));
        expect(scroll, `${view} is ${scroll - client}px wider than the screen`).toBeLessThanOrEqual(client);
    });
}
