// tests/campaign-performance.test.ts
// The Campaign Assistant's four Overview KPI cards: the arithmetic, and the wiring that feeds them.
//
// Why this file exists: the cards shipped in Phase 1 as COPY ONLY. The registry named four figures
// and the values came from get-assistant-performance, which reads post_insights scoped to the
// assistant's own id — and this assistant owns no posts, so the section rendered its "nothing to
// report" panel permanently. Exactly the goals-steer-generation failure: a complete surface with no
// wire behind it. These checks pin the wire down at both ends.
//
// No database: pure functions plus source-consistency checks.
// Run:  npx tsx tests/campaign-performance.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildCampaignPerformance, emptyCampaignPerformance, type CampaignPerformanceCounts,
} from '../src/utils/campaign-performance';

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

const counts = (over: Partial<CampaignPerformanceCounts> = {}): CampaignPerformanceCounts => ({
    campaignsTotal: 1, campaignsLive: 1, campaignsFinished: 0,
    postsPublished: 0, articlesPublished: 0, leadsFound: 0,
    workSpent: 0, decisionsRaised: 0, decisionsApproved: 0,
    decisionsPending: 0, ordersInReview: 0,
    ...over,
});

console.log('\n──── outcomes are things that actually happened ────');

check('outcomes are published work and real leads, added up', () => {
    const p = buildCampaignPerformance(counts({ postsPublished: 3, articlesPublished: 1, leadsFound: 12 }));
    assert.equal(p.metrics.outcomes, 16);
    assert.match(p.trends.outcomes, /3 posts/);
    assert.match(p.trends.outcomes, /1 article/);
    assert.match(p.trends.outcomes, /12 leads/);
});

check('the trend names the components, so 16 is not an unexplained number', () => {
    // "16" alone does not tell the user whether the campaign is producing content or finding
    // customers, which is the entire question the card is meant to answer.
    const p = buildCampaignPerformance(counts({ postsPublished: 2, leadsFound: 4 }));
    assert.equal(p.trends.outcomes, '2 posts · 4 leads');
    assert.ok(!p.trends.outcomes.includes('article'), 'a zero component was listed');
});

check('no outcomes yet says so rather than rendering an empty string', () => {
    assert.equal(buildCampaignPerformance(counts()).trends.outcomes, 'Nothing published yet');
});

console.log('\n──── effort per outcome refuses to invent a price ────');

check('effort per outcome is null until there is something to divide by', () => {
    // The registry warns that "Cost per Outcome: £0" is a lie about a real cost. Zero outcomes
    // against real spend is UNDEFINED, not free, and not infinite.
    const p = buildCampaignPerformance(counts({ workSpent: 12 }));
    assert.equal(p.metrics.effortPerOutcome, null);
    assert.equal(p.metrics.workSpent, 12);
});

check('effort per outcome divides work by outcomes, to one decimal', () => {
    const p = buildCampaignPerformance(counts({ workSpent: 12, postsPublished: 5 }));
    assert.equal(p.metrics.effortPerOutcome, 2.4);
    assert.equal(p.trends.effort, '12 tasks spent');
});

check('one task reads as a task, not "1 tasks"', () => {
    assert.equal(buildCampaignPerformance(counts({ workSpent: 1 })).trends.effort, '1 task spent');
});

console.log('\n──── needs you counts only what the user can act on ────');

check('needs you is pending decisions plus work sitting in review', () => {
    const p = buildCampaignPerformance(counts({ decisionsPending: 2, ordersInReview: 3 }));
    assert.equal(p.metrics.needsYou, 5);
    assert.match(p.trends.needsYou, /2 decisions/);
    assert.match(p.trends.needsYou, /3 orders in review/);
});

check('nothing waiting says so', () => {
    assert.equal(buildCampaignPerformance(counts()).trends.needsYou, 'Nothing waiting');
});

console.log('\n──── an assistant with no campaigns is not an assistant that failed ────');

check('no campaigns means hasData:false, not four zeroes', () => {
    // Four zeroes read as a campaign that produced nothing. The panel says "no campaign has run
    // yet", which is a different statement and one the user can act on.
    assert.equal(buildCampaignPerformance(counts({ campaignsTotal: 0, campaignsLive: 0 })).hasData, false);
    assert.equal(emptyCampaignPerformance().hasData, false);
});

check('a campaign that has produced nothing yet still has data', () => {
    assert.equal(buildCampaignPerformance(counts()).hasData, true);
});

console.log('\n──── the window is the campaign lifetime ────');

const endpoint = read('netlify/functions/get-campaign-performance.ts');

check('the endpoint takes no days parameter and applies no date filter', () => {
    // A 30-day window across a six-week flight cliff-drops at rollover — roi-hero-defaults-all-time
    // cost us this once already.
    assert.ok(!/queryStringParameters\?\.days|periodDays|DEFAULT_DAYS/.test(endpoint), 'a window crept in');
    assert.ok(!/gte\(.*createdAt|INTERVAL '|now\(\) -/.test(endpoint), 'a date filter crept in');
    assert.equal(buildCampaignPerformance(counts()).scope, 'lifetime');
});

check('the client overwrites the hardcoded "Last 30 days" note', () => {
    const client = read('assistants.js');
    const fn = client.slice(
        client.indexOf('async function _loadCampaignMetrics'),
        client.indexOf('async function _loadAssistantMetrics'),
    );
    assert.ok(fn.length > 0, '_loadCampaignMetrics not found');
    assert.ok(fn.includes('all time'), 'the period note still claims a 30-day window');
});

console.log('\n──── the wiring holds at both ends ────');

check('the registry routes this role to the campaign endpoint', () => {
    const registry = read('src/components/assistant-dashboard-registry.js');
    const entry = registry.slice(registry.indexOf('campaign_orchestrator: {'));
    assert.match(entry.slice(0, 2000), /metricsSource: 'campaign'/, 'no metricsSource flag');
    const client = read('assistants.js');
    assert.ok(client.includes("source === 'campaign'"), 'the client does not read the flag');
    assert.ok(client.includes('_loadCampaignMetrics(assistantId)'), 'the campaign loader is never called');
});

check('the role key is actually passed to the loader', () => {
    // Without this the branch above can never be taken, and the cards silently keep the social
    // endpoint — the exact failure this whole file is about.
    const client = read('assistants.js');
    assert.match(client, /_loadAssistantMetrics\(assistantId, currentData\.roleKey\)/, 'roleKey not passed at the call site');
    assert.match(client, /async function _loadAssistantMetrics\(assistantId, roleKey\)/, 'the loader does not accept it');
});

check('the endpoint is tenant-guarded and IDOR-checked', () => {
    // The campaign tables carry no RLS policy by design, so these two checks are the whole of the
    // isolation story.
    assert.ok(endpoint.includes('requireTenant('), 'no tenant guard');
    assert.ok(endpoint.includes('eq(aiAssistants.organisationId, orgId)'), 'no IDOR re-check');
    assert.ok(endpoint.includes('eq(campaigns.organisationId, orgId)'), 'campaigns are not org-scoped');
});

check('a failure is reported as a failure, never as a zero', () => {
    // get-assistant-metrics degrades to a 200 "no activity" shape; doing that here would tell the
    // user their campaign produced nothing, which is a much worse statement than "we don't know".
    assert.ok(endpoint.includes('statusCode: 500'), 'the catch does not surface an error');
    assert.ok(!/catch[\s\S]{0,200}emptyCampaignPerformance/.test(endpoint), 'the catch degrades to an empty payload');
    const client = read('assistants.js');
    const fn = client.slice(
        client.indexOf('async function _loadCampaignMetrics'),
        client.indexOf('async function _loadAssistantMetrics'),
    );
    assert.ok(fn.includes("_setMetricsEmptyState('error')"), 'the client does not distinguish an error');
    assert.ok(fn.includes("_setMetricsEmptyState('campaign-no-data')"), 'no campaign-specific empty state');
});

check('attribution rides the tracing column, not a guess', () => {
    assert.ok(endpoint.includes('campaign_order_id'), 'published work is not attributed via the order trace');
    assert.ok(endpoint.includes("artefact_kind = 'discovery_campaign'"), 'leads are not attributed via the order artefact');
});

console.log('\n──── the cards do not describe features that do not exist ────');

check('card 3 no longer claims work is reallocated unattended', () => {
    // autonomy_threshold_work is written and validated by campaigns.ts and read by nothing: no path
    // auto-approves a decision. The old copy ("without waking you") described that missing feature,
    // so the card could only ever have reported 0.
    const registry = read('src/components/assistant-dashboard-registry.js');
    const entry = registry.slice(
        registry.indexOf('campaign_orchestrator: {'),
        registry.indexOf('campaign_orchestrator: {') + 3000,
    );
    assert.ok(!entry.includes("label: 'Decisions Taken For You'"), 'the unimplemented claim is back');
    assert.ok(!/without waking you'/.test(entry), 'the unimplemented claim is back in the description');
    assert.match(entry, /label: 'Decisions Raised'/, 'card 3 lost its replacement label');
});

check('nothing in the codebase consumes the autonomy dial yet', () => {
    // A guard on the note above: the day this stops being true, card 3 should go back to promising
    // autonomy, and this check is what will fail to remind us.
    const consumers = ['src/utils/campaign-proposer.ts', 'src/utils/campaign-orders.ts', 'src/utils/campaign-reconciler.ts']
        .filter((f) => read(f).includes('autonomyThreshold'));
    assert.deepEqual(consumers, [], `autonomy threshold now has consumers: ${consumers.join(', ')} — revisit the card 3 copy`);
});

console.log(`\n${passed} checks passed.\n`);
