// The post preview in the editor uses the page it is given.
//
// Stacked on a wide, short window, the card was fitted to the height left under the platform tabs. A
// narrow card wrapped those tabs onto three rows, which left less height, which narrowed the card: a
// 260px strip between two empty bands with its caption below the fold.
import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const SCREENSHOT = process.env.PREVIEW_SHOT_DIR;
// A 4:5 picture: the shape a feed post is, and the one with the least width to spare at a given height.
const PORTRAIT = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#8a9a8f"/></svg>',
)}`;

function stubCrossPost(api: ApiStub) {
    const slot = new Date(Date.now() + 2 * 86400_000).toISOString();
    const drafts = ['instagram', 'facebook', 'x'].map((platform, i) => ({
        id: 601 + i,
        assistantId: 7,
        assistantName: 'Social Assistant',
        platform,
        status: 'pending_approval',
        crosspostGroupId: 'g1',
        thumbnailUrl: PORTRAIT,
        caption: 'Holding the whole business in your head is exhausting. Here is one thing to hand over this week.',
        publishDate: slot,
        generatedAt: slot,
    }));
    api.set('check-capacity', { connectedPlatforms: ['instagram', 'facebook', 'x'] });
    api.set('get-social-drafts', (route) => (
        new URL(route.request().url()).searchParams.get('status') === 'pending_approval'
            ? { drafts, total: drafts.length, hasMore: false }
            : { drafts: [], total: 0, hasMore: false }
    ));
}

async function openPost(page: Page) {
    await openWorkspace(page, 'review-queue');
    await page.getByRole('button', { name: /^Review all/ }).click();
    await expect(page.locator('#post-review-body [data-media-img]')).toBeVisible();
    await page.waitForFunction(() => {
        const img = document.querySelector('#post-review-body [data-media-img]') as HTMLImageElement | null;
        return !!img && img.naturalWidth > 0;
    });
    await page.waitForTimeout(300);   // the rail appearing is a width change the fit answers
}

const box = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
});

test.describe('wide window', () => {
    test.use({ viewport: { width: 1915, height: 833 } });

    test('a photo post sits beside its words, whole picture and caption on screen', async ({ page, api, signedIn, pageErrors }) => {
        stubCrossPost(api);
        await openPost(page);

        const media = await box(page, '#post-review-body [data-media-host]');
        const words = await box(page, '#post-review-body [data-caption-host]');
        const scroller = await page.locator('#post-review-body').evaluate((el) => {
            const r = el.closest('.overflow-y-auto')!.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
        });

        if (SCREENSHOT) await page.screenshot({ path: `${SCREENSHOT}/wide.png` });

        expect(media.width).toBeGreaterThan(380);
        expect(words.left).toBeGreaterThanOrEqual(media.right - 1);
        expect(media.bottom).toBeLessThanOrEqual(scroller.bottom);
        expect(words.top).toBeLessThan(scroller.bottom);

        // One row of platform tabs: the loop this replaces began with them wrapping.
        const rows = await page.locator('#post-review-tabs > div > *').evaluateAll(
            (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top / 8))).size,
        );
        expect(rows).toBe(1);
        expect(pageErrors).toEqual([]);
        // A ResizeObserver loop is not a pageerror, but the page's own catcher shows it to the customer.
        await expect(page.getByText('Something went wrong on this page').first()).toBeHidden();
    });

    test('the media panel offers one generate button, named after the post\'s assistant', async ({ page, api, signedIn, pageErrors }) => {
        stubCrossPost(api);
        const asked: string[] = [];
        page.on('request', (r) => { if (r.url().includes('/brand-briefs')) asked.push(r.postData() || ''); });
        await openPost(page);

        await page.evaluate(() => (window as unknown as { _gpSyncAssistantLabels: () => void })._gpSyncAssistantLabels());
        await expect(page.locator('#gp-ai-gen-label').first()).toHaveText('Ask Social Assistant to generate');
        await expect(page.locator('#gp-ai-src-ai')).toHaveCount(1);
        await expect(page.locator('#gp-ai-src-designer')).toHaveCount(0);
        expect(await page.locator('#gp-ai-media-actions').first().textContent()).not.toContain('Brand Designer');
        expect(asked.filter((body) => body.includes('post_brief'))).toEqual([]);
        expect(pageErrors).toEqual([]);
    });

    test('folding the setup steps gives the room to the post', async ({ page, api, signedIn }) => {
        stubCrossPost(api);
        await page.setViewportSize({ width: 1100, height: 833 });
        await openPost(page);
        const before = await box(page, '#post-review-body [data-mockup-card]');

        await page.locator('#pce-rail [onclick*="_pceFoldColumn"]').click();
        await expect.poll(async () => (await box(page, '#post-review-body [data-mockup-card]')).width)
            .toBeGreaterThan(before.width);
    });
});

test.describe('narrow window', () => {
    test.use({ viewport: { width: 820, height: 1000 } });

    test('the post stays stacked when there is no room beside it', async ({ page, api, signedIn }) => {
        stubCrossPost(api);
        await page.setViewportSize({ width: 620, height: 1000 });
        await openPost(page);
        const media = await box(page, '#post-review-body [data-media-host]');
        const words = await box(page, '#post-review-body [data-caption-host]');
        if (SCREENSHOT) await page.screenshot({ path: `${SCREENSHOT}/narrow.png` });
        expect(words.top).toBeGreaterThanOrEqual(media.bottom - 1);
    });
});
