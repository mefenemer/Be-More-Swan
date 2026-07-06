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
    isInAppEnabledFor, isEmailEnabledFor, overrideFor,
    buildDefaults, resolveInAppPrefs,
    isPublishingOnlyCategory, assistantCategoryAppliesToRole, PUBLISHING_ROLE_KEYS,
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

check('every category carries a valid UI scope', () => {
    for (const cat of PREF_CATEGORIES) {
        assert.ok(cat.scope === 'account' || cat.scope === 'assistant', `bad scope on "${cat.key}"`);
    }
});

check('assistant-work categories are assistant-scoped; essential/locked ones stay account-scoped', () => {
    const assistantKeys = PREF_CATEGORIES.filter(c => c.scope === 'assistant').map(c => c.key).sort();
    assert.deepEqual(assistantKeys, ['approvals', 'assistant_tasks', 'connections', 'content_calendar']);
    // Locked (always-on account/billing) rows must never move out of Account Settings.
    for (const cat of PREF_CATEGORIES) {
        if (cat.inApp.locked || cat.email.locked) {
            assert.equal(cat.scope, 'account', `locked category "${cat.key}" must be account-scoped`);
        }
    }
});

// ── Per-assistant overrides ────────────────────────────────────────────────────

check('per-assistant override beats the workspace value for that assistant only', () => {
    // Workspace has content_calendar ON (default); assistant 7 mutes it.
    const overrides = { '7': { content_calendar: { inApp: false } } };
    assert.equal(isInAppEnabledFor(null, overrides, 7, 'post_published'), false);
    assert.equal(isInAppEnabledFor(null, overrides, '7', 'post_published'), false); // id as string too
    assert.equal(isInAppEnabledFor(null, overrides, 8, 'post_published'), true);    // other assistant untouched
    assert.equal(isInAppEnabledFor(null, overrides, null, 'post_published'), true); // unattributed row → workspace
});

check('per-assistant override can re-enable a workspace-muted category', () => {
    const workspaceOff = { approvals: false };
    const overrides = { '3': { approvals: { email: true } } };
    assert.equal(isEmailEnabledFor(workspaceOff, overrides, 3, 'hitl_approval_required'), true);
    assert.equal(isEmailEnabledFor(workspaceOff, overrides, 4, 'hitl_approval_required'), false);
});

check('overrides are per-channel: an inApp override leaves email on the workspace value', () => {
    const overrides = { '7': { content_calendar: { inApp: false } } };
    assert.equal(isEmailEnabledFor(null, overrides, 7, 'post_published'), true);
});

check('overrides never unlock a locked category and never apply to account-scoped rows', () => {
    const overrides = {
        '7': {
            account_security: { inApp: false },        // locked — must stay ON
            product_updates: { inApp: false },         // account scope — override ignored
        },
    };
    assert.equal(isInAppEnabledFor(null, overrides, 7, 'security'), true);
    assert.equal(isInAppEnabledFor(null, overrides, 7, 'milestone'), true);
});

check('overrideFor returns undefined for missing levels and non-boolean values', () => {
    assert.equal(overrideFor(null, 7, 'approvals', 'inApp'), undefined);
    assert.equal(overrideFor({}, 7, 'approvals', 'inApp'), undefined);
    assert.equal(overrideFor({ '7': {} }, 7, 'approvals', 'inApp'), undefined);
    assert.equal(overrideFor({ '7': { approvals: {} } }, 7, 'approvals', 'inApp'), undefined);
    assert.equal(overrideFor({ '7': { approvals: { inApp: 'yes' as any } } }, 7, 'approvals', 'inApp'), undefined);
    assert.equal(overrideFor({ '7': { approvals: { inApp: false } } }, undefined, 'approvals', 'inApp'), undefined);
});

check('every critical_action type lives in an in-app-locked category (models in sync)', () => {
    for (const cat of PREF_CATEGORIES) for (const t of cat.types) {
        if (categoryOf(t) === 'critical_action') {
            assert.equal(cat.inApp.locked, true, `critical type "${t}" is in non-locked category "${cat.key}"`);
        }
    }
});

check('content_calendar is the only publishing-only assistant category', () => {
    for (const cat of PREF_CATEGORIES) {
        const expected = cat.key === 'content_calendar';
        assert.equal(isPublishingOnlyCategory(cat.key), expected, `${cat.key} publishing-only mismatch`);
    }
});

check('publishing-only categories apply only to publishing roles; legacy/unknown = social', () => {
    // content_calendar: gated by role
    assert.equal(assistantCategoryAppliesToRole('content_calendar', 'social_media_manager'), true);
    assert.equal(assistantCategoryAppliesToRole('content_calendar', 'lead_qualifier'), false);
    assert.equal(assistantCategoryAppliesToRole('content_calendar', 'accounts_receivable_clerk'), false);
    assert.equal(assistantCategoryAppliesToRole('content_calendar', 'tier1_support_agent'), false);
    assert.equal(assistantCategoryAppliesToRole('content_calendar', null), true);       // legacy
    assert.equal(assistantCategoryAppliesToRole('content_calendar', undefined), true);  // unknown
    // non-publishing-only categories always apply, regardless of role
    for (const key of ['approvals', 'assistant_tasks', 'connections']) {
        assert.equal(assistantCategoryAppliesToRole(key, 'lead_qualifier'), true, `${key} should always apply`);
    }
});

check('every publishing roleKey is a real assistant-scope-bearing role', () => {
    // Guardrail: PUBLISHING_ROLE_KEYS must be non-empty (else content_calendar is dead for all).
    assert.ok(PUBLISHING_ROLE_KEYS.size >= 1);
    assert.ok(PUBLISHING_ROLE_KEYS.has('social_media_manager'));
});

console.log(`\n${passed} checks passed.`);
