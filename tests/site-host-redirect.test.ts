// tests/site-host-redirect.test.ts
// The sites host passes the app's redirects on WITHOUT the address of its own call to the app. Netlify
// copies the request's query onto a redirect that has none, so the bare address of a booking-only site
// (Location: /book) reached visitors as /book?host=…&path=%2F (found 2026-11-11). Runs the real edge
// function with a stand-in app.
//
// Run:  npx tsx tests/site-host-redirect.test.ts

import assert from 'node:assert';
import serve, { cleanLocation } from '../sites-host/edge-functions/serve';

let passed = 0;
let total = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
    total++;
    const done = (ok: boolean, err?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; } };
    try { const r = fn(); if (r instanceof Promise) pending.push(r.then(() => done(true), (e) => done(false, e))); else done(true); }
    catch (err) { done(false, err); }
}

const SENT = ['host=shop.bemoreswan.site', 'path=%2F'];

check('Netlify\'s copy of our call is taken off; a plain /book stays plain', () => {
    assert.strictEqual(cleanLocation('/book?host=shop.bemoreswan.site&path=%2F', SENT), '/book');
    assert.strictEqual(cleanLocation('/book', SENT), '/book');
});

check('the app\'s own query, and a visitor\'s own ?q=, are kept', () => {
    assert.strictEqual(cleanLocation('/_book?s=_consultation&svc=20', SENT), '/_book?s=_consultation&svc=20');
    assert.strictEqual(cleanLocation('https://www.shop.co.uk/?q=shoes', [...SENT, 'q=q%3Dshoes']), 'https://www.shop.co.uk/?q=shoes');
    assert.strictEqual(cleanLocation('/x?a=1&host=shop.bemoreswan.site&path=%2F#top', SENT), '/x?a=1#top');
    assert.strictEqual(cleanLocation('/x?host=other.site&path=%2F', SENT), '/x?host=other.site&path=%2F', 'only exactly what we sent');
});

check('end to end: the bare address redirects to /book with nothing on it', async () => {
    (globalThis as unknown as { Netlify: unknown }).Netlify = { env: { get: (k: string) => ({ SITE_SERVE_SECRET: 'k', APP_ORIGIN: 'https://app.test' } as Record<string, string>)[k] } };
    const realFetch = globalThis.fetch;
    let asked = '';
    globalThis.fetch = (async (input: string) => {
        asked = String(input);
        // What Netlify hands back for the app's `Location: /book`.
        return new Response(null, { status: 302, headers: { location: `/book?${new URL(asked).search.slice(1)}` } });
    }) as typeof fetch;
    try {
        const res = await serve(new Request('https://shop.bemoreswan.site/'));
        assert.strictEqual(asked, 'https://app.test/.netlify/functions/site-serve?host=shop.bemoreswan.site&path=%2F');
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/book');
    } finally { globalThis.fetch = realFetch; }
});

Promise.all(pending).then(() => console.log(`\n${passed}/${total} passed`));
