// tests/token-refresh-classification.test.ts
// A provider being briefly unavailable must never condemn a working connection.
//
// Run:  npx tsx tests/token-refresh-classification.test.ts
//
// ── The incident this encodes ────────────────────────────────────────────────────────────────────
// 2026-08-04, prod. A database outage (141 CONNECT_TIMEOUTs across ~20 functions) landed in the
// 5-second window between X issuing a rotated refresh token and our storing it — the pool's
// connect_timeout is 5s, and the failed vault INSERT is timestamped exactly 5s after the
// successful read that preceded it. X had already retired the old refresh token; the replacement
// existed only in the function's memory and died with the write.
//
// The failure handler then tried to record all this in the same dead database, threw on its first
// statement, and was swallowed by Promise.allSettled — no log, no audit row, no email, status left
// 'active'. Thirty minutes later the next run presented the retired token, X rejected it, and the
// user was emailed that their X account needed reconnecting. A five-second blip had permanently
// destroyed a working connection, and the message blamed the token.
//
// Two properties keep that from repeating, and both are invisible when they regress:
//   • a failure that touched nothing must leave the connection alone (transient → retry)
//   • a failure that lost a rotated credential must be retried hard, then said out loud

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TransientRefreshError, TokenLostError, requestGrant } from '../netlify/functions/refresh-social-tokens';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Swap global fetch for one canned response, restore afterwards.
const realFetch = globalThis.fetch;
const stubFetch = (impl: () => Promise<Response> | never) => { globalThis.fetch = impl as typeof fetch; };
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const callGrant = () => requestGrant('X', 'https://example.invalid/token', new URLSearchParams(), {});

// tsx compiles these to CJS, where top-level await is unavailable — hence the main() wrapper.
async function main() {

console.log('\nToken refresh — transient failures must not condemn a connection\n');

// ── Provider unavailable → transient ────────────────────────────────────────────────────────────

await test('a network failure is transient (the request may never have been processed)', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(callGrant(), (err: Error) => {
        assert.ok(err instanceof TransientRefreshError, `got ${err.name}: ${err.message}`);
        return true;
    });
});

await test('a 5xx is transient — their problem, not a verdict on our grant', async () => {
    for (const status of [500, 502, 503]) {
        stubFetch(async () => json(status, { error: 'server_error' }));
        await assert.rejects(callGrant(), (err: Error) => {
            assert.ok(err instanceof TransientRefreshError, `${status} gave ${err.name}`);
            return true;
        });
    }
});

await test('a 429 is transient — ours, but temporary', async () => {
    stubFetch(async () => json(429, { error: 'rate_limit' }));
    await assert.rejects(callGrant(), (err: Error) => {
        assert.ok(err instanceof TransientRefreshError, `got ${err.name}`);
        return true;
    });
});

await test('an unparseable body is transient (an edge/proxy page, not the provider answering)', async () => {
    stubFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    await assert.rejects(callGrant(), (err: Error) => {
        assert.ok(err instanceof TransientRefreshError, `got ${err.name}: ${err.message}`);
        return true;
    });
});

// ── Provider rejected the grant → permanent ─────────────────────────────────────────────────────

await test('a 4xx rejection is NOT transient — this is the real reconnect case', async () => {
    // The exact response X returned at 10:31:50 on the retired token.
    stubFetch(async () => json(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' }));
    await assert.rejects(callGrant(), (err: Error) => {
        assert.ok(!(err instanceof TransientRefreshError), 'a rejected grant must condemn, not retry forever');
        assert.match(err.message, /Value passed for the token was invalid/);
        return true;
    });
});

await test('a 2xx without an access_token is treated as a rejection', async () => {
    stubFetch(async () => json(200, { error: 'invalid_grant' }));
    await assert.rejects(callGrant(), (err: Error) => {
        assert.ok(!(err instanceof TransientRefreshError), `got ${err.name}`);
        return true;
    });
});

await test('a good response returns the rotated pair', async () => {
    stubFetch(async () => json(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200 }));
    const data = await callGrant();
    assert.equal(data.access_token, 'new-access');
    assert.equal(data.refresh_token, 'new-refresh');
});

globalThis.fetch = realFetch;

// ── The irreversible window ─────────────────────────────────────────────────────────────────────

await test('the vault write after rotation is retried, not attempted once', () => {
    const text = src('netlify/functions/refresh-social-tokens.ts');
    assert.ok(
        /PERSIST_DEADLINE_MS\s*=\s*[0-9_]+/.test(text),
        'the post-rotation vault write must have a retry budget — it is the only copy of the new token',
    );
    // A wall-clock deadline, not an attempt count: each failed attempt burns an unknown ~5s of
    // connect timeout, and overrunning the function budget means a hard kill with no condemn.
    assert.ok(
        /const deadline = Date\.now\(\) \+ PERSIST_DEADLINE_MS/.test(text),
        'the retry must be bounded by wall clock, not by a fixed list of backoffs',
    );
    const deadline = Number(/PERSIST_DEADLINE_MS\s*=\s*([0-9_]+)/.exec(text)?.[1]?.replace(/_/g, ''));
    assert.ok(
        deadline > 0 && deadline <= 24_000,
        `retry budget ${deadline}ms must leave room inside the ~30s scheduled-function limit`,
    );
    assert.ok(
        /throw new TokenLostError/.test(text),
        'exhausting the retries must raise TokenLostError, not a generic failure',
    );
    assert.ok(
        TokenLostError.prototype instanceof Error,
        'TokenLostError must be a real Error subclass',
    );
});

await test('a transient failure returns without touching the connection', () => {
    const text = src('netlify/functions/refresh-social-tokens.ts');
    const catchBlock = text.slice(text.indexOf('if (err instanceof TransientRefreshError)'));
    const beforeReturn = catchBlock.slice(0, catchBlock.indexOf('return;'));
    for (const forbidden of ['handleRefreshFailure', "status: 'paused'", 'token_refresh_failed']) {
        assert.ok(
            !beforeReturn.includes(forbidden),
            `the transient branch must not ${forbidden} — that is what turned a 5s outage into a dead connection`,
        );
    }
});

await test('the failure handler logs before it writes, and guards every step', () => {
    const text = src('netlify/functions/refresh-social-tokens.ts');
    const handler = text.slice(text.indexOf('async function handleRefreshFailure'));
    const firstWrite = handler.indexOf('db.update(');
    const firstLog = handler.indexOf('console.error(');
    assert.ok(firstLog >= 0 && firstLog < firstWrite,
        'the CONDEMNING log must be emitted before any database write, so it survives a DB outage');
    assert.ok(/const step = async/.test(handler),
        'each side-effect must be individually guarded so one dead step does not cancel the rest');
});

console.log(`\n${passed} passed\n`);

}

main();
