// tests/lead-contact-column.test.ts
// The Leads tab's "Contact" column — can this lead actually be reached?
//
// Outreach is email-only (`send_outreach` bails with reason 'no_recipient' without an address), and
// tier-1 enrichment hits roughly 3 in 10 UK SMB sites, so "no way to contact this one" is the
// MAJORITY state of the Leads table rather than an edge case. Until this column existed an
// unreachable lead was pixel-identical to a sendable one.
//
// ⚠️ THE TWO INVARIANTS WORTH DEFENDING, both of them couplings to the discovery worker:
//
//   1. `recordEnrichment()` must mirror `enrichAttemptedAt` onto the assistant_record on a MISS,
//      not only on a hit. That single key is what separates "None found" (we read the site; it
//      publishes nothing — go find an address by hand) from "Checking…" (nobody has looked yet).
//      It used to return early on a miss, and the column could not tell the two apart.
//
//   2. `enrichBatch()` must keep scraping `rating IN ('hot','warm')` only, because that is what
//      "Not checked" asserts about a cold lead. Widen or narrow that SQL and the column starts
//      claiming nobody looked at leads that were looked at, or vice versa.
//
// Both are quiet lies on a screen whose entire job is to say what can be acted on, and neither
// shows up as an error. This file fails when they drift.
//
// No database, no DOM: the component is a browser IIFE with no exports, so its logic is read as
// source and re-evaluated here, in the same style as the reject-strip checks.
// Run:  npx tsx tests/lead-contact-column.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const HUB = read('src/components/assistant-data-hub.js');
const REGISTRY = read('src/components/assistant-dashboard-registry.js');
const WORKER = read('netlify/functions/process-discovery-jobs.ts');

/** Lift `contactState` + `contactEmailOf` out of the IIFE and run them for real. */
function loadContactState(): (r: Record<string, unknown>) => string {
    const emailFn = HUB.slice(HUB.indexOf('function contactEmailOf'), HUB.indexOf('/**', HUB.indexOf('function contactEmailOf')));
    const start = HUB.indexOf('function contactState');
    assert.ok(start !== -1, 'contactState() is gone — the column no longer derives its state');
    const stateFn = HUB.slice(start, HUB.indexOf('\n  }', start) + 4);
    // eslint-disable-next-line no-new-func
    return new Function(`${emailFn}\n${stateFn}\nreturn contactState;`)() as (r: Record<string, unknown>) => string;
}

const contactState = loadContactState();
const lead = (status: string, data: Record<string, unknown> = {}) => ({ status, data });

console.log('\n──── the five states ────');

check('a scraped generic inbox is sendable', () => {
    assert.strictEqual(contactState(lead('hot', { contactEmail: 'hello@acme.co.uk', emailKind: 'role' })), 'role');
});

check('a named individual is flagged apart from a role inbox', () => {
    // Not cosmetic: send_outreach puts a personal address behind an extra confirm, so the list has
    // to warn before the reviewer commits, not after.
    assert.strictEqual(contactState(lead('hot', { contactEmail: 'jo@acme.co.uk', emailKind: 'personal' })), 'personal');
});

check('an unknown emailKind degrades to role, never to personal', () => {
    // A missing kind must not manufacture a warning. Manual and CSV leads carry no emailKind.
    assert.strictEqual(contactState(lead('warm', { contactEmail: 'hello@acme.co.uk' })), 'role');
});

check('an attempt that found nothing reads "we looked and found nothing"', () => {
    const stamped = { enrichAttemptedAt: '2026-08-06T10:00:00.000Z' };
    assert.strictEqual(contactState(lead('warm', stamped)), 'none');
    assert.strictEqual(contactState(lead('hot', { ...stamped, contactEmail: '   ' })), 'none');
    // The stamp beats the rating: a cold lead that WAS somehow attempted still reports the truth.
    assert.strictEqual(contactState(lead('cold', stamped)), 'none');
});

check('a hot/warm lead with no attempt stamp is queued only while a job is LIVE', () => {
    // Phase 2 item 11. This used to assert 'checking' unconditionally, which is what the column
    // did — and it was the accepted lie documented above contactState(): a run that finished or
    // died left every unreached lead claiming to be in progress, permanently. `enrichBatch()` only
    // runs inside a live job, so the claim needs a live job behind it.
    const live = { enrichmentInFlight: true };
    assert.strictEqual(contactState({ ...lead('warm'), ...live }), 'checking');
    assert.strictEqual(contactState({ ...lead('hot'), ...live }), 'checking');

    assert.strictEqual(contactState(lead('warm')), 'missed');
    assert.strictEqual(contactState(lead('hot')), 'missed');
    assert.strictEqual(contactState({ ...lead('hot'), enrichmentInFlight: false }), 'missed');
});

check('a cold lead with no address reads "nobody looked, and nobody will"', () => {
    assert.strictEqual(contactState(lead('cold')), 'unchecked');
});

check('a cold lead that somehow HAS an address still reports the address', () => {
    // CSV imports and manual entry bypass enrichment entirely, so a cold lead can carry one.
    // Reporting "Not checked" over a real address would send the user hunting for what they have.
    assert.strictEqual(contactState(lead('cold', { contactEmail: 'hello@acme.co.uk', emailKind: 'role' })), 'role');
});

console.log('\n──── the derivation still matches the pipeline ────');

check('enrichment is still hot/warm only, which is what "Not checked" asserts', () => {
    const start = WORKER.indexOf('async function enrichBatch');
    assert.ok(start !== -1, 'enrichBatch() is gone — re-derive what "Not checked" can claim');
    const fn = WORKER.slice(start, WORKER.indexOf('\n}', start));
    assert.ok(/rating IN \('hot','warm'\)/.test(fn),
        'enrichBatch no longer filters to hot/warm. contactState() infers "Not checked" from a cold '
        + 'rating alone, so the column now lies about which leads were attempted — update both together.');
});

check('the attempt stamp is mirrored onto the record on a MISS, not just a hit', () => {
    // This is what makes "None found" mean "we looked". recordEnrichment used to return early on a
    // miss (`if (!hit || !assistantRecordId) return`), so the stamp never reached the table the
    // Leads tab reads and the column could not tell a miss from a pending attempt.
    const start = WORKER.indexOf('async function recordEnrichment');
    assert.ok(start !== -1, 'recordEnrichment() is gone');
    const fn = WORKER.slice(start, WORKER.indexOf('\n}', start));
    const guard = fn.slice(fn.indexOf('if (!'), fn.indexOf('assistantRecords)', fn.indexOf('if (!')));
    assert.ok(!/!hit\s*\|\|/.test(guard),
        'the assistant_records mirror is hit-only again — every miss stops reaching the Leads tab, '
        + 'and the Contact column silently reverts to calling misses "Checking…"');
    assert.ok(/\.\.\.stamp/.test(fn),
        'the mirror must spread `stamp`, which carries enrichAttemptedAt on both paths');
});

check('the revenue ledger stays hit-only, unlike the mirror', () => {
    // Different jobs: the mirror is UI state, the ledger measures our scraper's hit RATE. Counting
    // misses there would report every attempt as a success.
    const start = WORKER.indexOf('async function recordEnrichment');
    const fn = WORKER.slice(start, WORKER.indexOf('\n}', start));
    assert.ok(/if \(hit && ledger\)/.test(fn),
        'lead_enriched must only be emitted on a hit');
});

check('a backfill exists for records enriched before the mirror changed', () => {
    // Without it, every already-missed lead reads "Checking…" forever.
    const sql = read('db/backfill-enrich-attempted.sql');
    assert.ok(/enrichAttemptedAt/.test(sql) && /discovered_leads/.test(sql),
        'the backfill must read the stamp discovered_leads already had');
    assert.ok(/IS NULL/.test(sql), 'the backfill must skip rows that already carry the key (idempotent)');
});

check('contactState keys off the same two ratings, not a hardcoded third', () => {
    const src = HUB.slice(HUB.indexOf('function contactState'), HUB.indexOf('function cellValue'));
    assert.ok(/record\.status === 'cold'/.test(src),
        'the "nobody looked" leg must test the rating the pipeline skips');
    assert.ok(!/'hot'|'warm'/.test(src.replace(/\/\/.*$/gm, '')),
        'test for the skipped rating only — enumerating the attempted ones means two lists to keep in sync');
});

console.log('\n──── the column is wired and states are total ────');

check('the lead hub lists the column, and its key is the synthetic one', () => {
    const hub = REGISTRY.slice(REGISTRY.indexOf('hubTab: {', REGISTRY.indexOf('lead_qualifier:')));
    assert.ok(/\{ key: 'contact', label: 'Contact' \}/.test(hub),
        'the Leads hub no longer lists the Contact column');
    // Synthetic: there is no `contact` field on a record, so cellValue MUST special-case it or the
    // dot-path fallback silently renders an em-dash for every row.
    assert.ok(/if \(key === 'contact'\)/.test(HUB),
        'cellValue no longer resolves the synthetic `contact` key — every row would read "—"');
});

check('every state contactState can return has a chip', () => {
    const map = HUB.slice(HUB.indexOf('const CONTACT_CHIP'), HUB.indexOf('};', HUB.indexOf('const CONTACT_CHIP')));
    const declared = [...map.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]).sort();
    // 'missed' joined the set for Phase 2 item 11: hot/warm, never looked up, and no live job to
    // look it up — previously rendered as "Checking…" forever.
    assert.deepEqual(declared, ['checking', 'missed', 'none', 'personal', 'role', 'unchecked'],
        'CONTACT_CHIP and contactState() have drifted — an unmapped state throws on render');
});

check('the chip renders the STATE, and keeps the address out of the cell', () => {
    const row = HUB.slice(HUB.indexOf('function rowHtml'), HUB.indexOf('function refreshRow'));
    const branch = row.slice(row.indexOf("c.key === 'contact'"));
    // The tooltip carries the ADDRESS when there is one, and the reason for its absence otherwise
    // (item 11), now joined by the social-profile hint (item 7). Both, never the raw address in the
    // cell — a column of a hundred people's contact details answers a question nobody asked.
    //
    // Matched loosely on purpose: the ordering is what matters (address first, everything else only
    // when there is no address), not the expression that builds the fallback.
    assert.ok(/const tip = email \|\|/.test(branch),
        'the tooltip must prefer the address over any fallback');
    assert.ok(/s\.why/.test(branch),
        'the tooltip must still fall back to why there is no address');
    assert.ok(/socialHint\(record\)/.test(branch),
        'the fallback must name the profiles a row carries, or they are only findable row by row');
    assert.ok(/title="\$\{esc\(tip\)\}"/.test(branch),
        'the address should ride in the tooltip, so it is available without being rendered per row');
    assert.ok(/\$\{esc\(s\.short\)\}/.test(branch),
        'the cell must render the state label, never the raw address');
});

console.log(`\n${passed} checks passed.`);
