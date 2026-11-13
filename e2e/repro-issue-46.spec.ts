// Issue #46: "Checklist item stays unticked after answering". The owner saw two ticked boxes under "What does
// your business offer?" on Business Information ▸ Products & Services, but the Mentor's Set-up checklist
// still said "To do". On prod their workspace had NO saved answer: the two ticks were our GUESS
// (offer-profile.ts loadOfferProfile → services + bookings, answered: false), pre-ticked so they look the
// same as a saved answer. A tick only saves when a box CHANGES, so agreeing with the guess saved nothing.
// Now a guess says plainly that it isn't saved, and one button saves it as it stands.

import { test, expect, openWorkspace } from './fixtures';

test('a guessed answer says it is not saved, and "That\'s right, save it" saves it as it stands', async ({ page, api, signedIn, pageErrors }) => {
    let offer = { offers: ['services', 'bookings'], answered: false };
    api.set('org-products', (route, body) => {
        if (route.request().method() === 'GET') return { products: [], offer, introOffer: null, callsToAction: { assistants: [], giftForms: [] } };
        const b = body as { offer?: string[] };
        if (b?.offer) { offer = { offers: b.offer, answered: true }; return { offer }; }
        return {};
    });
    await openWorkspace(page, 'assets');
    await page.locator('.bizinfo-tab[data-tab="products"]').click();

    const box = page.locator('#op-offer');
    await expect(box).toBeVisible();
    // The guess is pre-ticked, exactly what the owner saw.
    await expect(box.locator('[data-op-offer][value="services"]')).toBeChecked();
    await expect(box.locator('[data-op-offer][value="bookings"]')).toBeChecked();

    // It must say it is NOT saved, and offer to save it without changing a tick.
    await expect(box.locator('#op-offer-note')).toContainText('Not saved yet');
    const confirm = box.locator('#op-offer-confirm');
    await expect(confirm).toBeVisible();
    await confirm.click();

    const patch = api.called('org-products').find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ offer: ['services', 'bookings'] });
    // Saved: the warning and the button go.
    await expect(confirm).toBeHidden();
    await expect(box.locator('#op-offer-note')).not.toContainText('Not saved yet');
    expect(pageErrors).toEqual([]);
});

test('a saved answer shows no warning and no confirm button', async ({ page, api, signedIn }) => {
    api.set('org-products', { products: [], offer: { offers: ['services'], answered: true }, introOffer: null, callsToAction: { assistants: [], giftForms: [] } });
    await openWorkspace(page, 'assets');
    await page.locator('.bizinfo-tab[data-tab="products"]').click();
    await expect(page.locator('#op-offer')).toBeVisible();
    await expect(page.locator('#op-offer-confirm')).toBeHidden();
});
