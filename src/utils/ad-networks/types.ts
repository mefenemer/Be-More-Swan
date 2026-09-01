// src/utils/ad-networks/types.ts
// The one interface every ad network is reached through. Modelled on src/utils/blog-destinations/,
// which is the pattern in this codebase for "several external services, one contract".
//
// ── Why an adapter and not a LinkedIn client ────────────────────────────────────────────────────
// The brief asked for LinkedIn. The thing that makes LinkedIn buildable LATER without a redesign is
// that nothing above this file knows LinkedIn exists: the optimiser, the HTTP boundary and the
// surface all speak the vocabulary below. When Marketing Developer Platform access lands, a real
// adapter drops in beside the mock and nothing else changes.
//
// ── The contract that carries the human-in-the-loop rule ────────────────────────────────────────
// `stageCampaign` is the ONLY way to create anything on a network, and it MUST create it paused.
// `activateCampaign` is the only call that can start a spend, and the boundary only reaches it
// after a human has clicked approve with the number visible. Splitting them is what makes the
// invariant enforceable rather than a promise in a comment: there is no method on this interface
// that both creates and starts.
//
// An adapter that "helpfully" activated on stage would be a spend nobody approved. If you write a
// real adapter, that is the line to be paranoid about.

import type { AdNetwork } from '../../config/ad-networks';

/** What we ask a network to create. Copy and targeting are already approved by the time this runs. */
export interface StageVariantInput {
    /** Our own variant id, so the network's record can be traced back. */
    variantId: number;
    headline: string;
    body: string;
    /** Absolute URL. Normally one of our own /go/ tracked links, so clicks land in the ledger. */
    destinationUrl: string;
    /** Network-specific targeting, already validated. Opaque here on purpose. */
    targeting: Record<string, unknown>;
}

export interface StageCampaignInput {
    campaignId: number;
    organisationId: number;
    name: string;
    /** Daily ceiling in GBP for the whole campaign. */
    dailyBudgetGbp: number;
    variants: StageVariantInput[];
}

export interface StageCampaignResult {
    /** The network's id for the campaign. Stored so later calls can address it. */
    externalCampaignId: string;
    /** Network ids per variant, keyed by our variantId. */
    externalVariantIds: Record<number, string>;
    /**
     * What the network says it is. MUST be 'paused'. The caller asserts this rather than trusting
     * it — see registry.ts — because "we asked for paused" and "it is paused" are different claims
     * and only one of them is safe to record.
     */
    status: 'paused';
}

/** One variant's performance over one day. The optimiser's only input. */
export interface VariantMetrics {
    externalVariantId: string;
    day: string;              // YYYY-MM-DD, the network's own day boundary
    impressions: number;
    clicks: number;
    spendGbp: number;
    /** Conversions the NETWORK claims. Deliberately separate from our own attributed count. */
    reportedConversions: number;
}

/**
 * Everything a network must be able to do.
 *
 * Note what is absent: there is no `setBudget`, no `increaseBudget`, no `createCampaignActive`.
 * The interface cannot express raising a spend ceiling, so no amount of code above it can do so by
 * accident. Reallocation happens between variants inside a fixed campaign budget, which is
 * `pauseVariant` plus the network's own even distribution — see campaign-optimiser.ts.
 */
export interface AdNetworkAdapter {
    key: AdNetwork;
    label: string;

    /** Create the campaign and its variants, PAUSED. Never spends. */
    stageCampaign(input: StageCampaignInput): Promise<StageCampaignResult>;

    /** PAUSED → ACTIVE. The only call in this interface that can cost money. */
    activateCampaign(externalCampaignId: string): Promise<void>;

    /** Stop one variant. The kill switch's hands. */
    pauseVariant(externalVariantId: string, reason: string): Promise<void>;

    /** Stop everything on this campaign. */
    pauseCampaign(externalCampaignId: string): Promise<void>;

    /** Daily metrics for the given variants, over the last `days`. */
    fetchMetrics(externalVariantIds: string[], days: number): Promise<VariantMetrics[]>;

    /**
     * Can we still reach and control this account?
     *
     * ⚠️ Load-bearing, and the reason it is on the interface rather than inferred from a failed
     * call: a dead token while a paid campaign runs means the network keeps charging the customer
     * and we can no longer stop it. That is the "Control lost" state (plan §6), and it must be
     * detectable BEFORE we need to act, not discovered when the kill switch fails.
     */
    checkControl(externalCampaignId: string): Promise<{ ok: boolean; detail?: string }>;
}
