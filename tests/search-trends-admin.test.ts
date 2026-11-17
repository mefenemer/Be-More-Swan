// tests/search-trends-admin.test.ts
// Admin ▸ System ▸ Search trends (docs/google-trends-plan.md §5 Phase 1): how a term's health is judged,
// and that the page and endpoint are wired, gated and never name a workspace.
//
// Run:  npx tsx tests/search-trends-admin.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { termHealth } from '../src/utils/search-trends-admin';
import { checkProvider, classifyProviderError, type TrendsProvider } from '../src/lib/trends-provider';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const now = new Date('2026-11-16T12:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
const base = { tracking: 2, fetchedAt: ago(24), taskPostedAt: null as Date | null, taskOut: false, attempts: 0, status: 'ok' };

console.log('search trends admin');

test('health: unused, stuck, failing, waiting, stale, ok — in that precedence', () => {
    assert.strictEqual(termHealth({ ...base, tracking: 0, attempts: 3 }, now), 'unused', 'nobody tracks it, so nothing to fix');
    assert.strictEqual(termHealth({ ...base, taskOut: true, taskPostedAt: ago(30) }, now), 'stuck');
    assert.strictEqual(termHealth({ ...base, taskOut: true, taskPostedAt: ago(2) }, now), 'ok', 'a task out for 2 hours is normal');
    assert.strictEqual(termHealth({ ...base, attempts: 1 }, now), 'failing');
    assert.strictEqual(termHealth({ ...base, status: 'error' }, now), 'failing');
    assert.strictEqual(termHealth({ ...base, fetchedAt: null, status: 'pending' }, now), 'waiting');
    assert.strictEqual(termHealth({ ...base, fetchedAt: ago(9 * 24) }, now), 'stale');
    assert.strictEqual(termHealth({ ...base, fetchedAt: ago(7.5 * 24) }, now), 'ok', 'a day of slack past the weekly refresh');
    assert.strictEqual(termHealth({ ...base, status: 'not_enough_data' }, now), 'ok', 'too thin is an answer, not a fault');
});

test('endpoint: platform_config, no writes while impersonating, audited, setUp:false before the SQL', () => {
    const fn = read('netlify/functions/admin-search-trends.ts');
    assert.match(fn, /hasPermission\(row\?\.role, 'platform_config'\)/);
    assert.match(fn, /if \(admin\.impersonating\) return json\(403/);
    assert.strictEqual((fn.match(/await insertAdminAuditLog\(/g) ?? []).length, 2, 'both actions audited, and awaited');
    assert.match(fn, /if \(isMissingTable\(err\)\) return json\(200, \{ setUp: false \}\)/);
});

test('shared data only: the loader never selects an organisation id per term', () => {
    const src = read('src/utils/search-trends-admin.ts');
    const termSelect = src.slice(src.indexOf('const rows = await db.select'), src.indexOf('.limit(2000)'));
    assert.ok(termSelect.length > 0 && !/organisationId/.test(termSelect));
    assert.match(src, /count\(distinct \$\{orgTrendTerms\.organisationId\}\)/, 'only a COUNT of workspaces');
});

test('no bare Date inside a raw sql fragment (prod 2026-11-16: the spend query failed)', () => {
    const src = read('src/utils/search-trends-admin.ts');
    for (const m of src.matchAll(/sql<[^>]*>`([^`]*)`/g)) {
        assert.doesNotMatch(m[1], /\$\{d30\}|\$\{d1\}|\$\{now\}/, `raw Date in: ${m[1].slice(0, 80)}`);
    }
    assert.match(src, /\$\{d30Iso\}::timestamp/);
});

test('provider check: a refused login reads as refused, not "Connected" (prod 2026-11-16)', () => {
    const refused = classifyProviderError('HTTP 401 40100 You are not authorized to access this resource.');
    assert.strictEqual(refused.status, 'refused');
    assert.strictEqual(classifyProviderError('HTTP 403 40104 Please verify your account').status, 'unverified');
    assert.strictEqual(classifyProviderError('timed out').status, 'unreachable');
    assert.strictEqual(classifyProviderError('fetch failed').status, 'unreachable');
    assert.strictEqual(classifyProviderError('HTTP 500 50000 Internal error').status, 'error');
    const html = read('admin.html');
    assert.match(html, /case 'refused':\s+return tile\('Provider', 'Login refused'/);
    assert.match(html, /case 'ok':\s+return tile\('Provider', 'Connected', `Login accepted just now/);
    const fn = read('netlify/functions/admin-search-trends.ts');
    assert.match(fn, /Promise\.all\(\[loadAdminTrends\(db, !!provider\), checkProvider\(provider\)\]\)/);
});

test('page: nav entry under System ▸ Health, title, loader, escaped rows', () => {
    const html = read('admin.html');
    assert.match(html, /\{ view: 'search-trends',\s+icon: '📈', label: 'Search trends',\s+perm: 'platform_config',\s+group: 'Health' \}/);
    assert.match(html, /'search-trends': 'Search trends',/);
    assert.match(html, /if \(view === 'search-trends'\)\s+loadSearchTrendsAdmin\(\);/);
    assert.match(html, /<section id="view-search-trends" class="admin-view hidden/);
    assert.match(html, /\$\{_strEsc\(r\.term\)\}/);
    assert.match(html, /title="\$\{_strEsc\(r\.lastError\)\}"/);
});

// checkProvider is async: a fake provider for each outcome, and a hang that must be cut off.
const fake = (ready: TrendsProvider['ready']): TrendsProvider => ({ name: 'fake', ready, post: async () => ({ ok: true, posted: [] }), get: async () => ({ ok: false, pending: true, error: '' }), live: async () => ({ ok: false, error: '' }) });
(async () => {
    total++;
    try {
        assert.deepStrictEqual(await checkProvider(null), { status: 'not_set', detail: null });
        assert.strictEqual((await checkProvider(fake(async () => ({ ok: true, ids: [] })))).status, 'ok');
        assert.strictEqual((await checkProvider(fake(async () => ({ ok: false, error: 'HTTP 401 40100 You are not authorized' })))).status, 'refused');
        assert.strictEqual((await checkProvider(fake(async () => { throw new Error('fetch failed'); }))).status, 'unreachable');
        const hung = await checkProvider(fake(() => new Promise(() => { /* never answers */ })), 50);
        assert.strictEqual(hung.status, 'unreachable', 'a hung provider is cut off, never hangs the admin page');
        passed++; console.log('  ✓ checkProvider: not set, ok, refused, unreachable, and a hang is cut off');
    } catch (err) { console.error(`  ✗ checkProvider\n    ${(err as Error).message}`); }
    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
})();
