// tests/sending-domain-check.test.ts
//
// Run:  npx tsx tests/sending-domain-check.test.ts
//
// checkSendingDomain used to POST /verify and then GET immediately. A verify request resets the
// domain to 'pending' at Resend while it re-checks (~45s), so the read ALWAYS said pending — the
// Check DNS button could never report a domain as verified, even one Resend had already verified.
// This drives the real function against a fake Resend that behaves that way.

import assert from 'node:assert';
import { checkSendingDomain } from '../src/utils/sending-domain';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

process.env.RESEND_DOMAINS_API_KEY = 'test-key';

/** A fake Resend: `state` is its verdict; a POST /verify resets it to pending, as the real one does. */
function fakeResend(initial: 'verified' | 'pending') {
    let state = initial;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push(`${method} ${String(url).replace('https://api.resend.com', '')}`);
        if (method === 'POST') { state = 'pending'; return new Response(JSON.stringify({ object: 'domain', id: 'd1' }), { status: 200 }); }
        return new Response(JSON.stringify({ id: 'd1', status: state, records: [{ type: 'TXT', name: 'x', value: 'y', status: state }] }), { status: 200 });
    }) as typeof fetch;
    return calls;
}

(async () => {
await check('an already-verified domain is reported verified, and is NOT sent back to pending', async () => {
    const calls = fakeResend('verified');
    const res = await checkSendingDomain('d1');
    assert.strictEqual(res.status, 'verified', 'the check reported a verified domain as pending — the button can never succeed');
    assert.deepStrictEqual(calls, ['GET /domains/d1'], 'a verified domain must not be re-verified (that resets it to pending)');
});

await check('a pending domain is read first, then asked to re-check', async () => {
    const calls = fakeResend('pending');
    const res = await checkSendingDomain('d1');
    assert.strictEqual(res.status, 'pending');
    assert.deepStrictEqual(calls, ['GET /domains/d1', 'POST /domains/d1/verify'], 'read, THEN kick off a fresh check');
});

if (process.exitCode) console.error('\nsending domain check: FAILED');
else console.log(`\nsending domain check: ${passed} passed`);
})();
