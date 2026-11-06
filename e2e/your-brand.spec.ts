// "Your brand" in every assistant's settings (owner, 2026-11-06): Brand Assets — the brand style, picture
// guidelines, files and links — reachable from the assistant's right-hand menu, through the same functions
// as Business Information ▸ Brand Assets, so a change in one is the change in the other.

import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const KIT = { brandKit: { primaryColor: '#123456', backgroundColor: '#ffffff', textColor: '#111111', fontFamily: null, source: 'manual' }, guidelines: { photoStyle: 'Bright, natural light', mustInclude: null, mustAvoid: 'Stock handshakes', secondaryColors: [] } };

function stubBrand(api: ApiStub, roleKey: string) {
    const store = {
        assets: [
            { id: 'a1', name: 'logo.png', isFile: true, category: 'logo', status: 'confirmed', externalUrl: null },
            { id: 'a2', name: 'Old brochure', isFile: true, category: 'general', status: 'failed', externalUrl: null },
        ] as Record<string, unknown>[],
    };
    api.set('get-assistant-context', { id: 9, name: 'Mira', roleKey, status: 'working', context: {}, goals: [] });
    api.set('brand-kit', KIT);
    api.set('get-workspace-assets', () => ({ assets: store.assets }));
    api.set('upload-asset', () => {
        store.assets.push({ id: 'a3', name: 'https://example.com/guide', isFile: false, category: 'logo', status: 'ready', externalUrl: 'https://example.com/guide' });
        return { ok: true };
    });
    api.set('delete-workspace-asset', (route) => {
        const id = new URL(route.request().url()).searchParams.get('assetId');
        store.assets = store.assets.filter((a) => a.id !== id);
        return { ok: true };
    });
    return store;
}

async function openAssistant(page: Page) {
    await openWorkspace(page);
    await page.evaluate(() => (window as any).loadView('assistant-detail', 9));
    await expect(page.locator('#assistant-detail-content')).toBeVisible();
}
// The settings' section cards, which the right-hand menu is built from (and the pop-over shows where there is no menu).
const settingsCard = (page: Page, tab: string) => page.locator(`#tab-profile-home .detail-tab-btn[data-tab="${tab}"]`);

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the right-hand menu opens Your brand, with the style and the files from Brand Assets', async ({ page, api, signedIn, pageErrors }) => {
        // The Brand Designer has the right-hand menu (compactHeader) and nothing else on the old strategy panel.
        stubBrand(api, 'brand_designer');
        await openAssistant(page);
        await expect(page.locator('#rm-items .rm-item[data-rm-tab="brand"]')).toHaveCount(1);
        await expect(page.locator('#rm-items .rm-item[data-rm-tab="strategy"]')).toHaveCount(0);
        await page.locator('#rm-items .rm-item[data-rm-tab="brand"]').click();
        const panel = page.locator('#tab-brand');
        await expect(page.locator('#brief-drawer-title')).toHaveText('Your brand');
        await expect(panel.getByText('Shared by all your assistants.')).toBeVisible();
        await expect(panel.locator('#module-brand-style').getByText('Bright, natural light')).toBeVisible();
        await expect(panel.locator('#module-brand-style [data-brand-style-edit]')).toBeVisible();
        await expect(panel.getByText('logo.png')).toBeVisible();
        await expect(panel.getByText('Not used yet')).toBeVisible();
        await page.screenshot({ path: 'test-results/your-brand.png' });

        // Add a link: the same upload-asset call Brand Assets makes.
        await panel.locator('#bf-category').selectOption('logo');
        await panel.locator('#bf-url').fill('https://example.com/guide');
        await panel.getByRole('button', { name: 'Add link' }).click();
        await expect(panel.getByText('https://example.com/guide')).toBeVisible();
        expect(api.called('upload-asset')).toHaveLength(1);

        // Remove one: confirmed first, then the same delete-workspace-asset call.
        await panel.locator('[data-bf-remove="a2"]').click();
        await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
        await expect(panel.locator('[data-bf-list]').getByText('Old brochure')).toHaveCount(0);
        expect(api.called('delete-workspace-asset')[0].url).toContain('assetId=a2');
        expect(pageErrors).toEqual([]);
    });

    test('Blog keeps its writing card as "How I write" beside Your brand', async ({ page, api, signedIn, pageErrors }) => {
        stubBrand(api, 'blog_writer');
        await openAssistant(page);
        await expect(settingsCard(page, 'strategy')).toHaveText(/How I write/);
        await expect(settingsCard(page, 'strategy')).not.toHaveClass(/\bhidden\b/);
        await expect(settingsCard(page, 'brand')).toHaveText(/Your brand/);
        expect(pageErrors).toEqual([]);
    });

    test('a role with no writing card (Mystery Shopper) loses it, and keeps Your brand', async ({ page, api, signedIn, pageErrors }) => {
        stubBrand(api, 'mystery_shopper');
        await openAssistant(page);
        await expect(settingsCard(page, 'strategy')).toHaveClass(/\bhidden\b/);
        await expect(settingsCard(page, 'brand')).not.toHaveClass(/\bhidden\b/);
        expect(pageErrors).toEqual([]);
    });
});
