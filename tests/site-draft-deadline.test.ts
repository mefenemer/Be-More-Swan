// tests/site-draft-deadline.test.ts — "The draft couldn't be completed this time" (staging, 2026-11-05):
// the whole-site draft died twice with "Request timed out." after ~75 s. The gateway gave a caller's
// deadline to THINKING models only; any other model (or no role model chosen) kept the client's 24 s,
// and the SDK's 3 tries of 24 s ended long before ~8k tokens of site could be written.
//
// Run:  npx tsx tests/site-draft-deadline.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const gw = read('src/lib/ai-gateway.ts');
const store = read('src/utils/site-store.ts');
const imp = read('src/utils/site-import-store.ts');
let passed = 0;
const check = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; } };

check('the gateway gives a caller\'s deadline to every model, not only thinking ones', () => {
    const call = gw.slice(gw.indexOf('async function callModel('), gw.indexOf('function isRequestRefusal('));
    assert.ok(call.includes('const deadline = req.deadlineMs ? { timeout: req.deadlineMs } : undefined;'));
    // PRIMARY/FALLBACK are adapted too since 2026-11-12 (5.5 models); a model that doesn't think still gets the caller's deadline.
    assert.ok(call.includes("thinks ? { timeout: req.deadlineMs ?? 120_000 } : deadline"), 'primary / fallback');
    assert.ok(!call.includes('if (model !== req.model) return client.messages.create(params, deadline);'), 'no unadapted path left for a 5.5 default');
    assert.ok(call.includes('thinks ? { timeout: req.deadlineMs ?? 120_000 } : deadline);'), 'a non-thinking role model');
});

check('the whole-site draft and the import pass a long deadline, AFTER the role model (which must not override it)', () => {
    for (const [name, src] of [['draft', store], ['import', imp]] as const) {
        const at = src.indexOf("...(await gatewayRoleModel(db, 'website_assistant')),\n");
        assert.ok(at > -1, name);
        assert.ok(src.slice(at, at + 400).includes('deadlineMs: SITE_WRITE_DEADLINE_MS,'), `${name}: deadline after the spread`);
    }
});

check('three tries at the deadline fit inside the draft claim, so a slow draft is never shown as stopped', () => {
    const deadline = Number((/export const SITE_WRITE_DEADLINE_MS = ([\d_]+);/.exec(store) || [])[1]?.replace(/_/g, ''));
    const claim = (/export const DRAFT_TIMEOUT_MS = (\d+) \* (\d+) \* (\d+);/.exec(store) || []).slice(1).map(Number).reduce((a, b) => a * b, 1);
    assert.ok(deadline >= 120_000, 'long enough to write ~8k tokens');
    assert.ok(3 * deadline < claim, `3 × ${deadline} must be under ${claim}`);
});

check('an unusable reply is logged with why (cut off, or not JSON) before the owner is told', () => {
    assert.ok(store.includes("console.error('[site-store] draft reply unusable', { siteId, model: res.model, stopReason: res.stopReason"));
});

console.log(`\n${passed}/4 passed`);
