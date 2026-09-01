// tests/campaign-approve-launch.test.ts
// `approve_launch` — the only action in this product that can start spending a customer's money.
//
// Everything else in the paid rails either costs nothing or can only reduce spend. This one call
// flips a LinkedIn campaign from PAUSED to ACTIVE, and from that moment a third party is charging
// the customer on a schedule we do not control.
//
// So this file is almost entirely about ordering and refusal: what must be checked before the
// network call, what must be written before it, and what must be undone if it fails. None of that
// is expressible in a type, and all of it is the kind of thing a later refactor quietly reorders.
//
// Source scans, because this is an HTTP handler whose behaviour IS its sequence.
// Run:  npx tsx tests/campaign-approve-launch.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const api = read('netlify/functions/campaigns.ts');
const act = api.slice(landmark(api, "if (action === 'approve_launch')"), landmark(api, "if (action === 'list_decisions')"));

const ACTIVATE = 'await adapter.activateCampaign(';

console.log('\n──── a human, with the number in front of them ────');

check('the caller must echo back the budget it is approving', () => {
    // ⚠️ Between staging and approval the budget can be edited — in another tab, or by a colleague.
    // Approving a number you were never shown is consent that is worthless afterwards.
    assert.match(act, /const confirmed = Number\(body\.confirmDailyBudgetGbp\)/);
    assert.ok(landmark(act, 'body.confirmDailyBudgetGbp') < landmark(act, ACTIVATE));
});

check('a mismatched figure REFUSES and reports both numbers', () => {
    // A bare "mismatch" leaves the user unable to tell which figure is real.
    assert.match(act, /Math\.abs\(confirmed - dailyBudget\) > 0\.001/);
    assert.match(act, /return json\(409, \{/);
    assert.match(act, /daily budget is £\$\{dailyBudget\.toFixed\(2\)\}/);
});

check('a zero or missing budget cannot be approved', () => {
    assert.match(act, /if \(!\(dailyBudget > 0\)\)/);
});

check('the approving user is recorded on every variant', () => {
    // The ad_variants CHECK requires approved_by on anything live — this is the application half
    // of that, and the permanent answer to "who authorised this spend".
    assert.match(act, /approvedBy: userId, approvedAt/);
});

console.log('\n──── control is re-checked, never assumed ────');

check('LinkedIn is asked about control BEFORE activation', () => {
    // ⚠️ `control_state` in our database is a cached opinion. The failure being guarded against —
    // a dead token — is invisible until the moment we need to STOP the campaign.
    assert.ok(
        landmark(act, 'await adapter.checkControl(') < landmark(act, ACTIVATE),
        'the campaign is activated before control is verified',
    );
});

check('a campaign we cannot stop is never started', () => {
    const branch = act.slice(landmark(act, 'if (!control.ok)'), landmark(act, 'const approvedAt'));
    assert.match(branch, /controlState: 'lost'/);
    assert.match(branch, /return json\(400/);
    assert.match(branch, /we would not be able to stop it/);
});

console.log('\n──── the ordering that keeps a live campaign visible ────');

check('the LOCAL write happens BEFORE the network call', () => {
    // ⚠️ The OPPOSITE of stage_paid, deliberately. At staging the network call creates something
    // PAUSED, so network-first is safe. Here the network call STARTS the spend: if it succeeded
    // and our write then failed, we would have a live, charging campaign our records show as
    // paused — the optimiser reads our records, so nothing would ever check on it and the kill
    // switch would never fire.
    assert.ok(
        landmark(act, "status: 'active', approvedBy: userId") < landmark(act, ACTIVATE),
        'the network activation now runs before the local record — a live campaign could go untracked',
    );
});

check('stage_paid still uses the opposite order, and that is correct', () => {
    // Both orders are right, for opposite reasons. A future reader "making them consistent" would
    // break one of them.
    const stage = api.slice(landmark(api, "if (action === 'stage_paid')"), landmark(api, "if (action === 'approve_launch')"));
    assert.ok(landmark(stage, 'await adapter.stageCampaign(') < landmark(stage, 'db.update(campaigns).set({'));
});

check('a refused activation rolls the local state all the way back', () => {
    const rollback = act.slice(landmark(act, 'rolling back'), landmark(act, 'return json(502'));
    assert.match(rollback, /status: 'staged', approvedBy: null, approvedAt: null/,
        'the rollback leaves an approval stamp on ads that were never live');
    assert.match(rollback, /status: campaign\.status/);
});

check('the rollback message says nothing was spent', () => {
    assert.match(act, /Nothing has been launched and nothing has been spent/);
});

console.log('\n──── the watchdog does not eat the launch ────');

check('optimiserLastRunAt is stamped at approval', () => {
    // ⚠️ THE BUG THIS PREVENTS: assessHeartbeat() treats a null last-run as STALE and halts the
    // campaign. Without this stamp every paid campaign would be halted by its own watchdog within
    // a day of launching, before the optimiser had ever run once.
    assert.match(act, /optimiserLastRunAt: approvedAt/);
});

check('the heartbeat really does treat null as stale, so the stamp is load-bearing', () => {
    // Guards the reasoning above: if this stops being true, the stamp looks like dead code and
    // somebody will remove it.
    const opt = read('src/utils/campaign-optimiser.ts');
    const fn = opt.slice(landmark(opt, 'export function assessHeartbeat'));
    assert.match(fn, /if \(!lastRunAt\) \{\s*\n\s*return \{\s*\n\s*stale: true/);
});

console.log('\n──── the guards in front of the money ────');

check('every precondition runs before activation', () => {
    const at = landmark(act, ACTIVATE);
    for (const guard of [
        'await requireCampaign(Number(body.campaignId))',
        'hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)',
        "campaign.mode !== 'paid'",
        'LIVE_CAMPAIGN_STATUSES.includes(campaign.status as never)',
        'assessAdsReadiness(',
        'body.confirmDailyBudgetGbp',
        'await adapter.checkControl(',
    ]) {
        assert.ok(landmark(act, guard) < at, `${guard} runs after the campaign is already spending`);
    }
});

check('a campaign that was never staged cannot be launched', () => {
    assert.match(act, /campaign\.mode !== 'paid' \|\| !campaign\.externalCampaignId/);
    assert.match(act, /if \(staged\.length === 0\)/);
});

check('an already-running campaign is refused, not re-activated', () => {
    assert.match(act, /This campaign is already running/);
});

console.log('\n──── it leaves a record, and a way out ────');

check('the launch is written to the audit log with who and how much', () => {
    const audit = act.slice(landmark(act, 'db.insert(auditLogs)'), landmark(act, 'return json(200'));
    assert.match(audit, /campaign_paid_launched/);
    assert.match(audit, /approvedByUserId: userId/);
    assert.match(audit, /dailyBudgetGbp: dailyBudget/);
});

check('the audit row is written only AFTER activation actually succeeded', () => {
    // An audit log claiming a launch that was rolled back is worse than no log.
    assert.ok(landmark(act, 'db.insert(auditLogs)') > landmark(act, ACTIVATE));
});

check('the confirmation states the daily figure and how to stop it', () => {
    // A launch confirmation with no route back is the pattern connection-pause-needs-a-resume is
    // named after.
    assert.match(act, /Live on LinkedIn, spending up to £\$\{dailyBudget\.toFixed\(2\)\} a day/);
    assert.match(act, /You can pause it from this page at any time/);
});

console.log('\n──── nothing else in the product can start a spend ────');

check('activateCampaign is called from exactly one place', () => {
    // The whole human-in-the-loop story reduces to this. If a second caller appears — a cron, a
    // chat handler, an optimiser — the invariant is gone.
    const callers: string[] = [];
    for (const f of [
        'netlify/functions/campaigns.ts',
        'netlify/functions/autonomous-campaign-agent.ts',
        'netlify/functions/reconcile-campaigns.ts',
        'src/utils/campaign-optimiser.ts',
        'src/utils/campaign-proposer.ts',
        'src/utils/campaign-reconciler.ts',
        'src/utils/campaign-orders.ts',
    ]) {
        const hits = (code(read(f)).match(/\.activateCampaign\(/g) || []).length;
        if (hits) callers.push(`${f} (${hits})`);
    }
    assert.deepEqual(callers, ['netlify/functions/campaigns.ts (1)'],
        `activateCampaign now has other callers: ${callers.join(', ')}`);
});

check('the optimiser still cannot start anything', () => {
    const opt = code(read('src/utils/campaign-optimiser.ts'));
    assert.ok(!opt.includes('activateCampaign'));
    assert.ok(!/from '\.\/ad-networks/.test(opt), 'the optimiser can now reach an adapter directly');
});

console.log(`\n${passed} checks passed.\n`);
