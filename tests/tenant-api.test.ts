// tests/tenant-api.test.ts
// The tenant-facing API: a shop, a booking system or a Zapier step writing into their own audience.
//
// ⚠️ THE FAILURE THIS EXISTS TO NOT HAVE. Every subscriber API's characteristic disaster is a
// nightly sync from a CRM that does not know who opted out, posting the whole customer table as
// `subscribed` and quietly re-subscribing everybody who left. It is not hypothetical and it is not
// rare — it is the default behaviour of a naive integration, and it emails people who said no from
// the tenant's own domain.
//
// Four more, each checked below:
//   · A leaked key that can mint another key, making one leak permanent.
//   · A key readable from a database row, a backup, or over a support engineer's shoulder.
//   · A write with no answer to "who said these people agreed?".
//   · An erase performed by a sync, leaving a tenant with an opt-out list they never chose.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    API_RATE, hashApiKey, KEY_PREFIX, mintApiKey, readBearer, redactKey,
} from '../src/utils/tenant-api-auth';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

const API = read('netlify/functions/audience-api.ts');
const KEYS = read('netlify/functions/api-keys.ts');
const AUTH = read('src/utils/tenant-api-auth.ts');
const STORE = read('src/utils/audience-store.ts');
const SQL = read('db/tenant-api-keys.sql');
const TOML = read('netlify.toml');
const UI = read('audience.js');

console.log('\nThe tenant-facing API\n');

// ── 1. A write can never resurrect an unsubscribe ───────────────────────────

check('the ratchet is the store\'s, not re-implemented here', () => {
    // The API must not have its own idea of when a status may change.
    assert.match(STORE, /WHEN \$\{audienceContacts\.status\} IN \('unsubscribed','bounced','complained','suppressed'\)/);
    assert.ok(!/unsubscribed','bounced'/.test(API), 'the API must not carry a second copy of the rule');
});

check('the response reports the status they ACTUALLY have', () => {
    // ⚠️ Returning "ok" for a request that was refused is what lets a nightly sync keep trying for
    // ever without anybody noticing.
    const fn = API.slice(landmark(API, 'const honoured = res.status === wanted'));
    assert.match(fn, /statusHonoured: honoured/);
    assert.match(fn, /contact: \{ email, status: res\.status \}/);
    assert.match(fn, /already opted out, bounced or been suppressed/);
});

check('a caller cannot announce a status only the world can cause', () => {
    // 'bounced' and 'complained' are things that HAPPENED; a caller asserting one would be writing
    // a fact it cannot know.
    const fn = API.slice(landmark(API, "const wanted = String(body.status"), landmark(API, 'const customKeys'));
    assert.match(fn, /\['subscribed', 'pending'\]\.includes\(wanted\)/);
    assert.match(fn, /Use the unsubscribe endpoint/);
});

check('the index says the rule out loud, before anybody integrates', () => {
    // Anchored on the comment that introduces the branch — a regex literal makes a brittle marker.
    const fn = API.slice(landmark(API, 'The index answers without a key'), landmark(API, 'const auth = await authenticateApiKey'));
    assert.match(fn, /can never move somebody out of unsubscribed/);
});

// ── 2. Consent is declared per call ─────────────────────────────────────────

check('a write with no declared basis is refused', () => {
    // The same rule the CSV import applies: the answer to "who said they agreed?" attaches to the
    // act, not to a setting somebody ticked in March.
    const fn = API.slice(landmark(API, 'const consent = '), landmark(API, 'const wanted'));
    assert.match(fn, /consent_required/);
    assert.match(fn, /CONSENT_BASES\.includes\(basis\)/);
});

check('the basis comes from a closed list', () => {
    assert.match(API, /const CONSENT_BASES: ConsentBasis\[\]/);
    assert.match(API, /NOT free text/);
});

check('every write records a consent event, with the key on it', () => {
    const fn = API.slice(landmark(API, 'await recordConsentEvent'), landmark(API, 'THE STATUS WE RETURN'));
    assert.match(fn, /channel: 'api'/);
    assert.match(fn, /key #\$\{auth\.keyId\}/);
    // The event names what happened, not what was asked for.
    assert.match(fn, /res\.status === 'subscribed' \? 'confirmed' : 'subscribe_requested'/);
});

// ── 3. The key itself ───────────────────────────────────────────────────────

check('a key is stored as a hash and shown once', () => {
    const minted = mintApiKey();
    assert.ok(minted.key.startsWith(KEY_PREFIX));
    assert.strictEqual(minted.hash, hashApiKey(minted.key));
    assert.notStrictEqual(minted.hash, minted.key);
    assert.ok(minted.prefix.length < minted.key.length / 3, 'the prefix must not be most of the key');
    assert.ok(minted.key.startsWith(minted.prefix));
});

check('two keys are never the same', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintApiKey().key));
    assert.strictEqual(seen.size, 200);
});

check('no endpoint can return a key after creation', () => {
    // Not a policy — the stored form is a hash, so there is nothing to return.
    assert.ok(!/keyHash: apiKeys\.keyHash/.test(KEYS), 'the list must not even select the hash');
    assert.match(KEYS, /The prefix, never the key/);
    assert.match(KEYS, /ONLY time the key itself exists outside/);
});

check('the plain hash is justified rather than accidental', () => {
    // A password wants bcrypt; 32 bytes of CSPRNG has nothing to brute-force, and a slow hash on a
    // checkout's hot path is a self-inflicted rate limit.
    assert.match(AUTH, /A plain sha256, deliberately/);
    assert.match(AUTH, /nothing to brute-force/);
});

check('a key cannot mint another key', () => {
    // ⚠️ Otherwise one leak is permanent.
    assert.match(KEYS, /Session-authenticated \(NOT key-authenticated\)/);
    assert.match(KEYS, /requireTenant/);
    assert.ok(!/authenticateApiKey/.test(KEYS));
});

check('minting and revoking are owner/admin only', () => {
    assert.match(KEYS, /const MANAGE_ROLES = \['owner', 'admin'\]/);
});

check('a revoked key is kept, not deleted', () => {
    assert.match(SQL, /REVOKED, NOT DELETED/);
    assert.match(KEYS, /set\(\{ revokedAt: new Date\(\) \}\)/);
    assert.ok(!/db\.delete\(apiKeys\)/.test(KEYS));
});

check('a revoked key stops authenticating immediately', () => {
    assert.match(AUTH, /isNull\(apiKeys\.revokedAt\)/);
});

check('every auth failure is the same answer', () => {
    // "That key is revoked" tells a holder of a stolen key that it was real.
    const fn = AUTH.slice(landmark(AUTH, 'export async function authenticateApiKey'));
    assert.strictEqual((fn.match(/return denied/g) || []).length, 3, 'one shared denial, used everywhere');
    assert.match(AUTH, /EVERY FAILURE IS THE SAME 401/);   // stated in the doc comment above it
});

check('a key is never logged whole', () => {
    assert.match(AUTH, /export const redactKey/);
    assert.strictEqual(redactKey('bms_live_abcdef0123456789').includes('0123456789'), false);
    assert.strictEqual(redactKey(''), '(none)');
});

check('the bearer header is read in the shapes people actually send', () => {
    assert.strictEqual(readBearer({ authorization: 'Bearer abc' }), 'abc');
    assert.strictEqual(readBearer({ Authorization: '  Bearer   abc  ' }), 'abc');
    assert.strictEqual(readBearer({ authorization: 'abc' }), 'abc', 'a bare key is accepted rather than silently failing');
    assert.strictEqual(readBearer({}), '');
});

// ── 4. What the API refuses to do ───────────────────────────────────────────

check('DELETE is refused, and says what to use instead', () => {
    // ⚠️ Erasing also writes a permanent block on the address (THE DELETE RULE). Doing that from a
    // nightly sync would leave a tenant with a growing opt-out list they never chose.
    const fn = API.slice(landmark(API, "if (method === 'DELETE'"), landmark(API, '// ── Create or update'));
    assert.match(fn, /use_dashboard/);
    assert.match(fn, /Use POST \/unsubscribe/);
    assert.match(fn, /Erasure is a decision, not a sync artefact/);
});

check('unsubscribing an address we do not hold is a success', () => {
    // "Make sure this person is not subscribed" is satisfied by an address we never had, and a 404
    // would push callers into ignoring the response.
    const fn = API.slice(landmark(API, "if (method === 'POST' && emailMatch && emailMatch[2])"), landmark(API, "if (method === 'DELETE'"));
    assert.match(fn, /Not found is not an error here/);
    assert.match(fn, /status: 'unsubscribed'/);
});

check('only the tenant\'s own custom field keys can be written', () => {
    assert.match(API, /function pickCustom/);
    assert.match(API, /loadCustomFieldKeys/);
});

// ── 5. Wiring ───────────────────────────────────────────────────────────────

check('it is rate limited per KEY, not per IP', () => {
    // A tenant's server has one address and may legitimately be busy; a runaway loop is the thing
    // being bounded.
    assert.match(API, /`key:\$\{auth\.keyId\}`/);
    assert.ok(API_RATE.maxAttempts >= 100 && API_RATE.windowSecs === 60);
});

check('the route is rewritten, and the ordering trap is named', () => {
    const block = TOML.slice(landmark(TOML, 'from = "/api/v1/*"'), landmark(TOML, 'from = "/api/v1/*"') + 200);
    assert.match(block, /audience-api/);
    assert.match(block, /status = 200/);
    assert.match(TOML, /must stay\n# above any future \/api\/\* catch-all/);
});

check('the index needs no key', () => {
    // A developer with the base url and no credentials should be able to find out what to ask for.
    assert.ok(landmark(API, 'The index answers without a key') < landmark(API, 'const auth = await authenticateApiKey'));
});

check('the UI says the key is shown once', () => {
    assert.match(UI, /it is not shown again/);
    assert.match(UI, /Base URL/);
});

console.log(`\n${passed} checks passed.`);
