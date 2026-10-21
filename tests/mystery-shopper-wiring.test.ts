// tests/mystery-shopper-wiring.test.ts
// The Mystery Shopper as a hired assistant (docs/mystery-shopper-plan.md step 3): every registry it
// must be in, the names the chat quotes against the page that shows them, the set-up ↔ audit bridge,
// and the GUI/chat parity — each chat card is handled, and each handler calls the tab's own action.
//
// Run:  npx tsx tests/mystery-shopper-wiring.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';
import { RULE_READING_ROLES } from '../src/utils/assistant-rules-prompt';
import { getGoalMetric } from '../src/config/goal-metrics';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';
import { ROLE_ACTIVITY_ROLES } from '../src/utils/role-activity';
import {
    CONVERSION_GOALS, SETUP_KEYS, rawFromSetup, setupAnswersFor, validateSettings, type SiteAuditSettings,
} from '../src/utils/site-audit-setup';
import { MYSTERY_SHOPPER_ROLE_KEY } from '../src/constants/roles';
import { stalledFixBrief } from '../src/utils/site-audit-briefs';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const ROLE = MYSTERY_SHOPPER_ROLE_KEY;

const registry = read('src/components/assistant-dashboard-registry.js');
const tab = read('src/components/assistant-site-audit.js');
const chat = read('netlify/functions/chat-orchestrator.ts');
const cards = read('src/components/disruptive-ui-registry.js');
const session = read('src/components/chat-session.js');
const assistants = read('assistants.js');
const detail = read('assistant-detail.html');
const workspace = read('workspace.html');
const schemas = read('src/public/assistant-onboarding-schemas.js');

/** The registry entry's source text, from its key to the next top-level role key. */
const entry = (() => {
    const at = registry.indexOf(`    ${ROLE}: {`);
    assert.ok(at > -1, 'mystery_shopper registry entry');
    const end = registry.indexOf('\n    lead_qualifier: {', at);
    return registry.slice(at, end);
})();

console.log('\nRegistries');

check('role key constant matches the catalogue', () => {
    assert.strictEqual(ROLE, 'mystery_shopper');
    assert.ok(read('db/seed-catalog.ts').includes(`roleKey: '${ROLE}'`));
    assert.ok(read('db/z-mystery-shopper-role.sql').includes(`'${ROLE}'`));
});

check('the catalogue row is inserted HIDDEN (is_active false, coming_soon false)', () => {
    const sql = read('db/z-mystery-shopper-role.sql');
    assert.match(sql, /'\["standalone"\]'::jsonb,\s*false,\s*false\s*\)/);
    assert.match(sql, /ON CONFLICT \(role_key\) DO NOTHING/);
});

check('connection policy is an explicit EMPTY list (an omitted role fails open)', () => {
    assert.deepStrictEqual(ROLE_CONNECTIONS[ROLE], []);
});

check('build manifest, rules, activity and goal metric all know the role', () => {
    assert.deepStrictEqual(ASSISTANT_BUILD[ROLE], { setup: 'schema', chat: true, dashboard: true });
    assert.ok(RULE_READING_ROLES.has(ROLE));
    assert.ok(ROLE_ACTIVITY_ROLES.has(ROLE));
    const m = getGoalMetric('site_health_score');
    assert.ok(m && m.roles?.includes(ROLE) && m.available);
    assert.match(read('netlify/functions/poll-goal-telemetry.ts'), /case 'site_health_score':/);
});

check('labels, welcome, starter prompts and mandate chips exist', () => {
    for (const f of ['src/public/role-labels.js', 'src/components/team-feed.js', 'src/components/assistant-welcome-messages.js',
        'src/components/assistant-starter-prompts.js', 'src/public/mandate-suggestions.js']) {
        assert.ok(read(f).includes(`${ROLE}:`), f);
    }
});

check('dashboard entry: own tab, own metrics, no social modules, no post queue or Data Hub', () => {
    assert.match(entry, /metricsSource: 'site_audit'/);
    assert.match(entry, /siteAuditTab: \{\s*label: 'Website',/);
    assert.match(entry, /hideReviewQueue: true/);
    assert.match(entry, /hideDataHub: true/);
    assert.match(entry, /hasPostingSchedule: false/);
    assert.match(entry, /defaultMainTab: 'website'/);
    assert.match(entry, /calendarItems: 'checks'/);
    assert.match(entry, /rulesScope: 'audit'/);
    assert.ok(!/primaryAction/.test(entry.replace(/\/\/.*$/gm, '')), 'no primary action — the button lives on the tab');
    assert.strictEqual((entry.match(/label: '/g) || []).length, 5, 'four KPI cards + the tab label');
});

check('the page has the tab, its panel, the script, and every branch that routes to them', () => {
    assert.match(detail, /id="maintab-btn-website" data-maintab="website"/);
    assert.match(detail, /<div id="maintab-website" role="tabpanel" aria-labelledby="maintab-btn-website" class="main-tab-content hidden">\s*<div id="site-audit-host"><\/div>/);
    assert.match(detail, /id="site-audit-badge" style="display:none"/);
    assert.match(workspace, /<script src="\/src\/components\/assistant-site-audit\.js"><\/script>/);
    assert.match(assistants, /toggle\('maintab-btn-website', !!siteAuditTab\)/);
    assert.match(assistants, /if \(name === 'website'\) window\.AssistantSiteAudit\?\.activate\(\);/);
    assert.match(assistants, /if \(source === 'site_audit'\)[\s\S]{0,120}_loadSiteAuditMetrics\(assistantId\)/);
    assert.match(assistants, /_detailRulesScope === 'audit'/);
    assert.match(read('dashboard-content.html'), /reg\.siteAuditTab\) return \{ tab: 'website'/);
    assert.match(read('calendar.js'), /_datedSource === 'checks'/);
});

console.log('\nNames the chat quotes');

check('every tab and button the chat names is on the page', () => {
    const at = chat.indexOf('function mysteryShopperSurfaces()');
    const surfaces = chat.slice(at, chat.indexOf('\n}', at));
    for (const name of ['"Website" tab', '"Check my site now"', '"Settings"', '"I\'ll make this change"', '"Copy"', '"Reject"', '"I\'ve made this change"', '"Results" tab',
        '"Ideas for your other assistants"', '"Brief <name>"',
        // The six sub-tabs (2026-10-21) and the score explainer's buttons.
        '"Checks"', '"To review"', '"In progress"', '"Done"', '"Needs attention"', '"Archived"',
        '"Why your score isn\'t higher"', '"See the suggested fix"', '"Edit competitors"', '"Bring back"', '"Undo"']) {
        assert.ok(surfaces.includes(name), `surfaces names ${name}`);
    }
    for (const label of ['Check my site now', 'Settings', "I'll make this change", '>Copy<', '>Reject<', "I've made this change", 'Ideas for your other assistants', '>Brief ${esc(who.name)}<',
        "['checks', 'Checks'], ['review', 'To review'], ['progress', 'In progress'], ['done', 'Done'], ['attention', 'Needs attention'], ['archived', 'Archived']",
        "Why your score isn't higher", 'See the suggested fix', 'how to fix this', 'Edit competitors']) {
        assert.ok(tab.includes(label), `tab has ${label}`);
    }
});

console.log('\nGUI ↔ chat parity');

check('each card type in the prompt is registered and dispatches an event the chat session handles', () => {
    const pairs: Array<[string, string]> = [
        ['site_audit_check', 'siteaudit:check'], ['site_audit_settings', 'siteaudit:save'], ['site_audit_fix_update', 'siteaudit:fix'],
        ['site_audit_handoff', 'siteaudit:handoff'],
    ];
    for (const [type, evt] of pairs) {
        assert.ok(chat.includes(`"type": "${type}"`), `prompt shows ${type}`);
        assert.ok(cards.includes(`register('${type}'`), `registered ${type}`);
        assert.ok(cards.includes(`new CustomEvent('${evt}'`), `${type} dispatches ${evt}`);
        assert.ok(session.includes(`container.addEventListener('${evt}'`), `chat session listens for ${evt}`);
        assert.ok(session.includes(`container.removeEventListener('${evt}'`), `and unbinds ${evt}`);
    }
});

check('chat handlers call the same actions as the tab, and tell the tab to reload', () => {
    for (const action of ["action: 'run'", "action: 'save'", "action: 'fix'"]) {
        assert.ok(session.includes(action), `chat: ${action}`);
        assert.ok(tab.includes(action), `tab: ${action}`);
    }
    assert.match(session, /new CustomEvent\('siteaudit:changed'/);
    assert.match(tab, /document\.addEventListener\('siteaudit:changed'/);
});

check('both surfaces can say "I\'ve made this change" — and only a fix no check confirmed can be undone', () => {
    assert.match(tab, /data-status="done" class="btn-primary[^"]*">I've made this change</);
    assert.match(cards, /const WORDS = \{ accepted: "I'll make this change", dismissed: 'Reject', open: 'Undecided again', done: "I've made this change" \};/);
    assert.ok(chat.includes('"accepted" | "dismissed" | "open" | "done"'), 'the prompt offers done');
    assert.match(tab, /const confirmed = live && f\.verifiedRunId != null;/);
    assert.match(tab, /\$\{confirmed \? '' : live/, 'no undo on a confirmed fix');
});

check('a hand-off only ever TYPES the brief into the other chat — it never sends', () => {
    assert.match(tab, /window\.openAssistantChat\(\{ assistantId: who\.id, draft \}\)/);
    assert.match(session, /window\.openAssistantChat\(\{ assistantId: who\.id, draft \}\)/);
    assert.ok(!/sendMessage\(/.test(tab));
});

console.log('\nBriefs and History');

check('a Brief click is recorded on BOTH surfaces through the one server action', () => {
    const api = read('netlify/functions/site-audits.ts');
    assert.match(api, /if \(action === 'brief'\)/);
    assert.match(api, /if \(action === 'unbrief'\)/);
    assert.match(tab, /post\(\{ action: 'brief', assistantId: state\.assistantId, \.\.\.what \}\)/);
    assert.match(tab, /briefAndOpen\(who, ideaDraft\(h\), \{ source: 'idea', runId, handoffIndex: i \}\)/);
    assert.match(tab, /briefAndOpen\(who, stalledFixBrief\(f\.afterText\), \{ source: 'stalled_fix', fixId: f\.id \}\)/);
    assert.match(session, /siteAuditPost\(\{ action: 'brief', assistantId, source: 'chat'/);
    assert.match(cards, /target, brief, title,/);
});

check('a briefed idea leaves the Ideas card and the chat snapshot', () => {
    assert.match(tab, /filter\(\(\[, i\]\) => !ideaBrief\(latest\.id, i\)\)/);
    assert.match(read('src/utils/site-audit-snapshot.ts'), /not yet briefed/);
});

check('the tab types exactly the brief the server records for a stalled fix', () => {
    const at = tab.indexOf('const stalledFixBrief = (afterText) => `');
    assert.ok(at > -1);
    const tpl = tab.slice(tab.indexOf('`', at) + 1, tab.indexOf('`;', at));
    assert.strictEqual(tpl.replace('${afterText}', 'X'), stalledFixBrief('X'));
});

// History was split into the sub-tabs it belongs to (2026-10-21): briefs In progress then Done, live
// fixes Done, dismissed fixes and unactioned ideas Archived.
check('what happened to each suggestion is on the tab, named to the chat, and degrades without its table', () => {
    const b = tab.slice(tab.indexOf('function buckets()'), tab.indexOf('function counts('));
    assert.match(b, /progress: \{[\s\S]*briefs: briefs\(\)\.filter\(\(b\) => !settled\(b\)\)/, 'recent briefs are In progress');
    assert.match(b, /done: \[[\s\S]*f\.status === 'done'[\s\S]*briefs\(\)\.filter\(settled\)/, 'live fixes and older briefs are Done');
    assert.match(b, /archived: \[[\s\S]*f\.status === 'dismissed'[\s\S]*\.\.\.pastIdeas/, 'dismissed fixes and old ideas are Archived');
    assert.match(b, /attention: \{[\s\S]*stalled\.has\(f\.id\)[\s\S]*newest\.status === 'failed'[\s\S]*competitorsUnread/, 'stalled fixes, failed checks, unread competitors need attention');
    assert.ok(tab.includes('Undo — not briefed after all') && tab.includes('Bring back'));
    const at = chat.indexOf('function mysteryShopperSurfaces()');
    assert.ok(chat.slice(at, chat.indexOf('\n}', at)).includes('"In progress"'));
    assert.match(read('netlify/functions/site-audits.ts'), /briefsAvailable = false/);
    const sql = read('db/z-mystery-shopper-briefs.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS site_audit_briefs/);
    assert.match(sql, /site_audit_briefs_idea_uq ON site_audit_briefs \(run_id, handoff_index\) WHERE source = 'idea'/);
    assert.match(read('db/schema.ts'), /export const siteAuditBriefs = pgTable\("site_audit_briefs"/);
});

check('handlers are bound to document once, not from render', () => {
    const renderFn = tab.slice(tab.indexOf('function render()'), tab.indexOf('function rerender()'));
    assert.ok(!/addEventListener/.test(renderFn));
});

check('the check button states the task cost on both surfaces', () => {
    assert.match(tab, /A check that re-scores uses 1 task/);
    assert.match(cards, /A check that re-scores uses 1 task/);
});

console.log('\nSet-up ↔ audit');

check('the set-up schema uses exactly the SETUP_KEYS, and its goal options are CONVERSION_GOALS', () => {
    const at = schemas.indexOf(`    ${ROLE}: [`);
    const block = schemas.slice(at, schemas.indexOf('\n    brand_designer: [', at));
    const keys = [...block.matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(keys, Object.values(SETUP_KEYS).sort());
    for (const g of CONVERSION_GOALS) assert.ok(block.includes(`{ value: '${g.value}', label: '${g.label}' }`), g.value);
    assert.strictEqual((block.match(/operational: true/g) || []).length, 1, 'exactly one operational step');
});

check('saving set-up syncs the audit, for this role only', () => {
    const src = read('netlify/functions/update-assistant-context.ts');
    assert.match(src, /target\.roleKey === MYSTERY_SHOPPER_ROLE_KEY\)[\s\S]{0,200}syncSiteAuditFromSetup\(db,/);
});

const current: SiteAuditSettings = {
    url: 'https://mine.example/', icp: 'Agency owners', conversionGoal: 'Book a call or consultation',
    competitorUrls: ['https://rival.example/'], checkWeekday: 3,
};

check('a partial change keeps everything it did not mention', () => {
    const v = validateSettings({ competitorUrls: ['other.example'] }, current);
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.deepStrictEqual(v.settings, { ...current, competitorUrls: ['https://other.example/'] });
});

check('competitors: max 3, never the site itself, de-duplicated, one-per-line text accepted', () => {
    assert.strictEqual(validateSettings({ competitorUrls: ['a.example', 'b.example', 'c.example', 'd.example'] }, current).ok, false);
    assert.strictEqual(validateSettings({ competitorUrls: ['www.mine.example'] }, current).ok, false);
    const v = validateSettings({ competitorUrls: 'a.example\nwww.a.example\n\nb.example' }, current);
    assert.ok(v.ok && v.settings.competitorUrls.length === 2);
});

check('moving the site onto a saved competitor drops that competitor', () => {
    const v = validateSettings({ url: 'rival.example' }, current);
    assert.ok(v.ok && v.settings.competitorUrls.length === 0);
});

check('no site anywhere is an error, in words', () => {
    const v = validateSettings({ icp: 'x' }, null);
    assert.ok(!v.ok && /website address/.test(v.error));
});

check('conversion goal: radio value ↔ label round-trips through the set-up answers', () => {
    const v = validateSettings(rawFromSetup({ ...setupAnswersFor(current) }), null);
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.deepStrictEqual(v.settings, current);
    assert.strictEqual(setupAnswersFor(current)[SETUP_KEYS.conversionGoal], 'book_call');
});

console.log(`\n${passed}/${total} passed`);
