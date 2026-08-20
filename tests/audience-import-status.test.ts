// tests/audience-import-status.test.ts
// Importing somebody else's list without re-subscribing the people who left it.
//
// Until 2026-08-20 the importer wrote `status: 'subscribed'` for every row. A tenant migrating from
// Mailchimp or Kit exports their audience — which includes the unsubscribes — imports it here, and
// those people come back as subscribers and get emailed again, from the tenant's own domain, on the
// tenant's own reputation. Three clicks, a success toast, and a compliance breach.
//
// The three ways this can still go wrong, all covered below:
//   1. Reading "cleaned" as healthy. It is Mailchimp's word for a hard bounce.
//   2. Guessing at a value we do not recognise. Either guess is wrong: "subscribed" re-opens the
//      original bug, "unsubscribed" silently bins an entire import.
//   3. Letting an imported opt-out claim a consent basis, or land in a segment.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMailable, resolveImportStatus, STATUS_HEADER_ALIASES } from '../src/config/audience-import-status';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const ENDPOINT = read('netlify/functions/audience-contacts.ts');
const CLIENT = read('audience.js');
const STORE = read('src/utils/audience-store.ts');

async function main() {

// ── 1. The values ───────────────────────────────────────────────────────────

await check('an unsubscribe in the file stays an unsubscribe here', () => {
    for (const raw of ['unsubscribed', 'Unsubscribed', ' UNSUB ', 'opted out', 'not_subscribed', 'inactive', 'no', 'false', '0']) {
        const v = resolveImportStatus(raw);
        assert.equal(v.status, 'unsubscribed', `${JSON.stringify(raw)} must import as unsubscribed`);
        assert.equal(isMailable(v.status!), false);
    }
});

await check('"cleaned" is a hard bounce, not a healthy subscriber', () => {
    // Mailchimp's own vocabulary, and the single most likely way to import a dead address as a
    // contact and then damage a sending domain with it.
    assert.equal(resolveImportStatus('cleaned').status, 'bounced');
    assert.equal(resolveImportStatus('Bounced').status, 'bounced');
    assert.equal(isMailable('bounced'), false);
});

await check('a spam complaint survives the migration', () => {
    for (const raw of ['complained', 'spam', 'abuse']) {
        assert.equal(resolveImportStatus(raw).status, 'complained');
    }
    assert.equal(isMailable('complained'), false);
});

await check('somebody who never confirmed arrives unconfirmed, not subscribed', () => {
    assert.equal(resolveImportStatus('pending').status, 'pending');
    assert.equal(resolveImportStatus('unconfirmed').status, 'pending');
    assert.equal(isMailable('pending'), false, 'double opt-in is decorative if an import can skip it');
});

await check('an ordinary subscriber is mailable, and only that state is', () => {
    for (const raw of ['subscribed', 'active', 'confirmed', 'yes', 'true', '1']) {
        assert.equal(resolveImportStatus(raw).status, 'subscribed');
    }
    assert.equal(isMailable('subscribed'), true);
});

await check('no status column means the import default, not a guess', () => {
    // A plain "here are some people to add" list is the ordinary case and must keep working.
    for (const raw of ['', '   ', null, undefined]) {
        const v = resolveImportStatus(raw);
        assert.equal(v.status, null);
        assert.equal(v.unrecognised, false, 'an empty cell is not an unreadable one');
    }
});

await check('a value we do not recognise is refused, not guessed', () => {
    // Both guesses are wrong. "Subscribed" re-opens the original bug for that row; "unsubscribed"
    // would silently discard an import over one unexpected column match.
    const v = resolveImportStatus('archived-2019');
    assert.equal(v.status, null);
    assert.equal(v.unrecognised, true);
});

// ── 2. The endpoint acts on it ──────────────────────────────────────────────

await check('the import reads the status column at all', () => {
    const imp = ENDPOINT.slice(landmark(ENDPOINT, "if (action === 'import')"));
    assert.match(imp, /resolveImportStatus/);
    assert.match(imp, /verdict\.unrecognised/, 'and refuses what it cannot read');
});

await check('an unreadable row is skipped and reported, never imported', () => {
    const imp = ENDPOINT.slice(landmark(ENDPOINT, "if (action === 'import')"));
    const guard = imp.slice(landmark(imp, 'if (verdict.unrecognised)'), landmark(imp, 'const status = verdict.status'));
    assert.match(guard, /continue;/, 'the row must not reach the upsert');
    assert.match(imp, /unreadableStatuses/, 'and the caller has to be told which values stopped it');
});

await check('an imported opt-out claims no consent basis', () => {
    // 'imported_declared' means "the importer says these people agreed". Stamping it on somebody
    // who explicitly said the opposite is a false record, in the table that exists to be evidence.
    const imp = ENDPOINT.slice(landmark(ENDPOINT, "if (action === 'import')"));
    assert.match(imp, /consentBasis: null/);
    assert.match(imp, /status !== 'subscribed' \? \{ consentBasis: null \}/);
});

await check('an imported opt-out gets an unsubscribed event, not an imported one', () => {
    const imp = ENDPOINT.slice(landmark(ENDPOINT, "if (action === 'import')"));
    assert.match(imp, /optedOut \? \('unsubscribed' as const\) : \('imported' as const\)/,
        'the consent timeline must not show "imported" against somebody we may never email');
});

await check('an imported opt-out never joins a segment', () => {
    // A segment whose count includes people we may never email overstates every send built on it.
    const imp = ENDPOINT.slice(landmark(ENDPOINT, "if (action === 'import')"));
    const seg = imp.slice(landmark(imp, 'if (seg) {'));
    assert.match(seg.slice(0, 400), /c\.status === 'subscribed'/);
});

await check('the store applies the row\'s own status, not one for the whole batch', () => {
    assert.match(STORE, /status: r\.status \?\? args\.status/);
    // And the ratchet still refuses to RAISE a terminal state, in both directions.
    const set = STORE.slice(landmark(STORE, 'export async function bulkUpsertContacts'));
    assert.match(set, /WHEN \$\{audienceContacts\.status\} IN \('unsubscribed','bounced','complained','suppressed'\)/);
});

// ── 3. The person doing it is told ──────────────────────────────────────────

await check('the file with no status column carries a warning BEFORE the import runs', () => {
    // This is the case where importing quietly re-subscribes people, so it is the case that has to
    // be said out loud while the button is still unpressed.
    // ⚠️ Both bounds anchored FORWARD from the start. `show(preview` also appears in the two error
    // branches above this block, and an unanchored end bound lands before the start — which
    // slice() answers with '' and the assertion then reports a missing warning that is right there.
    const from = landmark(CLIENT, 'const hasStatus = idx.status >= 0;');
    const preview = CLIENT.slice(from, landmark(CLIENT, 'show(preview', from));
    assert.match(preview, /No status column found/);
    assert.match(preview, /unsubscribed there will be emailed again/);
});

await check('carried-over opt-outs are reported as their own number', () => {
    // Folded into "skipped", a tenant would assume their unsubscribes did not come across and go
    // looking for a way to re-add them.
    assert.match(CLIENT, /kept as unsubscribed/);
    assert.match(CLIENT, /unsubscribedFromFile/);
    assert.match(ENDPOINT, /unsubscribedFromFile: unsubscribedRows/);
});

await check('the client and the server agree on which headers are a status column', () => {
    // The client picks the column; the server reads the values. If the two lists diverge the
    // column is never picked and the whole feature silently reverts to the old behaviour.
    const at = landmark(CLIENT, "status: ['status'");
    const list = CLIENT.slice(at, landmark(CLIENT, '  };', at));
    for (const alias of STATUS_HEADER_ALIASES) {
        assert.ok(list.includes(`'${alias}'`), `audience.js is missing the "${alias}" header alias`);
    }
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
