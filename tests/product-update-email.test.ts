// tests/product-update-email.test.ts
// The weekly "What's new" email (docs/weekly-product-update.md). It goes to every customer, so the
// properties worth locking are the ones whose failure is public and cannot be taken back:
//   • copy from an AI draft is never rendered as HTML
//   • the machine token can create a draft but never send one
//   • nobody is emailed twice, and an unsubscribe is honoured by the very next send
//   • links in the email are signed, and a tampered link does nothing

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    normaliseDraft, normaliseEdit, renderProductUpdateEmail, renderReminderEmail, DraftError,
    productUpdateImageUrl, verifyImageSignature, whatsNewUnsubscribeUrl, verifyUnsubscribeSignature, LIMITS,
} from '../src/utils/product-update-email';
import { PREF_CATEGORIES, isEmailEnabled } from '../src/utils/notification-prefs';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SECRET = 'test-secret';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const good = () => ({
    subject: "What's new", preheader: 'Three things', intro: 'Hello\n\n\n\nworld',
    commitFrom: 'aa0dc094', commitTo: 'F0DA80FA', periodStart: '2026-09-23', periodEnd: '2026-10-03',
    items: [
        { heading: 'One', body: 'First', image: { mime: 'image/png', dataB64: PNG_1PX } },
        { heading: 'Two', body: 'Second' },
    ],
});

check('a valid draft normalises: text trimmed, blank runs collapsed, SHA lower-cased', () => {
    const d = normaliseDraft(good());
    assert.equal(d.intro, 'Hello\n\nworld');
    assert.equal(d.commitTo, 'f0da80fa');
    assert.equal(d.items.length, 2);
    assert.equal(d.items[0].image?.mime, 'image/png');
    assert.equal(d.items[1].image, null);
});

check('a bad draft is refused with a message an operator can act on', () => {
    const bad: [string, unknown][] = [
        ['no items', { ...good(), items: [] }],
        ['too many items', { ...good(), items: Array.from({ length: LIMITS.maxItems + 1 }, () => ({ heading: 'h', body: 'b' })) }],
        ['empty heading', { ...good(), items: [{ heading: '  ', body: 'b' }] }],
        ['svg image', { ...good(), items: [{ heading: 'h', body: 'b', image: { mime: 'image/svg+xml', dataB64: PNG_1PX } }] }],
        ['not base64', { ...good(), items: [{ heading: 'h', body: 'b', image: { mime: 'image/png', dataB64: 'not base64!' } }] }],
        ['oversized image', { ...good(), items: [{ heading: 'h', body: 'b', image: { mime: 'image/png', dataB64: 'A'.repeat(2_100_000) } }] }],
        ['bad sha', { ...good(), commitTo: 'main' }],
        ['bad date', { ...good(), periodEnd: '3 Oct' }],
        ['no subject', { ...good(), subject: '' }],
    ];
    for (const [label, input] of bad) {
        assert.throws(() => normaliseDraft(input), DraftError, label);
    }
});

check('copy is escaped — a heading or body can never inject markup into the email', () => {
    const { html, text } = renderProductUpdateEmail({
        subject: 's', preheader: null, intro: '<img src=x onerror=alert(1)>',
        items: [{ heading: '<script>alert(1)</script>', body: 'a "quote" & <b>bold</b>\nline two', imageId: null }],
    }, { baseUrl: 'https://bemoreswan.com', firstName: '<i>Mo</i>', secret: SECRET });
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>bold<\/b>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Hi &lt;i&gt;Mo&lt;\/i&gt;,/);
    assert.match(html, /<br>line two/, 'a single newline becomes a line break');
    assert.match(text, /a "quote" & <b>bold<\/b>/, 'the plain-text part is plain text, not escaped HTML');
});

check('the email is Be More Swan pink, carries its screenshots, a CTA and the per-user unsubscribe', () => {
    const unsub = whatsNewUnsubscribeUrl('https://bemoreswan.com/', 42, SECRET);
    const { html, text } = renderProductUpdateEmail({
        subject: 's', preheader: 'pre', intro: null,
        items: [{ heading: 'H', body: 'B', imageId: 7 }],
    }, { baseUrl: 'https://bemoreswan.com/', firstName: null, unsubscribeUrl: unsub, secret: SECRET });
    assert.match(html, /#d6006b/);
    assert.match(html, /Hi there,/);
    assert.ok(html.includes(productUpdateImageUrl('https://bemoreswan.com', 7, SECRET).replace(/&/g, '&amp;')), 'signed image URL');
    assert.ok(html.includes(unsub) || html.includes(unsub.replace(/&/g, '&amp;')), 'unsubscribe link in the footer');
    assert.match(html, /https:\/\/bemoreswan\.com\/workspace\.html/);
    assert.ok(text.includes(unsub));
});

check('image and unsubscribe links are signed; a tampered id or signature fails', () => {
    const img = new URL(productUpdateImageUrl('https://x.test', 12, SECRET));
    assert.ok(verifyImageSignature(12, img.searchParams.get('s')!, SECRET));
    assert.ok(!verifyImageSignature(13, img.searchParams.get('s')!, SECRET));
    assert.ok(!verifyImageSignature(12, 'deadbeefdeadbeef', SECRET));
    assert.ok(!verifyImageSignature(12, '', SECRET));
    const un = new URL(whatsNewUnsubscribeUrl('https://x.test', 5, SECRET));
    assert.equal(un.pathname, '/api/product-updates/unsubscribe');
    assert.ok(verifyUnsubscribeSignature(5, un.searchParams.get('s')!, SECRET));
    assert.ok(!verifyUnsubscribeSignature(6, un.searchParams.get('s')!, SECRET), 'one user cannot unsubscribe another');
    assert.ok(!verifyImageSignature(5, un.searchParams.get('s')!.slice(0, 16), SECRET), 'purposes do not cross');
});

check('an admin edit can reorder and drop screenshots but never borrow another email\'s', () => {
    const e = normaliseEdit({ items: [{ heading: 'B', body: 'b', imageId: 3 }, { heading: 'A', body: 'a', imageId: null }] }, [3, 4]);
    assert.deepEqual(e.items, [{ heading: 'B', body: 'b', imageId: 3 }, { heading: 'A', body: 'a', imageId: null }]);
    assert.throws(() => normaliseEdit({ items: [{ heading: 'A', body: 'a', imageId: 99 }] }, [3, 4]), DraftError);
    assert.throws(() => normaliseEdit({ items: [] }, [3]), DraftError);
    assert.deepEqual(normaliseEdit({ preheader: '' }, []), { preheader: null });
});

check('the reminder links to the review page and says nothing has been sent', () => {
    const r = renderReminderEmail({ baseUrl: 'https://bemoreswan.com', digestId: 9, subject: 'S', itemCount: 4, periodStart: '2026-09-27', periodEnd: '2026-10-03' });
    assert.match(r.html, /admin\.html\?view=product-updates&amp;id=9/);
    assert.match(r.text, /Nothing is sent to customers until you approve it/);
    assert.doesNotMatch(r.html, /Unsubscribe/, 'an operational note to ourselves carries no unsubscribe');
});

check('"What\'s new" is its own preference: email ON by default, off once unsubscribed, nothing else affected', () => {
    const cat = PREF_CATEGORIES.find(c => c.key === 'whats_new');
    assert.ok(cat, 'whats_new category exists');
    assert.equal(cat!.email.default, true);
    assert.equal(cat!.email.locked, false);
    assert.deepEqual(cat!.types, [], 'no notification type maps here — support replies stay under product_updates');
    assert.ok(isEmailEnabled({ whats_new: false }, 'ticket_reply'), 'unsubscribing does not silence support replies');
});

const API = read('netlify/functions/product-updates.ts');
const WORKER = read('netlify/functions/send-product-update-background.ts');
const UNSUB = read('netlify/functions/product-update-unsubscribe.ts');
const RECIP = read('src/utils/product-update-recipients.ts');

check('the machine token can upload a draft but every sending route is behind the admin cookie', () => {
    const machineBlock = API.slice(landmark(API, '// ── Machine routes'), landmark(API, '// ── Admin routes'));
    assert.doesNotMatch(machineBlock, /send-product-update-background|resource === 'approve'|triggerWorker\(/);
    const adminBlock = API.slice(landmark(API, '// ── Admin routes'));
    assert.ok(adminBlock.indexOf('requireAdmin(event)') < landmark(adminBlock, "resource === 'approve'"));
    assert.match(API, /hasPermission\(row\.role, 'manage_comms_templates'\)/);
    assert.match(API, /timingSafeEqual/);
});

check('approve is a conditional ready → sending update, so two clicks cannot send twice', () => {
    const approve = API.slice(landmark(API, "resource === 'approve'"), landmark(API, "resource === 'resume'"));
    assert.match(approve, /eq\(productUpdateDigests\.status, 'ready'\)\)\)\.returning/);
    assert.ok(landmark(approve, 'if (!claimed)') < landmark(approve, 'triggerWorker('));
});

check('the worker claims a (digest, user) row BEFORE it sends, and skips a row it did not claim', () => {
    const claim = landmark(WORKER, '.onConflictDoNothing()');
    assert.ok(claim < landmark(WORKER, 'await sendEmail('));
    assert.match(WORKER, /if \(!claim\) continue;/);
    assert.match(WORKER, /digest\.status !== 'sending'/);
    assert.match(WORKER, /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/);
    assert.match(read('db/product-update-emails.sql'), /UNIQUE INDEX IF NOT EXISTS product_update_sends_digest_user_uidx ON product_update_sends \(digest_id, user_id\)/);
});

check('recipients: active customer accounts, not staff, not mid-deletion, not unsubscribed', () => {
    assert.match(RECIP, /eq\(users\.status, 'active'\)/);
    assert.match(RECIP, /eq\(users\.role, 'user'\)/);
    assert.match(RECIP, /pendingDeletion/);
    assert.match(RECIP, /->>'whats_new', 'true'\) <> 'false'/);
});

check('unsubscribe: GET only shows a button (link scanners), POST merges whats_new=false', () => {
    const get = UNSUB.slice(landmark(UNSUB, "event.httpMethod === 'GET'"), landmark(UNSUB, "event.httpMethod === 'POST'"));
    assert.doesNotMatch(get, /insert|update/i);
    assert.match(UNSUB, /'\{"whats_new": false\}'::jsonb/);
    assert.match(UNSUB, /coalesce\(\$\{userProfiles\.emailPreferences\}, '\{\}'::jsonb\) \|\|/);
});

check('public routes are wired in netlify.toml', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /from = "\/api\/product-updates\/image"\s+to = "\/\.netlify\/functions\/product-update-image"/);
    assert.match(toml, /from = "\/api\/product-updates\/unsubscribe"\s+to = "\/\.netlify\/functions\/product-update-unsubscribe"/);
});

const A = read('admin.html');
check('admin: the view exists, is in Comms, loads its data, and approve is blocked while unsaved', () => {
    assert.match(A, /<section id="view-product-updates" class="admin-view hidden/);
    assert.match(A, /\{ view: 'product-updates',\s+icon: '🆕', label: "What's New Emails",\s+perm: 'manage_comms_templates' \}/);
    assert.match(A, /if \(view === 'product-updates'\) loadProductUpdates\(\);/);
    assert.match(A, /approve\.disabled = _puDirty;/);
    assert.match(A, /async function puApprove\(\) \{\n  if \(_puDirty\) return;/);
    // ⚠️ a sandboxed srcdoc iframe renders blank in Edge — the preview must use a data: URL.
    assert.match(A, /frame\.src = 'data:text\/html;charset=utf-8,' \+ encodeURIComponent/);
    assert.doesNotMatch(A, /id="pu-preview"[^>]*srcdoc/);
});

console.log(`\n${passed} checks passed`);
