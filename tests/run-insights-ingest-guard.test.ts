// tests/run-insights-ingest-guard.test.ts
// The staging insights trigger is the only cron wrapper that spends money on every call —
// it issues a paid Graph API request per published post. Its auth guard is therefore the
// only thing standing between the open internet and an unbounded API bill, so it gets a test.
//
// Every assertion here exercises a path that returns BEFORE the ingest runs, so nothing
// touches the database or the Graph API. Run:  npx tsx tests/run-insights-ingest-guard.test.ts

import assert from 'node:assert';

const SECRET = 'test-secret-value';
const ENDPOINT = 'https://staging--bemoreswan.netlify.app/.netlify/functions/run-insights-ingest';

// Set before the import below: the handler reads process.env at call time, but the module
// graph it pulls in (db/client) reads env when it loads.
process.env.CRON_TRIGGER_SECRET = SECRET;

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const done = () => { console.log(`  ✓ ${name}`); passed++; };
    const out = fn();
    return out instanceof Promise ? out.then(done) : Promise.resolve().then(done);
}

async function run() {
    console.log('US-SMM-PERF — run-insights-ingest auth guard');

    const handler = (await import('../netlify/functions/run-insights-ingest')).default;
    const ctx = {} as any;
    const post = (init: RequestInit = {}) =>
        handler(new Request(ENDPOINT, { method: 'POST', ...init }), ctx);

    await check('rejects GET — this is a POST-only trigger', async () => {
        const res = await handler(new Request(ENDPOINT, { method: 'GET' }), ctx);
        assert.strictEqual(res.status, 405);
    });

    await check('an unauthenticated POST never reaches the ingest', async () => {
        assert.strictEqual((await post()).status, 401);
    });

    await check('rejects a wrong secret', async () => {
        assert.strictEqual((await post({ headers: { Authorization: 'Bearer nope' } })).status, 401);
    });

    await check('near-misses do not squeak through a sloppy prefix or trim', async () => {
        for (const bad of [SECRET + 'x', SECRET.slice(0, -1), '', ' ']) {
            const res = await post({ headers: { Authorization: `Bearer ${bad}` } });
            assert.strictEqual(res.status, 401, `"${bad}" must not authenticate`);
        }
    });

    // NOT TESTED HERE: the accept path. Getting past this guard runs the real ingest — DB reads,
    // writes, and a paid Graph API call per published post — which a unit test must never do.
    // That the handler discriminates at all (rather than blanket-401ing, which would make every
    // assertion above pass on a permanently broken endpoint) is already proved by the 405 and
    // 503 cases: same handler, three distinct outcomes.

    await check('fails closed — an unset secret disables the endpoint, it does not open it', async () => {
        // The important one. A missing env var must not read as "no auth required": even the
        // RIGHT secret gets 503 once the server has none to compare against.
        delete process.env.CRON_TRIGGER_SECRET;
        const res = await post({ headers: { Authorization: `Bearer ${SECRET}` } });
        assert.strictEqual(res.status, 503);
        assert.strictEqual((await res.json()).ok, false);
        process.env.CRON_TRIGGER_SECRET = SECRET;
    });

    console.log(`\n${passed} checks passed`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
