// tests/provider-balances.test.ts
// The AI-provider balance alert — src/utils/provider-balance.ts + check-provider-balances.ts.
//
// Two ways this goes wrong without anything failing:
//   · it stays silent through a real outage (the whole reason it exists — fal locked from
//     2026-09-28 14:31, Anthropic dry 09-17 → 09-28, nobody told either time)
//   · it cries wolf (a 429, a key that can't read billing, refusals from before a top-up) and gets
//     filtered, so the next real outage goes unread
// Both halves are checked. No network, no database.
//
// Run:  npx tsx tests/provider-balances.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
    assessProviders, classifyAnthropicError, readFalBalance, probeAnthropic, FAL_LOCK_PATTERN,
    readStabilityBalance, STABILITY_TRACK_CREDITS, DEFAULT_STABILITY_LOW_BALANCE_CREDITS,
    type FalLockEvidence,
} from '../src/utils/provider-balance';
import { dueForAlert } from '../netlify/functions/check-provider-balances';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const noEvidence: FalLockEvidence = { failures: 0, organisations: 0, latestAt: null, sample: null, lastSuccessAt: null };
// The real rows from prod, 2026-09-30.
const LOCK_MSG = 'Fal request unavailable (403): {"detail":"User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing."}';
const lockEvidence: FalLockEvidence = {
    failures: 20, organisations: 1, latestAt: '2026-09-30T07:40:54Z', sample: LOCK_MSG, lastSuccessAt: '2026-09-28T14:31:02Z',
};
const ok = { status: 'ok' as const };
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

async function main() {
    await check('the fal lock pattern matches the message fal actually sent', () => {
        assert.match(LOCK_MSG, new RegExp(FAL_LOCK_PATTERN));
        assert.doesNotMatch('Fal request failed (500): upstream', new RegExp(FAL_LOCK_PATTERN));
    });

    await check("2026-09-30 exactly: lock evidence + a key that can't read billing → DOWN alert", () => {
        const p = assessProviders({ fal: { status: 'no_access', httpStatus: 403 }, falEvidence: lockEvidence, anthropic: ok });
        assert.strictEqual(p.length, 1);
        assert.strictEqual(p[0].provider, 'fal');
        assert.strictEqual(p[0].severity, 'down');
        assert.ok(p[0].lines.some(l => l.includes('fal.ai/dashboard/billing')), 'must say what to do');
    });

    await check('refusals from BEFORE a top-up do not alert once an image has succeeded since', () => {
        const recovered = { ...lockEvidence, lastSuccessAt: '2026-09-30T09:00:00Z' };
        assert.deepStrictEqual(assessProviders({ fal: { status: 'no_access', httpStatus: 403 }, falEvidence: recovered, anthropic: ok }), []);
    });

    await check('a healthy balance read now overrides old refusals', () => {
        assert.deepStrictEqual(assessProviders({ fal: { status: 'ok', balance: 80, currency: 'USD' }, falEvidence: lockEvidence, anthropic: ok }), []);
    });

    await check('zero balance → DOWN; under the line → LOW; above → nothing', () => {
        assert.strictEqual(assessProviders({ fal: { status: 'ok', balance: 0, currency: 'USD' }, falEvidence: noEvidence, anthropic: ok })[0].severity, 'down');
        assert.strictEqual(assessProviders({ fal: { status: 'ok', balance: 4.2, currency: 'USD' }, falEvidence: noEvidence, anthropic: ok })[0].severity, 'low');
        assert.deepStrictEqual(assessProviders({ fal: { status: 'ok', balance: 40, currency: 'USD' }, falEvidence: noEvidence, anthropic: ok }), []);
    });

    await check('no evidence and an unreadable balance is silence, not a false alarm', () => {
        assert.deepStrictEqual(assessProviders({ fal: { status: 'no_access', httpStatus: 401 }, falEvidence: noEvidence, anthropic: ok }), []);
        assert.deepStrictEqual(assessProviders({ fal: { status: 'error', detail: 'timeout' }, falEvidence: noEvidence, anthropic: ok }), []);
    });

    await check("Anthropic's credit 400 is 'exhausted'; a 429 is only transient", () => {
        const credit = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'Your credit balance is too low to access the Anthropic API.', new Headers());
        assert.strictEqual(classifyAnthropicError(credit).status, 'exhausted');
        const rate = new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers());
        assert.strictEqual(classifyAnthropicError(rate).status, 'transient');
        const auth = new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers());
        assert.strictEqual(classifyAnthropicError(auth).status, 'key_rejected');
        assert.strictEqual(classifyAnthropicError(new Error('socket hang up')).status, 'transient');
    });

    await check('an exhausted Anthropic probe alerts; a transient one does not', async () => {
        const credit = await probeAnthropic(async () => { throw new Error('400 Your credit balance is too low'); });
        assert.strictEqual(assessProviders({ fal: { status: 'not_configured' }, falEvidence: noEvidence, anthropic: credit })[0]?.severity, 'down');
        const flaky = await probeAnthropic(async () => { throw new Error('ECONNRESET'); });
        assert.deepStrictEqual(assessProviders({ fal: { status: 'not_configured' }, falEvidence: noEvidence, anthropic: flaky }), []);
        assert.deepStrictEqual(await probeAnthropic(async () => ({})), { status: 'ok' });
    });

    await check("fal billing: reads the balance, and maps 401/403 to 'no_access' (not an outage)", async () => {
        process.env.FAL_KEY = 'k';
        assert.deepStrictEqual(await readFalBalance(json(200, { username: 'x', credits: { current_balance: 24.5, currency: 'USD' } }) as any),
            { status: 'ok', balance: 24.5, currency: 'USD' });
        assert.deepStrictEqual(await readFalBalance(json(403, { error: {} }) as any), { status: 'no_access', httpStatus: 403 });
        assert.strictEqual((await readFalBalance((async () => { throw new Error('boom'); }) as any)).status, 'error', 'a probe must never throw');
    });

    await check('cooldown: repeats wait, an escalation low → down goes out at once', () => {
        const down = { provider: 'fal' as const, severity: 'down' as const, headline: '', lines: [] };
        const low = { ...down, severity: 'low' as const };
        const now = new Date('2026-09-30T12:00:00Z');
        assert.strictEqual(dueForAlert(down, {}, now), true);
        assert.strictEqual(dueForAlert(down, { fal: { at: '2026-09-30T09:00:00Z', severity: 'down' } }, now), false);
        assert.strictEqual(dueForAlert(down, { fal: { at: '2026-09-30T05:00:00Z', severity: 'down' } }, now), true);
        assert.strictEqual(dueForAlert(down, { fal: { at: '2026-09-30T11:00:00Z', severity: 'low' } }, now), true, 'escalation must not wait');
        assert.strictEqual(dueForAlert(low, { fal: { at: '2026-09-30T00:00:00Z', severity: 'low' } }, now), false);
    });

    await check('it is scheduled', () => {
        assert.match(readFileSync(join(root, 'netlify.toml'), 'utf8'), /\[functions\.check-provider-balances\]\s*\n\s*schedule = "15 \*\/6 \* \* \*"/);
    });

    // ── Stability (Generate music) ──────────────────────────────────────────────────────────────
    const healthyFal = { status: 'ok' as const, balance: 80, currency: 'USD' };
    const stab = (stability: any) => assessProviders({ fal: healthyFal, falEvidence: noEvidence, anthropic: ok, stability })
        .filter((p) => p.provider === 'stability');

    await check('Stability below one track is DOWN; below the line is LOW; above it is quiet', () => {
        assert.strictEqual(stab({ status: 'ok', credits: STABILITY_TRACK_CREDITS - 1 })[0].severity, 'down');
        const low = stab({ status: 'ok', credits: 100 });
        assert.strictEqual(low[0].severity, 'low');
        assert.ok(/~3 tracks/.test(low[0].headline), low[0].headline);
        assert.deepStrictEqual(stab({ status: 'ok', credits: DEFAULT_STABILITY_LOW_BALANCE_CREDITS + 1 }), []);
    });

    await check('a rejected Stability key is DOWN; a transient read error and no key at all are not alerts', () => {
        assert.strictEqual(stab({ status: 'key_rejected', httpStatus: 401 })[0].severity, 'down');
        assert.deepStrictEqual(stab({ status: 'error', detail: 'HTTP 502' }), []);
        assert.deepStrictEqual(stab({ status: 'not_configured' }), []);
        assert.deepStrictEqual(stab(undefined), [], 'a caller without Stability must not alert');
    });

    await check('the Stability balance is read with Bearer auth from /v1/user/balance', async () => {
        process.env.STABILITY_API_KEY = 'sk-test';
        let url = '', auth = '';
        const r = await readStabilityBalance((async (u: any, init: any) => {
            url = String(u); auth = init.headers.Authorization;
            return new Response(JSON.stringify({ credits: 412.5 }), { status: 200 });
        }) as any);
        assert.deepStrictEqual(r, { status: 'ok', credits: 412.5 });
        assert.strictEqual(url, 'https://api.stability.ai/v1/user/balance');
        assert.strictEqual(auth, 'Bearer sk-test');
        const rej = await readStabilityBalance((async () => new Response('{}', { status: 401 })) as any);
        assert.strictEqual(rej.status, 'key_rejected');
    });

    await check('the scheduled check actually asks Stability', () => {
        const fn = readFileSync(join(root, 'netlify/functions/check-provider-balances.ts'), 'utf8');
        assert.ok(fn.includes('readStabilityBalance()'), 'the probe is defined but never run');
        assert.ok(fn.includes('stability, stabilityLowBalanceCredits'), 'the reading never reaches the rules');
    });

    console.log(`\n${passed} checks passed`);
}

main();
