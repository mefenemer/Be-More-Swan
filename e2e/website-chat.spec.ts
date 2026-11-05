// The Website tab as a chat-first builder (owner, 2026-11-04, after trying Lovable): the preview on
// the left, the assistant's chat docked on the right, the assistant's questions asked one at a time on
// a card, and "Select" on the preview putting the clicked part into the chat.
//
// The Website tab's own modules (assistant-site-editor.js, chat-session.js, disruptive-ui-registry.js)
// are mounted on a bare page so this needs no workspace stubs; the preview is the REAL renderer's
// output (site-render.ts) for a real normalised definition, and every function is stubbed.

import { test, expect } from './fixtures';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { SECTION_TYPES } from '../src/utils/site-definition';

const RAW = {
    theme: { primaryColor: '#2D6A4F', textColor: '#1f2937', backgroundColor: '#ffffff', font: 'sans', radius: 'medium' },
    settings: { siteName: 'Willowbrook Coffee', description: 'Fresh-roasted coffee for independent cafés in Yorkshire.', businessType: 'LocalBusiness', locality: 'Leeds', email: 'hello@willowbrook.example', phone: '0113 496 0000' },
    nav: [],
    pages: [{ id: 'home', slug: '', title: 'Home', seo: { title: null, description: null }, sections: [
        { id: 'hero', type: 'hero', props: { layout: 'centered', headline: 'Fresh-roasted coffee for Yorkshire cafés', subheadline: 'Delivered within 48 hours of roasting.', primaryCta: { label: 'Get a quote', href: '/' } } },
        { id: 'how', type: 'steps', props: { heading: 'How wholesale works', items: [{ title: 'Taste', body: 'A free tasting box.' }, { title: 'Choose', body: 'Pick your blends.' }] } },
        { id: 'faq', type: 'faq', props: { heading: 'Questions cafés ask', items: [{ q: 'Is there a minimum order?', a: '5kg a week.' }] } },
    ] }],
    footer: { text: 'Willowbrook Coffee Ltd, Leeds.' },
};
const definition = normaliseSiteDefinition(RAW).definition;
const previewHtml = renderSitePage(definition, '/', {
    origin: 'https://preview.invalid', preview: true, reportUrl: '#', creditUrl: null,
    pagePath: (p: string) => `/.netlify/functions/site-preview?assistantId=7&path=${encodeURIComponent(p)}`,
    assetUrl: () => '',
} as never).html;

const siteView = {
    import: null, importSuggestUrl: null,
    site: { id: 1, status: 'draft', credit: true, drafting: false, draftNote: null, slug: null, url: null, domain: 'bemoreswan.site', freeUrl: null, suggestedSlug: 'willowbrook', publishedVersion: 1, publishedAt: null, unpublishedChanges: false, customDomain: null, canSplit: false, suspendedReason: null, publishBlocker: null },
    definition, warnings: [], maxPages: null, placeholders: [], assetUrls: {}, forms: [], catalogue: [],
    reviews: { summary: null, list: [] }, social: { platforms: [], published: [] }, blog: { published: 0 },
    payments: { connected: false, chargesEnabled: false, detailsSubmitted: false, canConnect: true },
    booking: { ready: false, hours: [], mode: 'request', visitAddress: null, whatsapp: null, services: [], resources: [], waiting: 0 },
    newOrders: 0, newEnquiries: 0, templates: [],
    vocab: { sectionTypes: SECTION_TYPES, fonts: [], features: [], limits: {} },
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="site-editor-host" data-site-host="website"></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script>
  <script src="/src/components/media-picker.js"></script>
  <script src="/src/components/assistant-site-editor.js"></script>
  <script>AssistantSiteEditor.init({ assistantId: 7, assistantName: 'Wren' }); AssistantSiteEditor.activate('website');</script>
</body></html>`;

test.beforeEach(async ({ page, api }) => {
    await page.route('**/e2e-website-chat.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    api.set('sites', siteView);
    api.set('site-preview', async (route) => { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: previewHtml }); });
});

test('preview on the left, the chat docked on the right and open first', async ({ page, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/e2e-website-chat.html');
    const chatTab = page.getByRole('tab', { name: 'Chat' });
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await expect(input).toBeVisible();
    const frame = page.locator('iframe[data-site-preview]');
    await expect(frame).toBeVisible();
    const f = await frame.boundingBox();
    const c = await input.boundingBox();
    expect(f!.x).toBeLessThan(c!.x);
    // No swans in the preview beside a docked chat; a bigger message box.
    await expect(page.frameLocator('iframe[data-site-preview]').locator('#hero h1')).toBeVisible();
    await expect(page.frameLocator('iframe[data-site-preview]').locator('[data-bms-ask]')).toHaveCount(0);
    await expect(input).toHaveAttribute('rows', '4');
    // The chat pane ends level with the preview.
    const previewCard = await page.locator('[data-sb-preview-col] > div').boundingBox();
    const chatBox = await page.locator('[data-sb-chatbox]').boundingBox();
    expect(Math.abs((previewCard!.y + previewCard!.height) - (chatBox!.y + chatBox!.height))).toBeLessThan(3);
    const paneWidth = (await page.locator('[data-sb-pane]').boundingBox())!.width;
    // Another sub-tab swaps the chat for its panel; coming back finds the same chat, not a new one.
    await input.fill('kept while I look at Pages');
    await page.getByRole('tab', { name: 'Pages' }).click();
    await expect(input).toBeHidden();
    // Every sub-tab keeps the same pane width.
    expect((await page.locator('[data-sb-pane]').boundingBox())!.width).toBeCloseTo(paneWidth, 0);
    await chatTab.click();
    await expect(input).toHaveValue('kept while I look at Pages');
    await page.screenshot({ path: 'test-results/website-chat-layout.png' });
    expect(pageErrors).toEqual([]);
});

test('the assistant asks step by step; the answers go back as the user\'s message', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    let turn = 0;
    api.set('chat-orchestrator', () => {
        turn++;
        if (turn === 1) {
            return { chatSessionId: 55, message: { id: 1, role: 'assistant', content: 'Lovely — a few quick questions first.', uiElement: {
                type: 'chat_questions', questions: [
                    { question: 'What should visitors do first?', options: ['Get a quote', 'Call us', 'Order online'] },
                    { question: 'Which pages do you want?', options: ['Home', 'About', 'Wholesale', 'Contact'], multiple: true },
                    { question: 'How should it feel?', options: [{ label: 'Warm and friendly', description: 'Soft colours, rounded corners' }, 'Bold'] },
                ] } } };
        }
        return { chatSessionId: 55, message: { id: 2, role: 'assistant', content: 'Thanks — here is the draft.', uiElement: null } };
    });
    await page.goto('/e2e-website-chat.html');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await input.fill('A site for my coffee roastery that sells to cafés');
    await input.press('Enter');
    const card = page.locator('[data-sb-chat] [data-cq-send], [data-sb-chat] [data-cq-skip]').first();
    await expect(card).toBeVisible();
    await expect(page.getByText('1 of 3')).toBeVisible();
    await page.getByRole('button', { name: 'Get a quote' }).click();          // one answer → next question
    await expect(page.getByText('2 of 3')).toBeVisible();
    await page.getByRole('button', { name: /Home/ }).click();
    await page.getByRole('button', { name: /Wholesale/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('3 of 3')).toBeVisible();
    await expect(page.getByText('Soft colours, rounded corners')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: /Wholesale/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByPlaceholder('Or type something else…').fill('Calm, a bit premium');
    await page.screenshot({ path: 'test-results/website-chat-questions.png' });
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(page.getByText('Thanks — here is the draft.')).toBeVisible();
    const sent = api.called('chat-orchestrator')[1].body as { message: string; chatSessionId: number };
    expect(sent.chatSessionId).toBe(55);
    expect(sent.message).toBe('My answers:\n• What should visitors do first? — Get a quote\n• Which pages do you want? — Home, Wholesale\n• How should it feel? — Calm, a bit premium');
    await expect(page.getByText('Your answers')).toBeVisible();
    // Shown once, on the card — not again as a bubble.
    await expect(page.getByText('My answers:', { exact: false })).toHaveCount(0);
    await expect(page.locator('[data-sb-chat]').getByText('Home, Wholesale')).toHaveCount(1);
    // The thread is remembered for next time.
    expect(await page.evaluate(() => localStorage.getItem('bms-site-chat:7'))).toBe('55');
    expect(pageErrors).toEqual([]);
});

test('"Select": hover outlines a part of the preview, a click puts it on the chat', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    api.set('chat-orchestrator', { chatSessionId: 56, message: { id: 3, role: 'assistant', content: 'Here is a warmer headline.', uiElement: null } });
    await page.goto('/e2e-website-chat.html');
    await page.getByRole('button', { name: /Select/ }).click();
    const preview = page.frameLocator('iframe[data-site-preview]');
    const headline = preview.locator('#hero h1');
    await headline.hover();
    await expect(preview.getByText('Hero › heading “Fresh-roasted coffee for Yorkshire cafés”')).toBeVisible();
    await page.screenshot({ path: 'test-results/website-chat-select-hover.png' });
    await headline.click();
    const chip = page.locator('[data-sb-chat] [data-chat-ref]');
    await expect(chip).toContainText('Hero › heading');
    await expect(page.getByRole('button', { name: /Select/ })).toHaveAttribute('aria-pressed', 'false');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await expect(input).toBeFocused();
    await input.fill('Make it warmer');
    await page.screenshot({ path: 'test-results/website-chat-select-chip.png' });
    await input.press('Enter');
    await expect(page.getByText('Here is a warmer headline.')).toBeVisible();
    const sent = api.called('chat-orchestrator')[0].body as { message: string };
    expect(sent.message).toBe('About this part of my website: the Hero section (section hero) — the heading “Fresh-roasted coffee for Yorkshire cafés”.\n\nMake it warmer');
    await expect(chip).toBeHidden();
    expect(pageErrors).toEqual([]);
});

test('phone width: the chat comes first; selecting in the full-screen preview returns to the chat', async ({ page, pageErrors }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e-website-chat.html');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await expect(input).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Preview my site' }).click();
    await page.getByRole('button', { name: /Select/ }).click();
    await page.frameLocator('iframe[data-site-preview]').locator('#faq h2').click();
    await expect(page.locator('[data-sb-full]')).toHaveCount(0);
    await expect(page.locator('[data-sb-chat] [data-chat-ref]')).toContainText('Questions › heading');
    await page.screenshot({ path: 'test-results/website-chat-phone.png' });
    expect(pageErrors).toEqual([]);
});

test('a draft being written shows moving dots over the preview, and the chat hears when it lands', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    let drafting = true;
    api.set('sites', () => ({ ...siteView, site: { ...siteView.site, drafting } }));
    await page.goto('/e2e-website-chat.html');
    await expect(page.locator('[data-sb-drafting]')).toContainText('Wren is writing your site');
    await expect(page.locator('[data-sb-drafting] .sb-dots i')).toHaveCount(3);
    await page.screenshot({ path: 'test-results/website-chat-drafting.png' });
    drafting = false;
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('site:changed', { detail: { assistantId: 7 } })));
    await expect(page.locator('[data-sb-drafting]')).toHaveCount(0);
    await expect(page.locator('[data-sb-chat]').getByText('Your draft is ready')).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test('full screen: the editor fills the window, and the button or Esc puts it back', async ({ page, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/e2e-website-chat.html');
    await page.getByRole('button', { name: /Full screen/ }).click();
    const host = page.locator('[data-site-host="website"]');
    await expect(host).toHaveAttribute('data-sb-editor-full', '');
    const box = await host.boundingBox();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(1400);
    await page.screenshot({ path: 'test-results/website-chat-fullscreen.png' });
    await page.getByRole('button', { name: /Exit full screen/ }).click();
    await expect(host).not.toHaveAttribute('data-sb-editor-full', '');
    await page.getByRole('button', { name: /Full screen/ }).click();
    await page.keyboard.press('Escape');
    await expect(host).not.toHaveAttribute('data-sb-editor-full', '');
    expect(pageErrors).toEqual([]);
});

test('the paperclip opens upload / library / find stock / create — and a library picture rides with the message', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    api.set('content-assets', { assets: { pending: [{ id: 41, name: 'Harbour at dusk', assetType: 'image', status: 'approved', storageUrl: 'https://example.invalid/h.jpg' }], scheduled: [], posted: [] } });
    api.set('chat-orchestrator', { chatSessionId: 57, message: { id: 4, role: 'assistant', content: 'Lovely picture.', uiElement: null } });
    await page.route('https://example.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }));
    await page.goto('/e2e-website-chat.html');
    await page.locator('[data-sb-chat] label[title^="Add pictures"]').click();
    const picker = page.locator('#bms-media-picker');
    await expect(picker).toBeVisible();
    for (const t of ['Upload or library', 'Ask Wren to find stock', 'Ask Wren to create one']) await expect(picker.getByRole('button', { name: t })).toBeVisible();
    await expect(picker.getByText('Attach a document (Word, PDF, text)')).toBeVisible();
    await picker.getByRole('button', { name: 'Ask Wren to create one' }).click();
    await expect(picker.locator('[data-mp-ai-prompt]')).toHaveAttribute('placeholder', /Leave it blank and Wren decides/);
    await picker.getByRole('button', { name: 'Upload or library' }).click();
    await page.screenshot({ path: 'test-results/website-chat-paperclip.png' });
    await picker.locator('[data-mp-asset="41"]').click();
    await picker.getByRole('button', { name: 'Add 1' }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.locator('[data-sb-chat] [data-chat-chips]')).toContainText('Harbour at dusk');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await input.fill('Use this on the home page');
    await input.press('Enter');
    await expect(page.getByText('Lovely picture.')).toBeVisible();
    const body = api.called('chat-orchestrator')[0].body as { attachments: unknown[] };
    expect(body.attachments).toEqual([{ kind: 'image', assetId: 41, name: 'Harbour at dusk' }]);
    expect(pageErrors).toEqual([]);
});

test('a picture from the chat: the card finds options, the preview shows where it will go, a pick places it', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    api.set('chat-orchestrator', { chatSessionId: 58, message: { id: 5, role: 'assistant', content: 'Choose one on the card below.', uiElement: {
        type: 'site_picture', pageId: 'home', sectionId: 'how', sectionLabel: 'How wholesale works', place: 'after', source: 'stock', description: 'coffee being roasted', alt: 'Coffee being roasted' } } });
    api.set('get-ai-credit-balance', { canImage: true, imageCost: 1, unit: 'tasks' });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    api.set('pexels-search', async (route, body) => {
        const b = body as { action?: string };
        if (b.action === 'save') return { assetId: 77 };
        await held;   // keep the search open so the placeholder can be seen
        return { keywords: 'coffee roast', candidates: [1, 2, 3].map((i) => ({ providerAssetId: `p${i}`, url: `https://example.invalid/${i}.jpg`, title: `Roaster ${i}`, photographer: 'Ana' })) };
    });
    await page.route('https://example.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }));
    const applied: unknown[] = [];
    api.set('sites', (_route, body) => { const b = body as { action: string; ops?: unknown[] }; if (b.action === 'apply') applied.push(...(b.ops || [])); return siteView; });
    await page.goto('/e2e-website-chat.html');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await input.fill('Add a picture after this');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Find stock photos (free)' }).click();
    const placeholder = page.frameLocator('iframe[data-site-preview]').locator('[data-bms-picture-working]');
    await expect(placeholder).toContainText('Wren: Finding a picture');
    await page.waitForTimeout(900);   // the preview scrolls the placeholder into view
    await page.screenshot({ path: 'test-results/website-chat-picture-working.png' });
    release();
    await page.getByRole('button', { name: /Use photo 2/ }).click();
    await expect(page.getByText(/Done — it's after “How wholesale works”/)).toBeVisible();
    expect(applied).toEqual([{ op: 'add_section', pageId: 'home', index: 2, section: { type: 'gallery', props: { heading: null, intro: null, layout: 'natural', images: [{ assetId: 77, url: '', alt: 'Coffee being roasted', caption: null }] } } }]);
    await expect(placeholder).toHaveCount(0);
    expect(pageErrors).toEqual([]);
});

test('a video from the chat: the card switches to Video, finds stock videos and places one where it can play', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    api.set('chat-orchestrator', { chatSessionId: 59, message: { id: 6, role: 'assistant', content: 'Choose one on the card below.', uiElement: {
        type: 'site_picture', pageId: 'home', sectionId: 'hero', sectionLabel: 'Fresh-roasted coffee', place: 'in', kind: 'video', source: 'stock', description: 'coffee pouring', alt: 'Coffee pouring' } } });
    api.set('get-ai-credit-balance', { canImage: true, imageCost: 1, assistantCanVideo: true, tierCanVideo: false, videoCost: 4, unit: 'tasks' });
    const searched: unknown[] = [];
    api.set('pexels-search', (_route, body) => {
        const b = body as { action?: string; mediaType?: string };
        searched.push(b);
        if (b.action === 'save') return { assetId: 88 };
        return { keywords: 'coffee pour', candidates: [1, 2].map((i) => ({ providerAssetId: `v${i}`, url: `https://example.invalid/${i}.mp4`, title: `Pour ${i}` })) };
    });
    await page.route('https://example.invalid/**', (r) => r.fulfill({ status: 404, body: '' }));
    const applied: unknown[] = [];
    api.set('sites', (_route, body) => { const b = body as { action: string; ops?: unknown[] }; if (b.action === 'apply') applied.push(...(b.ops || [])); return siteView; });
    await page.goto('/e2e-website-chat.html');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await input.fill('A video in the hero');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Video', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Create with AI' })).toBeDisabled();   // this plan has no AI video
    await page.getByRole('button', { name: 'Find stock videos (free)' }).click();
    await page.getByRole('button', { name: 'Use video 1' }).click();
    await expect(page.getByText(/Done — it's in “Fresh-roasted coffee”/)).toBeVisible();
    expect(searched[0]).toMatchObject({ topic: 'coffee pouring', mediaType: 'video' });
    expect(searched[1]).toMatchObject({ action: 'save', mediaType: 'video' });
    expect(applied).toEqual([{ op: 'update_section', pageId: 'home', sectionId: 'hero', props: { image: { assetId: 88, url: '', alt: 'Coffee pouring', video: true } } }]);
    expect(pageErrors).toEqual([]);
});

test('an AI video: needs a description, keeps checking until it is ready, then places it', async ({ page, api, pageErrors }) => {
    test.setTimeout(30000);
    await page.setViewportSize({ width: 1400, height: 900 });
    api.set('chat-orchestrator', { chatSessionId: 60, message: { id: 7, role: 'assistant', content: 'Choose on the card below.', uiElement: {
        type: 'site_picture', pageId: 'home', sectionId: 'how', sectionLabel: 'How wholesale works', place: 'after', kind: 'video', source: 'ai', description: '', alt: '' } } });
    api.set('get-ai-credit-balance', { canImage: true, imageCost: 1, assistantCanVideo: true, tierCanVideo: true, videoCost: 4, unit: 'tasks' });
    let polls = 0;
    api.set('generate-ai-video', (route) => {
        if (route.request().method() === 'POST') return { jobId: 9 };
        polls++;
        return polls < 2 ? { status: 'processing' } : { status: 'completed', assetId: 99, videoUrl: 'https://example.invalid/v.mp4' };
    });
    await page.route('https://example.invalid/**', (r) => r.fulfill({ status: 404, body: '' }));
    const applied: unknown[] = [];
    api.set('sites', (_route, body) => { const b = body as { action: string; ops?: unknown[] }; if (b.action === 'apply') applied.push(...(b.ops || [])); return siteView; });
    await page.goto('/e2e-website-chat.html');
    const input = page.locator('[data-sb-chat] [data-chat-input]');
    await input.fill('Make me a video after this');
    await input.press('Enter');
    await expect(page.getByText(/Creating uses 4 tasks for a 6-second clip/)).toBeVisible();
    await page.getByRole('button', { name: 'Create with AI' }).click();
    await expect(page.getByText('Describe what the video should show first.')).toBeVisible();
    await page.locator('[data-sp-desc]').fill('steam rising from a cup');
    await page.getByRole('button', { name: 'Create with AI' }).click();
    await expect(page.frameLocator('iframe[data-site-preview]').locator('[data-bms-picture-working]')).toContainText('Creating a video');
    await page.getByRole('button', { name: 'Use this video' }).click({ timeout: 15000 });
    await expect(page.getByText(/Done — it's after “How wholesale works”/)).toBeVisible();
    expect(api.called('generate-ai-video')[0].body).toMatchObject({ prompt: 'steam rising from a cup', durationSeconds: 6 });
    expect(applied).toEqual([{ op: 'add_section', pageId: 'home', index: 2, section: { type: 'gallery', props: { heading: null, intro: null, layout: 'natural', images: [{ assetId: 99, url: '', alt: 'steam rising from a cup', video: true, caption: null }] } } }]);
    expect(pageErrors).toEqual([]);
});
