// tests/platform-reviews.test.ts
// Reviews OF Be More Swan (src/utils/platform-reviews.ts, platform-review.ts, admin-platform-reviews.ts,
// platform-review.js): the reviewer's words kept, free access disclosed, consent before quoting, the
// same Trustpilot / G2 links for every star rating, and asking only when it is fair to.
//
// Run:  npx tsx tests/platform-reviews.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ASK_RULES, BETA_INCENTIVE_NOTE, cleanDestinations, cleanPlatformReview, destinationList, reviewStats, shouldAsk, type AskInput,
} from '../src/utils/platform-reviews';
import { TEMPLATE_DEFAULTS } from '../src/utils/email-templates-catalog';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const DAY = 86_400_000;
const NOW = new Date('2026-10-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const base = (over: Partial<AskInput> = {}): AskInput => ({
    now: NOW, accountCreatedAt: daysAgo(20), publishedPosts: 6, hasReview: false, impersonating: false, paymentFailing: false, ask: null, ...over,
});
const ask = (over: Partial<NonNullable<AskInput['ask']>> = {}) => ({ askCount: 0, lastAskedAt: null, snoozedUntil: null, optedOutAt: null, requestedAt: null, ...over });

console.log('\nSaving a review');

check('keeps the words and line breaks, tidying only the ends', () => {
    const r = cleanPlatformReview({ rating: 4, body: '  Saved me hours!!\r\n\r\n\r\nwould recomend  ', consentToPublish: true, displayName: '  Sarah   K. ' });
    assert.ok(r.ok);
    if (r.ok) {
        assert.strictEqual(r.value.body, 'Saved me hours!!\n\nwould recomend');
        assert.strictEqual(r.value.displayName, 'Sarah K.');
    }
});

check('needs 1–5 whole stars and some words', () => {
    assert.ok(!cleanPlatformReview({ rating: 0, body: 'x' }).ok);
    assert.ok(!cleanPlatformReview({ rating: 3.5, body: 'x' }).ok);
    assert.ok(!cleanPlatformReview({ rating: 3, body: '   ' }).ok);
    assert.ok(cleanPlatformReview({ rating: 1, body: 'Not for me' }).ok);
});

check('agreeing to be quoted needs a name to quote', () => {
    assert.ok(!cleanPlatformReview({ rating: 5, body: 'Great', consentToPublish: true }).ok);
    const r = cleanPlatformReview({ rating: 5, body: 'Great', consentToPublish: 'yes' });
    assert.ok(r.ok && r.value.consentToPublish === false, 'only a real true counts as consent');
});

console.log('\nWhere reviewers are sent');

check('only https links on the site\'s own domain are kept', () => {
    assert.ok(cleanDestinations({ trustpilot: 'https://uk.trustpilot.com/evaluate/bemoreswan.com', g2: 'https://www.g2.com/products/x/take_survey' }).ok);
    assert.ok(!cleanDestinations({ trustpilot: 'http://uk.trustpilot.com/evaluate/bemoreswan.com' }).ok);
    assert.ok(!cleanDestinations({ g2: 'https://g2.com.evil.example/x' }).ok);
    assert.ok(!cleanDestinations({ trustpilot: 'https://www.g2.com/x' }).ok);
    const empty = cleanDestinations(null);
    assert.ok(empty.ok && Object.keys(empty.value).length === 0);
});

check('the list offered does not depend on the rating (no review gating)', () => {
    const list = destinationList({ trustpilot: 'https://uk.trustpilot.com/evaluate/bemoreswan.com', g2: 'https://www.g2.com/p' });
    assert.deepStrictEqual(list.map((d) => d.key), ['trustpilot', 'g2']);
    const fn = read('netlify/functions/platform-review.ts');
    assert.ok(!/rating\s*>=?\s*[345]/.test(fn), 'platform-review.ts must not branch on the rating');
    const ui = read('src/components/platform-review.js');
    const thanks = ui.slice(ui.indexOf('function renderThanks'), ui.indexOf('async function open'));
    assert.ok(thanks.length > 100, 'renderThanks found');
    assert.ok(!/rating/.test(thanks), 'the thank-you screen must not look at the rating');
});

console.log('\nWhen the app asks');

check('asks a 14-day-old account with 5 posts published', () => {
    assert.strictEqual(shouldAsk(base()).ask, true);
    assert.strictEqual(shouldAsk(base({ publishedPosts: ASK_RULES.minPublishedPosts - 1 })).ask, false);
    assert.strictEqual(shouldAsk(base({ accountCreatedAt: daysAgo(10) })).ask, false);
});

check('asks any 30-day-old account', () => {
    assert.strictEqual(shouldAsk(base({ accountCreatedAt: daysAgo(31), publishedPosts: 0 })).ask, true);
});

check('never asks after a review, under impersonation, with a failed payment, or after "don\'t ask again"', () => {
    assert.strictEqual(shouldAsk(base({ hasReview: true })).ask, false);
    assert.strictEqual(shouldAsk(base({ impersonating: true })).ask, false);
    assert.strictEqual(shouldAsk(base({ paymentFailing: true })).ask, false);
    assert.strictEqual(shouldAsk(base({ ask: ask({ optedOutAt: daysAgo(1), requestedAt: NOW }) })).ask, false);
});

check('at most three times, a week apart; "maybe later" waits', () => {
    assert.strictEqual(shouldAsk(base({ ask: ask({ askCount: 1, lastAskedAt: daysAgo(3) }) })).ask, false);
    assert.strictEqual(shouldAsk(base({ ask: ask({ askCount: 1, lastAskedAt: daysAgo(8) }) })).ask, true);
    assert.strictEqual(shouldAsk(base({ ask: ask({ askCount: 3, lastAskedAt: daysAgo(30) }) })).ask, false);
    assert.strictEqual(shouldAsk(base({ ask: ask({ snoozedUntil: new Date(NOW.getTime() + DAY) }) })).ask, false);
});

check('an admin\'s request is answered once, whatever the account\'s age', () => {
    const young = { accountCreatedAt: daysAgo(2), publishedPosts: 0 };
    assert.strictEqual(shouldAsk(base({ ...young, ask: ask({ requestedAt: daysAgo(1) }) })).ask, true);
    assert.strictEqual(shouldAsk(base({ ...young, ask: ask({ requestedAt: daysAgo(1), lastAskedAt: NOW, askCount: 1 }) })).ask, false);
});

console.log('\nThe numbers');

check('hiding a review never improves the average', () => {
    const s = reviewStats([
        { rating: 5, status: 'published', sharedTo: ['g2'] },
        { rating: 1, status: 'hidden', sharedTo: [] },
        { rating: 3, status: 'pending', sharedTo: ['g2', 'trustpilot'] },
    ]);
    assert.strictEqual(s.average, 3);
    assert.strictEqual(s.pending, 1);
    assert.deepStrictEqual(s.shared, { g2: 2, trustpilot: 1 });
});

console.log('\nThe law and the wiring');

check('beta testers\' reviews say they had free access', () => {
    assert.match(BETA_INCENTIVE_NOTE, /free access/i);
    const fn = read('netlify/functions/platform-review.ts');
    assert.ok(fn.includes('wasOnBeta(db, organisationId)) ? BETA_INCENTIVE_NOTE'), 'submit stamps the note server-side');
    const t = TEMPLATE_DEFAULTS.find((x) => x.triggerKey === 'platform_review_request');
    assert.ok(t, 'platform_review_request is in the catalog');
    assert.match(t!.bodyHtml, /free access/i);
    assert.ok(!/(voucher|gift card|discount|prize|reward)/i.test(t!.bodyHtml), 'no reward offered for a review');
});

check('publishing needs the author\'s consent, server-side', () => {
    const fn = read('netlify/functions/admin-platform-reviews.ts');
    assert.ok(/status === 'published' && !r\.consentToPublish/.test(fn));
});

check('resending a review puts it back to pending', () => {
    const fn = read('netlify/functions/platform-review.ts');
    assert.ok(/status: 'pending', decidedBy: null/.test(fn));
});

check('workspace loads the form and the account menu opens it', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes('/src/components/platform-review.js'));
    assert.ok(ws.includes('id="header-leave-review"'));
    assert.ok(ws.includes('window.PlatformReview?.init()'));
});

check('admin: Reviews view, nav entry, loader and beta-tester button', () => {
    const a = read('admin.html');
    assert.ok(a.includes('id="view-platform-reviews"'));
    assert.ok(a.includes("view: 'platform-reviews'"));
    assert.ok(a.includes("if (view === 'platform-reviews') loadPlatformReviews();"));
    assert.ok(a.includes('betaAskReview('));
    assert.ok(read('netlify/functions/admin-beta.ts').includes("action === 'review_request'"));
});

console.log(`\n${passed}/${total} passed`);
