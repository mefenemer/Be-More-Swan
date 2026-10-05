// tests/newsletter-sequence-no-route.test.ts
//
// Run:  npx tsx tests/newsletter-sequence-no-route.test.ts
//
// A welcome sequence / form email campaign with no way to send (no verified sending domain, no
// connected mailbox) used to HALT each enrolment on the spot with halt_reason 'no_route' — no error,
// no notification, never resumed. Found 2026-10-05 testing the waitlist: the sequence was "on", the
// sign-up worked, and the email simply never came. These checks keep the fix in place:
//   1. no route WAITS (retried hourly) for NO_ROUTE_WAIT_DAYS before it halts;
//   2. the owner is told, through a notification type declared everywhere a type must be;
//   3. switching a sequence on with no route says so.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryOf } from '../src/utils/notification-actions';
import { PREF_CATEGORIES } from '../src/utils/notification-prefs';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { NO_ROUTE_WAIT_DAYS } from '../src/utils/newsletter-sequence';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const WORKER = read('src/utils/newsletter-sequence.ts');
const TYPE = 'newsletter_sequence_blocked';

check('no route waits instead of halting on the spot', () => {
    const start = landmark(WORKER, "if ('error' in routed) {");
    const block = WORKER.slice(start, landmark(WORKER, 'continue;\n            }', start) + 30);
    assert.doesNotMatch(block.split('\n')[0], /halt\(row\.id, 'no_route'\)/,
        'the route check halts immediately again — everyone who signs up before a mailbox is connected is lost, silently');
    assert.match(block, /NO_ROUTE_WAIT_DAYS/, 'the halt must be gated on how long the enrolment has waited');
    assert.match(block, /nextSendAt: new Date\(now\.getTime\(\) \+ NO_ROUTE_RETRY_MS\)/, 'a waiting enrolment must be rescheduled, or it is retried every tick');
    assert.match(block, /notifyBlocked\(/, 'the owner must be told');
    assert.ok(NO_ROUTE_WAIT_DAYS >= 1, 'a wait under a day would halt people before anyone could react');
});

check(`${TYPE} is declared everywhere a notification type has to be`, () => {
    assert.strictEqual(categoryOf(TYPE), 'suggested_action', 'categorise it in notification-actions.ts');
    const cats = PREF_CATEGORIES.filter((c) => (c.types as readonly string[]).includes(TYPE));
    assert.strictEqual(cats.length, 1, 'it must sit in exactly one preference category, or the user cannot mute it');
    const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === TYPE);
    assert.ok(tpl, 'it needs a catalogue template — the catalogue is also the fallback copy');
    assert.strictEqual(tpl!.type, TYPE);
    const declared = new Set(tpl!.variables.map((v) => v.key));
    for (const [, path] of `${tpl!.title} ${tpl!.message}`.matchAll(/\{\{([^}]+)\}\}/g)) {
        assert.ok(declared.has(path.trim()), `the template renders {{${path.trim()}}} but does not declare it`);
    }
    // The DB trigger maps unknown types to 'informational'; the call site must stamp the category.
    assert.match(WORKER, new RegExp(`createNotification\\(db, '${TYPE}', \\{[\\s\\S]{0,200}category: 'suggested_action'`));
});

check('switching a sequence on with no route says so', () => {
    const fn = read('netlify/functions/newsletter-sequences.ts');
    const block = fn.slice(landmark(fn, "if (action === 'enable') {"));
    assert.match(block, /resolveSendRoute\(/, 'enable must check for a way to send');
    assert.match(block, /sendBlocked/, 'and report it to the Studio');
});

if (process.exitCode) console.error('\nnewsletter sequence no-route: FAILED');
else console.log(`\nnewsletter sequence no-route: ${passed} passed`);
