// tests/cached-fetch.test.ts
// src/components/cached-fetch.js lets several workspace views share one get-assistants list
// instead of each fetching its own (measured on prod 2026-10-07: 8 calls across 7 tab switches).
// A cache in front of state the user can change is only safe if it can never answer with a copy
// taken BEFORE something the user just did. These checks run the real module against a fake fetch
// and pin the rules that make that true:
//
//   - concurrent and repeat reads share one request, and every caller can still read its own body
//   - ANY write to a function clears it (hire, pause, archive, rename, org switch, …)
//   - { fresh: true } goes to the server (the provisioning poll depends on it)
//   - a failed or non-2xx answer is never kept
//   - nothing outlives its TTL
//
// Run:  npx tsx tests/cached-fetch.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'src/components/cached-fetch.js'), 'utf8');

/** A fresh window with the module loaded over a fake fetch that counts calls per URL. */
function load(respond: (url: string, n: number) => Response | Promise<Response> = (_u, n) =>
    new Response(JSON.stringify({ n }), { status: 200 })) {
    const calls: { url: string; method: string }[] = [];
    const fakeFetch = (input: unknown, init?: { method?: string }) => {
        const url = typeof input === 'string' ? input : String((input as { url: string }).url);
        calls.push({ url, method: (init?.method || 'GET').toUpperCase() });
        // Like a real fetch, a failure is a REJECTED promise, never a synchronous throw.
        return Promise.resolve().then(() => respond(url, calls.filter(c => c.url === url).length));
    };
    const window: any = { fetch: fakeFetch };
    const sandbox: any = { window, Date, Promise, String };
    createContext(sandbox);
    runInContext(SRC, sandbox);
    const gets = (url: string) => calls.filter(c => c.url === url && c.method === 'GET').length;
    return { window, calls, gets, cf: window.bmsCachedFetch };
}

const A = '/.netlify/functions/get-assistants?period=all';

(async () => {
await check('repeat and concurrent reads share one request, and every caller can read its own body', async () => {
    const { cf, gets } = load();
    const [r1, r2] = await Promise.all([cf.assistants(), cf.assistants()]);
    const r3 = await cf.assistants();
    assert.deepStrictEqual([await r1.json(), await r2.json(), await r3.json()], [{ n: 1 }, { n: 1 }, { n: 1 }]);
    assert.strictEqual(gets(A), 1, 'three reads within the TTL must cost one request');
});

await check('a write to any function clears the cache, so the next read is fresh', async () => {
    const { window, cf, gets } = load();
    await cf.assistants();
    await window.fetch('/.netlify/functions/manage-assistant?id=1', { method: 'DELETE' });
    const after = await (await cf.assistants()).json();
    assert.strictEqual(gets(A), 2, 'an archive must invalidate the list');
    assert.deepStrictEqual(after, { n: 2 });
    await window.fetch('/api/oauth/x/disconnect', { method: 'POST' });
    await cf.assistants();
    assert.strictEqual(gets(A), 3, 'a write under /api/ must invalidate too');
});

await check('a GET through the wrapped fetch does NOT clear the cache', async () => {
    const { window, cf, gets } = load();
    await cf.assistants();
    await window.fetch('/.netlify/functions/notifications');
    await cf.assistants();
    assert.strictEqual(gets(A), 1);
});

await check('{ fresh: true } always reaches the server and refreshes the shared copy', async () => {
    const { cf, gets } = load();
    await cf.assistants();
    const fresh = await (await cf.assistants({ fresh: true })).json();
    const next = await (await cf.assistants()).json();
    assert.strictEqual(gets(A), 2);
    assert.deepStrictEqual([fresh, next], [{ n: 2 }, { n: 2 }], 'later readers must get the fresh copy');
});

await check('a non-2xx answer is returned but never kept', async () => {
    const { cf, gets } = load((_u, n) => new Response('{}', { status: n === 1 ? 500 : 200 }));
    const first = await cf.assistants();
    assert.strictEqual(first.status, 500);
    const second = await cf.assistants();
    assert.strictEqual(second.status, 200);
    assert.strictEqual(gets(A), 2, 'a 500 must not be served from cache');
});

await check('a network error is thrown to the caller and never kept', async () => {
    let n = 0;
    const { cf, gets } = load(() => { n++; if (n === 1) throw new Error('offline'); return new Response('{}'); });
    await assert.rejects(cf.assistants());
    await cf.assistants();
    assert.strictEqual(gets(A), 2);
});

await check('nothing outlives its TTL', async () => {
    const { cf, gets } = load();
    await cf(A, { ttlMs: 20 });
    await new Promise(r => setTimeout(r, 40));
    await cf(A, { ttlMs: 20 });
    assert.strictEqual(gets(A), 2);
});

await check('the workspace loads it in <head>, before any view can fetch', async () => {
    const ws = readFileSync(join(root, 'workspace.html'), 'utf8');
    const at = ws.indexOf('<script src="/src/components/cached-fetch.js"');
    assert.ok(at > 0, 'workspace.html no longer loads cached-fetch.js');
    assert.ok(at < ws.indexOf('</head>'), 'cached-fetch.js must load in <head>, so its fetch wrapper sees every write');
});

await check('the provisioning poll asks for a fresh list', async () => {
    const ws = readFileSync(join(root, 'workspace.html'), 'utf8');
    assert.ok(/_provPollTimer = setTimeout\(\(\) => window\.fetchAndRenderAssistants\(containerId, \{ fresh: true \}\)/.test(ws),
        'the poll exists to see provisioning finish; served from cache it would never see it');
    const js = readFileSync(join(root, 'assistants.js'), 'utf8');
    assert.ok(/bmsCachedFetch\.assistants\(\{ fresh: !!\(options && options\.fresh\) \}\)/.test(js),
        'fetchAndRenderAssistants no longer passes fresh through to the cache');
});

console.log(`\n${passed} checks passed`);
})();
