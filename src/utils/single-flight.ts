// src/utils/single-flight.ts
// Collapse concurrent async work that shares a key down to ONE in-flight execution,
// so N callers awaiting the same thing produce 1 side effect and N identical results.
//
// Used by workspace-integrations.getFreshAccessToken(): providers with rotating
// single-use refresh tokens (Xero, QuickBooks, Jira, TikTok, Threads) invalidate the
// old refresh token the instant they mint a new one, so two concurrent refreshes for
// the same (org, provider) mean the second one POSTs an already-dead token and is
// rejected. This dedupes within a process; the DB row lock in getFreshAccessToken
// covers the cross-instance case.

const inflight = new Map<string, Promise<unknown>>();

/**
 * Run `fn` under `key`, or join the run already in flight for that key.
 *
 * The entry is removed once the promise settles, so the NEXT call after completion
 * starts fresh work rather than replaying a stale (or failed) result. Rejections are
 * shared by every joiner — callers must each handle their own rejection.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    // Start via Promise.resolve().then so a synchronous throw inside `fn` becomes a
    // rejected promise rather than escaping past the map bookkeeping below.
    const run = Promise.resolve().then(fn);

    // Register the JOINABLE promise (not `run`) so a joiner and the originator observe
    // the same settlement. Cleanup is guarded by identity: if a later call already
    // replaced this entry, we must not delete theirs.
    const joinable = run.finally(() => {
        if (inflight.get(key) === joinable) inflight.delete(key);
    });

    inflight.set(key, joinable);
    return joinable;
}

/** Number of keys currently in flight — for tests and diagnostics only. */
export function inflightCount(): number {
    return inflight.size;
}
