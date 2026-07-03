// tests/notification-prefs.test.ts
// Unified Notification Preferences matrix model (src/utils/notification-prefs.ts).
//
// Run:  npx tsx tests/notification-prefs.test.ts
//
// Verifies:
//   - every raw type maps to exactly one preference category (no overlaps / no gaps)
//   - locked categories are ON regardless of stored value (account/security, billing)
//   - toggleable categories respect stored value, falling back to the category default
//   - unknown types fall to the General bucket (never throw, never silently lock)
//   - resolveInAppPrefs seeds the New Role row from the legacy notify_availability column
//   - any critical_action type lands in an in-app-locked category (models stay in sync)
// Pure logic — no DB required.

import assert from 'node:assert';
import {
    PREF_CATEGORIES, categoryForType, isInAppEnabled, isEmailEnabled,
    buildDefaults, resolveInAppPrefs,
} from '../src/utils/notification-prefs';
import { categoryOf } from '../src/utils/notification-actions';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('no raw type is mapped to more than one preference category', () => {
    const seen = new Map<string, string>();
    for (const cat of PREF_CATEGORIES) for (const t of cat.types) {
        assert.ok(!seen.has(t), `type "${t}" in both "${seen.get(t)}" and "${cat.key}"`);
        seen.set(t, cat.key);
    }
});

check('category keys are unique', () => {
    const keys = PREF_CATEGORIES.map(c => c.key);
    assert.equal(new Set(keys).size, keys.length);
});

check('locked categories stay ON even when stored false', () => {
    // account_security + payment_confirmation (billing) are locked on both channels.
    const off = { account_security: false, payment_confirmation: false };
    assert.equal(isInAppEnabled(off, 'security'), true);
    assert.equal(isEmailEnabled(off, 'payment_confirmation'), true);
    assert.equal(isInAppEnabled(off, 'billing_payment_failed'), true);
});

check('toggleable category respects a stored false', () => {
    assert.equal(isInAppEnabled({ content_calendar: false }, 'post_published'), false);
    assert.equal(isEmailEnabled({ content_calendar: false }, 'post_published'), false);
    // and a stored true / missing → default on
    assert.equal(isInAppEnabled({ content_calendar: true }, 'post_published'), true);
    assert.equal(isInAppEnabled(null, 'post_published'), true);
});

check('New Role Availability defaults OFF', () => {
    assert.equal(isInAppEnabled(null, 'new_role_availability'), false);
    assert.equal(isEmailEnabled(null, 'new_role_availability'), false);
});

check('unknown type falls back to the General bucket (toggleable, not locked)', () => {
    const cat = categoryForType('some_brand_new_type_xyz');
    assert.equal(cat.key, 'product_updates');
    assert.equal(isInAppEnabled(null, 'some_brand_new_type_xyz'), true); // default on, not locked
});

check('buildDefaults returns a boolean for every category, both channels', () => {
    for (const channel of ['inApp', 'email'] as const) {
        const d = buildDefaults(channel);
        for (const c of PREF_CATEGORIES) assert.equal(typeof d[c.key], 'boolean', `${channel}/${c.key}`);
    }
});

check('resolveInAppPrefs seeds New Role from legacy notify_availability when unstored', () => {
    assert.equal(resolveInAppPrefs(null, true)['new_role_availability'], true);
    assert.equal(resolveInAppPrefs(null, false)['new_role_availability'], false);
    // stored prefs win — legacy column is ignored once the user has in-app prefs
    assert.equal(resolveInAppPrefs({ new_role_availability: false }, true)['new_role_availability'], false);
});

check('every critical_action type lives in an in-app-locked category (models in sync)', () => {
    for (const cat of PREF_CATEGORIES) for (const t of cat.types) {
        if (categoryOf(t) === 'critical_action') {
            assert.equal(cat.inApp.locked, true, `critical type "${t}" is in non-locked category "${cat.key}"`);
        }
    }
});

console.log(`\n${passed} checks passed.`);
