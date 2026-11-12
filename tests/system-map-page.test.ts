// tests/system-map-page.test.ts — System Map Phase 2 (docs/system-map-plan.md): the map's money maths,
// the fixed-bill validator, versions kept true, and the page + chat reading one source.
// No database: pure functions and source scans.
// Run:  npx tsx tests/system-map-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSystemMap, validateFixedCostRequest, toGbp, type MapInput } from '../src/utils/system-map';
import { SERVICES, SYSTEM_VERSIONS } from '../src/utils/system-registry';
import { STRIPE_API_VERSION } from '../src/utils/stripe';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nSystem Map page — maths, bills, versions, one source');

const svc = (key: string, category: string, health = 'ok', configured: boolean | null = true) => ({ key, name: key, category, tier: 'core', health, configured });
const base = (over: Partial<MapInput> = {}): MapInput => ({
    status: { environment: 'staging', runtime: null, readiness: null, services: [svc('anthropic', 'AI'), svc('fal', 'AI', 'error'), svc('netlify', 'Hosting & CI', 'n/a')] },
    usage: [
        { model: 'claude-opus-5-5', usdAll: 100, usd30: 10, calls30: 5, callsAll: 50, firstAt: '2026-09-01 10:00:00' },
        { model: 'fal-ai/flux-2-pro', usdAll: 20, usd30: 2, calls30: 4, callsAll: 40, firstAt: '2026-10-13 09:00:00' },
        { model: 'mystery-x', usdAll: 1, usd30: 1, calls30: 1, callsAll: 1, firstAt: '2026-11-01 00:00:00' },
    ],
    rolesByModel30: { 'claude-opus-5-5': ['social', 'blog'] },
    configuredRoleModels: { social: 'claude-opus-5-5', mentor: 'claude-sonnet-5-5' },
    fixed: [{ id: 1, systemKey: 'netlify', label: 'Pro', amountMonthly: 30.44, currency: 'USD', startedOn: '2026-10-01', endedOn: null, note: '' }],
    tasks: { all: 1000, d30: 100, firstAt: '2026-08-01 00:00:00' },
    fx: { USD: 0.8, EUR: 0.85 },
    fxFromConfig: true,
    now: new Date('2026-10-31T00:00:00Z'),
    ...over,
});

check('spend converts to GBP and groups under each system', () => {
    const m = assembleSystemMap(base());
    const a = m.systems.find((s) => s.key === 'anthropic')!;
    assert.strictEqual(a.spend.variable30Gbp, 8);
    assert.strictEqual(a.spend.variableAllGbp, 80);
    assert.strictEqual(a.spend.since, '2026-09-01 10:00:00');
    assert.deepStrictEqual(a.models.map((x) => x.model).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
});

check('a model chosen for a role but never used is still listed, at £0', () => {
    const a = assembleSystemMap(base()).systems.find((s) => s.key === 'anthropic')!;
    const sonnet = a.models.find((x) => x.model === 'claude-sonnet-5-5')!;
    assert.deepStrictEqual(sonnet.chosenFor, ['mentor']);
    assert.strictEqual(sonnet.spendAllGbp, 0);
    assert.deepStrictEqual(a.models.find((x) => x.model === 'claude-opus-5-5')!.roles30, ['blog', 'social']);
});

check('fixed bills pro-rate and convert; all time runs from their start', () => {
    const n = assembleSystemMap(base()).systems.find((s) => s.key === 'netlify')!;
    assert.strictEqual(n.spend.fixed30Gbp, 24);      // 30 days of $30.44/month at 0.8
    assert.strictEqual(n.spend.fixedAllGbp, 24);     // started 1 Oct = the same 30 days
    assert.strictEqual(n.spend.since, '2026-10-01');
});

check('unmapped spend is flagged and still counted in the totals', () => {
    const m = assembleSystemMap(base());
    assert.deepStrictEqual(m.unmappedModels.map((x) => x.model), ['mystery-x']);
    assert.strictEqual(m.totals.spend30Gbp, 8 + 1.6 + 24 + 0.8);
    assert.strictEqual(m.totals.systemsDown, 1);
    assert.strictEqual(m.totals.costPerTask30Gbp, Math.round((34.4 / 100) * 10000) / 10000);
    assert.strictEqual(m.totals.spendSince, '2026-09-01 10:00:00');
});

check('no tasks → no cost per task, not a divide by zero', () => {
    assert.strictEqual(assembleSystemMap(base({ tasks: { all: 0, d30: 0, firstAt: null } })).totals.costPerTask30Gbp, null);
});

check('toGbp: GBP as is, unknown currency counts as 0 rather than as pounds', () => {
    assert.strictEqual(toGbp(10, 'GBP', {}), 10);
    assert.strictEqual(toGbp(10, 'usd', { USD: 0.8 }), 8);
    assert.strictEqual(toGbp(10, 'JPY', { USD: 0.8 }), 0);
});

const keys = SERVICES.map((s) => s.key);
check('bill validator: accepts a good bill and cleans it', () => {
    const v = validateFixedCostRequest({ action: 'add_fixed', systemKey: 'netlify', label: ' Pro ', amountMonthly: '19.005', currency: 'usd', startedOn: '2026-09-01', endedOn: '' }, keys);
    assert.ok('ok' in v);
    const ok = (v as any).ok;
    assert.strictEqual(ok.currency, 'USD'); assert.strictEqual(ok.endedOn, null); assert.strictEqual(ok.label, 'Pro'); assert.strictEqual(ok.amountMonthly, 19.01);
});

check('bill validator: refuses what would corrupt the totals', () => {
    const bad = [
        { action: 'add_fixed', systemKey: 'nope', amountMonthly: 1, startedOn: '2026-01-01' },
        { action: 'add_fixed', systemKey: 'netlify', amountMonthly: -1, startedOn: '2026-01-01' },
        { action: 'add_fixed', systemKey: 'netlify', amountMonthly: 1, currency: 'JPY', startedOn: '2026-01-01' },
        { action: 'add_fixed', systemKey: 'netlify', amountMonthly: 1, startedOn: '1 Sep' },
        { action: 'add_fixed', systemKey: 'netlify', amountMonthly: 1, startedOn: '2026-09-01', endedOn: '2026-08-01' },
        { action: 'end_fixed', id: 3, endedOn: 'soon' },
        { action: 'delete_fixed', id: 0 },
        { action: 'drop_table' },
    ];
    for (const b of bad) assert.ok('error' in validateFixedCostRequest(b, keys), `accepted ${JSON.stringify(b)}`);
});

check('SDK versions match what is installed, Stripe matches its constant', () => {
    for (const [key, v] of Object.entries(SYSTEM_VERSIONS)) {
        for (const part of (v.sdk ?? '').split(' · ').filter(Boolean)) {
            const at = part.lastIndexOf(' ');
            const pkg = part.slice(0, at), ver = part.slice(at + 1);
            const installed = JSON.parse(read(`node_modules/${pkg}/package.json`)).version;
            assert.strictEqual(ver, installed, `${key}: ${pkg} says ${ver}, installed ${installed} — update SYSTEM_VERSIONS`);
        }
    }
    assert.strictEqual(SYSTEM_VERSIONS.stripe.api, STRIPE_API_VERSION);
    for (const key of Object.keys(SYSTEM_VERSIONS)) assert.ok(keys.includes(key), `SYSTEM_VERSIONS names unknown system ${key}`);
});

check('every registry category lands in a map group', () => {
    const js = read('src/components/admin-system-map.js');
    const cats = [...new Set(SERVICES.map((s) => s.category))];
    const known = (c: string) => ['AI', 'Media', 'Storage', 'Database', 'Security', 'Email', 'Billing', 'Search'].includes(c) || /Hosting|DNS|Config/.test(c) || c.startsWith('Connector');
    assert.deepStrictEqual(cats.filter((c) => !known(c)), [], 'a new category falls into "Hosting & config" by default — give it a group in GROUPS');
    assert.ok(js.includes("c.startsWith('Connector')"));
});

check('the page and the chat read the same loader; chat cards go through the page endpoint', () => {
    assert.ok(read('netlify/functions/admin-system-map.ts').includes('loadSystemMap(db'));
    const chat = read('netlify/functions/admin-systems-chat.ts');
    assert.ok(chat.includes('loadSystemMap(db'));
    assert.ok(chat.includes('validateFixedCostRequest('), 'chat cards must be checked by the same validator as the page');
    assert.ok(!/db\.(insert|update|delete)\(/.test(chat), 'the chat never writes — cards do, through admin-system-map');
    const js = read('src/components/admin-system-map.js');
    const confirmAt = js.indexOf('async function confirmCard');
    assert.ok(confirmAt > 0 && js.indexOf('fetch(API', confirmAt) > confirmAt, 'a confirmed card POSTs to admin-system-map, the page form\'s own endpoint');
});

check('both endpoints are super-admin only and refuse writes while impersonating', () => {
    const page = read('netlify/functions/admin-system-map.ts');
    assert.ok(page.includes("'view_system_status'") && page.includes('impersonating'));
    const chat = read('netlify/functions/admin-systems-chat.ts');
    assert.ok(chat.includes("'view_system_status'") && chat.includes("scope === 'impersonate'"));
});

check('the Systems view loads the map component', () => {
    const html = read('admin.html');
    assert.ok(html.includes('<script src="/src/components/admin-system-map.js"></script>'));
    const fn = html.slice(html.indexOf('function loadSystemStatus()'), html.indexOf('function loadSandboxPanel()'));
    assert.ok(fn.includes('AdminSystemMap.load(panel)'));
});

check('the component escapes what it prints', () => {
    const js = read('src/components/admin-system-map.js');
    for (const field of ['s.name', 's.purpose', 'm.model', 'b.label', 'b.note', 't.content', 'k.title', 'k.summary']) {
        assert.ok(js.includes(`esc(${field}`), `${field} must go through esc()`);
    }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
