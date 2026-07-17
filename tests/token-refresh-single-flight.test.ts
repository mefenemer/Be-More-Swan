// tests/token-refresh-single-flight.test.ts
// Concurrency guard for OAuth token refresh (src/utils/single-flight.ts, used by
// src/utils/workspace-integrations.ts → getFreshAccessToken).
//
// Run:  npx tsx tests/token-refresh-single-flight.test.ts
//
// Background: xero, quickbooks, jira, tiktok and threads all issue ROTATING SINGLE-USE
// refresh tokens — minting a new one kills the old one immediately. Two concurrent
// callers for the same (org, provider) used to both read the same refresh token and both
// POST it: the provider honours the first and rejects the second, and the loser's catch
// block marked the connection 'expired' for the whole org even though the winner had
// just stored a perfectly good token.
//
// This file models that provider contract and asserts:
//   - the UNGUARDED read→refresh→store sequence really does break (the bug is real)
//   - singleFlight() collapses concurrent refreshes to one, so nobody burns a live token
//   - keys are released after settle, so later refreshes still work and nothing leaks
//   - rejections are shared by all joiners, and a retry after failure runs fresh
// Pure logic — no DB, no network.

import assert from 'node:assert';
import { singleFlight, inflightCount } from '../src/utils/single-flight';

// singleFlight keys live in a module-level map, so these checks MUST run one at a time —
// running them concurrently lets one check join another's in-flight key and both read
// the wrong call counts.
let passed = 0;
const queued: Array<[string, () => void | Promise<void>]> = [];
function check(name: string, fn: () => void | Promise<void>): void {
    queued.push([name, fn]);
}

async function runChecks(): Promise<void> {
    for (const [name, fn] of queued) {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ── A provider that behaves like Xero/Jira/QuickBooks ─────────────────────────

/** Models a connection plus a provider whose refresh tokens are single-use. */
function makeConnection() {
    const state = {
        // The vault payload.
        accessToken: 'access-0',
        refreshToken: 'refresh-0',
        // The workspace_integrations row.
        status: 'active' as 'active' | 'expired',
        // Provider-side truth: only this refresh token is still spendable.
        liveRefreshToken: 'refresh-0',
        refreshCalls: 0,
        generation: 0,
    };

    /** The provider's refresh grant. Rejects any token that has already been spent. */
    async function providerRefresh(presented: string): Promise<{ accessToken: string; refreshToken: string }> {
        state.refreshCalls++;
        await tick(); // network round-trip — lets a racing caller interleave here
        if (presented !== state.liveRefreshToken) {
            throw new Error('invalid_grant: refresh token already used');
        }
        state.generation++;
        state.liveRefreshToken = `refresh-${state.generation}`;
        return { accessToken: `access-${state.generation}`, refreshToken: state.liveRefreshToken };
    }

    /** The original, unguarded sequence: read → refresh → store, catch → mark expired. */
    async function refreshUnguarded(): Promise<string> {
        const presented = state.refreshToken; // read
        try {
            const next = await providerRefresh(presented); // refresh
            state.accessToken = next.accessToken; // store
            state.refreshToken = next.refreshToken;
            state.status = 'active';
            return next.accessToken;
        } catch (err) {
            state.status = 'expired'; // the whole org now needs a reconnect
            throw err;
        }
    }

    /** The same sequence, serialised per key — mirrors the shipped fix. */
    const refreshGuarded = (key: string) => singleFlight(key, refreshUnguarded);

    return { state, refreshUnguarded, refreshGuarded };
}

// ── The bug ───────────────────────────────────────────────────────────────────

check('UNGUARDED concurrent refresh burns the token and expires a healthy connection', async () => {
    const { state, refreshUnguarded } = makeConnection();

    const results = await Promise.allSettled([refreshUnguarded(), refreshUnguarded()]);

    // Both callers read 'refresh-0' and both spent it: one won, one was rejected.
    assert.equal(state.refreshCalls, 2, 'both callers should have hit the provider');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one should win');
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'exactly one should lose');

    // This is the damage: the winner stored a good token, yet the loser's catch block
    // has marked the connection expired for the entire org.
    assert.equal(state.status, 'expired', 'the loser wrongly expires the connection');
    assert.equal(state.accessToken, 'access-1', '…even though a valid token was just stored');
});

// ── The fix ───────────────────────────────────────────────────────────────────

check('GUARDED concurrent refresh calls the provider once and keeps the connection active', async () => {
    const { state, refreshGuarded } = makeConnection();

    const tokens = await Promise.all([
        refreshGuarded('org-1:xero'),
        refreshGuarded('org-1:xero'),
        refreshGuarded('org-1:xero'),
    ]);


    assert.equal(state.refreshCalls, 1, 'the refresh token must be spent exactly once');
    assert.deepEqual(tokens, ['access-1', 'access-1', 'access-1'], 'every caller gets the winner’s token');
    assert.equal(state.status, 'active', 'a healthy connection is never marked expired');
    assert.equal(state.refreshToken, 'refresh-1', 'the rotated token is the one persisted');
});

check('different (org, provider) keys refresh independently', async () => {
    const a = makeConnection();
    const b = makeConnection();

    await Promise.all([a.refreshGuarded('org-3:xero'), b.refreshGuarded('org-4:xero')]);

    assert.equal(a.state.refreshCalls, 1, 'org 3 refreshes on its own');
    assert.equal(b.state.refreshCalls, 1, 'org 4 must not be starved by org 3’s key');
});

check('a later refresh is not served a stale cached result', async () => {
    const { state, refreshGuarded } = makeConnection();

    await refreshGuarded('org-1:jira');
    await refreshGuarded('org-1:jira'); // separate call, after the first settled

    assert.equal(state.refreshCalls, 2, 'a fresh call after settle must do real work');
    assert.equal(state.accessToken, 'access-2', 'and must store the newly rotated token');
});

check('keys are released after settle (no leak)', async () => {
    const before = inflightCount();
    await singleFlight('leak-check', async () => { await tick(); return 1; });
    assert.equal(inflightCount(), before, 'the key must be gone once the work settles');

    await singleFlight('leak-check-fail', async () => { await tick(); throw new Error('nope'); })
        .catch(() => {});
    assert.equal(inflightCount(), before, 'a rejection must release the key too');
});

check('a rejection is shared by every joiner, and a retry runs fresh', async () => {
    let calls = 0;
    const flaky = async () => {
        calls++;
        await tick();
        if (calls === 1) throw new Error('invalid_grant');
        return 'recovered';
    };

    const results = await Promise.allSettled([
        singleFlight('org-9:quickbooks', flaky),
        singleFlight('org-9:quickbooks', flaky),
    ]);

    assert.equal(calls, 1, 'joiners share the one attempt');
    assert.ok(results.every((r) => r.status === 'rejected'), 'both joiners see the failure');

    // The failure must not be cached — the next caller gets a real attempt.
    assert.equal(await singleFlight('org-9:quickbooks', flaky), 'recovered', 'retry runs fresh');
});

check('a synchronous throw inside fn rejects rather than escaping', async () => {
    await assert.rejects(
        () => singleFlight('sync-throw', () => { throw new Error('boom'); }),
        /boom/,
    );
    assert.equal(inflightCount(), 0, 'a sync throw must not wedge the key in the map');
});

// tsx compiles this to CJS, where top-level await is unavailable.
void runChecks().then(() => {
    console.log(`\n${passed}/${queued.length} check(s) passed.`);
});
