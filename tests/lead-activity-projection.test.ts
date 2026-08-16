// tests/lead-activity-projection.test.ts
// The sentences the Lead Generator's Activity tab actually shows, and the two ways they go wrong
// silently.
//
// WHY THIS EXISTS. get-lead-activity.ts is a PROJECTION over `revenue_events` — it invents no
// facts, so nothing it does can fail loudly. Both of its real failure modes render perfectly:
//
//   1. AN ICON THAT ISN'T IN THE CLIENT'S MAP. assistants.js looks `log.icon` up in a literal
//      object and falls through to a grey cog on a miss. Ship 'trophy' and every deal won draws a
//      settings cog — no error, no warning, in the one feed a user reads to see what happened.
//      §2 cross-checks every icon this module can emit against that map's real keys.
//   2. A SALES OUTCOME TYPED AS AN OPERATIONAL ONE. The client groups status 'failed' and
//      'needs_input' into a "Needs attention" block above the history. A deal the user themselves
//      marked lost is neither broken nor waiting on them; typing it 'failed' files a closed deal
//      under alarms. §3 pins the terminal three.
//
// §4 covers the wording that carries a number or a name — a follow-up that says "#0", or a deal
// won for "" because the lead was deleted, is the kind of thing only a rendered assertion catches.
//
// The module is pure (no db, no Netlify) precisely so this file can call it. §5 guards that.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';
import { EVENT_TYPES } from '../src/config/revenue-events';
import { describeLeadEvent } from '../src/config/lead-activity-events';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const DETAIL = read('assistants.js');
const SOURCE = read('src/config/lead-activity-events.ts');
const FUNCTION = read('netlify/functions/get-lead-activity.ts');

/** Every event type, projected with a name and without one. */
const ALL = EVENT_TYPES.map((t) => ({
    type: t,
    named: describeLeadEvent({ eventType: t, payload: {}, outcome: null, lossReason: null, valueGbp: null }, 'Acme Ltd'),
    anon: describeLeadEvent({ eventType: t, payload: {}, outcome: null, lossReason: null, valueGbp: null }, null),
}));

console.log('\n──── 1. the closed vocabulary is covered ────');

check('every ledger event type projects to something renderable', () => {
    const missing = ALL.filter((e) => e.named === null).map((e) => e.type);
    // Skipping is a legitimate choice for this presentation layer, but it must be a CHOICE. A new
    // event type added to revenue-events.ts and forgotten here is invisible on the feed: the work
    // happened, the row was banked, and the tab says nothing.
    assert.deepStrictEqual(missing, [],
        `these event types are banked but never shown: ${missing.join(', ')} — add them to `
        + 'EVENT_META in src/config/lead-activity-events.ts, or state the omission here');
});

check('an event type outside the vocabulary is skipped, not printed raw', () => {
    assert.strictEqual(
        describeLeadEvent({ eventType: 'some_future_event', payload: {} }, 'Acme Ltd'), null,
        'an unknown event type must project to null — rendering its raw event_type puts '
        + '"some_future_event" in front of a user');
});

check('a non-object payload does not throw', () => {
    // `payload` is jsonb. NULL, a bare string and an array are all things a column can hold, and a
    // feed that 500s because one old row has a null payload takes the whole tab down with it.
    for (const payload of [null, undefined, 'a string', [1, 2, 3], 42]) {
        assert.doesNotThrow(
            () => describeLeadEvent({ eventType: 'lead_discovered', payload }, 'Acme Ltd'),
            `payload ${JSON.stringify(payload) ?? 'undefined'} threw`);
    }
});

console.log('\n──── 2. icons resolve in the client, not to a grey cog ────');

check('every icon this module emits is a key in the client icon map', () => {
    // The map is a literal inside assistants.js. Slice it and read the real keys rather than
    // hardcoding a list here — a list would drift and then agree with itself forever.
    const map = DETAIL.slice(
        landmark(DETAIL, 'const iconSvg = (icon) => {'),
        landmark(DETAIL, 'const iconBg = '),
    );
    const known = new Set([...map.matchAll(/^\s{28}'?([a-z-]+)'?:\s*`<svg/gm)].map((m) => m[1]));
    assert.ok(known.size >= 10,
        `only parsed ${known.size} icon keys out of assistants.js — the map's shape changed and `
        + 'this check is no longer reading it');

    const used = [...new Set(ALL.map((e) => e.named?.icon).filter((i): i is string => !!i))];
    const unknown = used.filter((i) => !known.has(i));
    assert.deepStrictEqual(unknown, [],
        `these icons are not in assistants.js's iconSvg map and will render as a grey cog: `
        + `${unknown.join(', ')} (known: ${[...known].sort().join(', ')})`);
});

console.log('\n──── 3. status is the operational outcome, not the sales result ────');

check('no terminal event is filed under "Needs attention"', () => {
    for (const type of ['deal_won', 'deal_lost', 'deal_disqualified'] as const) {
        const p = describeLeadEvent({ eventType: type, payload: {}, outcome: null, lossReason: null, valueGbp: null }, 'Acme Ltd');
        assert.ok(p, `${type} did not project`);
        assert.ok(p!.status !== 'failed' && p!.status !== 'needs_input',
            `${type} is status '${p!.status}' — the client groups failed + needs_input into `
            + '"Needs attention", which would file a deal the USER closed under alarms');
    }
});

check('the two events that do want attention keep it', () => {
    // The counterpart to the check above: this feed is worthless as an alarm if nothing can alarm.
    const bounced = describeLeadEvent({ eventType: 'outreach_bounced', payload: {} }, 'Acme Ltd');
    assert.strictEqual(bounced?.status, 'failed', 'a bounced email must surface — delivery failed');
    const override = describeLeadEvent({ eventType: 'do_not_contact_overridden', payload: {} }, 'Acme Ltd');
    assert.strictEqual(override?.status, 'needs_input',
        'a compliance gate being overridden must be conspicuous');
});

check('a halted sequence is not an alarm', () => {
    // ⚠️ The commonest halt reason is "they replied", which is the best outcome the cadence has.
    const halted = describeLeadEvent({ eventType: 'sequence_halted', payload: { haltReason: 'replied' } }, 'Acme Ltd');
    assert.strictEqual(halted?.status, 'info',
        'a stopped cadence is pinned to "Needs attention" — but the usual reason it stops is a reply');
    assert.match(halted!.description, /replied/,
        'the halt reason is not said, so the user cannot tell a reply from a suppression');
});

console.log('\n──── 4. the wording carries the number and the name ────');

check('the opening email and a follow-up read differently', () => {
    const opener = describeLeadEvent({ eventType: 'outreach_sent', payload: {} }, 'Acme Ltd');
    assert.match(opener!.description, /opening email to Acme Ltd/,
        'the opener does not identify itself as the first email');
    assert.ok(!/#/.test(opener!.description), `the opener printed a step number: "${opener!.description}"`);

    const third = describeLeadEvent({ eventType: 'outreach_sent', payload: { sequenceStep: 3 } }, 'Acme Ltd');
    assert.match(third!.description, /follow-up #3 to Acme Ltd/,
        `a sequence follow-up does not say which one: "${third!.description}"`);

    // Step 0 is the opener's own encoding — it must not render as "follow-up #0".
    const zero = describeLeadEvent({ eventType: 'outreach_sent', payload: { sequenceStep: 0 } }, 'Acme Ltd');
    assert.match(zero!.description, /opening email/, `step 0 rendered as "${zero!.description}"`);
});

check('a deal won says the amount, and stays silent when there is none', () => {
    const withValue = describeLeadEvent(
        { eventType: 'deal_won', payload: {}, outcome: 'won', lossReason: null, valueGbp: '4200.00' }, 'Acme Ltd');
    assert.match(withValue!.description, /£4,200/,
        `a won deal does not state its value legibly: "${withValue!.description}"`);

    for (const valueGbp of [null, '0', '0.00']) {
        const none = describeLeadEvent(
            { eventType: 'deal_won', payload: {}, outcome: 'won', lossReason: null, valueGbp }, 'Acme Ltd');
        assert.ok(!/£/.test(none!.description),
            `a won deal with value ${String(valueGbp)} printed a currency figure: "${none!.description}"`);
    }
});

check('a deleted lead degrades to "a lead", never to an empty subject', () => {
    // The name is resolved by a second query; a lead deleted since the event was banked resolves
    // to null. "Scored ." and "Deal won ." are the failure this guards.
    const broken = ALL
        .filter((e) => e.anon)
        .filter((e) => /\s\.|\sfor\s*\.|\sto\s*\.|\s{2}/.test(e.anon!.description))
        .map((e) => `${e.type}: "${e.anon!.description}"`);
    assert.deepStrictEqual(broken, [],
        `these read as a dangling sentence when the lead has been deleted:\n    ${broken.join('\n    ')}`);
});

check('every sentence ends in a full stop and names no raw identifier', () => {
    for (const e of ALL) {
        const d = e.named!.description;
        assert.match(d, /\.$/, `${e.type} does not end in a full stop: "${d}"`);
        // snake_case leaking through is the tell that a payload value was interpolated raw.
        assert.ok(!/[a-z]+_[a-z]+/.test(d),
            `${e.type} shows a raw snake_case identifier: "${d}"`);
    }
});

console.log('\n──── 5. the projection stays testable ────');

check('the projection module imports neither a database nor Netlify', () => {
    // The whole point of the extraction. One `db/client` import here and every check above dies at
    // module load, needing a live connection to assert on a sentence.
    for (const forbidden of ['db/client', 'db/schema', '@netlify/', 'aws-lambda']) {
        assert.ok(!SOURCE.includes(forbidden),
            `src/config/lead-activity-events.ts imports ${forbidden} — it must stay pure so the `
            + 'wording can be tested without a database');
    }
});

check('the function delegates its wording rather than keeping a second copy', () => {
    assert.match(FUNCTION, /describeLeadEvent/,
        'get-lead-activity.ts no longer calls describeLeadEvent — if the wording moved back inline, '
        + 'this suite is asserting on a module nothing renders');
    assert.ok(!FUNCTION.includes('const EVENT_META'),
        'get-lead-activity.ts has its own EVENT_META again — two copies of the wording means the '
        + 'tested one and the shipped one can differ');
});

console.log(`\n${passed} checks passed.\n`);
