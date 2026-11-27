// tests/shop-review-requests.test.ts
// Review requests after shop orders go only from the owner's own address (online shop Phase 2, slice 7; owner Q1
// 2026-11-26; src/utils/review-requests.ts): the wiring, the plain-text part, and where the owner is told. The SQL path
// is proven by tests/shop-review-requests-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-review-requests.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewRequestEmail } from '../src/utils/review-requests';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nshop-review-requests');

check('the email has a plain-text part with both links (a mailbox send needs one)', () => {
    const m = reviewRequestEmail({ business: 'Kudzu', firstName: 'Sam', about: 'your Mug', link: 'https://k.example/_review?r=1&t=x', stopLink: 'https://k.example/_review?r=1&t=x&stop=1', googleUrl: 'https://g.page/r/x/review' });
    assert.ok(m.text.startsWith('Hi Sam,') && m.text.includes('Leave a review: https://k.example/_review?r=1&t=x'));
    assert.ok(m.text.includes('review us on Google: https://g.page/r/x/review') && m.text.includes("Don't ask me for reviews again: https://k.example/_review?r=1&t=x&stop=1"));
});

check('bookings and shop orders: routes resolved first, due only where one exists, sent on it', () => {
    const src = read('src/utils/review-requests.ts');
    const send = src.slice(src.indexOf('export async function sendDueReviewRequests('));
    assert.ok(send.indexOf("if ('route' in r) routes.set(o.id, r.route);") < send.indexOf('await dueOrders(db, now, [...routes.keys()])'));
    assert.ok(src.includes('inArray(siteOrders.organisationId, orgIds),'));
    assert.ok(send.includes('if (!route) continue;'), 'no route: never claimed');
    assert.ok(send.indexOf('if (!route) continue;') < send.indexOf('db.insert(reviewRequests)'));
    assert.ok(send.includes('await (deps.deliver ?? deliverStep)(db, { ...route,'));
    assert.ok(!/fromLine|sendEmail\(|noreply@/.test(src), 'bookings too (owner 2026-11-27): no Be More Swan sender left');
    // review #909: a time budget, a per-workspace cap, stale claims released, replies to the owner, a late window.
    assert.ok(send.includes('if (clock() - started > RUN_BUDGET_MS) break;') && send.includes('if (n >= REQUESTS_PER_WORKSPACE_PER_RUN) continue;'));
    assert.ok(send.includes('DELETE FROM review_requests WHERE (order_id IS NOT NULL OR booking_id IS NOT NULL) AND sent_at IS NULL AND skipped_reason IS NULL'));
    assert.ok(send.includes('replyTo: route.replyTo || owner?.email || null'));
    assert.ok(src.includes('inArray(bookings.organisationId, orgIds),') && send.includes('await dueBookings(db, now, [...routes.keys()])'), 'bookings: only where a route exists');
    assert.ok(src.includes('make_interval(days => ${reviewSettings.orderDelayDays} + ${ORDER_LATE_DAYS})'));
});

check('the owner is told: Shop tab line, chat snapshot, and beside the switch in Audience ▸ Reviews', () => {
    assert.ok(read('netlify/functions/shop.ts').includes('reviewBlocked: await orderReviewRequestsBlocked(db, orgId),'));
    assert.ok(read('src/components/assistant-shop.js').includes('data-shop-review-blocked>${esc(d.reviewBlocked)}'));
    assert.ok(read('src/utils/shop-snapshot.ts').includes('REVIEW REQUESTS AFTER ORDERS'));
    const aud = read('audience.html');
    assert.ok(aud.includes('data-rq-route>Sent from your own address') && aud.includes("$(id).textContent = data.routeBlocked || ''"));
    assert.ok(read('netlify/functions/org-reviews.ts').includes('routeBlocked: await reviewRequestsBlocked(db, orgId),'));
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-review-requests-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
