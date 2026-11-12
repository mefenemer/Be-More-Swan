// netlify/functions/mailbox-oauth.ts — connect a mailbox to the Email Assistant (docs/email-assistant-plan.md §3).
//
//   GET /api/mailbox-oauth/outlook/connect?assistantId=N   → Microsoft consent screen
//   GET /api/mailbox-oauth/outlook/callback                → code → token, mailbox row, first sync
//
// Separate from oauth-integrations.ts on purpose: that writes workspace_integrations (one row per
// workspace per provider, visible to every admin). A mailbox is ONE person's (src/utils/mailboxes.ts).
//
// Security, as oauth-integrations: the CSRF token and the workspace are held SERVER-SIDE in the vault
// for 10 minutes; `state` carries only routing hints and is never trusted for anything else. On top of
// that, the callback must be finished by the same signed-in person who started it.
//
// ⚠️ The callback URL (<site>/api/mailbox-oauth/outlook/callback) must be added to the Azure app's
// redirect URIs, for staging and prod, before this works (release checklist).
//
// Phase 1: Outlook only, business mailboxes only. Gmail waits for Google's review (plan Phase 3).

import { randomBytes } from 'crypto';
import { withLambda } from '@netlify/aws-lambda-compat';
import type { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { mailboxes } from '../../db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import { deleteSecret, getSecret, storeSecret } from '../../src/utils/vault';
import { isFeatureEnabled } from '../../src/utils/feature-flags';
import {
    EMAIL_ASSISTANT_FLAG, OUTLOOK_MAILBOX_SCOPE, newMailboxVaultKey, storeMailboxToken,
} from '../../src/utils/mailboxes';
import { triggerMailboxSync } from '../../src/utils/mailbox-sync';

const CSRF_TTL_MS = 10 * 60 * 1000;

function redirect(location: string) {
    return { statusCode: 302, headers: { Location: location }, body: '' };
}

function encodeState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeState(raw: string): Record<string, string> | null {
    try { return JSON.parse(Buffer.from(raw, 'base64url').toString()); } catch { return null; }
}

/** Where to land afterwards. assistantId is re-validated as a positive integer; nothing else from state is echoed. */
export function mailboxReturnUrl(assistantId: string | null | undefined, outcome: { ok: true } | { error: string }): string {
    const id = assistantId && /^\d+$/.test(assistantId) && Number(assistantId) > 0 ? assistantId : null;
    const q = 'ok' in outcome ? 'mailbox=connected' : `mailbox_error=${encodeURIComponent(outcome.error)}`;
    return id ? `/workspace.html?assistantId=${id}&tab=datahub&${q}` : `/integrations.html?${q}`;
}

/**
 * Microsoft's error on the callback, as one of our codes. Pure.
 *   access_denied + AADSTS65001 / "admin" → the tenant needs an admin to approve the app (plan §3.2).
 */
export function mailboxConsentError(error: string, description: string | undefined): string {
    const d = (description ?? '').toLowerCase();
    if (/aadsts90094|aadsts65001|aadsts90008|admin/.test(d)) return 'admin_approval_needed';
    if (error === 'access_denied') return 'access_denied';
    return 'provider_error';
}

function resolveRoute(event: HandlerEvent): { provider: string | null; action: string | null } {
    const qp = event.queryStringParameters ?? {};
    let provider = qp.provider ?? null;
    let action = qp.action ?? null;
    try {
        const m = new URL(event.rawUrl).pathname.match(/\/api\/mailbox-oauth\/([a-z]+)\/([a-z]+)\/?$/i);
        if (m) { provider = m[1]; action = m[2]; }
    } catch { /* direct invocation */ }
    return { provider, action };
}

export default withLambda(async (event) => {
    const db = getDb();
    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    const { provider, action } = resolveRoute(event);
    if (provider !== 'outlook') return redirect(mailboxReturnUrl(null, { error: 'unsupported_provider' }));
    const redirectUri = `${baseUrl}/api/mailbox-oauth/outlook/callback`;

    if (action === 'connect') {
        // mutates: a connect start is refused under impersonation, like a POST.
        const ctx = await requireTenant(event, db, { mutates: true });
        const assistantId = event.queryStringParameters?.assistantId ?? null;
        if ('error' in ctx) return redirect(mailboxReturnUrl(assistantId, { error: 'invalid_session' }));
        if (!(await isFeatureEnabled(ctx.organisationId, EMAIL_ASSISTANT_FLAG))) {
            return redirect(mailboxReturnUrl(assistantId, { error: 'not_available' }));
        }
        const clientId = process.env.OUTLOOK_CLIENT_ID;
        if (!clientId) return redirect(mailboxReturnUrl(assistantId, { error: 'not_configured' }));

        const csrf = randomBytes(32).toString('hex');
        await storeSecret(db as never, `mailbox_csrf:${ctx.userId}`, {
            csrf, expiresAt: Date.now() + CSRF_TTL_MS, organisationId: String(ctx.organisationId),
        });
        const state = encodeState({ userId: String(ctx.userId), csrf, ...(assistantId && /^\d+$/.test(assistantId) ? { assistantId } : {}) });
        // prompt=select_account: someone signed in to several Microsoft accounts picks the right mailbox.
        const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`
            + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(OUTLOOK_MAILBOX_SCOPE)}`
            + `&response_mode=query&prompt=select_account&state=${state}`;
        return redirect(authUrl);
    }

    if (action === 'callback') {
        const qp = event.queryStringParameters ?? {};
        const st = qp.state ? decodeState(qp.state) : null;
        const assistantId = st?.assistantId ?? null;
        if (qp.error) {
            console.error(`[mailbox-oauth outlook] consent returned error=${qp.error}${qp.error_description ? ` (${qp.error_description.slice(0, 200)})` : ''}`);
            return redirect(mailboxReturnUrl(assistantId, { error: mailboxConsentError(qp.error, qp.error_description) }));
        }
        if (!qp.code || !st?.userId || !st?.csrf) return redirect(mailboxReturnUrl(assistantId, { error: 'missing_params' }));

        // The person finishing must be the person who started: a consent link forwarded to someone
        // else must not attach THEIR mailbox to the starter's account, or the reverse.
        const ctx = await requireTenant(event, db, { mutates: true });
        if ('error' in ctx || String(ctx.userId) !== st.userId) return redirect(mailboxReturnUrl(assistantId, { error: 'csrf_fail' }));

        const csrfKey = `mailbox_csrf:${ctx.userId}`;
        const stored = await getSecret(db as never, csrfKey).catch(() => null) as { csrf?: string; expiresAt?: number; organisationId?: string } | null;
        await deleteSecret(db as never, csrfKey).catch(() => undefined);
        if (!stored || stored.csrf !== st.csrf || !stored.expiresAt || Date.now() > stored.expiresAt
            || Number(stored.organisationId) !== ctx.organisationId) {
            return redirect(mailboxReturnUrl(assistantId, { error: 'csrf_fail' }));
        }

        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: process.env.OUTLOOK_CLIENT_ID ?? '',
                client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? '',
                redirect_uri: redirectUri,
                scope: OUTLOOK_MAILBOX_SCOPE,
                code: qp.code,
            }),
        });
        const token: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
        if (!token.access_token) return redirect(mailboxReturnUrl(assistantId, { error: 'token_exchange' }));

        // Without Mail.ReadWrite in the GRANT (not our request) the mailbox can't be read.
        const granted = (token.scope ?? '').toLowerCase();
        if (!granted.includes('mail.readwrite')) return redirect(mailboxReturnUrl(assistantId, { error: 'scope_missing' }));

        // userPrincipalName, not `mail`: `mail` is null on many personal and unlicensed accounts.
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
            headers: { Authorization: `Bearer ${token.access_token}` },
        }).catch(() => null);
        const me: { mail?: string | null; userPrincipalName?: string; displayName?: string } = meRes?.ok ? await meRes.json().catch(() => ({})) : {};
        const address = (me.mail ?? me.userPrincipalName ?? '').trim();
        if (!address) return redirect(mailboxReturnUrl(assistantId, { error: 'no_address' }));

        const expiresAt = token.expires_in ? Date.now() + token.expires_in * 1000 : null;
        // Reconnecting the same mailbox reuses its row (and its sorted email); a new one gets its own vault key.
        const [existing] = await db.select({ id: mailboxes.id, vaultRefKey: mailboxes.vaultRefKey }).from(mailboxes)
            .where(and(eq(mailboxes.organisationId, ctx.organisationId), eq(mailboxes.userId, ctx.userId),
                eq(mailboxes.provider, 'outlook'), sql`lower(${mailboxes.address}) = lower(${address})`)).limit(1);
        let mailboxId: number;
        if (existing) {
            await storeMailboxToken(db, existing.vaultRefKey, { accessToken: token.access_token, refreshToken: token.refresh_token ?? null, expiresAt });
            await db.update(mailboxes).set({
                status: 'active', lastError: null, scopes: token.scope ?? null, displayName: me.displayName ?? null, updatedAt: new Date(),
            }).where(eq(mailboxes.id, existing.id));
            mailboxId = existing.id;
        } else {
            const vaultRefKey = newMailboxVaultKey();
            await storeMailboxToken(db, vaultRefKey, { accessToken: token.access_token, refreshToken: token.refresh_token ?? null, expiresAt });
            const [row] = await db.insert(mailboxes).values({
                organisationId: ctx.organisationId, userId: ctx.userId, provider: 'outlook', address,
                displayName: me.displayName ?? null, kind: 'business', grantLevel: 'inbox', vaultRefKey, scopes: token.scope ?? null,
            }).returning({ id: mailboxes.id });
            mailboxId = row.id;
        }

        // First sort starts now in the background; the Emails tab shows it filling in.
        await triggerMailboxSync(mailboxId).catch((err) => console.error('[mailbox-oauth] first sync trigger failed', err));
        return redirect(mailboxReturnUrl(assistantId, { ok: true }));
    }

    return { statusCode: 404, body: JSON.stringify({ error: 'Unknown action.' }) };
});
