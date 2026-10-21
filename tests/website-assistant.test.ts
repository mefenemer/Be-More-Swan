// tests/website-assistant.test.ts
// The Website Assistant, step 2 (docs/website-assistant-plan.md): the starter site and the AI draft
// (src/utils/site-draft.ts), and its wiring as a hired role — registries, the Website tab, the chat
// cards, the API's guards and the preview's lock-down.
//
// Run:  npx tsx tests/website-assistant.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDraftPrompt, placeholdersIn, siteFromDraftReply, starterSite, themeFromBrandKit, type BusinessFacts } from '../src/utils/site-draft';
import { normaliseSiteDefinition, DEFAULT_THEME } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { SITE_SETUP_KEYS } from '../src/utils/site-store';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';
import { RULE_READING_ROLES } from '../src/utils/assistant-rules-prompt';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';
import { WEBSITE_ASSISTANT_ROLE_KEY } from '../src/constants/roles';
import { SPECIAL_CATEGORY_RULE } from '../src/constants/special-category-rule';
import { contrastRatio } from '../src/utils/brand-kit';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const ROLE = WEBSITE_ASSISTANT_ROLE_KEY;
const ctx = { origin: 'https://x.example', preview: true, reportUrl: '#', creditUrl: null };

const business: BusinessFacts = { name: 'Willowbrook Coffee', industry: 'Food & drink', description: 'Fresh-roasted coffee for independent cafés in Yorkshire.', audience: 'Café owners', websiteUrl: null, email: 'hello@willowbrook.example' };

console.log('\nThe starter and the draft');

check('a new hire starts with a home and a contact page, written only from the profile', () => {
    const d = starterSite(business, DEFAULT_THEME);
    assert.deepStrictEqual(d.pages.map((p) => p.slug), ['', 'contact']);
    assert.strictEqual(renderSitePage(d, '/', ctx).status, 200);
    assert.match(JSON.stringify(d), /hello@willowbrook\.example/);
    assert.deepStrictEqual(placeholdersIn(d), [], 'nothing to fill in when the profile has the facts');
    const bare = starterSite({ ...business, description: null, email: null }, DEFAULT_THEME);
    assert.ok(placeholdersIn(bare).length >= 2, 'missing facts become [placeholders], never inventions');
});

check('placeholders are found wherever they are, with their page', () => {
    const d = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'testimonials', props: { items: [{ quote: "[A customer's words]", name: '[Customer name]' }] } },
        { type: 'text', props: { body: 'Supplying [number] cafés since [year].' } }] }] }).definition;
    assert.deepStrictEqual(placeholdersIn(d).map((p) => p.text), ["[A customer's words]", '[Customer name]', '[number]', '[year]']);
    assert.ok(placeholdersIn(d).every((p) => p.pageTitle === 'Home'));
});

check('the brand kit becomes the theme; an unreadable one falls back to readable defaults', () => {
    const t = themeFromBrandKit({ primaryColor: '#2D6A4F', textColor: '#1F2937', backgroundColor: '#FFFFFF', logoUrl: 'https://cdn.example/logo.png' });
    assert.strictEqual(t.primaryColor, '#2d6a4f');
    assert.strictEqual(t.logoUrl, 'https://cdn.example/logo.png');
    const bad = themeFromBrandKit({ textColor: '#fafafa', backgroundColor: '#ffffff', logoUrl: 'http://x.example/l.png' });
    assert.ok(contrastRatio(bad.textColor, bad.backgroundColor) >= 4.5);
    assert.strictEqual(bad.logoUrl, null);
});

check('the draft prompt forbids invented facts, sets the page cap and carries the house rules', () => {
    const p = buildDraftPrompt({ business, productsBlock: '<products>Espresso blend £12/kg</products>', rulesBlock: '<rules_block>Never say "best"</rules_block>',
        goal: 'Ask for a quote', pagesWanted: 'Home, Wholesale, Contact', style: 'Friendly', request: 'Mention free delivery', maxPages: 5 });
    assert.match(p.user, /NEVER invent facts/);
    assert.match(p.user, /placeholder in square brackets/);
    assert.match(p.user, /at most 5 pages/);
    assert.match(p.user, /Espresso blend £12\/kg/);
    assert.match(p.user, /Never say "best"[\s\S]*follow these rules/);
    assert.match(p.user, /What a visitor should do: Ask for a quote/);
    assert.match(p.user, /Mention free delivery/);
    assert.ok(p.system.includes(SPECIAL_CATEGORY_RULE.trim().slice(0, 40)));
    assert.match(p.system, /never write HTML/);
});

check('a draft reply goes through the gate: our theme, footer, email and phone kept; the cap holds', () => {
    const current = normaliseSiteDefinition({ theme: { primaryColor: '#2d6a4f' }, settings: { siteName: 'Willowbrook Coffee', email: 'hello@willowbrook.example', phone: '0113 496 0000' }, footer: { text: 'Ltd' } }).definition;
    const reply = {
        settings: { siteName: 'Willowbrook', email: 'attacker@evil.example', phone: '000', businessType: 'Spaceship' },
        pages: Array.from({ length: 8 }, (_, i) => ({ title: i ? `Page ${i}` : 'Home', slug: i ? `p${i}` : '', sections: [{ type: 'text', props: { body: `Body ${i}` } }, { type: 'script', props: {} }] })),
    };
    const r = siteFromDraftReply(reply, current, 5)!;
    assert.strictEqual(r.definition.pages.length, 5);
    assert.strictEqual(r.definition.theme.primaryColor, '#2d6a4f', 'theme is ours, not the model\'s');
    assert.strictEqual(r.definition.settings.email, 'hello@willowbrook.example', 'contact details are facts the model may not change');
    assert.strictEqual(r.definition.settings.phone, '0113 496 0000');
    assert.strictEqual(r.definition.settings.businessType, 'Organization');
    assert.strictEqual(r.definition.footer.text, 'Ltd');
    assert.ok(r.definition.pages.every((p) => p.sections.every((s) => s.type === 'text')), 'unknown sections never survive');
});

check('a reply with nothing usable keeps the current draft (null)', () => {
    const current = normaliseSiteDefinition({}).definition;
    for (const junk of [null, 'nope', {}, { pages: [] }, { pages: [{ title: 'Home', sections: [{ type: 'nope' }] }] }]) {
        assert.strictEqual(siteFromDraftReply(junk, current, 5), null, JSON.stringify(junk));
    }
});

console.log('\nRegistries');

check('role key, catalogue row (HIDDEN), seed entry', () => {
    assert.strictEqual(ROLE, 'website_assistant');
    assert.ok(read('db/seed-catalog.ts').includes(`roleKey: '${ROLE}'`));
    const sql = read('db/z-website-assistant.sql');
    assert.match(sql, /'website_assistant',[\s\S]*?'\["standalone", "mystery_shopper"\]'::jsonb,\s*false,\s*false\s*\)/);
    assert.match(sql, /ON CONFLICT \(role_key\) DO NOTHING/);
});

check('pages per plan: a plan feature, 5 on £29, never overwriting an admin\'s number, hidden from pricing until go-live', () => {
    const sql = read('db/z-website-assistant.sql');
    assert.match(sql, /'website_pages'/);
    assert.match(sql, /'\{"website_pages": 5\}'::jsonb\s*\n\s*WHERE tier_key = 'saver' AND NOT \(COALESCE\(features, '\{\}'::jsonb\) \? 'website_pages'\)/);
    assert.match(sql, /'Capacity', 'number', 'feature', 'Unlimited', 'Custom',[\s\S]*?false\s*\)\s*ON CONFLICT \(key\) DO NOTHING/);
    assert.match(read('src/utils/site-store.ts'), /getActiveFeaturesByOrg\(db, orgId\)\)\.website_pages/);
});

check('connections (explicit empty), build manifest, rules, labels, copy', () => {
    assert.deepStrictEqual(ROLE_CONNECTIONS[ROLE], []);
    assert.deepStrictEqual(ASSISTANT_BUILD[ROLE], { setup: 'schema', chat: true, dashboard: true });
    assert.ok(RULE_READING_ROLES.has(ROLE));
    for (const f of ['src/public/role-labels.js', 'src/components/team-feed.js', 'src/components/assistant-welcome-messages.js',
        'src/components/assistant-starter-prompts.js', 'src/public/mandate-suggestions.js']) assert.ok(read(f).includes(`${ROLE}:`), f);
});

check('set-up asks only what the draft reads, with exactly one operational step', () => {
    const schemas = read('src/public/assistant-onboarding-schemas.js');
    const at = schemas.indexOf(`    ${ROLE}: [`);
    const block = schemas.slice(at, schemas.indexOf('\n    // Mystery Shopper', at));
    const keys = [...block.matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(keys, Object.values(SITE_SETUP_KEYS).sort());
    assert.strictEqual((block.match(/operational: true/g) || []).length, 1);
});

check('the notification is registered in all five places, category explicit at the call site', () => {
    const type = 'site_draft_ready';
    assert.ok(read('src/utils/notification-prefs.ts').includes(`'${type}'`));
    assert.ok(read('src/utils/notification-actions.ts').includes(`${type}: 'state_change'`));
    assert.ok(read('src/utils/notification-templates-catalog.ts').includes(`templateKey: '${type}'`));
    assert.ok(read('db/notifications-categorization.sql').includes(`WHEN '${type}' THEN 'state_change'`));
    assert.match(read('src/utils/site-store.ts'), /createNotification\(db, 'site_draft_ready', \{[\s\S]{0,200}category: 'state_change'/);
});

console.log('\nThe Website tab and chat');

const registry = read('src/components/assistant-dashboard-registry.js');
const editor = read('src/components/assistant-site-editor.js');
const chat = read('netlify/functions/chat-orchestrator.ts');
const cards = read('src/components/disruptive-ui-registry.js');
const session = read('src/components/chat-session.js');
const assistants = read('assistants.js');

check('dashboard entry: own tab and metrics, no social modules, no queue, Data Hub or goals', () => {
    const at = registry.indexOf(`    ${ROLE}: {`);
    const entry = registry.slice(at, registry.indexOf('\n    // Mystery Shopper', at));
    for (const re of [/metricsSource: 'site'/, /siteEditorTab: \{\s*label: 'Website',/, /hideReviewQueue: true/, /hideDataHub: true/, /hideGoals: true/, /hasPostingSchedule: false/, /defaultMainTab: 'sitebuilder'/, /rulesScope: 'site'/]) {
        assert.match(entry, re);
    }
});

check('the page has the tab, its panel and the script; every branch routes to them', () => {
    assert.match(read('assistant-detail.html'), /id="maintab-btn-sitebuilder" data-maintab="sitebuilder"/);
    assert.match(read('assistant-detail.html'), /<div id="maintab-sitebuilder" class="main-tab-content hidden">\s*<div id="site-editor-host" data-site-host="website"><\/div>/);
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-site-editor\.js"><\/script>/);
    assert.match(assistants, /toggle\('maintab-btn-sitebuilder', !!siteEditorTab\)/);
    assert.match(assistants, /if \(name === 'sitebuilder'\) window\.AssistantSiteEditor\?\.activate\('website'\);/);
    assert.match(assistants, /if \(source === 'site'\)[\s\S]{0,100}_loadSiteMetrics\(assistantId\)/);
    assert.match(assistants, /_detailRulesScope === 'site'/);
});

check('every name the chat quotes is on the Website tab', () => {
    const at = chat.indexOf('function websiteAssistantSurfaces()');
    const surfaces = chat.slice(at, chat.indexOf('\n}', at));
    for (const n of ['"Website" tab', '"Pages"', '"Design"', '"Details"', '"Edit"', '"↑"', '"↓"', '"Remove"', '"Add a section"', '"+ Page"', '"Preview"', '"Desktop"', '"Phone"', '"Templates"', '"Add your own words"', '"Start again from scratch"', '"Replace my draft"', '"Import my current site"', '"Write my site"', '"Write the words"', '"Publish"', '"Publish changes"', '"View live site"', '"Take offline"']) {
        assert.ok(surfaces.includes(n), `surfaces: ${n}`);
        assert.ok(editor.includes(n.replace(/^"|"( tab)?$/g, '')), `editor: ${n}`);
    }
});

check('chat cards are registered, dispatch events the session handles, and call the tab\'s own actions', () => {
    for (const [type, evt] of [['site_changes', 'site:apply'], ['site_draft_request', 'site:draft']]) {
        assert.ok(chat.includes(`"type": "${type}"`), type);
        assert.ok(cards.includes(`register('${type}'`), type);
        assert.ok(cards.includes(`new CustomEvent('${evt}'`), evt);
        assert.ok(session.includes(`container.addEventListener('${evt}'`) && session.includes(`container.removeEventListener('${evt}'`), evt);
    }
    for (const a of ["action: 'apply'", "action: 'draft'"]) assert.ok(session.includes(a) && editor.includes(a), a);
    assert.match(session, /new CustomEvent\('site:changed'/);
    assert.match(editor, /document\.addEventListener\('site:changed'/);
});

check('the chat is told publishing exists, and the welcome names a real button', () => {
    const at = chat.indexOf('function websiteAssistantSurfaces()');
    const surfaces = chat.slice(at, chat.indexOf('\n}', at));
    assert.ok(!/coming soon/i.test(surfaces), 'surfaces must not say publishing is coming soon');
    const welcome = read('src/components/assistant-welcome-messages.js');
    assert.ok(!welcome.includes('Draft my whole site'));
    assert.ok(welcome.includes('“Write my site”') && editor.includes("'Write my site'"));
});

check('a draft with no tasks left is refused before it starts, with a way to more', () => {
    const api = read('netlify/functions/sites.ts');
    const draft = api.slice(api.indexOf("if (action === 'draft')"), api.indexOf("if (action === 'import')"));
    assert.ok(draft.indexOf('hasTaskCapacity(db, orgId)') > -1 && draft.indexOf('hasTaskCapacity(db, orgId)') < draft.indexOf('claimDraft('));
    assert.match(draft, /json\(402, \{ error: TASK_LIMIT_MESSAGE/);
    assert.match(editor, /billing: err\.status === 402/);
    assert.match(editor, /data-site-billing/);
});

check('the section form: asks before losing changes, opens in view, one save at a time', () => {
    for (const marker of ["if (t('[data-site-edit-cancel]')) {", 'if (want !== state.panel && !(await leaveEditor())) return;', "if (pg.dataset.sitePage !== p.id && !(await leaveEditor())) return;"]) {
        const at = editor.indexOf(marker);
        assert.ok(at > -1, marker);
        assert.ok(editor.slice(at, at + 200).includes('leaveEditor()'), marker);
    }
    assert.match(editor, /title: 'Leave without saving\?'/);
    assert.match(editor, /state\.focusEditor = true;/);
    assert.match(editor, /form\.scrollIntoView\(/);
    const apply = editor.slice(editor.indexOf('async function apply('), editor.indexOf('function markBusy('));
    assert.match(apply, /if \(state\.busy\) return;/);
    assert.match(apply, /markBusy\(\)/);
    assert.match(editor, /setAttribute\('aria-busy', 'true'\)/);
    assert.match(editor, /data-site-beside[^>]*><span aria-hidden="true">/);
});

check('UX quick wins: placeholders go to where they are, plan limit and load failure have a next step', () => {
    assert.match(editor, /btn\(`data-site-fix="\$\{i\}"`/);
    const fix = editor.slice(editor.indexOf("const fix = t('[data-site-fix]');"), editor.indexOf("const fix = t('[data-site-fix]');") + 1400);
    assert.match(fix, /leaveEditor\(\)/);
    assert.match(fix, /state\.focusEditor = true/);
    assert.match(editor, /pages on your plan — the most it includes\.<\/span> \$\{btn\('data-site-billing', 'See plans'\)\}/);
    assert.match(editor, /btn\('data-site-retry', 'Try again', true\)/);
    assert.match(editor, /show\('maintab-btn-calendar', featureOn\('bookings'\)\)/);
    assert.match(editor, /if \(s\.credit\)|s\.credit \?/);
    assert.match(editor, /Made with Be More Swan/);
    assert.match(editor, /'min\(390px, 100%\)'/);
});

check('the chat never publishes (step 3a: a click on the Website tab), and nothing spends without saying so', () => {
    assert.ok(!/action: 'publish'/.test(read('src/components/chat-session.js')));
    assert.match(chat, /You cannot publish, take the site offline or choose its address/);
    assert.match(editor, /uses 1 task/);
    assert.match(cards, /Uses 1 task from your monthly allowance/);
});

check('the editor uses the house dialogs and binds handlers once', () => {
    assert.ok(!/window\.prompt\(|[^.]alert\(|[^a-z]confirm\(/.test(editor.replace(/confirmModal|promptModal|alertModal/g, '')));
    const renderFn = editor.slice(editor.indexOf('function render()'), editor.indexOf('function rerender()'));
    assert.ok(!/addEventListener/.test(renderFn));
});

console.log('\nServer guards');

check('the API is tenant-scoped and role-guarded, and caps a batch', () => {
    const api = read('netlify/functions/sites.ts');
    assert.match(api, /requireTenant\(event, db\)/);
    assert.match(api, /'type'\) = \$\{WEBSITE_ASSISTANT_ROLE_KEY\}/);
    assert.match(api, /if \(ops\.length > MAX_OPS\)/);
    assert.match(api, /enforcePromptModeration\(\{ text: request/);
});

check('the preview is signed-in only, never indexed, and forbids scripts', () => {
    const pv = read('netlify/functions/site-preview.ts');
    assert.match(pv, /requireTenant\(event, db\)/);
    assert.match(pv, /CSP = "default-src 'none';/);
    assert.ok(!/script-src/.test(pv), 'no script source is ever allowed');
    assert.match(pv, /frame-ancestors 'self'/);
    assert.match(pv, /'X-Robots-Tag': 'noindex, nofollow'/);
    assert.match(pv, /preview: true/);
});

check('the draft worker fails CLOSED and charges only after the draft is saved', () => {
    assert.match(read('netlify/functions/draft-site-background.ts'), /if \(!secret\)[\s\S]{0,200}statusCode: 503/);
    const store = read('src/utils/site-store.ts');
    assert.ok(store.indexOf('if (!saved) return;') < store.indexOf("recordCompletedWork(db, site.organisationId, 'site_draft'"));
    assert.ok(store.indexOf('hasTaskCapacity(db, site.organisationId)') < store.indexOf('gatewayGenerate('));
});

console.log(`\n${passed}/${total} passed`);
