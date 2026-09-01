// src/utils/ad-networks/registry.ts
// Which ad networks this deployment can actually reach.
//
// ⚠️ THIS FILE IS THE LOCK. In production it resolves nothing, so the paid path terminates in a
// sentence naming the blocker instead of in a spend. Read the next paragraph before changing it.
//
// ── Why an empty registry rather than a feature flag alone ──────────────────────────────────────
// A flag protects against a decision; an empty registry protects against a mistake. The plan
// feature (`paid_ads`) is the commercial gate — somebody grants it on purpose. This is the
// structural one: even with the feature on, `resolveAdapter()` returns null for every real network
// because no real adapter exists to return.
//
// That means the failure mode of "someone enables paid ads early" is a clear refusal naming the
// approval we are waiting on, not a campaign that silently does nothing, and not a half-working
// integration against an API we do not have access to. Compare `follower-counts-availability`: a
// control that rendered and could never return a value.
//
// ── Adding the real LinkedIn adapter, when access lands ─────────────────────────────────────────
// 1. Write `src/utils/ad-networks/linkedin.ts` implementing AdNetworkAdapter.
// 2. Register it in ADAPTERS below.
// 3. Delete its entry from AD_NETWORK_BLOCKERS in src/config/ad-networks.ts.
// Nothing else changes — that is the point of the interface.
//
// ── The mock ────────────────────────────────────────────────────────────────────────────────────
// `mock` is registered ONLY outside production, and only when explicitly asked for. It exists so
// the optimiser, the staging flow and the approval flow are exercised end to end by tests today,
// rather than being written blind against an API nobody here has seen. It is never reachable by a
// tenant: `resolveAdapter` refuses it unless allowMock is passed, and the HTTP boundary never
// passes it.

import { AD_NETWORK_BLOCKERS, type AdNetwork } from '../../config/ad-networks';
import type { AdNetworkAdapter } from './types';
import { mockAdapter } from './mock';
import { createLinkedInAdapter, type LinkedInAdapterConfig } from './linkedin';

/**
 * Real, reachable adapters.
 *
 * ⚠️ DELIBERATELY EMPTY. Every entry added here is a network that can spend a customer's money.
 * Nothing belongs in this object until its access is approved AND its adapter has been exercised
 * against the real API.
 */
const ADAPTERS: Partial<Record<AdNetwork, AdNetworkAdapter>> = {
    // linkedin: ← Development Tier granted 2026-09-01 (app 247000116). Deliberately NOT registered
    //             here: see linkedInAdapter() below, which is DEV-ONLY until the ads OAuth flow
    //             exists and the 5-account edit cap has been exercised for real.
    // meta:     metaAdapter,       ← blocked on business verification
    // google:   googleAdapter,     ← blocked on a developer token
};

/**
 * LinkedIn, for development only.
 *
 * ⚠️ Deliberately NOT in ADAPTERS. Development Tier permits EDIT on at most five ad accounts, so
 * registering it for production would give the sixth tenant — and every tenant after — a control
 * that works for everybody else and fails for them. That is the `follower-counts-availability`
 * shape this whole phase was arranged to avoid, and it would fail at the worst possible moment:
 * mid-launch, on someone's money.
 *
 * It also cannot authenticate yet. There is no token carrying `rw_ads` / `r_ads_reporting`; the
 * workspace LinkedIn connection holds `w_member_social` only, and those scopes must not simply be
 * appended to it (see the header of linkedin.ts).
 *
 * Requires config the caller supplies, which is why it is a factory rather than a singleton.
 */
export function linkedInAdapter(cfg: LinkedInAdapterConfig): AdNetworkAdapter {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('The LinkedIn ads adapter is Development Tier only and must not be used in production.');
    }
    return createLinkedInAdapter(cfg);
}

export interface ResolveResult {
    adapter: AdNetworkAdapter | null;
    /** Why not, in the words the surface shows. Null when an adapter was found. */
    blocker: string | null;
}

/**
 * Find the adapter for a network, or explain why there isn't one.
 *
 * Never throws and never returns a partially-working stand-in. The caller gets an adapter it can
 * use, or a sentence it can show — those are the only two outcomes, and code that assumes a third
 * (a no-op adapter, say) would produce a campaign that reports success and does nothing.
 */
export function resolveAdapter(network: string, opts: { allowMock?: boolean } = {}): ResolveResult {
    // LinkedIn resolves to nothing here on purpose — it needs per-workspace config, so it is
    // constructed by linkedInAdapter() rather than looked up. The blocker below still explains why
    // a tenant cannot have it.
    if (network === 'mock') {
        // Two independent conditions. The env check alone would let a misconfigured production
        // deploy expose it; the flag alone would let any caller opt in.
        if (opts.allowMock && process.env.NODE_ENV !== 'production') {
            return { adapter: mockAdapter, blocker: null };
        }
        return { adapter: null, blocker: 'The mock ad network is not available here.' };
    }

    const adapter = ADAPTERS[network as AdNetwork];
    if (adapter) return { adapter, blocker: null };

    return {
        adapter: null,
        blocker: AD_NETWORK_BLOCKERS[network]
            ?? 'That advertising network is not connected, and no campaign can be created on it yet.',
    };
}

/**
 * Is ANY real network reachable?
 *
 * The surface asks this to decide between "create a paid campaign" and an honest locked state. It
 * ignores the mock entirely: a developer having the mock available must never make a tenant's
 * screen offer a button.
 */
export function anyNetworkAvailable(): boolean {
    return Object.keys(ADAPTERS).length > 0;
}

/** Every network we can name, with whether it is reachable and why not. For the locked state. */
export function networkAvailability(): { network: string; available: boolean; blocker: string | null }[] {
    return Object.keys(AD_NETWORK_BLOCKERS).map((network) => {
        const { adapter, blocker } = resolveAdapter(network);
        return { network, available: !!adapter, blocker };
    });
}
