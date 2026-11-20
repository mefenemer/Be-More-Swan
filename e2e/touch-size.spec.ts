// Phone tap targets (fix/touch-size-utilities): 100+ buttons carry `min-h-[44px] sm:min-h-0`, but the committed
// style.css never contained either class, so no button was 44px tall on a phone. This loads the real style.css and
// measures a typical button at phone and desktop widths.

import { test, expect } from './fixtures';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50 p-4">
  <button type="button" id="b" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button>
  <button type="button" id="icon" class="min-w-[44px] min-h-[44px] sm:min-h-0 p-1">×</button>
</body></html>`;

async function open(page: import('@playwright/test').Page) {
    await page.route('**/e2e-touch-size.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-touch-size.html');
}

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('buttons with min-h-[44px] are at least 44px tall, and min-w-[44px] 44px wide', async ({ page }) => {
        await open(page);
        const b = (await page.locator('#b').boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(44);
        const icon = (await page.locator('#icon').boundingBox())!;
        expect(icon.width).toBeGreaterThanOrEqual(44);
        expect(icon.height).toBeGreaterThanOrEqual(44);
    });
});

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test('from the sm breakpoint up, sm:min-h-0 gives the button back its normal height', async ({ page }) => {
        await open(page);
        const b = (await page.locator('#b').boundingBox())!;
        expect(b.height).toBeLessThan(44);
    });
});
