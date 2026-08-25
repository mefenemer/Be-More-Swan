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
import { landmark } from './landmark';
import {
    CONTACT_AGGREGATE_SCOPE_SQL,
    CONTACT_BUCKETS,
    CONTACT_BUCKET_SQL,
    CONTACT_STATE_TO_BUCKET,
    ENRICH_ELIGIBLE_SQL,
    PAID_ENRICH_ELIGIBLE_SQL,
    LIVE_JOB_SQL,
    contactBucketOf,
    isEnrichEligible,
    isPaidEnrichEligible,
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
    const emailFn = HUB.slice(landmark(HUB, 'function contactEmailOf'), landmark(HUB, '/**', landmark(HUB, 'function contactEmailOf')));
    const start = HUB.indexOf('function contactState');
    assert.ok(start !== -1, 'contactState() is gone — the column no longer derives its state');
    const stateFn = HUB.slice(start, landmark(HUB, '\n  }', start) + 4);
    return new Function(`${emailFn}\n${stateFn}\nreturn contactState;`)() as (r: Record<string, unknown>) => string;
}

/** Lift the aggregate sentence builder out of the Searches component. */
function loadAggregateLine(): (s: Record<string, unknown>) => string {
    const start = INBOX.indexOf('function contactAggregateLine');
    assert.ok(start !== -1, 'contactAggregateLine() is gone — the Searches tab states no aggregate');
    const fn = INBOX.slice(start, landmark(INBOX, '\n  }', start) + 4);
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
    // ⚠️ prospectType is now half of the eligibility rule, so it belongs in the cross-product.
    // Without it the matrix could not tell a cold directory from a cold company, which is the
    // whole of the 2026-08-25 change.
    const prospectTypes = [null, 'target_business', 'aggregator', 'content_page'];
    const inFlight = [true, false];

    for (const contactEmail of emails) {
        for (const enrichAttemptedAt of stamps) {
            for (const rating of ratings) {
                for (const prospectType of prospectTypes) {
                    for (const enrichmentInFlight of inFlight) {
                        // The column reads the mirrored record, where `data` IS the scoring card.
                        const column = contactState({ status: rating, enrichmentInFlight, data: { contactEmail, enrichAttemptedAt, prospectType } });
                        const bucket = contactBucketOf({ contactEmail, enrichAttemptedAt, rating, prospectType, enrichmentInFlight });
                        assert.equal(
                            bucket, CONTACT_STATE_TO_BUCKET[column],
                            `drift for email=${JSON.stringify(contactEmail)} stamp=${!!enrichAttemptedAt} rating=${rating} type=${prospectType} live=${enrichmentInFlight}: ` +
                            `column says "${column}" (→ ${CONTACT_STATE_TO_BUCKET[column]}), aggregate says "${bucket}"`,
                        );
                    }
                }
            }
        }
    }
});

check('rating is NOT part of the rule — §5, 2026-08-25', () => {
    // The customer's principle: "Emails should be found for all leads irrespective of cold or not,
    // as the user can then determine themselves whether to contact a cold lead. This is not for us
    // to decide." Agreed for COLD. Not agreed for NOT-A-COMPANY, which is the whole of the rule now.
    //
    // The defect it closes: 95 of one tenant's 500 leads were ever offered a lookup, and 68% of
    // those yielded an address. The gate was the bottleneck, never the lookup.
    const noAddress = { contactEmail: null, enrichAttemptedAt: null } as const;
    for (const rating of ['hot', 'warm', 'cold', null, 'something_new']) {
        assert.equal(contactBucketOf({ ...noAddress, rating, prospectType: 'target_business', enrichmentInFlight: true }), 'pending',
            `a ${rating} company must be looked up — rating is the user's call, not the pipeline's`);
        // Unclassified: legacy (scored before the gate shipped) or unscored (§4.2). Free to read.
        assert.equal(contactBucketOf({ ...noAddress, rating, prospectType: null, enrichmentInFlight: true }), 'pending',
            `an unclassified ${rating} lead must still be READ — it might be a company`);
    }
    // …and the things no address can turn into a customer are still refused, at every rating.
    for (const junk of ['aggregator', 'media', 'content_page', 'platform', 'supplier_to_target']) {
        for (const rating of ['hot', 'cold', null]) {
            assert.equal(contactBucketOf({ ...noAddress, rating, prospectType: junk, enrichmentInFlight: true }), 'notAttempted',
                `a ${rating} ${junk} has nobody to email`);
        }
    }
});

check('PAYING is gated narrower than READING', () => {
    // ⚠️ Two gates, deliberately different. Reading a site costs seconds; buying an address costs
    // money, and paidLookupAt is stamped on a MISS too — it counts money spent, not addresses
    // found. So an unclassified lead is read for free and never bought for.
    assert.ok(isEnrichEligible({ prospectType: null }), 'an unclassified lead must be READ');
    assert.ok(!isPaidEnrichEligible({ prospectType: null }), 'an unclassified lead must never be BOUGHT for');
    assert.ok(isEnrichEligible({ prospectType: 'target_business' }) && isPaidEnrichEligible({ prospectType: 'target_business' }));
    for (const junk of ['aggregator', 'media', 'content_page', 'platform', 'supplier_to_target']) {
        assert.ok(!isEnrichEligible({ prospectType: junk }) && !isPaidEnrichEligible({ prospectType: junk }));
    }
});

check('"Checking…" requires a live job — it is a claim, not a default', () => {
    // Phase 2 item 11. This chip promises work is queued. `enrichBatch()` only ever runs inside a
    // live job, so with every job terminal the promise cannot be kept and the column said it
    // anyway, indefinitely. Absent evidence, understate.
    const hotNoStamp = { status: 'hot', data: { contactEmail: null, enrichAttemptedAt: null } };
    assert.equal(contactState({ ...hotNoStamp, enrichmentInFlight: true }), 'checking');
    assert.equal(contactState({ ...hotNoStamp, enrichmentInFlight: false }), 'missed');
    assert.equal(contactState(hotNoStamp), 'missed', 'an absent flag must not promise a lookup');
    // ⚠️ §5: a COLD lead is no longer unaffected — it is read like any other possible company, so
    // it follows the same live-job split. Only a confirmed non-company sits outside it.
    const coldCompany = { status: 'cold', data: { prospectType: 'target_business' } };
    assert.equal(contactState({ ...coldCompany, enrichmentInFlight: true }), 'checking');
    assert.equal(contactState({ ...coldCompany, enrichmentInFlight: false }), 'missed');
    for (const live of [true, false]) {
        assert.equal(contactState({ status: 'cold', enrichmentInFlight: live, data: { prospectType: 'aggregator' } }), 'unchecked',
            'a directory has nobody to email, whatever is running');
    }
});

check('the missed chip explains itself, and every no-address chip does', () => {
    // A bare "Not attempted" reads as "the product is broken". The reason is what makes it a next
    // action, and it is the tooltip only because the address occupies that slot when there is one.
    const HUB_SRC = read('src/components/assistant-data-hub.js');
    for (const chip of ['none', 'checking', 'unchecked', 'missed']) {
        const re = new RegExp(`${chip}: \\{[^}]*why:`, 's');
        assert.ok(re.test(HUB_SRC), `the "${chip}" chip carries no explanation`);
    }
    // Matched on the ordering, not the whole expression: item 7 appends the social-profile hint to
    // the same fallback, and pinning the exact text would break on every future addition to it.
    assert.ok(/const tip = email \|\|[^\n]*s\.why/.test(HUB_SRC),
        'the tooltip no longer falls back to the reason when there is no address');
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
    for (const chip of ['role', 'personal', 'none', 'checking', 'unchecked', 'missed']) {
        assert.ok(chips.includes(chip), `the column renders "${chip}" but the aggregate does not map it`);
    }
});

check('the buckets partition the population — exactly one per lead', () => {
    // The copy states the counts as parts of a total, so a lead falling into two buckets (or none)
    // would make the sentence not add up on screen.
    for (const contactEmail of [null, 'a@b.com']) {
        for (const enrichAttemptedAt of [null, 'x']) {
            for (const rating of ['hot', 'warm', 'cold', null, 'weird']) {
                for (const prospectType of [null, 'target_business', 'media', 'nonsense']) {
                    for (const enrichmentInFlight of [true, false]) {
                        const hits = CONTACT_BUCKETS.filter((b) => contactBucketOf({ contactEmail, enrichAttemptedAt, rating, prospectType, enrichmentInFlight }) === b);
                        assert.equal(hits.length, 1, `rating=${rating} type=${prospectType} email=${contactEmail} stamp=${enrichAttemptedAt} live=${enrichmentInFlight} landed in ${hits.length} buckets`);
                    }
                }
            }
        }
    }
});

check('an unexpected rating stays inside the total', () => {
    // ⚠️ CHANGED 2026-08-25 with the gate. Eligibility used to be "not cold", so an unrated lead
    // fell through to the hot/warm pair and read "Checking…" — an over-promise chosen over
    // dropping the row from the arithmetic. It is now a POSITIVE test, so an unrated, unclassified
    // lead reads `notAttempted`, which is not a fallthrough at all: it is what the worker will
    // genuinely do with it. The row is still counted, which is the invariant this check defends.
    // ⚠️ §5: an unrecognised rating no longer decides anything — the rule reads prospect type only.
    assert.equal(contactBucketOf({ rating: null, enrichmentInFlight: true }), 'pending');
    assert.equal(contactBucketOf({ rating: 'something_new', enrichmentInFlight: true }), 'pending');
    assert.equal(contactBucketOf({ rating: null, prospectType: 'target_business' }), 'missed', 'no live job means no promise');
    assert.equal(contactBucketOf({ rating: 'something_new', prospectType: 'media', enrichmentInFlight: true }), 'notAttempted');
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
    assert.ok(CONTACT_BUCKET_SQL.notAttempted.includes(`NOT ${ENRICH_ELIGIBLE_SQL}`),
        'notAttempted must be the negation of the SAME eligibility rule the worker selects on');
    for (const b of ['pending', 'missed'] as const) {
        assert.ok(CONTACT_BUCKET_SQL[b].includes(ENRICH_ELIGIBLE_SQL), `${b} must require an eligible lead`);
    }
    // ⚠️ §5: the rule reads PROSPECT TYPE ONLY. A rating anywhere in it is the old defect coming
    // back — cold companies stop being looked up, which is where this whole thread started.
    assert.ok(/prospectType/.test(ENRICH_ELIGIBLE_SQL), 'the eligibility rule no longer reads prospect type');
    assert.ok(!/rating/.test(ENRICH_ELIGIBLE_SQL),
        'rating is back in the eligibility rule — that is the defect that stranded 89 cold companies');
    assert.ok(/= 'target_business'/.test(PAID_ENRICH_ELIGIBLE_SQL), 'the paid gate no longer requires a confirmed company');
    for (const junk of ['aggregator', 'media', 'content_page', 'platform', 'supplier_to_target']) {
        assert.ok(ENRICH_ELIGIBLE_SQL.includes(`'${junk}'`), `${junk} is no longer excluded from the scrape`);
    }
    // The item-11 split: identical leads, separated only by whether a job is live.
    assert.ok(CONTACT_BUCKET_SQL.pending.includes(LIVE_JOB_SQL), 'pending must require a live job');
    assert.ok(CONTACT_BUCKET_SQL.missed.includes(`NOT ${LIVE_JOB_SQL}`), 'missed must require NO live job');
    assert.ok(/status IN \('queued','processing'\)/.test(LIVE_JOB_SQL),
        "a sliced run RESTS at 'queued' — dropping it would flip every in-flight lead to Not attempted");
    assert.ok(/rejected|discarded/.test(CONTACT_AGGREGATE_SCOPE_SQL), 'rejected leads must be out of scope');
});

check('the aggregate still matches what the worker actually scrapes', () => {
    // `notAttempted` asserts nobody will ever look this lead up. That is only true while the
    // worker selects on the SAME predicate — widen one and this line starts claiming nobody
    // looked at leads that were looked at. Same coupling tests/lead-contact-column.test.ts
    // defends for the chips.
    //
    // ⚠️ Asserting the worker IMPORTS the shared constant, not that it contains the SQL text. The
    // rule was hand-typed in four places and drifted; pinning the string here would let a fifth
    // copy satisfy this check while the shared definition moved underneath it.
    assert.ok(/ENRICH_ELIGIBLE_SQL/.test(WORKER),
        'enrichBatch no longer selects on the shared eligibility rule');
    assert.ok(/from '\.\.\/\.\.\/src\/config\/lead-contact-state'/.test(WORKER),
        'the worker no longer imports lead-contact-state — the rule has been re-typed somewhere');
    assert.ok(!/rating IN \('hot','warm'\)/.test(WORKER),
        'a hand-typed hot/warm filter is back in the worker — that is the drift this file exists to stop');
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
        'Contact details for 4 of 65 — 9 publish none, 52 were not companies you could sell to, so were never checked.',
    );
    // Campaign 1, same database: 20 found, not one of them worth a scrape. The line diagnoses
    // targeting without the user having to open a single lead.
    assert.equal(
        agg({ contactTotal: 20, contactNotAttempted: 20 }),
        'Contact details for 0 of 20 — 20 were not companies you could sell to, so were never checked.',
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
        'Contact details for 1 of 3 — 1 publishes none, 1 was not a company you could sell to, so was never checked.');
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
    const completed = INBOX.slice(from, landmark(INBOX, '\n    }', from));
    assert.ok(/contactAggregateLine\(s\)/.test(completed),
        'the completed branch no longer states the aggregate');
    const before = INBOX.slice(landmark(INBOX, 'function searchState'), landmark(INBOX, "if (job === 'completed')"));
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
    const states = INBOX.slice(landmark(INBOX, 'function searchState'), landmark(INBOX, 'function searchRow'));
    assert.equal((states.match(/reach:/g) || []).length, 1, 'only the completed state may carry `reach`');
});

console.log(`\n${passed} checks passed.`);
