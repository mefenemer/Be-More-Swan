// tests/current-date-prompt.test.ts
// The model was dating social posts 2025 because NOTHING in the generation prompt said what day it
// was — so it answered from its training prior. The fix is a date block in the prompt, which means
// two things can silently regress:
//
//   1. The block itself getting the year wrong at a timezone/DST boundary (the one day it matters
//      most is the one day it is hardest to get right).
//   2. A generation surface quietly dropping the injection — the prompt-surface drift this repo
//      has already been bitten by twice (see blueprint-prompt-sync.test.ts).
//
// Run:  npx tsx tests/current-date-prompt.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { currentDatePromptBlock } from '../src/utils/current-date-prompt';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

console.log('\nCurrent-date prompt block\n');

// ── The block states the date ────────────────────────────────────────────────────────────────

test('states today, spelled out, in the given timezone', () => {
    const block = currentDatePromptBlock({
        now: new Date('2026-08-13T09:00:00Z'),
        timezone: 'Europe/London',
    });
    assert.match(block, /Thursday, 13 August 2026/, 'expected the long-form date');
    assert.match(block, /\(Europe\/London\)/, 'expected the zone to be named');
});

test('states the current year explicitly, not just a date', () => {
    // A bare date leaves the model free to type a year anyway — naming the year is the actual fix.
    const block = currentDatePromptBlock({ now: new Date('2026-08-13T09:00:00Z') });
    assert.match(block, /current year is 2026/);
});

test('reads the year in the TARGET zone, not the server zone', () => {
    // 31 Dec 23:30 New York is already 1 Jan in London. Whichever side the server sits on, the
    // stated year must be the account's — this is the boundary that puts a wrong year in copy.
    const newYearEve = new Date('2027-01-01T04:30:00Z');
    assert.match(
        currentDatePromptBlock({ now: newYearEve, timezone: 'America/New_York' }),
        /current year is 2026/,
        'New York is still 2026 at 23:30 on 31 Dec',
    );
    assert.match(
        currentDatePromptBlock({ now: newYearEve, timezone: 'Europe/London' }),
        /current year is 2027/,
        'London has already rolled over',
    );
});

// ── Publish date vs today ────────────────────────────────────────────────────────────────────

test('names the publish date when the slot is a different day', () => {
    // Drafts are generated ahead of their slot, so "this week" belongs to the slot, not to today.
    const block = currentDatePromptBlock({
        now: new Date('2026-12-30T10:00:00Z'),
        publishDate: new Date('2027-01-04T09:00:00Z'),
        timezone: 'Europe/London',
    });
    assert.match(block, /current year is 2026/, 'today is still 2026');
    assert.match(block, /scheduled to publish on Monday, 4 January 2027/);
});

test('omits the publish line when the slot is today', () => {
    const block = currentDatePromptBlock({
        now: new Date('2026-08-13T09:00:00Z'),
        publishDate: new Date('2026-08-13T17:00:00Z'),
        timezone: 'Europe/London',
    });
    assert.ok(!/scheduled to publish/.test(block), 'a same-day slot just restates today');
});

test('omits the publish line when there is no slot', () => {
    const block = currentDatePromptBlock({ now: new Date('2026-08-13T09:00:00Z'), publishDate: null });
    assert.ok(!/scheduled to publish/.test(block));
});

// ── It must never be the thing that fails a draft ────────────────────────────────────────────

test('a bad timezone degrades to UTC instead of throwing', () => {
    // posting_timezone is user-editable free text on onboarding_context; Intl throws on a typo,
    // and a formatting nicety must not take down the whole draft.
    const block = currentDatePromptBlock({ now: new Date('2026-08-13T09:00:00Z'), timezone: 'Europe/Lundon' });
    assert.match(block, /\(UTC\)/);
    assert.match(block, /current year is 2026/);
});

test('an unparseable publish date is ignored, not printed', () => {
    const block = currentDatePromptBlock({ now: new Date('2026-08-13T09:00:00Z'), publishDate: 'not a date' });
    assert.ok(!/scheduled to publish/.test(block));
    assert.ok(!/Invalid Date/.test(block));
});

// ── Every surface that writes dated copy injects it ──────────────────────────────────────────
//
// Source-scan, deliberately: these are handlers with DB + network in their bodies, and the thing
// worth pinning is that the call is present at all. A surface added later that writes post copy
// belongs in this list.

// Deliberately NOT listed, because they do not write dated copy and a date block there would be
// noise at best: social-auto-responder.ts writes evergreen standing greetings (telling it the year
// invites one INTO a message that outlives the year), suggest-overlay-text.ts derives a few words
// from a caption that already carries the framing, and autonomous-strategy-agent.ts writes playbook
// instructions and persona JSON, never prose a reader sees.
const SURFACES: Array<[string, string]> = [
    ['process-content-jobs.ts (scheduled + on-demand drafts)', '../netlify/functions/process-content-jobs.ts'],
    ['admin-test-generate-background.ts (admin smoke test)',   '../netlify/functions/admin-test-generate-background.ts'],
    ['chat-orchestrator.ts (chat drafts)',                     '../netlify/functions/chat-orchestrator.ts'],
    ['rewrite-post-text.ts (caption rewrites)',                '../netlify/functions/rewrite-post-text.ts'],
    ['blog-generate.ts (blog bodies)',                         '../src/utils/blog-generate.ts'],
    ['blog-topic-ideation.ts (blog titles)',                   '../src/utils/blog-topic-ideation.ts'],
    ['generate-seo.ts (meta titles + slugs)',                  '../netlify/functions/generate-seo.ts'],
    ['generate-hooks.ts (blog H1 variants)',                   '../netlify/functions/generate-hooks.ts'],
];

for (const [label, path] of SURFACES) {
    test(`${label} injects the date block`, () => {
        const src = read(path);
        assert.match(src, /currentDatePromptBlock\(/, 'no currentDatePromptBlock() call found');
        assert.match(src, /current-date-prompt/, 'no import of the shared builder');
    });
}

test('the worker scopes the block to the slot and the posting timezone', () => {
    // The generator is the one surface that knows BOTH — a regression to a bare
    // currentDatePromptBlock() there would silently lose the publish date on every scheduled draft.
    const src = read('../netlify/functions/process-content-jobs.ts');
    const call = src.match(/currentDatePromptBlock\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    assert.match(call, /publishDate:\s*job\.target_publish_date/, 'publish date not passed');
    assert.match(call, /timezone:\s*resolvePostingSchedule\(brandCtx\)\.timezone/, 'posting timezone not passed');
});

test('the blog body is scoped to the post\'s own publish date', () => {
    // Blog drafts are scheduled ahead too (blog-horizon-fill stamps target_publish_date), and the
    // year lands in an H1 on the customer's own domain — the most durable place to get it wrong.
    const src = read('../src/utils/blog-generate.ts');
    const call = src.match(/currentDatePromptBlock\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    assert.match(call, /publishDate:\s*post\.publishDate/, 'publish date not passed');
    assert.match(call, /timezone/, 'timezone not passed');
});

test('the date block leads the generation system prompt', () => {
    // Position matters: the blueprint dump carries its own dates (section 2 is a hire-time
    // snapshot), and those must read as history rather than as "now".
    const src = read('../netlify/functions/process-content-jobs.ts');
    const dateAt = src.indexOf('currentDatePromptBlock(');
    const blueprintAt = src.indexOf('renderBlueprintPrompt(sections)');
    assert.ok(dateAt > -1 && blueprintAt > -1, 'expected both calls in the worker');
    assert.ok(dateAt < blueprintAt, 'the date block must be prepended before the blueprint dump');
});

console.log(`\n${passed} checks passed.\n`);
