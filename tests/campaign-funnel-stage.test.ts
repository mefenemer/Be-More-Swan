// tests/campaign-funnel-stage.test.ts
// §9.6 of docs/campaign-orchestrator-plan.md: funnel stage, and outcomes each campaign can count.
//
// WHY THIS EXISTS. "If I set an Awareness objective, the AI shouldn't halt the campaign because it
// didn't generate 50 trial signups." Two things were missing, and they fail together:
//   1. No campaign had a stage, so every one was implicitly a conversion campaign — drafted as
//      pitches, and exposed to the lead-quality halt whatever it was for.
//   2. Nothing counted a campaign's OWN outcome. `outcome_metric` and `target_value` were stored
//      and displayed ("aiming for 500") with no counter behind them — `replies` was counted nowhere.
// This suite pins the stage reaching all three places it matters (what may be counted, what
// drafting is told, whether the halt may fire) and pins every counter to its own campaign and org.
//
// Run:  npx tsx tests/campaign-funnel-stage.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
    CAMPAIGN_OUTCOME_METRICS, DEFAULT_FUNNEL_STAGE, FUNNEL_STAGES, STAGE_OUTCOME_METRICS,
    UNAVAILABLE_OUTCOME_METRICS, defaultExcludeCustomers, isSelectableOutcomeMetric, outcomeForStage,
    stageOutcomes, type CampaignOutcomeMetric,
} from '../src/config/campaign-vocab';
import { buildCampaignDirective } from '../src/utils/campaign-directive';
import { mayProposeHalt } from '../src/utils/campaign-proposer';
import { countCampaignOutcome } from '../src/utils/campaign-outcomes';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone.`);
    return text.slice(a, b);
}

async function main() {
    console.log('\n──── the vocabulary ────');

    await check('every stage offers only countable outcomes, and at least one', () => {
        for (const st of FUNNEL_STAGES) {
            const offered = stageOutcomes(st);
            assert.ok(offered.length > 0, `Stage "${st}" offers nothing countable — a campaign there could never be measured.`);
            for (const m of offered) {
                assert.ok(!UNAVAILABLE_OUTCOME_METRICS.includes(m), `Stage "${st}" offers "${m}", which nothing counts.`);
            }
        }
    });

    await check('every countable outcome belongs to some stage', () => {
        const reachable = new Set(FUNNEL_STAGES.flatMap((st) => STAGE_OUTCOME_METRICS[st]));
        const orphaned = CAMPAIGN_OUTCOME_METRICS.filter((m) => isSelectableOutcomeMetric(m) && !reachable.has(m));
        assert.deepStrictEqual(orphaned, [], 'A countable outcome no stage offers is a capability no user can reach.');
    });

    await check('an awareness campaign can never be measured on leads', () => {
        assert.strictEqual(outcomeForStage('awareness', 'leads'), 'engagement',
            'The metric must fall back to the stage default — an awareness campaign counting leads reads as failing for its whole flight.');
        assert.strictEqual(outcomeForStage('conversion', 'signups'), 'signups');
        assert.strictEqual(outcomeForStage('retention', 'garbage'), stageOutcomes('retention')[0]);
    });

    await check('signups are countable now; email engagement waits for §9.7', () => {
        assert.ok(isSelectableOutcomeMetric('signups'));
        assert.ok(!isSelectableOutcomeMetric('email_engagement'));
    });

    await check('pre-§9.6 campaigns are conversion campaigns, and retention includes customers', () => {
        assert.strictEqual(DEFAULT_FUNNEL_STAGE, 'conversion',
            'Every campaign before this was a lead campaign — "conversion" is their true stage, not a placeholder.');
        assert.strictEqual(defaultExcludeCustomers('retention'), false);
        for (const st of ['awareness', 'consideration', 'conversion'] as const) assert.strictEqual(defaultExcludeCustomers(st), true);
    });

    console.log('\n──── the stage reaches drafting ────');

    await check('each stage adds its own instruction to the directive', () => {
        const base = { id: 1, objective: 'Get known in Leeds', outcomeMetric: 'engagement' as CampaignOutcomeMetric, pace: 'unknown' as const };
        const awareness = buildCampaignDirective({ ...base, funnelStage: 'awareness' })!.directive;
        assert.match(awareness, /Do not ask for a sale, a call or a signup/,
            'Awareness work must be told NOT to pitch — before §9.6 an awareness flight was drafted as sales posts.');
        const retention = buildCampaignDirective({ ...base, funnelStage: 'retention' })!.directive;
        assert.match(retention, /existing customers/);
        const none = buildCampaignDirective(base)!.directive;
        assert.ok(!/Stage:/.test(none), 'No stage, no stage line — a legacy caller must not be told a stage it never set.');
    });

    await check('the blueprint passes the campaign\'s stage into the directive', () => {
        const bp = code(read('src/utils/blueprint.ts'));
        assert.match(bp, /funnelStage: campaigns\.funnelStage/);
        assert.match(bp, /funnelStage: isFunnelStage\(liveCampaign\.funnelStage\)/);
    });

    console.log('\n──── the halt only fires where it means something ────');

    await check('only a conversion campaign can be halted for lead quality', () => {
        assert.strictEqual(mayProposeHalt('conversion'), true);
        assert.strictEqual(mayProposeHalt(null), true, 'A campaign with no stage predates §9.6 and was a lead campaign.');
        for (const st of ['awareness', 'consideration', 'retention']) {
            assert.strictEqual(mayProposeHalt(st), false, `A ${st} campaign must never be halted for not converting.`);
        }
    });

    await check('the daily agent asks before proposing a halt, and reads the stage', () => {
        const agent = code(read('netlify/functions/autonomous-campaign-agent.ts'));
        assert.match(agent, /mayProposeHalt\(campaign\.funnelStage\)/);
        const proposer = code(read('src/utils/campaign-proposer.ts'));
        const fn = span(proposer, 'export async function liveCampaignsForRun', '\n}', 'liveCampaignsForRun');
        assert.match(fn, /funnelStage: campaigns\.funnelStage/, 'Without the stage in the select, every campaign reads as conversion.');
    });

    console.log('\n──── each campaign counts its OWN outcome ────');

    const dialect = new PgDialect();
    for (const metric of CAMPAIGN_OUTCOME_METRICS) {
        await check(`"${metric}" ${isSelectableOutcomeMetric(metric) ? 'is counted, scoped to its campaign and org' : 'returns null, never 0'}`, async () => {
            const seen: string[] = [];
            const fakeDb = {
                execute: async (q: unknown) => {
                    const { sql, params } = dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]);
                    seen.push(sql); seen.push(JSON.stringify(params));
                    return [{ n: 7 }];
                },
            };
            const n = await countCampaignOutcome(fakeDb as never, { id: 4242, organisationId: 9191 }, metric);
            if (!isSelectableOutcomeMetric(metric)) {
                assert.strictEqual(n, null, 'An uncountable metric must read "cannot be counted", not "0 of 500".');
                assert.strictEqual(seen.length, 0);
                return;
            }
            assert.strictEqual(n, 7);
            const [sql, params] = seen;
            assert.match(sql, /organisation_id/, 'Every counter must scope by organisation — the campaign id is caller-supplied.');
            assert.ok(params.includes('4242') && params.includes('9191'), 'The campaign and org must be bound parameters.');
        });
    }

    await check('a failed count is unknown, not zero', async () => {
        const fakeDb = { execute: async () => { throw new Error('connection lost'); } };
        const n = await countCampaignOutcome(fakeDb as never, { id: 1, organisationId: 1 }, 'leads');
        assert.strictEqual(n, null);
    });

    await check('clicks exclude automated visits; leads de-duplicate a search used twice', async () => {
        const src = code(read('src/utils/campaign-outcomes.ts'));
        assert.match(src, /NOT e\.is_probable_bot/);
        assert.match(src, /count\(DISTINCT l\.id\)/);
    });

    console.log('\n──── the boundary, the migration, and both surfaces ────');

    await check('the migration adds the stage with an inline constraint and no DROP', () => {
        const sql = read('db/z-campaign-funnel-stage.sql');
        assert.match(sql, /ADD COLUMN IF NOT EXISTS funnel_stage TEXT NOT NULL DEFAULT 'conversion'/);
        assert.match(sql, /CONSTRAINT campaigns_funnel_stage_check/);
        assert.ok(!/DROP CONSTRAINT/i.test(sql.replace(/--[^\n]*/g, '')),
            'A DROP-then-ADD is the shape that once died half-way through a production migration.');
        assert.match(read('db/schema.ts'), /funnelStage: text\("funnel_stage"\)\.notNull\(\)\.default\("conversion"\)/);
    });

    await check('create and edit hold the outcome to the stage', () => {
        const api = code(read('netlify/functions/campaigns.ts'));
        const create = span(api, "action === 'create'", "action === 'edit'", 'create');
        assert.match(create, /outcomeForStage\(funnelStage, body\.outcomeMetric\)/);
        assert.match(create, /defaultExcludeCustomers\(funnelStage\)/);
        const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
        assert.match(edit, /outcomeForStage\(nextStage, wantedMetric\)/,
            'Changing stage must not leave an awareness campaign counting leads.');
        assert.match(edit, /patch\.funnelStage !== undefined/, 'A stage change must recompile — it changes the directive.');
        const list = span(api, "action === 'list'", "action === 'create'", 'list');
        assert.match(list, /countCampaignOutcome\(/);
    });

    await check('the chat is told the stages from the vocabulary, not a hand copy', () => {
        const orch = code(read('netlify/functions/chat-orchestrator.ts'));
        assert.match(orch, /FUNNEL_STAGES\.map\(/);
        assert.match(orch, /stageOutcomes\(st\)/);
        assert.match(orch, /"funnelStage": "awareness" \| "consideration" \| "conversion" \| "retention"/);
    });

    await check('the proposal card shows the outcome the server will actually save', () => {
        const card = code(read('src/components/disruptive-ui-registry.js'));
        const fn = span(card, 'function renderCampaignStrategyProposalCard', '\n  register(', 'the proposal card');
        assert.match(fn, /C\.stageOutcomes\(stage\)/);
        assert.match(fn, /funnelStage: stage/);
        assert.ok(fn.indexOf('const outcomeMetric =') < fn.indexOf('const outcomeLabel ='),
            'outcomeLabel reads outcomeMetric — declaring it first throws at render time.');
    });

    await check('the Campaigns tab picks a stage, filters outcomes by it, and shows progress', () => {
        const tab = code(read('src/components/assistant-campaigns.js'));
        assert.match(tab, /data-cmpf="funnelStage"/);
        assert.match(tab, /C\(\)\.stageOutcomes\(f\.stage\)/);
        assert.match(tab, /data-keep="f-outcome-\$\{esc\(f\.stage\)\}"/,
            'The outcome keep-key must carry the stage, or a value from one stage is restored into another\'s list.');
        assert.match(tab, /cannot be counted yet/);
        assert.match(tab, /function progressBar/);
    });
}

main().then(() => console.log(`\n${passed} checks passed.`));
