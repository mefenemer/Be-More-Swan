// tests/crosspost-view.test.ts
//
// "Show a post on several platforms as one post" (src/utils/crosspost-view.ts), plus the two
// billing fixes from the same day (stripe-webhook.ts), read as source.
//
// Why it exists: publishing one post to four platforms wrote four "Post published to …"
// notifications, and the assistant's Activity feed listed every platform's row — on prod, a week
// of posting was 15 published notifications for about four posts. The combining is SERVER-side so
// the inbox badge and the list can never count differently.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    combineCrossPostNotes, combineCrossPostsFrom, joinPlatformLabels,
} from '../src/utils/crosspost-view';

let passed = 0, total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const note = (id: number, postId: number, platform: string, isRead = false, type = 'post_published') => ({
    id, type, isRead, readAt: null, title: `Post published to ${platform}`, message: 'x',
    metadata: { postId, platform }, createdAt: new Date(2026, 9, 12, 9, 0, 100 - id),
});

check('the preference defaults ON and only an explicit false turns it off', () => {
    assert.strictEqual(combineCrossPostsFrom(null), true);
    assert.strictEqual(combineCrossPostsFrom({}), true);
    assert.strictEqual(combineCrossPostsFrom({ combineCrossPosts: true }), true);
    assert.strictEqual(combineCrossPostsFrom({ combineCrossPosts: false }), false);
});

check('platform lists read as English', () => {
    assert.strictEqual(joinPlatformLabels(['Instagram']), 'Instagram');
    assert.strictEqual(joinPlatformLabels(['Instagram', 'LinkedIn']), 'Instagram and LinkedIn');
    assert.strictEqual(joinPlatformLabels(['Facebook', 'Instagram', 'X (Twitter)']), 'Facebook, Instagram and X (Twitter)');
});

check('one cross-post becomes one notification, at the newest sibling\'s place and id', () => {
    const groups = new Map([[10, 'g1'], [11, 'g1'], [12, 'g1']]);
    const other = { ...note(5, 99, 'linkedin'), type: 'billing_renewed' };
    const out = combineCrossPostNotes([note(3, 10, 'instagram'), other, note(2, 11, 'linkedin'), note(1, 12, 'x')], groups);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, 3);
    assert.strictEqual(out[0].title, 'Post published to Instagram, LinkedIn and X (Twitter)');
    assert.deepStrictEqual((out[0] as any).groupIds, [3, 2, 1]);
    assert.strictEqual(out[1], other, 'unrelated notifications pass through untouched');
});

check('a merged row stays unread while ANY platform is unread', () => {
    const groups = new Map([[10, 'g1'], [11, 'g1']]);
    assert.strictEqual(combineCrossPostNotes([note(2, 10, 'instagram', true), note(1, 11, 'linkedin', false)], groups)[0].isRead, false);
    assert.strictEqual(combineCrossPostNotes([note(2, 10, 'instagram', true), note(1, 11, 'linkedin', true)], groups)[0].isRead, true);
});

check('different cross-posts, standalone posts and failures are never merged', () => {
    const groups = new Map([[10, 'g1'], [11, 'g2']]);
    // two groups, one ungrouped post (no entry in the map)
    assert.strictEqual(combineCrossPostNotes([note(3, 10, 'instagram'), note(2, 11, 'linkedin'), note(1, 12, 'x')], groups).length, 3);
    // failures carry their own cause — never folded together
    const fg = new Map([[10, 'g1'], [11, 'g1']]);
    const failed = [note(2, 10, 'instagram', false, 'post_publish_failed'), note(1, 11, 'linkedin', false, 'post_publish_failed')];
    assert.strictEqual(combineCrossPostNotes(failed, fg).length, 2);
});

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

check('the inbox combines BEFORE it counts, so the badge matches the list', () => {
    const src = read('netlify/functions/notifications.ts');
    const combine = src.indexOf('combineCrossPostNotes(allNotes');
    const count = src.indexOf("queryStringParameters.action === 'count'");
    assert.ok(combine > 0 && count > 0, 'both landmarks present');
    assert.ok(combine < count, 'combining must happen before the badge counts');
    assert.ok(/expandCrossPostIds\(db, userId, \[Number\(notificationId\)\]\)/.test(src), 'PATCH widens to the siblings');
    assert.ok(/expandCrossPostIds\(db, userId, ids\)/.test(src), 'mark-all widens to the siblings');
});

check('the preference is readable and writable through update-profile', () => {
    const src = read('netlify/functions/update-profile.ts');
    assert.ok(src.includes('combineCrossPosts: prefs.combineCrossPosts !== false'));
    assert.ok(src.includes("fieldKey === 'combineCrossPosts'"));
});

check('billing: a £0 renewal of an untracked subscription notifies nobody', () => {
    const src = read('netlify/functions/stripe-webhook.ts');
    const paid = src.indexOf("if (stripeEvent.type === 'invoice.paid')");
    const guard = src.indexOf('_isUntrackedSubscription(db, userId, getInvoiceSubscriptionId(invoice))', paid);
    const notify = src.indexOf("createNotification(db, 'invoice_ready_renewal'", paid);
    assert.ok(paid > 0 && guard > paid && notify > guard, 'guard sits before the invoice notification');
    assert.ok(/!invoice\.amount_paid && await _isUntrackedSubscription/.test(src), 'only FREE invoices are skipped — a paid one still notifies');
});

check('billing: deleting one subscription cancels only that subscription\'s plan', () => {
    const src = read('netlify/functions/stripe-webhook.ts');
    const deleted = src.indexOf("if (stripeEvent.type === 'customer.subscription.deleted')");
    const guard = src.indexOf('_isUntrackedSubscription(db, userId, sub.id)', deleted);
    const cancel = src.indexOf("status: 'cancelled', cancelledAt: cancelledNow", deleted);
    const pause = src.indexOf("provisioningStatus: 'paused_payment' as const", deleted);
    assert.ok(deleted > 0 && guard > deleted && cancel > guard && pause > cancel, 'untracked guard sits before the cancel and the pause');
    const scoped = src.indexOf('eq(plans.stripeSubscriptionId, sub.id)', cancel);
    assert.ok(scoped > cancel && scoped < pause, 'the cancel is scoped to the deleted subscription, not every plan the user has');
});

check('billing: "Active until" names the period being paid for, not the one that ended', () => {
    const src = read('netlify/functions/stripe-webhook.ts');
    assert.ok(src.includes('const paidThrough = getInvoicePaidThrough(invoice);'));
    assert.ok(!/const periodEnd\s+=\s+invoice\.period_end\s*\n?\s*\?/.test(src.slice(src.indexOf("stripeEvent.type === 'invoice.paid'"))),
        'invoice.paid must not read invoice.period_end for the active-until date');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
