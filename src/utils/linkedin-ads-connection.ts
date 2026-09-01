// src/utils/linkedin-ads-connection.ts
// Reading the workspace's LinkedIn ADVERTISING connection: the token, the chosen ad account, and
// whether it is usable at all.
//
// One resolver, because both callers — the account picker and `stage_paid` — must agree about what
// "connected" means. If they disagree, one of them offers a control the other refuses, and the user
// is left pressing a button that cannot work.
//
// ⚠️ NEVER reads `service_name = 'linkedin'`. That is the POSTING connection: a different token,
// different scopes, and it cannot touch an ad account. Reading it here would produce a "connected"
// state backed by credentials that fail on the first API call — the worst kind, because it fails
// at spend time rather than at connect time.

import { and, eq } from 'drizzle-orm';
import { systemConnections } from '../../db/schema';
import { getSecret } from './vault';

/** The ads connection's service name. Mirrors the callback's constant; a test pins them together. */
export const ADS_SERVICE_NAME = 'linkedin_ads';

export interface AdAccountOption {
    urn: string;
    name: string;
    currency: string;
}

export interface AdsConnection {
    connectionId: number;
    /** Ad accounts discovered at connect time. `null` means the listing FAILED, not that there are none. */
    adAccounts: AdAccountOption[] | null;
    /** The account the user picked. Null until they do — nothing can be staged before then. */
    selectedAccountUrn: string | null;
    /** The selected account's own currency. Never assumed. */
    selectedCurrency: string | null;
    scopes: string | null;
    status: string;
}

/**
 * The workspace's ads connection, without its token.
 *
 * Returns null when there is none. Used by any surface that needs to render state, so it
 * deliberately does NOT touch the vault — reading a credential to decide what to draw is how
 * tokens end up in places they should not be.
 */
export async function getAdsConnection(db: any, organisationId: number): Promise<AdsConnection | null> {
    const [row] = await db.select({
        id: systemConnections.id,
        metadata: systemConnections.metadata,
        scopes: systemConnections.scopes,
        status: systemConnections.status,
    }).from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, ADS_SERVICE_NAME),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);
    if (!row) return null;

    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const accounts = meta.adAccounts;
    const selectedAccountUrn = typeof meta.selectedAccountUrn === 'string' ? meta.selectedAccountUrn : null;
    const list = Array.isArray(accounts) ? accounts as AdAccountOption[] : null;

    return {
        connectionId: row.id,
        adAccounts: list,
        selectedAccountUrn,
        // Read from the stored list rather than trusted from anywhere else, so the currency always
        // belongs to the account actually selected.
        selectedCurrency: selectedAccountUrn
            ? (list?.find((a) => a.urn === selectedAccountUrn)?.currency ?? null)
            : null,
        scopes: row.scopes ?? null,
        status: row.status,
    };
}

/** The access token, read separately and only when a call is actually about to be made. */
export async function getAdsToken(db: any, organisationId: number): Promise<string | null> {
    const [row] = await db.select({ vaultRefKey: systemConnections.vaultRefKey })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, ADS_SERVICE_NAME),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);
    if (!row?.vaultRefKey) return null;
    const secret = await getSecret(db, row.vaultRefKey);
    const token = secret?.token;
    return typeof token === 'string' && token ? token : null;
}

export type AdsReadiness =
    | { ready: true; connection: AdsConnection }
    | { ready: false; reason: string };

/**
 * Is this workspace ready to stage a paid campaign?
 *
 * Every refusal is a SENTENCE, not a boolean. The four ways this can fail are genuinely different
 * and lead to different next actions — connect, reconnect, pick an account, or contact LinkedIn —
 * and a single "not ready" would send everyone to the wrong one.
 */
export function assessAdsReadiness(connection: AdsConnection | null): AdsReadiness {
    if (!connection) {
        return { ready: false, reason: 'No LinkedIn advertising account is connected to this workspace yet.' };
    }
    if (connection.status !== 'active') {
        return { ready: false, reason: 'The LinkedIn advertising connection needs reconnecting before it can be used.' };
    }
    if (connection.adAccounts === null) {
        // ⚠️ null is "we could not ask", NOT "you have none". Telling someone to create an ad
        // account they already have is worse than saying nothing.
        return { ready: false, reason: 'We could not read your LinkedIn ad accounts. Reconnect to try again.' };
    }
    if (connection.adAccounts.length === 0) {
        return { ready: false, reason: 'This LinkedIn account has no advertising accounts. Create one in LinkedIn Campaign Manager first.' };
    }
    if (!connection.selectedAccountUrn) {
        return { ready: false, reason: 'Choose which LinkedIn ad account this workspace should use.' };
    }
    if (!connection.selectedCurrency) {
        // The account vanished from the list between selection and now — a re-connect can change
        // what is available. Better to ask again than to price a campaign in an unknown currency.
        return { ready: false, reason: 'The selected ad account is no longer available. Choose one again.' };
    }
    return { ready: true, connection };
}
