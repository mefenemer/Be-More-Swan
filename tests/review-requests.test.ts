// tests/review-requests.test.ts
// Asking customers for a review (src/utils/review-requests.ts, site-review.ts): off until switched
// on, one neutral email, a signed link to the business's own site, consent before anything is shown,
// owner approval, the Google link offered to everyone alike, and "don't ask me again".
//
// Run:  npx tsx tests/review-requests.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-review-links';

import {
    cleanReviewRequestSettings, REVIEW_REQUEST_DEFAULTS, reviewRequestEmail, reviewRequestSettingsFrom, reviewRequestUrl,
    signReviewRequest, verifyReviewToken,
} from '../src/utils/review-requests';
import { REVIEW_MIN_FILL_MS, reviewPage, reviewSubmit, suggestedName, type ReviewCtx } from '../src/utils/site-review';
import { normaliseSiteDefinition } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

/** A stand-in database: each awaited query resolves to the next result in the queue; writes are recorded. */
function fakeDb(results: unknown[][]) {
    const writes: string[] = [];
    const chain = (kind: string): unknown => new Proxy(function () {}, {
        get(_t, prop) {
            if (prop === 'then') {
                const value = kind === 'select' ? (results.shift() ?? []) : [{ id: 1 }];
                return (res: (v: unknown) => void) => res(value);
            }
            return () => chain(kind);
        },
        apply() { return chain(kind); },
    });
    return {
        writes,
        db: {
            select: () => chain('select'),
            update: () => { writes.push('update'); return chain('update'); },
            insert: () => { writes.push('insert'); return chain('insert'); },
        },
    };
}

const def = normaliseSiteDefinition({ settings: { siteName: 'Willowbrook Salon' }, pages: [{ title: 'Home', slug: '', sections: [{ id: 'h', type: 'hero', props: { headline: 'Hi' } }] }] }).definition;
const site = { id: 3, organisationId: 9, slug: 'willowbrook', status: 'published', aiAssistantId: null } as unknown as ReviewCtx['site'];
const ctx = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };
const request = (over: Record<string, unknown> = {}) => ({ id: 41, organisationId: 9, customerName: 'Sarah Kemp', customerEmail: 'sarah@example.com', about: 'your Cut & blow-dry', respondedAt: null, ...over });
const now = new Date('2026-10-15T12:00:00Z');
const bctx = (results: unknown[][]) => { const f = fakeDb(results); return { f, b: { db: f.db as unknown as ReviewCtx['db'], site, def, ctx, now } as ReviewCtx }; };

(async () => {
    console.log('\nSettings');

    await check('off by default; switching on is a choice, delays are bounded, the Google link must be https', () => {
        assert.deepStrictEqual(reviewRequestSettingsFrom(null), REVIEW_REQUEST_DEFAULTS);
        assert.strictEqual(REVIEW_REQUEST_DEFAULTS.askAfterBookings || REVIEW_REQUEST_DEFAULTS.askAfterOrders, false);
        const ok = cleanReviewRequestSettings({ askAfterBookings: true, askAfterOrders: 'yes', bookingDelayHours: 24, orderDelayDays: '7', googleReviewUrl: ' https://g.page/r/abc/review ' });
        assert.ok(ok.ok);
        if (ok.ok) assert.deepStrictEqual(ok.value, { askAfterBookings: true, askAfterOrders: false, bookingDelayHours: 24, orderDelayDays: 7, googleReviewUrl: 'https://g.page/r/abc/review' });
        assert.ok(!cleanReviewRequestSettings({ bookingDelayHours: 0 }).ok);
        assert.ok(!cleanReviewRequestSettings({ orderDelayDays: 31 }).ok);
        assert.ok(!cleanReviewRequestSettings({ googleReviewUrl: 'http://g.page/x' }).ok);
    });

    console.log('\nThe email and its link');

    await check('the link is signed: a changed id or token is refused', () => {
        const t = signReviewRequest(41);
        assert.strictEqual(t.length, 20);
        assert.ok(verifyReviewToken(41, t));
        assert.ok(!verifyReviewToken(42, t));
        assert.ok(!verifyReviewToken(41, t.slice(0, 19) + (t[19] === 'a' ? 'b' : 'a')));
        assert.strictEqual(reviewRequestUrl('https://willowbrook.bemoreswan.site/', 41), `https://willowbrook.bemoreswan.site/_review?r=41&t=${t}`);
    });
    await check('neutral wording, one email, a way to stop, and the Google link offered to everyone', () => {
        const e = reviewRequestEmail({ business: 'Willowbrook Salon', firstName: 'Sarah', about: 'your Cut & blow-dry', link: 'https://x/_review?r=1&t=a', stopLink: 'https://x/_review?r=1&t=a&stop=1', googleUrl: 'https://g.page/r/abc/review' });
        assert.strictEqual(e.subject, 'How did we do? — Willowbrook Salon');
        assert.ok(e.html.includes('Hi Sarah,') && e.html.includes('for your Cut &amp; blow-dry'));
        assert.ok(e.html.includes('Leave a review') && e.html.includes('review us on Google'));
        assert.ok(e.html.includes("This is the only email you'll get about it.") && e.html.includes('&amp;stop=1'));
        assert.ok(!/(5 stars|discount|offer|% off|happy)/i.test(e.html), 'no steering, no selling');
        const noGoogle = reviewRequestEmail({ business: 'B', firstName: null, about: null, link: 'l', stopLink: 's', googleUrl: null });
        assert.ok(noGoogle.html.startsWith('<p>Hello,</p>') && !noGoogle.html.includes('Google'));
    });
    await check('the suggested name shows a first name and initial, never the full surname', () => {
        assert.strictEqual(suggestedName('Sarah Jane Kemp'), 'Sarah K.');
        assert.strictEqual(suggestedName('Tom'), 'Tom');
        assert.strictEqual(suggestedName(null), '');
    });

    console.log('\nThe page on their site');

    const q = (extra: Record<string, string> = {}) => new URLSearchParams({ r: '41', t: signReviewRequest(41), ...extra });

    await check('a forged link shows nothing of anyone\'s', async () => {
        const { b } = bctx([[request()]]);
        const r = await reviewPage(b, new URLSearchParams({ r: '41', t: 'nope' }));
        assert.ok('html' in r && r.status === 404 && r.html.includes("This link doesn't work") && !r.html.includes('Sarah'));
    });
    await check('the form: stars optional, the words, a suggested name, and consent in words', async () => {
        const { b } = bctx([[request()]]);
        const r = await reviewPage(b, q());
        assert.ok('html' in r && r.status === 200);
        if (!('html' in r)) return;
        assert.ok(r.html.includes('<form class="fm" method="post" action="/_form">') && r.html.includes('name="_k" value="review"'));
        assert.ok(r.html.includes('Your review of Cut &amp; blow-dry.'));
        assert.ok(r.html.includes('value="Sarah K."'));
        assert.ok(r.html.includes('name="consent" value="yes" required') && r.html.includes('Willowbrook Salon may show my review and this name on their website.'));
        assert.ok(r.html.includes('reads every review before it appears'));
    });
    await check('answered already → thanked, with the Google link offered whatever they said', async () => {
        const { b } = bctx([[request({ respondedAt: new Date() })], [{ organisationId: 9, askAfterBookings: true, googleReviewUrl: 'https://g.page/r/abc/review' }]]);
        const r = await reviewPage(b, q());
        assert.ok('html' in r && r.html.includes('We already have your review') && r.html.includes('href="https://g.page/r/abc/review"'));
    });
    await check('"don\'t ask me again" is a button (a link scanner can\'t trigger it), then remembered', async () => {
        const { b } = bctx([[request()]]);
        const page = await reviewPage(b, q({ stop: '1' }));
        assert.ok('html' in page && page.html.includes('name="_k" value="review_stop"') && page.html.includes("Don't ask me again"));
        const { b: b2, f } = bctx([[request()]]);
        const r = await reviewSubmit(b2, new URLSearchParams({ _k: 'review_stop', r: '41', t: signReviewRequest(41) }), '1.2.3.4');
        assert.ok('location' in r && r.location.endsWith('&stopped=1'));
        assert.deepStrictEqual(f.writes, ['insert']);
    });
    await check('without consent nothing is saved, and what they wrote is kept on the page', async () => {
        const { b, f } = bctx([[request()], [request()]]);
        const body = new URLSearchParams({ _k: 'review', r: '41', t: signReviewRequest(41), _t: String(now.getTime() - 60_000), body: 'Lovely cut', name: 'Sarah K.', rating: '5' });
        const r = await reviewSubmit(b, body, '1.2.3.4');
        assert.ok('html' in r && r.html.includes('Please tick the box') && r.html.includes('Lovely cut') && r.html.includes('value="5" checked'));
        assert.deepStrictEqual(f.writes, []);
    });
    await check('a bot (too fast, or the hidden field) is thanked and nothing is saved', async () => {
        const { b, f } = bctx([[request()]]);
        const body = new URLSearchParams({ _k: 'review', r: '41', t: signReviewRequest(41), _t: String(now.getTime() - REVIEW_MIN_FILL_MS + 500), body: 'x', name: 'y', consent: 'yes' });
        const r = await reviewSubmit(b, body, '1.2.3.4');
        assert.ok('location' in r && r.location.endsWith('&done=1'));
        assert.deepStrictEqual(f.writes, []);
    });

    console.log('\nWiring');

    await check('site-serve routes the page and the posts; the sender runs hourly; the owner is told', () => {
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes("if (path === REVIEW_PATH)") && serve.includes("posted.get('_k') === 'review' || posted.get('_k') === 'review_stop'"));
        assert.ok(read('netlify.toml').includes('[functions.send-review-requests]\n  schedule = "35 * * * *"'));
        assert.ok(read('src/utils/notification-actions.ts').includes("site_review_received: 'suggested_action'"));
        assert.ok(read('src/utils/notification-prefs.ts').includes("'site_review_received'"));
        assert.ok(read('db/notifications-categorization.sql').includes("WHEN 'site_review_received'"));
        assert.ok(read('src/utils/notification-templates-catalog.ts').includes("templateKey: 'site_review_received'"));
    });
    await check('the sender: claim before sending, nothing before it was switched on, no one twice in 30 days', () => {
        const src = read('src/utils/review-requests.ts');
        assert.ok(src.includes('.onConflictDoNothing().returning({ id: reviewRequests.id })'));
        assert.ok(src.includes('sql`${bookings.endsAt} >= ${reviewSettings.enabledAt}`') && src.includes('gte(siteOrders.createdAt, sql`${reviewSettings.enabledAt}`)'));
        assert.ok(src.includes("return recent ? 'asked_recently' : null;") && src.includes("if (out) return 'opted_out';"));
        assert.ok(read('db/z-review-requests.sql').includes('CREATE UNIQUE INDEX IF NOT EXISTS review_requests_booking_uq'));
    });
    await check('Audience ▸ Reviews: approve / decline waiting reviews, and the asking settings', () => {
        const ui = read('audience.html');
        assert.ok(ui.includes('id="rv-pending"') && ui.includes('data-rv-approve') && ui.includes('id="rq-bookings"') && ui.includes('id="rq-google"'));
        const api = read('netlify/functions/org-reviews.ts');
        assert.ok(api.includes("eq(orgReviews.status, 'pending'))).returning()") && api.includes('saveReviewRequestSettings(db, orgId, r.value)'));
    });

    console.log(`\n${passed}/${total} passed\n`);
})();
