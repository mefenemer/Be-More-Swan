// tests/lead-performance.test.ts
// The four Performance Metrics cards on the Lead Generation Assistant.
//
// ── What this is defending ───────────────────────────────────────────────────
// The card grid had ONE data source for every role but Campaign: get-assistant-performance, which
// reads `post_insights`. The Lead Generation Assistant publishes nothing, so it returned
// hasData:false for ever and the section rendered "Performance metrics aren't available yet …
// Nothing has been published in the last 30 days" — permanently, under a Lead Generator. Four
// registry labels ("Pipeline Volume", "Hours Reclaimed") sat above figures nothing computed.
//
// Three properties make the fix real rather than cosmetic, and each is easy to undo by accident:
//
//   1. THE ROUTING. `metricsSource: 'lead'` is the only thing that keeps this role off the social
//      endpoint. Lose it and the copy below is decoration again.
//   2. THE DENOMINATORS. Qualification rate is over DECIDED leads and reply rate is over leads
//      EMAILED. Over discovered leads instead, both numbers would report the user's review backlog
//      and their sending volume as failures.
//   3. NULL ≠ ZERO. A rate with no denominator is unknown. Rendering it as 0.0% tells someone
//      their reply rate is zero when in truth they have sent nothing.
//
// Part maths (the util is pure, so it is really executed), part source scan (the wiring).
// Run:  npx tsx tests/lead-performance.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    LEAD_PERFORMANCE_DAYS, buildLeadPerformance, emptyLeadPerformance,
    type LeadPerformanceCounts,
} from '../src/utils/lead-performance';
import { EVENT_TYPES } from '../src/config/revenue-events';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const FN = read('netlify/functions/get-lead-performance.ts');
const REGISTRY = read('src/components/assistant-dashboard-registry.js');
const ASSISTANTS = read('assistants.js');

/**
 * Strip comments before asserting that a phrase is GONE.
 *
 * ⚠️ Not optional, and this file proved it: the two checks below failed on their first run against
 * the raw source — by matching "Hours Reclaimed" and "publishes nothing" inside the block comments
 * that explain why those things went. A scan finds the phrase in its own obituary and fails on
 * documentation. Same trap lead-table-controls.test.ts and icp-snapshot.test.ts both learned.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

/** A zeroed count set, so each case below states only the fields it is about. */
function counts(over: Partial<LeadPerformanceCounts> = {}): LeadPerformanceCounts {
    return {
        discovered: 0, approved: 0, rejected: 0, contacted: 0, replied: 0, optedOut: 0,
        won: 0, lost: 0, disqualified: 0, wonValueGbp: null, ...over,
    };
}

console.log('\n──── the arithmetic ────');

check('an assistant with no activity reports hasData:false, not four zeroes', () => {
    assert.strictEqual(emptyLeadPerformance().hasData, false);
    assert.strictEqual(buildLeadPerformance(counts()).hasData, false);
});

check('activity with nothing yet approved STILL reports hasData', () => {
    // 40 leads found and all of them rejected is a real, and quite interesting, 0% qualification
    // rate. Showing the "nothing to report" panel would hide the one number that explains it.
    const p = buildLeadPerformance(counts({ discovered: 40, rejected: 40 }));
    assert.strictEqual(p.hasData, true, 'a fully-rejected batch is data, not an absence of data');
    assert.strictEqual(p.metrics.qualificationRate, 0, 'and its qualification rate is a measured zero');
});

check('qualification rate is over DECIDED leads, never over discovered ones', () => {
    // 100 found, 10 reviewed, 8 kept. Over discovered this reads 8% and falls further every time
    // the assistant runs — reporting a review backlog as a targeting failure.
    const p = buildLeadPerformance(counts({ discovered: 100, approved: 8, rejected: 2 }));
    assert.strictEqual(p.metrics.qualificationRate, 0.8,
        'the denominator must be approved + rejected, so an untouched queue cannot drag it down');
});

check('reply rate is over leads EMAILED, never over leads found', () => {
    const p = buildLeadPerformance(counts({ discovered: 500, contacted: 20, replied: 5 }));
    assert.strictEqual(p.metrics.replyRate, 0.25);
});

check('an empty denominator is null, never zero', () => {
    // The difference between "nobody replied" and "nobody has been emailed". Rendered the same,
    // the first is a lie about the assistant's performance.
    const p = buildLeadPerformance(counts({ discovered: 12 }));
    assert.strictEqual(p.metrics.qualificationRate, null, 'nothing reviewed → unknown, not 0%');
    assert.strictEqual(p.metrics.replyRate, null, 'nothing emailed → unknown, not 0%');
    assert.strictEqual(p.metrics.conversionRate, null);
    assert.strictEqual(p.metrics.optOutRate, null);
    for (const v of Object.values(p.metrics)) {
        assert.ok(!Number.isNaN(v as number), 'a NaN reached the payload — 0/0 is not guarded');
    }
});

check('conversion is won over CONTACTED, so unsent leads never dilute it', () => {
    const p = buildLeadPerformance(counts({ discovered: 200, contacted: 25, won: 5, lost: 5 }));
    assert.strictEqual(p.metrics.conversionRate, 0.2);
});

check('won value passes through, and its absence stays null', () => {
    assert.strictEqual(buildLeadPerformance(counts({ won: 3, contacted: 9 })).metrics.wonValueGbp, null,
        'three wins with no recorded figure must not become £0 — that claims they were worthless');
    assert.strictEqual(buildLeadPerformance(counts({ won: 3, contacted: 9, wonValueGbp: 41250 })).metrics.wonValueGbp, 41250);
});

check('the opt-out rate rides the reply card rather than taking one of its own', () => {
    const p = buildLeadPerformance(counts({ contacted: 50, replied: 6, optedOut: 4 }));
    assert.strictEqual(p.metrics.optOutRate, 0.08);
    assert.match(p.trends.replyRate, /asked to stop/,
        'a reply rate reads very differently beside a rising opt-out rate — the two must appear together');
});

check('every trend line is a sentence, in every state, including the empty ones', () => {
    for (const p of [buildLeadPerformance(counts()), buildLeadPerformance(counts({ discovered: 3, approved: 1, contacted: 1, won: 1 }))]) {
        for (const [key, line] of Object.entries(p.trends)) {
            assert.ok(typeof line === 'string' && line.trim(), `trend "${key}" is blank`);
            assert.ok(!/NaN|undefined|null/.test(line), `trend "${key}" leaked a non-value: ${line}`);
        }
    }
});

check('singulars are singular — the cards are read one at a time', () => {
    const p = buildLeadPerformance(counts({ discovered: 1, approved: 1, contacted: 1, replied: 1 }));
    assert.match(p.trends.qualifiedLeads, /1 lead found/);
    assert.match(p.trends.replyRate, /1 reply from 1 lead emailed/);
});

check('the window is stated by the payload, not assumed by the client', () => {
    assert.strictEqual(buildLeadPerformance(counts()).periodDays, LEAD_PERFORMANCE_DAYS);
    assert.ok(LEAD_PERFORMANCE_DAYS >= 60,
        'a B2B cycle runs weeks to months — a short window reports zero closed deals for a healthy '
        + 'pipeline, which is the artefact roi-hero-defaults-all-time already cost us once');
});

console.log('\n──── the query ────');

check('every event type the query names is a real one', () => {
    // A typo'd event type is invisible: the FILTER matches nothing and the card reads zero for
    // ever, with no error anywhere.
    const named = [...FN.matchAll(/event_type = '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(named.length >= 5, `expected the funnel's event types, found ${named.length}`);
    for (const t of named) {
        assert.ok((EVENT_TYPES as readonly string[]).includes(t),
            `"${t}" is not in EVENT_TYPES — this FILTER can never match a row`);
    }
});

check('engagement counts are DISTINCT leads, not ledger rows', () => {
    // outreach_sent is written once per send INCLUDING every sequence follow-up. Counting rows
    // would inflate the denominator each time a chase went out, so the reply rate would FALL as a
    // direct result of the assistant doing more work.
    for (const t of ['outreach_sent', 'reply_received', 'opt_out_received', 'lead_discovered']) {
        const re = new RegExp(`count\\(DISTINCT lead_key\\) FILTER \\(WHERE event_type = '${t}'\\)`);
        assert.match(FN, re, `${t} is counted by row, not by lead`);
    }
});

check('every CTE the query defines is actually selected FROM', () => {
    // ⚠️ THIS FILE SHIPPED WITHOUT THIS CHECK AND THE QUERY WAS BROKEN.
    // The outer SELECT had no `FROM ev`, so `count(DISTINCT lead_key)` referenced a column that
    // was not in scope. Postgres answered "column lead_key does not exist", drizzle rethrew it as
    // "Failed query: …", and the card grid rendered "Performance metrics couldn't be loaded" on
    // production. Every other check in this file passed throughout: they assert the FILTER
    // expressions, the scoping and the parsing, and NONE of them looks at whether the query has a
    // FROM clause at all. A source scan sees what it is told to look for.
    const q = FN.slice(landmark(FN, 'WITH ev AS ('));
    for (const [, name] of q.matchAll(/WITH\s+(\w+)\s+AS\s*\(/g)) {
        assert.ok(new RegExp(`(FROM|JOIN)\\s+${name}\\b`).test(q),
            `the "${name}" CTE is defined and never selected from — its columns are out of scope in `
            + 'the outer query, and Postgres will reject it at run time, not at deploy time');
    }
});

check('the not-migrated fallback reads err.cause, not err.message', () => {
    // drizzle rethrows EVERY query failure as "Failed query: …" and hangs the real Postgres error
    // (with its SQLSTATE) off `cause`. A fallback that greps `message` can therefore never match,
    // so every failure becomes a 500 — which the card grid shows as "couldn't be loaded". That is
    // exactly what happened here, and it is the same trap raw-sql-date-param-trap documents.
    const cat = FN.slice(landmark(FN, '} catch (err) {'));
    assert.match(cat, /\.cause/,
        'the catch never inspects err.cause, so the missing-relation branch below it is dead code');
    assert.ok(/'42P01'/.test(cat),
        'match on SQLSTATE — undefined_table is stable where the English message is not');
    // ⚠️ undefined_COLUMN must NOT be swallowed. A missing table is a migration state; a missing
    // column is a bug in the query, and the defect that caused this incident (a CTE with no FROM)
    // raised exactly 42703. Swallowing it would have reported "No lead activity to measure yet"
    // over a broken query — a wrong answer instead of a loud one.
    assert.ok(!/'42703'/.test(cat),
        'the catch swallows undefined_column, which hides query bugs behind an empty-state panel');
    assert.match(cat, /emptyLeadPerformance\(\)/, 'and it must still fall back to the empty payload');
});

check('a lead with no discovery row still counts as itself', () => {
    // CSV-imported and hand-added leads have no discovered_lead_id. Keying on it alone would
    // collapse every one of them into a single NULL bucket.
    assert.match(FN, /COALESCE\(discovered_lead_id::text, 'r' \|\| assistant_record_id::text\)/,
        'the lead key must fall back to the record id');
});

check('the query is tenant-scoped AND assistant-scoped, and the assistant is ownership-checked', () => {
    assert.match(FN, /organisation_id = \$\{orgId\}/, 'the aggregate is not org-scoped');
    assert.match(FN, /ai_assistant_id = \$\{aId\}/, 'the aggregate is not assistant-scoped');
    const guard = FN.slice(0, landmark(FN, 'const [row]'));
    assert.ok(/eq\(aiAssistants\.organisationId, orgId\)/.test(guard) && /statusCode: 404/.test(guard),
        'without the IDOR guard, any assistant id returns another tenant\'s funnel');
});

check('the numeric sum is parsed as one, and an empty sum stays null', () => {
    // ⚠️ Postgres numeric comes back as a STRING, and Number('') is 0 — an empty sum would render
    // as "£0 won" beside a real win.
    assert.match(FN, /row\.won_value === ''/,
        'the empty-string case is not guarded; a missing value would report £0');
});

check('an unmigrated ledger is an empty card set, not a 500', () => {
    // db/revenue-events.sql is a MANUAL apply in this repo, so an environment without it must not
    // turn the whole Overview into an error panel.
    assert.match(FN, /does not exist/, 'the missing-relation fallback has gone');
    assert.ok(!/msg\.includes\('column'\)/.test(FN),
        'the English-message branch must not match a missing COLUMN either — same reason as the '
        + 'SQLSTATE check above');
    assert.match(FN, /emptyLeadPerformance\(\)/, 'and it must fall back to the empty payload');
});

check('the function is exported through the Lambda compat wrapper', () => {
    assert.match(FN, /export default withLambda\(/,
        'a bare handler export does not run on this stack');
});

console.log('\n──── the wiring ────');

check('the role is routed off the social endpoint', () => {
    const role = REGISTRY.slice(landmark(REGISTRY, 'lead_qualifier: {'), landmark(REGISTRY, 'accounts_receivable_clerk: {'));
    assert.match(role, /metricsSource: 'lead'/,
        'without the flag this role falls back to get-assistant-performance, which reads '
        + 'post_insights — and this assistant publishes nothing, so the cards go blank again');
    assert.match(ASSISTANTS, /if \(source === 'lead'\)/, 'assistants.js does not route the flag');
    assert.match(ASSISTANTS, /get-lead-performance\?id=/, 'nothing calls the endpoint');
});

check('the four labels describe what is actually computed', () => {
    const role = REGISTRY.slice(landmark(REGISTRY, 'lead_qualifier: {'), landmark(REGISTRY, 'accounts_receivable_clerk: {'));
    for (const title of ['Qualified Leads', 'Qualification Rate', 'Reply Rate', 'Deals Won']) {
        assert.ok(role.includes(title), `the "${title}" card is missing from the registry copy`);
    }
    // ⚠️ These two were the old copy, and both were unmeasurable in principle: nothing in the
    // platform times a human doing this work by hand, and no card computes CRM field coverage.
    // A label above a figure nothing computes is how this section became wrong in the first place.
    assert.ok(!/Hours Reclaimed|CRM Enriched/.test(stripComments(role)),
        'an unmeasurable card label is back on this role');
});

check('the empty state stops talking about publishing', () => {
    assert.match(ASSISTANTS, /mode === 'lead-no-data'/,
        'the lead role has no empty state of its own, so it falls back to the social one — which '
        + 'says "nothing has been published", a sentence that is permanently true of an assistant '
        + 'that publishes nothing');
    const branch = stripComments(
        ASSISTANTS.slice(landmark(ASSISTANTS, "mode === 'lead-no-data'"), landmark(ASSISTANTS, "mode === 'campaign-no-data'")),
    );
    assert.ok(!/publish/.test(branch), 'the lead empty state still mentions publishing');
    assert.match(branch, /No lead activity to measure yet/, 'it must name what is actually missing');
});

check('the period note is overwritten from the payload, never left at the markup default', () => {
    const fn = ASSISTANTS.slice(landmark(ASSISTANTS, 'async function _loadLeadMetrics'), landmark(ASSISTANTS, 'async function _loadAssistantMetrics'));
    assert.match(fn, /Last \$\{data\.periodDays \|\| 90\} days/,
        'the markup says "Last 30 days"; leaving it there labels a 90-day window as a 30-day one');
});

check('the client renders an unknown rate as a dash, not 0.0%', () => {
    const fn = ASSISTANTS.slice(landmark(ASSISTANTS, 'async function _loadLeadMetrics'), landmark(ASSISTANTS, 'async function _loadAssistantMetrics'));
    assert.match(fn, /\(v === null \|\| v === undefined\) \? '—'/,
        'a null rate must render as an em-dash — 0.0% claims a measurement nobody took');
    assert.match(fn, /_setMetricsEmptyState\('error'\)/,
        'a fetch failure must say so rather than leaving four dashes that read as broken');
});

console.log(`\n${passed} checks passed.`);
