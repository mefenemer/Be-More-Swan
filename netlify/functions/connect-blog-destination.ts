// netlify/functions/connect-blog-destination.ts
// Authed management of paste-token blog connectors (US 3.2, Tier 1 — Dev.to, Hashnode).
// Not OAuth, so it does not go through oauth-integrations.ts.
//
// GET                                   → connection status for every adapter
// POST { action:'connect', provider, creds:{...} }  → validate live, then store
// POST { action:'disconnect', provider }            → remove connection + vault secret
// POST { action:'setmode', provider, publishMode }  → set draft/live auto-syndication mode
// POST { action:'save-profile', provider:'swanindex', profile:{...} } → edit the masthead identity

import { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { logAuditEvent } from '../../src/utils/audit';
import { getBlogAdapter, isBlogDestinationId } from '../../src/utils/blog-destinations';
import { saveBlogDestination, deleteBlogDestination, listBlogDestinations, setBlogPublishMode, connectSwanIndex } from '../../src/utils/blog-destinations/store';
import { updateProfile } from '../../src/utils/swan-index/profile';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, body: JSON.stringify(body) });

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    if (event.httpMethod === 'GET') {
        return json(200, { destinations: await listBlogDestinations(db, ctx.organisationId) });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    let body: {
        action?: string; provider?: string; creds?: Record<string, unknown>; publishMode?: string;
        profile?: Record<string, unknown>;
    };
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON.' });
    }

    if (!isBlogDestinationId(body.provider)) return json(400, { error: 'Unknown blog destination.' });
    const adapter = getBlogAdapter(body.provider);

    if (body.action === 'disconnect') {
        await deleteBlogDestination(db, ctx.organisationId, body.provider);
        logAuditEvent({ userId: ctx.userId, actionType: 'DELETE', resourceType: 'blog_destination', resourceId: body.provider });
        return json(200, { ok: true });
    }

    // Set how this destination receives auto-syndicated posts (draft vs live). Hashnode has no draft
    // API, so a draft request there is rejected rather than silently stored as live.
    if (body.action === 'setmode') {
        const mode = body.publishMode === 'live' ? 'live' : 'draft';
        if (mode === 'draft' && !adapter.supportsDraft) {
            return json(422, { error: `${adapter.label} can only publish live — it has no draft API.` });
        }
        await setBlogPublishMode(db, ctx.organisationId, body.provider, mode);
        return json(200, { ok: true, publishMode: mode });
    }

    // The author's own masthead identity — display name, credit line, bio, site and social links.
    // It lives on this endpoint rather than a new one because it is part of managing THIS
    // connection, and the card that shows it already has the status payload in hand.
    if (body.action === 'save-profile') {
        if (adapter.authKind !== 'firstparty') {
            return json(400, { error: `${adapter.label} profiles are managed on ${adapter.label}, not here.` });
        }
        const saved = await updateProfile(db, ctx.organisationId, body.profile || {});
        if (!saved.ok) return json(400, { error: saved.error });
        logAuditEvent({ userId: ctx.userId, actionType: 'UPDATE', resourceType: 'swan_index_profile', resourceId: saved.profile.handle });
        return json(200, { ok: true, profile: saved.profile });
    }

    if (body.action === 'connect') {
        // First-party (The Swan Index): no credentials to collect or verify. Connecting means
        // creating the workspace's publication profile, and the handle it was allocated is the one
        // thing the UI needs back — it is the author's public URL from here on.
        if (adapter.authKind === 'firstparty') {
            const profile = await connectSwanIndex(db, ctx.organisationId, ctx.userId);
            logAuditEvent({ userId: ctx.userId, actionType: 'CREATE', resourceType: 'blog_destination', resourceId: body.provider });
            return json(200, { ok: true, accountLabel: `@${profile.handle}`, handle: profile.handle });
        }
        if (adapter.authKind === 'oauth' && adapter.oauthProvider) {
            return json(400, { error: `${adapter.label} connects via OAuth.`, connectUrl: `/api/oauth/${adapter.oauthProvider}/connect` });
        }
        const parsed = adapter.parseCreds(body.creds || {});
        if (!parsed.ok) return json(400, { error: parsed.error });

        const check = await adapter.validate(parsed.creds);
        if (!check.ok) return json(400, { error: check.error || `${adapter.label} rejected the credentials.` });

        await saveBlogDestination(db, ctx.organisationId, ctx.userId, body.provider, parsed.creds, check.accountLabel ?? null);
        logAuditEvent({ userId: ctx.userId, actionType: 'CREATE', resourceType: 'blog_destination', resourceId: body.provider });
        return json(200, { ok: true, accountLabel: check.accountLabel ?? null });
    }

    return json(400, { error: 'Unknown action.' });
});
