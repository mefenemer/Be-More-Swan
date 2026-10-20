// tests/help-page-fixes-2026-10-20.test.ts
// Three fixes from the 2026-10-20 review list, each a regression that came back once already
// or would be invisible until a customer hit it:
//
//   1. "Ask Your Team" (Help & Support → the Swan Command Bar) delegated EVERY "create something"
//      request through generate-post, which writes a social post job for whichever assistant it is
//      handed — "draft a blog post" became a social job on the Blog Writer. And it spent the draft
//      the moment the reply arrived, with no confirmation.
//   2. The bell's popover lives on <body> at z 80, so it opened UNDER the Social editor / Blog
//      Studio pages (z 90 / 85) even after the header itself was lifted over them.
//   3. The pricing page's currency picker converts for DISPLAY only; checkout stays in pounds.
//   4. Refer a friend is "give a month, get a month" (owner): one token = one free month of the
//      referrer's plan. "Save five for a free assistant" is retired everywhere it was promised.
//
// Run:  npx tsx tests/help-page-fixes-2026-10-20.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';
import { buildHelpKnowledge } from '../src/utils/help-knowledge';
import { teamAllowanceFrom } from '../src/utils/team-seats';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(p, 'utf8');

console.log('\nAsk Your Team — delegation\n');

test('assistant-command delegates only to the Social Media Assistant', () => {
    const src = read('netlify/functions/assistant-command.ts');
    assert.match(src, /const DELEGATE_ROLE = 'social_media_manager';/);
    assert.match(src, /const delegates = assistants\.filter\(a => a\.roleKey === DELEGATE_ROLE\);/);
    const del = src.slice(landmark(src, "} else if (type === 'delegate') {"));
    assert.match(del, /delegates\.find\(/);
    assert.ok(!/out\.assistantId = .*assistants\.find/.test(del), 'the delegate id must come from `delegates`, not every assistant');
});

test('the command bar asks before it drafts', () => {
    const ws = read('workspace.html');
    const run = ws.slice(landmark(ws, 'async function runCommand(command) {'), landmark(ws, 'async function draftViaAssistant(d, command) {'));
    assert.ok(!run.includes("fetch('/.netlify/functions/generate-post'"), 'runCommand must not call generate-post itself');
    assert.match(run, /Draft it →/);
    assert.match(run, /onclick = \(\) => draftViaAssistant\(d, command\)/);
});

console.log('\nNotifications popover over the editor pages\n');

test('the popover is lifted above the Social editor and Blog Studio pages', () => {
    const ws = read('workspace.html');
    assert.match(ws, /body:has\(#post-review-modal\.pr-page:not\(\.hidden\)\) #notif-popover,\s*body:has\(#bms-blog-backdrop\.bs-page\.bs-open\) #notif-popover \{ z-index: 93 !important; \}/);
    // ...which only works while the popover stays where this rule expects it.
    assert.match(read('notifications.js'), /panel\.id = 'notif-popover';/);
});

console.log('\nPricing — live currency, charged in pounds\n');

test('pounds by default; conversions are labelled approximate and checkout is untouched', () => {
    const p = read('pricing.html');
    assert.match(p, /<option value="GBP" selected>£ GBP<\/option>/);
    assert.match(p, /let _currency = 'GBP';/);
    assert.match(p, /return '≈ ' \+ new Intl\.NumberFormat/);
    assert.match(p, /You're charged in pounds \(GBP\)/);
    const choose = p.slice(landmark(p, 'window.choosePlan = function (tier) {'));
    assert.ok(!/\b_currency\b/.test(choose.slice(0, 1200)), 'checkout must not carry the display currency');
});

test('fx-rates serves GBP-based rates and offers nothing invented on failure', () => {
    const f = read('netlify/functions/fx-rates.ts');
    assert.match(f, /base=GBP/);
    assert.match(f, /if \(j\.base !== 'GBP'/);
    assert.match(f, /statusCode: 503/);
});

console.log('\nRefer a friend — give a month, get a month\n');

test('redeem accepts only free_month and credits one month of the caller\'s plan', () => {
    const f = read('netlify/functions/redeem-referral-reward.ts');
    assert.match(f, /if \(type !== FREE_MONTH\)/);
    assert.match(f, /const tokensNeeded = 1;/);
    assert.match(f, /amount: -Math\.round\(month\.amountGbp \* 100\)/);
    assert.ok(!f.includes('bonusAssistants: sql'), 'redeeming must no longer add assistant slots');
    const t = read('src/utils/referral-tokens.ts');
    assert.match(t, /notInArray\(plans\.planType, \[\.\.\.FREE_PLAN_TYPES\]\)/, 'a trial has no month to take off');
});

test('no customer-facing copy still promises £10 tokens or a free assistant', () => {
    const files = ['index.html', 'referral.html', 'referral-content.html', 'faq.html', 'tour.js',
        'src/utils/notification-templates-catalog.ts', 'src/utils/gamification.ts'];
    for (const f of files) {
        const src = read(f).replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/free assistant/i.test(src), `${f} still offers a free assistant`);
        assert.ok(!/£10 credit/i.test(src), `${f} still offers £10 credit`);
        assert.ok(!/Reward Vault/.test(src), `${f} still names the Reward Vault`);
    }
});

console.log('\nAsk Your Team — answers from the Help Centre\n');

test('the knowledge block is every article, verbatim, in order, with exact titles', () => {
    const kb = buildHelpKnowledge([
        { title: 'B "quoted"', category: 'Billing', contentMd: 'Body B' },
        { title: 'A', category: null, contentMd: '  Body A  ' },
    ]);
    assert.deepStrictEqual(kb.titles, ['B "quoted"', 'A']);
    assert.ok(kb.text.includes('<article title="B &quot;quoted&quot;" category="Billing">\nBody B\n</article>'));
    assert.ok(kb.text.includes('category="General">\nBody A\n</article>'));
    assert.strictEqual(buildHelpKnowledge([]).text, '');
});

test('the articles are a cached prefix AHEAD of the per-user prompt', () => {
    const src = read('netlify/functions/assistant-command.ts');
    assert.match(src, /system: \[\s*\{ type: 'text', text: knowledge, cache_control: \{ type: 'ephemeral' \} \},\s*\{ type: 'text', text: system \},\s*\]/);
    // Nothing per-request may leak into the cached block.
    const k = src.slice(landmark(src, 'const knowledge = kb.text'), landmark(src, 'const system = `'));
    assert.ok(!/assistantList|setupSummary|command|Date/.test(k), 'the cached block must be identical for every user');
});

test('the article it cites must exist, and the bar can open it from the Help page itself', () => {
    const src = read('netlify/functions/assistant-command.ts');
    assert.match(src, /typeof parsed\.article === 'string' && kb\.titles\.includes\(parsed\.article\)/);
    assert.match(read('workspace.html'), /'Read the article →', \(\) => window\.openHelpArticle\(d\.article\)/);
    const h = read('help.js');
    const open = h.slice(landmark(h, 'window.openHelpArticle = function (title) {'));
    assert.ok(landmark(open, "window._currentViewKey === 'help'") < landmark(open, 'window._helpOpenArticle = title;'),
        'already on Help, the article opens in place — _helpOpenArticle is only read on load');
});

test('the referral article follows the Help Centre quoting rules', () => {
    const sql = read('db/help-articles-2026-12zzzzz-referrals.sql');
    const bodies = [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
    assert.strictEqual(bodies.length, 1);
    assert.ok(!bodies[0].includes(';'), 'no semicolons inside a body');
    assert.ok(!bodies[0].includes("''"), 'apostrophes inside $$ are literal');
    assert.ok(!/free assistant|£10|token/i.test(bodies[0]), 'describes the current offer only');
});

test('the data export article follows the Help Centre quoting rules and matches the code', () => {
    const sql = read('db/help-articles-2026-12zzzzzz-data-export.sql');
    const bodies = [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
    assert.strictEqual(bodies.length, 1);
    assert.ok(!bodies[0].includes(';'), 'no semicolons inside a body');
    assert.ok(!bodies[0].includes("''"), 'apostrophes inside $$ are literal');
    // The claims it makes are the ones the code makes.
    const ui = read('user-settings.html');
    assert.ok(ui.includes('>Your data<') && ui.includes('>Export my data<') && ui.includes('data-tab="agreements">My Agreements<'));
    assert.ok(read('netlify/functions/data-export-download.ts').includes('.json'), 'the file is JSON');
    assert.ok(read('src/utils/workspace-export.ts').includes("EXPORT_WORKSPACE_ROLES = ['owner', 'admin']"), 'workspace part is owners and admins');
    assert.ok(/24 hours/.test(bodies[0]) && /one export a day/i.test(bodies[0]));
});

console.log('\nTeam seats coming soon; no app-connection limit (owner, 2026-10-20)\n');

test("'coming_soon' never switches invites on — only true does", () => {
    assert.strictEqual(teamAllowanceFrom({ workspace_collaboration: 'coming_soon' }, 3).collaboration, false);
    assert.strictEqual(teamAllowanceFrom({ workspace_collaboration: 'coming_soon' }, 3).maxSeats, 1);
    assert.strictEqual(teamAllowanceFrom({ workspace_collaboration: true }, 3).maxSeats, 3);
    assert.ok(!read('src/utils/team-seats.ts').includes('Digital Employee plan'), 'the retired plan is not offered as the way to get invites');
});

test('the pricing table and plan picker show coming soon, never a tick, and no seats or connections', () => {
    const p = read('pricing.html');
    assert.match(p, /if \(cmpComingSoon\(value\)\) return CMP_SOON;/);
    assert.ok(landmark(p, 'if (cmpComingSoon(value))') < landmark(p, "if (def.valueType === 'boolean') return cmpTruthy"));
    assert.ok(!/>App Connections<br>/.test(p), 'the static fallback row is gone');
    const ws = read('workspace.html');
    const picker = ws.slice(landmark(ws, 'async function loadPlanCards(referralCode) {'), landmark(ws, 'async function loadPlanCards(referralCode) {') + 4000);
    assert.ok(!/appConnectionLimit|seatLimit/.test(picker), 'no connection or seat bullets');
    assert.match(picker, /return v === true \|\| v === 'true';/, 'only features the plan HAS');
});

test('the onboarding wizards never cap connections', () => {
    const o = read('onboarding-plan-limits.js');
    assert.ok(!/MAX_APPS_BY_TIER|appConnectionLimit/.test(o));
    assert.strictEqual((o.match(/maxApps: NO_APP_LIMIT/g) || []).length, 3);
});

test('the setup guide only offers "Invite a teammate" where inviting is possible', () => {
    const r = read('src/utils/onboarding-recommendations.ts');
    assert.match(r, /if \(canInvite \|\| hasTeammate\) add\(\{\s*key: 'invite_teammate'/);
});

test('public copy: no connection limits, team members coming soon, no Minute Taking on the homepage', () => {
    const faq = read('faq.html');
    assert.match(faq, /Is there a limit on how many apps I can connect\?/);
    assert.match(faq, /coming soon to the Busywork Buster/);
    assert.ok(!/Standard App and a Premium App|connection limit mid-month/.test(faq));
    assert.ok(!read('index.html').includes('Minute Taking'));
    const sql = read('db/z-plans-no-connection-limit-team-soon.sql');
    assert.match(sql, /'"coming_soon"'::jsonb/);
    assert.match(sql, /WHERE key IN \('app_connection_limit', 'app_connections'\)/);
    assert.ok(!/master_plans[\s\S]*?updated_at[\s\S]*?RETURNING tier_key/.test(sql.split('UPDATE plan_features')[0]), 'master_plans has no updated_at column');
});

console.log(`\n${passed} checks passed`);
