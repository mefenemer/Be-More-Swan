// netlify/functions/mailbox-oauth.ts — connect a mailbox to the Email Assistant (docs/email-assistant-plan.md §3).
//
//   GET /api/mailbox-oauth/{outlook|gmail}/connect?assistantId=N   → Microsoft / Google consent screen
//   GET /api/mailbox-oauth/{outlook|gmail}/callback                → code → token, mailbox row, first sync
//
// Separate from oauth-integrations.ts on purpose: that writes workspace_integrations (one row per
// workspace per provider, visible to every admin). A mailbox is ONE person's (src/utils/mailboxes.ts).
//
// Security, as oauth-integrations: the CSRF token and the workspace are held SERVER-SIDE in the vault
// for 10 minutes; `state` carries only routing hints and is never trusted for anything else. On top of
// that, the callback must be finished by the same signed-in person who started it.
//
// ⚠️ Each callback URL must be registered before it works, for staging and prod (release checklist):
//   Outlook: <site>/api/mailbox-oauth/outlook/callback — the Azure app's Web redirect URIs.
//   Gmail:   <site>/api/mailbox-oauth/gmail/callback   — the "Be More Swan Mail" Google project's OAuth
//            client (GMAIL_MAIL_CLIENT_ID), NEVER the approved send-only project (GMAIL_CLIENT_ID).
//
// Gmail's scope is restricted: until Google approves the mail project, only its listed test users can
// connect, and Google shows an "unverified app" screen first.

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
    EMAIL_ASSISTANT_FLAG, GMAIL_MAILBOX_SCOPE, OUTLOOK_MAILBOX_SCOPE, gmailMailboxConfigured, newMailboxVaultKey, storeMailboxToken,
} from '../../src/utils/mailboxes';
import { triggerMailboxSync } from '../../src/utils/mailbox-sync';

const CSRF_TTL_MS = 10 * 60 * 1000;
type MailProvider = 'outlook' | 'gmail';
const PROVIDERS: readonly MailProvider[] = ['outlook', 'gmail'];

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
    // view=assistant-detail is what makes workspace.html open the assistant (and its Emails tab); without
    // it the page showed the Dashboard and the outcome was lost.
    return id ? `/workspace.html?view=assistant-detail&assistantId=${id}&tab=datahub&${q}` : `/integrations.html?${q}`;
}

/**
 * The provider's error on the callback, as one of our codes. Pure.
 *   Microsoft: access_denied + AADSTS65001 / "admin" → the tenant needs an admin to approve the app.
 *   Google:    admin_policy_enforced → a Google Workspace admin blocks apps asking for Gmail access.
 */
export function mailboxConsentError(error: string, description: string | undefined): string {
    const d = (description ?? '').toLowerCase();
    if (error === 'admin_policy_enforced' || /aadsts90094|aadsts65001|aadsts90008|admin/.test(d)) return 'admin_approval_needed';
    if (error === 'access_denied') return 'access_denied';
    return 'provider_error';
}

/** The consent URL for a provider. Pure (given the client id). */
export function mailboxAuthUrl(provider: MailProvider, clientId: string, redirectUri: string, state: string): string {
    if (provider === 'gmail') {
        // access_type=offline + prompt=consent: Google only returns a refresh token on a consent screen.
        // select_account: someone signed in to several Google accounts picks the right mailbox.
        return `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}`
            + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(GMAIL_MAILBOX_SCOPE)}`
            + `&access_type=offline&prompt=${encodeURIComponent('consent select_account')}&include_granted_scopes=true&state=${state}`;
    }
    // prompt=select_account: someone signed in to several Microsoft accounts picks the right mailbox.
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(OUTLOOK_MAILBOX_SCOPE)}`
        + `&response_mode=query&prompt=select_account&state=${state}`;
}

/** Did the provider GRANT what reading needs (the grant, not our request)? Pure. */
export function grantCoversReading(provider: MailProvider, grantedScope: string | undefined): boolean {
    const g = (grantedScope ?? '').toLowerCase();
    return provider === 'gmail' ? g.includes('https://www.googleapis.com/auth/gmail.modify') : g.includes('mail.readwrite');
}

function clientIdFor(provider: MailProvider): string | null {
    if (provider === 'gmail') return gmailMailboxConfigured() ? process.env.GMAIL_MAIL_CLIENT_ID ?? null : null;
    return process.env.OUTLOOK_CLIENT_ID ?? null;
}

interface Exchanged { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null; address: string; displayName: string | null }

/** Code → token → the mailbox's address. A string is an error code for the return URL. */
async function exchangeCode(provider: MailProvider, code: string, redirectUri: string): Promise<Exchanged | string> {
    if (provider === 'gmail') {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code', code, redirect_uri: redirectUri,
                client_id: process.env.GMAIL_MAIL_CLIENT_ID ?? '', client_secret: process.env.GMAIL_MAIL_CLIENT_SECRET ?? '',
            }),
        });
        const t: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await res.json().catch(() => ({}));
        if (!t.access_token) return 'token_exchange';
        if (!grantCoversReading('gmail', t.scope)) return 'scope_missing';
        // The address from Gmail itself: it is the mailbox we will read, whatever the Google account's name.
        const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${t.access_token}` } }).catch(() => null);
        const p: { emailAddress?: string } = prof?.ok ? await prof.json().catch(() => ({})) : {};
        const address = (p.emailAddress ?? '').trim();
        if (!address) return 'no_address';
        return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, scope: t.scope ?? null, address, displayName: null };
    }

    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: OUTLOOK_MAILBOX_SCOPE,
            client_id: process.env.OUTLOOK_CLIENT_ID ?? '', client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? '',
        }),
    });
    const t: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await res.json().catch(() => ({}));
    if (!t.access_token) return 'token_exchange';
    if (!grantCoversReading('outlook', t.scope)) return 'scope_missing';
    // userPrincipalName, not `mail`: `mail` is null on many personal and unlicensed accounts.
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
        headers: { Authorization: `Bearer ${t.access_token}` },
    }).catch(() => null);
    const me: { mail?: string | null; userPrincipalName?: string; displayName?: string } = meRes?.ok ? await meRes.json().catch(() => ({})) : {};
    const address = (me.mail ?? me.userPrincipalName ?? '').trim();
    if (!address) return 'no_address';
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, scope: t.scope ?? null, address, displayName: me.displayName ?? null };
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
    const { provider: rawProvider, action } = resolveRoute(event);
    if (!PROVIDERS.includes(rawProvider as MailProvider)) return redirect(mailboxReturnUrl(null, { error: 'unsupported_provider' }));
    const provider = rawProvider as MailProvider;
    const redirectUri = `${baseUrl}/api/mailbox-oauth/${provider}/callback`;

    if (action === 'connect') {
        // mutates: a connect start is refused under impersonation, like a POST.
        const ctx = await requireTenant(event, db, { mutates: true });
        const assistantId = event.queryStringParameters?.assistantId ?? null;
        if ('error' in ctx) return redirect(mailboxReturnUrl(assistantId, { error: 'invalid_session' }));
        if (!(await isFeatureEnabled(ctx.organisationId, EMAIL_ASSISTANT_FLAG))) {
            return redirect(mailboxReturnUrl(assistantId, { error: 'not_available' }));
        }
        const clientId = clientIdFor(provider);
        if (!clientId) return redirect(mailboxReturnUrl(assistantId, { error: 'not_configured' }));

        const csrf = randomBytes(32).toString('hex');
        await storeSecret(db as never, `mailbox_csrf:${ctx.userId}:${provider}`, {
            csrf, expiresAt: Date.now() + CSRF_TTL_MS, organisationId: String(ctx.organisationId),
        });
        const state = encodeState({ userId: String(ctx.userId), provider, csrf, ...(assistantId && /^\d+$/.test(assistantId) ? { assistantId } : {}) });
        return redirect(mailboxAuthUrl(provider, clientId, redirectUri, state));
    }

    if (action === 'callback') {
        const qp = event.queryStringParameters ?? {};
        const st = qp.state ? decodeState(qp.state) : null;
        const assistantId = st?.assistantId ?? null;
        if (qp.error) {
            console.error(`[mailbox-oauth ${provider}] consent returned error=${qp.error}${qp.error_description ? ` (${qp.error_description.slice(0, 200)})` : ''}`);
            return redirect(mailboxReturnUrl(assistantId, { error: mailboxConsentError(qp.error, qp.error_description) }));
        }
        if (!qp.code || !st?.userId || !st?.csrf || st.provider !== provider) return redirect(mailboxReturnUrl(assistantId, { error: 'missing_params' }));

        // The person finishing must be the person who started: a consent link forwarded to someone
        // else must not attach THEIR mailbox to the starter's account, or the reverse.
        const ctx = await requireTenant(event, db, { mutates: true });
        if ('error' in ctx || String(ctx.userId) !== st.userId) return redirect(mailboxReturnUrl(assistantId, { error: 'csrf_fail' }));

        const csrfKey = `mailbox_csrf:${ctx.userId}:${provider}`;
        const stored = await getSecret(db as never, csrfKey).catch(() => null) as { csrf?: string; expiresAt?: number; organisationId?: string } | null;
        await deleteSecret(db as never, csrfKey).catch(() => undefined);
        if (!stored || stored.csrf !== st.csrf || !stored.expiresAt || Date.now() > stored.expiresAt
            || Number(stored.organisationId) !== ctx.organisationId) {
            return redirect(mailboxReturnUrl(assistantId, { error: 'csrf_fail' }));
        }

        const got = await exchangeCode(provider, qp.code, redirectUri);
        if (typeof got === 'string') return redirect(mailboxReturnUrl(assistantId, { error: got }));

        // Reconnecting the same mailbox reuses its row (and its sorted email); a new one gets its own vault key.
        const [existing] = await db.select({ id: mailboxes.id, vaultRefKey: mailboxes.vaultRefKey }).from(mailboxes)
            .where(and(eq(mailboxes.organisationId, ctx.organisationId), eq(mailboxes.userId, ctx.userId),
                eq(mailboxes.provider, provider), sql`lower(${mailboxes.address}) = lower(${got.address})`)).limit(1);
        const token = { accessToken: got.accessToken, refreshToken: got.refreshToken, expiresAt: got.expiresAt };
        let mailboxId: number;
        if (existing) {
            // Google sends a refresh token only on a consent screen; never overwrite a good one with null.
            if (!token.refreshToken) {
                const prev = await getSecret(db as never, existing.vaultRefKey).catch(() => null) as { refreshToken?: string | null } | null;
                token.refreshToken = prev?.refreshToken ?? null;
            }
            await storeMailboxToken(db, existing.vaultRefKey, token);
            await db.update(mailboxes).set({
                status: 'active', lastError: null, scopes: got.scope, displayName: got.displayName, updatedAt: new Date(),
            }).where(eq(mailboxes.id, existing.id));
            mailboxId = existing.id;
        } else {
            const vaultRefKey = newMailboxVaultKey();
            await storeMailboxToken(db, vaultRefKey, token);
            const [row] = await db.insert(mailboxes).values({
                organisationId: ctx.organisationId, userId: ctx.userId, provider, address: got.address,
                displayName: got.displayName, kind: 'business', grantLevel: 'inbox', vaultRefKey, scopes: got.scope,
            }).returning({ id: mailboxes.id });
            mailboxId = row.id;
        }

        // First sort starts now in the background; the Emails tab shows it filling in.
        await triggerMailboxSync(mailboxId).catch((err) => console.error('[mailbox-oauth] first sync trigger failed', err));
        return redirect(mailboxReturnUrl(assistantId, { ok: true }));
    }

    return { statusCode: 404, body: JSON.stringify({ error: 'Unknown action.' }) };
});
