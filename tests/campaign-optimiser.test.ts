// tests/campaign-optimiser.test.ts
// Phase C — the paid rails. The kill switch, the budget guarantee, the watchdog, and the lock that
// keeps all of it unreachable until an ad network approves us.
//
// Two halves, the split this suite family uses throughout.
//
//   1. THE DECISIONS ARE PURE, so they are unit-tested directly. `optimise()` decides whether to
//      stop a customer's advertising. Both directions are expensive and neither is visible in
//      types: too eager and it kills the best ad in a new campaign within an hour of launch; too
//      timid and it watches money drain. The sample floors are the load-bearing part and most of
//      the checks below are about them.
//
//   2. THE LOCK CANNOT BE EXPRESSED IN TYPES, so it is source-scanned and behaviourally tested.
//      "This cannot spend money yet" is the claim the whole phase rests on, and it is exactly the
//      sort of claim a later refactor breaks while every other test stays green.
//
// No database. The mock adapter is exercised for real — it is the only way to test the staging and
// approval flow before any network grants us access.
// Run:  npx tsx tests/campaign-optimiser.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    CTR_FATIGUE_DROP, MIN_CLICKS_FOR_FATIGUE, MIN_DAYS_FOR_FATIGUE, MIN_IMPRESSIONS_FOR_FATIGUE,
    OPTIMISER_STALE_HOURS, PAID_ADS_FEATURE,
} from '../src/config/ad-networks';
import {
    assessHeartbeat, costPerOutcome, ctr, hasEnoughEvidence, optimise,
    type DailyMetric, type VariantWindow,
} from '../src/utils/campaign-optimiser';
import { anyNetworkAvailable, networkAvailability, resolveAdapter } from '../src/utils/ad-networks/registry';
import { mockAdapter, _resetMock, _seedMetrics, _breakControl, _inspect } from '../src/utils/ad-networks/mock';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Source with comments removed.
 *
 * ⚠️ Necessary, not tidiness. Three checks in this file first "failed" against files that were
 * perfectly correct, because the thing they forbid is NAMED in the comment explaining why it is
 * forbidden — `setBudget` appears in "there is no setBudget", `campaigns_status_check` in "we
 * deliberately do not widen campaigns_status_check". A scan that reads prose as code reports the
 * documentation as the violation, and the fix looks like deleting the explanation.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');

/** A day with a given CTR, at a scale that clears the sample floors when repeated. */
const day = (d: string, impressions: number, ctrValue: number, over: Partial<DailyMetric> = {}): DailyMetric => ({
    day: d, impressions, clicks: Math.round(impressions * ctrValue), spendGbp: 0, conversions: 0, ...over,
});

/** A healthy baseline: 5 days, well past every floor, steady 1% CTR. */
const healthyBaseline = () => [
    day('2026-08-25', 1000, 0.01), day('2026-08-26', 1000, 0.01), day('2026-08-27', 1000, 0.01),
    day('2026-08-28', 1000, 0.01), day('2026-08-29', 1000, 0.01),
];

const variant = (over: Partial<VariantWindow> = {}): VariantWindow => ({
    variantId: 1, externalVariantId: 'mock_v_1', status: 'active', days: healthyBaseline(), ...over,
});

const input = (variants: VariantWindow[], over: Partial<Parameters<typeof optimise>[0]> = {}) => ({
    variants, maxCostPerOutcomeGbp: null, maxActionsPerDay: 3, actionsTakenToday: 0, ...over,
});

console.log('\n──── the sample floors ARE the rule ────');

check('a brand-new variant is never paused, however bad today looks', () => {
    // ⚠️ The failure this whole design is arranged around. Day one is when the sample is smallest
    // AND when the user is watching hardest, so a threshold without floors produces an assistant
    // that kills the best ad in a new campaign within the hour.
    const v = variant({ days: [day('2026-08-29', 400, 0.01), day('2026-08-30', 400, 0.0)] });
    const r = optimise(input([v]));
    assert.equal(r.pauses.length, 0, 'a two-day-old variant with a zero-CTR day was paused');
    assert.match(r.held[0].reason, /Not enough history/);
});

check('the held reason NAMES what is missing, so "why is this still running" has an answer', () => {
    const r = optimise(input([variant({ days: [day('2026-08-30', 100, 0.01)] })]));
    assert.match(r.held[0].reason, new RegExp(String(MIN_DAYS_FOR_FATIGUE)));
    assert.match(r.held[0].reason, /2,000 impressions/);
    assert.match(r.held[0].reason, new RegExp(`${MIN_CLICKS_FOR_FATIGUE} clicks`));
});

check('enough days but too few impressions is still not enough', () => {
    // Three days of 100 impressions is three days of noise, not a trend.
    const thin = [day('2026-08-27', 100, 0.01), day('2026-08-28', 100, 0.01), day('2026-08-29', 100, 0.01), day('2026-08-30', 100, 0)];
    assert.equal(optimise(input([variant({ days: thin })])).pauses.length, 0);
});

check('enough impressions but too few clicks is still not enough', () => {
    // 3,000 impressions at a 0.1% CTR is 3 clicks. One person's behaviour moves that by a third.
    const lowCtr = [day('2026-08-27', 1000, 0.001), day('2026-08-28', 1000, 0.001), day('2026-08-29', 1000, 0.001), day('2026-08-30', 1000, 0)];
    const base = lowCtr.slice(0, 3);
    assert.ok(!hasEnoughEvidence(base), 'the click floor is not being applied');
    assert.equal(optimise(input([variant({ days: lowCtr })])).pauses.length, 0);
});

check('evidence is measured on the BASELINE, not on today', () => {
    // A variant with 50,000 impressions today and nothing before it has no average to have fallen
    // below. Counting today would let one enormous day authorise a judgement about a trend.
    assert.ok(!hasEnoughEvidence([day('2026-08-30', 50000, 0.01)]));
});

console.log('\n──── fatigue, once the evidence is there ────');

check('a genuine collapse against a real average is paused', () => {
    const days = [...healthyBaseline(), day('2026-08-30', 1000, 0.004)]; // 1% → 0.4%, a 60% drop
    const r = optimise(input([variant({ days })]));
    assert.equal(r.pauses.length, 1);
    assert.equal(r.pauses[0].reason, 'creative_fatigue');
});

check('a drop that does not clear the threshold is left alone', () => {
    // 1% → 0.7% is a 30% drop, inside the 40% threshold. Pausing here would be the assistant
    // reacting to ordinary variance.
    const days = [...healthyBaseline(), day('2026-08-30', 1000, 0.007)];
    const r = optimise(input([variant({ days })]));
    assert.equal(r.pauses.length, 0);
    assert.match(r.held[0].reason, /Performing normally/);
});

check('the boundary sits exactly where the constant says', () => {
    const base = 0.01;
    const justUnder = base * (1 - CTR_FATIGUE_DROP) - 0.0001;
    const justOver = base * (1 - CTR_FATIGUE_DROP) + 0.0001;
    assert.equal(optimise(input([variant({ days: [...healthyBaseline(), day('2026-08-30', 10000, justUnder)] })])).pauses.length, 1);
    assert.equal(optimise(input([variant({ days: [...healthyBaseline(), day('2026-08-30', 10000, justOver)] })])).pauses.length, 0);
});

check('the explanation carries the numbers it was based on', () => {
    // "Paused Variant B" with no figures is an assertion. The user has to be able to disagree.
    const days = [...healthyBaseline(), day('2026-08-30', 1000, 0.002)];
    const e = optimise(input([variant({ days })])).pauses[0].explanation;
    assert.match(e, /0\.20%/);
    assert.match(e, /1\.00%/);
    assert.match(e, /40%/);
});

check('no impressions today means nothing to compare, not a collapse to zero', () => {
    // A day the network served nothing is not a day the ad failed. Treating 0/0 as a 100% drop
    // would pause every variant the moment a budget ran out early.
    const days = [...healthyBaseline(), day('2026-08-30', 0, 0)];
    const r = optimise(input([variant({ days })]));
    assert.equal(r.pauses.length, 0);
    assert.match(r.held[0].reason, /nothing to compare/);
});

console.log('\n──── a ceiling the user set beats a trend we inferred ────');

check('cost per outcome above the user\'s ceiling pauses, and says so', () => {
    const days = healthyBaseline().map((d) => ({ ...d, spendGbp: 40, conversions: 1 }));
    const r = optimise(input([variant({ days })], { maxCostPerOutcomeGbp: 25 }));
    assert.equal(r.pauses.length, 1);
    assert.equal(r.pauses[0].reason, 'cost_per_outcome');
    assert.match(r.pauses[0].explanation, /£40\.00/);
    assert.match(r.pauses[0].explanation, /£25\.00/);
});

check('with no ceiling set, cost alone never pauses anything', () => {
    // ⚠️ The agent must not invent what a lead is worth. That is a commercial judgement it has no
    // standing to make, and a default here would be exactly that.
    const days = healthyBaseline().map((d) => ({ ...d, spendGbp: 500, conversions: 1 }));
    const r = optimise(input([variant({ days })], { maxCostPerOutcomeGbp: null }));
    assert.equal(r.pauses.length, 0);
});

check('spend with no conversions is an UNDEFINED cost, not an infinite one', () => {
    // £300 and no conversions might be day one of a working campaign. Dividing by zero and
    // pausing would kill every ad before its first conversion lands.
    const rows = healthyBaseline().map((d) => ({ ...d, spendGbp: 60, conversions: 0 }));
    assert.strictEqual(costPerOutcome(rows), null);
    assert.equal(optimise(input([variant({ days: rows })], { maxCostPerOutcomeGbp: 10 })).pauses.length, 0);
});

check('the cost ceiling is checked BEFORE the fatigue trend', () => {
    // A variant breaching both should report the reason the user chose, not the one we inferred.
    const days = [...healthyBaseline(), day('2026-08-30', 1000, 0.001)].map((d) => ({ ...d, spendGbp: 90, conversions: 1 }));
    const r = optimise(input([variant({ days })], { maxCostPerOutcomeGbp: 20 }));
    assert.equal(r.pauses[0].reason, 'cost_per_outcome');
});

console.log('\n──── the total never rises ────');

check('the adapter interface cannot express raising a budget', () => {
    // ⚠️ AC 4.3, enforced structurally rather than by discipline. If no method can set a budget,
    // no amount of code above can raise one by accident.
    const types = code(read('src/utils/ad-networks/types.ts'));
    const iface = types.slice(landmark(types, 'export interface AdNetworkAdapter'));
    for (const forbidden of ['setBudget', 'updateBudget', 'increaseBudget', 'raiseBudget']) {
        assert.ok(!iface.includes(forbidden), `AdNetworkAdapter grew a ${forbidden} method`);
    }
    assert.ok(!/dailyBudgetGbp/.test(iface), 'a budget field reached the adapter method surface');
    // The methods it DOES have, pinned — so a new one is a deliberate act, not a drift.
    const methods = [...iface.matchAll(/^\s{4}(\w+)\(/gm)].map((m) => m[1]).sort();
    assert.deepEqual(methods, [
        'activateCampaign', 'checkControl', 'fetchMetrics', 'pauseCampaign', 'pauseVariant', 'stageCampaign',
    ]);
});

check('the optimiser never starts or resumes anything', () => {
    // A daily job that could START a spend would mean a model's judgement plus a cron tick was
    // enough to begin costing money.
    const src = code(read('src/utils/campaign-optimiser.ts'));
    for (const forbidden of ['activateCampaign', 'unpause', 'pauseCampaign']) {
        assert.ok(!src.includes(forbidden), `the optimiser references ${forbidden}`);
    }
    // Purity is the real guarantee: it cannot call a network because it never imports one.
    assert.ok(!/from '\.\/ad-networks/.test(src), 'the optimiser now imports an adapter and could act directly');
    // Its only output shape is pauses + holds. A `resumes` or `activations` field would be the tell.
    assert.match(src, /export interface OptimiserResult \{\s*\n\s*pauses:/);
    assert.ok(!/\n\s{4}(resumes|activations|budgetChanges)\??:/.test(src),
        'the optimiser result grew a field that implies starting something');
});

check('the daily action cap is honoured, and a re-run cannot exceed it', () => {
    // Optimisation is divergent; a loop that acts on every tick burns the whole campaign on churn.
    const collapsed = [...healthyBaseline(), day('2026-08-30', 1000, 0.001)];
    const vs = [1, 2, 3, 4].map((i) => variant({ variantId: i, externalVariantId: `v${i}`, days: collapsed }));
    assert.equal(optimise(input(vs, { maxActionsPerDay: 2 })).pauses.length, 2);
    // Two already taken today leaves room for one more, not two.
    assert.equal(optimise(input(vs, { maxActionsPerDay: 2, actionsTakenToday: 1 })).pauses.length, 1);
    assert.equal(optimise(input(vs, { maxActionsPerDay: 2, actionsTakenToday: 5 })).pauses.length, 0);
});

check('pausing the last variant standing is REPORTED, not done quietly', () => {
    // Sometimes right, sometimes catastrophic — it is a judgement about the customer's business,
    // so it becomes a decision for a human rather than a silent campaign stop.
    const collapsed = [...healthyBaseline(), day('2026-08-30', 1000, 0.001)];
    const r = optimise(input([variant({ days: collapsed })]));
    assert.equal(r.wouldStopCampaign, true);
    const twoLeft = optimise(input([
        variant({ variantId: 1, days: collapsed }),
        variant({ variantId: 2, externalVariantId: 'v2', days: healthyBaseline() }),
    ]));
    assert.equal(twoLeft.wouldStopCampaign, false);
});

check('a staged variant is never touched', () => {
    // It has never spent and has never been approved. Pausing it would silently reject something
    // the user has not been asked about.
    const collapsed = [...healthyBaseline(), day('2026-08-30', 1000, 0.001)];
    const r = optimise(input([variant({ status: 'staged', days: collapsed })]));
    assert.equal(r.pauses.length, 0);
    assert.equal(r.held.length, 0, 'a staged variant should not even be considered');
});

console.log('\n──── the watchdog ────');

check('a campaign whose optimiser has gone quiet halts itself', () => {
    // ⚠️ Fails CLOSED. A dead cron is invisible here — nothing happens, which looks exactly like
    // nothing being wrong, while every guardrail above silently stops being enforced.
    const now = new Date('2026-09-01T12:00:00Z');
    const stale = new Date(now.getTime() - (OPTIMISER_STALE_HOURS + 2) * 3600_000);
    const v = assessHeartbeat(stale, now);
    assert.equal(v.stale, true);
    assert.match(v.message!, /paused it/);
    assert.match(v.message!, /spending/);
});

check('a run inside the window is not stale', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    assert.equal(assessHeartbeat(new Date(now.getTime() - 3600_000), now).stale, false);
    // Exactly at the boundary is still fine — a daily job landing 26h late is late, not dead.
    assert.equal(assessHeartbeat(new Date(now.getTime() - OPTIMISER_STALE_HOURS * 3600_000), now).stale, false);
});

check('never having run is treated as stale, not as fine', () => {
    // The most likely real failure: it was never wired up. "No last run" must not read as "no
    // problem", which is what a null-means-skip would do.
    const v = assessHeartbeat(null, new Date());
    assert.equal(v.stale, true);
    assert.strictEqual(v.hoursSince, null);
    assert.match(v.message!, /not been able to check/);
});

check('the stale message says what happened to the money, in plain words', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    const m = assessHeartbeat(new Date(now.getTime() - 40 * 3600_000), now).message!;
    assert.match(m, /40 hours/);
    assert.match(m, /resume/);
    assert.ok(!/cron|heartbeat|optimiser|scheduler/i.test(m), 'the user is being told about our plumbing');
});

console.log('\n──── nothing can spend, because nothing is connected ────');

check('no real network resolves, and each refusal names its blocker', () => {
    // ⚠️ THE LOCK. A feature flag protects against a decision; an empty registry protects against
    // a mistake.
    assert.equal(anyNetworkAvailable(), false, 'a real ad network adapter has been registered');
    for (const network of ['linkedin', 'meta', 'google']) {
        const { adapter, blocker } = resolveAdapter(network);
        assert.equal(adapter, null, `${network} resolved to an adapter`);
        assert.ok(blocker && blocker.length > 30, `${network} has no real blocker sentence`);
    }
    // ⚠️ Updated 2026-09-01: Development Tier WAS granted, so the blocker is now about the
    // five-account EDIT CAP, not about access being refused. Copy still claiming we were never
    // approved would be the stale-claim failure this project keeps repeating.
    assert.ok(!/not yet been granted/i.test(resolveAdapter('linkedin').blocker!),
        'the LinkedIn blocker still says access was refused, which is no longer true');
    assert.match(resolveAdapter('linkedin').blocker!, /handful of ad accounts|limited testing/i);
});

check('the availability list is honest about every network', () => {
    const rows = networkAvailability();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => !r.available && r.blocker));
});

check('the mock needs BOTH an explicit opt-in and a non-production env', () => {
    // Either alone is a single point of failure: the env check alone would let a misconfigured
    // deploy expose it, the flag alone would let any caller opt in.
    assert.equal(resolveAdapter('mock').adapter, null, 'the mock resolved without opt-in');
    assert.ok(resolveAdapter('mock', { allowMock: true }).adapter, 'the mock is unreachable in tests');
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    assert.equal(resolveAdapter('mock', { allowMock: true }).adapter, null, 'the mock resolved in production');
    process.env.NODE_ENV = prev;
});

check('the plan feature is off by ABSENCE, so no environment starts exposed', () => {
    assert.equal(PAID_ADS_FEATURE, 'paid_ads');
    const cfg = read('src/config/ad-networks.ts');
    assert.match(cfg, /DEFAULT OFF, absence = off/);
});

console.log('\n──── the schema says what the config says ────');

check('the variant lifecycle agrees in all three places', () => {
    const ddl = read('db/campaign-paid.sql');
    const schema = read('db/schema.ts');
    for (const v of ['staged', 'active', 'paused', 'archived', 'rejected']) {
        assert.ok(ddl.includes(`'${v}'`), `${v} missing from the SQL`);
    }
    assert.ok(ddl.includes('ad_variants_status_check'));
    assert.ok(schema.includes('ad_variants_status_check'), 'the drizzle mirror lost the status check');
    assert.ok(schema.includes('ad_variants_approval_check'), 'the drizzle mirror lost the approval check');
});

check('a variant that has ever been live must name who approved it', () => {
    // The database half of the human-in-the-loop rule. Without it, "approved" is a field the
    // application merely promises to set.
    const ddl = read('db/campaign-paid.sql');
    assert.match(ddl, /ad_variants_approval_check[\s\S]{0,200}approved_by IS NOT NULL/);
});

check('the paid migration widens no existing CHECK', () => {
    // ⚠️ A DROP-then-ADD that fails part-way leaves the rest of the file silently unapplied, and
    // this codebase already carries one half-applied production migration of that shape. The only
    // DROP here is of the NEW constraint this file itself owns.
    const ddl = sqlCode(read('db/campaign-paid.sql'));
    const drops = ddl.match(/DROP CONSTRAINT IF EXISTS (\w+)/g) || [];
    assert.deepEqual(drops, ['DROP CONSTRAINT IF EXISTS campaigns_control_state_check']);
    assert.ok(!/campaigns_status_check/.test(ddl), 'the paid migration is rewriting the status CHECK');
    // Everything else must be additive: new columns and new tables only.
    const alters = ddl.match(/ALTER TABLE (\w+) (\w+)/g) || [];
    for (const a of alters) {
        assert.ok(/ADD COLUMN|DROP CONSTRAINT|ADD  CONSTRAINT|ADD CONSTRAINT/.test(ddl.slice(ddl.indexOf(a), ddl.indexOf(a) + 80)),
            `non-additive ALTER: ${a}`);
    }
});

check('control state is orthogonal to status, not another status value', () => {
    // The dangerous case is a campaign that is still ACTIVE and no longer controllable. One column
    // could only ever say one of those.
    const schema = read('db/schema.ts');
    assert.match(schema, /controlState: text\("control_state"\)\.notNull\(\)\.default\("ok"\)/);
    assert.match(schema, /campaigns_status_check[\s\S]{0,160}'draft','active','throttled','paused','finished','archived'/);
});

// ── The async half ─────────────────────────────────────────────────────────────────────────────
// Wrapped in main() rather than using top-level await: the test runner transpiles to CJS, where
// top-level await is a build error rather than a runtime one — so this fails at load with no
// output at all, which looks like the suite was never written.
async function main(): Promise<void> {
    console.log('\n──── staging can never start a spend ────');

    await checkAsync('a staged campaign and every variant come back PAUSED', async () => {
        // ⚠️ The human-in-the-loop invariant, checked behaviourally rather than by reading a comment.
        _resetMock();
        const res = await mockAdapter.stageCampaign({
            campaignId: 1, organisationId: 1, name: 'Test', dailyBudgetGbp: 50,
            variants: [
                { variantId: 10, headline: 'A', body: 'b', destinationUrl: 'https://x.example/go', targeting: {} },
                { variantId: 11, headline: 'B', body: 'b', destinationUrl: 'https://x.example/go', targeting: {} },
            ],
        });
        assert.equal(res.status, 'paused');
        const state = _inspect(res.externalCampaignId)!;
        assert.equal(state.status, 'paused');
        assert.ok(state.variants.every((v) => v.status === 'paused'), 'a variant was staged live');
    });

    await checkAsync('only activateCampaign starts anything', async () => {
        _resetMock();
        const res = await mockAdapter.stageCampaign({
            campaignId: 1, organisationId: 1, name: 'T', dailyBudgetGbp: 50,
            variants: [{ variantId: 10, headline: 'A', body: 'b', destinationUrl: 'https://x.example/go', targeting: {} }],
        });
        await mockAdapter.activateCampaign(res.externalCampaignId);
        assert.equal(_inspect(res.externalCampaignId)!.status, 'active');
    });

    await checkAsync('a lost connection refuses to activate rather than silently spending', async () => {
        _resetMock();
        const res = await mockAdapter.stageCampaign({
            campaignId: 1, organisationId: 1, name: 'T', dailyBudgetGbp: 50,
            variants: [{ variantId: 10, headline: 'A', body: 'b', destinationUrl: 'https://x.example/go', targeting: {} }],
        });
        _breakControl(res.externalCampaignId);
        const control = await mockAdapter.checkControl(res.externalCampaignId);
        assert.equal(control.ok, false);
        await assert.rejects(() => mockAdapter.activateCampaign(res.externalCampaignId), /control lost/);
        assert.equal(_inspect(res.externalCampaignId)!.status, 'paused');
    });

    await checkAsync('metrics for an unknown variant are ABSENT, not zeroes', async () => {
        // Zeroes read as "it ran and got nothing", which is a different and far more alarming fact
        // than "we have no data" — and would feed the optimiser a collapse that never happened.
        _resetMock();
        assert.deepEqual(await mockAdapter.fetchMetrics(['nope'], 7), []);
    });

    await checkAsync('seeded metrics come back windowed, newest first requested', async () => {
        _resetMock();
        const res = await mockAdapter.stageCampaign({
            campaignId: 1, organisationId: 1, name: 'T', dailyBudgetGbp: 50,
            variants: [{ variantId: 10, headline: 'A', body: 'b', destinationUrl: 'https://x.example/go', targeting: {} }],
        });
        const vid = res.externalVariantIds[10];
        _seedMetrics(vid, [
            { day: '2026-08-28', impressions: 1000, clicks: 10, spendGbp: 20, reportedConversions: 1 },
            { day: '2026-08-29', impressions: 1000, clicks: 10, spendGbp: 20, reportedConversions: 1 },
            { day: '2026-08-30', impressions: 1000, clicks: 2, spendGbp: 20, reportedConversions: 0 },
        ]);
        assert.equal((await mockAdapter.fetchMetrics([vid], 2)).length, 2);
    });

    console.log(`\n${passed} checks passed.\n`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
