// src/utils/workspace-integrations.ts
// External Integrations (Phase 1: HubSpot, Xero, Slack · Phase 2: Salesforce, Zendesk,
// Notion · Phase 3: QuickBooks, Intercom, Gmail · Phase 4: Threads, TikTok, YouTube):
// the ONLY read/write path for workspace_integrations rows and their token material.
//
// Token custody follows the platform standard (US-DB-1.6.1): access/refresh tokens are
// never stored in table columns — they live AES-256-GCM encrypted in vault_secrets under
// 'aura/org-<orgId>/integration-<provider>', and the row only carries the refKey plus
// non-sensitive metadata (tenantId, expiry, scopes, account label).
//
// getFreshAccessToken() is what action endpoints call: it transparently refreshes an
// expired (or about-to-expire) access token using the provider's refresh grant, persists
// the rotated tokens (Xero rotates the refresh token on every use), and marks the row
// 'expired' when the refresh grant itself is rejected so the UI can prompt a reconnect.
//
// Refresh is SERIALISED per (org, provider) — see refreshUnderLock(). Several providers
// issue rotating single-use refresh tokens, so two concurrent refreshes would both POST
// the same token, the provider would honour the first and reject the second, and the
// loser would mark a perfectly healthy connection 'expired' for the whole org. The lock
// makes the loser wait and then re-read the winner's freshly stored token instead.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { workspaceIntegrations } from '../../db/schema';
import { storeSecret, getSecret, deleteSecret } from './vault';
import { singleFlight } from './single-flight';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type IntegrationProvider = 'hubspot' | 'xero' | 'slack' | 'salesforce' | 'zendesk' | 'notion' | 'quickbooks' | 'intercom' | 'gmail' | 'outlook' | 'threads' | 'tiktok' | 'youtube' | 'wordpresscom' | 'searchconsole' | 'jira' | 'asana' | 'canva';

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ['hubspot', 'xero', 'slack', 'salesforce', 'zendesk', 'notion', 'quickbooks', 'intercom', 'gmail', 'outlook', 'threads', 'tiktok', 'youtube', 'wordpresscom', 'searchconsole', 'jira', 'asana', 'canva'];

/**
 * Microsoft Graph delegated scope for outbound email. Shared by the authorize URL, the
 * code exchange and the refresh grant — Microsoft narrows the grant if refresh omits it,
 * so all three MUST send the same string. offline_access is what yields a refresh token
 * at all; without it a connection dies roughly an hour after consent.
 */
export const OUTLOOK_SCOPE = 'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read';

export function isIntegrationProvider(value: unknown): value is IntegrationProvider {
    return typeof value === 'string' && (INTEGRATION_PROVIDERS as string[]).includes(value);
}

/** Vault refKey for a workspace integration's token payload. */
export function integrationRefKey(organisationId: number, provider: IntegrationProvider): string {
    return `aura/org-${organisationId}/integration-${provider}`;
}

export class IntegrationError extends Error {
    /** 'not_connected' | 'expired' | 'refresh_failed' | 'provider_error' */
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

interface TokenPayload {
    accessToken: string;
    refreshToken: string | null;
}

export interface SaveIntegrationInput {
    organisationId: number;
    userId: number;
    provider: IntegrationProvider;
    accessToken: string;
    refreshToken?: string | null;
    /** Seconds until the access token expires; null/undefined = non-expiring. */
    expiresInSec?: number | null;
    tenantId?: string | null;
    externalAccountName?: string | null;
    scopes?: string | null;
}

/** Upsert the (org, provider) integration row and store tokens in the vault. */
export async function saveIntegration(db: Db, input: SaveIntegrationInput): Promise<void> {
    const refKey = integrationRefKey(input.organisationId, input.provider);
    await storeSecret(db, refKey, {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
    });

    const expiresAt = input.expiresInSec ? new Date(Date.now() + input.expiresInSec * 1000) : null;

    await db
        .insert(workspaceIntegrations)
        .values({
            organisationId: input.organisationId,
            provider: input.provider,
            vaultRefKey: refKey,
            tenantId: input.tenantId ?? null,
            externalAccountName: input.externalAccountName ?? null,
            scopes: input.scopes ?? null,
            status: 'active',
            connectedBy: input.userId,
            expiresAt,
        })
        .onConflictDoUpdate({
            target: [workspaceIntegrations.organisationId, workspaceIntegrations.provider],
            set: {
                vaultRefKey: refKey,
                tenantId: input.tenantId ?? null,
                externalAccountName: input.externalAccountName ?? null,
                scopes: input.scopes ?? null,
                status: 'active',
                connectedBy: input.userId,
                expiresAt,
                updatedAt: new Date(),
            },
        });
}

export async function getIntegration(db: Db, organisationId: number, provider: IntegrationProvider) {
    const [row] = await db
        .select()
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, organisationId),
            eq(workspaceIntegrations.provider, provider),
        ))
        .limit(1);
    return row ?? null;
}

/** Remove the integration row and its vault secret (disconnect). */
export async function deleteIntegration(db: Db, organisationId: number, provider: IntegrationProvider): Promise<void> {
    await deleteSecret(db, integrationRefKey(organisationId, provider)).catch(() => {});
    await db
        .delete(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, organisationId),
            eq(workspaceIntegrations.provider, provider),
        ));
}

// ── Token refresh ─────────────────────────────────────────────────────────────

// Refresh an access token if it expires within this window, so a token can't die
// mid-way through a multi-call sync action.
const REFRESH_SKEW_MS = 60 * 1000;

// Salesforce token responses never include expires_in (access tokens die with the org's
// session timeout, 2h by default). Persist this synthetic TTL instead so
// getFreshAccessToken proactively refreshes before the real session lapses.
export const SALESFORCE_SYNTHETIC_TTL_SEC = 90 * 60;

interface RefreshResult {
    accessToken: string;
    refreshToken: string | null; // null = provider did not rotate it; keep the old one
    expiresInSec: number | null;
}

async function refreshProviderToken(provider: IntegrationProvider, refreshToken: string, tenantId: string | null): Promise<RefreshResult> {
    if (provider === 'hubspot') {
        const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.HUBSPOT_CLIENT_ID ?? '',
                client_secret: process.env.HUBSPOT_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json();
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'HubSpot token refresh was rejected.', 401);
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'xero') {
        const credentials = Buffer.from(`${process.env.XERO_CLIENT_ID ?? ''}:${process.env.XERO_CLIENT_SECRET ?? ''}`).toString('base64');
        const res = await fetch('https://identity.xero.com/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json();
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Xero token refresh was rejected.', 401);
        // Xero ALWAYS rotates the refresh token — the old one is now dead.
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'salesforce') {
        const res = await fetch('https://login.salesforce.com/services/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.SALESFORCE_CLIENT_ID ?? '',
                client_secret: process.env.SALESFORCE_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; instance_url?: string } = await res.json();
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Salesforce token refresh was rejected.', 401);
        // Salesforce refresh responses carry no expires_in — the token lives as long as
        // the org's session timeout. Re-arm the same synthetic window used at connect
        // time so getFreshAccessToken keeps refreshing proactively.
        return { accessToken: data.access_token, refreshToken: null, expiresInSec: SALESFORCE_SYNTHETIC_TTL_SEC };
    }

    if (provider === 'zendesk') {
        // Zendesk token endpoints live on the customer's subdomain (stored as tenantId).
        // This path only runs when the Zendesk app is configured with expiring tokens.
        if (!tenantId) throw new IntegrationError('refresh_failed', 'Zendesk token refresh needs the subdomain mapping — please reconnect it.', 401);
        const res = await fetch(`https://${tenantId}.zendesk.com/oauth/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                client_id: process.env.ZENDESK_CLIENT_ID ?? '',
                client_secret: process.env.ZENDESK_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Zendesk token refresh was rejected.', 401);
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'notion') {
        // Notion access tokens never expire and there is no refresh grant — reaching
        // here means the row's expiresAt was set in error; force a reconnect.
        throw new IntegrationError('refresh_failed', 'Notion tokens cannot be refreshed — please reconnect it on the Integrations page.', 401);
    }

    if (provider === 'quickbooks') {
        const credentials = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID ?? ''}:${process.env.QUICKBOOKS_CLIENT_SECRET ?? ''}`).toString('base64');
        const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'QuickBooks token refresh was rejected.', 401);
        // QuickBooks rotates the refresh token roughly every 24h — always persist the new one.
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'intercom') {
        // Intercom access tokens never expire and there is no refresh grant — reaching
        // here means the row's expiresAt was set in error; force a reconnect.
        throw new IntegrationError('refresh_failed', 'Intercom tokens cannot be refreshed — please reconnect it on the Integrations page.', 401);
    }

    if (provider === 'wordpresscom') {
        // WordPress.com access tokens never expire and there is no refresh grant — reaching
        // here means the row's expiresAt was set in error; force a reconnect.
        throw new IntegrationError('refresh_failed', 'WordPress.com tokens cannot be refreshed — please reconnect it.', 401);
    }

    if (provider === 'gmail') {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.GMAIL_CLIENT_ID ?? '',
                client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Gmail token refresh was rejected.', 401);
        // Google does not rotate the refresh token on use — keep the stored one.
        return { accessToken: data.access_token, refreshToken: null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'outlook') {
        // Microsoft identity platform v2.0. The /common authority serves both work/school
        // (Entra ID) and personal Microsoft accounts, matching the app's "any tenant +
        // personal" registration. The scope must be re-sent on refresh or Graph narrows the grant.
        const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.OUTLOOK_CLIENT_ID ?? '',
                client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
                scope: OUTLOOK_SCOPE,
            }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Outlook token refresh was rejected.', 401);
        // Microsoft ROTATES the refresh token on use — persist the new one, or the next
        // refresh fails with invalid_grant and the user has to reconnect.
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'threads') {
        // Threads long-lived tokens (~60 days) refresh with the CURRENT token itself —
        // there is no separate refresh_token, so the vault stores the long-lived token
        // in both slots and this grant rotates them together. Refreshing only works
        // while the token is still valid; once lapsed the user must reconnect.
        const res = await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(refreshToken)}`);
        const data: { access_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Threads token refresh was rejected.', 401);
        return { accessToken: data.access_token, refreshToken: data.access_token, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'tiktok') {
        const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_key: process.env.TIKTOK_CLIENT_ID ?? '',
                client_secret: process.env.TIKTOK_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'TikTok token refresh was rejected.', 401);
        // TikTok rotates the refresh token — always persist the new one.
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'youtube') {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.YOUTUBE_CLIENT_ID ?? '',
                client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'YouTube token refresh was rejected.', 401);
        // Google does not rotate the refresh token on use — keep the stored one.
        return { accessToken: data.access_token, refreshToken: null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'searchconsole') {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.SEARCHCONSOLE_CLIENT_ID ?? '',
                client_secret: process.env.SEARCHCONSOLE_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Google Search Console token refresh was rejected.', 401);
        // Google does not rotate the refresh token on use — keep the stored one.
        return { accessToken: data.access_token, refreshToken: null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'jira') {
        const res = await fetch('https://auth.atlassian.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                client_id: process.env.JIRA_CLIENT_ID ?? '',
                client_secret: process.env.JIRA_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Jira token refresh was rejected.', 401);
        // Atlassian rotates the refresh token on use (rotating refresh tokens) — persist the new one.
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
    }

    if (provider === 'asana') {
        const res = await fetch('https://app.asana.com/-/oauth_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: process.env.ASANA_CLIENT_ID ?? '',
                client_secret: process.env.ASANA_CLIENT_SECRET ?? '',
                refresh_token: refreshToken,
            }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Asana token refresh was rejected.', 401);
        // Asana does not rotate the refresh token on use — keep the stored one when none is returned.
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? 3600 };
    }

    if (provider === 'canva') {
        const credentials = Buffer.from(`${process.env.CANVA_CLIENT_ID ?? ''}:${process.env.CANVA_CLIENT_SECRET ?? ''}`).toString('base64');
        const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        });
        const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Canva token refresh was rejected.', 401);
        // Canva refresh tokens are SINGLE-USE and always rotate — the one we just sent is now
        // dead, so a missing refresh_token in the response would strand the connection. Treat
        // that as a failure rather than falling back to the stored (now-spent) token.
        if (!data.refresh_token) throw new IntegrationError('refresh_failed', 'Canva did not return a rotated refresh token — please reconnect it.', 401);
        return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSec: data.expires_in ?? null };
    }

    // Slack: only used when token rotation is enabled on the app (otherwise bot tokens
    // never expire and this path is never reached — expiresAt stays null).
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: process.env.SLACK_CLIENT_ID ?? '',
            client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
            refresh_token: refreshToken,
        }),
    });
    const data: { ok?: boolean; access_token?: string; refresh_token?: string; expires_in?: number } = await res.json();
    if (!data.ok || !data.access_token) throw new IntegrationError('refresh_failed', 'Slack token refresh was rejected.', 401);
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSec: data.expires_in ?? null };
}

export interface FreshToken {
    accessToken: string;
    tenantId: string | null;
    integrationId: number;
}

// How long a caller waits for the lock held by whoever is mid-refresh. Comfortably
// longer than a refresh round-trip, short enough that a wedged provider surfaces as a
// clean error instead of piling up serverless invocations until they time out.
const REFRESH_LOCK_TIMEOUT = '15s';

/**
 * The outcome of a locked refresh attempt.
 *
 * The failure path CANNOT write status='expired' from inside the transaction: the
 * caller throws on failure, and anything written in the transaction is rolled back —
 * so the row would silently stay 'active'. The transaction therefore returns the
 * verdict and getFreshAccessToken applies it after the transaction has committed.
 */
type RefreshOutcome =
    | { ok: true; token: FreshToken }
    | { ok: false; markExpired: boolean; error: IntegrationError };

/**
 * Refresh (org, provider) with the workspace_integrations row locked FOR UPDATE.
 *
 * The lock is what makes rotating single-use refresh tokens safe: a concurrent caller
 * blocks here rather than racing to spend the same refresh token, and once it acquires
 * the lock it re-reads the row and vault INSIDE the lock. If the winner already
 * refreshed, expiresAt is no longer in the skew window and we return their token
 * without touching the provider at all.
 */
async function refreshUnderLock(tx: Tx, organisationId: number, provider: IntegrationProvider): Promise<RefreshOutcome> {
    await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${REFRESH_LOCK_TIMEOUT}'`)}`);

    const [row] = await tx
        .select()
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, organisationId),
            eq(workspaceIntegrations.provider, provider),
        ))
        .limit(1)
        .for('update');

    if (!row || row.status === 'revoked') {
        return { ok: false, markExpired: false, error: new IntegrationError('not_connected', `${providerLabel(provider)} is not connected for this workspace. Connect it on the Integrations page first.`, 409) };
    }

    const secret = (await getSecret(tx, row.vaultRefKey).catch(() => null)) as TokenPayload | null;
    if (!secret?.accessToken) {
        return { ok: false, markExpired: false, error: new IntegrationError('not_connected', `${providerLabel(provider)} credentials are missing — please reconnect it on the Integrations page.`, 409) };
    }

    // Re-check under the lock. We may have queued behind a concurrent refresh that has
    // already stored a good token — spending our (now dead) refresh token would burn it.
    const stillExpired = row.expiresAt && row.expiresAt.getTime() - REFRESH_SKEW_MS < Date.now();
    if (!stillExpired) {
        return { ok: true, token: { accessToken: secret.accessToken, tenantId: row.tenantId, integrationId: row.id } };
    }

    if (!secret.refreshToken) {
        return { ok: false, markExpired: true, error: new IntegrationError('expired', `${providerLabel(provider)} access has expired and no refresh token is available — please reconnect it.`, 409) };
    }

    try {
        const refreshed = await refreshProviderToken(provider, secret.refreshToken, row.tenantId);
        await storeSecret(tx, row.vaultRefKey, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? secret.refreshToken,
        });
        await tx.update(workspaceIntegrations).set({
            status: 'active',
            expiresAt: refreshed.expiresInSec ? new Date(Date.now() + refreshed.expiresInSec * 1000) : null,
            updatedAt: new Date(),
        }).where(eq(workspaceIntegrations.id, row.id));
        return { ok: true, token: { accessToken: refreshed.accessToken, tenantId: row.tenantId, integrationId: row.id } };
    } catch (err) {
        // Genuine rejection (revoked app, rotated client secret, user disconnected upstream):
        // we held the lock, so no concurrent caller can have spent this refresh token —
        // the grant really is dead and reconnecting is the only fix.
        const error = err instanceof IntegrationError
            ? err
            : new IntegrationError('refresh_failed', `${providerLabel(provider)} token refresh failed — please reconnect it on the Integrations page.`, 401);
        return { ok: false, markExpired: true, error };
    }
}

/**
 * Resolve a valid access token for (org, provider), refreshing it first when expired
 * or about to expire. Throws IntegrationError('not_connected' | 'refresh_failed').
 */
export async function getFreshAccessToken(db: Db, organisationId: number, provider: IntegrationProvider): Promise<FreshToken> {
    const row = await getIntegration(db, organisationId, provider);
    if (!row || row.status === 'revoked') {
        throw new IntegrationError('not_connected', `${providerLabel(provider)} is not connected for this workspace. Connect it on the Integrations page first.`, 409);
    }

    const secret = (await getSecret(db, row.vaultRefKey).catch(() => null)) as TokenPayload | null;
    if (!secret?.accessToken) {
        throw new IntegrationError('not_connected', `${providerLabel(provider)} credentials are missing — please reconnect it on the Integrations page.`, 409);
    }

    // Fast path: a healthy token needs no lock, so the common case never touches the
    // transaction and stays exactly as cheap as it was before.
    const expired = row.expiresAt && row.expiresAt.getTime() - REFRESH_SKEW_MS < Date.now();
    if (!expired) {
        return { accessToken: secret.accessToken, tenantId: row.tenantId, integrationId: row.id };
    }

    // Slow path. singleFlight collapses same-process concurrency (the batch-import case,
    // where the pool is max:1 and a transaction would otherwise hold the only connection
    // while every sibling job queues); the FOR UPDATE row lock inside covers callers in
    // other serverless instances, which share nothing but the database. Joiners share one
    // outcome, so the 'expired' write below happens once per refresh, not once per caller.
    const outcome = await singleFlight(`integration-refresh:${organisationId}:${provider}`, async () => {
        const result = await db.transaction((tx) => refreshUnderLock(tx as Tx, organisationId, provider));
        // Applied only after the transaction commits: this write must survive the throw,
        // and anything written inside the transaction would roll back with it.
        if (!result.ok && result.markExpired) {
            await db.update(workspaceIntegrations).set({ status: 'expired', updatedAt: new Date() }).where(eq(workspaceIntegrations.id, row.id));
        }
        return result;
    });

    if (outcome.ok) return outcome.token;
    throw outcome.error;
}

const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
    hubspot: 'HubSpot',
    xero: 'Xero',
    slack: 'Slack',
    salesforce: 'Salesforce',
    zendesk: 'Zendesk',
    notion: 'Notion',
    quickbooks: 'QuickBooks',
    intercom: 'Intercom',
    gmail: 'Gmail',
    outlook: 'Outlook',
    threads: 'Threads',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    wordpresscom: 'WordPress.com',
    searchconsole: 'Google Search Console',
    jira: 'Jira',
    asana: 'Asana',
    canva: 'Canva',
};

export function providerLabel(provider: IntegrationProvider): string {
    return PROVIDER_LABELS[provider];
}
