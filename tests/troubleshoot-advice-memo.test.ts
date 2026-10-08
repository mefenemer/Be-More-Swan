// tests/troubleshoot-advice-memo.test.ts
// The Connections card for a social account with failing setup checks shows one paragraph of
// advice written by Claude Haiku (social-troubleshoot-chat). It is requested from the card
// RENDERER, and the grid is drawn on every assistant-page visit — twice per visit — so for the
// same unchanged checks it was one billed LLM call per draw (1.6–3.2 s each, measured on prod
// 2026-10-08). The fix keeps each answer for the session, keyed by the failing checks.
//
// This file runs the real _intLoadGroupedTroubleshoot against a fake fetch and DOM.
//
// Run:  npx tsx tests/troubleshoot-advice-memo.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { landmark } from './landmark';

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
const SRC = readFileSync(join(root, 'integrations.js'), 'utf8');

// Lift just the memo + function out of integrations.js: the file as a whole needs a full DOM.
const start = landmark(SRC, 'const _groupedTroubleshoot = new Map();');
const end = landmark(SRC, '\n};', start) + 3;
const FN = SRC.slice(start, end);

function load(respond: (n: number) => Response) {
    let calls = 0;
    const els: Record<string, { textContent: string; hidden: boolean; classList: { add: (c: string) => void } }> = {};
    const el = () => {
        const e = { textContent: 'Reviewing configuration issues…', hidden: false, classList: { add: (c: string) => { if (c === 'hidden') e.hidden = true; } } };
        return e;
    };
    const sandbox: any = {
        window: {},
        document: { getElementById: (id: string) => els[id] || null },
        fetch: () => { calls++; return Promise.resolve().then(() => respond(calls)); },
        Map, Promise, JSON,
    };
    createContext(sandbox);
    runInContext(FN, sandbox);
    return {
        fn: sandbox.window._intLoadGroupedTroubleshoot as (id: number, p: string, c: unknown[]) => Promise<void>,
        calls: () => calls,
        draw: (id: number) => (els[`trouble-grouped-${id}`] = el()),
    };
}

const CHECKS = [{ id: 'C1', label: 'Business account', detail: 'Not a business account' }];
const ok = () => new Response(JSON.stringify({ message: 'Switch to a business account.' }), { status: 200 });

(async () => {
await check('redrawing the same failing checks asks the LLM once, and every draw shows the advice', async () => {
    const t = load(ok);
    const a = t.draw(7); await t.fn(7, 'instagram', CHECKS);
    const b = t.draw(7); await t.fn(7, 'instagram', CHECKS);
    const c = t.draw(7); await t.fn(7, 'instagram', CHECKS);
    assert.strictEqual(t.calls(), 1, 'three draws of unchanged checks must cost one LLM call');
    for (const e of [a, b, c]) assert.strictEqual(e.textContent, 'Switch to a business account.');
});

await check('two draws in flight at once share one request', async () => {
    const t = load(ok);
    t.draw(7);
    await Promise.all([t.fn(7, 'instagram', CHECKS), t.fn(7, 'instagram', CHECKS)]);
    assert.strictEqual(t.calls(), 1);
});

await check('a different set of failures is asked afresh', async () => {
    const t = load(ok);
    t.draw(7); await t.fn(7, 'instagram', CHECKS);
    await t.fn(7, 'instagram', [...CHECKS, { id: 'C2', label: 'Page link', detail: 'No Page linked' }]);
    t.draw(8); await t.fn(8, 'instagram', CHECKS);
    assert.strictEqual(t.calls(), 3, 'new failures, or another connection, must not reuse old advice');
});

await check('a failed or rate-limited answer is not kept, so the next draw retries', async () => {
    const t = load((n) => n === 1 ? new Response('', { status: 500 })
        : n === 2 ? new Response(JSON.stringify({ rateLimited: true }), { status: 200 })
        : ok());
    const a = t.draw(7); await t.fn(7, 'instagram', CHECKS);
    assert.ok(a.hidden, 'a failed request hides the line, as before');
    const b = t.draw(7); await t.fn(7, 'instagram', CHECKS);
    assert.match(b.textContent, /limit reached/i);
    const c = t.draw(7); await t.fn(7, 'instagram', CHECKS);
    assert.strictEqual(c.textContent, 'Switch to a business account.');
    assert.strictEqual(t.calls(), 3);
});

await check('the element is looked up after the wait, so a redraw mid-request still gets the advice', async () => {
    const t = load(ok);
    t.draw(7);
    const p = t.fn(7, 'instagram', CHECKS);
    const replacement = t.draw(7);
    await p;
    assert.strictEqual(replacement.textContent, 'Switch to a business account.');
});

console.log(`\n${passed} checks passed`);
})();
