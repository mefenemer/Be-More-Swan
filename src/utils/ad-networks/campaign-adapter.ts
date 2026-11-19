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
import { assessMetaAdsReadiness, getMetaAdsConnection, getMetaAdsToken } from '../meta-ads-connection';

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
): Promise<CampaignAdapterResult> {
    const label = networkLabel(network);

    if (network === 'meta') {
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
            }, env) };
        } catch (err) {
            return { ok: false, label, noAdapter: true, reason: err instanceof Error ? err.message : 'Advertising is not available here yet.' };
        }
    }

    // LinkedIn — also every campaign staged before ad_network existed.
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
        return { ok: false, label, noAdapter: true, reason: err instanceof Error ? err.message : 'Advertising is not available here yet.' };
    }
}
