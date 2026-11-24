// tests/partner-start.test.ts
// A partnership STARTS when the partner accepts the Partner Terms after an admin approves them (owner, 2026-11-24):
// Partner since, the activity clock and any waiting special rate all begin then (src/utils/partner-start.ts).
//
// Run:  npx tsx tests/partner-start.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canStart, needsAcceptance, pendingWindow } from '../src/utils/partner-start';
import { clockBase } from '../src/utils/partner-activity';
import { PARTNER_TERMS_VERSION } from '../src/config/partner-terms';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const d = (s: string) => new Date(`${s}T00:00:00Z`);

check('starts only when approved, not started, and the CURRENT terms accepted AFTER approval (application tick doesn\'t count)', () => {
    const v = PARTNER_TERMS_VERSION;
    const base = { status: 'approved', terms_version: v, partner_since: null, approved_at: d('2026-12-01') };
    assert.strictEqual(canStart({ ...base, terms_accepted_at: d('2026-12-03') }), true, 'accepted after approval');
    assert.strictEqual(canStart({ ...base, terms_accepted_at: d('2026-11-20') }), false, 'only the application tick (before approval)');
    assert.strictEqual(canStart({ ...base, status: 'applied', terms_accepted_at: d('2026-12-03') }), false, 'not approved');
    assert.strictEqual(canStart({ ...base, terms_version: '1.2', terms_accepted_at: d('2026-12-03') }), false, 'older terms');
    assert.strictEqual(canStart({ ...base, terms_accepted_at: null }), false, 'never accepted');
    assert.strictEqual(canStart({ ...base, partner_since: '2027-01-01', terms_accepted_at: d('2026-12-03') }), false, 'already started');
});
check('the Partner page asks an approved, not-started partner to accept again until they do', () => {
    const v = PARTNER_TERMS_VERSION;
    const base = { status: 'approved', terms_version: v, partner_since: null, approved_at: d('2026-12-01') };
    assert.strictEqual(needsAcceptance({ ...base, terms_accepted_at: d('2026-11-20') }), true);
    assert.strictEqual(needsAcceptance({ ...base, terms_accepted_at: d('2026-12-03') }), false);
    assert.strictEqual(needsAcceptance({ ...base, partner_since: '2026-12-03', terms_accepted_at: d('2026-11-20') }), false, 'started: no re-ask');
    assert.strictEqual(needsAcceptance({ ...base, terms_version: '1.2', terms_accepted_at: d('2026-12-03') }), true, 'older version always asks');
});
check('a waiting special rate runs from acceptance for its window (Angela: 12 months)', () => {
    assert.deepStrictEqual(pendingWindow(d('2026-12-03'), 12), { startsAt: d('2026-12-03'), endsAt: d('2027-12-03') });
});
check('no clock before the partnership starts; a reinstatement after it restarts the clock', () => {
    assert.strictEqual(clockBase(null, d('2026-12-01')), null);
    assert.deepStrictEqual(clockBase(d('2026-12-03'), d('2026-12-01')), d('2026-12-03'), 'approved, then accepted: from acceptance');
    assert.deepStrictEqual(clockBase(d('2026-12-03'), d('2027-03-01')), d('2027-03-01'), 'reinstated later: from reinstatement');
});

console.log('wiring');
check('approval never sets a start date or starts the partnership (it needs an acceptance AFTER approval)', () => {
    const a = read('netlify/functions/admin-partners.ts');
    assert.ok(a.includes("...(before.status !== 'suspended' ? { partnerSince: null, endedAt: null, endReason: null } : {}) }"));
    assert.ok(!a.includes('startPartnershipIfReady('), 'approval / reinstatement do not start it — the partner accepts on their Partner page');
    assert.ok(!a.includes('approvedAt: new Date(), partnerSince: new Date()'), 'admin-added partners also wait for acceptance');
});
check('accepting on the Partner page starts it', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes('const start = await startPartnershipIfReady(db, p.id).catch('), 'a failed start never loses the acceptance');
    assert.strictEqual((hub.match(/const retry = await startPartnershipIfReady\(db, p\.id\)/g) || []).length, 2, 'accepting again retries a failed start (review of #838)');
    assert.ok(hub.includes("if (!impersonating && canStart({"), 'opening the Partner page retries a failed start (never while impersonating)');
    assert.ok(read('src/utils/partner-start.ts').includes('AND terms_accepted_at IS NOT NULL AND (approved_at IS NULL OR terms_accepted_at >= approved_at)'), 'the SQL start needs acceptance after approval');

});
check('starting is conditional (approved, current terms, not started) and turns the waiting rate into a dated period', () => {
    const s = read('src/utils/partner-start.ts');
    assert.ok(s.includes("WHERE id = ${partnerId} AND status = 'approved' AND partner_since IS NULL AND terms_version = ${PARTNER_TERMS_VERSION}"));
    assert.ok(s.includes('INSERT INTO partner_rate_periods') && s.includes('DELETE FROM partner_pending_rates WHERE partner_id = ${partnerId}'));
    assert.ok(s.includes('return db.transaction(async (tx: Db) => {') && s.includes('FOR UPDATE'), 'one transaction (review of #838)');
    assert.ok(s.includes('rateConflict: true as const'), 'never inserts an overlapping period (behaviour in partner-start-db.test.ts)');
});
check('nothing is earned before the start; the clock and sweep skip partners who have not started', () => {
    assert.ok(read('src/utils/partner-ledger.ts').includes("if (!ref.partnerSince || terms.subscribedAt.getTime() < ref.partnerSince.getTime()) return { recorded: false, reason: 'before_partnership' };"));
    const act = read('src/utils/partner-activity.ts');
    assert.ok(act.includes("if (!since || !base) return empty;"));
    assert.ok(act.includes("WHERE status IN ('approved', 'suspended') AND partner_since IS NOT NULL"));
});
check('admins can add a special rate that waits for acceptance; a director agreement lifts only the 3.5 caps', () => {
    const a = read('netlify/functions/admin-partners.ts');
    assert.ok(a.includes("body.action === 'pending_rate' || body.action === 'pending_rate_delete'"));
    assert.ok(a.includes('errors.push(...periodShapeErrors(probe, !director));'));
    assert.ok(a.includes("if (p.partner_since) return json(409"), 'only before the partnership starts');
    assert.ok(a.includes('SELECT id FROM partners WHERE id = ${partnerId} AND partner_since IS NULL FOR UPDATE'), 'saved under a lock, never after the start');
    assert.ok(read('admin.html').includes('Add special rate that starts when they accept'));
    assert.ok(a.includes('This partner has a special rate waiting to start when they accept the Partner Terms.'), 'no dated rate while one is waiting');
    assert.ok(read('db/z-partner-start-on-acceptance.sql').includes('CREATE TABLE IF NOT EXISTS partner_pending_rates ('));
});
check('the Partner page says the partnership starts on acceptance', () => {
    const page = read('partner-content.html');
    assert.ok(page.includes('Your partnership starts when you accept the Partner Terms'));
    assert.ok(page.includes(": data.partner.status !== 'approved' ? ''"), 'not shown to a suspended partner who can\'t start');
    assert.ok(read('netlify/functions/partner-hub.ts').includes('partnerSince: p.partnerSince ?? null,'));
});

check('approval emails say the partnership starts when they accept on their Partner page (no "from today")', () => {
    const e = read('src/utils/email-templates-catalog.ts');
    assert.ok(!e.includes("p('From today you earn"), 'no promise of commission from today');
    assert.ok(e.includes('<strong>One step to start:</strong> open your Partner page and accept the Partner Terms.'));
    assert.ok(e.includes('Then accept the Partner Terms on your Partner page: your partnership starts the moment you do'));
    assert.ok(read('src/utils/partner-applications.ts').includes('FROM partner_pending_rates WHERE partner_id = ${partnerId}'), 'a waiting special rate is the rate in the email');
});
check('admin "terms accepted" uses the same rule as the Partner page', () => {
    assert.ok(read('netlify/functions/admin-partners.ts').includes('termsAccepted: !needsAcceptance({ status: r.status'));
});

check('the Partner page never tells a not-started partner that commission "keeps building up"', () => {
    const page = read('partner-content.html');
    assert.ok(!page.includes('it keeps building up but we can’t pay it until you do'));
    assert.ok(page.includes("if (moneyEl) moneyEl.textContent = data.partnerSince"), 'started on an older version → 8.1 wording; not started → starts on acceptance');
    assert.ok(page.includes('to start your partnership.'));
});

console.log(`\n${passed} passed`);
