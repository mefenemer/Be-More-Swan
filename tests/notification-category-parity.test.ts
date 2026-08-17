// tests/notification-category-parity.test.ts
// The type→category map exists TWICE — in TypeScript (src/utils/notification-actions.ts TYPE_CATEGORY)
// and in SQL (db/notifications-categorization.sql, as a CASE inside notification_category_for_type,
// stamped by a BEFORE INSERT trigger). Nothing kept them in step.
//
// ── Why the drift is silent, and why it is worth a test ──────────────────────
// A type the CASE does not know falls to `ELSE 'informational'`. The insert SUCCEEDS — 'informational'
// satisfies the category CHECK — so the row is written, stamped with the wrong category and the lowest
// priority. The client then reads the STORED column for styling and sort while the server counts
// action items from the CODE map, so the notification is counted as an action item and rendered as a
// low-priority notice at the bottom of the bell.
//
// This has already happened twice. The file's own comments record thirteen types drifting by
// 2026-08-16, and it happened again the same week `lead_reply_received` was added — on the one
// notification in the Lead Generator whose entire purpose is to be noticed.
//
// Nothing here touches a database: both maps are read as source.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../src/utils/notification-actions';
import { PREF_CATEGORIES } from '../src/utils/notification-prefs';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const TS = read('src/utils/notification-actions.ts');
const SQL = read('db/notifications-categorization.sql');

/** Every `type: 'category'` pair in the TS map, read from source rather than from the private const. */
function tsPairs(): Map<string, string> {
    const block = TS.slice(
        landmark(TS, 'TYPE_CATEGORY'),
        landmark(TS, 'export const categoryOf'),
    );
    const out = new Map<string, string>();
    // ⚠️ NOT anchored to the start of a line. The TS map packs several pairs per line
    // (`trial_expired: 'critical_action', trial_expiring_soon: 'suggested_action',`), and a `^\s*`
    // anchor silently read only the first of each — which produced a list of phantom "orphans" and
    // made the parity check look like a drift report.
    for (const m of block.matchAll(/([a-z0-9_]+):\s*'(critical_action|suggested_action|state_change|celebratory|informational)'/g)) {
        out.set(m[1], m[2]);
    }
    return out;
}

/** Every `WHEN 'type' THEN 'category'` in the SQL CASE. */
function sqlPairs(): Map<string, string> {
    const block = SQL.slice(
        landmark(SQL, 'FUNCTION notification_category_for_type'),
        landmark(SQL, "ELSE 'informational'"),
    );
    const out = new Map<string, string>();
    for (const m of block.matchAll(/WHEN\s+'([a-z0-9_]+)'\s+THEN\s+'([a-z_]+)'/g)) {
        out.set(m[1], m[2]);
    }
    return out;
}

check('both maps were actually parsed (a broken scan must fail, not silently pass)', () => {
    // Without this the two extractors could return empty maps and every comparison below would pass
    // over nothing at all — the exact failure this file exists to prevent, one level up.
    assert.ok(tsPairs().size > 40, `TS map looks unparsed (${tsPairs().size} entries)`);
    assert.ok(sqlPairs().size > 40, `SQL map looks unparsed (${sqlPairs().size} entries)`);
});

check('no type is categorised one way in code and another in the database', () => {
    const ts = tsPairs();
    const sql = sqlPairs();
    const conflicts: string[] = [];
    for (const [type, cat] of ts) {
        const dbCat = sql.get(type);
        if (dbCat && dbCat !== cat) conflicts.push(`${type}: code=${cat} db=${dbCat}`);
    }
    assert.deepStrictEqual(conflicts, [],
        'the client styles and sorts from the STORED category while the server counts action items '
        + 'from the code map, so a disagreement renders one thing and counts another');
});

check('every ACTIONABLE type in code is known to the SQL CASE', () => {
    // The ELSE is 'informational'. For a state_change or informational type that is harmless; for a
    // critical_action or suggested_action it silently demotes the alert to the bottom of the bell.
    const sql = sqlPairs();
    const missing = [...tsPairs()]
        .filter(([, cat]) => cat === 'critical_action' || cat === 'suggested_action')
        .map(([type]) => type)
        .filter((type) => !sql.has(type));
    assert.deepStrictEqual(missing, [],
        'these fall to ELSE \'informational\' in the database: add each to '
        + 'db/notifications-categorization.sql — and remember it is a MANUAL apply, so the row is '
        + 'mis-stamped until the file is run against every environment');
});

check('the SQL knows no type the code has forgotten', () => {
    // The reverse drift is milder but still a lie: the DB would stamp a category for a type the code
    // resolves as 'informational' through categoryOf().
    const ts = tsPairs();
    const orphans = [...sqlPairs().keys()].filter((type) => !ts.has(type));
    assert.deepStrictEqual(orphans, [],
        'the SQL CASE names types the TS map does not — one of the two has been edited alone');
});

/**
 * Types that are toggleable in the preferences matrix but carry no TYPE_CATEGORY entry, so
 * `categoryOf()` resolves them to 'informational'.
 *
 * ⚠️ These three PREDATE this test and are recorded rather than fixed: changing how a live
 * notification renders and sorts is a product decision, not a tidy-up, and `admin_message` in
 * particular is locked ON in-app precisely because it must never be missed. Left as an explicit
 * allowlist so a NEW omission still fails here — the point of the guard is to stop the list growing.
 */
const KNOWN_UNCATEGORISED = ['admin_message', 'issue_update', 'milestone'];

check('no LEAD notification type is left to the informational fallback', () => {
    // ── Scope, stated rather than assumed ────────────────────────────────────
    // Measured 2026-08-17: of 93 template types, FIFTEEN carry no TYPE_CATEGORY entry and resolve to
    // 'informational' by default — among them `security_incident_p0`, `ai_review` and
    // `social_token_refresh_failed`, none of which read as informational. That is a real finding and a
    // separate job: each needs a product decision about how it renders and sorts, and blanket-mapping
    // fifteen live notifications from a test file would be exactly the kind of drive-by change that
    // makes a category map untrustworthy.
    //
    // So this check guards the surface it was written for — the Lead Generator — and the counts above
    // are recorded so the wider gap is not lost. `no NEW preference type is left uncategorised` below
    // is what stops the fifteen becoming sixteen through the preferences matrix.
    const leadTypes = [...new Set(NOTIFICATION_DEFAULTS.map((t) => t.type))]
        .filter((type) => /lead|outreach|search|discovery|strategy/.test(type));
    assert.ok(leadTypes.length >= 3, `the type filter matched too little to be checking anything (${leadTypes.length})`);
    const uncategorised = leadTypes.filter((type) => !tsPairs().has(type));
    assert.deepStrictEqual(uncategorised, [],
        'a lead notification resolving to informational sorts to the bottom of the bell — add an '
        + 'explicit TYPE_CATEGORY entry AND the matching WHEN in db/notifications-categorization.sql');
});

check('no NEW preference type is left uncategorised', () => {
    // An unmapped type also falls through to the product_updates preference fallback, so muting
    // product news would silently mute it. This is the third place the same name has to appear.
    const ts = tsPairs();
    const stray = PREF_CATEGORIES
        .flatMap((c) => c.types)
        .filter((type) => !ts.has(type) && !KNOWN_UNCATEGORISED.includes(type));
    assert.deepStrictEqual(stray, [],
        'these are toggleable in the preferences matrix but uncategorised in TYPE_CATEGORY');
});

check('the allowlist has not gone stale', () => {
    // An allowlist nobody prunes is how an exception becomes a rule. If one of these gains a real
    // entry, this fails and the name should simply be deleted from the list above.
    const ts = tsPairs();
    const nowMapped = KNOWN_UNCATEGORISED.filter((type) => ts.has(type));
    assert.deepStrictEqual(nowMapped, [],
        'these are categorised now — remove them from KNOWN_UNCATEGORISED');
});

console.log(`\n${passed} checks passed.\n`);
