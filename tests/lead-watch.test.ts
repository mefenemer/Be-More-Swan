// tests/lead-watch.test.ts
// Buying triggers Phase 2 (docs/buying-triggers-plan.md §5, FR#36; owner decisions 2026-11-16): the Lead
// Generator's Watch list — Companies House news on customers, leads and companies added by hand.
//
// WHY THIS EXISTS. The Watch list tells a business "this company just appointed a director / changed
// owner / is in liquidation". Wrong news is worse than none: these pin that the wording comes from the
// filing type alone (never a model), unknown filings are ignored, the first check of a company is silent
// (no news from before it was watched, why-now 2.3), the same filing is never reported twice (daily check
// and stream share one unique key), customers are always watched and rejected / do-not-contact /
// deleted leads never are, a user's "Stop watching" survives the daily sync, a closing company stops the
// follow-ups (and the halt reason exists in all four places, or the halt would fail and keep sending),
// erasure removes the watch row, the export includes it, and the GUI and chat share one endpoint.
//
// Run:  npx tsx tests/lead-watch.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    filingToSignal, statusToSignal, newFilingsSince, normaliseCompanyNumber, parseStreamEvent, tidyName, isClosingStatus,
} from '../src/lib/triggers/ch-watch';
import { parseFiling, type CompaniesHouseFiling } from '../src/lib/companies-house';
import { planWatchRows, nextCheckDays, groupForRollUp, rollUpText, watchingOn, CHECK_EVERY_DAYS, RECHECK_AFTER_POSITIVE_DAYS, CATCH_UP_EVERY_DAYS } from '../src/utils/lead-watch';
import { watchActionFromUiElement } from '../src/utils/chat-watch-action';
import { SEQUENCE_HALT_REASONS, SEQUENCE_HALT_REASON_LABELS } from '../src/config/outreach-sequences';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const filing = (type: string, values: Record<string, string> = {}, id = `T-${type}`, date = '2026-11-10'): CompaniesHouseFiling =>
    ({ transactionId: id, type, date, category: null, description: null, values });

console.log('Filing → signal (fixed wording, no model)');
check('director appointed is positive and names the director', () => {
    const s = filingToSignal(filing('AP01', { officer_name: 'MR JOHN SMITH' }), '01234567', '2026-11-16')!;
    assert.strictEqual(s.kind, 'director_appointed');
    assert.strictEqual(s.direction, 'positive');
    assert.strictEqual(s.text, 'Appointed a new director: John Smith, 10 Nov 2026');
    assert.strictEqual(s.ref, 'T-AP01');
    assert.strictEqual(s.occurredOn, '2026-11-10');
    assert.match(s.url, /find-and-update\.company-information\.service\.gov\.uk\/company\/01234567\/filing-history$/);
});
check('director left is neutral; a secretary leaving (TM02) is ignored', () => {
    assert.strictEqual(filingToSignal(filing('TM01', { officer_name: 'Jane Doe' }), '01234567', '2026-11-16')!.direction, 'neutral');
    assert.strictEqual(filingToSignal(filing('TM02'), '01234567', '2026-11-16'), null);
});
check('office move, new charge and new owner are positive; owner leaving is neutral', () => {
    assert.strictEqual(filingToSignal(filing('AD01'), 'X', '2026-11-16')!.kind, 'office_moved');
    assert.strictEqual(filingToSignal(filing('MR01'), 'X', '2026-11-16')!.text, 'Registered a new charge (borrowing), 10 Nov 2026');
    const owner = filingToSignal(filing('PSC01', { psc_name: 'Ms Ada Lovelace' }), 'X', '2026-11-16')!;
    assert.strictEqual(owner.kind, 'owner_added');
    assert.strictEqual(owner.text, 'New owner or controller: Ada Lovelace, 10 Nov 2026');
    assert.strictEqual(filingToSignal(filing('PSC07'), 'X', '2026-11-16')!.direction, 'neutral');
});
check('every other filing type is ignored (accounts, confirmation statements…)', () => {
    for (const t of ['AA', 'CS01', 'SH01', 'CH01', 'RESOLUTIONS', 'NEWINC']) assert.strictEqual(filingToSignal(filing(t), 'X', '2026-11-16'), null, t);
});
check('a filing without a usable date is dated the day we saw it', () => {
    assert.strictEqual(filingToSignal({ ...filing('AD01'), date: null }, 'X', '2026-11-16')!.occurredOn, '2026-11-16');
});
check('parseFiling reads the register shape and refuses rows without id or type', () => {
    const f = parseFiling({ transaction_id: 'MzQ1', type: 'ap01', date: '2026-11-01', category: 'officers', description_values: { officer_name: 'Mr A B', appointment_date: '2026-10-30' } })!;
    assert.strictEqual(f.type, 'AP01');
    assert.strictEqual(f.values.officer_name, 'Mr A B');
    assert.strictEqual(parseFiling({ type: 'AP01' }), null);
    assert.strictEqual(parseFiling(null), null);
});
check('tidyName drops titles and softens register capitals', () => {
    assert.strictEqual(tidyName('DR MARY-ANNE O\'NEILL'), 'Mary-Anne O\'Neill');
    assert.strictEqual(tidyName('Mr Tom Jones'), 'Tom Jones');
});

console.log('Status and first look');
check('the first status ever recorded is the silent baseline, even a closing one', () => {
    assert.strictEqual(statusToSignal(null, 'liquidation', 'X', '2026-11-16'), null);
});
check('moving into liquidation / administration / dissolved is a negative signal; other moves are not', () => {
    const s = statusToSignal('active', 'liquidation', '01234567', '2026-11-16')!;
    assert.strictEqual(s.direction, 'negative');
    assert.strictEqual(s.kind, 'company_closing');
    assert.strictEqual(s.ref, 'status:liquidation');
    assert.strictEqual(s.text, 'Companies House shows this company in liquidation');
    assert.ok(statusToSignal('active', 'dissolved', 'X', 'd'));
    assert.strictEqual(statusToSignal('active', 'active', 'X', 'd'), null);
    assert.strictEqual(statusToSignal('liquidation', 'active', 'X', 'd'), null);
    assert.ok(isClosingStatus('administration') && !isClosingStatus('active'));
});
check('first look reports NO filings; later looks report only newer ones, oldest first', () => {
    const list = [filing('AP01', {}, 'c'), filing('AD01', {}, 'b'), filing('MR01', {}, 'a')];
    assert.deepStrictEqual(newFilingsSince(list, null), []);
    assert.deepStrictEqual(newFilingsSince(list, 'a').map((f) => f.transactionId), ['b', 'c']);
    assert.deepStrictEqual(newFilingsSince(list, 'c'), []);
    // The last seen filing fell off the page: everything is a candidate, the unique key stops repeats.
    assert.deepStrictEqual(newFilingsSince(list, 'zzz').map((f) => f.transactionId), ['a', 'b', 'c']);
    // '' = checked before and the company had no filings then.
    assert.strictEqual(newFilingsSince(list, '').length, 3);
});
check('company numbers are normalised; junk is refused', () => {
    assert.strictEqual(normaliseCompanyNumber('1234567'), '01234567');
    assert.strictEqual(normaliseCompanyNumber('sc 123'), 'SC000123');
    assert.strictEqual(normaliseCompanyNumber('OC312345'), 'OC312345');
    assert.strictEqual(normaliseCompanyNumber('ACME LTD'), null);
    assert.strictEqual(normaliseCompanyNumber(''), null);
});

console.log('The Companies House stream');
check('a filings event and a companies event are parsed; heartbeats and junk are skipped', () => {
    const f = parseStreamEvent(JSON.stringify({ resource_uri: '/company/01234567/filing-history/MzQ1', data: { transaction_id: 'MzQ1', type: 'AP01', date: '2026-11-15', description_values: { officer_name: 'Mr A B' } }, event: { timepoint: 991, type: 'changed' } }), 'filings', parseFiling)!;
    assert.strictEqual(f.companyNumber, '01234567');
    assert.strictEqual(f.timepoint, 991);
    assert.strictEqual(f.filing!.type, 'AP01');
    const c = parseStreamEvent(JSON.stringify({ resource_uri: '/company/SC000123', data: { company_status: 'liquidation' }, event: { timepoint: 5 } }), 'companies', parseFiling)!;
    assert.strictEqual(c.status, 'liquidation');
    assert.strictEqual(parseStreamEvent('', 'filings', parseFiling), null);
    assert.strictEqual(parseStreamEvent('{not json', 'filings', parseFiling), null);
    assert.strictEqual(parseStreamEvent(JSON.stringify({ resource_uri: '/company/01234567', event: {} }), 'companies', parseFiling), null);
});
check('the stream only reads companies whose first check has run (baseline stays silent)', () => {
    const src = read('src/utils/lead-watch.ts');
    const i = src.indexOf('async function loadWatchedByNumber');
    assert.ok(i > 0);
    assert.match(src.slice(i, i + 700), /ch_last_filing_id IS NOT NULL/);
});
check('daily check and stream share one unique key per watched company and filing', () => {
    assert.match(read('db/z-lead-watch.sql'), /UNIQUE \(watch_id, ref\)/);
    assert.match(read('src/utils/lead-watch.ts'), /ON CONFLICT \(watch_id, ref\) DO NOTHING/);
});

console.log('Which companies are watched');
const lead = (recordId: number, data: Record<string, unknown>, updatedAt = '2026-11-10T00:00:00Z', assistantId = 1) =>
    ({ recordId, organisationId: 9, assistantId, data, updatedAt });
const ch = (number: string, name = 'Acme Ltd') => ({ companiesHouse: { number, name } });
check('customers are always watched; open leads newest first up to the cap', () => {
    const rows = planWatchRows([
        lead(1, { ...ch('00000001'), dealOutcome: { outcome: 'won' } }, '2020-01-01T00:00:00Z'),
        lead(2, ch('00000002'), '2026-11-01T00:00:00Z'),
        lead(3, ch('00000003'), '2026-11-12T00:00:00Z'),
        lead(4, ch('00000004'), '2026-10-01T00:00:00Z'),
    ], 3);
    assert.deepStrictEqual(rows.map((r) => [r.recordId, r.kind]), [[1, 'customer'], [3, 'lead'], [2, 'lead']]);
});
check('lost, disqualified, do-not-contact, deleted and unmatched leads are never watched', () => {
    const rows = planWatchRows([
        lead(1, { ...ch('00000001'), dealOutcome: { outcome: 'lost' } }),
        lead(2, { ...ch('00000002'), dealOutcome: { outcome: 'disqualified' } }),
        lead(3, { ...ch('00000003'), doNotContact: true }),
        lead(4, { ...ch('00000004'), retention: { deletedAt: '2026-11-01T00:00:00Z', reason: 'unreviewed' } }),
        lead(5, { companyName: 'No match Ltd' }),
        lead(6, ch('not-a-number')),
    ], 300);
    assert.deepStrictEqual(rows, []);
});
check('the same company twice on one assistant is watched once; separate assistants each watch it', () => {
    const rows = planWatchRows([lead(1, ch('00000001')), lead(2, ch('1')), lead(3, ch('00000001'), undefined, 2)], 300);
    assert.strictEqual(rows.length, 2);
});
check('"Stop watching" survives the daily sync, and the sync never deletes a manual row', () => {
    const src = read('src/utils/lead-watch.ts');
    assert.match(src, /WHEN lead_watch\.paused_reason = 'removed_by_user' THEN 'removed_by_user'/);
    assert.match(src, /watch_kind = CASE WHEN lead_watch\.watch_kind = 'manual' THEN 'manual'/);
    assert.doesNotMatch(src, /DELETE FROM lead_watch/);
});
check('the switch defaults ON (why-now decision 1)', () => {
    assert.strictEqual(watchingOn(null), true);
    assert.strictEqual(watchingOn(undefined), true);
    assert.strictEqual(watchingOn(false), false);
});
check('check cadence: 7 days, 3 after a positive signal, 30 when the stream is healthy', () => {
    assert.strictEqual(nextCheckDays(false, false), CHECK_EVERY_DAYS);
    assert.strictEqual(nextCheckDays(true, true), RECHECK_AFTER_POSITIVE_DAYS);
    assert.strictEqual(nextCheckDays(false, true), CATCH_UP_EVERY_DAYS);
    assert.deepStrictEqual([CHECK_EVERY_DAYS, RECHECK_AFTER_POSITIVE_DAYS, CATCH_UP_EVERY_DAYS], [7, 3, 30]);
});

console.log('Telling the workspace');
check('one note per assistant; neutral-only news sends nothing', () => {
    const groups = groupForRollUp([
        { organisation_id: 9, ai_assistant_id: 1, direction: 'positive', company_name: 'Acme Ltd' },
        { organisation_id: 9, ai_assistant_id: 1, direction: 'positive', company_name: 'Acme Ltd' },
        { organisation_id: 9, ai_assistant_id: 1, direction: 'negative', company_name: 'Bolt Ltd' },
        { organisation_id: 9, ai_assistant_id: 2, direction: 'neutral', company_name: 'Calm Ltd' },
    ]);
    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0].companies, ['Acme Ltd', 'Bolt Ltd']);
    const t = rollUpText(groups[0]);
    assert.strictEqual(t.title, 'News on 2 companies you watch');
    assert.match(t.body, /2 new reasons to get in touch and 1 warning/);
});
check('the roll-up marks every signal it read as notified, sent or not', () => {
    const src = read('src/utils/lead-watch.ts');
    const i = src.indexOf('export async function rollUpSignals');
    assert.match(src.slice(i, i + 1500), /UPDATE lead_watch_signals SET notified_at = now\(\)/);
});
check('a positive signal restarts the retention clock; other news does not', () => {
    assert.match(read('src/utils/lead-watch.ts'), /updated_at = CASE WHEN \$\{positive\} THEN now\(\) ELSE updated_at END/);
});

console.log('A company closing stops the follow-ups');
check('company_closed is a halt reason with a label, in the SQL CHECK, schema.ts and its migration', () => {
    assert.ok((SEQUENCE_HALT_REASONS as readonly string[]).includes('company_closed'));
    assert.ok(SEQUENCE_HALT_REASON_LABELS.company_closed);
    for (const f of ['db/outreach-sequences.sql', 'db/schema.ts', 'db/sequence-halt-company-closed.sql']) {
        assert.ok(read(f).includes("'company_closed'"), f);
    }
    const mig = read('db/sequence-halt-company-closed.sql');
    for (const r of SEQUENCE_HALT_REASONS) assert.ok(mig.includes(`'${r}'`), `migration keeps ${r}`);
});
check('the halt falls back to manual until the migration runs, so a cadence never keeps sending', () => {
    const src = read('src/utils/lead-watch-effects.ts');
    assert.match(src, /haltEnrolment\(db, r, 'company_closed'/);
    assert.match(src, /\|\| await haltEnrolment\(db, r, 'manual'/);
    assert.match(src, /sig\.kind === 'company_closing' && row\.assistant_record_id/);
});
check('do-not-contact is never set by the Watch list', () => {
    for (const f of ['src/utils/lead-watch.ts', 'src/utils/lead-watch-effects.ts', 'src/utils/lead-watch-list.ts']) {
        // A write would be `doNotContact: …` or `doNotContact = …`; the sync's `=== true` read is fine.
        assert.doesNotMatch(read(f), /doNotContact['"]?\s*:(?!:)|doNotContact\s*=(?!=)/, f);
    }
});

console.log('Privacy and data');
check('erasing a prospect deletes its Watch list row (and its news, by cascade)', () => {
    assert.match(read('src/utils/prospect-erasure.ts'), /db\.delete\(leadWatch\)[\s\S]{0,120}eq\(leadWatch\.organisationId, orgId\)/);
    assert.match(read('db/z-lead-watch.sql'), /watch_id\s+BIGINT NOT NULL REFERENCES lead_watch\(id\) ON DELETE CASCADE/);
});
check('the workspace export includes the Watch list and tolerates a table not created yet', () => {
    const src = read('src/utils/workspace-export.ts');
    assert.match(src, /leadWatch: s\.leadWatch/);
    assert.match(src, /leadWatchSignals: s\.leadWatchSignals/);
    assert.match(src, /42P01/);
});
check('the Mentor data inventory decides on every new table', () => {
    const src = read('src/config/mentor-data-inventory.ts');
    for (const t of ['lead_watch', 'lead_watch_signals', 'lead_watch_settings']) assert.ok(src.includes(`'${t}'`), t);
});

console.log('GUI and chat share one path');
check('the Lead Generator declares the tab and the page has its button, panel and script', () => {
    assert.match(read('src/components/assistant-dashboard-registry.js'), /watchListTab:\s*\{\s*label: 'Watch list'/);
    const html = read('assistant-detail.html');
    assert.ok(html.includes('id="maintab-btn-watchlist"') && html.includes('id="watchlist-host"'));
    assert.ok(read('workspace.html').includes('/src/components/assistant-watch-list.js'));
    const a = read('assistants.js');
    assert.ok(a.includes("if (name === 'watchlist') window.AssistantWatchList?.activate();"));
    assert.ok(a.includes('window.AssistantWatchList?.init('));
});
check('the tab and the chat card both post to lead-watch.ts', () => {
    assert.ok(read('src/components/assistant-watch-list.js').includes("const API = '/.netlify/functions/lead-watch'"));
    const cs = read('src/components/chat-session.js');
    assert.ok(cs.includes("container.addEventListener('watch:action', onWatchAction)"));
    assert.ok(cs.includes("fetch('/.netlify/functions/lead-watch'"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('watch_action_proposal', renderWatchActionProposalCard)"));
});
check('the chat card is validated and rebuilt server-side', () => {
    assert.deepStrictEqual(watchActionFromUiElement({ type: 'watch_action_proposal', action: 'add', number: '1234567' })?.number, '01234567');
    assert.strictEqual(watchActionFromUiElement({ type: 'watch_action_proposal', action: 'add' }), null);
    assert.strictEqual(watchActionFromUiElement({ type: 'watch_action_proposal', action: 'remove' }), null);
    assert.strictEqual(watchActionFromUiElement({ type: 'watch_action_proposal', action: 'set_enabled' }), null);
    assert.strictEqual(watchActionFromUiElement({ type: 'watch_action_proposal', action: 'delete_everything', watchId: 1 }), null);
    assert.strictEqual(watchActionFromUiElement({ type: 'other', action: 'add', number: '1' }), null);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /resolveWatchActionProposal\(db, orgId, session\.aiAssistantId, watchReq\)/);
    assert.match(orch, /rc\.watchListBlock/);
});
check('the endpoint checks the workspace owns the assistant and that it is a Lead Generator', () => {
    const src = read('netlify/functions/lead-watch.ts');
    assert.match(src, /requireTenant\(event, db\)/);
    assert.match(src, /eq\(aiAssistants\.organisationId, orgId\)/);
    assert.match(src, /roleKey !== 'lead_qualifier'/);
});
check('every Watch list query in the tenant module is scoped by organisation', () => {
    const src = read('src/utils/lead-watch-list.ts');
    const updates = src.match(/UPDATE lead_watch [^`]*/g) || [];
    for (const u of updates) assert.match(u, /organisation_id = \$\{orgId\}|WHERE id = \$\{(existing|row)\.id\}/, u.slice(0, 80));
});

console.log('Schedules and SQL');
check('production schedules and the staging poke exist', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /\[functions\.dispatch-lead-watch\]\n\s+schedule = "10 5 \* \* \*"/);
    assert.match(toml, /\[functions\.dispatch-ch-stream\]\n\s+schedule = "\*\/30 \* \* \* \*"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /run-lead-watch-dispatch\s+86400\s+120/);
});
check('the stream does nothing without COMPANIES_HOUSE_STREAM_KEY', () => {
    assert.match(read('netlify/functions/dispatch-ch-stream.ts'), /if \(!isStreamConfigured\(\) \|\| !isLeadWatchEnabled\(\)\)/);
});
check('db/z-lead-watch.sql is additive and idempotent', () => {
    const s = read('db/z-lead-watch.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/ON DELETE CASCADE/g, '');
    assert.doesNotMatch(s, /\b(DROP|ALTER|TRUNCATE|DELETE)\b/i);
    assert.strictEqual((s.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
    assert.doesNotMatch(s, /\bDO \$\$/);
});

console.log(`\n${passed}/${total} passed`);
