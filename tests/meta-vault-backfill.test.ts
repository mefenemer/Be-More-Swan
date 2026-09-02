// tests/meta-vault-backfill.test.ts
// The plan behind scripts/backfill-meta-vault-keys.ts, which moves Meta connections off the legacy
// org+service vault key (`aura/org-<id>/<service>-token`) and onto the account-scoped key.
//
// The dangerous case is the one this file exists for: TWO rows in one workspace pointing at ONE
// legacy key. Only one of them can own that secret — it belongs to whichever account connected
// last — so a plan that "migrates" both would copy one account's token onto the other's key and
// make today's broken pairing permanent, under a name that looks correct. The plan must therefore
// mark such rows CONTESTED and leave the resolution to evidence (a live Meta reach check, or
// newest-wins under --no-verify), never to the copy.
//
// Run:  npx tsx tests/meta-vault-backfill.test.ts

import assert from 'node:assert';
import { buildSocialRefKey } from '../src/utils/vault';
import {
    planBackfill, legacyKeyFor, isVaultConfigError, missingVaultVar,
    classifyGraphError, describeGraphError, type ConnRow,
} from '../scripts/backfill-meta-vault-keys';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const row = (over: Partial<ConnRow> & { id: number }): ConnRow => ({
    organisationId: 37,
    serviceName: 'instagram',
    externalUserId: '17841414318461950',
    vaultRefKey: legacyKeyFor(37, 'instagram'),
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
});

const find = (plan: ReturnType<typeof planBackfill>, id: number) => plan.find(p => p.row.id === id)!;

console.log('\nMeta vault key backfill — the plan\n');

// ── The sole owner: unambiguous ──────────────────────────────────────────────────────────────

test('a lone legacy row moves to its account-scoped key', () => {
    const plan = planBackfill([row({ id: 1 })]);
    assert.strictEqual(find(plan, 1).action, 'migrate');
    assert.strictEqual(find(plan, 1).fromKey, 'aura/org-37/instagram-token');
    assert.strictEqual(find(plan, 1).toKey, buildSocialRefKey(37, 'instagram', '17841414318461950'));
    assert.strictEqual(find(plan, 1).sharedWith, 1);
});

test('a row already on the new key is left alone', () => {
    const already = row({ id: 2, vaultRefKey: buildSocialRefKey(37, 'instagram', '17841414318461950') });
    assert.strictEqual(find(planBackfill([already]), 2).action, 'current');
});

test('the plan is idempotent — a second pass over migrated rows plans nothing', () => {
    const first = planBackfill([row({ id: 1 })]);
    const migrated = row({ id: 1, vaultRefKey: find(first, 1).toKey });
    assert.strictEqual(find(planBackfill([migrated]), 1).action, 'current');
});

// ── The contested case: two accounts, one secret ─────────────────────────────────────────────

test('two rows on ONE legacy key are BOTH contested, never both migrated', () => {
    // The org-37 shape: bemoreswan connected first, love.cat.studio overwrote the secret.
    const plan = planBackfill([
        row({ id: 1, externalUserId: '17841414318461950', updatedAt: '2026-08-01T00:00:00.000Z' }),
        row({ id: 2, externalUserId: '17841467511229378', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    assert.deepStrictEqual([find(plan, 1).action, find(plan, 2).action], ['contested', 'contested']);
    assert.ok(
        !plan.some(p => p.action === 'migrate'),
        'copying one token onto both keys would make the broken pairing permanent',
    );
    assert.strictEqual(find(plan, 1).sharedWith, 2);
});

test('the newest row of a contested group is identified, and only one of them is', () => {
    const plan = planBackfill([
        row({ id: 1, externalUserId: 'A', updatedAt: '2026-08-01T00:00:00.000Z' }),
        row({ id: 2, externalUserId: 'B', updatedAt: '2026-09-01T00:00:00.000Z' }),
        row({ id: 3, externalUserId: 'C', updatedAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    assert.deepStrictEqual(plan.filter(p => p.newestOfGroup).map(p => p.row.id), [2]);
});

test('a tie on updated_at still resolves to exactly one row, deterministically', () => {
    // Two rows CAN carry the same timestamp. A plan that changes between the dry run and the apply
    // is worse than no plan, so the tie-break is on id and must not depend on input order.
    const same = '2026-09-01T00:00:00.000Z';
    const forward = planBackfill([
        row({ id: 1, externalUserId: 'A', updatedAt: same }),
        row({ id: 2, externalUserId: 'B', updatedAt: same }),
    ]);
    const reversed = planBackfill([
        row({ id: 2, externalUserId: 'B', updatedAt: same }),
        row({ id: 1, externalUserId: 'A', updatedAt: same }),
    ]);
    assert.deepStrictEqual(forward.filter(p => p.newestOfGroup).map(p => p.row.id), [2]);
    assert.deepStrictEqual(reversed.filter(p => p.newestOfGroup).map(p => p.row.id), [2]);
});

test('a null updated_at never wins the group', () => {
    const plan = planBackfill([
        row({ id: 1, externalUserId: 'A', updatedAt: null }),
        row({ id: 2, externalUserId: 'B', updatedAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    assert.deepStrictEqual(plan.filter(p => p.newestOfGroup).map(p => p.row.id), [2]);
});

// ── Groups are per stored key, not per (org, service) ────────────────────────────────────────

test('a row already migrated does not make its old neighbour contested', () => {
    // The half-migrated state: one account reconnected since the fix, one did not. The remaining
    // legacy row is now the sole reader of that secret and is safe to move.
    const plan = planBackfill([
        row({ id: 1, externalUserId: 'A' }),
        row({ id: 2, externalUserId: 'B', vaultRefKey: buildSocialRefKey(37, 'instagram', 'B') }),
    ]);
    assert.strictEqual(find(plan, 1).action, 'migrate');
    assert.strictEqual(find(plan, 2).action, 'current');
});

test('facebook and instagram in one org are separate secrets, not a contest', () => {
    const plan = planBackfill([
        row({ id: 1, serviceName: 'instagram', externalUserId: 'IG' }),
        row({ id: 2, serviceName: 'facebook', externalUserId: 'PAGE', vaultRefKey: legacyKeyFor(37, 'facebook') }),
    ]);
    assert.deepStrictEqual([find(plan, 1).action, find(plan, 2).action], ['migrate', 'migrate']);
});

test('the same account in two orgs is two separate migrations', () => {
    const plan = planBackfill([
        row({ id: 1, organisationId: 37, externalUserId: 'SHARED' }),
        row({ id: 2, organisationId: 38, externalUserId: 'SHARED', vaultRefKey: legacyKeyFor(38, 'instagram') }),
    ]);
    assert.deepStrictEqual([find(plan, 1).action, find(plan, 2).action], ['migrate', 'migrate']);
    assert.notStrictEqual(find(plan, 1).toKey, find(plan, 2).toKey, 'org isolation must survive the move');
});

// ── Rows that cannot be moved ────────────────────────────────────────────────────────────────

test('a row with no vault_ref_key is reported, not migrated', () => {
    assert.strictEqual(find(planBackfill([row({ id: 1, vaultRefKey: null })]), 1).action, 'no_key');
});

test('a row with no external_user_id cannot be given an account-scoped key', () => {
    const plan = planBackfill([row({ id: 1, externalUserId: null })]);
    assert.strictEqual(find(plan, 1).action, 'no_account');
    assert.strictEqual(find(plan, 1).toKey, null, 'there is no key to build — it must not be guessed');
});

test('an unfamiliar key shape is left alone for a human', () => {
    const plan = planBackfill([row({ id: 1, vaultRefKey: 'aura/org-37/instagram-legacy-hand-edited' })]);
    assert.strictEqual(find(plan, 1).action, 'unrecognised');
});

// ── The invariant the whole script rests on ──────────────────────────────────────────────────

test('no plan ever sends two rows to the SAME new key', () => {
    // That would be the original defect, recreated by the tool meant to fix it.
    const plan = planBackfill([
        row({ id: 1, externalUserId: 'A' }),
        row({ id: 2, externalUserId: 'B', updatedAt: '2026-09-01T00:00:00.000Z' }),
        row({ id: 3, serviceName: 'facebook', externalUserId: 'PAGE', vaultRefKey: legacyKeyFor(37, 'facebook') }),
        row({ id: 4, organisationId: 38, externalUserId: 'A', vaultRefKey: legacyKeyFor(38, 'instagram') }),
    ]);
    const keys = plan.map(p => p.toKey).filter(Boolean);
    assert.strictEqual(new Set(keys).size, keys.length, 'two rows would share a secret again');
});

// ── Telling a configuration fault from a transient one ───────────────────────────────────────
// The first prod dry run reported five rows as "retryable — just run the script again". They were
// not retryable: VAULT_KEK_1 was absent from the shell, so every read failed identically and a
// re-run would have failed identically again. Advice that sends an operator round a loop that
// cannot terminate is worse than no advice.

test('missing key material is a config fault, and stops the run', () => {
    assert.ok(isVaultConfigError('VAULT_KEK_1 env var is missing or not 64 hex chars.'));
    assert.ok(isVaultConfigError('VAULT_KEK_2 env var is missing or not 64 hex chars.'));
    assert.ok(isVaultConfigError('VAULT_KEY env var is missing or not 64 hex chars.'));
});

test('a genuinely transient failure is still retryable', () => {
    for (const message of [
        'write CONNECT_TIMEOUT ep-rapid-smoke-abdnj1gi-pooler.eu-west-2.aws.neon.tech:5432',
        'Connection terminated unexpectedly',
        'Malformed encryptedDek.',
        'Unsupported state or unable to authenticate data',
    ]) {
        assert.ok(!isVaultConfigError(message), `misread as a config fault: ${message}`);
    }
});

test('the advice names the variable that actually failed', () => {
    // A row predating the KEK/DEK migration falls back to VAULT_KEY. Telling its operator to export
    // VAULT_KEK_1 would cost them a second round trip for the same error.
    assert.strictEqual(missingVaultVar('VAULT_KEY env var is missing or not 64 hex chars.'), 'VAULT_KEY');
    assert.strictEqual(missingVaultVar('VAULT_KEK_2 env var is missing or not 64 hex chars.'), 'VAULT_KEK_2');
    assert.strictEqual(missingVaultVar('VAULT_KEK env var is missing or not 64 hex chars.'), 'VAULT_KEK');
    assert.strictEqual(missingVaultVar('Connection terminated unexpectedly'), null);
});

// ── Reading a Graph error honestly ───────────────────────────────────────────────────────────
// The first prod dry run reported `API access blocked.` as "the shared token does not reach this
// account" and told the operator two customers had to reconnect. That message says nothing about
// ownership — and both contested rows returned it, which is what an app-level block looks like,
// not what two different owners look like. Only 100/33 distinguishes accounts.

test('only 100/33 (and 803) proves an account is out of reach', () => {
    assert.strictEqual(classifyGraphError({ code: 100, error_subcode: 33, message: 'Unsupported get request.' }), 'out_of_reach');
    assert.strictEqual(classifyGraphError({ code: 803, message: 'Some of the aliases you requested do not exist' }), 'out_of_reach');
});

test('an app-level block is INCONCLUSIVE, never a reconnect', () => {
    // The exact message from the 2026-09-02 prod run.
    assert.strictEqual(classifyGraphError({ code: 10, message: 'API access blocked.' }), 'inconclusive');
    // And the message that started the whole incident, for the same reason.
    assert.strictEqual(classifyGraphError({ code: 10, message: '(#10) Application does not have permission for this action' }), 'inconclusive');
    // A bare 100 is a malformed request, not an access answer.
    assert.strictEqual(classifyGraphError({ code: 100, message: 'Unsupported get request.' }), 'inconclusive');
    assert.strictEqual(classifyGraphError({ code: 200, message: 'Permissions error' }), 'inconclusive');
    assert.strictEqual(classifyGraphError(undefined), 'inconclusive');
});

test('a dead token is its own verdict, distinct from ownership', () => {
    assert.strictEqual(classifyGraphError({ code: 190, message: 'Error validating access token' }), 'token_dead');
    assert.strictEqual(classifyGraphError({ code: 102, message: 'Session has expired' }), 'token_dead');
});

test('throttling is retryable, not an answer', () => {
    for (const code of [4, 17, 32, 613, 1, 2]) {
        assert.strictEqual(classifyGraphError({ code, message: 'limit' }), 'rate_limited', `code ${code}`);
    }
});

test('the error is reported with its code, so the next reader can check the verdict', () => {
    const described = describeGraphError({ code: 100, error_subcode: 33, type: 'GraphMethodException', message: 'Unsupported get request.' }, 400);
    assert.match(described, /code 100/);
    assert.match(described, /subcode 33/);
    assert.match(described, /GraphMethodException/);
    // A bare message with no code is what made the first run unreadable.
    assert.match(describeGraphError(undefined, 400), /HTTP 400/);
});

console.log(`\n${passed} passed\n`);
