// tests/support-inbox.test.ts
// Admin ▸ Customers ▸ Inbox (2026-10-18): tickets, reported problems and enquiries in one list, each
// answering "who is it waiting on?" the same way; re-routing between the helpdesk and the fix
// pipeline; and the panels those rows open, which used to be dead outside their own page.
//
// Run:  npx tsx tests/support-inbox.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketWaitingOn, issueWaitingOn, enquiryWaitingOn, countWaitingOnUs, ENQUIRY_LEAD_TYPES, type InboxItem } from '../src/utils/support-inbox';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ADMIN = read('admin.html');
const API = read('netlify/functions/admin-api.ts');
const INBOX = read('src/utils/support-inbox.ts');

console.log('\nWho is it waiting on?');

check('tickets: a customer reply reopens to open = us; pending_customer = them; resolved/closed = done', () => {
    for (const s of ['new', 'open']) assert.strictEqual(ticketWaitingOn(s), 'us', s);
    assert.strictEqual(ticketWaitingOn('pending_customer'), 'customer');
    for (const s of ['resolved', 'closed']) assert.strictEqual(ticketWaitingOn(s), 'done', s);
});

check('issues: new = us, asked/ready-to-test = them, pipeline = being fixed, and a customer comment always = us', () => {
    assert.strictEqual(issueWaitingOn('reported', false), 'us');
    assert.strictEqual(issueWaitingOn('more_info_required', false), 'customer');
    assert.strictEqual(issueWaitingOn('fixed_ready_to_test', false), 'customer');
    for (const s of ['backlog', 'on_hold', 'fix_in_progress', 'merge']) assert.strictEqual(issueWaitingOn(s, false), 'fixing', s);
    assert.strictEqual(issueWaitingOn('fix_in_progress', true), 'us', 'their newest message needs reading');
    assert.strictEqual(issueWaitingOn('more_info_required', true), 'us', 'they answered our question');
    for (const s of ['closed', 'roadmap']) assert.strictEqual(issueWaitingOn(s, true), 'done', s);
});

check('enquiries: their message last (or none answered) = us, ours last = them, converted/lost = done', () => {
    assert.strictEqual(enquiryWaitingOn('inbound', false), 'us');
    assert.strictEqual(enquiryWaitingOn(null, false), 'us');
    assert.strictEqual(enquiryWaitingOn('outbound', false), 'customer');
    assert.strictEqual(enquiryWaitingOn('inbound', true), 'done');
    assert.match(INBOX, /enquiryWaitingOn\(r\.last_direction \?\? null, r\.status === 'converted' \|\| r\.status === 'lost'\)/);
    assert.match(INBOX, /direction <> 'internal'/, 'an internal note is not a reply');
});

check('waitlist sign-ups are interest, not enquiries — only message-shaped lead types count', () => {
    assert.ok(!ENQUIRY_LEAD_TYPES.includes('waitlist' as never));
    assert.ok(ENQUIRY_LEAD_TYPES.includes('contact_form') && ENQUIRY_LEAD_TYPES.includes('inbound_email'));
    assert.match(INBOX, /l\.lead_type IN \(\$\{sql\.join\(ENQUIRY_LEAD_TYPES/);
});

check('countWaitingOnUs counts only "us"', () => {
    const mk = (waitingOn: InboxItem['waitingOn']) => ({ waitingOn } as InboxItem);
    assert.strictEqual(countWaitingOnUs([mk('us'), mk('customer'), mk('us'), mk('fixing'), mk('done')]), 2);
});

console.log('\nThe API');

check('each source is read only with the permission its own page needs', () => {
    const route = API.slice(API.indexOf("resource === 'inbox')"), API.indexOf("resource === 'inbox-reroute'"));
    assert.match(route, /tickets: hasPermission\(adminRole, 'view_tickets'\)/);
    assert.match(route, /issues: hasPermission\(adminRole, 'view_issue_reports'\)/);
    assert.match(route, /enquiries: hasPermission\(adminRole, 'view_billing_history'\)/);
});

check('re-routing needs both queues\' permissions, is audited, and tells the customer', () => {
    const route = API.slice(API.indexOf("resource === 'inbox-reroute'"), API.indexOf('// ── GET: assistant catalog'));
    assert.match(route, /requirePermission\(adminRole, 'view_tickets'\) \|\| requirePermission\(adminRole, 'view_issue_reports'\)/);
    assert.match(route, /action: 'support_request_reroute'/);
    assert.match(route, /createNotification\(db, 'ticket_reply'/);
    assert.match(read('src/utils/admin-audit.ts'), /\| 'support_request_reroute'/);
});

check('a move is one transaction that creates the new one, carries the conversation, and closes the old with a note', () => {
    for (const fn of ['ticketToIssue', 'issueToTicket']) {
        const body = INBOX.slice(INBOX.indexOf(`export async function ${fn}`));
        const end = body.indexOf('\n}\n');
        const f = body.slice(0, end);
        assert.match(f, /db\.transaction\(async \(tx\) =>/, fn);
        assert.match(f, /FOR UPDATE/, `${fn} locks the original`);
        assert.match(f, /status = 'closed'/, `${fn} closes the original`);
        assert.match(f, /'Our reply' : 'Customer'/, `${fn} carries the conversation`);
    }
    assert.match(INBOX, /is_internal = false ORDER BY r\.created_at/, 'internal notes never travel into a customer-visible report');
});

console.log('\nThe admin portal');

check('one Inbox in the menu; Issue Reports is the Fix pipeline; Support Tickets left the menu', () => {
    assert.match(ADMIN, /\{ view: 'inbox', +icon: '📥', label: 'Inbox',/);
    assert.match(ADMIN, /\{ view: 'issue-reports', +icon: '🐞', label: 'Fix pipeline',/);
    assert.doesNotMatch(ADMIN, /\{ view: 'tickets', +icon/);
    assert.match(ADMIN, /if \(view === 'inbox'\) +loadInbox\(\);/);
    assert.match(ADMIN, /<section id="view-inbox" class="admin-view hidden/);
});

check('rows open where the request lives; panels offer the move both ways', () => {
    assert.match(ADMIN, /if \(kind === 'ticket'\) return openTicketPanel\(id\);\s*if \(kind === 'issue'\) return openIssuePanel\(id\);/);
    assert.match(ADMIN, /onclick="inboxReroute\('ticket', \$\{t\.id\}\)"/);
    assert.match(ADMIN, /onclick="inboxReroute\('issue', \$\{i\.id\}\)"/);
});

check('the Dashboard counts what is waiting on us across the Inbox', () => {
    assert.match(ADMIN, /\['Waiting on us', '<span id="kpi-waiting-on-us">…<\/span>', '📥'\]/);
    assert.match(ADMIN, /const waiting = \(ib\.items \|\| \[\]\)\.filter\(x => x\.waitingOn === 'us'\);/);
});

check('the ticket and issue panels are at body level (they were dead from Dashboard, Contacts, Feature Requests)', () => {
    const cross = ADMIN.indexOf('<!-- ── Cross-view modals');
    assert.ok(cross > 0);
    assert.ok(ADMIN.indexOf('id="ticket-detail-panel"') > cross);
    assert.ok(ADMIN.indexOf('id="ir-detail-panel"') > cross);
});

check('customer text is escaped in the admin tables and panels', () => {
    assert.match(ADMIN, /\$\{_escH\(t\.subject\)\}<\/td>/);
    assert.match(ADMIN, /whitespace-pre-wrap">\$\{_escH\(t\.description\)\}<\/div>/);
    assert.match(ADMIN, /<p class="text-gray-800 whitespace-pre-wrap">\$\{_escH\(r\.body\)\}<\/p>/);
    assert.match(ADMIN, /focus:outline-none">\$\{_escH\(i\.description\)\}<\/textarea>/);
    assert.match(ADMIN, /<p class="text-gray-800 whitespace-pre-wrap">\$\{_escH\(m\.body\)\}<\/p>/);
    assert.match(ADMIN, /const srcUrl = \/\^https\?:/, 'only an http(s) page address becomes a link');
    assert.doesNotMatch(ADMIN, /\$\{i\.description \|\| ''\}<\/textarea>/);
});

check('the ticket category filter uses the values tickets are saved with', () => {
    for (const v of ['technical', 'assistant', 'billing', 'other']) assert.match(ADMIN, new RegExp(`<option value="${v}">`));
    assert.doesNotMatch(ADMIN, /<option value="Onboarding">Onboarding<\/option>/);
});

console.log(`\n${passed}/${total} passed\n`);
