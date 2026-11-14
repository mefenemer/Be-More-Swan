// tests/fix-live-no-confirm.test.ts — FR#23 (owner 2026-11-14): "They are not our testers, they are paying
// customers." When a fix reaches production the customer is told it is fixed and the issue closes; nothing asks
// them to try it again or confirm it, and nothing waits on their answer.

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
console.log('fix-live-no-confirm');
const ASKS = /give it another try|let us know how it goes|ready for you to test|ready to test|confirm (the )?fix|haven't heard back|If we don't hear from you/i;

const live = read('src/utils/issue-fix-live.ts');
const confirm = live.slice(live.indexOf('async function confirmLiveFixes('), live.indexOf('async function autoCloseQuietFixes('));
const auto = live.slice(live.indexOf('async function autoCloseQuietFixes('));

check('a fix going live closes the issue and says there is nothing to do', () => {
    assert.ok(/SET status = 'closed', fixed_at = now\(\), live_at = now\(\), resolved_at = now\(\)/.test(confirm), 'closed on go-live');
    assert.ok(confirm.includes("status: 'closed', variant: 'live'"), 'one "fixed and live" notification');
    const m = /export const LIVE_FIX_MESSAGE = "([^"]+)"/.exec(live);
    assert.ok(m && /nothing you need to do/.test(m[1]) && /just reply/.test(m[1]), 'the thread note');
    assert.ok(!ASKS.test(confirm) && !ASKS.test(m![1]), 'never asks them to test');
});

check('the 7-day close of a hand-set "fixed" issue is quiet: no "haven\'t heard back" note or notification', () => {
    assert.ok(!/notifyIssueUser|issueReportMessages/.test(auto), 'no message, no notification');
});

check('no customer-facing copy asks them to test or confirm', () => {
    const rep = read('src/utils/issue-reports.ts');
    const cta = rep.slice(rep.indexOf('const cta ='), rep.indexOf('const messageLine'));
    assert.ok(!ASKS.test(cta), 'notification / email copy');
    const cat = read('src/utils/notification-templates-catalog.ts');
    for (const key of ['issue_fixed_ready_to_test', 'issue_fixed_live']) {
        const i = cat.indexOf(`templateKey: '${key}'`);
        assert.ok(!ASKS.test(cat.slice(i, cat.indexOf('variables:', i))), key);
    }
    const legacy = rep.slice(rep.indexOf('export async function maybeAdvanceToReadyToTest'));
    assert.ok(!ASKS.test(legacy.slice(0, 2500)), 'the pre-SQL route too');
});

check('Help & Support: no "Confirm fix works" button, and a fixed issue is not "waiting on you"', () => {
    const h = read('help.js');
    assert.ok(!h.includes('Confirm fix works'));
    assert.ok(h.includes("waiting: i.status === 'more_info_required'"));
    assert.ok(h.includes("fixed_ready_to_test: ['Fixed',"));
});

check('the admin Inbox counts a fixed issue as done, not "waiting on them"', () => {
    const s = read('src/utils/support-inbox.ts');
    assert.ok(s.includes("if (status === 'fixed_ready_to_test') return 'done';"));
});

console.log(`\n${passed} passed`);
