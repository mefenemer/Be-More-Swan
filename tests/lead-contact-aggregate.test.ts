// tests/lead-contact-aggregate.test.ts
// The Searches tab's reachability line — "Contact details for 4 of 65 — 20 publish none, 41
// scored cold so were never checked." (Phase 2 item 8 of docs/lead-triage-review-split-plan.md.)
//
// ⚠️ THE INVARIANT THIS EXISTS FOR: the aggregate and the Leads tab's Contact column must never
// disagree. They are computed in different languages on different tiers — server-side SQL over
// `discovered_leads`, versus `contactState()` inside a browser IIFE over `assistant_records.data`
// — and they sit one click apart, so a user comparing "20 publish none" against the chips in the
// table below will find any drift immediately. A number that contradicts the table it summarises
// is worse than no number: it teaches the user not to trust either.
//
// The shared definitions live in src/config/lead-contact-state.ts. This file runs the REAL
// contactState() out of the component and asserts it agrees with contactBucketOf() across the
// whole fixture matrix, so the two can only drift by making this fail.
//
// No database and no DOM: the component is an IIFE with no exports, so its logic is read as source
// and re-evaluated here, in the same style as tests/lead-contact-column.test.ts.
// Run:  npx tsx tests/lead-contact-aggregate.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONTACT_AGGREGATE_SCOPE_SQL,
    CONTACT_BUCKETS,
    CONTACT_BUCKET_SQL,
    CONTACT_STATE_TO_BUCKET,
    contactBucketOf,
    type ContactBucket,
} from '../src/config/lead-contact-state';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const HUB = read('src/components/assistant-data-hub.js');
const INBOX = read('src/components/assistant-signal-inbox.js');
const API = read('netlify/functions/signal-inbox.ts');
const WORKER = read('netlify/functions/process-discovery-jobs.ts');

/** Lift `contactState` + `contactEmailOf` out of the IIFE and run them for real. */
function loadContactState(): (r: Record<string, unknown>) => string {
    const emailFn = HUB.slice(HUB.indexOf('function contactEmailOf'), HUB.indexOf('/**', HUB.indexOf('function contactEmailOf')));
    const start = HUB.indexOf('function contactState');
    assert.ok(start !== -1, 'contactState() is gone — the column no longer derives its state');
    const stateFn = HUB.slice(start, HUB.indexOf('\n  }', start) + 4);
    return new Function(`${emailFn}\n${stateFn}\nreturn contactState;`)() as (r: Record<string, unknown>) => string;
}

/** Lift the aggregate sentence builder out of the Searches component. */
function loadAggregateLine(): (s: Record<string, unknown>) => string {
    const start = INBOX.indexOf('function contactAggregateLine');
    assert.ok(start !== -1, 'contactAggregateLine() is gone — the Searches tab states no aggregate');
    const fn = INBOX.slice(start, INBOX.indexOf('\n  }', start) + 4);
    return new Function(`${fn}\nreturn contactAggregateLine;`)() as (s: Record<string, unknown>) => string;
}

const contactState = loadContactState();
const contactAggregateLine = loadAggregateLine();

// ── The coupling: one lead, two tiers, one answer ─────────────────────────────

check('contactBucketOf agrees with the Contact column on every shape', () => {
    // The full cross-product of the three facts the decision is made from. The column reads the
    // mirrored record (status = rating, data.* = the enrichment stamps); the aggregate reads the
    // discovered_leads row. Same lead, expressed as each tier sees it.
    const emails = [null, '', '   ', 'hello@acme.co.uk'];
    const stamps = [null, '2026-08-12T10:00:00.000Z'];
    const ratings = ['hot', 'warm', 'cold'];

    for (const contactEmail of emails) {
        for (const enrichAttemptedAt of stamps) {
            for (const rating of ratings) {
                const column = contactState({ status: rating, data: { contactEmail, enrichAttemptedAt } });
                const bucket = contactBucketOf({ contactEmail, enrichAttemptedAt, rating });
                assert.equal(
                    bucket, CONTACT_STATE_TO_BUCKET[column],
                    `drift for email=${JSON.stringify(contactEmail)} stamp=${!!enrichAttemptedAt} rating=${rating}: ` +
                    `column says "${column}" (→ ${CONTACT_STATE_TO_BUCKET[column]}), aggregate says "${bucket}"`,
                );
            }
        }
    }
});

check('every Contact chip maps to a bucket, and every bucket is reachable', () => {
    // A chip with no bucket would be silently uncounted; a bucket no chip maps to would be a
    // number the table can never corroborate.
    const chips = Object.keys(CONTACT_STATE_TO_BUCKET);
    for (const chip of chips) {
        assert.ok(CONTACT_BUCKETS.includes(CONTACT_STATE_TO_BUCKET[chip]), `chip "${chip}" maps outside the vocabulary`);
    }
    const mapped = new Set(Object.values(CONTACT_STATE_TO_BUCKET));
    for (const b of CONTACT_BUCKETS) assert.ok(mapped.has(b), `no Contact chip ever produces "${b}"`);
    // The five chips the column actually defines.
    for (const chip of ['role', 'personal', 'none', 'checking', 'unchecked']) {
        assert.ok(chips.includes(chip), `the column renders "${chip}" but the aggregate does not map it`);
    }
});

check('the buckets partition the population — exactly one per lead', () => {
    // The copy states the counts as parts of a total, so a lead falling into two buckets (or none)
    // would make the sentence not add up on screen.
    for (const contactEmail of [null, 'a@b.com']) {
        for (const enrichAttemptedAt of [null, 'x']) {
            for (const rating of ['hot', 'warm', 'cold', null, 'weird']) {
                const hits = CONTACT_BUCKETS.filter((b) => contactBucketOf({ contactEmail, enrichAttemptedAt, rating }) === b);
                assert.equal(hits.length, 1, `rating=${rating} email=${contactEmail} stamp=${enrichAttemptedAt} landed in ${hits.length} buckets`);
            }
        }
    }
});

check('an unexpected rating falls into "still to check", never out of the total', () => {
    assert.equal(contactBucketOf({ rating: null }), 'pending');
    assert.equal(contactBucketOf({ rating: 'something_new' }), 'pending');
});

// ── The SQL mirror ────────────────────────────────────────────────────────────

check('the SQL is built from the shared predicates, not typed out in the query', () => {
    assert.ok(/CONTACT_BUCKET_SQL/.test(API), 'signal-inbox.ts no longer imports the shared predicates');
    assert.ok(/CONTACT_AGGREGATE_SCOPE_SQL/.test(API), 'the aggregate scope has been inlined');
    for (const b of CONTACT_BUCKETS) {
        assert.ok(API.includes(`CONTACT_BUCKET_SQL.${b}`), `the query never counts "${b}"`);
    }
});

check('every predicate reads the same three fields as the JS mirror', () => {
    for (const b of CONTACT_BUCKETS) {
        assert.ok(/dl\.contact_email/.test(CONTACT_BUCKET_SQL[b]), `${b} does not test the address`);
    }
    assert.ok(/enrichAttemptedAt/.test(CONTACT_BUCKET_SQL.nonePublished), 'nonePublished must key off the attempt stamp');
    assert.ok(/dl\.rating = 'cold'/.test(CONTACT_BUCKET_SQL.notAttempted), 'notAttempted must key off a cold rating');
    assert.ok(/rejected|discarded/.test(CONTACT_AGGREGATE_SCOPE_SQL), 'rejected leads must be out of scope');
});

check('the aggregate still matches what the worker actually scrapes', () => {
    // `notAttempted` asserts a cold lead is never attempted. That is only true while enrichBatch
    // filters to hot/warm — widen it and this line starts claiming nobody looked at leads that
    // were looked at. Same coupling tests/lead-contact-column.test.ts defends for the chips.
    assert.ok(/rating IN \('hot','warm'\)/.test(WORKER), 'enrichBatch no longer scrapes hot/warm only');
    assert.ok(/enrichAttemptedAt/.test(WORKER), 'the worker no longer stamps the attempt');
});

// ── The sentence ──────────────────────────────────────────────────────────────

const agg = (o: Partial<Record<string, number>>) => contactAggregateLine({
    contactTotal: 0, contactReachable: 0, contactNonePublished: 0, contactNotAttempted: 0, contactPending: 0, ...o,
});

check('states the prod run this was built for', () => {
    // Campaign 2 as it actually stands, measured 2026-08-12: 65 leads, 4 reachable, 9 sites read
    // and publishing nothing, 52 cold and therefore never attempted. This is the sentence that
    // turns "Review only has 3 things in it" into "and here is why".
    assert.equal(
        agg({ contactTotal: 65, contactReachable: 4, contactNonePublished: 9, contactNotAttempted: 52 }),
        'Contact details for 4 of 65 — 9 publish none, 52 scored cold so were never checked.',
    );
    // Campaign 1, same database: 20 found, not one of them worth a scrape. The line diagnoses
    // targeting without the user having to open a single lead.
    assert.equal(
        agg({ contactTotal: 20, contactNotAttempted: 20 }),
        'Contact details for 0 of 20 — 20 scored cold so were never checked.',
    );
});

check('says nothing at all for a search with no leads', () => {
    assert.equal(agg({}), '', '"0 of 0" is noise next to a line already saying nothing was found');
});

check('omits clauses that are zero', () => {
    assert.equal(agg({ contactTotal: 3, contactReachable: 3 }), 'Contact details for 3 of 3.');
    assert.equal(agg({ contactTotal: 5, contactReachable: 2, contactNonePublished: 3 }),
        'Contact details for 2 of 5 — 3 publish none.');
});

check('reads correctly in the singular', () => {
    assert.equal(agg({ contactTotal: 3, contactReachable: 1, contactNonePublished: 1, contactNotAttempted: 1 }),
        'Contact details for 1 of 3 — 1 publishes none, 1 scored cold so was never checked.');
});

check('names work still in progress rather than calling it a result', () => {
    assert.equal(agg({ contactTotal: 10, contactReachable: 1, contactPending: 9 }),
        'Contact details for 1 of 10 — 9 still to check.');
});

check('the line is only shown on a finished run', () => {
    // Mid-run the counts are still climbing (enriching is the last stage) and on a failed run they
    // describe a pipeline that stopped early. Either would be true of the database and misleading
    // about the search.
    // Bounded by the branch's own closing brace rather than a character count — a comment added
    // inside the branch must not be able to fail this.
    const from = INBOX.indexOf("if (job === 'completed')");
    assert.ok(from !== -1, 'the completed branch is gone');
    const completed = INBOX.slice(from, INBOX.indexOf('\n    }', from));
    assert.ok(/contactAggregateLine\(s\)/.test(completed),
        'the completed branch no longer states the aggregate');
    const before = INBOX.slice(INBOX.indexOf('function searchState'), INBOX.indexOf("if (job === 'completed')"));
    assert.ok(!/contactAggregateLine/.test(before),
        'the aggregate has leaked into an in-flight, queued or failed state');
});

check('the aggregate renders as its own line, not glued to the cadence', () => {
    // Appended to `line` it read as three unrelated sentences in one grey paragraph — the count,
    // the reachability answer and the schedule — and the middle one is the reason the row exists.
    assert.ok(/reach: contactAggregateLine\(s\)/.test(INBOX), 'the aggregate is no longer a separate field');
    assert.ok(/st\.reach \? `<p[^`]*>\$\{esc\(st\.reach\)\}<\/p>`/.test(INBOX),
        'searchRow no longer renders the aggregate in its own escaped element');
    // Every other state must leave the field unset, so no other row grows a second line.
    const states = INBOX.slice(INBOX.indexOf('function searchState'), INBOX.indexOf('function searchRow'));
    assert.equal((states.match(/reach:/g) || []).length, 1, 'only the completed state may carry `reach`');
});

console.log(`\n${passed} checks passed.`);
