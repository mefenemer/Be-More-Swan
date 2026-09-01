// tests/paid-optimiser-cron.test.ts
// The daily sweep over live paid campaigns — the file that finally CALLS the kill switch.
//
// Until this existed, `optimise()` and `assessHeartbeat()` were correct, tested, and reachable by
// nothing: a launched campaign was unwatched, and the 26-hour watchdog would have halted it a day
// later. That is the `goals-steer-generation` shape — a complete mechanism with no wire behind it —
// and these checks are mostly about the wire.
//
// The decisions themselves are unit-tested in tests/campaign-optimiser.test.ts. What is asserted
// here is sequence, scope, and the handful of places where a plausible simplification would let a
// campaign spend unwatched.
//
// Run:  npx tsx tests/paid-optimiser-cron.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { OPTIMISER_STALE_HOURS } from '../src/config/ad-networks';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const cron = read('netlify/functions/optimise-paid-campaigns.ts');
const toml = read('netlify.toml');

console.log('\n──── the kill switch is finally connected ────');

check('the optimiser and the heartbeat both have a caller now', () => {
    // The whole point of this file.
    assert.match(code(cron), /optimise\(\{/);
    assert.match(code(cron), /assessHeartbeat\(c\.optimiserLastRunAt, now\)/);
});

check('it is scheduled, and the interval matches the watchdog', () => {
    // ⚠️ OPTIMISER_STALE_HOURS is 26 — a campaign whose optimiser has not run in that long halts
    // ITSELF. A schedule longer than daily would make every live campaign stop on its own, and
    // changing one without the other is the bug.
    assert.match(toml, /\[functions\.optimise-paid-campaigns\]\s*\n\s*schedule = "40 6 \* \* \*"/);
    assert.ok(OPTIMISER_STALE_HOURS > 24, 'the staleness window no longer leaves room for a daily job');
});

check('only live PAID campaigns with a network id are swept', () => {
    const q = code(cron).slice(landmark(code(cron), 'from(campaigns)'), landmark(code(cron), '.limit(BATCH)'));
    assert.match(q, /eq\(campaigns\.mode, 'paid'\)/);
    assert.match(q, /inArray\(campaigns\.status, \['active', 'throttled'\]\)/);
    assert.match(q, /isNotNull\(campaigns\.externalCampaignId\)/);
});

console.log('\n──── the order of the safety checks ────');

check('the heartbeat runs BEFORE anything else touches the campaign', () => {
    // If we have not been able to look at a campaign, it should not keep running while we work out
    // why — including while we spend time fetching its metrics.
    const at = landmark(cron, 'const beat = assessHeartbeat');
    assert.ok(at < landmark(cron, 'const control = await adapter.checkControl'));
    assert.ok(at < landmark(cron, 'await adapter.fetchMetrics('));
    assert.ok(at < landmark(cron, 'const result = optimise({'));
});

check('control is checked before any optimisation is applied', () => {
    assert.ok(
        landmark(cron, 'const control = await adapter.checkControl') < landmark(cron, 'await adapter.pauseVariant('),
        'variants are paused before we have confirmed we can reach the account',
    );
});

check('a stale or uncontrollable campaign is HALTED, not merely flagged', () => {
    const body = code(cron);
    assert.match(body, /if \(beat\.stale\) \{[\s\S]{0,200}await haltCampaign\(/);
    assert.match(body, /if \(!control\.ok\) \{[\s\S]{0,400}await haltCampaign\(/);
});

console.log('\n──── it can stop things, and start nothing ────');

check('the cron never activates or resumes anything', () => {
    // ⚠️ A daily job that could START a spend would mean a cron tick was enough to begin costing
    // money. tests/campaign-approve-launch.test.ts asserts activateCampaign has ONE caller; this
    // is the other half of that claim.
    const body = code(cron);
    for (const forbidden of ['activateCampaign', 'stageCampaign']) {
        assert.ok(!body.includes(forbidden), `the cron references ${forbidden}`);
    }
    // ⚠️ Checked as a WRITE, not a substring. `status: 'active'` also appears as a READ filter and
    // in the VariantWindow the optimiser is fed — a naive scan flags both and reports correct code
    // as a violation, and the obvious "fix" is to break the query.
    const writes = body.match(/\.set\(\{[^}]*\}/gs) || [];
    for (const w of writes) {
        assert.ok(!/status: 'active'/.test(w), `a write sets a status to active: ${w.slice(0, 80)}`);
    }
});

check('it cannot change a budget', () => {
    // AC 4.3. The adapter has no method for it either, but a local write would still misreport.
    // Again checked as a WRITE: `maxSpendGbp` legitimately appears in select projections.
    const writes = (code(cron).match(/\.set\(\{[^}]*\}/gs) || []);
    for (const w of writes) {
        assert.ok(!/maxSpendGbp/.test(w), `a write touches the budget: ${w.slice(0, 80)}`);
    }
    // And the cost ceiling stays null until a customer-set field exists — passing the daily budget
    // would be the agent deciding what a lead is worth.
    assert.match(code(cron), /maxCostPerOutcomeGbp: null/);
});

check('a decision that would stop the whole campaign is NOT applied', () => {
    // Sometimes right, sometimes catastrophic — it is a judgement about the customer's business.
    assert.match(code(cron), /const toPause = result\.wouldStopCampaign \? \[\] : result\.pauses/);
});

console.log('\n──── the data it decides on ────');

check('metrics are UPSERTED one row per variant per day', () => {
    // Appending instead would double every denominator and halve every rate.
    assert.match(code(cron), /onConflictDoUpdate\(\{/);
    assert.match(code(cron), /target: \[adVariantMetrics\.variantId, adVariantMetrics\.day\]/);
});

check('it optimises from STORED metrics, not from the fetch it just made', () => {
    // A partial fetch must not be able to make a variant look like it collapsed.
    assert.ok(
        landmark(cron, 'from(adVariantMetrics)') < landmark(cron, 'const result = optimise({'),
        'the optimiser is being fed the raw fetch rather than the stored history',
    );
});

check('a non-GBP spend figure is skipped, never coerced to zero', () => {
    // stage_paid refuses non-GBP accounts so this should be unreachable — but storing NaN or 0
    // would poison every cost figure downstream.
    assert.match(code(cron), /if \(!Number\.isFinite\(r\.spendGbp\)\) \{/);
    const branch = cron.slice(landmark(cron, 'if (!Number.isFinite(r.spendGbp))'), landmark(cron, 'await db.insert(adVariantMetrics)'));
    assert.match(branch, /continue;/);
});

check('one campaign failing does not abandon the rest', () => {
    // Including the ones that need STOPPING — an early return here would leave later campaigns
    // unwatched because an earlier one threw.
    assert.match(code(cron), /catch \(err\) \{[\s\S]{0,200}console\.error\('\[optimise-paid\] campaign failed'/);
});

console.log('\n──── the stamp, and what depends on it ────');

check('the run is stamped only after the campaign was actually examined', () => {
    // Stamping on the halt path would tell the next run "we checked, all fine" about a campaign we
    // just stopped.
    const halted = cron.slice(landmark(cron, 'if (beat.stale) {'), landmark(cron, 'const readiness = assessAdsReadiness'));
    assert.ok(!/stamp\(/.test(halted), 'a halted campaign is being stamped as freshly checked');
    assert.match(code(cron), /await stamp\(db, c\.id, now\);\s*\n\s*examined\+\+;/);
});

check('an unavailable adapter skips WITHOUT stamping', () => {
    // Production: Development Tier is dev-only. Stamping there would mark unwatched campaigns as
    // watched — the one lie that would defeat the whole watchdog.
    const branch = cron.slice(landmark(cron, "console.warn('[optimise-paid] no adapter available"), landmark(cron, 'const control = await adapter.checkControl'));
    assert.ok(!/stamp\(/.test(branch), 'a campaign with no adapter is stamped as checked');
});

console.log('\n──── halting says what actually happened ────');

check('a halt writes locally even when the network pause fails', () => {
    // ⚠️ The control-lost case. Our records must say halted so nothing keeps optimising it, while
    // the user is told plainly that money may still be moving.
    const fn = cron.slice(landmark(cron, 'async function haltCampaign'));
    assert.match(fn, /catch \(err\) \{ console\.error\('\[optimise-paid\] could not pause on the network'/);
    assert.ok(landmark(fn, 'await db.update(campaigns).set({') > landmark(fn, 'stopped = true'));
});

check('an unconfirmed stop is reported as unconfirmed', () => {
    const fn = cron.slice(landmark(cron, 'async function haltCampaign'));
    assert.match(fn, /could not confirm it stopped on LinkedIn/);
    assert.match(fn, /controlState: 'lost'/);
});

console.log('\n──── the digest ────');

check('both notification templates exist BEFORE they are called', () => {
    // ⚠️ createNotification() with an unknown key logs and returns false — a silent no-op that
    // LOOKS wired. That is why Phase 1 shipped without a notification at all.
    const catalog = read('src/utils/notification-templates-catalog.ts');
    for (const key of ['paid_campaign_optimised', 'paid_campaign_halted']) {
        assert.ok(catalog.includes(`templateKey: '${key}'`), `${key} is missing from the catalog`);
        assert.ok(cron.includes(`'${key}'`), `${key} is never sent`);
    }
});

check('a halt gets its own template, never buried in the routine digest', () => {
    assert.ok(
        landmark(cron, "createNotification(db, 'paid_campaign_halted'") < landmark(cron, "createNotification(db, 'paid_campaign_optimised'"),
        'the halt notice is emitted after the routine one',
    );
});

check('one digest per organisation per run, not one per action', () => {
    // Three campaigns adjusting on the same morning is one alert, or this becomes the noise it
    // exists to cut through.
    assert.match(code(cron), /for \(const n of notices\.values\(\)\)/);
    assert.match(code(cron), /if \(n\.paused\.length === 0 && n\.halted\.length === 0\) continue;/);
});

check('the message names what changed and says the budget is untouched', () => {
    const catalog = read('src/utils/notification-templates-catalog.ts');
    const tpl = catalog.slice(landmark(catalog, "templateKey: 'paid_campaign_optimised'"), landmark(catalog, "templateKey: 'paid_campaign_halted'"));
    assert.match(tpl, /\{\{change\.reason\}\}/);
    assert.match(tpl, /Your daily budget is unchanged/);
});

check('it respects the global AI switch, like every other autonomous run', () => {
    assert.match(code(cron), /if \(await isGlobalAiDisabled\(\)\)/);
});

console.log('\n──── the staging poke ────');

const poke = read('netlify/functions/run-paid-optimiser.ts');
const workflow = read('.github/workflows/staging-crons.yml');

check('the poke drives the SAME sweep, not a copy of it', () => {
    // If staging ran a copy, the thing tested on staging would not be the thing running in
    // production — which is the entire point of having a staging poke.
    assert.match(code(poke), /import \{ runPaidOptimiserSweep \} from '\.\/optimise-paid-campaigns'/);
    assert.match(code(poke), /await runPaidOptimiserSweep\(\)/);
    assert.match(code(cron), /export async function runPaidOptimiserSweep/);
});

check('the poke FAILS CLOSED without its secret', () => {
    // ⚠️ It matters more here than on the other pokes: a successful sweep STAMPS
    // optimiser_last_run_at, which is exactly what silences the staleness watchdog. An open
    // endpoint on a loop would keep the alarm quiet while the real scheduler was dead.
    assert.match(code(poke), /if \(!secret\) \{/);
    assert.match(code(poke), /statusCode: 503/);
    assert.ok(
        landmark(poke, 'if (!secret)') < landmark(poke, 'await runPaidOptimiserSweep()'),
        'the sweep can run before the secret is checked',
    );
});

check('the poke is POST-only and bearer-guarded', () => {
    assert.match(code(poke), /event\.httpMethod !== 'POST'/);
    assert.match(code(poke), /token !== secret/);
});

check('the workflow calls it, and NOT at the production cadence', () => {
    // ⚠️ 12h, not 24h. GitHub delivers a fraction of requested ticks with observed gaps to 3h17m,
    // so a 24h interval plus slop lands past OPTIMISER_STALE_HOURS (26) and staging campaigns
    // would halt themselves at random — the watchdog working correctly, in the one place nobody
    // would believe it.
    const row = workflow.match(/^\s*run-paid-optimiser\s+(\d+)\s+(\d+)\s*$/m);
    assert.ok(row, 'run-paid-optimiser is not in the staging JOBS table');
    const intervalHours = Number(row![1]) / 3600;
    assert.ok(intervalHours < OPTIMISER_STALE_HOURS - 6,
        `the staging interval (${intervalHours}h) leaves too little margin under the ${OPTIMISER_STALE_HOURS}h staleness window`);
});

check('the note about that interval sits OUTSIDE the JOBS string', () => {
    // ⚠️ The reader loop skips empty lines and nothing else, so a `#` inside JOBS is read as an
    // endpoint name and curl'd as ${BASE}/# — a 404 counted as a failed endpoint every tick.
    const jobs = workflow.slice(landmark(workflow, 'JOBS="'), landmark(workflow, '"', landmark(workflow, 'JOBS="') + 6));
    assert.ok(!jobs.includes('#'), 'a comment leaked into the JOBS string');
    assert.match(workflow, /OPTIMISER_STALE_HOURS is 26/);
});

console.log(`\n${passed} checks passed.\n`);
