// src/utils/trigger-blueprint-recompile.ts
// Kick off a platform-wide blueprint recompile after a plan price is applied.
//
// A price change affects every plan gate, so once it lands we refresh every compiled brief. That
// sweep (one assembleBlueprint per assistant) is far too long for the request that applies the
// price, so it runs in recompile-blueprints-background; this helper just pokes that worker.

import { resolveBaseUrl } from './base-url';

/** How long to wait for the background invoke to be ACCEPTED (not to finish). */
const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Fire the background recompile. Best-effort by construction: the price change has already been
 * persisted, so a failure here must never surface to the caller — it only means blueprints keep
 * their previous compilation until they next recompile for another reason.
 *
 * The fetch IS awaited on purpose: an un-awaited fetch can be frozen with the lambda before the
 * request leaves the sandbox, so the worker would never be invoked. Awaiting a `-background` invoke
 * is cheap — Netlify answers 202 as soon as it accepts the work — so this returns in milliseconds.
 */
export async function triggerBlueprintRecompile(reason: string): Promise<void> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.warn(`[trigger-blueprint-recompile] recompile not triggered (${!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'}) — blueprints keep their current compilation.`);
        return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        await fetch(`${baseUrl}/.netlify/functions/recompile-blueprints-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ reason }),
            signal: controller.signal,
        });
    } catch (err) {
        console.warn('[trigger-blueprint-recompile] trigger failed — blueprints keep their current compilation:',
            err instanceof Error ? err.message : err);
    } finally {
        clearTimeout(timer);
    }
}
