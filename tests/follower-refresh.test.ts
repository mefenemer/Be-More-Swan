// tests/follower-refresh.test.ts
// The two pieces of the Audience follower-count pipeline that are pure logic rather than a platform
// call: which workspaces the background cron sweeps (refresh-follower-counts.ts) and what each platform's
// response means (src/utils/follower-counts.ts).
// Run:  npx tsx tests/follower-refresh.test.ts
//
// WHY THIS MATTERS: the Audience block now tells the user "Refreshed automatically every 4 hours in
// the background — next refresh around 16:20". That sentence is only true if the sweep actually reaches
// every workspace. A selection bug here is invisible in production — no error, no empty state, just a
// workspace whose figures quietly stop moving while the UI keeps promising they're current.

import assert from 'node:assert';
import { selectOrgsToSweep, oldestCachedAt, type ConnMetaRow } from '../netlify/functions/refresh-follower-counts';
import { fetchPlatformCount, nextRefreshFrom, CACHE_TTL_MS } from '../src/utils/follower-counts';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): void {
    try {
        const r = fn();
        if (r instanceof Promise) { r.then(() => { passed++; console.log(`  ✓ ${name}`); }, err => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }); return; }
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const NOW = Date.parse('2026-07-30T14:00:00.000Z');
const agoMins = (m: number) => new Date(NOW - m * 60000).toISOString();
const row = (organisationId: number | null, followerCountAt?: string): ConnMetaRow =>
    ({ organisationId, metadata: followerCountAt === undefined ? {} : { followerCountAt } });
const MIN_AGE = Math.round(CACHE_TTL_MS * 0.75);   // the cron's threshold — 0.75 of the cache TTL
// Ages are expressed as fractions of the TTL, never as literal minutes: the TTL has already moved once
// (1h → 4h) and hardcoded ages would have silently stopped testing the boundary they were written for.
const TTL_MINS = CACHE_TTL_MS / 60000;
const agoTtl = (fraction: number) => agoMins(Math.round(TTL_MINS * fraction));
const opts = { minAgeMs: MIN_AGE, max: 150 };

// ── Which orgs get swept ─────────────────────────────────────────────────────────────────────────

check('a workspace whose figures are still fresh is not swept at all', () => {
    // Not merely "not refreshed" — not even visited. Waking the vault and the connection queries for
    // an org with nothing to do is the cost this filter exists to avoid.
    const r = selectOrgsToSweep([row(1, agoTtl(0.1))], NOW, opts);
    assert.equal(r.organisations, 1);
    assert.deepEqual(r.due, []);
    assert.deepEqual(r.batch, []);
});

check('a never-fetched workspace is swept, and sorts ahead of merely stale ones', () => {
    // THE CASE THAT MATTERS MOST. A connection that has never reported a count has no
    // followerCountAt at all; if a missing timestamp read as "now" instead of "epoch", a brand-new
    // connection would be the one thing the cron never got round to.
    const r = selectOrgsToSweep([row(1, agoTtl(1.2)), row(2), row(3, agoTtl(10))], NOW, opts);
    assert.deepEqual(r.due, [2, 3, 1], 'never-fetched first, then oldest-to-newest');
});

check('one stale platform makes the whole workspace due', () => {
    // A workspace with a freshly-fetched Instagram and a long-stuck YouTube must be
    // swept. Averaging, or reading the newest timestamp, would let the healthy connection mask the
    // broken one forever.
    const r = selectOrgsToSweep([row(9, agoTtl(0.05)), row(9, agoTtl(12))], NOW, opts);
    assert.deepEqual(r.due, [9]);
});

check('rows with no organisation are ignored rather than grouped together', () => {
    // A NULL organisation_id is the unowned-connection sentinel (a global catalog row). Grouping the
    // nulls into one pseudo-org would sweep another tenant's connection under it.
    const r = selectOrgsToSweep([row(null, agoTtl(10)), row(null), row(4, agoTtl(10))], NOW, opts);
    assert.equal(r.organisations, 1);
    assert.deepEqual(r.due, [4]);
});

check('the per-run cap keeps the stalest and defers the freshest', () => {
    // The HTTP trigger used on staging is a synchronous function capped at 26s, so a run can be cut
    // short. Truncation is only safe because the order is stalest-first — this pins that pairing.
    const rows = [row(1, agoTtl(0.8)), row(2, agoTtl(100)), row(3, agoTtl(2))];
    const r = selectOrgsToSweep(rows, NOW, { minAgeMs: MIN_AGE, max: 2 });
    assert.equal(r.truncated, true);
    assert.deepEqual(r.batch, [2, 3], 'the two stalest');
    assert.equal(r.due.length, 3, 'the deferred org is still reported as due');
});

check('the cron threshold is stricter than the read-path TTL', () => {
    // Deliberate: on a schedule matching the TTL the cron must find the previous run's figures due. If
    // it used the full TTL, a page load shortly before the tick would push that connection past this
    // run and into the next — making the stated cadence a coin-flip.
    assert.ok(MIN_AGE < CACHE_TTL_MS, 'cron minAge must be below the cache TTL');
    // 0.85 of the TTL: past the cron's 0.75 threshold, still inside the read path's full TTL.
    const between = [row(1, agoTtl(0.85))];
    assert.deepEqual(selectOrgsToSweep(between, NOW, opts).due, [1], 'the cron sweeps it');
    assert.deepEqual(selectOrgsToSweep(between, NOW, { minAgeMs: CACHE_TTL_MS, max: 150 }).due, [], 'the read path would have served it from cache');
});

check('oldestCachedAt treats a malformed timestamp as maximally stale, not as fresh', () => {
    // Garbage in the metadata must mean "go and check", never "assume it's fine".
    assert.equal(oldestCachedAt([{ followerCountAt: 'not a date' }]), 0);
    assert.equal(oldestCachedAt([{}]), 0);
    assert.equal(oldestCachedAt([null]), 0);
    assert.equal(oldestCachedAt([]), 0);
    assert.equal(oldestCachedAt([{ followerCountAt: agoMins(10) }]), NOW - 10 * 60000);
});

check('nextRefreshAt is exactly one TTL after the fetch', () => {
    // The UI subtracts these to name a time on screen; drift here shows up as a wrong promise.
    const at = agoMins(0);
    assert.equal(Date.parse(nextRefreshFrom(at)) - Date.parse(at), CACHE_TTL_MS);
});

// ── What each platform's response means ──────────────────────────────────────────────────────────
// Availability is permanently uneven, and { available: false } is correct behaviour. These pin the
// distinction the UI depends on: a real zero is a number, an unavailable count is NOT zero.

const withFetch = async (impl: (url: string) => Response, fn: () => Promise<void>) => {
    const real = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (u: unknown) => impl(String(u));
    try { await fn(); } finally { (globalThis as unknown as { fetch: unknown }).fetch = real; }
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

check('a hidden YouTube subscriber count is unavailable, not zero', () => withFetch(
    () => json({ items: [{ statistics: { hiddenSubscriberCount: true } }] }),
    async () => {
        const r = await fetchPlatformCount('youtube', 't', null, {});
        assert.equal(r.available, false);
        assert.equal(r.count, null, 'a hidden count must never render as 0 followers');
        assert.equal(r.note, 'hidden by channel');
    },
));

check('a genuine zero is reported as an available zero', () => withFetch(
    () => json({ items: [{ statistics: { subscriberCount: '0' } }] }),
    async () => {
        const r = await fetchPlatformCount('youtube', 't', null, {});
        assert.equal(r.available, true);
        assert.equal(r.count, 0, 'a brand-new channel really does have 0 subscribers');
    },
));

check("X's 403 is reported as an API-tier limit, not a broken connection", () => withFetch(
    () => new Response('forbidden', { status: 403 }),
    async () => {
        const r = await fetchPlatformCount('x', 't', null, {});
        assert.equal(r.available, false);
        assert.equal(r.note, 'API tier', 'the user must not be told to reconnect a working account');
    },
));

check('Facebook falls back from followers_count to the legacy fan_count', () => withFetch(
    () => json({ fan_count: 512 }),
    async () => assert.equal((await fetchPlatformCount('facebook', 't', 'page1', {})).count, 512),
));

check('Facebook prefers metadata.fbPageId over externalUserId', () => {
    // The two can disagree on older connections; poll-goal-telemetry uses the same precedence, and if
    // these two diverged the Audience block and the user's goal would measure different Pages.
    let seen = '';
    return withFetch(
        (u) => { seen = u; return json({ followers_count: 1 }); },
        async () => {
            await fetchPlatformCount('facebook', 't', 'external-id', { fbPageId: 'meta-page-id' });
            assert.ok(seen.includes('meta-page-id'), `expected the metadata page id, called ${seen}`);
            assert.ok(!seen.includes('external-id'));
        },
    );
});

check('LinkedIn is never called and always reports unavailable', () => {
    // The member API exposes no personal-profile follower count. A call here would be a guaranteed
    // wasted request on every sweep.
    let called = false;
    return withFetch(
        () => { called = true; return json({}); },
        async () => {
            const r = await fetchPlatformCount('linkedin', 't', 'li', {});
            assert.equal(called, false, 'LinkedIn must not issue a request');
            assert.equal(r.available, false);
        },
    );
});

check('a thrown fetch degrades to an unavailable row rather than failing the sweep', () => withFetch(
    () => { throw new Error('socket hang up'); },
    async () => {
        const r = await fetchPlatformCount('instagram', 't', 'ig1', {});
        assert.equal(r.available, false);
        assert.equal(r.note, 'error');
    },
));

process.on('exit', () => { if (!process.exitCode) console.log(`\n${passed} checks passed.`); });
