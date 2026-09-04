// src/utils/deploy-context.ts
// Which deployment am I? The one question the paid rails' safety gate turns on.
//
// ── Why this is not `process.env.NODE_ENV` ──────────────────────────────────────────────────────
// It was, and that was wrong twice over:
//
//   1. NODE_ENV appears NOWHERE ELSE in this codebase's functions. Netlify sets it to 'production'
//      for the BUILD, and it stays 'production' at function runtime on every context — including
//      branch deploys. So a gate reading `NODE_ENV !== 'production'` is false on STAGING too, and
//      the dev-only LinkedIn adapter could never have been exercised anywhere at all. A safety gate
//      that blocks the only place you could safely test is not a safety gate, it is a wall.
//   2. `CONTEXT` and `BRANCH` are Netlify BUILD-time variables and are frequently absent at
//      function runtime — admin-system-status.ts documents exactly this, and derives from the
//      request host instead, which IS always available.
//
// This module is that same derivation, in one place, so the paid gate and the admin status page
// cannot drift apart about what "production" means.
//
// ── It fails CLOSED ─────────────────────────────────────────────────────────────────────────────
// With no host to judge by — a scheduled function, which Netlify only ever runs on the production
// deploy — the answer is PRODUCTION. Guessing "staging" when we cannot tell would let the dev-only
// adapter run against a real customer's ad account, which is the exact outcome the gate exists to
// prevent.

type Headers = Record<string, string | undefined> | undefined | null;

/** Hosts that are the real production site. Everything else is a branch or preview deploy. */
const PROD_HOSTS = new Set(['bemoreswan.com', 'www.bemoreswan.com']);

/**
 * Is this request running on the production deployment?
 *
 * @param headers  The request's headers. OMIT for a scheduled function — there is no request, and
 *                 the answer is `true`, which is both correct (Netlify runs schedules on production
 *                 only) and the safe default.
 */
export function isProductionDeploy(headers?: Headers): boolean {
    // Build-time signals first, when they survived into the runtime environment.
    if (process.env.CONTEXT === 'production' || process.env.BRANCH === 'main') return true;
    // Explicit non-production build contexts. Only trusted to say NO, never to say yes.
    if (process.env.CONTEXT === 'branch-deploy' || process.env.CONTEXT === 'deploy-preview') return false;

    const host = String(headers?.host || headers?.['x-forwarded-host'] || '').toLowerCase().split(':')[0];
    // ⚠️ No host means no request means a scheduled function — production. Fail closed.
    if (!host) return true;
    return PROD_HOSTS.has(host);
}
