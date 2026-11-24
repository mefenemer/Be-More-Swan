// tests/partner-start.test.ts
// A partnership STARTS when the partner accepts the Partner Terms after an admin approves them (owner, 2026-11-24):
// Partner since, the activity clock and any waiting special rate all begin then (src/utils/partner-start.ts).
//
// Run:  npx tsx tests/partner-start.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canStart, pendingWindow } from '../src/utils/partner-start';
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

check('starts only when approved AND the current terms accepted AND not already started', () => {
    assert.strictEqual(canStart({ status: 'approved', terms_version: PARTNER_TERMS_VERSION, partner_since: null }), true);
    assert.strictEqual(canStart({ status: 'applied', terms_version: PARTNER_TERMS_VERSION, partner_since: null }), false, 'not approved');
    assert.strictEqual(canStart({ status: 'approved', terms_version: '1.2', partner_since: null }), false, 'older terms');
    assert.strictEqual(canStart({ status: 'approved', terms_version: null, partner_since: null }), false, 'never accepted');
    assert.strictEqual(canStart({ status: 'approved', terms_version: PARTNER_TERMS_VERSION, partner_since: '2027-01-01' }), false, 'already started');
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
check('approval no longer sets a start date; it starts the partnership only if the current terms were already accepted', () => {
    const a = read('netlify/functions/admin-partners.ts');
    assert.ok(a.includes("...(before.status !== 'suspended' ? { partnerSince: null, endedAt: null, endReason: null } : {}) }"));
    assert.ok(a.includes("if (rule.to === 'approved' && before.status !== 'suspended') await startPartnershipIfReady(db, partnerId, now);"));
    assert.ok(!a.includes('approvedAt: new Date(), partnerSince: new Date()'), 'admin-added partners also wait for acceptance');
});
check('accepting on the Partner page starts it', () => {
    assert.ok(read('netlify/functions/partner-hub.ts').includes('const start = await startPartnershipIfReady(db, p.id);'));
});
check('starting is conditional (approved, current terms, not started) and turns the waiting rate into a dated period', () => {
    const s = read('src/utils/partner-start.ts');
    assert.ok(s.includes("WHERE id = ${partnerId} AND status = 'approved' AND partner_since IS NULL AND terms_version = ${PARTNER_TERMS_VERSION}"));
    assert.ok(s.includes('INSERT INTO partner_rate_periods') && s.includes('DELETE FROM partner_pending_rates WHERE partner_id = ${partnerId}'));
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
    assert.ok(read('admin.html').includes('Add special rate that starts when they accept'));
    assert.ok(read('db/z-partner-start-on-acceptance.sql').includes('CREATE TABLE IF NOT EXISTS partner_pending_rates ('));
});
check('the Partner page says the partnership starts on acceptance', () => {
    assert.ok(read('partner-content.html').includes('Your partnership starts when you accept the Partner Terms'));
    assert.ok(read('netlify/functions/partner-hub.ts').includes('partnerSince: p.partnerSince ?? null,'));
});

console.log(`\n${passed} passed`);
