// netlify/functions/connect-blog-destination.ts
// Authed management of paste-token blog connectors (US 3.2, Tier 1 — Dev.to, Hashnode).
// Not OAuth, so it does not go through oauth-integrations.ts.
//
// GET                                   → connection status for every adapter
// POST { action:'connect', provider, creds:{...} }  → validate live, then store
// POST { action:'disconnect', provider }            → remove connection + vault secret

import { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { logAuditEvent } from '../../src/utils/audit';
import { getBlogAdapter, isBlogDestinationId } from '../../src/utils/blog-destinations';
import { saveBlogDestination, deleteBlogDestination, listBlogDestinations } from '../../src/utils/blog-destinations/store';

const json = (statusCode: number, body: unknown) => ({ statusCode, body: JSON.stringify(body) });

export const handler = async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    if (event.httpMethod === 'GET') {
        return json(200, { destinations: await listBlogDestinations(db, ctx.organisationId) });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    let body: { action?: string; provider?: string; creds?: Record<string, unknown> };
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

    if (body.action === 'connect') {
        const parsed = adapter.parseCreds(body.creds || {});
        if (!parsed.ok) return json(400, { error: parsed.error });

        const check = await adapter.validate(parsed.creds);
        if (!check.ok) return json(400, { error: check.error || `${adapter.label} rejected the credentials.` });

        await saveBlogDestination(db, ctx.organisationId, ctx.userId, body.provider, parsed.creds, check.accountLabel ?? null);
        logAuditEvent({ userId: ctx.userId, actionType: 'CREATE', resourceType: 'blog_destination', resourceId: body.provider });
        return json(200, { ok: true, accountLabel: check.accountLabel ?? null });
    }

    return json(400, { error: 'Unknown action.' });
};
