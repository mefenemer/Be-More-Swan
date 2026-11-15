// tests/buying-triggers.test.ts
// Buying triggers Phase 1 (docs/buying-triggers-plan.md §5, FR#36): the engine and its first feed, the
// FSA's new food and drink premises. ADMIN ONLY in this phase.
//
// WHY THIS EXISTS. Phase 1 is a measurement: the owner's stop/go gate (§9.3) is set against its counts.
// A count inflated by the backlog (35,000 premises already awaiting inspection) or by a council
// re-keying its records would say "go" on false numbers. These pin: the first look at a council is
// silent; a bulk re-import is not news; a premises is counted once; a council that hasn't been read
// for 30 days is baselined again, and its seen rows outlive that window; the wording is fixed and never
// implies official status; only corporate bodies count as emailable (PECR); and nothing in Phase 1
// reaches a workspace.
//
// Run:  npx tsx tests/buying-triggers.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import {
    fhrsTradeCode, nameLooksCorporate, fhrsHasAddress, isAwaitingInspection, fhrsToEvent, fhrsLabel,
    isFsaSourceEnabled, type FhrsEstablishment,
} from '../src/lib/triggers/fsa-fhrs';
import {
    councilVerdict, isBaselined, parseState, splitNew, ukDay, isCorporateCompanyType,
} from '../src/utils/trigger-engine';
import { chooseCompany } from '../src/lib/companies-house';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

// A real row from the API (2026-11-15), trimmed.
const SLICE: FhrsEstablishment = {
    FHRSID: 1964256, BusinessName: '& Slice', BusinessType: 'Takeaway/sandwich shop', BusinessTypeID: 7844,
    AddressLine1: '3 Bloomsbury Street', AddressLine2: 'Birmingham', AddressLine3: '', AddressLine4: '',
    PostCode: 'B7 5BX', RatingValue: 'AwaitingInspection', RatingKey: 'fhrs_awaitinginspection_en-gb',
    LocalAuthorityName: 'Birmingham', LocalAuthorityCode: '402', SchemeType: 'FHRS',
    geocode: { longitude: '-1.8719132', latitude: '52.4944355' },
};
const HOME: FhrsEstablishment = { FHRSID: 42, BusinessName: 'Jane Smith Cakes', BusinessType: 'Other catering premises', AddressLine1: '', PostCode: '', RatingKey: 'fhrs_awaitinginspection_en-gb' };

console.log('FSA adapter');
check('business type → stable trade code', () => {
    assert.strictEqual(fhrsTradeCode('Restaurant/Cafe/Canteen'), 'restaurant_cafe_canteen');
    assert.strictEqual(fhrsTradeCode('Hotel/bed & breakfast/guest house'), 'hotel_bed_and_breakfast_guest_house');
    assert.strictEqual(fhrsTradeCode(''), 'unknown');
});
check('a trading name that says Ltd is spotted; one that does not is not', () => {
    assert.ok(nameLooksCorporate('Acme Foods Ltd'));
    assert.ok(nameLooksCorporate('ACME FOODS LIMITED'));
    assert.ok(!nameLooksCorporate('Jane Smith Cakes'));
    assert.ok(!nameLooksCorporate('Ltdz Bakery'));
});
check('a withheld address (home business) is recorded as such', () => {
    assert.ok(fhrsHasAddress(SLICE));
    assert.ok(!fhrsHasAddress(HOME));
    // A real row: the FSA shows only the postcode district for a home business.
    assert.ok(!fhrsHasAddress({ FHRSID: 1919009, BusinessName: 'Ducky Dough', AddressLine1: '', PostCode: 'DE55' }));
});
check('awaiting inspection is read in English, Welsh and Scottish wording', () => {
    assert.ok(isAwaitingInspection(SLICE));
    assert.ok(isAwaitingInspection({ FHRSID: 1, RatingKey: 'fhrs_ratingawaited_cy-gb' }));
    assert.ok(isAwaitingInspection({ FHRSID: 1, RatingKey: 'fhis_awaiting_inspection_en-gb' }));
    assert.ok(!isAwaitingInspection({ FHRSID: 1, RatingKey: 'fhrs_5_en-gb', RatingValue: '5' }));
});
check('one establishment → one event, keyed by FHRSID, dated the day we saw it', () => {
    const ev = fhrsToEvent(SLICE, '2026-11-15');
    assert.strictEqual(ev.kind, 'food_premises_registered');
    assert.strictEqual(ev.source, 'fsa_fhrs');
    assert.strictEqual(ev.sourceEventId, '1964256');
    assert.strictEqual(ev.subjectType, 'fhrs_id');
    assert.strictEqual(ev.postcode, 'B7 5BX');
    assert.strictEqual(ev.area, 'Birmingham');
    assert.deepStrictEqual(ev.tradeCodes, ['takeaway_sandwich_shop']);
    assert.strictEqual(ev.occurredOn, '2026-11-15');
    assert.strictEqual(ev.payload.address, '3 Bloomsbury Street, Birmingham');
    assert.strictEqual(ev.payload.hasAddress, true);
});
check('the wording is fixed, says where it came from, and never implies official status', () => {
    const l = fhrsLabel({ occurredOn: '2026-11-03', payload: { address: '12 High St' } });
    assert.strictEqual(l.direction, 'positive');
    assert.match(l.text, /^Registered a new food business at 12 High St/);
    assert.match(l.text, /FSA's public ratings list/);
    assert.match(l.text, /3 Nov/);
    assert.doesNotMatch(l.text, /\byour\b/i, 'never "Your food registration…" — scam letters say that');
    assert.doesNotMatch(fhrsLabel({ occurredOn: '2026-11-03', payload: {} }).text, / at /);
});
check('the source has its own off switch', () => {
    const was = process.env.TRIGGER_SOURCE_FSA_FHRS;
    process.env.TRIGGER_SOURCE_FSA_FHRS = 'off';
    assert.ok(!isFsaSourceEnabled());
    delete process.env.TRIGGER_SOURCE_FSA_FHRS;
    assert.ok(isFsaSourceEnabled());
    if (was !== undefined) process.env.TRIGGER_SOURCE_FSA_FHRS = was;
});

console.log('Engine: honest counts');
const NOW = new Date('2026-11-15T04:25:00Z');
check('the first look at a council is silent (it is a backlog, not news)', () => {
    assert.strictEqual(councilVerdict(false, 1898, 1898), 'baseline');
    assert.ok(!isBaselined(parseState(null), 197, NOW));
});
check('a council read yesterday produces events', () => {
    const st = parseState({ authorities: { '197': '2026-11-14T04:25:00Z' } });
    assert.ok(isBaselined(st, 197, NOW));
    assert.strictEqual(councilVerdict(true, 12, 1900), 'events');
});
check('a council not read for over 30 days is baselined again', () => {
    const st = parseState({ authorities: { '197': '2026-10-10T04:25:00Z' } });
    assert.ok(!isBaselined(st, 197, NOW));
});
check('seen rows are kept longer than the re-baseline window (no false events after an outage)', () => {
    const src = read('src/utils/trigger-engine.ts');
    const rebase = Number(src.match(/const REBASELINE_AFTER_DAYS = (\d+)/)?.[1]);
    const keep = Number(src.match(/const SEEN_KEEP_DAYS = (\d+)/)?.[1]);
    assert.ok(rebase > 0 && keep > rebase, `SEEN_KEEP_DAYS (${keep}) must exceed REBASELINE_AFTER_DAYS (${rebase})`);
});
check('a bulk re-import (more than max(50, 25%) new at once) is not counted as news', () => {
    assert.strictEqual(councilVerdict(true, 51, 100), 'bulk');
    assert.strictEqual(councilVerdict(true, 50, 100), 'events');
    assert.strictEqual(councilVerdict(true, 400, 1898), 'events');
    assert.strictEqual(councilVerdict(true, 600, 1898), 'bulk');
});
check('only unseen premises are new, and one listed twice counts once', () => {
    const seen = new Set(['1964256']);
    const out = splitNew([SLICE, HOME, { ...HOME }], seen);
    assert.deepStrictEqual(out.map((e) => e.FHRSID), [42]);
});
check('the day is the UK day', () => {
    assert.strictEqual(ukDay(new Date('2026-07-01T23:30:00Z')), '2026-07-02');
    assert.strictEqual(ukDay(new Date('2026-12-01T23:30:00Z')), '2026-12-01');
});

console.log('PECR: who can be emailed');
check('Ltd, PLC and LLP are corporate; no match and limited partnerships are not', () => {
    for (const t of ['ltd', 'plc', 'llp', 'scottish-partnership']) assert.ok(isCorporateCompanyType(t), t);
    for (const t of ['limited-partnership', 'converted-or-closed', '', null]) assert.ok(!isCorporateCompanyType(t as string), String(t));
});
check('the register match passes the company type through and keeps its strict rules', () => {
    const items = [
        { number: '12345678', name: 'ACME FOODS LTD', status: 'active', postcode: 'B7 5BX', type: 'ltd' },
        { number: '87654321', name: 'ACME FOODS LIMITED', status: 'active', postcode: 'LS1 1AA', type: 'ltd' },
    ];
    assert.strictEqual(chooseCompany('Acme Foods', items, ['B7 5BX'])?.type, 'ltd');
    assert.strictEqual(chooseCompany('Acme Foods', items, []), null, 'two active matches and no postcode = no match');
});

console.log('Wiring');
check('scheduled daily on production, poked on staging, run in the background', () => {
    assert.match(read('netlify.toml'), /\[functions\.dispatch-trigger-polls\]\s*\n\s*schedule = "25 4 \* \* \*"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /^\s+run-trigger-poll-dispatch\s+86400\s+\d+$/m);
    assert.match(read('src/utils/trigger-engine.ts'), /\/\.netlify\/functions\/run-trigger-poll-background/);
});
check('the background poller and staging poke fail closed without the shared secret', () => {
    for (const f of ['netlify/functions/run-trigger-poll-background.ts', 'netlify/functions/run-trigger-poll-dispatch.ts']) {
        assert.match(read(f), /CRON_TRIGGER_SECRET/, f);
    }
});
check('the Admin page is gated on platform_config and listed in the menu', () => {
    assert.match(read('netlify/functions/admin-triggers.ts'), /hasPermission\(row\?\.role, 'platform_config'\)/);
    const html = read('admin.html');
    assert.match(html, /view: 'buying-triggers',[^\n]*perm: 'platform_config'/);
    assert.match(html, /id="view-buying-triggers"/);
    assert.match(html, /if \(view === 'buying-triggers'\)\s+loadBuyingTriggers\(\)/);
    assert.match(html, /Open Government Licence v3\.0/, 'OGL attribution shown wherever the data is');
});
check('Phase 1 is admin only: no workspace code reads trigger_events yet', () => {
    // When Phase 2/3 start using it, replace this with the real gate (opt-in source, corporate-only email).
    const users = ['src/utils/trigger-engine.ts', 'netlify/functions/admin-triggers.ts'];
    const out = execSync('git ls-files src netlify', { cwd: ROOT, encoding: 'utf8' });
    const readers = out.split('\n').filter((f) => /\.(ts|js)$/.test(f) && !users.includes(f))
        .filter((f) => { try { return /\btrigger_events\b/.test(read(f)); } catch { return false; } });
    assert.deepStrictEqual(readers, []);
});
check('the SQL is additive and idempotent', () => {
    const s = read('db/z-trigger-events.sql');
    assert.doesNotMatch(s, /\b(DROP|ALTER|TRUNCATE|DELETE)\b/i);
    assert.strictEqual((s.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
    assert.match(s, /UNIQUE \(source, source_event_id\)/);
});

console.log(`\n${passed}/${total} passed`);
