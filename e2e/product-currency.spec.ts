// A product's price in pounds, dollars or euros (db/z-product-price-currency.sql, product-price.ts):
// Business Information ▸ Products & Services picks the currency beside the amount, a new item starts in
// the currency the business last used, and deposits say they're pounds only.

import { test, expect, openWorkspace } from './fixtures';

const USD_KIT = { id: 7, kind: 'product', name: 'Starter kit', price: '$49', priceType: 'fixed', priceAmount: 4900, priceUnit: null, priceCurrency: 'USD', status: 'active', sortOrder: 0, updatedAt: '2026-11-07T10:00:00Z' };

test('the price editor picks a currency, sends it, and a new item starts in the last one used', async ({ page, api, signedIn, pageErrors }) => {
    const products: Record<string, unknown>[] = [USD_KIT];
    api.set('org-products', (route, body) => {
        const m = route.request().method();
        if (m === 'GET') return { products, offer: { offers: ['products', 'bookings'], answered: true }, introOffer: null, callsToAction: { assistants: [], giftForms: [] } };
        const b = body as Record<string, unknown>;
        const symbol = ({ GBP: '£', USD: '$', EUR: '€' } as Record<string, string>)[String(b.priceCurrency)] || '£';
        const product = { ...b, id: 8, price: `${symbol}${b.priceAmount}`, priceAmount: Number(b.priceAmount) * 100, status: 'active', sortOrder: 1 };
        products.push(product);
        return { product };
    });
    await openWorkspace(page, 'assets');
    await page.locator('.bizinfo-tab[data-tab="products"]').click();
    await expect(page.getByText('$49')).toBeVisible();

    await page.locator('#op-add').click();
    const ed = page.locator('#op-editor');
    await ed.locator('#op-name').fill('Refill pack');
    await ed.locator('#op-price-type').selectOption('fixed');
    // Starts in dollars — the currency the last saved product is in.
    await expect(ed.locator('#op-price-currency')).toHaveValue('USD');
    await expect(ed.locator('#op-price-symbol')).toHaveText('$');
    await expect(ed.locator('#op-deposit-currency-note')).toBeVisible();

    await ed.locator('#op-price-currency').selectOption('EUR');
    await expect(ed.locator('#op-price-symbol')).toHaveText('€');
    await ed.locator('#op-price-currency').selectOption('GBP');
    await expect(ed.locator('#op-price-symbol')).toHaveText('£');
    await expect(ed.locator('#op-deposit-currency-note')).toBeHidden();
    await ed.locator('#op-price-currency').selectOption('USD');
    await ed.locator('#op-price-amount').fill('12');
    await page.screenshot({ path: 'test-results/product-currency.png' });
    await ed.locator('#op-save').click();

    const post = api.called('org-products').find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ name: 'Refill pack', priceType: 'fixed', priceAmount: '12', priceCurrency: 'USD' });
    await expect(page.getByText('$12')).toBeVisible();
    expect(pageErrors).toEqual([]);
});
