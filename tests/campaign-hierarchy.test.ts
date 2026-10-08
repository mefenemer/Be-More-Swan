// tests/campaign-hierarchy.test.ts
// §9.4 of docs/campaign-orchestrator-plan.md: umbrella campaigns, always-on campaigns, the year.
//
// WHY THIS EXISTS. "We run overarching umbrella campaigns that contain sub-campaigns, and BAU
// always-on campaigns underneath. Moving budget from the Summer Rebrand shouldn't cannibalise the
// always-on budget. The calendar needs to show the hierarchy of the year."
//
// What is pinned, and why each would be easy to lose:
//   • ONE level. A CHECK cannot see another row, so depth lives only in campaigns.ts — one deleted
//     guard and umbrellas nest without limit, and every roll-up double-counts.
//   • Budgets are NOT pooled. Each child keeps its own ceiling; an umbrella shows sums only. That is
//     how "no cannibalising" is met by construction rather than by a rule someone must remember.
//   • Outcomes are summed per measure, never across — adding engagements to leads means nothing.
//   • Always-on has no end date, which is also exactly why the finish sweep never touches it.
//   • The year view draws only what is real: a draft that never started gets no invented flight.
//
// Run:  npx tsx tests/campaign-hierarchy.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const api = code(read('netlify/functions/campaigns.ts'));
const tab = code(read('src/components/assistant-campaigns.js'));

console.log('\n──── the database ────');

check('the migration adds the umbrella (SET NULL) and always-on (no end date), with inline checks', () => {
    const sql = read('db/z-campaign-hierarchy.sql');
    assert.match(sql, /parent_campaign_id INTEGER\s+REFERENCES campaigns\(id\) ON DELETE SET NULL/,
        'Removing an umbrella must never take its campaigns with it.');
    assert.match(sql, /CONSTRAINT campaigns_parent_not_self_check CHECK \(parent_campaign_id IS NULL OR parent_campaign_id <> id\)/);
    assert.match(sql, /always_on BOOLEAN NOT NULL DEFAULT FALSE\s+CONSTRAINT campaigns_always_on_no_end_check CHECK \(NOT always_on OR ends_at IS NULL\)/);
    assert.ok(!/DROP CONSTRAINT/i.test(sql.replace(/--[^\n]*/g, '')), 'Inline checks only — no DROP-then-ADD.');
    const schema = read('db/schema.ts');
    assert.match(schema, /parentCampaignId: integer\("parent_campaign_id"\)/);
    assert.match(schema, /alwaysOn: boolean\("always_on"\)\.notNull\(\)\.default\(false\)/);
});

console.log('\n──── one level, one assistant ────');

check('an umbrella must be top-level, this assistant\'s, live, and not the campaign itself', () => {
    const fn = span(api, 'async function resolveParent', '\n    }\n\n', 'resolveParent');
    assert.match(fn, /pid === selfId/, 'A campaign cannot be its own umbrella.');
    assert.match(fn, /eq\(campaigns\.organisationId, orgId\)/);
    assert.match(fn, /parent\.assistant !== assistantId/, 'An umbrella across two assistants would roll up nothing.');
    assert.match(fn, /parent\.status === 'archived'/);
    assert.match(fn, /if \(parent\.parent\)/, 'The umbrella must itself have no umbrella — one level only.');
    assert.match(fn, /eq\(campaigns\.parentCampaignId, selfId\)/, 'A campaign with children cannot become a child.');
});

check('create and edit both go through the depth check', () => {
    const create = span(api, "action === 'create'", "action === 'edit'", 'create');
    assert.match(create, /resolveParent\(body\.parentCampaignId, assistantId, null\)/);
    const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(edit, /resolveParent\(body\.parentCampaignId, campaign\.aiAssistantId, campaign\.id\)/);
});

console.log('\n──── always on ────');

check('always-on clears the end date on create and on edit', () => {
    const create = span(api, "action === 'create'", "action === 'edit'", 'create');
    assert.match(create, /endsAt: alwaysOn \? null :/);
    const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(edit, /if \(finalAlwaysOn\) patch\.endsAt = null;/,
        'A date sent to a campaign that stays always-on must be dropped, or the CHECK refuses the whole edit.');
});

check('the finish sweep only finishes campaigns with an end date — always-on is never finished', () => {
    const rec = code(read('src/utils/campaign-reconciler.ts'));
    const sweep = span(rec, 'async function sweepExpiredCampaigns', '\n}\n', 'the sweep');
    assert.match(sweep, /isNotNull\(campaigns\.endsAt\)/);
});

console.log('\n──── umbrellas never pool budgets ────');

check('the umbrella roll-up is read-only sums, outcomes per measure', () => {
    const fn = span(tab, 'function umbrellaHtml', '\n  }\n', 'umbrellaHtml');
    assert.match(fn, /byMetric\[k\.outcomeMetric\]/, 'Outcomes must be summed per measure, never across measures.');
    assert.match(fn, /Each keeps its own budget/);
    assert.ok(!/post\(|action:/.test(fn), 'The roll-up must write nothing.');
    assert.ok(!/maxWorkItems\s*=/.test(api.replace(/maxWorkItems\s*=\s*int\(/g, '')),
        'Nothing may set a child\'s ceiling from its umbrella.');
});

check('children render indented under their umbrella; an orphan stays visible', () => {
    const fn = span(tab, 'function nestedRows', '\n  }\n', 'nestedRows');
    assert.match(fn, /!c\.parentCampaignId \|\| !ids\.has\(c\.parentCampaignId\)/,
        'A child whose umbrella is gone (archived) must render at the top level, not vanish.');
});

check('the form offers only legal umbrellas, and none to a campaign that is one', () => {
    const fn = span(tab, 'function umbrellaFields', '\n  }\n', 'umbrellaFields');
    assert.match(fn, /!x\.parentCampaignId && \(!c \|\| x\.id !== c\.id\)/);
    assert.match(fn, /isUmbrella[\s\S]{0,40}\?/);
});

console.log('\n──── the year ────');

check('the year view is org-scoped and traces work through orders only', () => {
    const fn = span(api, "action === 'timeline'", "action === 'list_library'", 'timeline');
    assert.match(fn, /eq\(campaigns\.organisationId, orgId\)/);
    assert.match(fn, /JOIN campaign_orders o ON o\.id = j\.campaign_order_id/);
    assert.match(fn, /o\.organisation_id = \$\{orgId\}/);
    assert.match(fn, /NOT IN \('rejected','cancelled'\)/, 'Turned-down posts are not part of the year.');
});

check('a draft that never started gets no invented flight', () => {
    const fn = span(tab, 'function timelineHtml', '\n  async function loadTimeline', 'timelineHtml');
    assert.match(fn, /const start = r\.startsAt \? new Date\(r\.startsAt\) : null;/);
    assert.match(fn, /'not started'/);
    assert.ok(!/createdAt/.test(fn), 'A creation date is not a flight — drawing one would show work that never ran.');
});

check('the Calendar tab draws the year for this role, with its year buttons bound on document', () => {
    const cal = code(read('src/components/assistant-calendar.js'));
    assert.match(cal, /state\.roleKey === 'campaign_orchestrator' && window\.AssistantCampaigns\?\.renderTimeline/);
    assert.match(tab, /document\.addEventListener\('click', \(e\) => \{\s*const btn = e\.target\.closest\('\[data-cmp-tl-year\]'\)/,
        'Never bind handlers from a render path — the host is replaced on every navigation.');
});

console.log('\n──── the chat ────');

check('the chat knows the hierarchy and can place a campaign in an umbrella', () => {
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /an UMBRELLA over campaignId/);
    assert.match(plan, /ALWAYS ON/);
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /one level only/);
    assert.match(orch, /"parentCampaignId": <number>/);
    const card = code(read('src/components/disruptive-ui-registry.js'));
    assert.match(card, /parentCampaignId: parentId,/);
    assert.match(card, /\.\.\.\(alwaysOn \? \{ endsAt: null \} : \{\}\)/, 'An always-on card must never send an end date.');
    const chat = code(read('src/components/chat-session.js'));
    assert.match(chat, /parentCampaignId: c\.parentCampaignId/);
});

console.log(`\n${passed} checks passed.`);
