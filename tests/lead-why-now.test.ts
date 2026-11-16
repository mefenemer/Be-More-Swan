// tests/lead-why-now.test.ts
// "Why now": the dated reason to contact a lead now (docs/lead-why-now-and-watching-plan.md, Phase 1).
//
// WHY THIS EXISTS. A Why now line tells a user to pick up the phone this week. Three ways it could
// lie, each held here:
//   1. A REASON THE MODEL MADE UP, or one pointing at a page we never read — resolveWhyNow keeps
//      only a reason whose url is one of OUR evidence urls. §1.
//   2. A DATE THE MODEL MADE UP — the date is read from the evidence, resolved against when we read
//      it; undated or unreadable evidence means no Why now at all. §1, §2.
//   3. THE TABLE AND THE CHAT DISAGREEING about whether a reason is still fresh — both run the same
//      functions (the browser through the generated mirror, executed here). §3, §4.
//
// No database. Run:  npx tsx tests/lead-why-now.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    parseEvidenceDate, resolveWhyNow, dateSignals, clampTiming, whyNowState, whyNowAgeLabel, whyNowRank,
    WHY_NOW_FRESH_DAYS, WHY_NOW_GONE_DAYS, WHY_NOW_UNDATED_TIMING_CAP, WHY_NOW_STATE_LABELS,
} from '../src/config/lead-why-now';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const GATHERED = '2026-11-16T09:30:00.000Z';
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.parse('2026-11-16T12:00:00Z') - n * DAY).toISOString().slice(0, 10);

console.log('\n──── 1. the guard: only our evidence, only a readable date ────');

const EVIDENCE = [
    { url: 'https://news.example/raise', date: '3 days ago' },
    { url: 'https://news.example/undated', date: null },
    { url: 'https://news.example/garbled', date: 'sometime last spring' },
    { url: 'https://news.example/future', date: '2027-03-01' },
];

check('a reason pointing at our dated evidence is kept, with the EVIDENCE date', () => {
    const w = resolveWhyNow({ summary: 'Raised £2m to open more sites', url: 'https://news.example/raise', date: '1999-01-01' }, EVIDENCE, GATHERED);
    assert.deepStrictEqual(w, { summary: 'Raised £2m to open more sites', url: 'https://news.example/raise', date: '2026-11-13' },
        'the date must come from the evidence ("3 days ago" read at gatheredAt), never from the model');
});

check('a reason pointing at a url we never gathered is dropped', () => {
    assert.strictEqual(resolveWhyNow({ summary: 'Hiring', url: 'https://made-up.example' }, EVIDENCE, GATHERED), null);
});

check('undated, unreadable or future-dated evidence gives no Why now', () => {
    for (const url of ['https://news.example/undated', 'https://news.example/garbled', 'https://news.example/future']) {
        assert.strictEqual(resolveWhyNow({ summary: 'Something', url }, EVIDENCE, GATHERED), null, url);
    }
});

check('junk from the model is dropped, not thrown on', () => {
    for (const raw of [null, undefined, 'Hiring', [], {}, { summary: '' , url: 'https://news.example/raise' }, { summary: 'x' }]) {
        assert.strictEqual(resolveWhyNow(raw, EVIDENCE, GATHERED), null, JSON.stringify(raw));
    }
});

check('signals carry their evidence date, or null', () => {
    const out = dateSignals([
        { summary: 'a', url: 'https://news.example/raise', direction: 'positive' as const },
        { summary: 'b', url: 'https://news.example/undated', direction: 'neutral' as const },
    ], EVIDENCE, GATHERED);
    assert.strictEqual(out[0].date, '2026-11-13');
    assert.strictEqual(out[1].date, null);
    assert.strictEqual(out[0].direction, 'positive', 'the rest of the signal is untouched');
});

check('timing is clamped to 0–100, and capped when no dated reason survived', () => {
    const w = { summary: 'x', url: 'u', date: '2026-11-13' };
    assert.strictEqual(clampTiming(85, w), 85);
    assert.strictEqual(clampTiming(140, w), 100);
    assert.strictEqual(clampTiming(-5, w), 0);
    assert.strictEqual(clampTiming('72', w), 72);
    assert.strictEqual(clampTiming(85, null), WHY_NOW_UNDATED_TIMING_CAP,
        'a high timing with no dated reason behind it must not survive');
    assert.strictEqual(clampTiming('soon', w), null);
    assert.strictEqual(clampTiming(undefined, w), null);
});

console.log('\n──── 2. reading the provider\'s date ────');

check('relative dates resolve against when we read them', () => {
    assert.strictEqual(parseEvidenceDate('today', GATHERED), '2026-11-16');
    assert.strictEqual(parseEvidenceDate('yesterday', GATHERED), '2026-11-15');
    assert.strictEqual(parseEvidenceDate('5 hours ago', GATHERED), '2026-11-16');
    assert.strictEqual(parseEvidenceDate('1 day ago', GATHERED), '2026-11-15');
    assert.strictEqual(parseEvidenceDate('2 weeks ago', GATHERED), '2026-11-02');
    assert.strictEqual(parseEvidenceDate('a month ago', GATHERED), '2026-10-17');
    assert.strictEqual(parseEvidenceDate('1 year ago', GATHERED), '2025-11-16');
});

check('written dates in UK and US order both read', () => {
    assert.strictEqual(parseEvidenceDate('14 Aug 2026', GATHERED), '2026-08-14');
    assert.strictEqual(parseEvidenceDate('14 August 2026', GATHERED), '2026-08-14');
    assert.strictEqual(parseEvidenceDate('Aug 14, 2026', GATHERED), '2026-08-14');
    assert.strictEqual(parseEvidenceDate('September 3 2026', GATHERED), '2026-09-03');
    assert.strictEqual(parseEvidenceDate('3 Sept 2026', GATHERED), '2026-09-03');
    assert.strictEqual(parseEvidenceDate('2026-08-14T10:00:00Z', GATHERED), '2026-08-14');
});

check('ambiguous or impossible dates are refused, never guessed', () => {
    for (const raw of ['04/08/2026', '31 Feb 2026', '2026-13-01', 'last spring', '', '   ', null, undefined, 'Q3 2026']) {
        assert.strictEqual(parseEvidenceDate(raw as string | null, GATHERED), null, String(raw));
    }
    assert.strictEqual(parseEvidenceDate('3 days ago', 'not a date'), null, 'an unreadable gatheredAt dates nothing');
});

console.log('\n──── 3. fading ────');

const NOW = Date.parse('2026-11-16T12:00:00Z');
const intelAged = (n: number) => ({ whyNow: { summary: 'Hiring two sales reps', url: 'https://x.example', date: daysAgo(n) } });

check(`fresh up to ${WHY_NOW_FRESH_DAYS} days, cooling to ${WHY_NOW_GONE_DAYS}, gone after`, () => {
    assert.strictEqual(whyNowState(intelAged(0), NOW).state, 'fresh');
    assert.strictEqual(whyNowState(intelAged(WHY_NOW_FRESH_DAYS), NOW).state, 'fresh');
    assert.strictEqual(whyNowState(intelAged(WHY_NOW_FRESH_DAYS + 1), NOW).state, 'cooling');
    assert.strictEqual(whyNowState(intelAged(WHY_NOW_GONE_DAYS), NOW).state, 'cooling');
    assert.strictEqual(whyNowState(intelAged(WHY_NOW_GONE_DAYS + 1), NOW).state, 'gone');
    assert.strictEqual(whyNowState(intelAged(12), NOW).ageDays, 12);
});

check('never researched, researched before Why now, and "nothing found" are three different answers', () => {
    assert.strictEqual(whyNowState(undefined, NOW).state, 'not_checked');
    assert.strictEqual(whyNowState({ gatheredAt: GATHERED, signals: [] }, NOW).state, 'not_checked',
        'intel saved before Why now existed has no whyNow key — that is "not checked", not "no reason"');
    assert.strictEqual(whyNowState({ whyNow: null }, NOW).state, 'none');
    assert.strictEqual(whyNowState({ whyNow: { summary: 'x', url: 'u', date: '14/08/2026' } }, NOW).state, 'none',
        'a malformed stored date is shown as no reason, not as a fresh one');
});

check('age labels never print a numeric date', () => {
    assert.strictEqual(whyNowAgeLabel(0), 'today');
    assert.strictEqual(whyNowAgeLabel(1), 'yesterday');
    assert.strictEqual(whyNowAgeLabel(9), '9 days ago');
    assert.strictEqual(whyNowAgeLabel(21), '3 weeks ago');
    assert.strictEqual(whyNowAgeLabel(75), '3 months ago');
    assert.strictEqual(whyNowAgeLabel(null), '');
});

check('sorting puts fresh first, newest first within a band', () => {
    const order = [intelAged(40), {}, intelAged(2), { whyNow: null }, intelAged(10)]
        .map((i) => whyNowState(i, NOW))
        .sort((a, b) => whyNowRank(a) - whyNowRank(b))
        .map((v) => `${v.state}:${v.ageDays}`);
    assert.deepStrictEqual(order, ['fresh:2', 'fresh:10', 'cooling:40', 'none:null', 'not_checked:null']);
});

console.log('\n──── 4. the browser mirror is the same code ────');

const GENERATED = read('src/generated/platform-constants.js');

check('the mirror runs, and agrees with the server module', () => {
    const w: Record<string, any> = {};
    new Function('window', GENERATED)(w);
    const W = w.LeadWhyNow;
    assert.ok(W, 'window.LeadWhyNow was not generated — run `npm run gen:constants`');
    assert.strictEqual(W.FRESH_DAYS, WHY_NOW_FRESH_DAYS);
    assert.strictEqual(W.GONE_DAYS, WHY_NOW_GONE_DAYS);
    assert.deepStrictEqual(W.LABELS, WHY_NOW_STATE_LABELS);
    for (const n of [0, 1, 30, 31, 90, 91, 400]) {
        assert.deepStrictEqual(W.state(intelAged(n), NOW), whyNowState(intelAged(n), NOW), `disagree at ${n} days`);
        assert.strictEqual(W.ageLabel(n), whyNowAgeLabel(n));
    }
    assert.strictEqual(W.state({}, NOW).state, 'not_checked');
});

console.log('\n──── 5. wiring ────');

check('research saves Why now through the guard, never the model\'s raw answer', () => {
    const src = read('src/utils/lead-enrichment.ts');
    assert.match(src, /resolveWhyNow\(rescored\.whyNow, intel\.evidence, intel\.gatheredAt\)/);
    assert.match(src, /clampTiming\(rescored\.timing, whyNow\)/);
    assert.ok(!/whyNow: rescored\.whyNow/.test(src), 'the unverified model answer must never be stored');
    assert.match(src, /whyNow: null, timing: null/, '"researched, nothing found" must store whyNow: null');
});

check('the re-score prompt asks for timing and a dated, positive whyNow', () => {
    const src = read('src/lib/discovery-scoring.ts');
    assert.match(src, /"timing": <0-100>/);
    assert.match(src, /"whyNow": \{ "summary"/);
    assert.match(src, /Only a POSITIVE reason, only from evidence with a "published" date/);
});

check('the Leads table has a Why now column, drawn from the mirror', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    assert.match(reg, /\{ key: 'whyNow', label: 'Why now' \}/);
    const hub = read('src/components/assistant-data-hub.js');
    assert.match(hub, /if \(key === 'whyNow'\) return whyNowCell\(record\)\.text;/);
    assert.match(hub, /window\.LeadWhyNow/);
    assert.match(hub, /whyNow: \['Reason now', 'Cooling off', 'No recent reason', 'Not checked'\]/,
        'the filter order must use the rendered labels');
    for (const label of Object.values(WHY_NOW_STATE_LABELS)) {
        assert.ok(hub.includes(`'${label}'`), `the ordered labels miss "${label}"`);
    }
});

check('the chat lists fresh reasons with the same rule the table runs', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    assert.match(src, /import \{ whyNowState, whyNowAgeLabel, WHY_NOW_FRESH_DAYS, WHY_NOW_GONE_DAYS \} from '\.\.\/\.\.\/src\/config\/lead-why-now'/);
    assert.match(src, /WHY NOW — leads with a dated reason/);
    assert.match(src, /\$\{whyNowList\}/, 'the Why now list must be in the snapshot the chat reads');
    assert.match(src, /"Why now" column/, 'the prompt must tell the chat the column exists');
});

console.log(`\n${passed} checks passed.\n`);
