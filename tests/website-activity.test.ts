// The Website Assistant's Activity tab (src/utils/role-activity.ts websiteItems): its own work and
// what visitors sent — not the social feed's posts and ideas. Run: npx tsx tests/website-activity.test.ts
import assert from 'node:assert/strict';
import { roleActivityItems, ROLE_ACTIVITY_ROLES } from '../src/utils/role-activity';
import { bookings, siteEnquiries, siteImports, siteOrders, sites, siteVersions, taskLedger } from '../db/schema';

const t = (iso: string) => new Date(iso);
const FIXTURES = new Map<unknown, unknown[]>([
    [sites, [{ id: 9, draftingAt: null, draftNote: null, updatedAt: t('2026-10-01T09:00:00Z') }]],
    [siteImports, [{ id: 3, url: 'https://oldsite.co.uk', status: 'ready', message: null, at: t('2026-10-02T10:00:00Z') }]],
    [taskLedger, [
        { id: 51, kind: 'site_draft', at: t('2026-10-02T10:01:00Z') },   // the import's charge — not a draft
        { id: 50, kind: 'site_draft', at: t('2026-09-28T08:00:00Z') },
        { id: 52, kind: 'site_words', at: t('2026-10-03T08:00:00Z') },
    ]],
    [siteVersions, [{ id: 7, version: 2, at: t('2026-10-04T12:00:00Z') }]],
    [siteEnquiries, [{ id: 11, name: 'Ada <b>', status: 'new', at: t('2026-10-05T12:00:00Z') }]],
    [siteOrders, [{ id: 12, item: 'Gift card', qty: 2, total: 5000, currency: 'gbp', status: 'paid', at: t('2026-10-06T12:00:00Z') }]],
    [bookings, [{ id: 13, name: 'Sam', service: 'Haircut', status: 'pending', at: t('2026-10-07T12:00:00Z') }]],
]);

/** Just enough of drizzle's select chain: from(table) picks the fixture; any of where/orderBy/limit resolve it. */
function fakeDb() {
    return {
        select() {
            let rows: unknown[] = [];
            const chain: any = {
                from(table: unknown) { rows = FIXTURES.get(table) ?? []; return chain; },
                where() { return chain; }, orderBy() { return chain; }, limit() { return chain; },
                then(res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve(rows).then(res, rej); },
            };
            return chain;
        },
    } as any;
}

(async () => {
    assert.ok(ROLE_ACTIVITY_ROLES.has('website_assistant'));
    const items = await roleActivityItems(fakeDb(), { orgId: 1, assistantId: 2, roleKey: 'website_assistant', cutoff: null, limit: 50 });
    const by = (type: string) => items.filter((i) => i.type === type);

    assert.equal(by('site_import').length, 1);
    assert.equal(by('site_import')[0].status, 'needs_input');
    assert.match(by('site_import')[0].description, /oldsite\.co\.uk/);
    assert.deepEqual(by('site_draft').map((i) => i.id), ['site-draft-50'], 'the import\'s charge is not counted as a draft');
    assert.equal(by('site_words').length, 1);
    assert.match(by('site_publish')[0].description, /version 2 published/);
    assert.equal(by('site_enquiry')[0].status, 'needs_input');
    assert.match(by('site_enquiry')[0].description, /Ada <b>/, 'raw here — assistants.js escapes descriptions');
    assert.match(by('site_order')[0].description, /Gift card × 2, £50\.00/);
    assert.equal(by('site_booking')[0].status, 'needs_input');
    assert.match(by('site_booking')[0].description, /Booking request from Sam for Haircut/);
    const icons = new Set(['alert', 'calendar', 'check', 'check-circle', 'clock', 'edit', 'image', 'lightbulb', 'link', 'rocket', 'settings', 'shield', 'sparkles', 'users', 'video', 'x']);
    for (const i of items) assert.ok(icons.has(i.icon), `${i.icon} is an icon assistants.js draws`);

    const none = await roleActivityItems({ select: () => { const c: any = { from: () => c, where: () => c, orderBy: () => c, limit: () => c, then: (r: any) => Promise.resolve([]).then(r) }; return c; } } as any,
        { orgId: 1, assistantId: 2, roleKey: 'website_assistant', cutoff: null, limit: 50 });
    assert.deepEqual(none, [], 'no site yet: nothing');
    console.log('website-activity: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
