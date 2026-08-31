// tests/discovery-paid-enrichment.test.ts
// Tier 2: buying a contact address when reading the company's own site found nothing.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Measured on a real prod run (2026-08-12): 64 leads in the Leads tab, 4 with an address. The
// free scraper attempts hot/warm leads only and hits roughly one in three of those, so the Review
// Queue — which can only hold leads that HAVE an address — was near-empty by construction. Every
// tool in the market solves this by buying the data.
//
// ⚠️ THE INVARIANTS WORTH DEFENDING, in the order they can hurt someone:
//
//   1. A PURCHASED PERSONAL ADDRESS MUST STILL BE GATED. Both confirmation gates used to test
//      `emailSource === 'scrape'` literally. A bought address carries 'provider', matches neither,
//      and a named individual whose details we paid a broker for would be emailed with no
//      confirmation at all — worse than the scraped case the gate was built for, not lesser.
//      The predicate is now "the user did not type it", so a source added later is gated by
//      DEFAULT rather than by someone remembering.
//
//   2. NOTHING IS BOUGHT UNLESS A PROVIDER IS NAMED. Unlike search, which defaults to Serper,
//      this defaults to OFF: it spends money per lookup on a third party's data about a person.
//
//   3. THE FREE SCRAPE RUNS FIRST. Paying for the ~1/3 of domains the scraper already covers is
//      spending money on data we have.
//
//   4. THE CAP COUNTS ATTEMPTS, NOT HITS. A miss costs exactly as much as a find.
//
//   5. ROLE ADDRESSES ARE PREFERRED OVER NAMED INDIVIDUALS — the opposite of what a vendor's own
//      ranking optimises for, because a generic desk address is the defensible lane for cold B2B
//      outreach and a named one trips gate 1.
//
// Run:  npx tsx tests/discovery-paid-enrichment.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsPersonalInboxConfirmation, emailSourceLabel } from '../src/config/lead-email-kind';
import { isEnrichProviderConfigured, lookupProviderContact } from '../src/lib/discovery-enrich-provider';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const WORKER = stripComments(read('netlify/functions/process-discovery-jobs.ts'));
// The persistence half of enrichment — `recordEnrichment`, which writes the paidLookupAt stamp the
// cap counts — moved to src/utils/lead-enrichment.ts so the on-demand "Send back for enrichment"
// path and the worker share one writer. The waterfall ORDERING below still belongs to the worker;
// only the stamp checks follow the function to its new home.
const ENRICH = stripComments(read('src/utils/lead-enrichment.ts'));
const PROVIDER = stripComments(read('src/lib/discovery-enrich-provider.ts'));
const SEND = stripComments(read('netlify/functions/lead-generation.ts'));
const INBOX = stripComments(read('netlify/functions/signal-inbox.ts'));
const SCHEMA = read('db/schema.ts');
const DDL = read('db/discovery-enrichment-cap.sql');

// ── 1. The gate, which is the part that can email a real person ──────────────

check('a PURCHASED personal address still needs confirmation', () => {
    assert.equal(needsPersonalInboxConfirmation('personal', 'provider'), true,
        'a bought address for a named individual would be emailed with no confirmation');
    assert.equal(needsPersonalInboxConfirmation('personal', 'scrape'), true);
});

check('a hand-typed address does NOT — the user already knows whose inbox it is', () => {
    assert.equal(needsPersonalInboxConfirmation('personal', 'manual'), false);
});

check('role addresses are never gated, whatever their provenance', () => {
    for (const src of ['scrape', 'manual', 'provider']) {
        assert.equal(needsPersonalInboxConfirmation('role', src), false, `role/${src} should not be gated`);
    }
});

check('an unknown future source is gated by DEFAULT', () => {
    // The whole reason the predicate is "not manual" rather than a list of gated sources.
    assert.equal(needsPersonalInboxConfirmation('personal', 'some_new_vendor'), true,
        'a source added later must be gated until someone deliberately exempts it');
});

check('both enforcement points use the shared predicate, not a literal', () => {
    assert.ok(/needsPersonalInboxConfirmation\(emailKind, emailSource\)/.test(SEND),
        'lead-generation.ts send gate no longer uses the shared predicate');
    assert.ok(/needsPersonalInboxConfirmation\(emailKind, emailSource\)/.test(INBOX),
        'signal-inbox.ts no longer uses the shared predicate');
    assert.ok(!/emailSource === 'scrape'/.test(SEND) && !/emailSource === 'scrape'/.test(INBOX),
        "a literal 'scrape' comparison is back — a purchased address would bypass it");
});

check('a purchased address states its origin to the reviewer', () => {
    // ⚠️ The recipient line originally read `emailSource === 'scrape' ? ' · found on their
    // website' : ''`, so a BOUGHT address rendered with no origin at all — the one provenance a
    // reviewer most needs before approving an email to a named individual.
    const ASSISTANTS = stripComments(read('assistants.js'));
    const GENERATED = read('src/generated/platform-constants.js');
    assert.ok(/EK\.sourceLabel\(d\.emailSource\)/.test(ASSISTANTS),
        'the recipient line no longer reads the shared provenance vocabulary');
    assert.ok(!/const scraped = d\.emailSource === 'scrape'/.test(ASSISTANTS),
        "the literal 'scrape' test is back — a purchased address would render with no origin");
    assert.ok(/EK\.needsConfirmation\(d\.emailKind, d\.emailSource\)/.test(ASSISTANTS),
        'the warning no longer uses the same predicate the server enforces');
    // And the browser must actually HAVE them.
    assert.ok(/sourceLabel: emailSourceLabel/.test(GENERATED) && /needsConfirmation: needsPersonalInboxConfirmation/.test(GENERATED),
        'window.LeadEmailKind is missing the provenance helpers — run npm run gen:constants');
});

check('every EmailSource has a provenance label, and only manual is silent', () => {
    assert.equal(emailSourceLabel('scrape'), 'found on their website');
    assert.equal(emailSourceLabel('provider'), 'from a paid data provider');
    assert.equal(emailSourceLabel('manual'), '', 'the user typed it — telling them where it came from is noise');
    assert.equal(emailSourceLabel('nonsense'), '', 'an unknown source must not throw or invent a label');
});

// ── 2. Off by default ────────────────────────────────────────────────────────

check('no provider is configured in this environment, so nothing is bought', () => {
    // The default state, and the one the whole test suite runs in.
    assert.equal(isEnrichProviderConfigured(), false,
        'a provider is configured during tests — the suite would make paid calls');
});

check('the provider defaults to none, unlike search which defaults to serper', () => {
    assert.ok(/DISCOVERY_ENRICH_PROVIDER \?\? 'none'/.test(PROVIDER),
        'the provider no longer defaults to off — a key appearing in the env would start billing');
});

check('every failure path is REPORTED as an error rather than thrown', () => {
    // A paid lookup is an enhancement to a pipeline that already works without it.
    assert.ok(/catch \(err\) \{[\s\S]{0,400}return \{ status: 'error', reason \};/.test(PROVIDER),
        'the HTTP path can throw');
    assert.ok(/if \(!res\.ok\)/.test(PROVIDER), 'a non-200 is not handled');
    assert.ok(/\.catch\(\(\) => null\)/.test(PROVIDER), 'a malformed body is not handled');
});

// ── 2b. Error is not miss — the invariant the 2026-08-27 outage broke ─────────
//
// ⚠️ THIS IS THE ONE THAT COST A CUSTOMER THEIR PIPELINE. The Hunter account ran out of credits
// mid-afternoon; 172 lookups came back with nothing; the worker recorded every one as "this
// company publishes no address", stamped them un-retryable and charged £1.46 of spend that never
// happened. The tenant then hand-deleted 104 schools on the strength of it. A provider that
// cannot answer must never be able to say something about the LEAD.

check('a provider that did not answer returns error, never miss', () => {
    // Every non-2xx: out of credits (429) and bad key (401) are the two that actually happen.
    assert.ok(/if \(!res\.ok\) \{[\s\S]{0,600}return \{ status: 'error', reason: `http_\$\{res\.status\}` \};/.test(PROVIDER),
        'an HTTP failure is being reported as a miss — an out-of-credits account would read as "no address published"');
    // A 200 whose body does not carry the array we map is a contract change, not an empty result.
    assert.ok(/if \(!Array\.isArray\(raw\)\) \{[\s\S]{0,400}return \{ status: 'error', reason: 'bad_body' \};/.test(PROVIDER),
        'an unparseable response settles the lead — a silent mapping break would look like a market with no emails');
    // Only a parsed, empty answer is a miss.
    assert.ok(/if \(!best\) return \{ status: 'miss' \};/.test(PROVIDER),
        'the genuine no-address case is no longer reported as a miss');
});

check('an error costs neither a cap slot nor a penny', () => {
    const i = landmark(WORKER, 'async function enrichBatch');
    const body = WORKER.slice(i, landmark(WORKER, 'async function publishSignals'));
    // The early return has to come BEFORE both the stamp and the charge, or the outage is
    // invisible again.
    const iErr = body.indexOf("if (outcome.status === 'error')");
    const iStamp = body.indexOf('s.paidAttempted = true;');
    const iCharge = body.indexOf('counters.costGbp += ENRICH_COST_GBP_PER_LOOKUP');
    assert.ok(iErr !== -1, 'the error outcome is not handled separately from a miss');
    assert.ok(iErr < iStamp && iErr < iCharge,
        'a failed lookup is still stamped as an attempt or charged to the run budget');
    assert.ok(/s\.paidFailedReason = outcome\.reason;/.test(body),
        'the failure reason is discarded — http_401 and http_429 would be indistinguishable');
});

check('a failed lookup is stamped distinctly, and never as a purchase', () => {
    assert.ok(/if \(paidFailedReason\) \{[\s\S]{0,300}stamp\.paidLookupFailedAt/.test(ENRICH),
        'a failed lookup writes no distinguishing stamp');
    // ⚠️ The two stamps must stay separate keys. paidLookupAt is what the per-run cap counts, and
    // the cap bounds SPEND — a rejected request costs nothing and must not consume a slot.
    assert.ok(!/paidLookupFailedAt[\s\S]{0,80}stamp\.paidLookupAt =/.test(ENRICH),
        'a failed lookup also writes paidLookupAt — the cap would count requests that cost nothing');
});

check('a stranded lead is re-queued once per run, from query_gen', () => {
    // ⚠️ CADENCE IS THE WHOLE SAFETY ARGUMENT. `enrichAttemptedAt` is still written on a provider
    // failure, because the enriching stage ends when no unstamped rows remain — leaving them
    // unstamped would mean a run with a dead provider never completes. So the retry is a sweep at
    // the START of the next run. Putting it anywhere in the enriching stage would un-settle the
    // rows that stage is settling, and the job would loop until the cron gave up.
    // ⚠️ ANCHOR ON CODE, NOT ON COMMENT BANNERS. WORKER is comment-stripped, so a `STAGE query_gen`
    // marker resolves to -1 and every ordering assertion below silently compares against it.
    const iGen = landmark(WORKER, 'if (!cursor || !Array.isArray(cursor.flat))');
    const iSweep = WORKER.indexOf("dl.signals ->> 'paidLookupFailedAt' IS NOT NULL");
    const iPromoting = landmark(WORKER, "if (state?.stage === 'promoting')");
    assert.ok(iSweep !== -1, 'the re-queue sweep is gone — a provider outage strands leads forever');
    assert.ok(iGen < iSweep && iSweep < iPromoting,
        'the sweep is not inside query_gen, the one branch that runs exactly once per job');
    // Both tables, record first: the second statement deletes the key the first selects on.
    const sweep = WORKER.slice(iGen, iPromoting);
    assert.ok(sweep.indexOf('UPDATE assistant_records') < sweep.indexOf('UPDATE discovered_leads'),
        'the discovery row is cleared first, so the record-side mirror can no longer be found');
});

// ── 3. Waterfall ordering and the cap ────────────────────────────────────────

check('the free scrape runs BEFORE any purchase', () => {
    const i = landmark(WORKER, 'async function enrichBatch');
    const body = WORKER.slice(i, landmark(WORKER, 'async function publishSignals'));
    const iScrape = body.indexOf('enrichLeadContact(');
    const iPaid = body.indexOf('lookupProviderContact(');
    assert.ok(iScrape !== -1 && iPaid !== -1, 'one of the two enrichment tiers is gone');
    assert.ok(iScrape < iPaid, 'the paid lookup runs first — that buys data the free scrape already had');
    assert.ok(/const misses = scraped\.filter\(\(s\) =>\s*\n?\s*!s\.found\.contact/.test(body),
        'the paid tier no longer targets only the scrape misses');
    // ⚠️ §5 (2026-08-25): the paid tier is gated NARROWER than the scrape. The scrape reads
    // anything that might be a company, including leads with no prospect type at all — that costs
    // seconds and might hand the user an address for free. Buying one costs money, and
    // `paidLookupAt` is stamped on a MISS too, so an unclassified lead would be a blank cheque.
    assert.ok(/isPaidEnrichEligible\(/.test(body),
        'the paid tier no longer gates on prospect type — it would buy addresses for unclassified leads');
});

check('the purchase is skipped entirely when no provider is configured', () => {
    assert.ok(/misses\.length > 0 && isEnrichProviderConfigured\(\)/.test(WORKER),
        'the configured check is gone — an unconfigured run would do pointless work');
});

check('the cap is allocated BEFORE the concurrent map', () => {
    // ⚠️ Decrementing a shared counter inside parallel callbacks lets a batch overrun the cap by
    // however many run at once. The allocation has to be decided up front.
    const iAllowed = WORKER.indexOf('const allowed = Math.max(0, Math.min(misses.length');
    const iMap = WORKER.indexOf('misses.slice(0, allowed).map');
    assert.ok(iAllowed !== -1 && iMap !== -1, 'the cap allocation is gone');
    assert.ok(iAllowed < iMap, 'the cap is computed inside the concurrent map — it can be overrun');
});

check('the cap counts ATTEMPTS, so a miss costs a slot', () => {
    assert.ok(/if \(paidAttempted\) stamp\.paidLookupAt/.test(ENRICH),
        'the attempt stamp is gone — the cap would count hits and let misses run free');
    assert.ok(/signals ->> 'paidLookupAt' IS NOT NULL/.test(WORKER),
        'the spent-so-far query no longer counts attempts');
    // Scoped to the job, not the campaign: a campaign-wide count would make the cap bind
    // permanently after 25 lifetime lookups instead of per run.
    assert.ok(/WHERE job_id = \$\{job\.id\} AND signals ->> 'paidLookupAt'/.test(WORKER),
        'the spend count is not scoped to this run');
});

check('each purchase is charged to the run budget', () => {
    assert.ok(/counters\.costGbp \+= ENRICH_COST_GBP_PER_LOOKUP/.test(WORKER),
        'purchases are not charged to the run cost — maxCostGbpPerRun would never trip');
});

check('the paid phase has its own slice budget', () => {
    // Chaining a paid lookup onto each scrape makes the per-lead worst case the SUM of both
    // timeouts, and the leads run concurrently — the compounding that caused 504s before.
    assert.ok(/PAID_ENRICH_BUDGET_MS/.test(WORKER), 'the paid phase is unbounded');
    assert.ok(/timeoutMs: deadline - Date\.now\(\)/.test(WORKER),
        'the remaining slice budget is not passed to the lookup');
    // ⚠️ Abandoning a lookup because OUR slice ran out of time is an error, not a miss — we ran
    // out of clock, not out of their addresses.
    assert.ok(/if \(timeoutMs <= 0\) return \{ status: 'error', reason: 'no_budget' \};/.test(PROVIDER),
        'an exhausted budget still issues a request, or settles the lead as having no address');
});

// ── 4. What gets bought, and how it is labelled ──────────────────────────────

check('a bought address is labelled provider, never scrape or manual', () => {
    assert.ok(/source: 'provider'/.test(WORKER),
        'a purchased address is not distinguishable from a scraped one');
    assert.ok(!/source: 'manual'/.test(WORKER),
        "a purchased address must never be labelled 'manual' — that is the one source the gate exempts");
});

check('role addresses are preferred over named individuals', () => {
    assert.ok(/const roles = classified\.filter\(\(c\) => c\.kind === 'role'\)/.test(PROVIDER),
        'the role preference is gone — vendors rank the named person first, which is the address we least want');
});

check('the vendor’s own label is not trusted — our classifier decides', () => {
    assert.ok(/roleOrPersonal\(/.test(PROVIDER),
        'the provider no longer classifies through the shared rule, so role/personal could disagree with the scraper');
});

// ── 5. Storage ───────────────────────────────────────────────────────────────

check('the cap exists in BOTH the DDL and the schema', () => {
    assert.ok(/ADD COLUMN IF NOT EXISTS max_enrichment_calls_per_run integer NOT NULL DEFAULT 25/.test(DDL),
        'the migration no longer adds the cap');
    assert.ok(/maxEnrichmentCallsPerRun: integer\("max_enrichment_calls_per_run"\)/.test(SCHEMA),
        'db/schema.ts is missing the column — a drizzle-kit push would drop it');
});

check('an unmigrated environment falls back to the default, not to zero', () => {
    // Number(null) is 0, which reads as "cap of zero" — paid enrichment silently off. The deploy
    // and the migration are not guaranteed to land together, so the gap must fail safe.
    assert.ok(/maxEnrichmentCallsPerRun: g\.maxEnrichmentCallsPerRun \?\? DEFAULT_GUARDRAILS\.maxEnrichmentCallsPerRun/.test(WORKER),
        'the cap is read raw — an unmigrated row would disable paid enrichment instead of defaulting');
});

// The only check that needs to await. tsx compiles this file to CJS, which has no top-level
// await, so it runs here rather than inline above.
async function main(): Promise<void> {
    await checkAsync('an unconfigured lookup reports an error instead of throwing', async () => {
        // The waterfall must degrade to today's scrape-only behaviour, never fail a run.
        // ⚠️ And it must report `error`, NOT `miss`: switching the provider off must not mark the
        // entire backlog as companies that publish no address.
        // Unconfigured is checked FIRST, so every input short-circuits to the same reason here.
        // That ordering is deliberate: "we never asked anyone" is the truest description of what
        // happened, whatever the domain looked like.
        for (const input of ['example.com', null, 'not a domain']) {
            assert.deepEqual(await lookupProviderContact(input),
                { status: 'error', reason: 'not_configured' },
                `lookupProviderContact(${JSON.stringify(input)}) must degrade to a not_configured error`);
        }
    });
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
