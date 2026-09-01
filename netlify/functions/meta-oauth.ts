// netlify/functions/meta-oauth.ts
// US-SMM-3.2.1: Meta OAuth flow for Instagram Business/Creator accounts.
// GET ?action=start  — redirects to Meta OAuth dialog
// GET ?action=callback — exchanges code, validates, stores token in vault, upserts system_connections

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { createHmac, randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { systemConnections, users, auditLogs, userOrganisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { storeSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { restoreConnectionDependents } from '../../src/utils/connection-recovery';
import { findTenantCollision, recordCollisionAttempt } from '../../src/utils/connection-collision';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret   = process.env.JWT_SECRET!;
const metaAppId   = process.env.META_APP_ID!;
const metaSecret  = process.env.META_APP_SECRET!;
// pages_show_list is what permits /me/accounts to enumerate the user's Pages — without it the
// Instagram account behind the Page can never be discovered.
// business_management lets us fall back to enumerating Pages via the user's Business portfolios:
// /me/accounts only lists Pages a user administers DIRECTLY, so a Page owned by a Business/Meta
// portfolio is invisible there and its Instagram account can never be found without this scope.
// NOTE: business_management is an advanced permission — it works immediately for app admins/testers
// and in Development mode, but requires Meta App Review before general (Live-mode) users can grant it.
const SCOPES      = 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging,pages_manage_posts,business_management';
const TOKEN_TTL_DAYS = 60;

function csrfToken(): string {
    return randomBytes(32).toString('hex');
}

function signState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseState(state: string): Record<string, string> | null {
    try {
        return JSON.parse(Buffer.from(state, 'base64url').toString());
    } catch { return null; }
}

function validateStateCsrf(state: Record<string, string>, stored: string): boolean {
    return createHmac('sha256', jwtSecret).update(state.csrf ?? '').digest('hex') === stored;
}

export default withLambda(async (event) => {
    const action = event.queryStringParameters?.action;

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    const REDIRECT_URI = process.env.META_REDIRECT_URI ?? `${baseUrl}/.netlify/functions/meta-oauth?action=callback`;

    // ── START: redirect to Meta OAuth ─────────────────────────────────────────
    if (action === 'start') {
        // Without an app id we'd send the user to Facebook with `client_id=undefined` and they'd
        // land on Meta's own error page. Degrade to the same friendly not_configured banner
        // LinkedIn/X already use (social-oauth-init.ts). `platform` drives the message label —
        // Instagram connects through Facebook, so honour the caller's platform when given.
        if (!metaAppId || !metaSecret) {
            const platform = event.queryStringParameters?.platform === 'instagram' ? 'instagram' : 'facebook';
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=not_configured&platform=${platform}` }, body: '' };
        }
        // Session carries `activeOrganisationId`, not `organisationId` — resolve via requireTenant
        // (re-verifies current membership) rather than reading the JWT claim directly.
        const ctx = await requireTenant(event, getDb());
        if ('error' in ctx) return ctx.error;
        const { organisationId, userId } = ctx;

        const assistantId = event.queryStringParameters?.assistantId;
        // Carry the platform the user clicked (Instagram connects through Facebook) so an error
        // redirect can label the toast correctly and route back to the right Connections tab.
        const platform = event.queryStringParameters?.platform === 'instagram' ? 'instagram' : 'facebook';
        const csrf = csrfToken();
        const csrfHmac = createHmac('sha256', jwtSecret).update(csrf).digest('hex');
        // `userId` rides in the state for the same reason `organisationId` does: the callback is a
        // top-level redirect back from Meta and cannot rely on the session cookie being present.
        // Without it the stored connection had NO owner — and `user_id IS NULL` is the sentinel
        // integrations.ts uses for a global catalog row, so every Facebook/Instagram connection
        // was served to every workspace as an unconnected "platform definition".
        const state = signState({ organisationId: String(organisationId), userId: String(userId), assistantId: assistantId ?? '', platform, csrf, csrfHmac });

        const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${metaAppId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}&state=${state}&response_type=code`;

        return { statusCode: 302, headers: { Location: url }, body: '' };
    }

    // ── CALLBACK: exchange code, validate, store ───────────────────────────────
    if (action === 'callback') {
        const { code, state: rawState, error } = event.queryStringParameters ?? {};

        if (error) {
            // Best-effort route hint so a cancel also lands back on the Connections tab (state is not
            // yet CSRF-validated, but it's only used to pick which page to show).
            const s = rawState ? parseState(rawState) : null;
            const plat = s?.platform === 'instagram' ? 'instagram' : 'facebook';
            const aId = s?.assistantId ? `&assistantId=${parseInt(s.assistantId)}` : '';
            return { statusCode: 302, headers: { Location: `/workspace.html?meta_error=access_denied&platform=${plat}${aId}` }, body: '' };
        }
        if (!code || !rawState) {
            return { statusCode: 400, body: 'Missing code or state' };
        }

        const state = parseState(rawState);
        if (!state) return { statusCode: 400, body: 'Invalid state parameter' };

        // Validate CSRF
        const expectedHmac = createHmac('sha256', jwtSecret).update(state.csrf ?? '').digest('hex');
        if (expectedHmac !== state.csrfHmac) {
            await getDb().insert(auditLogs).values({ actionType: 'meta_oauth_csrf_fail', resourceType: 'system_connections', resourceId: 'csrf', newState: { state } });
            return { statusCode: 400, body: JSON.stringify({ error: 'Security error: invalid state. Flow aborted.' }) };
        }

        const organisationId = parseInt(state.organisationId);
        const stateUserId   = state.userId ? parseInt(state.userId) : null;
        const assistantId   = state.assistantId ? parseInt(state.assistantId) : null;
        const platform      = state.platform === 'instagram' ? 'instagram' : 'facebook';

        // Build an error redirect that keeps the user on the assistant's Connections tab (not the
        // Dashboard) and labels the toast for the platform they were connecting. workspace.html reads
        // assistantId + platform to route back and colour the message.
        const metaErr = (code: string) =>
            `/workspace.html?meta_error=${code}&platform=${platform}` +
            (assistantId ? `&assistantId=${assistantId}` : '');

        // Connection sandboxing: if this connect was initiated for a specific
        // assistant, the platform being connected must be relevant to that assistant's role.
        if (assistantId) {
            const assistant = await resolveAssistantRole(getDb(), organisationId, assistantId);
            if (!assistant || !isServiceAllowedForAssistant(platform, assistant)) {
                return { statusCode: 302, headers: { Location: metaErr('connection_not_relevant') }, body: '' };
            }
        }

        // Exchange short-lived code for long-lived token
        const tokenRes = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${metaAppId}&client_secret=${metaSecret}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
        );
        const tokenData: { access_token?: string; error?: { message: string } } = await tokenRes.json();
        if (!tokenData.access_token) {
            // Redirect back to the workspace toast rather than dumping raw JSON at the user.
            return { statusCode: 302, headers: { Location: metaErr('token_exchange') }, body: '' };
        }

        // Exchange for 60-day long-lived token
        const llRes = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${metaAppId}&client_secret=${metaSecret}&fb_exchange_token=${tokenData.access_token}`
        );
        const llData: { access_token?: string; expires_in?: number; error?: { message: string } } = await llRes.json();
        if (!llData.access_token) {
            return { statusCode: 302, headers: { Location: metaErr('token_exchange') }, body: '' };
        }
        const longLivedToken = llData.access_token;

        // Meta's deauthorize/delete callbacks identify the person by their APP-SCOPED USER ID and
        // nothing else. We key connections on the Page id (facebook) or the Instagram business
        // account id (instagram) — neither of which Meta sends — so without this stored on the row
        // there is no join back from a "delete my data" callback to the connection it must revoke.
        // Captured here, while the token is definitely valid: by the time a deletion callback
        // fires the grant is already gone and /me would fail.
        let fbUserId: string | null = null;
        try {
            const meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id&access_token=${longLivedToken}`);
            const me: { id?: string; error?: { message: string } } = await meRes.json();
            fbUserId = me.id ?? null;
            if (!fbUserId) console.error('[meta-oauth] /me returned no id:', me.error?.message ?? 'unknown');
        } catch (e) {
            console.error('[meta-oauth] /me lookup failed — deletion callbacks cannot match this row:', e);
        }

        // Resolve the Instagram account via the user's PAGES.
        //
        // `instagram_business_account` is an edge on the Page node, not on the User node — asking
        // /me for it always returned undefined, so every connect fell straight through to
        // `not_business` no matter how the user's Instagram was set up. Same for `account_type`,
        // which is an Instagram-node field and never present on a Facebook User.
        type IgPage = { id: string; name?: string; instagram_business_account?: { id: string; username?: string } };

        const pagesRes = await fetch(
            `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${longLivedToken}`
        );
        const pages: { data?: IgPage[]; error?: { message: string } } = await pagesRes.json();

        if (pages.error) {
            console.error('[meta-oauth] /me/accounts failed:', pages.error.message);
            return { statusCode: 302, headers: { Location: metaErr('token_exchange') }, body: '' };
        }

        // Distinguish the two failure modes — they have completely different remedies, and
        // reporting both as "not_business" sent users to fix an Instagram setting when the real
        // problem was that they never granted Page access on Meta's consent screen.
        const pageList: IgPage[] = pages.data ?? [];
        console.log(`[meta-oauth] /me/accounts returned ${pageList.length} page(s); ${pageList.filter(p => p.instagram_business_account?.id).length} with a linked Instagram account`);

        // Business/Meta-portfolio fallback. /me/accounts only lists Pages the user administers
        // DIRECTLY, so a Page owned by a Business portfolio (the now-default setup) never appears
        // above — its linked Instagram account is invisible and every connect dead-ends at no_pages.
        // When nothing here has a linked Instagram account, enumerate the user's businesses and their
        // owned + client Pages instead. Needs business_management (see SCOPES).
        let businessMgmtDenied = false;
        if (!pageList.some(p => p.instagram_business_account?.id)) {
            const bizRes = await fetch(`https://graph.facebook.com/v19.0/me/businesses?fields=id,name&access_token=${longLivedToken}`);
            const biz: { data?: Array<{ id: string; name?: string }>; error?: { message: string } } = await bizRes.json();
            if (biz.error) {
                // Almost always means business_management wasn't granted/approved. Record it so the
                // final diagnostic can point the user at the real fix rather than "no Pages".
                console.error('[meta-oauth] /me/businesses failed (business_management likely not granted):', biz.error.message);
                businessMgmtDenied = true;
            } else {
                const businesses = biz.data ?? [];
                console.log(`[meta-oauth] business fallback: scanning ${businesses.length} business(es) for portfolio-owned Pages`);
                const seen = new Set(pageList.map(p => p.id));
                for (const b of businesses) {
                    // owned_pages = Pages the business owns; client_pages = Pages shared into it.
                    for (const edge of ['owned_pages', 'client_pages'] as const) {
                        const r = await fetch(`https://graph.facebook.com/v19.0/${b.id}/${edge}?fields=id,name,instagram_business_account{id,username}&access_token=${longLivedToken}`);
                        const j: { data?: IgPage[]; error?: { message: string } } = await r.json();
                        if (j.error) { console.error(`[meta-oauth] ${edge} for business ${b.id} failed:`, j.error.message); continue; }
                        for (const p of j.data ?? []) {
                            if (!seen.has(p.id)) { seen.add(p.id); pageList.push(p); }
                        }
                    }
                }
                console.log(`[meta-oauth] after business fallback: ${pageList.length} page(s); ${pageList.filter(p => p.instagram_business_account?.id).length} with a linked Instagram account`);
            }
        }

        if (pageList.length === 0) {
            // A successful login that returns zero Pages is ambiguous — it has three distinct causes
            // with different remedies, and blaming "no Pages" for all of them is what makes this feel
            // broken to a user who *did* pick a Page on Meta's consent screen:
            //   1. the Page is owned by a Business/Meta portfolio (/me/accounts only lists Pages the
            //      user administers DIRECTLY, so portfolio Pages come back empty here);
            //   2. the per-permission `pages_show_list` toggle was declined (an empty list, not an error);
            //   3. the account genuinely administers no Page.
            // Ask Meta which permissions were actually granted so the logs — and the user-facing
            // message — reflect the real cause instead of always pointing at case 3.
            let pagesScopeGranted = true; // assume granted; only flip on positive evidence it wasn't
            try {
                const permRes = await fetch(`https://graph.facebook.com/v19.0/me/permissions?access_token=${longLivedToken}`);
                const perms: { data?: Array<{ permission: string; status: string }> } = await permRes.json();
                const granted = (perms.data ?? []).filter(p => p.status === 'granted').map(p => p.permission);
                const declined = (perms.data ?? []).filter(p => p.status !== 'granted').map(p => p.permission);
                console.log(`[meta-oauth] zero pages after successful auth — permissions granted=[${granted.join(',')}] declined=[${declined.join(',')}]`);
                // Only treat as "declined" when the endpoint actually answered and pages_show_list is
                // absent from the granted set; a failed lookup must not mislabel the cause.
                if (perms.data) pagesScopeGranted = granted.includes('pages_show_list');
            } catch (e) {
                console.error('[meta-oauth] /me/permissions lookup failed:', e);
            }

            // Pick the most specific, actionable cause:
            //   pages_permission   → the user withheld Page access on the consent screen.
            //   business_permission → Page access was granted but we couldn't read the user's Business
            //                         portfolios (business_management not granted/approved), so a
            //                         portfolio-owned Page stays invisible.
            //   no_pages           → everything was granted and even the business scan found nothing,
            //                         i.e. the account genuinely administers no Page anywhere.
            const cause = !pagesScopeGranted ? 'pages_permission'
                : businessMgmtDenied ? 'business_permission'
                : 'no_pages';
            return {
                statusCode: 302,
                headers: { Location: metaErr(cause) },
                body: '',
            };
        }

        // ── Resolve the target account for the product being connected ────────────────────
        // Instagram and Facebook are discovered from the same Meta Pages but store DIFFERENT
        // connections: Instagram keys on the linked IG account (and REQUIRES one); Facebook keys
        // on the Page itself and needs no linked Instagram. Publishing for both derives a Page
        // token from the stored long-lived user token (resolveFacebookPageCredentials /
        // publish-instagram), so the token model is identical — only the row differs.
        const db = getDb();

        let serviceName: 'instagram' | 'facebook';
        let externalUserId: string;          // the id the connection row is keyed on
        let fbPageId: string;                // the Facebook Page id (both products need a Page)
        let pageName: string | null = null;
        let igUsername: string | null = null;

        if (platform === 'instagram') {
            // Only a Business/Creator account can be linked to a Page as an
            // instagram_business_account, so the presence of the link IS the account-type check.
            const linkedPage = pageList.find(p => p.instagram_business_account?.id);
            if (!linkedPage) {
                return { statusCode: 302, headers: { Location: metaErr('not_business') }, body: '' };
            }
            serviceName = 'instagram';
            externalUserId = linkedPage.instagram_business_account!.id;
            igUsername = linkedPage.instagram_business_account!.username ?? null;
            fbPageId = linkedPage.id;        // the Page that owns the IG account
            pageName = linkedPage.name ?? null;
        } else {
            // Facebook needs only a Page. Prefer the Page that also carries the Instagram account
            // (so Facebook and Instagram align on one Page); otherwise the first Page shared.
            const fbPage = pageList.find(p => p.instagram_business_account?.id) ?? pageList[0];
            serviceName = 'facebook';
            externalUserId = fbPage.id;      // the connection is keyed on the Page id
            fbPageId = fbPage.id;
            pageName = fbPage.name ?? null;
            igUsername = fbPage.instagram_business_account?.username ?? null;
        }
        const accountType = 'BUSINESS';
        const connMetadata = { accountType, fbPageId, igUsername, pageName, fbUserId };

        // US1 AC1.3: block if this tenant is already live in a different workspace. Checked before
        // any token is persisted, so nothing is stored on rejection.
        // PARKED: findTenantCollision returns null unless ENFORCE_TENANT_COLLISION is set, so this
        // branch is dead by default. See src/utils/connection-collision.ts.
        const collision = await findTenantCollision(db, { serviceName, externalUserId, organisationId });
        if (collision) {
            await recordCollisionAttempt(db, { requestingOrgId: organisationId, existingOrgId: collision.organisationId, serviceName, externalUserId });
            return { statusCode: 302, headers: { Location: metaErr('tenant_collision') }, body: '' };
        }

        // Store token in vault — a separate ref per product so disconnecting one leaves the other's
        // token intact.
        const refKey = `aura/org-${organisationId}/${serviceName}-token`;
        await storeSecret(db, refKey, { token: longLivedToken });

        const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

        // The org's first member — the notification recipient below, and the owner of last resort
        // for a connection whose state predates `userId` riding in it (an OAuth flow already in
        // flight across this deploy). Resolved before the upsert because the row now needs it.
        const [orgUser] = await db.select({ id: users.id }).from(users).innerJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(userOrganisations.organisationId, organisationId)).limit(1);
        const connectionUserId = stateUserId ?? orgUser?.id ?? null;

        // Upsert system_connections — update existing if same external id, else create.
        const [existing] = await db
            .select({ id: systemConnections.id, userId: systemConnections.userId })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, organisationId),
                eq(systemConnections.serviceName, serviceName),
                eq(systemConnections.externalUserId, externalUserId),
            ))
            .limit(1);

        let isReconnect = false;
        if (existing) {
            isReconnect = true;
            await db.update(systemConnections).set({
                vaultRefKey: refKey,
                tokenExpiresAt,
                status: 'active',
                isActive: true,
                metadata: connMetadata,
                ...(assistantId ? { assistantId } : {}),
                // Heal a row stored before this was set, but never reassign one that already has an
                // owner: a teammate reconnecting a shared account must not take it over.
                ...(existing.userId == null && connectionUserId ? { userId: connectionUserId } : {}),
                updatedAt: new Date(),
            }).where(eq(systemConnections.id, existing.id));
        } else {
            await db.insert(systemConnections).values({
                organisationId,
                userId: connectionUserId,
                assistantId,
                serviceName,
                connectionType: 'oauth',
                externalUserId,
                vaultRefKey: refKey,
                tokenExpiresAt,
                status: 'active',
                isActive: true,
                scopes: SCOPES,
                metadata: connMetadata,
            });
        }

        if (orgUser) {
            if (serviceName === 'instagram') {
                await createNotification(db, isReconnect ? 'instagram_reconnected' : 'instagram_connected', {
                    userId: orgUser.id,
                    context: { instagram: { page_warning: !fbPageId ? ' Note: No Facebook Page linked — some features may be limited.' : '' } },
                    metadata: { igUserId: externalUserId, accountType, fbPageId, assistantId },
                });
            } else {
                await createNotification(db, isReconnect ? 'facebook_reconnected' : 'facebook_connected', {
                    userId: orgUser.id,
                    context: { facebook: { page_name: pageName || 'your Page' } },
                    metadata: { fbPageId, pageName, assistantId },
                });
            }
            // Connection is live again — un-pause the posts and assistants the failure halted, and
            // clear any open "reconnect" action items. Must run AFTER the status='active' write
            // above: the assistant-resume guard reads current connection statuses.
            if (isReconnect && existing) {
                await restoreConnectionDependents(db, {
                    connectionId: existing.id,
                    organisationId,
                    assistantId,
                    serviceName,
                    userId: orgUser.id,
                });
            } else {
                await resolveActionNotifications(db, orgUser.id, CONNECTION_RESTORED_TYPES);
            }
        }

        await db.insert(auditLogs).values({ actionType: isReconnect ? `${serviceName}_reconnected` : `${serviceName}_connected`, resourceType: 'system_connections', resourceId: externalUserId, newState: { organisationId, accountType, fbPageId } });

        // US-SMM-4.2.2 / 4.3.1: trigger profile sync + pre-flight audit fire-and-forget after OAuth.
        fetch(`${baseUrl}/.netlify/functions/social-profile-sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organisationId }),
        }).catch(() => {});
        fetch(`${baseUrl}/.netlify/functions/social-preflight-audit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organisationId, platform: serviceName }),
        }).catch(() => {});

        return {
            statusCode: 302,
            headers: { Location: `/workspace.html?oauth_success=${serviceName}${assistantId ? `&assistantId=${assistantId}` : ''}` },
            body: '',
        };
    }

    return { statusCode: 400, body: 'Unknown action' };
});
