// netlify/functions/meta-ads-oauth-callback.ts
// GET — finishes Meta ADVERTISING authorisation: code → token → long-lived token → ad accounts,
// Pages and the permissions actually granted, stored as the workspace's `meta_ads` connection.
//
// ⚠️ Writes ONLY service_name = 'meta_ads'. Touching 'facebook' / 'instagram' would overwrite a
// posting connection with a token that was granted for something else.
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { auditLogs, systemConnections } from '../../db/schema';
import { getSecret, storeSecret, deleteSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { metaAdsCallbackPath, metaAdsCsrfKey } from './meta-ads-oauth-init';
import { META_ADS_SERVICE_NAME, metaAdsScopes } from '../../src/utils/meta-ads-connection';
import {
    fetchGrantedPermissions, fetchMetaAdAccounts, fetchMetaPages, metaAdsGraphVersion,
} from '../../src/utils/ad-networks/meta';
import { withLambda } from '@netlify/aws-lambda-compat';
import { requireSession } from '../../src/utils/session';
import { requireOrgMembership } from '../../src/utils/tenant';

const redirect = (to: string) => ({ statusCode: 302, headers: { Location: to }, body: '' });

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>) || '';
    const q = event.queryStringParameters || {};

    // Cancel on Meta's consent screen. Not an error — say nothing alarming.
    if (q.error) return redirect('/integrations.html?meta_ads_error=declined');
    if (!q.code || !q.state) return redirect('/integrations.html?meta_ads_error=invalid_response');

    let parsed: { flow?: string; userId?: string; csrf?: string };
    try {
        parsed = JSON.parse(Buffer.from(String(q.state), 'base64url').toString('utf8'));
    } catch {
        return redirect('/integrations.html?meta_ads_error=invalid_state');
    }
    // Only this flow's states. A posting-flow state must not redeem an ads token.
    if (parsed.flow !== 'meta_ads' || !parsed.userId || !parsed.csrf) {
        return redirect('/integrations.html?meta_ads_error=invalid_state');
    }
    const userId = Number(parsed.userId);
    if (!Number.isFinite(userId)) return redirect('/integrations.html?meta_ads_error=invalid_state');

    // ⚠️ THE PERSON FINISHING THE CONNECT MUST BE THE ONE WHO STARTED IT (security scan M1, 28 Nov 2026).
    // Otherwise someone could start an ads connect, send Meta's consent link to another person, and
    // that person's ad accounts would be saved into the sender's workspace (who could then spend as
    // them). The session cookie is SameSite=Lax, so it rides on Meta's top-level GET redirect.
    // Checked before the CSRF entry is read or burned, so a stranger's visit can't use it up.
    const session = requireSession(event);
    if ('error' in session) return redirect('/integrations.html?meta_ads_error=invalid_session');
    if (session.userId !== userId) return redirect('/integrations.html?meta_ads_error=invalid_state');

    const db = getDb();
    const stored = await getSecret(db, metaAdsCsrfKey(userId)) as
        { csrf?: string; expiresAt?: number; organisationId?: string } | null;
    if (!stored?.csrf || stored.csrf !== parsed.csrf) return redirect('/integrations.html?meta_ads_error=invalid_state');
    if (!stored.expiresAt || Date.now() > Number(stored.expiresAt)) {
        await deleteSecret(db, metaAdsCsrfKey(userId));
        return redirect('/integrations.html?meta_ads_error=expired');
    }
    const organisationId = Number(stored.organisationId);
    if (!Number.isFinite(organisationId)) return redirect('/integrations.html?meta_ads_error=invalid_state');
    // Still a member of the workspace the connect was started in (removed in the 10 minutes since = refused).
    if (!(await requireOrgMembership(db, userId, organisationId))) {
        await deleteSecret(db, metaAdsCsrfKey(userId));
        return redirect('/integrations.html?meta_ads_error=invalid_state');
    }
    // One-time use: burned before the exchange so a replayed callback cannot mint a second token.
    await deleteSecret(db, metaAdsCsrfKey(userId));

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) return redirect('/integrations.html?meta_ads_error=not_configured');

    const ver = metaAdsGraphVersion();
    // Byte-identical to the one init sent, or Meta refuses the exchange.
    const callbackUri = `${baseUrl}${metaAdsCallbackPath}`;

    let longLived: string;
    let expiresIn: number | null = null;
    try {
        const short = await fetch(`https://graph.facebook.com/${ver}/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: appId, client_secret: appSecret, redirect_uri: callbackUri, code: String(q.code),
            }).toString(),
        });
        if (!short.ok) {
            // ⚠️ Status only, never the body — a token response can carry credentials.
            console.error(`[meta-ads-oauth] code exchange failed: ${short.status}`);
            return redirect('/integrations.html?meta_ads_error=exchange_failed');
        }
        const shortData = await short.json() as { access_token?: string };
        if (!shortData.access_token) return redirect('/integrations.html?meta_ads_error=exchange_failed');

        // A user token lasts hours; the long-lived one ~60 days. Without this the connection would
        // die overnight and the optimiser would lose control of a live campaign by morning.
        const long = await fetch(`https://graph.facebook.com/${ver}/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret,
                fb_exchange_token: shortData.access_token,
            }).toString(),
        });
        if (!long.ok) {
            console.error(`[meta-ads-oauth] long-lived exchange failed: ${long.status}`);
            return redirect('/integrations.html?meta_ads_error=exchange_failed');
        }
        const longData = await long.json() as { access_token?: string; expires_in?: number };
        if (!longData.access_token) return redirect('/integrations.html?meta_ads_error=exchange_failed');
        longLived = longData.access_token;
        expiresIn = typeof longData.expires_in === 'number' ? longData.expires_in : null;
    } catch (err) {
        console.error(`[meta-ads-oauth] exchange threw: ${err instanceof Error ? err.message : String(err)}`);
        return redirect('/integrations.html?meta_ads_error=exchange_failed');
    }

    const [accounts, pages, granted] = await Promise.all([
        fetchMetaAdAccounts(longLived),
        fetchMetaPages(longLived),
        fetchGrantedPermissions(longLived),
    ]);

    const refKey = `aura/org-${organisationId}/meta_ads-oauth`;
    await storeSecret(db, refKey, { token: longLived });

    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    // What the person actually GRANTED (Meta lets them untick permissions), falling back to what we
    // asked for only when Meta would not say. metaAdsCreateProblem reads this.
    const scopes = granted ? granted.join(',') : metaAdsScopes();

    const [existing] = await db.select({ id: systemConnections.id, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, META_ADS_SERVICE_NAME),
        ))
        .limit(1);

    // ⚠️ KEEP the previous choices when they are still available. LinkedIn's reconnect wiped the
    // chosen ad account (2026-11-18 live run), making the user pick it again after every reconnect.
    const prev = (existing?.metadata ?? {}) as Record<string, unknown>;
    // ⚠️ A FAILED listing (null) keeps the previous list and choice. Wiping them would make the
    // connection read "not ready", and the optimiser would then halt a LIVE Meta campaign without the
    // adapter — paused here, still spending on Meta (review on e4fb6828). Only a SUCCESSFUL listing
    // that no longer contains the old choice may clear it.
    const prevAccounts = Array.isArray(prev.adAccounts) ? prev.adAccounts as typeof accounts : null;
    const prevPages = Array.isArray(prev.pages) ? prev.pages as typeof pages : null;
    const accountList = accounts ?? prevAccounts;
    const pageList = pages ?? prevPages;
    const keepAccount = typeof prev.selectedAccountId === 'string' && accountList?.some((a) => a.id === prev.selectedAccountId)
        ? prev.selectedAccountId as string : null;
    const keepPage = typeof prev.selectedPageId === 'string' && pageList?.some((p) => p.id === prev.selectedPageId)
        ? prev.selectedPageId as string : null;

    const metadata = {
        adAccounts: accountList,       // null = could not ask (and nothing earlier); [] = none
        pages: pageList,               // null = could not ask (and nothing earlier); [] = none
        selectedAccountId: keepAccount,
        // One Page and no previous choice: there is nothing to choose between.
        selectedPageId: keepPage ?? (pageList && pageList.length === 1 ? pageList[0].id : null),
        access: 'standard',            // app-role holders only until App Review grants Advanced
    };

    if (existing) {
        await db.update(systemConnections).set({
            vaultRefKey: refKey, tokenExpiresAt, status: 'active', isActive: true,
            scopes, metadata, updatedAt: new Date(),
        }).where(eq(systemConnections.id, existing.id));
    } else {
        await db.insert(systemConnections).values({
            organisationId, userId, serviceName: META_ADS_SERVICE_NAME, connectionType: 'oauth',
            vaultRefKey: refKey, tokenExpiresAt, status: 'active', isActive: true,
            scopes, metadata,
        });
    }

    await db.insert(auditLogs).values({
        actionType: existing ? 'meta_ads_reconnected' : 'meta_ads_connected',
        resourceType: 'system_connections',
        resourceId: String(organisationId),
        newState: { organisationId, accountsFound: accounts?.length ?? null, pagesFound: pages?.length ?? null },
    });

    const a = accounts === null ? 'unknown' : String(accounts.length);
    const p = pages === null ? 'unknown' : String(pages.length);
    return redirect(`/integrations.html?meta_ads_connected=1&meta_ads_accounts=${a}&meta_ads_pages=${p}`);
});
