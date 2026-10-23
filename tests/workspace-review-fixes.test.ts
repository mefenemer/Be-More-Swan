// tests/workspace-review-fixes.test.ts
// Small fixes from the 2026-10-22 UI/UX review of Dashboard, My Assistants and Audience: a dead
// "Set rate" link, a hire button missing on phones, a Dashboard poll that outlived the page,
// unescaped assistant names on the card, and an Audience list held behind three requests.
//
// Run:  npx tsx tests/workspace-review-fixes.test.ts

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
const cards = read('assistants.js');
const dir = read('assistants-directory.html');
const dash = read('dashboard-content.html');
const aud = read('audience.js');

check('"Set rate → ROI" goes to a route that exists', () => {
    assert.ok(!cards.includes("loadView('account')"), 'there is no `account` route; loadView ignores it');
    assert.ok(/loadView\('settings'\)" title="Set your hourly rate to see financial ROI">Set rate → ROI<\/button>/.test(cards));
});

check('the card escapes the assistant name and role, and the chat button reads them from data attributes', () => {
    assert.ok(cards.includes("${_escapeHtml(assistant.name || '')}</h3>"));
    assert.ok(cards.includes('${_escapeHtml(role)}</p>'));
    assert.ok(cards.includes('data-chat-name="${_escapeHtml(assistant.name'), 'name travels as an attribute');
    assert.ok(!cards.includes("(assistant.name || 'Your assistant').replace(/'/g, '&#39;')"), '&#39; decodes back to \' before the JS runs');
});

check('keyboard users can open an assistant and follow Dashboard widget links', () => {
    assert.ok(/<button type="button" class="link text-sm font-bold"[^>]*>View Details &rarr;<\/button>/.test(cards));
    assert.ok(!dash.includes('<span class="dw-link">'), 'widget links are buttons, not spans');
    assert.ok(dash.includes('<button type="button" class="dw-link">Manage assistants →</button>'));
});

check('"Hire New Assistant" shows at phone width', () => {
    const btn = dir.slice(dir.indexOf('<button id="route-to-catalog-from-dir"'));
    assert.ok(btn.length > 0, 'button marker missing');
    const cls = (btn.match(/class="([^"]*)"/) || [])[1] || '';
    assert.ok(!/(^|\s)hidden(\s|$)/.test(cls), 'no `hidden` at the smallest width');
});

check('the Dashboard notifications poll stops when the Dashboard leaves the page', () => {
    assert.ok(dash.includes('clearInterval(window._dashNotificationsPoll);\n    window._dashNotificationsPoll = setInterval('));
    assert.ok(dash.includes('if (!grid.isConnected) { clearInterval(window._dashNotificationsPoll); return; }'));
});

check('Audience loads segments and API keys alongside the list, not ahead of it', () => {
    const i = aud.indexOf('const sidebar = Promise.all([loadSegments(), loadApiKeys()]);');
    assert.ok(i > 0, 'sidebar loads start together');
    const fields = aud.indexOf('await loadCustomFields();', i);
    const contacts = aud.indexOf('await loadContacts();', i);
    assert.ok(fields > i && contacts > fields, 'custom fields (the columns) still come before the rows');
    assert.ok(!aud.includes('await loadApiKeys();\n    await loadSegments();'));
});

check('every Audience overlay is a dialogs.js page dialog, with a close control Escape can press', () => {
    const html = read('audience.html');
    // Each overlay's markup runs from its own opening tag to the next overlay's.
    const starts = [...html.matchAll(/<div id="(aud-[a-z-]+)" data-dialog/g)];
    assert.deepStrictEqual(starts.map((m) => m[1]).sort(),
        ['aud-add-modal', 'aud-detail', 'aud-export-modal', 'aud-import-modal', 'aud-rule-modal']);
    starts.forEach((m, k) => {
        const body = html.slice(m.index, starts[k + 1]?.index);
        assert.ok(body.includes('data-dialog-cancel'), `${m[1]} has a data-dialog-cancel control`);
    });
    assert.ok(html.includes('<div id="aud-detail" data-dialog aria-labelledby="aud-detail-title"'), 'the slide-over has no heading; name it from its title');
    const icons = html.match(/<button type="button" data-aud-(?:rule-)?close data-dialog-cancel[^>]*>/g) || [];
    assert.strictEqual(icons.length, 2, 'both × buttons found');
    for (const b of icons) assert.ok(b.includes('aria-label="Close"'), b);
});

check('the Add-contact, import and segment-builder fields have real labels', () => {
    const html = read('audience.html');
    for (const id of ['aud-add-email', 'aud-add-first', 'aud-add-last', 'aud-add-company', 'aud-add-segment', 'aud-import-file', 'aud-import-segment']) {
        assert.ok(html.includes(`<label for="${id}"`), `${id} has a <label for>`);
    }
    assert.ok(aud.includes('<label for="aud-rule-name"') && aud.includes('<label for="aud-rule-match"'));
    for (const attr of ['data-rule-field', 'data-rule-op', 'data-rule-key']) {
        assert.ok(new RegExp(`<select ${attr}="\\$\\{i\\}" aria-label="Condition`).test(aud), `${attr} is named`);
    }
    const values = aud.match(/data-rule-value="\$\{i\}"[^>]*>/g) || [];
    assert.ok(values.length >= 6, 'every value control found');
    for (const v of values) assert.ok(v.includes('aria-label="Condition'), v);
});

check('no customer sees a developer message, and both page loads offer Try again', () => {
    assert.ok(!aud.includes('apply <span class="font-mono text-xs bg-gray-100 px-1 rounded">db/audience.sql'), 'migration hint is developer copy');
    assert.ok(aud.includes("Audience isn't available yet"));
    assert.ok(aud.includes('data-aud-retry') && aud.includes("querySelector('[data-aud-retry]')?.addEventListener('click', () => loadContacts())"));
    assert.ok(!cards.includes('Could not connect to the database'));
    assert.ok(cards.includes("querySelector('[data-team-retry]')?.addEventListener('click', () => window.fetchAndRenderAssistants(containerId, options))"));
});

check('one hire wording, the referral widget sells what we sell, and the back button names its page', () => {
    for (const old of ['Hire New Assistant', 'Add New Assistant</span>', 'Delegate a New Task']) {
        assert.ok(!dir.includes(old) && !dash.includes(old) && !cards.includes(old), old);
    }
    assert.ok(dir.includes('Hire an assistant') && dash.includes('Hire an assistant</a>') && cards.includes('${plus}Hire an assistant</span>'));
    assert.ok(!dash.includes("title: 'Invite a teammate'") && !dash.includes('Invite a teammate —'), 'team seats are not sold yet');
    assert.ok(dash.includes("title: 'Refer a business'"));
    assert.ok(!read('assistant-detail.html').includes('Back to Team'), 'clashes with Team Chat');
});

check('the three pages use brand pink, not the emerald shades that still render green or indigo', () => {
    const pages = { 'audience.html': read('audience.html'), 'audience.js': aud, 'dashboard-content.html': dash, 'assistants-directory.html': dir };
    for (const [f, text] of Object.entries(pages)) {
        assert.ok(!/emerald-(?:300|400|500|600|900)\b/.test(text), `${f}: emerald 300–600/900 render green`);
        assert.ok(!/#4f46e5|#4338ca|#059669|#10b981|#34d399|#047857|#ecfdf5/i.test(text), `${f}: off-palette hex`);
    }
    const card = cards.slice(cards.indexOf('window.generateAssistantCardHTML = function'), cards.indexOf('window.fetchAndRenderAssistants = async function'));
    assert.ok(card.length > 1000, 'card renderer slice found');
    assert.ok(!/emerald-(?:300|400|500|600|900)\b/.test(card), 'card: emerald 300–600/900 render green');
    assert.ok(dash.includes('class="as-btn as-btn-yes btn-primary">Yes, please'));
});

check('every Cancel on Audience is a .btn-secondary', () => {
    const cancels = (read('audience.html') + aud).match(/<button[^>]*>Cancel<\/button>/g) || [];
    assert.ok(cancels.length >= 5, 'found the Cancel buttons');
    for (const b of cancels) assert.ok(b.includes('btn-secondary'), b);
});

check('Dashboard: the value hero, then the team as a one-line roster, not full cards at the bottom', () => {
    const ny = dash.indexOf('<section id="needs-you"');
    const team = dash.indexOf('<section id="dash-team"');
    const hero = dash.indexOf('<section id="command-center-hero"');
    // Owner 2026-10-23: the value the team created comes first, the roster under it.
    assert.ok(ny > 0 && hero > ny && team > hero, 'Needs you → value hero → Your team');
    assert.ok(dash.includes('<div id="dashboard-assistants-grid" data-render="roster"'), 'roster mode is on the container, so id-only re-renders keep it');
    assert.strictEqual(dash.split('id="dashboard-assistants-grid"').length, 2, 'one team grid only');
    assert.ok(cards.includes("if (opts.roster || container.dataset.render === 'roster') {"));
    const roster = cards.slice(cards.indexOf('window.generateTeamRosterHTML = function'), cards.indexOf('window.generateFirstHireCardHTML = function'));
    assert.ok(roster.includes('_escapeHtml(a.name') && roster.includes('_escapeHtml(a.role'), 'roster escapes names');
    assert.ok(roster.includes('window._assistantIdentity(a)'), 'same icon and badge as the card');
});

check('Dashboard: a workspace with no working assistant gets one hire card instead of zeros', () => {
    assert.ok(cards.includes("classList.toggle('dash-first-visit', visible.length === 0)"));
    assert.ok(cards.includes("if (inProgress.length === 0) container.insertAdjacentHTML('beforeend', window.generateFirstHireCardHTML());"));
    for (const id of ['#command-center-hero', '#action-stream', '#dash-widgets-section', '#dash-hire-banner']) {
        assert.ok(dash.includes(`#dash-root.dash-first-visit ${id}`), `${id} hides on a first visit`);
    }
});

check('Dashboard: duplicate widgets start off, the heatmap is folded, and the period default is unchanged', () => {
    assert.ok(dash.includes("const DEFAULT_ON = { 'roi-mini': false, 'team-status': false,"));
    assert.ok(dash.includes('<details class="cc-heatmap-wrap">') && !dash.includes('<details class="cc-heatmap-wrap" open'));
    // "All time" stays until the owner re-decides: a calendar window reads as zeros at its start.
    assert.ok(dash.includes("let period = 'all';"));
});

check('Audience on a phone: list first, Manage folded, segment dropdown, Import and Export under More', () => {
    const html = read('audience.html');
    assert.ok(/@media \(max-width: 1023px\) \{\s*\.aud-side \{ order: 2; \}/.test(html), 'sidebar after the list below desktop');
    assert.ok(html.includes('.aud-side:not(.is-open) .aud-side-body { display: none; }'));
    assert.ok(html.includes('<button type="button" id="aud-side-toggle" class="aud-side-toggle" aria-expanded="false" aria-controls="aud-side-body">'));
    assert.ok(html.includes('<select id="aud-segment-pick" aria-label="Segment"'));
    assert.ok(html.includes('#aud-import-btn, #aud-export-btn { display: none !important; }'));
    assert.ok(!/@media \(max-width: 639px\)[^}]*#aud-form-btn/.test(html), 'Sign-up forms stays visible on phones');
    assert.ok(aud.includes("$('aud-segment-pick')?.addEventListener('change'"));
    assert.ok(aud.includes("if (!window._audMoreOutsideBound) {"), 'the document listener is bound once');
});

check('every Hire an assistant button takes one route, catalogue first', () => {
    const ws = read('workspace.html');
    assert.ok(cards.includes('window.openHireCatalogue = function()'));
    assert.ok(cards.includes("catalogBtn.addEventListener('click', () => window.openHireCatalogue());"), 'My Assistants header');
    assert.ok(cards.includes('onclick="window.openHireCatalogue()"'), 'placeholder cards');
    assert.ok(cards.includes('onclick="window.openHireCatalogue(); return false" class="link">Hire an assistant'), 'empty-team link');
    assert.ok(ws.includes('if (window.openHireCatalogue) window.openHireCatalogue(); else loadView(\'catalog\');'), 'Dashboard banner');
    assert.ok(ws.includes("if (where === 'catalog' && window.openHireCatalogue) window.openHireCatalogue();"), 'sidebar switcher');
    assert.ok(cards.includes('window._hasWorkingAssistants = visible.length > 0;'), 'a first hire keeps the plain catalogue route');
});

check('Audience: Import is the primary action, review Delete is destructive, small targets grow on phones', () => {
    const html = read('audience.html');
    assert.ok(html.includes('<button type="button" id="aud-import-start" class="btn-primary'));
    assert.ok(html.includes('data-rv-delete="${r.id}" class="btn-destructive'));
    assert.ok(html.includes('#aud-bulk button { min-height: 44px; }'));
    assert.ok(html.includes('.aud-x { min-width: 44px; min-height: 44px;'));
    assert.strictEqual((aud.match(/class="aud-x /g) || []).length, 3, 'field ×, segment edit, segment ×');
    assert.ok(!/text-gray-300 hover:text-red-500/.test(aud), 'the × buttons were too faint');
});

check('Dashboard widgets: kept on the page between toggles, and reorderable without dragging', () => {
    const grid = dash.slice(dash.indexOf('function renderGrid() {'), dash.indexOf('function toggle(key, on) {'));
    assert.ok(grid.length > 200, 'renderGrid found');
    assert.ok(!grid.includes("grid.innerHTML = ''"), 'no wipe-and-refetch');
    assert.ok(grid.includes('const have = new Map(') && grid.includes('if (!card) {'), 'reuses existing cards');
    assert.ok(grid.indexOf('meta.render(') > grid.indexOf('if (!card) {'), 'renders data only for a new card');
    assert.ok(dash.includes('function move(key, dir) {'));
    assert.ok(dash.includes('aria-label="Move ${esc(meta.title)} up"') && dash.includes('aria-label="Show ${esc(meta.title)}"'));
});

check('Audience bulk delete runs in parallel through the single-contact DELETE', () => {
    const fn = aud.slice(aud.indexOf('async function bulkDelete()'), aud.indexOf('// ── Growth chart'));
    assert.ok(fn.includes('const DELETE_POOL = 6;') && fn.includes('await Promise.all('));
    assert.ok(fn.includes("api(`${CONTACTS_API}?id=${id}`, { method: 'DELETE' })"), 'keeps THE DELETE RULE path');
    assert.ok(!/for \(const id of ids\) \{\s*try \{ await api/.test(fn), 'no one-after-another loop');
});

check('the public page is "Meet the Assistants", in its title, its eyebrow, the nav and the footer', () => {
    const page = read('assistants.html');
    assert.ok(page.includes('<title>Meet the Assistants | Be More Swan</title>'));
    assert.ok(!/Assistant Library/.test(page));
    const en = JSON.parse(read('locales/en.json'));
    assert.strictEqual(en.nav.assistant_library, 'Meet the Assistants');
    assert.strictEqual(en.footer.assistant_library, 'Meet the Assistants');
    for (const f of ['components/nav.html', 'components/footer.html', 'about.html', 'blog.html', 'faq.html', 'index.html']) {
        assert.ok(!read(f).includes('Assistant Library'), `${f} still says Assistant Library`);
    }
});

check('the nav and footer fragments link root-relative, so a crawled /components/… page links nowhere broken', () => {
    // Google Search Console reported /components/register.html: a relative href in a fragment that
    // is itself a public URL resolves against /components/.
    for (const f of ['components/nav.html', 'components/footer.html']) {
        const rel = read(f).match(/href="(?!\/|#|https?:|mailto:)[^"]+"/g) || [];
        assert.deepStrictEqual(rel, [], `${f} has relative links`);
    }
});

check('Mystery Shopper: "Checking your site…" clears when the check ends, in brand colours', () => {
    const sa = read('src/components/assistant-site-audit.js');
    assert.ok(sa.includes("say(data.alreadyRunning ? 'A check is already running.' : 'Checking your site…', null, true);"));
    assert.ok(sa.includes('if (state.note?.whileRunning && !inFlight()) state.note = null;'));
    assert.ok(!/indigo/.test(sa), 'indigo is not a brand colour');
});

check('the sidebar Calendar loads every assistant\'s own dated work, not only on the assistant\'s tab', () => {
    const cal = read('calendar.js');
    assert.ok(cal.includes(': _globalExtraTargets(assistants || _assistants);'));
    assert.ok(cal.includes("const datedSource = ['records', 'briefs', 'checks', 'campaigns'].includes(cfg.calendarItems)"), 'roles from the registry');
    for (const fn of ['_datedItemsOnDate', '_scheduledRecordsOnDate', '_followUpsOnDate']) {
        const body = cal.slice(cal.indexOf(`function ${fn}(`), cal.indexOf(`function ${fn}(`) + 300);
        assert.ok(body.includes('_matchesAssistantFilter('), `${fn} respects the assistant filter`);
    }
    assert.ok(cal.includes("${blocked || !_lockedAssistant ? '' : `draggable"), 'follow-ups are view-only on the shared calendar');
});

check('Audience and Orders come after Review and Calendar in the sidebar', () => {
    const ids = [...read('components/sidebar.html').matchAll(/<a [^>]*id="(nav-[a-z-]+)"/g)].map((m) => m[1]);
    const at = (id: string) => ids.indexOf(id);
    // Review above Calendar since 2026-10-23: the work runs review first, then the calendar.
    assert.ok(at('nav-assistants') < at('nav-review-queue') && at('nav-review-queue') < at('nav-calendar'));
    assert.ok(at('nav-calendar') < at('nav-audience') && at('nav-audience') < at('nav-orders'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
