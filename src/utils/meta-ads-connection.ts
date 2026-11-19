// src/utils/meta-ads-connection.ts
// Reading the workspace's Meta ADVERTISING connection: the token, the chosen ad account and Page,
// and whether it is usable. Mirrors linkedin-ads-connection.ts.
//
// ⚠️ NEVER reads the posting connections (service_name 'facebook' / 'instagram'). Those tokens were
// granted for publishing and carry no ads permission; reading them here would show "connected" and
// then fail at spend time — the worst moment to fail.
import { and, eq } from 'drizzle-orm';
import { systemConnections } from '../../db/schema';
import { getSecret } from './vault';

/** The Meta ads connection's service name. NEVER 'facebook' or 'instagram'. */
export const META_ADS_SERVICE_NAME = 'meta_ads';

/**
 * Permissions the ads sign-in asks for. Override with META_ADS_SCOPES (comma-separated) WITHOUT a
 * deploy: a permission the Meta app has not added fails the whole login ("Invalid Scopes"), and the
 * fix is then a Netlify variable, not a PR.
 *
 *   ads_management        create/pause campaigns, ad sets, ads, creatives, images
 *   ads_read              read insights for the optimiser
 *   business_management   see ad accounts owned by a business portfolio, not just personal ones
 *   pages_show_list       list the Pages an advert can be published as
 *   pages_read_engagement creatives are Page posts; Meta reads the Page to build them
 */
export const META_ADS_DEFAULT_SCOPES = 'ads_management,ads_read,business_management,pages_show_list,pages_read_engagement';

export function metaAdsScopes(): string {
    const override = String(process.env.META_ADS_SCOPES ?? '').trim().replace(/[\s,]+/g, ',').replace(/^,|,$/g, '');
    return override || META_ADS_DEFAULT_SCOPES;
}

/** What creating anything needs. Reading/pausing needs less, so this gates only the create paths. */
export const META_ADS_CREATE_PERMISSIONS = ['ads_management', 'pages_show_list'];

export interface MetaAdAccountOption { id: string; name: string; currency: string; accountStatus: number | null }
export interface MetaPageOption { id: string; name: string }

export interface MetaAdsConnection {
    connectionId: number;
    /** null = the listing FAILED, not "you have none". */
    adAccounts: MetaAdAccountOption[] | null;
    pages: MetaPageOption[] | null;
    selectedAccountId: string | null;
    selectedCurrency: string | null;
    selectedPageId: string | null;
    /** Permissions actually GRANTED at connect time (comma-separated), when Meta told us. */
    scopes: string | null;
    status: string;
}

export async function getMetaAdsConnection(db: any, organisationId: number): Promise<MetaAdsConnection | null> {
    const [row] = await db.select({
        id: systemConnections.id,
        metadata: systemConnections.metadata,
        scopes: systemConnections.scopes,
        status: systemConnections.status,
    }).from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, META_ADS_SERVICE_NAME),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);
    if (!row) return null;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const accounts = Array.isArray(meta.adAccounts) ? meta.adAccounts as MetaAdAccountOption[] : null;
    const pages = Array.isArray(meta.pages) ? meta.pages as MetaPageOption[] : null;
    const selectedAccountId = typeof meta.selectedAccountId === 'string' ? meta.selectedAccountId : null;
    const selectedPageId = typeof meta.selectedPageId === 'string' ? meta.selectedPageId : null;
    return {
        connectionId: row.id,
        adAccounts: accounts,
        pages,
        selectedAccountId,
        // From the stored list, so the currency always belongs to the account actually selected.
        selectedCurrency: selectedAccountId ? (accounts?.find((a) => a.id === selectedAccountId)?.currency ?? null) : null,
        // Only a Page still in the list counts — a reconnect can change what is available.
        selectedPageId: selectedPageId && pages?.some((p) => p.id === selectedPageId) ? selectedPageId : null,
        scopes: row.scopes ?? null,
        status: row.status,
    };
}

export async function getMetaAdsToken(db: any, organisationId: number): Promise<string | null> {
    const [row] = await db.select({ vaultRefKey: systemConnections.vaultRefKey })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, META_ADS_SERVICE_NAME),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);
    if (!row?.vaultRefKey) return null;
    const secret = await getSecret(db, row.vaultRefKey);
    const token = secret?.token;
    return typeof token === 'string' && token ? token : null;
}

export type MetaAdsReadiness =
    | { ready: true; connection: MetaAdsConnection }
    | { ready: false; reason: string };

/**
 * Can this workspace's Meta connection be used at all (read, pause)? Every refusal is a sentence.
 *
 * ⚠️ Like LinkedIn, the optimiser uses THIS to decide whether it can still pause through the
 * adapter. Anything that only blocks CREATING belongs in metaAdsCreateProblem, not here — a
 * not-ready verdict makes the optimiser halt without the adapter, which would mark a campaign
 * paused here while it keeps spending on Meta.
 */
export function assessMetaAdsReadiness(connection: MetaAdsConnection | null): MetaAdsReadiness {
    if (!connection) return { ready: false, reason: 'No Meta advertising account is connected to this workspace yet.' };
    if (connection.status !== 'active') return { ready: false, reason: 'The Meta advertising connection needs reconnecting before it can be used.' };
    if (connection.adAccounts === null) return { ready: false, reason: 'We could not read your Meta ad accounts. Reconnect to try again.' };
    if (connection.adAccounts.length === 0) return { ready: false, reason: 'This Facebook login has no ad accounts. Create one in Meta Ads Manager first.' };
    if (!connection.selectedAccountId) return { ready: false, reason: 'Choose which Meta ad account this workspace should use.' };
    if (!connection.selectedCurrency) return { ready: false, reason: 'The selected ad account is no longer available. Choose one again.' };
    return { ready: true, connection };
}

/** True when the fix is the Meta ads sign-in again (the surface offers the connect link). */
export function metaAdsNeedsReconnect(connection: MetaAdsConnection | null): boolean {
    if (!connection) return false;
    if (connection.status !== 'active' || connection.adAccounts === null || connection.pages === null) return true;
    if (connection.scopes === null) return false;
    const held = new Set(connection.scopes.split(/[\s,]+/).filter(Boolean));
    return META_ADS_CREATE_PERMISSIONS.some((p) => !held.has(p));
}

/** A reason creating adverts is blocked, or null. Only the create paths and the surfaces call this. */
export function metaAdsCreateProblem(connection: MetaAdsConnection | null): string | null {
    if (!connection) return null;
    if (connection.scopes !== null) {
        const held = new Set(connection.scopes.split(/[\s,]+/).filter(Boolean));
        const missing = META_ADS_CREATE_PERMISSIONS.filter((p) => !held.has(p));
        if (missing.length) return `Reconnect Meta advertising and allow ${missing.join(' and ')} — without it we cannot create adverts.`;
    }
    if (connection.pages === null) return 'We could not read your Facebook Pages. Reconnect to try again.';
    if (connection.pages.length === 0) return 'Meta adverts are published by a Facebook Page, and this login manages none.';
    if (!connection.selectedPageId) return 'Choose which Facebook Page these adverts should be published as.';
    return null;
}
