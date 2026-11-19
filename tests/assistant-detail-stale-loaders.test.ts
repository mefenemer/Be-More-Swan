// tests/assistant-detail-stale-loaders.test.ts
// Follow-up to assistant-detail-stale-response.test.ts (#772). initAssistantDetail starts a dozen
// loaders after its context read — metrics, activity, connections, rules, goals, audience, the
// Review badge… Each fetches for ONE assistant and then finds its cards by id, so opening Orbit
// Scribe and switching to Felix while Orbit Scribe's loaders were in flight painted Orbit Scribe's
// numbers into Felix's cards. Each loader now takes the page's ticket (_detailTicket) and checks it
// after every await, before painting. Leaving the page for another view takes a ticket too.
// Source-scan checks. Run:  npx tsx tests/assistant-detail-stale-loaders.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const js = readFileSync(path.join(ROOT, 'assistants.js'), 'utf8');
const integ = readFileSync(path.join(ROOT, 'integrations.js'), 'utf8');
const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');

function at(hay: string, marker: string, from = 0): number {
    const i = hay.indexOf(marker, from);
    assert.ok(i !== -1, `marker not found: ${marker}`);
    assert.strictEqual(hay.indexOf(marker, i + 1), -1, `marker not unique: ${marker}`);
    return i;
}

// The body of a top-level function: from its header to the first line that is just "}" or "};".
function body(hay: string, header: string): string {
    const s = at(hay, header);
    const m = /\n\};?\n/.exec(hay.slice(s));
    assert.ok(m, `end of ${header} not found`);
    return hay.slice(s, s + m.index);
}

// After the LAST await in a loader, a stale() check must come before the first thing it paints or
// stores (innerHTML/textContent/classList/style, a _set…/_render… call, or a module global).
const WRITE = /\.innerHTML\s*=|\.textContent\s*=|\.classList\.|\.style\.|\b_set\w+\(|\b_render\w+\(|window\._\w+\?\.\(|\n\s*_[A-Za-z]\w*\s*=[^=]/g;
function guardedAfterLastAwait(src: string): string | null {
    const last = src.lastIndexOf('await ');
    if (last === -1) return 'no await';
    const lineEnd = src.indexOf('\n', last);
    const guard = src.indexOf('stale()', lineEnd);
    WRITE.lastIndex = lineEnd;
    const w = WRITE.exec(src);
    if (guard === -1) return 'no stale() after the last await';
    if (w && w.index < guard) return `writes before the check: ${src.slice(w.index, w.index + 60).trim()}`;
    return null;
}

console.log('\nthe ticket');

check('_detailTicket reads the same counter initAssistantDetail bumps', () => {
    const t = body(js, 'function _detailTicket() {');
    assert.ok(t.includes('const t = _detailInitSeq;'), 'captures the counter');
    assert.ok(t.includes('return () => t !== _detailInitSeq;'), 'returns a stale() check');
    assert.ok(js.includes('window._detailTicket = _detailTicket;'), 'shared with integrations.js');
    assert.ok(at(js, 'let _detailInitSeq = 0;') < at(js, 'function _detailTicket() {'), 'declared after the counter');
});

check('leaving the assistant page for another view bumps the ticket', () => {
    assert.ok(js.includes('window._leaveAssistantDetail = () => { _detailInitSeq++; };'), 'assistants.js exposes it');
    const i = at(ws, "if (routeKey !== 'assistant-detail') {\n          window._currentAssistantId = null;");
    const block = ws.slice(i, i + 400);
    assert.ok(block.includes('window._leaveAssistantDetail?.();'), 'loadView calls it when leaving');
    assert.ok(i < at(ws, 'contentContainer.innerHTML = viewHtml;'), 'before the next view is swapped in');
});

console.log('\neach loader checks its ticket before painting');

const LOADERS: Array<[string, string]> = [
    ['_prefetchDetailRqBadge', 'async function _prefetchDetailRqBadge(assistantId) {'],
    ['_fetchAndRenderLeadRoi', "async function _fetchAndRenderLeadRoi(assistantId, period = 'all') {"],
    ['_fetchAndRenderWrittenRoi', "async function _fetchAndRenderWrittenRoi(assistantId, period = 'all') {"],
    ['_renderAssistantTaskShare', 'async function _renderAssistantTaskShare(assistantId, opts = {}) {'],
    ['_fetchAndRenderAssistantMetrics', "async function _fetchAndRenderAssistantMetrics(assistantId, period = 'all') {"],
    ['_fetchAndRenderBlogDestinations', 'async function _fetchAndRenderBlogDestinations() {'],
    ['_fetchAndRenderNewsletterList', 'async function _fetchAndRenderNewsletterList() {'],
    ['_fetchAndRenderFollowerCounts', 'async function _fetchAndRenderFollowerCounts() {'],
    ['_loadAssistantMetrics', 'async function _loadAssistantMetrics(assistantId, roleKey) {'],
    ['_fetchAndRenderAssistantRules', 'async function _fetchAndRenderAssistantRules(assistantId) {'],
    ['_fetchAndRenderGoals', 'async function _fetchAndRenderGoals(assistantId) {'],
    ['_renderRunbookDirectives', 'window._renderRunbookDirectives = async function(assistantId) {'],
    ['_renderLeadRejectionEvidence', 'window._renderLeadRejectionEvidence = async function(assistantId) {'],
    // The role-specific KPI loaders _loadAssistantMetrics hands off to (the Note Taker's are records).
    ['_loadNewsletterMetrics', 'async function _loadNewsletterMetrics(assistantId) {'],
    ['_loadBlogMetrics', 'async function _loadBlogMetrics(assistantId) {'],
    ['_loadCampaignMetrics', 'async function _loadCampaignMetrics(assistantId) {'],
    ['_loadRecordsMetrics', 'async function _loadRecordsMetrics(assistantId, roleKey) {'],
    ['_loadBrandMetrics', 'async function _loadBrandMetrics(assistantId) {'],
    ['_loadVideoMetrics', 'async function _loadVideoMetrics(assistantId) {'],
    ['_loadShopMetrics', 'async function _loadShopMetrics(assistantId) {'],
    ['_loadMailboxMetrics', 'async function _loadMailboxMetrics() {'],
    ['_loadSiteMetrics', 'async function _loadSiteMetrics(assistantId) {'],
    ['_loadSiteAuditMetrics', 'async function _loadSiteAuditMetrics(assistantId) {'],
    ['_loadLeadMetrics', 'async function _loadLeadMetrics(assistantId) {'],
];

for (const [name, header] of LOADERS) {
    check(`${name} takes a ticket first and checks it after its awaits`, () => {
        const b = body(js, header);
        const firstLine = b.split('\n')[1] || '';
        assert.ok(firstLine.includes('const stale = _detailTicket();'), `first statement takes the ticket (got: ${firstLine.trim()})`);
        assert.ok(b.includes('if (stale()'), 'checks it');
        const why = guardedAfterLastAwait(b);
        assert.strictEqual(why, null, why || '');
    });
}

check('kick-off card: checked after the readiness read (its click handler is the user acting, left alone)', () => {
    const b = body(js, 'async function _renderKickOff(assistantId) {');
    assert.ok(b.split('\n')[1].includes('const stale = _detailTicket();'));
    assert.ok(b.includes("} catch { if (!stale()) card.classList.add('hidden'); return; }\n    if (stale()) return;"));
    // The failed-response branch too: a late 500/403 for the previous assistant hid the next one's
    // Kick-off card until a reload (review of #778).
    assert.ok(b.includes("if (!res.ok) { if (!stale()) card.classList.add('hidden'); return; }"), 'failed read checks the ticket before hiding');
    assert.ok(!b.includes("if (!res.ok) { card.classList.add('hidden'); return; }"), 'no unguarded hide on a failed read');
});

check('goals: no global is set from a stale answer', () => {
    const b = body(js, 'async function _fetchAndRenderGoals(assistantId) {');
    const json = b.indexOf('const data = await res.json();');
    assert.ok(json !== -1);
    assert.ok(b.indexOf('if (stale()) return;', json) < b.indexOf('_goalHeadlineId = ', json), 'checked before _goalHeadlineId');
});

check('Review badge: checked before the count is written anywhere', () => {
    const b = body(js, 'async function _prefetchDetailRqBadge(assistantId) {');
    assert.ok(b.lastIndexOf('if (stale()) return;') < b.indexOf('_setDetailRqTabBadge(count);'));
});

console.log('\ninside initAssistantDetail');

const start = at(js, 'window.initAssistantDetail = async function(assistantId, loadViewCb) {');
const init = js.slice(start, js.indexOf('\n};\n', start));

check('the Autopilot skeleton is not cleared by a superseded call', () => {
    assert.ok(init.includes("if (_skelAutopilot && !_detailStale()) _endCardLoading('autopilot-status-card');"));
});

check('activity: checked after the fetch and after the JSON, and a stale failure says nothing', () => {
    const f = init.indexOf('const res = await fetch(`${_activityUrl}');
    assert.ok(f !== -1);
    const after = init.slice(f, f + 400);
    assert.ok(after.split('if (_detailStale()) return;').length - 1 >= 2, 'two checks right after the awaits');
    assert.ok(init.includes('if (!_detailStale()) _activityLoadFailed();'));
});

check('connections: Synced actions + onboarding answers wait for a live ticket', () => {
    const i = init.indexOf('window.initAssistantConnections(assistantId, currentData).then(() => {');
    assert.ok(i !== -1);
    assert.ok(init.slice(i, i + 140).includes('if (_detailStale()) return;'));
});

console.log('\nintegrations.js');

check('initAssistantConnections takes the page ticket and hands it to _loadConnections', () => {
    const b = body(integ, 'window.initAssistantConnections = async function (assistantId, currentData) {');
    assert.ok(b.includes("const stale = typeof window._detailTicket === 'function' ? window._detailTicket() : () => false;"));
    assert.ok(/await _loadSocialHandles\(\);\n\s*if \(stale\(\)\) return;/.test(b), 'checked after the handles');
    assert.ok(b.includes('await _loadConnections(stale);'));
});

check('_loadConnections ignores a non-function argument and checks before writing or drawing', () => {
    const b = body(integ, 'async function _loadConnections(isStale) {');
    assert.ok(b.includes("const stale = () => typeof isStale === 'function' && isStale();"), 'an Event from a listener is not a ticket');
    const json = b.indexOf('const data = await res.json();');
    assert.ok(b.indexOf('if (stale()) return;', json) < b.indexOf('_userConnections = ', json), 'before _userConnections');
    const blog = b.indexOf('await _loadBlogDestinations();');
    assert.ok(b.indexOf('if (stale()) return;', blog) < b.indexOf('_renderConnectionsGrid();', blog), 'before the grid is drawn');
});

check('Synced actions (assistant-integrations.js load) check the ticket before storing or drawing', () => {
    const ai = readFileSync(path.join(ROOT, 'src/components/assistant-integrations.js'), 'utf8');
    const b = body(ai.replace(/\n  /g, '\n'), 'async function load() {');
    assert.ok(b.includes("const stale = typeof window._detailTicket === 'function' ? window._detailTicket() : () => false;"));
    assert.ok(b.indexOf('if (stale()) return;') < b.indexOf('state.scenarios = scenarios;'));
    assert.ok(/catch \(e\) \{\n\s*if \(stale\(\)\) return;/.test(b), 'a stale failure says nothing');
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
