// src/utils/stripe.ts
// Epic: Superadmin Environment Management — US3.2 (Stripe Key Swapping).
//
// Environment-aware Stripe client. getStripe() returns a client keyed to the active
// request environment (env-context.ts):
//   - live    → STRIPE_SECRET_KEY        (sk_live_… in production)
//   - sandbox → STRIPE_SECRET_KEY_TEST   (sk_test_…)
//
// Clients are cached per environment so a warm instance reuses connections. Use this
// helper anywhere admin code "manages plans or views invoices" so the same code path
// transparently hits test vs live Stripe.

import Stripe from 'stripe';
import { currentEnv, type AppEnv } from './env-context';

export const STRIPE_API_VERSION = '2026-05-27.dahlia';

const cache: Partial<Record<AppEnv, Stripe>> = {};

function keyFor(env: AppEnv): string | undefined {
    return env === 'sandbox' ? process.env.STRIPE_SECRET_KEY_TEST : process.env.STRIPE_SECRET_KEY;
}

/** True when a Stripe secret key is configured for the given environment. */
export function stripeKeyAvailable(env: AppEnv = currentEnv()): boolean {
    return !!keyFor(env);
}

/** Stripe client for the active environment. Throws if the key is not configured. */
export function getStripe(): Stripe {
    const env = currentEnv();
    if (!cache[env]) {
        const key = keyFor(env);
        if (!key) {
            throw new Error(
                env === 'sandbox'
                    ? 'STRIPE_SECRET_KEY_TEST is not configured — sandbox Stripe is unavailable.'
                    : 'STRIPE_SECRET_KEY is not configured.',
            );
        }
        cache[env] = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
    }
    return cache[env]!;
}
