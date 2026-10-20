// tests/admin-cascade-deletes.test.ts
// Every Delete button in the admin portal either works end to end or says why it can't.
//
// 2026-10-20 audit, after "Delete failed: Method Not Allowed" (see admin-delete-record-method.test.ts):
//   - feature_flags / platform_config / supported_languages rows are keyed by a STRING. The sheet sent
//     them to cascade-preview, which needs a numeric id ("table and id are required"), and to
//     admin-delete-record, which had no config for them ("Unknown table"). master-data-api already
//     deleted them by key; nothing called it.
//   - organisations and content_assets were configured as soft deletes on an is_active column neither
//     table has — a 500 after the audit row was written.
//   - a failed preview replaced the sheet's inner markup, so every later open threw until a reload.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { TABLE_DELETE_CONFIG } from '../src/utils/delete-tiers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const UI = read('admin.html');
const SCHEMA = read('db/schema.ts');
const MD = read('netlify/functions/master-data-api.ts');

/** table name → the column block of its pgTable definition. */
const tables = new Map<string, string>();
for (const m of SCHEMA.matchAll(/pgTable\(\s*["']([a-z_]+)["']\s*,\s*\{([\s\S]*?)\n\}/g)) tables.set(m[1], m[2]);

const SOFT_COLUMN: Record<string, string> = { isActive: 'is_active', deletedAt: 'deleted_at' };

/** Every table the admin page offers a Delete for, and the id expression it passes. */
const offered = new Map<string, string>();
for (const m of UI.matchAll(/delBtn\('([a-z_]+)',\s*([^,]+),/g)) offered.set(m[1], m[2].trim());
for (const m of UI.matchAll(/openCascadeDeleteSheet\('([a-z_]+)',\s*([^,]+),/g)) offered.set(m[1], m[2].trim());

const keyedBlock = UI.slice(landmark(UI, 'const KEYED_DELETES = {'), landmark(UI, 'async function openCascadeDeleteSheet('));
const keyed = new Map<string, { resource: string; param: string }>();
for (const m of keyedBlock.matchAll(/^\s*([a-z_]+):\s*\{ resource: '([a-z-]+)',\s*param: '([a-z]+)'/gm)) keyed.set(m[1], { resource: m[2], param: m[3] });

console.log('\nadmin-cascade-deletes');

check('the admin page still offers the deletes this test audits', () => {
    for (const t of ['users', 'master_plans', 'feature_flags', 'supported_languages', 'platform_config']) {
        assert.ok(offered.has(t), `no Delete button found for ${t} — update this test`);
    }
});

check('every offered Delete has a route: keyed master data, users, or TABLE_DELETE_CONFIG with a numeric id', () => {
    for (const [table, idExpr] of offered) {
        if (keyed.has(table) || table === 'users') continue;
        assert.ok(TABLE_DELETE_CONFIG[table], `${table} has a Delete button but no TABLE_DELETE_CONFIG entry → "Unknown table"`);
        assert.match(idExpr, /\.id$|^uid$/, `${table} passes ${idExpr}; cascade-preview and admin-delete-record need a numeric id`);
    }
});

check('each keyed table is deleted by a master-data-api handler that takes that query param', () => {
    const handlerFor: Record<string, string> = {
        'feature-flags': 'async function handleFeatureFlags(',
        'platform-config': 'async function handlePlatformConfig(',
        'supported-languages': 'async function handleSupportedLanguages(',
    };
    assert.equal(keyed.size, 3);
    for (const [table, { resource, param }] of keyed) {
        assert.ok(MD.includes(`case '${resource}':`), `master-data-api has no '${resource}' resource (${table})`);
        const start = landmark(MD, handlerFor[resource]);
        const fn = MD.slice(start, MD.indexOf('\nasync function ', start + 10));
        const del = fn.slice(landmark(fn, "if (method === 'DELETE')"));
        assert.ok(fn.includes(`queryStringParameters?.${param}`), `${resource} does not read ?${param}=`);
        assert.match(del, /reason: deleteReason\(event\)/, `${resource} must record the admin's reason`);
    }
});

check('keyed deletes skip cascade-preview and go to master-data-api with the reason', () => {
    const open = UI.slice(landmark(UI, 'async function openCascadeDeleteSheet('), landmark(UI, 'async function confirmCascadeDelete()'));
    assert.ok(landmark(open, 'const keyed = KEYED_DELETES[table]') < landmark(open, '/.netlify/functions/cascade-preview'));
    const confirm = UI.slice(landmark(UI, 'async function confirmCascadeDelete()'), landmark(UI, "window.showToast?.('Delete failed: '"));
    const branch = confirm.slice(landmark(confirm, 'if (keyed) {'), landmark(confirm, "} else if (_cascadeTable === 'users')"));
    assert.match(branch, /\$\{MD_API\}\?resource=\$\{keyed\.resource\}&\$\{keyed\.param\}=/);
    assert.match(branch, /method: 'DELETE'/);
    assert.match(branch, /JSON\.stringify\(\{ reason \}\)/);
});

check('every soft-delete table has the column its soft delete writes', () => {
    for (const [table, cfg] of Object.entries(TABLE_DELETE_CONFIG)) {
        if (cfg.tier !== 'soft' || table === 'users') continue; // users never reach the soft path
        const body = tables.get(table);
        assert.ok(body, `${table} is not in db/schema.ts`);
        const col = SOFT_COLUMN[cfg.softField ?? ''];
        assert.ok(col, `${table} soft delete has no softField`);
        assert.ok(body!.includes(`"${col}"`) || body!.includes(`'${col}'`), `${table} has no ${col} column — the soft delete would 500`);
        assert.ok(body!.includes('updated_at'), `${table} has no updated_at — the soft delete sets it`);
    }
});

check('organisations and content_assets are blocked with a reason that says what to do instead', () => {
    for (const t of ['organisations', 'content_assets']) {
        assert.equal(TABLE_DELETE_CONFIG[t]?.tier, 'blocked', t);
        assert.ok((TABLE_DELETE_CONFIG[t].blockedReason ?? '').length > 40, `${t} needs an actionable reason`);
    }
});

check('a failed preview never replaces the sheet markup it reuses next time', () => {
    const open = UI.slice(landmark(UI, 'async function openCascadeDeleteSheet('), landmark(UI, 'async function confirmCascadeDelete()'));
    const catchBlock = open.slice(landmark(open, '} catch (e) {'));
    assert.ok(!/getElementById\('cascade-preview-content'\)\.innerHTML\s*=/.test(catchBlock));
    assert.match(catchBlock, /getElementById\('cascade-groups'\)\.innerHTML = /);
});

console.log(`\n${passed} checks passed.`);
