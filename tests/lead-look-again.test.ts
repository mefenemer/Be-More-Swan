// tests/lead-look-again.test.ts
// The "Look again" recovery action (Phase 2 item 10).
//
// `signals->>'enrichAttemptedAt'` is what makes "None found" mean "we looked" — and it suppresses
// re-scraping forever. A company that publishes a contact page next month is never revisited.
// Clearing that stamp for ONE lead puts it back in `enrichBatch`'s queue.
//
// Two ways this feature can be a lie, and both are checked here:
//
//   1. CLEARING THE WRONG TABLE. The Contact column reads `assistant_records.data`, but
//      `enrichBatch` selects from `discovered_leads`. Clear only the mirror and the chip changes,
//      the user believes the lead is queued, and nothing is ever scraped again.
//   2. PROMISING A LOOKUP NOBODY SCHEDULED. Enrichment only runs inside a live discovery job on the
//      lead's own campaign. The action restores eligibility; it does not scrape. Copy that implies
//      otherwise is the same lie "Checking…" told before item 11.
//
// Run:  npx tsx tests/lead-look-again.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const FN = read('netlify/functions/lead-generation.ts');
const HUB = read('src/components/assistant-data-hub.js');
const WORKER = read('netlify/functions/process-discovery-jobs.ts');

// ⚠️ The end anchor is the action that IMMEDIATELY follows look_again, not some later one. It was
// `set_outcome`, and `send_back_for_enrichment` was then added between the two — which silently
// widened this span to cover both actions. The count below went from 2 to 4 and the failure read as
// look_again having grown a duplicate write, when nothing about look_again had changed at all.
// Anchor spans on their true neighbour, and re-check this line when an action is inserted here.
const ACTION = FN.slice(
    landmark(FN, "if (action === 'look_again')"),
    landmark(FN, "if (action === 'send_back_for_enrichment')"),
);

console.log('\n──── it clears the stamp the WORKER reads ────');

check('the action exists and is reachable', () => {
    assert.ok(ACTION.length > 200, "the look_again action is missing from lead-generation.ts");
});

check('it clears discovered_leads, not just the mirrored record', () => {
    // The failure that would make this feature a no-op with a satisfying chip change.
    assert.ok(/update\(discoveredLeads\)/.test(ACTION),
        'nothing updates discovered_leads — enrichBatch would never see this lead again');
    assert.ok(/- 'enrichAttemptedAt'/.test(ACTION),
        "the jsonb key must be REMOVED with `-`; setting it null leaves an explicit null to merge around forever");
});

check('it clears the mirror too, so the column and the aggregate agree', () => {
    assert.ok(/update\(assistantRecords\)/.test(ACTION),
        'the record keeps its stamp — the Contact column would still read "None found" over a re-queued lead');
    // Both writes remove the key IN the database. Writing back an object read a few statements
    // earlier would discard anything the Review Queue, the Edit form or the worker's mirror
    // committed in between — this record has four writers.
    const removals = ACTION.match(/- 'enrichAttemptedAt'/g) || [];
    assert.equal(removals.length, 2,
        'both the discovered_leads row and the mirrored record must drop the key with the jsonb `-` operator, not a read-modify-write');
});

check('the stamp it clears is exactly the one enrichBatch filters on', () => {
    // If the worker's predicate moves, clearing this key re-queues nothing.
    assert.ok(/signals ->> 'enrichAttemptedAt' IS NULL/.test(WORKER),
        'enrichBatch no longer filters on the attempt stamp — look_again may now be a no-op');
});

console.log('\n──── it refuses rather than pretending ────');

check('a lead that already has an address is refused', () => {
    assert.ok(/already has an address/.test(ACTION), 'nothing to look for, and re-scraping would risk overwriting it');
});

check('a hand-added lead is refused, with the reason', () => {
    // No discovered_leads row means no site was ever on file. Reporting success here would be a
    // cleared stamp on a table that has no row to clear.
    assert.ok(/if \(!lead\)/.test(ACTION), 'a lead with no discovery row is treated as re-queueable');
    assert.ok(/added by hand rather than found by a search/.test(ACTION),
        'the refusal must say why, or it reads as a bug');
});

check('a lead with no domain is refused', () => {
    assert.ok(/if \(!lead\.domain\)/.test(ACTION), 'there is no site to read — the scrape would skip it');
});

check('the rating gate mirrors what the worker actually scrapes', () => {
    // enrichBatch visits `rating IN ('hot','warm')` only. Clearing a cold lead's stamp would leave
    // it looking eligible and never visited.
    assert.ok(/rating !== 'hot' && lead\.rating !== 'warm'/.test(ACTION),
        'a cold lead would be re-queued into a batch that filters it out on rating');
    assert.ok(/rating IN \('hot','warm'\)/.test(WORKER), "the worker's rating filter moved — re-check this gate");
});

check('a lead outside the active set is refused', () => {
    assert.ok(/status !== 'promoted'/.test(ACTION), 'enrichBatch only visits promoted leads');
    assert.ok(/status = 'promoted'/.test(WORKER), "the worker's status filter moved — re-check this gate");
});

check('every lookup is scoped to the caller’s organisation', () => {
    assert.ok(/eq\(assistantRecords\.organisationId, orgId\)/.test(ACTION), 'the record read is not tenant-scoped');
    assert.ok(/eq\(discoveredLeads\.organisationId, orgId\)/.test(ACTION),
        'the discovered_leads read is not tenant-scoped — an assistantRecordId alone would cross tenants');
});

console.log('\n──── the button says what actually happens ────');

const BTN = HUB.slice(landmark(HUB, "label: 'Look again'"), landmark(HUB, "label: 'Edit'"));

check('it is offered only where a stamp exists to clear', () => {
    // 'missed' and 'checking' are unstamped by definition and 'unchecked' is a cold lead — on all
    // three the button would clear nothing while looking like it did something.
    assert.ok(/contactState\(record\) === 'none'/.test(HUB),
        'Look again is offered on states that carry no attempt stamp');
});

check('it does not claim a lookup is happening', () => {
    assert.ok(/next time this search runs/.test(BTN),
        'the copy must say the lookup happens on the next run — nothing here schedules one');
    assert.ok(!/(looking now|checking now|scanning|we are reading)/i.test(BTN),
        'the copy implies work is under way; enrichment only runs inside a live discovery job');
});

check('a server refusal reaches the user verbatim', () => {
    // The server refuses for reasons the browser cannot evaluate — discovery provenance, the
    // discovery-side rating, whether a domain is on file. A generic "something went wrong" would
    // strip exactly the part that tells the user what to do instead.
    assert.ok(/data\.error \|\|/.test(BTN), 'the server’s sentence is discarded in favour of a generic message');
});

check('the row is refreshed so the chip stops saying "None found"', () => {
    assert.ok(/delete record\.data\.enrichAttemptedAt/.test(BTN), 'the local record keeps a stamp the server just cleared');
    assert.ok(/refreshRow\(record\)/.test(BTN), 'the table still shows the pre-action state');
});

console.log(`\n${passed} checks passed.`);
