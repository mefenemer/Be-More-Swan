// src/utils/ad-networks/campaign-adapter.ts
// The adapter for an ALREADY-STAGED campaign, chosen by the network it was staged on
// (campaigns.ad_network). Used by approve_launch and the paid optimiser — the paths that start,
// read and stop spend — so both pick the network the same way.
//
// ⚠️ Uses each network's READINESS only, never its create checks (adsScopeProblem /
// metaAdsCreateProblem). Pausing needs less than creating, and a connection that can no longer
// create must still be able to stop a live campaign. See the warnings in both connection utils.
import type { AdNetworkAdapter } from './types';
import { linkedInAdapter, metaAdapter } from './registry';
import { assessAdsReadiness, getAdsConnection, getAdsToken } from '../linkedin-ads-connection';
import { assessMetaAdsReadiness, getMetaAdsConnection, getMetaAdsToken, metaAdsAllowedInProduction } from '../meta-ads-connection';

export type CampaignAdapterResult =
    | { ok: true; adapter: AdNetworkAdapter; label: string }
    /** `noAdapter`: the environment refuses this network (production) — not a connection problem. */
    | { ok: false; label: string; reason: string; noAdapter?: boolean };

export const networkLabel = (network: string | null | undefined): string => (network === 'meta' ? 'Meta' : 'LinkedIn');

export async function adapterForCampaign(
    db: any,
    organisationId: number,
    network: string | null | undefined,
    env: { isProduction: boolean },
    /**
     * 'launch' = about to START spend (approve_launch): Meta on production only for workspaces on
     * META_ADS_PROD_ORG_IDS. 'control' = read / pause an already-staged campaign (the optimiser):
     * Meta always resolves, so spend can always be STOPPED — even after a workspace is taken off the
     * list (review on 5ecf0583: unsetting the list must never leave a live campaign unwatchable).
     */
    purpose: 'launch' | 'control' = 'launch',
): Promise<CampaignAdapterResult> {
    const label = networkLabel(network);
    // ⚠️ `noAdapter` means ONE thing: this environment refuses dev-only adapters (production), so
    // the optimiser skips rather than halts. Any OTHER construction error (e.g. a malformed stored
    // account id) is a real problem with a live campaign and must halt it and tell the owner
    // (review on e4fb6828).
    if (network === 'meta') {
        // Production refuses Meta too, EXCEPT for workspaces on META_ADS_PROD_ORG_IDS (reviewer, pilots).
        if (env.isProduction && purpose === 'launch' && !metaAdsAllowedInProduction(organisationId)) {
            return { ok: false, label, noAdapter: true, reason: 'Advertising is not available here yet.' };
        }
        const readiness = assessMetaAdsReadiness(await getMetaAdsConnection(db, organisationId));
        if (!readiness.ready) return { ok: false, label, reason: readiness.reason };
        const token = await getMetaAdsToken(db, organisationId);
        if (!token) return { ok: false, label, reason: 'The Meta advertising connection needs reconnecting.' };
        try {
            // The Page is only needed to CREATE creatives; reading and pausing never use it.
            return { ok: true, label, adapter: metaAdapter({
                accessToken: token,
                accountId: readiness.connection.selectedAccountId!,
                pageId: readiness.connection.selectedPageId ?? '',
            }, { isProduction: false }) };
        } catch (err) {
            return { ok: false, label, reason: err instanceof Error ? err.message : 'The Meta advertising connection could not be used.' };
        }
    }

    // LinkedIn — also every campaign staged before ad_network existed. Development only, no exceptions.
    if (env.isProduction) {
        return { ok: false, label, noAdapter: true, reason: 'Advertising is not available here yet.' };
    }
    const readiness = assessAdsReadiness(await getAdsConnection(db, organisationId));
    if (!readiness.ready) return { ok: false, label, reason: readiness.reason };
    const token = await getAdsToken(db, organisationId);
    if (!token) return { ok: false, label, reason: 'The LinkedIn advertising connection needs reconnecting.' };
    try {
        return { ok: true, label, adapter: linkedInAdapter({
            accessToken: token,
            accountUrn: readiness.connection.selectedAccountUrn!,
            currencyCode: 'GBP',
        }, env) };
    } catch (err) {
        return { ok: false, label, reason: err instanceof Error ? err.message : 'The LinkedIn advertising connection could not be used.' };
    }
}
