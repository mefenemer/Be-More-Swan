// tests/discovery-spend-guards.test.ts
// What stands between a tenant's Searches tab and our search bill.
//
// The per-campaign guardrails were the only limits in the system, and two holes ran through them:
//
//  1. The volume fields were taken from the request body with `typeof x === 'number'` as the whole
//     validation, so a form, a chat proposal or anyone with the console open could set a tenant's own
//     ceiling to whatever they liked. (`maxCostGbpPerRun` was safe only because it is never accepted.)
//  2. Nothing limited how many searches an org could run at once. Each is capped at £2 a run, so the
//     real ceiling was £2 × active searches × runs per day, and nothing capped the middle term.
//
// Also guarded here: the robots.txt courtesy check on the lead crawler, and the crawler saying who it
// actually is. Both are cheap to get right and awkward to explain after a complaint.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    clampGuardrail, MAX_ACTIVE_CAMPAIGNS_PER_ORG,
    MAX_LEADS_PER_MONTH_CEILING, MAX_LEADS_PER_RUN_CEILING,
} from '../src/config/discovery-limits';
import { parseRobots, robotsAllowsPath } from '../src/lib/robots';
import { USER_AGENTS } from '../src/utils/safe-fetch';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const CAMPAIGNS = read('netlify/functions/discovery-campaigns.ts');
const LEAD_GEN = read('netlify/functions/lead-generation.ts');
const DISCOVERY_UTIL = read('src/utils/discovery.ts');
const ENRICH = read('src/lib/discovery-enrich.ts');

console.log('\n──── 1. guardrail values are clamped, not trusted ────');

check('an absurd request is clamped to the ceiling', () => {
    assert.equal(clampGuardrail(100000, MAX_LEADS_PER_RUN_CEILING), MAX_LEADS_PER_RUN_CEILING);
    assert.equal(clampGuardrail(1e9, MAX_LEADS_PER_MONTH_CEILING), MAX_LEADS_PER_MONTH_CEILING);
});

check('a sensible request passes through untouched', () => {
    assert.equal(clampGuardrail(25, MAX_LEADS_PER_RUN_CEILING), 25,
        'this is an anti-runaway limit, not a product tier — normal values must not be rewritten');
});

check('nonsense is dropped so the column keeps its default', () => {
    for (const bad of [0, -5, NaN, Infinity, '50', null, undefined, {}]) {
        assert.equal(clampGuardrail(bad, MAX_LEADS_PER_RUN_CEILING), undefined,
            `${JSON.stringify(bad)} must not reach the column`);
    }
    // Zero is dropped rather than clamped to 1 on purpose: it is a mistake, not a small limit, and a
    // search that found one lead per run would look broken.
});

check('a fractional value cannot smuggle a float into an integer column', () => {
    assert.equal(clampGuardrail(12.9, MAX_LEADS_PER_RUN_CEILING), 12);
});

check('BOTH doors into the column clamp — create and edit', () => {
    const create = CAMPAIGNS.slice(landmark(CAMPAIGNS, "if (action === 'create')"), landmark(CAMPAIGNS, "if (action === 'list')"));
    assert.match(create, /clampGuardrail\(guardrails\.maxLeadsPerRun/, 'create must clamp per-run');
    assert.match(create, /clampGuardrail\(guardrails\.maxLeadsPerMonth/, 'create must clamp per-month');

    const edit = CAMPAIGNS.slice(landmark(CAMPAIGNS, "if (action === 'edit')"));
    assert.match(edit.slice(0, 3000), /clampGuardrail\(g\.maxLeadsPerRun/,
        'the edit modal is the other door to the same column — a limit that can only be raised '
        + 'through Edit is not a limit');
    assert.match(edit.slice(0, 3000), /clampGuardrail\(g\.maxLeadsPerMonth/, 'and per-month too');
});

check('the operator-only cost cap is still never accepted from a caller', () => {
    // It caps OUR spend, nothing bills it to the tenant, and a model once invented "Max £50 per run"
    // onto an approval card when this was settable.
    assert.ok(!/maxCostGbpPerRun:\s*(guardrails|g)\./.test(CAMPAIGNS),
        'maxCostGbpPerRun must stay a table default, unreachable from the request body');
});

console.log('\n──── 2. an organisation cannot run unlimited searches ────');

check('the ceiling exists and is a real number', () => {
    assert.ok(Number.isInteger(MAX_ACTIVE_CAMPAIGNS_PER_ORG) && MAX_ACTIVE_CAMPAIGNS_PER_ORG > 0);
});

check('it counts ACTIVE searches only', () => {
    const fn = DISCOVERY_UTIL.slice(landmark(DISCOVERY_UTIL, 'export async function activeCampaignCapacity'));
    assert.match(fn.slice(0, 1600), /eq\(discoveryCampaigns\.status, 'active'\)/,
        'drafts and paused searches spend nothing — counting them would punish a tenant for thinking');
    assert.match(fn.slice(0, 1600), /eq\(discoveryCampaigns\.organisationId/,
        'per ORG, not per assistant: a per-assistant cap is sidestepped by hiring a second assistant');
});

check('it fails OPEN, because a spend guard that cannot measure must not block paid work', () => {
    const fn = DISCOVERY_UTIL.slice(landmark(DISCOVERY_UTIL, 'export async function activeCampaignCapacity'));
    const catchBlock = fn.slice(landmark(fn, '} catch'));
    assert.match(catchBlock.slice(0, 400), /ok: true/,
        'a database blip must not tell a paying user they are over a limit we could not count');
});

check('every door into "active" checks it — all four of them', () => {
    // create, approve_brief and run_now in discovery-campaigns.ts, plus approve_idea in
    // lead-generation.ts, which is the one a MODEL can push on the user's behalf.
    const create = CAMPAIGNS.slice(landmark(CAMPAIGNS, "if (action === 'create')"), landmark(CAMPAIGNS, "if (action === 'list')"));
    assert.match(create, /activeCampaignCapacity/, 'create');

    const brief = CAMPAIGNS.slice(landmark(CAMPAIGNS, "if (action === 'approve_brief')"), landmark(CAMPAIGNS, "if (action === 'run_now')"));
    assert.match(brief, /activeCampaignCapacity/, 'approve_brief promotes a draft');

    const runNow = CAMPAIGNS.slice(landmark(CAMPAIGNS, "if (action === 'run_now')"), landmark(CAMPAIGNS, "if (action === 'list_leads')"));
    assert.match(runNow, /activeCampaignCapacity/, 'run_now promotes a draft too');

    const idea = LEAD_GEN.slice(landmark(LEAD_GEN, "if (action === 'approve_idea')"));
    assert.match(idea.slice(0, 3000), /activeCampaignCapacity/, 'approving an idea starts a real run');
});

check('a draft can always be created, even at the cap', () => {
    const create = CAMPAIGNS.slice(landmark(CAMPAIGNS, "if (action === 'create')"), landmark(CAMPAIGNS, "if (action === 'list')"));
    const gate = create.slice(landmark(create, 'activeCampaignCapacity') - 300, landmark(create, 'activeCampaignCapacity'));
    assert.match(gate, /if \(!asDraft\)/,
        'a tenant at the cap must still be able to write down the next idea — a draft spends nothing');
});

check('the refusal is one sentence, in one place', () => {
    assert.match(DISCOVERY_UTIL, /export function campaignCapacityMessage/,
        'four differently-worded refusals for one rule is how a limit reads as a bug');
    const msg = DISCOVERY_UTIL.slice(landmark(DISCOVERY_UTIL, 'export function campaignCapacityMessage'));
    assert.match(msg.slice(0, 600), /Pause one/, 'and it must say what to do about it');
});

console.log('\n──── 3. the crawler is polite and says who it is ────');

check('lead enrichment identifies itself as the lead crawler', () => {
    assert.match(ENRICH, /userAgent: USER_AGENTS\.leadDiscovery/,
        'reading a prospect’s contact page while calling yourself the Inspo Bot tells a site owner '
        + 'the wrong thing about why you are there');
    assert.notEqual(USER_AGENTS.leadDiscovery, USER_AGENTS.inspo, 'the two behaviours need two names');
    assert.match(USER_AGENTS.leadDiscovery, /https?:\/\//,
        'a well-behaved agent string points at a page explaining itself');
});

check('robots.txt is consulted before a prospect’s page is read', () => {
    const fn = ENRICH.slice(landmark(ENRICH, 'export async function enrichLeadContact'));
    assert.ok(landmark(fn, 'robotsAllows(') < landmark(fn, 'safeFetchText('),
        'the check has to precede the fetch it is gating');
});

check('a Disallow that covers our path stops the read', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /contact\n');
    assert.equal(robotsAllowsPath(rules, '/contact'), false);
    assert.equal(robotsAllowsPath(rules, '/about'), true, 'and only that path');
});

check('rules written for US override the wildcard group', () => {
    const rules = parseRobots(
        'User-agent: *\nDisallow: /\n\nUser-agent: BeMoreSwan-LeadDiscovery\nDisallow: /private\n',
    );
    assert.equal(robotsAllowsPath(rules, '/contact'), true,
        'a site that wrote rules for us specifically has taken the trouble to be specific — folding '
        + 'the generic block back in would override what they actually said');
    assert.equal(robotsAllowsPath(rules, '/private'), false, 'while still honouring what they wrote');
});

check('Allow beats Disallow when it is more specific', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /contact\n');
    assert.equal(robotsAllowsPath(rules, '/contact'), true, 'a carve-out is an instruction too');
    assert.equal(robotsAllowsPath(rules, '/pricing'), false);
});

check('an empty Disallow means "everything is allowed", not "nothing is"', () => {
    const rules = parseRobots('User-agent: *\nDisallow:\n');
    assert.equal(robotsAllowsPath(rules, '/contact'), true,
        'the standard’s way of allowing everything — reading it as a path would block whole sites');
});

check('no rules, no robots.txt, and junk all fail OPEN', () => {
    assert.equal(robotsAllowsPath(null, '/contact'), true, 'no file means no rules were set');
    assert.equal(robotsAllowsPath([], '/contact'), true);
    assert.equal(robotsAllowsPath(parseRobots('<!DOCTYPE html><h1>404</h1>'), '/contact'), true,
        'an HTML 404 page is the commonest "robots.txt" on the web');
});

check('comments and case do not defeat the parser', () => {
    const rules = parseRobots('# hello\nUSER-AGENT: *\nDISALLOW: /contact # no scraping please\n');
    assert.equal(robotsAllowsPath(rules, '/contact'), false);
});

check('a rule for another crawler is not applied to us', () => {
    const rules = parseRobots('User-agent: AhrefsBot\nDisallow: /\n');
    assert.equal(robotsAllowsPath(rules, '/contact'), true,
        'someone else’s block is not ours to honour');
});

console.log(`\n${passed} checks passed.\n`);
