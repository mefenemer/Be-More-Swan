// tests/campaign-steering-recompiles.test.ts
// A campaign steers drafting ONLY through blueprint section 13-campaign, and generation reads the
// PERSISTED blueprint. So every event that changes what section 13 should say must recompile the
// assistants the campaign has ordered work from — otherwise the steering is always one event late.
//
// Found 2026-09-30 reviewing Be More Swan's first PROD campaign (assistant Finn):
//   · placing an order never recompiled its target, so the order's own jobs were stamped with the
//     blueprint compiled BEFORE the order existed — the posts a campaign ordered carried no campaign,
//     and an adjust_messaging order changed nothing;
//   · pausing, stopping, finishing or editing a campaign recompiled nothing either, so once baked in
//     the directive kept steering drafts after the campaign had ended.
//
// Run:  npx tsx tests/campaign-steering-recompiles.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const orders = read('src/utils/campaign-orders.ts');
const api = read('netlify/functions/campaigns.ts');
const reconciler = read('src/utils/campaign-reconciler.ts');
const between = (src: string, a: string, b: string) => {
    const i = src.indexOf(a); assert.notStrictEqual(i, -1, `marker gone: ${a}`);
    const j = src.indexOf(b, i); assert.notStrictEqual(j, -1, `marker gone: ${b}`);
    return src.slice(i, j);
};

check('issuing an order recompiles its target BEFORE any job is stamped', () => {
    const issue = between(orders, 'export async function issueOrder(', 'interface ExecutorResult');
    const recompile = issue.indexOf('recompileAssistantForCampaign(ctx.targetAssistantId');
    const run = issue.indexOf('await executor(db, ctx, orderId)');
    assert.ok(recompile !== -1 && run !== -1 && recompile < run,
        'the jobs would carry the pre-order blueprint, which has no 13-campaign section');
});

check('the recompile never throws into the order path', () => {
    const helper = between(orders, 'async function recompileAssistantForCampaign(', 'export async function recompileCampaignTargets');
    assert.match(helper, /try \{[\s\S]*assembleBlueprint\([\s\S]*\} catch/);
    const targets = between(orders, 'export async function recompileCampaignTargets(', 'interface ExecutorResult');
    assert.match(targets, /Promise\.allSettled/);
    assert.match(targets, /selectDistinct\(\{ id: campaignOrders\.targetAssistantId \}\)/);
});

check('every campaign state change refreshes the assistants it steers', () => {
    const block = (action: string) => between(api, `if (action === '${action}')`, '\n    // ──');
    assert.match(block('start'), /recompileCampaignTargets\(db, campaign\.id, 'campaign-started'\)/);
    assert.match(block('pause'), /recompileCampaignTargets\(db, campaign\.id, 'campaign-paused'\)/);
    assert.match(block('stop_all'), /recompileCampaignTargets\(db, c\.id, 'campaign-stopped'\)/);
    assert.match(block('edit'), /recompileCampaignTargets\(db, campaign\.id, 'campaign-edited'\)/);
});

check('a campaign swept to finished stops steering too', () => {
    const sweep = between(reconciler, 'async function sweepExpiredCampaigns(', 'result.finished++');
    assert.ok(sweep.indexOf("status: 'finished'") < sweep.indexOf("recompileCampaignTargets(db, campaign.id, 'campaign-finished')"));
});

console.log(`\n${passed} checks passed`);
