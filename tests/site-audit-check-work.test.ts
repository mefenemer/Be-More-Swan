// tests/site-audit-check-work.test.ts
// "I'll work on this" on the Mystery Shopper's "Why your score isn't higher" (owner, 2026-11-04):
// a line can be taken on, goes to In progress, and only a check that PASSES it confirms it.
//
// Run:  npx tsx tests/site-audit-check-work.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksNowPassing, decideCheckWork, isCheckWorkTableMissing, itemVerdict, websiteChangeBrief } from '../src/utils/site-audit-check-work';
import type { CheckOutcome } from '../src/utils/site-score';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const line = (result: CheckOutcome['result']): CheckOutcome => ({ id: 'faq', lens: 'ai', weight: 2, label: 'No FAQ section', source: 'rubric', result });
const ACCEPTED = { status: 'accepted', verifiedRunId: null };
const USER_DONE = { status: 'done', verifiedRunId: null };
const CONFIRMED = { status: 'done', verifiedRunId: 9 };

console.log('site-audit-check-work');

check('a failing line can be taken on, and marked done straight away', () => {
    assert.deepStrictEqual(decideCheckWork(null, 'accepted', line('fail')), { op: 'upsert', status: 'accepted' });
    assert.deepStrictEqual(decideCheckWork(null, 'done', line('fail')), { op: 'upsert', status: 'done' });
});

check('a line that is not failing cannot be newly taken on', () => {
    assert.strictEqual(decideCheckWork(null, 'accepted', line('pass')).op, 'refuse');
    assert.strictEqual(decideCheckWork(null, 'accepted', undefined).op, 'refuse');
});

check('undo removes the row; undo with no row is harmless', () => {
    assert.deepStrictEqual(decideCheckWork(ACCEPTED, 'open', line('fail')), { op: 'delete' });
    assert.deepStrictEqual(decideCheckWork(null, 'open', line('fail')), { op: 'none' });
});

check('"Not done after all" works on a user-marked line, even if the latest check has not seen it', () => {
    assert.deepStrictEqual(decideCheckWork(USER_DONE, 'accepted', line('fail')), { op: 'upsert', status: 'accepted' });
    assert.deepStrictEqual(decideCheckWork(USER_DONE, 'accepted', undefined), { op: 'upsert', status: 'accepted' });
});

check('a check\'s confirmation stands — unless the line has failed again', () => {
    assert.strictEqual(decideCheckWork(CONFIRMED, 'open', line('pass')).op, 'refuse');
    assert.strictEqual(decideCheckWork(CONFIRMED, 'accepted', line('pass')).op, 'refuse');
    assert.deepStrictEqual(decideCheckWork(CONFIRMED, 'done', line('pass')), { op: 'none' });
    assert.deepStrictEqual(decideCheckWork(CONFIRMED, 'accepted', line('fail')), { op: 'upsert', status: 'accepted' });
});

check('only a PASS confirms: a fail or an n/a does not, and confirmed rows are left alone', () => {
    const rows = [
        { id: 1, checkId: 'a', status: 'accepted', verifiedRunId: null },
        { id: 2, checkId: 'b', status: 'done', verifiedRunId: null },
        { id: 3, checkId: 'c', status: 'accepted', verifiedRunId: null },
        { id: 4, checkId: 'd', status: 'accepted', verifiedRunId: null },
        { id: 5, checkId: 'e', status: 'done', verifiedRunId: 7 },
    ];
    const outcomes = [{ id: 'a', result: 'pass' }, { id: 'b', result: 'pass' }, { id: 'c', result: 'fail' }, { id: 'd', result: 'na' }, { id: 'e', result: 'pass' }] as const;
    assert.deepStrictEqual(checksNowPassing(rows, [...outcomes]), [1, 2]);
});

check('a missing table is recognised however the driver wraps it', () => {
    assert.ok(isCheckWorkTableMissing({ code: '42P01' }));
    assert.ok(isCheckWorkTableMissing({ cause: { code: '42P01' } }));
    assert.ok(isCheckWorkTableMissing({ message: 'relation "site_audit_check_work" does not exist' }));
    assert.ok(!isCheckWorkTableMissing({ code: '23505', message: 'duplicate key' }));
});

check('the pipeline confirms only after the success latch', () => {
    const src = read('src/utils/site-audit.ts');
    const latch = src.indexOf('if (!latched) return;');
    const confirm = src.indexOf('await confirmPassedChecks(');
    assert.ok(latch > -1 && confirm > latch);
});

check('the tab offers it on every line, sends it through In progress, and the copy no longer says there is nothing to tick off', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.ok(tab.includes('>I\'ll work on this') || tab.includes(`"I'll work on this"`));
    assert.ok(tab.includes("I've done this"));
    assert.ok(!tab.includes("there's nothing to tick off"));
    assert.match(tab, /action: 'check_work'/);
    assert.match(tab, /checks: work\.filter\(\(w\) => onPage\(w\) && !stalledChecks\.has\(w\.id\)\)/);
});

check('the chat knows the ids and the card', () => {
    const snapshot = read('src/utils/site-audit-snapshot.ts');
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(snapshot.includes("checkId — what is missing — what they said"));
    assert.ok(chat.includes('SCORE CHECKS.'));
    assert.ok(chat.includes('"I\'ll work on this", plus "See the suggested fix"'));
});

check('the verdict comes from the run, so a failed or swept check never strands an item', () => {
    assert.strictEqual(itemVerdict('queued'), 'checking');
    assert.strictEqual(itemVerdict('running'), 'checking');
    assert.strictEqual(itemVerdict('failed'), 'not_checked');
    assert.strictEqual(itemVerdict('unreadable'), 'not_checked');
    assert.strictEqual(itemVerdict('done'), 'incomplete');
    assert.strictEqual(itemVerdict('unchanged'), 'nothing_changed');
    assert.strictEqual(itemVerdict(null), null);
});

check('the Website Assistant brief says where it came from, and keeps placeholders', () => {
    const fix = websiteChangeBrief({ kind: 'fix', location: 'Headline', beforeText: 'Welcome', afterText: 'Book a [service] today' });
    assert.match(fix, /^From my Mystery Shopper's website check: please change "Welcome" \(Headline\) to "Book a \[service\] today"\./);
    assert.match(fix, /rather than making it up/);
    assert.match(websiteChangeBrief({ kind: 'check', label: 'No FAQ section' }), /"No FAQ section"/);
});

check('the Website Assistant prompt recognises that opening, so the two can\'t drift apart', () => {
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes("When a message says it comes from their Mystery Shopper's website check"));
});

check('every item in progress gets the button; a finished one does not; the helper is offered only when hosted', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /\$\{accepted \? completionBlock\('fix', f\.id,/);
    assert.match(tab, /\$\{completionBlock\('check', w\.id,/);
    assert.match(tab, /\$\{helper \? `<button type="button" data-sa-ask-website=/);
});

check('Publish tells the Mystery Shopper: only a requested change, only after going live, and it can never fail the publish', () => {
    const sites = read('netlify/functions/sites.ts');
    const live = sites.indexOf('await publishSite(db, site, userId, maxPages)');
    assert.ok(live > -1 && sites.indexOf('await recheckAfterPublish(db, orgId, r.site, userId)') > live);
    const r = read('src/utils/site-audit-recheck.ts');
    assert.match(r, /isNotNull\(siteAuditItemChecks\.websiteAskedAt\)/);
    assert.match(r, /if \(!open\.length\) continue;/);
    assert.match(r, /websiteAskedAt: null/, 'each request starts one check');
    assert.match(r, /\} catch \(err\) \{[\s\S]*return null;\s*\}\s*\}\s*$/, 'never throws');
});

console.log(`\n${passed} passed`);
