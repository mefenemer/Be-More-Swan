// tests/goal-freshness-note.test.ts
// The Goal Progress card now prints a promise: "Measured automatically once an hour in the
// background — next check around 1 Aug, 21:00." (_renderGoalFreshnessNote in assistants.js).
// Run:  npx tsx tests/goal-freshness-note.test.ts
//
// WHY THIS MATTERS: that sentence names a cadence and a clock time, and nothing in production will
// ever tell us it stopped being true. The three ways it silently becomes a lie:
//   • poll-goal-telemetry stops running on the hour — the card rounds the next check up to the next
//     hour boundary precisely because the cron fires at :00. A "0 */6" schedule makes it fiction.
//   • the cadence gets hardcoded in the UI — it is per plan tier (entry daily, paid hourly), so a
//     literal "hourly" in assistants.js would be wrong for every entry-tier workspace.
//   • manage-goals stops serving the two inputs the note is computed from.
// The equivalent guard for the Audience block's near-identical sentence is follower-refresh.test.ts.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLL_CADENCE_HOURS_BY_TIER, DEFAULT_POLL_CADENCE_HOURS, pollCadenceHours } from '../src/config/goal-metrics';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\ngoal freshness note\n');

// ── 1. The cron the sentence promises ────────────────────────────────────────────────────────────

check('poll-goal-telemetry still runs hourly, on the hour', () => {
    const toml = read('netlify.toml');
    const block = toml.slice(toml.indexOf('[functions.poll-goal-telemetry]'));
    assert.ok(block.startsWith('[functions.poll-goal-telemetry]'), 'poll-goal-telemetry is no longer scheduled in netlify.toml — the Goal Progress card promises a background check that would no longer happen');
    const schedule = /schedule\s*=\s*"([^"]+)"/.exec(block.slice(0, 200))?.[1];
    assert.strictEqual(schedule, '0 * * * *',
        `the card rounds "next check" up to the next hour boundary because this cron fires at :00; it is now "${schedule}". Change _renderGoalFreshnessNote's rounding in assistants.js to match, or the time it names is one nothing happens on.`);
});

// ── 2. The cadence is per tier, so the UI may not hold an opinion about it ────────────────────────

check('every tier cadence is a positive number of hours', () => {
    for (const [tier, hours] of Object.entries(POLL_CADENCE_HOURS_BY_TIER)) {
        assert.ok(Number.isFinite(hours) && hours > 0, `tier "${tier}" has a non-positive poll cadence (${hours}) — the card would fall back to a vague "measured automatically in the background" with no cadence at all`);
    }
    assert.ok(DEFAULT_POLL_CADENCE_HOURS > 0, 'the default cadence must be positive for the same reason');
});

check('manage-goals serves the cadence and the last-measured stamp the note is built from', () => {
    const src = read('netlify/functions/manage-goals.ts');
    assert.match(src, /pollCadenceHours:\s*pollCadenceHours\(tierKey\)/,
        'the GET response no longer carries pollCadenceHours — the Goal Progress card would drop to its cadence-less wording for everyone');
    assert.match(src, /lastMeasuredAt:/,
        'the GET response no longer carries lastMeasuredAt — the card could not say when the last check landed or when the next one is due');
});

check('the card reads the cadence from the server instead of hardcoding one', () => {
    const js = read('assistants.js');
    const start = js.indexOf('function _renderGoalFreshnessNote(');
    assert.ok(start > 0, '_renderGoalFreshnessNote is gone — if the note moved, move this guard with it');
    const body = js.slice(start, js.indexOf('\n}', start));
    assert.ok(body.includes('_goalPollCadenceHours'),
        'the note no longer derives its cadence from the server value');
    // A literal cadence phrase would be right for one tier and wrong for the others. The branches
    // that turn the SERVER's number into words are fine; a bare claim is not.
    const literals = /(every|once)\s+(an?\s+)?(hour|day|\d+\s*(hours?|days?))(?![^\n]*hrs ===)/g;
    for (const m of body.matchAll(literals)) {
        const line = body.slice(0, m.index).split('\n').pop() ?? '';
        assert.ok(/hrs ===|hrs \?|cadence =/.test(line) || line.trimStart().startsWith('*') || line.trimStart().startsWith('//'),
            `"${m[0]}" is stated outside the cadence branch, so it claims a schedule the server did not: ${line.trim()}`);
    }
});

// ── 3. What the cadence values actually read as ──────────────────────────────────────────────────

check('each tier maps to a cadence the note can phrase naturally', () => {
    // The note has bespoke wording for 1 ("once an hour") and 24 ("once a day"); anything else falls
    // to "every N hours", which reads badly for values like 36. Not a failure — a prompt to add a case.
    const phrasable = new Set([1, 24]);
    for (const tier of [...Object.keys(POLL_CADENCE_HOURS_BY_TIER), 'unknown-tier']) {
        const hours = pollCadenceHours(tier);
        assert.ok(phrasable.has(hours) || hours % 24 === 0 || hours < 24,
            `tier "${tier}" polls every ${hours}h, which _renderGoalFreshnessNote would render as "every ${hours} hours" — add a case for it`);
    }
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
