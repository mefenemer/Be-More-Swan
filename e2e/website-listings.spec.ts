// Listings (docs/website-types-plan.md §4): the Listings tab on the Website Assistant — add an event,
// approve a visitor's entry — and a listings section in the preview, drawn by the real renderer.
// Mounted on a bare page like website-chat.spec.ts; every function is stubbed.

import { test, expect } from './fixtures';
import { normaliseSiteDefinition, SECTION_TYPES } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';

const definition = normaliseSiteDefinition({
    settings: { siteName: 'Syros Events', features: ['listings'] },
    pages: [{ id: 'home', slug: '', title: 'Home', sections: [
        { id: 'hero', type: 'hero', props: { headline: 'What\'s happening on Syros' } },
        { id: 'on', type: 'listings', props: { kind: 'event', heading: 'Coming up', allowPosts: true } },
    ] }],
}).definition;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const listing = (o: Record<string, unknown>) => ({ id: 1, kind: 'event', title: 'X', slug: 'x', category: null, summary: null, body: null, startsOn: soon, startTime: null, endsOn: null, endTime: null, location: null, imageAssetId: null, imageAlt: null, linkUrl: null, linkLabel: null, status: 'published', source: 'owner', submitterName: null, submitterEmail: null, ...o });
const previewHtml = renderSitePage(definition, '/', {
    origin: 'https://preview.invalid', preview: true, reportUrl: '#', creditUrl: null,
    listings: { today, all: [{ ...listing({ id: 1, title: 'Rebetiko night', slug: 'rebetiko-night', category: 'Music', startTime: '21:00', location: 'Ermoupoli harbour', summary: 'Live music by the water.' }), when: '' } as never] },
} as never).html;

const siteView = {
    import: null, importSuggestUrl: null,
    site: { id: 1, status: 'draft', credit: true, drafting: false, draftNote: null, slug: null, url: null, domain: 'bemoreswan.site', freeUrl: null, suggestedSlug: 'syros', publishedVersion: 1, publishedAt: null, unpublishedChanges: false, customDomain: null, canSplit: false, suspendedReason: null, publishBlocker: null },
    definition, warnings: [], maxPages: null, placeholders: [], assetUrls: {}, forms: [], catalogue: [],
    reviews: { summary: null, list: [] }, social: { platforms: [], published: [] }, blog: { published: 0 },
    payments: { connected: false, chargesEnabled: false, detailsSubmitted: false, canConnect: true },
    booking: { ready: false, hours: [], mode: 'request', visitAddress: null, whatsapp: null, services: [], resources: [], waiting: 0 },
    newOrders: 0, newEnquiries: 0, templates: [],
    vocab: { sectionTypes: SECTION_TYPES, fonts: [], features: [], limits: {} },
};
const page = (surface: string) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div data-site-host="${surface}"></div></div>
  <button id="maintab-btn-sitelistings" class="hidden">Listings <span id="site-listings-badge" style="display:none"></span></button>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/components/assistant-site-editor.js"></script>
  <script>AssistantSiteEditor.init({ assistantId: 7, assistantName: 'Wren' }); AssistantSiteEditor.activate('${surface}');</script>
</body></html>`;

test('the Listings tab: a visitor\'s entry waits; Approve sends the decision; Add a listing saves an event', async ({ page: pg, api, pageErrors }) => {
    await pg.route('**/e2e-listings.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: page('listings') }));
    api.set('sites', siteView);
    let rows = [
        listing({ id: 1, title: 'Rebetiko night', category: 'Music', startTime: '21:00' }),
        listing({ id: 2, title: 'Beach picnic', status: 'pending', source: 'public', submitterName: 'Eleni', submitterEmail: 'eleni@example.com', summary: 'Bring a blanket.' }),
    ];
    api.set('site-listings', async (route, body) => {
        const m = route.request().method();
        if (m === 'PATCH') { rows = rows.map((r) => (r.id === (body as { id: number }).id ? { ...r, status: 'published' } : r)); return { listing: rows[1] }; }
        if (m === 'POST') { rows.push(listing({ id: 3, ...(body as object) })); return { listing: rows[2] }; }
        return { listings: rows, pending: rows.filter((r) => r.status === 'pending').length, categories: ['Music'] };
    });
    await pg.goto('/e2e-listings.html');
    await expect(pg.getByText('Waiting for you (1)')).toBeVisible();
    await expect(pg.getByText('Sent in by Eleni')).toBeVisible();
    await expect(pg.locator('#maintab-btn-sitelistings')).toBeVisible();
    await expect(pg.locator('#site-listings-badge')).toHaveText('1');
    await pg.screenshot({ path: 'test-results/website-listings-tab.png' });
    await pg.getByRole('button', { name: 'Approve' }).click();
    await expect(pg.getByText('Waiting for you')).toHaveCount(0);
    expect(api.called('site-listings').find((c) => c.method === 'PATCH')!.body).toEqual({ id: 2, decision: 'approve' });

    await pg.getByRole('button', { name: '+ Add a listing' }).click();
    await pg.locator('[name="l-title"]').fill('Jazz on the steps');
    await pg.locator('[name="l-startsOn"]').fill(soon);
    await pg.locator('[name="l-startTime"]').fill('19:30');
    await pg.locator('[name="l-location"]').fill('Ano Syros');
    await pg.screenshot({ path: 'test-results/website-listings-form.png' });
    await pg.getByRole('button', { name: 'Add it' }).click();
    await expect(pg.getByText('Jazz on the steps')).toBeVisible();
    const sent = api.called('site-listings').find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ kind: 'event', title: 'Jazz on the steps', startsOn: soon, startTime: '19:30', location: 'Ano Syros' });
    expect(pageErrors).toEqual([]);
});

test('the preview draws a listings section with its filter and "Post your event"', async ({ page: pg, api, pageErrors }) => {
    await pg.setViewportSize({ width: 1400, height: 900 });
    await pg.route('**/e2e-listings-site.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: page('website') }));
    api.set('sites', siteView);
    api.set('site-listings', { listings: [], pending: 0, categories: [] });
    api.set('site-preview', async (route) => { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: previewHtml }); });
    await pg.goto('/e2e-listings-site.html');
    const frame = pg.frameLocator('iframe[data-site-preview]');
    await expect(frame.getByRole('heading', { name: 'Coming up' })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Rebetiko night', exact: true })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Post your event' })).toBeVisible();
    await frame.getByRole('heading', { name: 'Coming up' }).scrollIntoViewIfNeeded();
    await pg.screenshot({ path: 'test-results/website-listings-preview.png' });
    expect(pageErrors).toEqual([]);
});
