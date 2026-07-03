// src/utils/env-context.ts
// Epic: Superadmin Environment Management — US3 (Safe Data Mutation & API Key Swapping)
//
// Request-scoped Live/Sandbox environment context. A single AsyncLocalStorage store
// carries the resolved environment for the duration of a handler invocation, so the
// shared DB accessors (db/client.ts) and Stripe accessor (src/utils/stripe.ts) can
// route to the correct database / API key WITHOUT every call site passing a flag.
//
// Strict production default (AC 3.3): if the X-Environment header is missing or
// malformed, OR the caller is not authorised for sandbox, OR sandbox is not
// provisioned, we resolve to 'live'. Sandbox is opt-in and never the default.
//
// IMPORTANT: auth/role lookups must run OUTSIDE the sandbox context (i.e. against
// live), because user accounts live in the production database. Resolve the admin's
// identity first with the default (live) context, then wrap only the data work in
// runWithEnvironment().

import { AsyncLocalStorage } from 'node:async_hooks';

export type AppEnv = 'live' | 'sandbox';

const store = new AsyncLocalStorage<{ env: AppEnv }>();

/** The environment for the current async context. Defaults to 'live' when unset. */
export function currentEnv(): AppEnv {
    return store.getStore()?.env ?? 'live';
}

export function isSandbox(): boolean {
    return currentEnv() === 'sandbox';
}

type HeaderBag = Record<string, string | string[] | undefined> | undefined;

function readHeader(headers: HeaderBag, name: string): string | undefined {
    if (!headers) return undefined;
    // Netlify lower-cases header keys, but be defensive about casing.
    const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolve the request environment from the X-Environment header.
 *
 * Strict: only the exact token 'sandbox' (case-insensitive, trimmed) selects
 * sandbox. Anything else — missing, empty, 'SANDBOX ', 'test', garbage — resolves
 * to 'live' (AC 3.3). Sandbox additionally requires:
 *   - opts.allowSandbox === true (caller has verified super_admin), and
 *   - SANDBOX_DATABASE_URL to be provisioned.
 * Otherwise it falls back to 'live'.
 */
export function resolveEnvironment(
    headers: HeaderBag,
    opts: { allowSandbox: boolean },
): AppEnv {
    const raw = readHeader(headers, 'x-environment');
    const requested: AppEnv = raw?.trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'live';
    if (requested !== 'sandbox') return 'live';
    if (!opts.allowSandbox) return 'live';
    if (!process.env.SANDBOX_DATABASE_URL) return 'live';
    return 'sandbox';
}

/** Run `fn` with the given environment bound to the async context. */
export function runWithEnvironment<T>(env: AppEnv, fn: () => Promise<T>): Promise<T> {
    return store.run({ env }, fn);
}

/**
 * Convenience wrapper: resolve the environment from the event headers and run `fn`
 * inside that context. `allowSandbox` should be the result of a super_admin check.
 */
export function withEnvironment<T>(
    event: { headers?: HeaderBag },
    opts: { allowSandbox: boolean },
    fn: () => Promise<T>,
): Promise<T> {
    return runWithEnvironment(resolveEnvironment(event.headers, opts), fn);
}
