// src/utils/provider-balance.ts
// Are the paid AI providers still willing to serve us? Read by check-provider-balances.ts.
//
// ── Why ─────────────────────────────────────────────────────────────────────────────────────────
// Two provider accounts ran dry in two weeks and nothing told a human either time:
//   · Anthropic, 2026-09-17 → 09-28: every AI draft on prod failed for eleven days.
//   · fal, ~2026-09-28 14:31 → 09-30: fal LOCKED the account ("Exhausted balance"). Every AI image
//     failed — and because the drafting job falls through to the next media source, nothing even
//     failed visibly. Customers just quietly stopped getting AI images.
// check-content-generation-health watches drafting failures after the fact. This asks the
// providers directly, so an empty balance is caught before (or without) a customer tripping on it.
//
// ── How each provider is asked ──────────────────────────────────────────────────────────────────
// fal     — GET api.fal.ai/v1/account/billing?expand=credits: free and read-only, and it returns the
//           real balance, so a LOW balance can be warned about before it locks. ⚠️ It needs an ADMIN
//           key. FAL_ADMIN_KEY if set, else FAL_KEY — an ordinary key answers 401/403 ('no_access'),
//           and then the only signal left is evidence: fal's lock message in our own failed jobs.
// Stability — GET api.stability.ai/v1/user/balance → { credits }. Free, read-only, any API key.
//           Music generation (Stable Audio 3.0) costs 26 credits a track, so below that NO track can
//           be made: customers get their AI credits back but no music. 401/403 here is the same key
//           generate-ai-music uses, so a rejected key means music is down too — unlike fal, there is
//           no separate admin key that could explain it away.
// Anthropic — there is no balance endpoint. A 1-token Haiku call (~$0.00001) either succeeds or
//           fails with the credit-balance 400 the outage produced. isUpstreamBlocked owns that test.
//
// Every probe NEVER throws: a monitoring call that crashes is a monitor that reports "fine".

import Anthropic from '@anthropic-ai/sdk';
import { isUpstreamBlocked } from '../lib/ai-gateway';

export const FAL_BILLING_URL = 'https://api.fal.ai/v1/account/billing?expand=credits';
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_MODEL = 'claude-haiku-4-5-20251001';
/** Warn below this many USD. FLUX 1.1 Pro is ~$0.04 an image, so $10 is ~250 images of runway. */
export const DEFAULT_FAL_LOW_BALANCE_USD = 10;

export const STABILITY_BALANCE_URL = 'https://api.stability.ai/v1/user/balance';
/** One Stable Audio 3.0 track. Below this, music generation cannot run at all. */
export const STABILITY_TRACK_CREDITS = 26;
/** Warn below this many Stability credits: ~20 tracks of runway (~$5). STABILITY_LOW_BALANCE_CREDITS overrides. */
export const DEFAULT_STABILITY_LOW_BALANCE_CREDITS = 520;

export type StabilityBalance =
    | { status: 'ok'; credits: number }
    | { status: 'key_rejected'; httpStatus: number }
    | { status: 'not_configured' }
    | { status: 'error'; detail: string };

export type FalBalance =
    | { status: 'ok'; balance: number; currency: string }
    | { status: 'no_access'; httpStatus: number }        // key can't read billing — not an outage
    | { status: 'not_configured' }
    | { status: 'error'; detail: string };

export type AnthropicProbe =
    | { status: 'ok' }
    | { status: 'exhausted'; detail: string }            // the 2026-09-17 failure
    | { status: 'key_rejected'; detail: string }         // 401/403
    | { status: 'transient'; detail: string }            // 429, 5xx, network — not alerted on
    | { status: 'not_configured' };

/** fal's own lock message, as it lands in media_generation_jobs.error_message. */
export const FAL_LOCK_PATTERN = 'Exhausted balance|User is locked|unavailable \\((402|403)\\)';

export interface FalLockEvidence {
    failures: number; organisations: number; latestAt: string | null; sample: string | null;
    /** Newest fal image that DID generate. Later than latestAt = the account has recovered. */
    lastSuccessAt: string | null;
}

export async function readFalBalance(fetchImpl: typeof fetch = fetch): Promise<FalBalance> {
    const key = process.env.FAL_ADMIN_KEY || process.env.FAL_KEY;
    if (!key) return { status: 'not_configured' };
    try {
        const res = await fetchImpl(FAL_BILLING_URL, {
            headers: { Authorization: `Key ${key}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) return { status: 'no_access', httpStatus: res.status };
        if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };
        const data: any = await res.json().catch(() => null);
        const balance = Number(data?.credits?.current_balance);
        if (!Number.isFinite(balance)) return { status: 'error', detail: 'no credits.current_balance in the response' };
        return { status: 'ok', balance, currency: String(data?.credits?.currency || 'USD') };
    } catch (err) {
        return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
}

export async function readStabilityBalance(fetchImpl: typeof fetch = fetch): Promise<StabilityBalance> {
    const key = process.env.STABILITY_API_KEY;
    if (!key) return { status: 'not_configured' };
    try {
        const res = await fetchImpl(STABILITY_BALANCE_URL, {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) return { status: 'key_rejected', httpStatus: res.status };
        if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };
        const data: any = await res.json().catch(() => null);
        const credits = Number(data?.credits);
        if (!Number.isFinite(credits)) return { status: 'error', detail: 'no credits in the response' };
        return { status: 'ok', credits };
    } catch (err) {
        return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
}

/** Sort an Anthropic failure into "we must top up / fix the key" vs "try again later". */
export function classifyAnthropicError(err: unknown): Exclude<AnthropicProbe, { status: 'ok' } | { status: 'not_configured' }> {
    const detail = String((err as { message?: string } | null)?.message || err).slice(0, 300);
    if (err instanceof Anthropic.RateLimitError) return { status: 'transient', detail };
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return { status: 'key_rejected', detail };
    }
    if (isUpstreamBlocked(err)) return { status: 'exhausted', detail };
    return { status: 'transient', detail };
}

export async function probeAnthropic(
    call: (() => Promise<unknown>) | null = null,
): Promise<AnthropicProbe> {
    if (!process.env.ANTHROPIC_API_KEY && !call) return { status: 'not_configured' };
    const run = call ?? (() => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: PROBE_TIMEOUT_MS, maxRetries: 0 })
        .messages.create({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }));
    try {
        await run();
        return { status: 'ok' };
    } catch (err) {
        return classifyAnthropicError(err);
    }
}

export interface ProviderProblem {
    provider: 'fal' | 'anthropic' | 'stability';
    /** 'down' = customers are affected now; 'low' = they will be soon. */
    severity: 'down' | 'low';
    headline: string;
    lines: string[];
}

/**
 * Pure: turn the probe results into the problems worth a human's attention. Transient failures and
 * a key that simply can't read billing are NOT problems — alerting on them would train the reader
 * to ignore this email, which is how the next real outage goes unread.
 */
export function assessProviders(input: {
    fal: FalBalance;
    falEvidence: FalLockEvidence;
    anthropic: AnthropicProbe;
    falLowBalanceUsd?: number;
    /** Optional so existing callers and tests that predate music are unchanged. */
    stability?: StabilityBalance;
    stabilityLowBalanceCredits?: number;
}): ProviderProblem[] {
    const problems: ProviderProblem[] = [];
    const low = input.falLowBalanceUsd ?? DEFAULT_FAL_LOW_BALANCE_USD;
    const ev = input.falEvidence;
    // A success after the newest refusal means someone already topped up — the refusals are history.
    const recovered = !!(ev.lastSuccessAt && ev.latestAt && new Date(ev.lastSuccessAt) > new Date(ev.latestAt));
    const liveEvidence = ev.failures > 0 && !recovered;
    const evidenceLine = ev.failures > 0
        ? `${ev.failures} image generation${ev.failures === 1 ? '' : 's'} refused by fal in the last 24h across ${ev.organisations} organisation${ev.organisations === 1 ? '' : 's'} (latest ${ev.latestAt ?? 'unknown'}).`
        : null;
    const topUp = 'Top up at https://fal.ai/dashboard/billing — no code change will help.';

    if (input.fal.status === 'ok' && input.fal.balance <= 0) {
        problems.push({ provider: 'fal', severity: 'down', headline: 'fal balance is EMPTY — AI images are failing',
            lines: [`Balance: ${input.fal.balance.toFixed(2)} ${input.fal.currency}.`, evidenceLine, topUp].filter(Boolean) as string[] });
    } else if (liveEvidence && !(input.fal.status === 'ok' && input.fal.balance > low)) {
        // Evidence counts unless a healthy balance was read just now — then those failures predate
        // a top-up and the account is fine.
        problems.push({ provider: 'fal', severity: 'down', headline: 'fal has locked the account — AI images are failing',
            lines: [evidenceLine!, ev.sample ? `fal said: ${ev.sample}` : '', topUp,
                'Autopilot drafts fall back to stock photos or brand cards, so nothing else fails visibly.'].filter(Boolean) });
    } else if (input.fal.status === 'ok' && input.fal.balance < low) {
        problems.push({ provider: 'fal', severity: 'low', headline: `fal balance is low — ${input.fal.balance.toFixed(2)} ${input.fal.currency} left`,
            lines: [`Below the ${low} ${input.fal.currency} warning line. fal locks the account at zero and every AI image then fails.`, topUp] });
    }

    // ── Stability (music) ───────────────────────────────────────────────────────────────────────
    // A transient read error is NOT a problem, for the same reason as fal's: an alert that cries
    // wolf is the one nobody reads when the account really is empty.
    const st = input.stability;
    const stLow = input.stabilityLowBalanceCredits ?? DEFAULT_STABILITY_LOW_BALANCE_CREDITS;
    const stTopUp = 'Top up at https://platform.stability.ai/account/credits — customers get their AI credits back on every failed track, but no music.';
    if (st?.status === 'ok' && st.credits < STABILITY_TRACK_CREDITS) {
        problems.push({ provider: 'stability', severity: 'down', headline: 'Stability credits are EMPTY — Generate music is failing',
            lines: [`Balance: ${st.credits.toFixed(1)} credits; one track needs ${STABILITY_TRACK_CREDITS}.`, stTopUp] });
    } else if (st?.status === 'key_rejected') {
        problems.push({ provider: 'stability', severity: 'down', headline: 'Stability rejected our API key — Generate music is failing',
            lines: [`Balance endpoint answered HTTP ${st.httpStatus}.`, 'Check STABILITY_API_KEY in the Netlify environment (every context).'] });
    } else if (st?.status === 'ok' && st.credits < stLow) {
        const tracks = Math.floor(st.credits / STABILITY_TRACK_CREDITS);
        problems.push({ provider: 'stability', severity: 'low', headline: `Stability credits are low — ${Math.round(st.credits)} left (~${tracks} tracks)`,
            lines: [`Below the ${stLow}-credit warning line. Each generated track costs ${STABILITY_TRACK_CREDITS} credits (~$0.26).`, stTopUp] });
    }

    if (input.anthropic.status === 'exhausted') {
        problems.push({ provider: 'anthropic', severity: 'down', headline: 'Anthropic credit is EXHAUSTED — all AI drafting is failing',
            lines: [`Probe said: ${input.anthropic.detail}`,
                'Top up at https://console.anthropic.com/settings/billing. Jobs park for 72h, then fail terminally — requeue with scripts/requeue-failed-content-jobs.ts.'] });
    } else if (input.anthropic.status === 'key_rejected') {
        problems.push({ provider: 'anthropic', severity: 'down', headline: 'Anthropic rejected our API key — all AI drafting is failing',
            lines: [`Probe said: ${input.anthropic.detail}`, 'Check ANTHROPIC_API_KEY in the Netlify environment.'] });
    }
    return problems;
}
