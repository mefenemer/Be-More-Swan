// tests/help-support-hub.test.ts
// Help & Support as the one place for help (2026-10-03): the workspace's Report-an-Issue icon and
// pop-up folded in as a tab, tickets gained a real conversation, and the knowledge base was fixed
// and extended.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const W = read('workspace.html');
const HC = read('help-content.html');
const HJ = read('help.js');
const ST = read('netlify/functions/support-tickets.ts');

console.log('\n──── one place for help ────');

check('the header icon, its modal and its old script are gone from the workspace', () => {
    assert.doesNotMatch(W, /id="nav-report-issue"/);
    assert.doesNotMatch(W, /id="modal-report-issue"/);
    assert.doesNotMatch(W, /window\.openReportIssue = function/);
});

check('Help & Support has the four tabs, issues included', () => {
    for (const t of ['docs', 'issues', 'tickets', 'features']) {
        assert.match(HC, new RegExp(`id="tab-btn-${t}"`));
        assert.match(HC, new RegExp(`id="tab-content-${t}"`));
    }
    for (const id of ['ri-area', 'ri-description', 'ri-image', 'ri-submit', 'ri-my-list', 'ri-status-filter']) assert.match(HC, new RegExp(`id="${id}"`));
});

check('the old entry points still work, and land on the tab', () => {
    assert.match(HJ, /window\.openReportIssue = function/);
    assert.match(HJ, /window\.routeToIssueReport = function \(issueId\)/);
    assert.match(HJ, /window\.routeToSupportTicket = function \(ticketId\)/);
    assert.match(read('tour.js'), /targets: \['#tab-btn-issues'\]/);
    assert.doesNotMatch(read('notifications.js'), /ticketTab\.click\(\)/, 'a timed tab click races the view load');
});

check('a requested tab opens before the knowledge base\'s network wait', () => {
    const init = HJ.slice(HJ.indexOf('window.initHelpCenter = async function'));
    assert.ok(init.indexOf('window.helpShowTab(want)') < init.indexOf('await initKnowledgeBase()'));
});

check('the issue form says where it happened, defaulting to the page the user came from', () => {
    assert.match(HJ, /sourceLocation: AREA_LABEL\(area\) \|\| area/);
    assert.match(HJ, /const prev = window\._previousView && window\._previousView\.key;/);
});

console.log('\n──── tickets are a conversation ────');

check('the owner can read a ticket and its PUBLIC replies', () => {
    assert.match(ST, /and\(eq\(supportTickets\.id, ticketId\), eq\(supportTickets\.userId, userId\)\)/);
    assert.match(ST, /eq\(ticketReplies\.isInternal, false\)/, 'internal notes must never reach the customer');
});

check('the owner can reply, which reopens the ticket, and a closed one refuses', () => {
    assert.match(ST, /insert\(ticketReplies\)\.values\(\{ ticketId, authorId: userId, body, isInternal: false \}\)/);
    assert.match(ST, /set\(\{ status: 'open', updatedAt: new Date\(\) \}\)/);
    assert.match(ST, /ticket\.status === 'closed'\) return \{ statusCode: 409/);
});

check('the business inbox hears about new tickets, replies and feature ideas', () => {
    assert.match(ST, /New \$\{newTicket\.category\} ticket/);
    assert.match(ST, /Customer replied/);
    assert.match(read('netlify/functions/feature-requests.ts'), /for \(const to of adminInbox\(\)\)/);
});

check('every status has a label, and user text is escaped', () => {
    for (const s of ['new', 'open', 'pending_customer', 'resolved', 'closed']) assert.match(HJ, new RegExp(`${s}: +\\[`));
    assert.match(HJ, /\$\{esc\(ticket\.subject\)\}/);
});

check('the ticket button keeps its button-system class after submitting', () => {
    assert.doesNotMatch(HJ, /btn\.className = "w-full px-4 py-3 text-sm font-bold text-white bg-gray-900/);
});

check('a ticket notification opens THAT ticket', () => {
    assert.match(read('notifications.js'), /window\.routeToSupportTicket\?\.\(meta\.ticketId \?\? null\)/);
    assert.match(read('netlify/functions/admin-helpdesk.ts'), /metadata: \{ ticketId \}/);
});

console.log('\n──── the knowledge base ────');

check('article cards are cards, not pink primary buttons', () => {
    const kb = HJ.slice(HJ.indexOf('function renderArticles'), HJ.indexOf('function renderChips'));
    assert.doesNotMatch(kb, /btn-primary/);
});

check('filter chips come from the published categories', () => {
    assert.match(HC, /<div class="flex flex-wrap gap-2 mt-4" id="help-filters"><\/div>/);
    assert.match(HJ, /new Set\(allArticles\.map\(\(a\) => a\.category\)/);
});

check('articles are styled (the prose plugin was never compiled) on both readers', () => {
    assert.match(HC, /#help-article-body h2 \{/);
    assert.match(read('help.html'), /#article-body h2 \{/);
});

check('in-article #links open the article they name', () => {
    assert.match(HJ, /a\[href\^="#"\]/);
});

check('the refresh migration is safe to paste and follows the quoting rules', () => {
    const sql = read('db/help-articles-2026-10.sql');
    const bodies = [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
    assert.ok(bodies.length >= 15, `expected the article bodies, found ${bodies.length}`);
    for (const b of bodies) {
        assert.ok(!b.includes(';'), 'a semicolon inside a body is where a web SQL editor cuts the file');
        assert.ok(!b.includes("''"), 'apostrophes inside $$ bodies are literal — never doubled');
    }
    assert.match(sql, /'Your Assistant''s Page'/, 'titles ARE single-quoted, so their apostrophes are doubled');
    assert.doesNotMatch(sql, /Standard \| Premium|Up to 2 active/, 'the old fictional plan table is gone');
});

console.log(`\n${passed} checks passed`);
