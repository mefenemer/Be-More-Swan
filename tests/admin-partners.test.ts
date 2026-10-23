// tests/admin-partners.test.ts
// Affiliate Partner Programme, step 3 — Admin → Revenue → Partners (docs/affiliate-partner-programme-plan.md §4.5).
//
// WHY THIS EXISTS (2026-10-18): this screen sets what people outside the company are paid. Pins:
//   1. who may use it (manage_partners, never during impersonation) and that every write is audited;
//   2. rate edits go through validatePeriodChanges INSIDE a locked transaction, so two admins can't
//      both pass validation against the same starting state;
//   3. admins pick UK days — "from 1 July" is midnight UK time (23:00 UTC in summer) — and a date the
//      screen is not changing is sent back as an exact instant, so it can't drift and trip the
//      "a started period's start date is fixed" rule;
//   4. the modals sit OUTSIDE every .admin-view (a display:none ancestor hides them for good — memory
//      admin-modals-trapped-in-view-sections).
//
// Run:  npx tsx tests/admin-partners.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPermission } from '../src/utils/rbac';
import { ukMidnightUtc } from '../src/utils/partner-rate-periods';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const api = read('netlify/functions/admin-partners.ts');
const html = read('admin.html');

console.log('UK days');

check('a winter date starts at midnight UTC, a summer date at 23:00 UTC the day before', () => {
    assert.strictEqual(ukMidnightUtc('2026-12-01')?.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.strictEqual(ukMidnightUtc('2027-07-01')?.toISOString(), '2027-06-30T23:00:00.000Z');
    assert.strictEqual(ukMidnightUtc('2027-03-28')?.toISOString(), '2027-03-28T00:00:00.000Z', 'clocks go forward at 01:00, so midnight is still GMT');
    assert.strictEqual(ukMidnightUtc('2026-10-25')?.toISOString(), '2026-10-24T23:00:00.000Z', 'clocks go back at 02:00, so midnight is still BST');
});

check('anything that is not a real date is refused', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '1 Dec 2026', '', '2026-12-01T00:00:00Z']) assert.strictEqual(ukMidnightUtc(bad), null, bad);
});

console.log('access and audit');

check('billing admins and above can manage partners; support agents cannot', () => {
    assert.ok(hasPermission('billing_admin', 'manage_partners'));
    assert.ok(hasPermission('super_admin', 'manage_partners'));
    assert.ok(!hasPermission('support_agent', 'manage_partners'));
});

check('the endpoint checks manage_partners and refuses impersonation sessions', () => {
    assert.ok(api.includes("requirePermission(admin?.role, 'manage_partners')"));
    assert.ok(api.includes("if (tok.scope === 'impersonate') return json(403"));
});

check('every write is audited', () => {
    for (const action of ['partner_rates_change', 'partner_settings_update', 'partner_decision', 'partner_create']) {
        assert.ok(api.includes(`await audit('${action}'`), `${action} is not audited`);
        assert.ok(read('src/utils/admin-audit.ts').includes(`| '${action}'`), `${action} missing from AdminAuditAction`);
    }
});

console.log('rate edits');

check('validated inside the transaction, after taking the rate lock', () => {
    const tx = api.slice(api.indexOf('await db.transaction(async (tx) => {'));
    const lock = tx.indexOf("pg_advisory_xact_lock(hashtext('partner_rate_periods'))");
    const validate = tx.indexOf('validatePeriodChanges(before, changes, new Date())');
    const write = tx.indexOf('tx.insert(partnerRatePeriods)');
    assert.ok(lock > 0 && validate > lock && write > validate);
});

check('a field the screen does not send keeps its stored value (no date round-trip)', () => {
    assert.ok(api.includes('const startsAt = start === undefined ? existing?.startsAt ?? null : start;'));
    assert.ok(api.includes('const endsAt = end === undefined ? existing?.endsAt ?? null : end;'));
    assert.ok(html.includes("changes.push({ op: 'update', id: latest.id, period: { endsOn: terms.startsOn } });"), 'scheduling sends only the end date of the rate it ends');
});

check('decisions are conditional on the status that was read (two admins cannot both win)', () => {
    assert.ok(api.includes('.where(and(eq(partners.id, partnerId), eq(partners.status, before.status)))'));
    assert.ok(api.includes("approve:   { from: ['applied', 'rejected', 'ended'], to: 'approved'"));
    assert.ok(api.includes("suspend:   { from: ['approved'],            to: 'suspended'"));
});

console.log('the screen');

check('Revenue nav entry, router line and section all exist', () => {
    assert.ok(html.includes("{ view: 'partners',       icon: '🤝', label: 'Partners',              perm: 'manage_partners' },"));
    assert.ok(html.includes("if (view === 'partners')        loadPartners();"));
    assert.ok(html.includes('<section id="view-partners" class="admin-view hidden'));
});

check('both modals sit outside every .admin-view section', () => {
    for (const id of ['partner-rate-modal', 'partner-add-modal']) {
        const at = html.indexOf(`<div id="${id}"`);
        assert.ok(at > 0, `${id} missing`);
        const before = html.slice(0, at);
        const opens = (before.match(/<section id="view-/g) || []).length;
        const closes = (before.match(/<\/section>/g) || []).length;
        assert.ok(closes >= opens, `${id} is inside an admin-view section`);
    }
});

check('rejecting, suspending and deleting ask first, through dialogs.js', () => {
    const js = html.slice(html.indexOf('// ── Partners (admin-partners.ts)'), html.indexOf('// ── Analytics ──'));
    assert.ok(js.includes('await window.promptModal(msg'));
    assert.ok(js.includes("{ title: 'Delete upcoming rate', confirmLabel: 'Delete', confirmColor: '#dc2626' }"));
    assert.ok(!/\bconfirm\(|\bprompt\(|\balert\(/.test(js.replace(/window\.(confirmModal|promptModal|alertModal)\(/g, '')), 'no browser dialogs');
});

console.log(`\n${passed} passed`);
