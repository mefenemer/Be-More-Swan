// Placeholder pictures and videos on a first draft (owner, 2026-11-06): the Website tab's set-up step
// and the chat's draft card offer the same choice, state AI's cost in tasks before the click, and send
// it to the same `draft` action. Every function is stubbed: nothing reaches Pexels, fal or a model.

import { test, expect } from './fixtures';
import { normaliseSiteDefinition, SECTION_TYPES } from '../src/utils/site-definition';

const definition = normaliseSiteDefinition({
    theme: { primaryColor: '#2D6A4F', textColor: '#1f2937', backgroundColor: '#ffffff', font: 'sans', radius: 'medium' },
    settings: { siteName: 'Fern & Co', businessType: 'LocalBusiness', features: ['faq'] },
    pages: [{ id: 'home', slug: '', title: 'Home', sections: [{ id: 'hero', type: 'hero', props: { layout: 'centered', headline: 'Flowers for Leeds' } }] }],
}).definition;

const draftMedia = (over: Record<string, unknown> = {}) => ({
    images: { aiAllowed: true, aiWhyNot: null, aiTasksEach: 1, aiMax: 4, stockMax: 8 },
    videos: { aiAllowed: true, aiWhyNot: null, aiTasksEach: 24, aiMax: 1, stockMax: 2 },
    answers: { images: null, videos: null },
    ...over,
});

const siteView = (media: unknown = draftMedia()) => ({
    import: null, importSuggestUrl: null,
    site: { id: 1, status: 'draft', credit: true, drafting: false, draftNote: null, slug: null, url: null, domain: 'bemoreswan.site', freeUrl: null, suggestedSlug: 'fern', publishedVersion: null, publishedAt: null, unpublishedChanges: false, customDomain: null, canSplit: false, suspendedReason: null, publishBlocker: null },
    draftMedia: media,
    definition, warnings: [], maxPages: null, placeholders: [], assetUrls: {}, forms: [], catalogue: [],
    reviews: { summary: null, list: [] }, social: { platforms: [], published: [] }, blog: { published: 0 },
    payments: { connected: false, chargesEnabled: false, detailsSubmitted: false, canConnect: true },
    booking: { ready: false, hours: [], mode: 'request', visitAddress: null, whatsapp: null, services: [], resources: [], waiting: 0 },
    newOrders: 0, newEnquiries: 0, templates: [],
    vocab: { sectionTypes: SECTION_TYPES, fonts: [], features: [], limits: {} },
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="site-editor-host" data-site-host="website"></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/components/media-picker.js"></script>
  <script src="/src/components/assistant-site-editor.js"></script>
  <script>AssistantSiteEditor.init({ assistantId: 7, assistantName: 'Wren' }); AssistantSiteEditor.activate('website');</script>
</body></html>`;

const CARD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body>
  <div id="host"></div>
  <script src="/src/components/disruptive-ui-registry.js"></script>
  <script>
    window.sent = null;
    const host = document.getElementById('host');
    host.addEventListener('site:draftOptions', (e) => e.detail.respond(window.options));
    host.addEventListener('site:draft', (e) => { window.sent = { request: e.detail.request, media: e.detail.media }; e.detail.respond({ ok: true }); });
    window.show = (ui, options) => {
      window.options = options;
      host.appendChild(window.DisruptiveUIRegistry.render(ui));
    };
  </script></body></html>`;

test.describe('Website tab', () => {
    test.beforeEach(async ({ page, api }) => {
        await page.route('**/e2e-website-draft-media.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        api.set('site-preview', async (route) => { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>x</title>' }); });
    });

    const openDraftStep = async (page: import('@playwright/test').Page) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto('/e2e-website-draft-media.html');
        await page.locator('#site-subtab-setup').click();
        await page.getByRole('button', { name: 'Skip this step' }).click();
    };

    test('a new site offers stock, AI or none, with AI\'s cost in tasks, and sends what was chosen', async ({ page, api, pageErrors }) => {
        api.set('sites', siteView());
        await openDraftStep(page);

        const pictures = page.locator('[data-site-draft-images]');
        const videos = page.locator('[data-site-draft-videos]');
        await expect(pictures).toHaveValue('stock');
        await expect(videos).toHaveValue('none');
        await expect(pictures.locator('option')).toHaveText(['Stock photos (free)', 'AI-made: 1 task each, up to 4 tasks', 'No pictures']);
        await expect(videos.locator('option')).toHaveText(['Stock videos (free)', 'AI-made: 24 tasks for one clip', 'No videos']);

        await pictures.selectOption('ai');
        await videos.selectOption('ai');
        await page.getByRole('button', { name: 'Write my site' }).click();
        const dialog = page.locator('#aura-confirm-modal');
        await expect(dialog).toContainText('uses 1 task, plus up to 4 tasks for AI pictures and 24 tasks for an AI video');
        await dialog.getByRole('button', { name: 'Draft my site' }).click();

        await expect.poll(() => api.called('sites').find((c) => (c.body as { action?: string })?.action === 'draft')?.body).toMatchObject({ action: 'draft', media: { images: 'ai', videos: 'ai' } });
        expect(pageErrors).toEqual([]);
    });

    test('stock adds nothing to the stated cost', async ({ page, api }) => {
        api.set('sites', siteView());
        await openDraftStep(page);
        await page.getByRole('button', { name: 'Write my site' }).click();
        const dialog = page.locator('#aura-confirm-modal');
        await expect(dialog).toContainText('This uses 1 task.');
        await expect(dialog).not.toContainText('plus');
    });

    test('AI video the plan doesn\'t include is offered as unavailable, with the reason', async ({ page, api }) => {
        api.set('sites', siteView(draftMedia({ videos: { aiAllowed: false, aiWhyNot: 'AI video is on the Busywork Buster and Digital Employee plans.', aiTasksEach: 24, aiMax: 1, stockMax: 2 } })));
        await openDraftStep(page);
        await expect(page.locator('[data-site-draft-videos] option[value="ai"]')).toHaveAttribute('disabled', '');
        await expect(page.locator('[data-site-draft-media] + p')).toContainText('AI video is on the Busywork Buster');
    });

    test('their set-up answers are what the step starts on', async ({ page, api }) => {
        api.set('sites', siteView(draftMedia({ answers: { images: 'none', videos: 'stock' } })));
        await openDraftStep(page);
        await expect(page.locator('[data-site-draft-images]')).toHaveValue('none');
        await expect(page.locator('[data-site-draft-videos]')).toHaveValue('stock');
    });

    test('words first, then media: the tab says so, and a draft ready with media missing isn\'t called a failure', async ({ page, api, pageErrors }) => {
        const view = siteView();
        let site: Record<string, unknown> = { ...view.site, drafting: true, draftNote: 'Your words are written. Adding your pictures and videos now.', draftNoteIsFailure: false };
        api.set('sites', () => ({ ...view, site }));
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto('/e2e-website-draft-media.html');
        await page.locator('#site-subtab-setup').click();
        await expect(page.getByText('Your words are written. Adding your pictures and videos now.')).toBeVisible();

        site = { ...view.site, drafting: false, draftNote: 'Your draft is ready. 1 picture couldn\'t be found or made, and nothing was charged for it.', draftNoteIsFailure: false };
        await expect(page.getByText('1 picture couldn\'t be found or made').first()).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('The draft didn\'t finish')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('the real chat: the card from a reply offers the live choice and sends it to `draft`', async ({ page, api, pageErrors }) => {
        const options = draftMedia();
        api.set('sites', (_route: unknown, body: unknown) => ((body as { action?: string }).action === 'draft_options' ? options : siteView()));
        api.set('chat-orchestrator', { chatSessionId: 91, message: { id: 3, role: 'assistant', content: 'Here is your draft card.', uiElement: { type: 'site_draft_request', request: 'A friendly florist site', images: 'stock', videos: 'ai' } } });
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto('/e2e-website-draft-media.html');
        const input = page.locator('[data-sb-chat] [data-chat-input]');
        await input.fill('Write my whole site');
        await input.press('Enter');
        const videos = page.locator('[data-sd-videos]');
        await expect(videos).toHaveValue('ai');
        await expect(videos.locator('option[value="ai"]')).toHaveText('AI-made: 24 tasks for one clip');
        await page.getByRole('button', { name: 'Draft my whole site' }).click();
        await expect.poll(() => api.called('sites').find((c) => (c.body as { action?: string })?.action === 'draft')?.body).toMatchObject({ action: 'draft', assistantId: 7, request: 'A friendly florist site', media: { images: 'stock', videos: 'ai' } });
        expect(pageErrors).toEqual([]);
    });
});

test.describe('Chat card', () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/e2e-site-draft-card.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: CARD_PAGE }));
        await page.goto('/e2e-site-draft-card.html');
    });

    test('offers the same choice at the live price, starts on the assistant\'s pick, sends the owner\'s', async ({ page, pageErrors }) => {
        await page.evaluate((o) => (window as never as { show: (u: unknown, o: unknown) => void }).show({ type: 'site_draft_request', request: 'A friendly florist site', images: 'ai', videos: 'stock' }, o), draftMedia());
        const pictures = page.locator('[data-sd-images]');
        await expect(pictures).toHaveValue('ai');
        await expect(pictures.locator('option')).toHaveText(['Stock photos (free)', 'AI-made: 1 task each, up to 4 tasks', 'No pictures']);
        await expect(page.locator('[data-sd-videos] option[value="ai"]')).toHaveText('AI-made: 24 tasks for one clip');
        await expect(page.locator('[data-sd-videos]')).toHaveValue('stock');

        await page.locator('[data-sd-videos]').selectOption('none');
        await page.getByRole('button', { name: 'Draft my whole site' }).click();
        expect(await page.evaluate(() => (window as never as { sent: unknown }).sent)).toEqual({ request: 'A friendly florist site', media: { images: 'ai', videos: 'none' } });
        expect(pageErrors).toEqual([]);
    });

    test('AI isn\'t offered where it isn\'t allowed, or when the price couldn\'t be read', async ({ page }) => {
        await page.evaluate((o) => (window as never as { show: (u: unknown, o: unknown) => void }).show({ type: 'site_draft_request', request: '', images: 'ai', videos: 'ai' }, o),
            draftMedia({ videos: { aiAllowed: false, aiWhyNot: 'AI video is on the higher plans.', aiTasksEach: 24, aiMax: 1, stockMax: 2 } }));
        await expect(page.locator('[data-sd-images]')).toHaveValue('ai');
        await expect(page.locator('[data-sd-videos] option[value="ai"]')).toHaveCount(0);
        await expect(page.locator('[data-sd-videos]')).toHaveValue('none');
        await expect(page.locator('[data-sd-why]')).toHaveText('AI video is on the higher plans.');
    });

    test('with no price to hand, only the free choices are offered', async ({ page }) => {
        await page.evaluate(() => (window as never as { show: (u: unknown, o: unknown) => void }).show({ type: 'site_draft_request', request: '', images: 'ai' }, null));
        await expect(page.locator('[data-sd-images] option[value="ai"]')).toHaveCount(0);
        await expect(page.locator('[data-sd-images]')).toHaveValue('stock');
    });
});
