// tests/inbox-ignore.test.ts — FR#22 (owner 2026-11-14): Ignore a message in Admin ▸ Inbox without replying.
// It moves to Done, nothing is sent, the request itself is unchanged, and it comes back if the person writes again.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as inbox from '../src/utils/support-inbox';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
console.log('inbox-ignore');

const { applyDismissals, dismissalKey } = inbox as any;
const item = (over: Partial<inbox.InboxItem>): inbox.InboxItem => ({
    kind: 'ticket', id: 1, contactId: null, name: 'A', email: 'a@x.test', title: 'Hi', detail: null, status: 'open',
    waitingOn: 'us', createdAt: '2026-11-10T09:00:00.000Z', lastActivityAt: '2026-11-10T09:00:00.000Z', ...over,
});
const now = new Date('2026-11-14T12:00:00Z');

check('an ignored item moves to Done and carries when it was ignored', () => {
    assert.strictEqual(typeof applyDismissals, 'function', 'applyDismissals exists');
    const out = applyDismissals([item({})], new Map([[dismissalKey('ticket', 1), '2026-11-11T10:00:00.000Z']]), now);
    assert.strictEqual(out[0].waitingOn, 'done');
    assert.strictEqual(out[0].dismissedAt, '2026-11-11T10:00:00.000Z');
});

check('the same id in another queue is not ignored', () => {
    const out = applyDismissals([item({ kind: 'issue' })], new Map([[dismissalKey('ticket', 1), '2026-11-11T10:00:00.000Z']]), now);
    assert.strictEqual(out[0].waitingOn, 'us');
    assert.ok(!out[0].dismissedAt);
});

check('it comes back when the person writes again after it was ignored', () => {
    const out = applyDismissals([item({ kind: 'enquiry', lastActivityAt: '2026-11-12T08:00:00.000Z' })],
        new Map([[dismissalKey('enquiry', 1), '2026-11-11T10:00:00.000Z']]), now);
    assert.strictEqual(out[0].waitingOn, 'us');
    assert.ok(!out[0].dismissedAt);
});

check('ignored items drop off after the Done window like any other Done item', () => {
    const out = applyDismissals([item({ lastActivityAt: '2026-08-01T00:00:00.000Z' })],
        new Map([[dismissalKey('ticket', 1), '2026-08-02T00:00:00.000Z']]), now);
    assert.strictEqual(out.length, 0);
});

check('the API records the dismissal only: no notification, no status change, permission per queue', () => {
    const api = read('netlify/functions/admin-api.ts');
    const i = api.indexOf("resource === 'inbox-dismiss'");
    assert.ok(i > 0, 'POST ?resource=inbox-dismiss exists');
    const block = api.slice(i, api.indexOf("resource === 'inbox-reroute'", i));
    assert.ok(block.includes('setDismissed('), 'writes the dismissal');
    assert.ok(!/createNotification|notifyIssueUser|sendEmail|UPDATE support_tickets|UPDATE issue_reports/.test(block), 'tells no one, changes nothing else');
    assert.ok(block.includes("'view_tickets'") && block.includes("'view_issue_reports'") && block.includes("'view_billing_history'"), 'same gate as each queue');
    const util = read('src/utils/support-inbox.ts');
    const set = util.slice(util.indexOf('export async function setDismissed'), util.indexOf('/** How many are waiting on us'));
    assert.ok(!/UPDATE (support_tickets|issue_reports|leads)/.test(set), 'setDismissed touches only support_inbox_dismissals');
});

check('the SQL is additive', () => {
    const q = read('db/z-inbox-dismissals.sql');
    assert.ok(/CREATE TABLE IF NOT EXISTS support_inbox_dismissals/.test(q));
    assert.ok(!/\b(DROP|DELETE|UPDATE|TRUNCATE|ALTER TABLE \w+ DROP)\b/i.test(q.replace(/--.*$/gm, '').replace(/ON DELETE SET NULL/g, '')));
});

check('Inbox rows: Ignore on open items, Ignored + Undo on ignored ones, nothing on other Done items', () => {
    const html = read('admin.html');
    const a = html.indexOf('function inboxIgnoreButton(x)');
    assert.ok(a > 0, 'inboxIgnoreButton exists');
    const fn = html.slice(a, html.indexOf('\nasync function inboxIgnore', a));
    const c: any = {}; vm.createContext(c);
    vm.runInContext(`${fn}; this.f = inboxIgnoreButton;`, c);
    assert.ok(c.f({ kind: 'ticket', id: 4, waitingOn: 'us' }).includes("inboxIgnore('ticket', 4, false)"));
    assert.ok(c.f({ kind: 'enquiry', id: 9, waitingOn: 'customer' }).includes('data-inbox-ignore'));
    const ign = c.f({ kind: 'issue', id: 7, waitingOn: 'done', dismissedAt: '2026-11-14T00:00:00Z' });
    assert.ok(ign.includes('Ignored') && ign.includes("inboxIgnore('issue', 7, true)"));
    assert.strictEqual(c.f({ kind: 'ticket', id: 2, waitingOn: 'done' }), '');
    assert.ok(html.includes('${inboxIgnoreButton(x)}'), 'rendered in every Inbox row');
});

console.log(`\n${passed} passed`);
