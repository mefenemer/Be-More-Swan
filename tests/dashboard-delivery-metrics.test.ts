// tests/dashboard-delivery-metrics.test.ts — FR#29 (owner 2026-11-14): Admin ▸ Dashboard shows the number of issues
// resolved and the number of feature requests released to live.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    console.log('dashboard-delivery-metrics');
    const path = join(root, 'src/utils/delivery-metrics.ts');
    await check('the metrics module exists', () => assert.ok(existsSync(path)));
    const m: any = existsSync(path) ? await import('../src/utils/delivery-metrics') : {};

    await check('"resolved" = closed or marked fixed WITH a fix behind it (re-routed closes have none)', () => {
        assert.strictEqual(m.ISSUES_RESOLVED_SQL, "status IN ('closed', 'fixed_ready_to_test') AND (fixed_at IS NOT NULL OR resolved_at IS NOT NULL)");
    });

    await check('both figures and their last-30-days counts come from the database, released by released_at', async () => {
        const seen: string[] = [];
        const db: any = { execute: async (q: any) => { const text = JSON.stringify(q); seen.push(text); return text.includes('feature_requests') ? [{ total: 20, recent: 7 }] : [{ total: 57, recent: 45 }]; } };
        assert.deepStrictEqual(await m.loadDeliveryMetrics(db), { issuesResolved: 57, issuesResolved30d: 45, featuresReleased: 20, featuresReleased30d: 7 });
        assert.ok(seen.some((t) => t.includes("status = 'released'") && t.includes('released_at >')));
    });

    await check('the dashboard API returns them, and a failure costs only these cards', () => {
        const api = read('netlify/functions/admin-api.ts');
        const i = api.indexOf("resource === 'dashboard'");
        const block = api.slice(i, api.indexOf("resource === 'storage-stats'", i));
        assert.ok(block.includes('loadDeliveryMetrics(db).catch(') && block.includes('delivery,'));
    });

    await check('two cards on the dashboard, each opening its board; dashes when unreadable', () => {
        const html = read('admin.html');
        const a = html.indexOf('function dashDeliveryCards(m)');
        assert.ok(a > 0, 'dashDeliveryCards exists');
        const fn = html.slice(a, html.indexOf('\nasync function loadDashboard', a));
        const c: any = {}; vm.createContext(c); vm.runInContext(`${fn}; this.f = dashDeliveryCards;`, c);
        const out = c.f({ issuesResolved: 57, issuesResolved30d: 45, featuresReleased: 20, featuresReleased30d: 7 });
        assert.ok(/Issues resolved[\s\S]*>57<[\s\S]*45 in the last 30 days/.test(out));
        assert.ok(/Features released[\s\S]*>20<[\s\S]*7 in the last 30 days/.test(out));
        assert.ok(out.includes("adminNav('issue-reports')") && out.includes("adminNav('feature-roadmap')"));
        const none = c.f(null);
        assert.ok((none.match(/>—</g) || []).length === 2 && none.includes('Could not be read'));
        assert.ok(html.includes('kpiCards + deliveryCards + tierCard + storageCard'));
    });

    console.log(`\n${passed} passed`);
})();
