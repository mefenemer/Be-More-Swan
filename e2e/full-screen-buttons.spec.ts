// One place for Full screen and New on every live assistant (owner, 2026-11-07): at the right of the tab's header, Full
// screen immediately before the New button. Plus Blog setup as a sub tab of Blogs, and Team Chat's place in Notifications.

import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

function stubRole(api: ApiStub, roleKey: string) {
    api.set('get-assistant-context', { id: 9, name: 'Mira', role: 'Role', roleKey, status: 'working', lifecycleStatus: 'active', context: {}, goals: [], configuration: {} });
}
async function open(page: Page) {
    await openWorkspace(page);
    await page.evaluate(() => (window as any).loadView('assistant-detail', 9));
    await expect(page.locator('#assistant-detail-content')).toBeVisible();
}

test.use({ viewport: { width: 1600, height: 1000 } });

// role, its tab, the New button's words ('' = it has none)
const TABS: [string, string, string][] = [
    ['social_media_manager', 'review-queue', 'Create a Post'],
    ['blog_writer', 'review-queue', 'Write Blog Post'],
    ['newsletter_editor', 'review-queue', 'Write Email'],
    ['campaign_orchestrator', 'campaigns', 'New campaign'],
    ['brand_designer', 'briefs', 'New brief'],
    ['video_producer', 'videos', 'New video'],
    ['lead_qualifier', 'signals', 'Find New Leads'],
    ['lead_qualifier', 'datahub', 'Add Lead'],
    ['accounts_receivable_clerk', 'datahub', 'Chase an Invoice'],
    ['business_mentor', 'mentor', ''],
    ['business_mentor', 'mentorplan', ''],
    ['mystery_shopper', 'website', ''],
];

for (const [role, tab, newWords] of TABS) {
    test(`${role} / ${tab}: Full screen is there${newWords ? `, with ${newWords} beside it` : ''}`, async ({ page, api, signedIn, pageErrors }) => {
        stubRole(api, role);
        api.set('signal-inbox', { signals: [], items: [], savedSearches: [] });
        api.set('discovery-campaigns', { campaigns: [], savedSearches: [] });
        api.set('assistant-records', { records: [], total: 0 });
        await open(page);
        await page.locator(`#maintab-btn-${tab}`).click();
        const panel = page.locator(`#maintab-${tab}`);
        await expect(panel).toBeVisible();
        const full = panel.getByRole('button', { name: 'Full screen', exact: true }).first();
        await expect(full).toBeVisible();
        // The row it sits in ends at the right of the tab, wherever the assistant is.
        // (Beside a chat docked inside the tab, that means the right of the work, not of the chat.)
        const gap = await full.evaluate((el) => {
            const work = el.closest('.chatpane-dock')?.firstElementChild ?? el.closest('.main-tab-content')!;
            return work.getBoundingClientRect().right - el.parentElement!.lastElementChild!.getBoundingClientRect().right;
        });
        expect(gap).toBeLessThan(40);
        if (newWords) {
            const next = await full.evaluateHandle((el) => el.nextElementSibling);
            expect(await next.evaluate((el) => (el as HTMLElement | null)?.innerText?.trim() ?? '')).toBe(newWords);
        }
        await full.click();
        const exit = panel.getByRole('button', { name: 'Exit full screen', exact: true }).first();
        await expect(exit).toBeVisible();
        const hit = await exit.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + 5, r.y + 5)); });
        expect(hit).toBe(true);
        await page.keyboard.press('Escape');
        await expect(panel.getByRole('button', { name: 'Full screen', exact: true }).first()).toBeVisible();
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
        expect(pageErrors).toEqual([]);
    });
}

test('Blog setup is a sub tab of Blogs, and an article opened from there still has what it needs', async ({ page, api, signedIn, pageErrors }) => {
    stubRole(api, 'blog_writer');
    api.set('save-widget-config', { config: { publicKey: 'e2e-key' } });
    api.set('blog-posts', { post: { id: 41, assistantId: 9, title: 'Fresh beans', status: 'draft', bodyMarkdown: 'Words.' }, posts: [] });
    await open(page);
    await expect(page.locator('#detail-rq-setup-btn')).toHaveCount(0);
    const pill = page.locator('#detail-rq-col-setup');
    await pill.click();
    await expect(pill).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#detail-rq-groups')).toBeHidden();
    const panel = page.locator('#detail-rq-blog-setup');
    await expect(panel.locator('[data-bs-sec="search"]')).toBeVisible();
    await expect(panel.locator('[data-bs-sec="widget"]')).toBeVisible();
    await expect(page.locator('#bms-blog-backdrop')).not.toHaveClass(/bs-open/);
    await page.screenshot({ path: 'test-results/blog-setup-subtab.png' });

    // The studio takes its sections back while it is open, and the tab has them again afterwards.
    await page.evaluate(() => (window as any).openBlogStudio({ postId: 41, assistantId: 9 }));
    await expect(page.locator('#bs-editor .bmsme-block').first()).toBeVisible();
    expect(await panel.locator('[data-bs-sec]').count()).toBe(0);
    await page.evaluate(() => (window as any).closeBlogStudio());
    await expect(panel.locator('[data-bs-sec="widget"]')).toBeVisible();

    await page.locator('.detail-rq-col[data-status="scheduled"]').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#detail-rq-groups')).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test('Notifications: Needs you, Updates, then Team Chat', async ({ page, signedIn, pageErrors }) => {
    await openWorkspace(page);
    await page.evaluate(() => (window as any).loadView('notifications'));
    const tabs = page.locator('[role="tablist"][aria-label="Notifications"] [role="tab"]');
    await expect(tabs).toHaveCount(3);
    const words = (await tabs.allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
    expect(words).toEqual(['Needs you', 'Updates', 'Team Chat']);
    await tabs.nth(2).click();
    await expect(page.locator('#notif-messages-panel')).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test('Brand Designer calendar: a brief appears when received, drafted, approved and due', async ({ page, api, signedIn, pageErrors }) => {
    const today = new Date();
    const due = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-15`;
    stubRole(api, 'brand_designer');
    api.set('brand-briefs', (_route, body) => (body as { action?: string }).action === 'calendar'
        ? { items: [
            { id: 3, kind: 'brief_received', title: 'Summer flyer', at: `${due.slice(0, 8)}10T09:00:00.000Z` },
            { id: 3, kind: 'brief_drafted', title: 'Summer flyer', at: `${due.slice(0, 8)}11T09:00:00.000Z` },
            { id: 3, kind: 'brief_approved', title: 'Summer flyer', at: `${due.slice(0, 8)}12T09:00:00.000Z` },
            { id: 3, kind: 'brief_due', title: 'Summer flyer', at: due },
        ] }
        : { briefs: [], options: [] });
    await open(page);
    await page.locator('#maintab-btn-calendar').click();
    const host = page.locator('#assistant-calendar-host');
    await expect(host.getByText('Summer flyer')).toHaveCount(4);
    for (const label of ['Brief received', 'Options drafted', 'Approved', 'Brief due']) await expect(page.locator('#cal-status-legend')).toContainText(label);
    expect(pageErrors).toEqual([]);
});
