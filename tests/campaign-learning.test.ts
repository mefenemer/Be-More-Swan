// tests/campaign-learning.test.ts
// §9.8 of docs/campaign-orchestrator-plan.md: A/B tests and what a campaign taught.
//
// WHY THIS EXISTS. "We want to know WHY — long-form beats short-form on LinkedIn — and save it to a
// brand memory so we don't start from zero." Three ways that goes wrong, each pinned here:
//   1. A TEST THAT TESTS NOTHING. The blueprint holds one section 13 per assistant, so both halves of
//      a test were drafted with the same angle. Each job now carries its variant, and the drafting
//      worker rebuilds section 13 for that job (which also stops a two-campaign assistant drafting
//      one campaign's posts with the other's instructions).
//   2. A WINNER DECLARED ON NOISE. Below four measured posts per angle the verdict is "not enough
//      data"; a gap under 1.25× is "no clear difference". No surface may name a winner the verdict
//      does not.
//   3. A LESSON THAT REACHES NOTHING (goals-steer-generation). Kept lessons are read by the
//      Campaign Assistant's planning every turn, and — only if asked — become a rule on each writing
//      assistant the campaign briefed: visible and deletable, never an invisible workspace rule.
//
// Run:  npx tsx tests/campaign-learning.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_POSTS_PER_VARIANT, WIN_RATIO, judgeExperiment, verdictSentence } from '../src/utils/campaign-learning';
import { directiveInputFrom, buildCampaignDirective } from '../src/utils/campaign-directive';
import { ORDER_ACTION_SPECS } from '../src/config/campaign-vocab';
import { normalisePlanOrders, planOrderProblem, planWorkItems } from '../src/utils/campaign-plan';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
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

const learning = code(read('src/utils/campaign-learning.ts'));
const orders = code(read('src/utils/campaign-orders.ts'));
const jobDirective = code(read('src/utils/campaign-job-directive.ts'));

console.log('\n──── a winner is never declared on noise ────');

const v = (measured: number, mean: number | null) => ({ posts: measured, measured, mean });

check('below the floor the verdict is "not enough data", whatever the gap', () => {
    assert.strictEqual(MIN_POSTS_PER_VARIANT, 4);
    assert.strictEqual(judgeExperiment(v(3, 900), v(8, 10)).verdict, 'not_enough_data',
        'One viral post among three decides nothing.');
    assert.strictEqual(judgeExperiment(v(4, null), v(4, 10)).verdict, 'not_enough_data');
});

check('a gap under WIN_RATIO is "no clear difference", not a winner', () => {
    assert.strictEqual(WIN_RATIO, 1.25);
    assert.strictEqual(judgeExperiment(v(6, 10), v(6, 11.5)).verdict, 'no_clear_difference');
    assert.strictEqual(judgeExperiment(v(6, 0), v(6, 0)).verdict, 'no_clear_difference', 'Zero against zero is no difference.');
});

check('a clear lead names the right angle', () => {
    const r = judgeExperiment(v(6, 20), v(5, 8));
    assert.strictEqual(r.verdict, 'a');
    assert.strictEqual((r as { ratio: number }).ratio, 2.5);
    assert.strictEqual(judgeExperiment(v(4, 0), v(4, 3)).verdict, 'b', 'Anything against zero is a clear lead.');
});

check('the sentence never names a winner the verdict does not', () => {
    const exp = { angleA: 'Customer story', angleB: 'How-to' };
    const thin = verdictSentence(exp, v(2, 50), v(5, 5), judgeExperiment(v(2, 50), v(5, 5)));
    assert.match(thin, /^Not enough data/);
    assert.ok(!/drew [0-9.]+×/.test(thin));
    const win = verdictSentence(exp, v(6, 20), v(5, 8), judgeExperiment(v(6, 20), v(5, 8)));
    assert.match(win, /"Customer story" drew 2\.5× the engagement of "How-to"/);
});

check('the chat may report a test only with that sentence', () => {
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /never name a winner it does not name/);
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /\$\{t\.sentence\}/, 'The snapshot must carry the verdict sentence, not raw numbers to reinterpret.');
});

console.log('\n──── the test really compares two angles ────');

check('the order needs a hypothesis and two DIFFERENT angles, priced per pair', () => {
    const [ok] = normalisePlanOrders([{ action: 'ab_test_posts', hypothesis: 'Story vs how-to', angleA: 'Story', angleB: 'How-to' }]);
    assert.strictEqual(planOrderProblem(ok), null);
    assert.strictEqual(ok.quantity, 4, 'Default four per angle — the floor below which no answer is possible.');
    assert.strictEqual(planWorkItems([ok]), 4 * ORDER_ACTION_SPECS.ab_test_posts.workItemsPerUnit);
    const [same] = normalisePlanOrders([{ action: 'ab_test_posts', hypothesis: 'x', angleA: 'Story', angleB: ' story ' }]);
    assert.match(planOrderProblem(same) ?? '', /DIFFERENT/);
});

check('the executor interleaves A and B and tags every job with its variant', () => {
    const exec = span(orders, 'ab_test_posts: async', '\n    },\n', 'the test executor');
    assert.match(exec, /const variant = i % 2 === 0 \? 'A' : 'B'/,
        'Interleaved, so neither angle gets the better posting days.');
    assert.match(exec, /insert\(campaignExperimentJobs\)\.values\(\{ jobId: job\.id, experimentId: exp\.id, variant \}\)/);
    assert.match(exec, /campaignOrderId: orderId/);
});

check('a test job is drafted with ITS variant\'s angle — nothing overrides it', () => {
    const fn = span(jobDirective, 'export async function campaignDirectiveForJob', '\n}\n', 'campaignDirectiveForJob');
    const tagged = fn.indexOf("angle = variant === 'A' ? tag.angleA : tag.angleB");
    const briefAngle = fn.indexOf('angle = brief.angle');
    assert.ok(tagged !== -1 && briefAngle !== -1 && tagged < briefAngle, 'The variant angle must win over the brief.');
    assert.match(fn, /row\.status !== 'active' && row\.status !== 'throttled'\) return null/,
        'A paused or finished campaign must stop steering, as the blueprint drops it.');
    assert.match(fn, /catch \(err\)/, 'A failed lookup must leave the blueprint section, never fail the draft.');
});

check('the drafting worker uses the job\'s own section 13, built by the shared builder', () => {
    const jobs = code(read('netlify/functions/process-content-jobs.ts'));
    const inject = jobs.indexOf("['13-campaign'] = { status: 'complete', content: { ...jobCampaign.directive } }");
    const render = jobs.indexOf('renderBlueprintPrompt(sections)');
    assert.ok(inject !== -1 && render !== -1 && inject < render, 'The override must land BEFORE the prompt is rendered.');
    assert.match(jobDirective, /buildCampaignDirective\(directiveInputFrom\(row, brief, angle\)\)/);
    assert.match(code(read('src/utils/blueprint.ts')), /directiveInputFrom\(liveCampaign,/,
        'One builder for both — the assistant-wide section and a job\'s own can never disagree.');
});

check('the shared builder lets an override angle win', () => {
    const row = { id: 1, objective: 'Launch', outcomeMetric: 'engagement', endsAt: null, constraints: null, audience: null, funnelStage: 'awareness', tone: null };
    const d = buildCampaignDirective(directiveInputFrom(row, { angle: 'brief angle' }, 'variant angle'))!;
    assert.strictEqual(d.angle, 'variant angle');
    assert.strictEqual(buildCampaignDirective(directiveInputFrom(row, { angle: 'brief angle' }))!.angle, 'brief angle');
});

check('the reconciler follows a test order like any post order', () => {
    const rec = code(read('src/utils/campaign-reconciler.ts'));
    assert.match(rec, /CONTENT_ACTIONS: readonly CampaignOrderAction\[\] = \['draft_social_posts', 'draft_blog_pillar', 'ab_test_posts'\]/);
});

console.log('\n──── a summary states facts, not insight ────');

check('the summary and its candidate lessons involve no model', () => {
    assert.ok(!/anthropic|Anthropic|messages\.create|callModel/.test(learning),
        'A model asked "what did we learn?" writes plausible insight the data does not support.');
    const fn = span(learning, 'export async function buildCampaignSummary', '\n}\n', 'buildCampaignSummary');
    assert.match(fn, /if \(t\.verdict\.verdict === 'a' \|\| t\.verdict\.verdict === 'b'\) candidates\.push/,
        'Only a test with a real verdict may become a candidate lesson.');
});

console.log('\n──── a kept lesson reaches something ────');

check('kept lessons ride in the planning chat every turn', () => {
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /await learningsPromptBlock\(db, organisationId\)/);
    assert.match(learning, /WHAT PAST CAMPAIGNS TAUGHT THIS BUSINESS/);
});

check('"apply to drafting" writes a visible rule on each writing assistant the campaign briefed — only those', () => {
    const fn = span(learning, 'export async function saveLearning', '\n}\n', 'saveLearning');
    assert.match(fn, /eq\(campaignOrders\.campaignId, input\.campaignId\)/);
    assert.match(fn, /inArray\(campaignOrders\.targetRoleKey, \[SMM_ROLE_KEY, BLOG_WRITER_ROLE_KEY\]\)/);
    assert.match(fn, /eq\(aiAssistants\.organisationId, input\.organisationId\)/);
    assert.match(fn, /assistantId: t\.id/, 'Per assistant — never assistant_id NULL, which no Rules tab shows.');
    assert.match(fn, /origin: 'campaign_learning'/);
    assert.match(fn, /assembleBlueprint\(t\.id/, 'Recompile, or the rule reaches nothing until something else recompiles.');
    assert.match(fn, /appliedToDrafting: true/);
    assert.match(code(read('src/utils/assistant-rules-prompt.ts')), /r\.origin === 'campaign_learning'/,
        'The chat drafting path labels where the rule came from.');
});

check('the migration only adds tables', () => {
    const sql = read('db/z-campaign-learning.sql');
    for (const t of ['campaign_experiments', 'campaign_experiment_jobs', 'campaign_learnings']) {
        assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    }
    assert.ok(!/ALTER TABLE/i.test(sql.replace(/--[^\n]*/g, '')), 'No existing table is altered — nothing can break before it lands.');
    assert.match(sql, /campaign_id\s+INTEGER REFERENCES campaigns\(id\) ON DELETE SET NULL/, 'A lesson outlives its campaign.');
});

console.log('\n──── GUI and chat both reach it (§9.0) ────');

check('the Campaigns tab runs tests, shows verdicts, summarises, and keeps lessons once', () => {
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /data-cmp-aw-angle-a/);
    assert.match(tab, /function testsBlock/);
    assert.match(tab, /function summaryPanel/);
    assert.match(tab, /action: 'save_learning'/);
    assert.match(tab, /function isKept/, '"Kept" must come from the saved lessons, or a re-render offers Keep again.');
    assert.match(tab, /function lessonsHtml/);
});

check('the chat can propose a test and a lesson', () => {
    const card = code(read('src/components/disruptive-ui-registry.js'));
    assert.match(card, /A: \$\{o\.angleA\.trim\(\)\} · B: \$\{o\.angleB\.trim\(\)\}/, 'A test card shows BOTH angles.');
    assert.match(card, /register\('campaign_learning_proposal'/);
    const chat = code(read('src/components/chat-session.js'));
    const fn = span(chat, 'function onCampaignSaveLearning', '\n    }\n', 'the lesson handler');
    assert.match(fn, /action: 'save_learning'/);
});

console.log(`\n${passed} checks passed.`);
