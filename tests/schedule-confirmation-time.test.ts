// tests/schedule-confirmation-time.test.ts
// The confirmation must name the time the post is ACTUALLY going out.
//
// Two independent ways it stopped doing that, both silent — nothing threw, and the calendar (which
// reloads from the server and renders in the reader's own zone) went on showing the right time, so
// the only symptom was two surfaces disagreeing about one row:
//
//   1. CLIENT. "Pick a time myself" sends the chosen time and approves in one call, and a plain
//      approve lets the assistant pick a cadence slot — but the approved panel printed
//      `targets[0].publishDate`, a cache entry captured BEFORE the call. So it quoted the draft's
//      old proposed slot: the user picked Friday 3pm, the panel said Tuesday 9am, the calendar said
//      Friday 3pm.
//
//   2. SERVER. `toLocaleString('en-GB', …)` with no `timeZone` formats in the HOST's zone, and a
//      Netlify function's host is UTC. Through British Summer Time every confirmation was an hour
//      early — 15:00 read back as "14:00" — and for an org outside the UK it was however far out
//      their offset is.
//
// Source-level: the alternative is a live DB, an approve round trip and a fake system clock to catch
// what is, in both cases, one missing argument.
//
// Run:  npx tsx tests/schedule-confirmation-time.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const fn = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** The body of a named function, bounded by the next top-level one rather than a byte count. */
function bodyOf(src: string, decl: string): string {
    const from = landmark(src, decl);
    const after = src.indexOf('\nfunction ', from + 1);
    const afterAsync = src.indexOf('\nasync function ', from + 1);
    const ends = [after, afterAsync].filter(i => i !== -1);
    return src.slice(from, ends.length ? Math.min(...ends) : src.length);
}

check('the approved panel quotes the server, not the cache it was handed', () => {
    const ws = fn('workspace.html');

    // _rqApproveOne has to carry the settled time back at all — the response body has it, the
    // caller never read it.
    const one = bodyOf(ws, 'async function _rqApproveOne(');
    assert.match(one, /scheduledFor: d\.post\?\.publishDate/,
        'approve-post returns the updated row; the settled publish date has to come back with it');

    const panel = bodyOf(ws, 'function _rqShowApprovedPanel(');
    assert.match(panel, /function _rqShowApprovedPanel\(targets, action, scheduledFor\)/,
        'the panel cannot prefer the settled time without being given it');
    assert.match(panel, /const at = scheduledFor \|\| post\.publishDate/,
        'the server answer must win; the cached proposal is only the fallback');
    assert.ok(!/new Date\(post\.publishDate\)\.toLocaleString/.test(panel),
        'reading the cached publishDate directly is exactly the bug — it predates the approve call');
});

check('the cached rows are updated before anything reads them back', () => {
    const ws = fn('workspace.html');
    const inner = bodyOf(ws, 'async function _rqApproveTargetsInner(');
    assert.match(inner, /_rqShowApprovedPanel\(targets, action, settledAt\)/,
        'the panel must be handed the settled time');
    assert.match(inner, /_rqPostCache\[p\.id\]\.publishDate = when/,
        'the queue and the modal header read the cache — leave it stale and they quote the old slot too');
});

check('every date approve-post speaks is stamped with a timezone', () => {
    const approve = fn('netlify/functions/approve-post.ts');

    // One resolver, used by both messages. A bare toLocaleString anywhere in here is the bug back.
    assert.match(approve, /const say = \(d: Date\) => d\.toLocaleString\('en-GB', \{ dateStyle: 'medium', timeStyle: 'short', timeZone: displayTimezone \}\)/,
        'the one place a date becomes words must name the zone it is speaking in');
    assert.match(approve, /const dateLabel = say\(newPublishDate\)/, 'the confirmation goes through it');
    assert.match(approve, /\$\{say\(scheduledFor\)\}/, 'so does the past-schedule prompt');

    const bare = approve.match(/toLocaleString\((?![^)]*timeZone)/g) || [];
    assert.equal(bare.length, 0,
        `toLocaleString without a timeZone formats in the Lambda's zone (UTC): found ${bare.length}`);

    // The assistant's posting timezone, because that is the zone its cadence slots are computed in —
    // so the time the confirmation says and the schedule the user agreed are the same clock.
    assert.match(approve, /resolvePostingSchedule\(\(assistant\.onboardingContext as Record<string, unknown>\) \?\? \{\}\)\.timezone/,
        'the zone must come from the assistant, falling back to the posting default');
    assert.match(approve, /DEFAULT_POSTING_TIMEZONE/, 'an assistant-less post still needs a zone to speak in');
});

check('reschedule-post-chat says the time back in the zone it read it in', () => {
    const chat = fn('netlify/functions/reschedule-post-chat.ts');
    // The natural-language parser already resolved the assistant's zone to understand "3pm"; the
    // confirmation then answered in a hardcoded Europe/London, which is a different clock for any
    // org that is not in the UK.
    assert.ok(!/timeZone: 'Europe\/London'/.test(chat),
        'the confirmation must not be pinned to one country while the parser uses the org’s own zone');
    assert.match(chat, /timeZone: timezone/, 'one resolved zone, used to read the instruction and to answer it');

    // Resolved once, above the branch — the explicit-picker path quotes a date too and never went
    // near the assistant row.
    const resolve = chat.indexOf('let timezone =');
    const branch = chat.indexOf('if (rescheduleAt) {');
    assert.ok(resolve !== -1 && branch !== -1, 'expected both the resolver and the action branch');
    assert.ok(resolve < branch, 'the zone must be resolved before the branch, or one path has none');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
