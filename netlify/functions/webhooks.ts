// netlify/functions/webhooks.ts
// The tenant's own webhook endpoints. Session-authenticated, owner/admin to change.
//
//   GET                          → this org's endpoints, plus recent delivery outcomes
//   POST { action: 'create' }    → add one; the signing secret is in THIS RESPONSE AND NOWHERE ELSE
//   POST { action: 'update' }    → change the events, or switch it back on after an auto-disable
//   POST { action: 'rotate' }    → new signing secret, shown once
//   POST { action: 'delete' }    → remove it and its history
//   POST { action: 'test' }      → send a ping to prove the setup works
//
// ⚠️ The URL is checked before it is stored, not just before it is called. A tenant who typed
// something we will refuse should be told while they are still looking at the field.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { webhookDeliveries, webhookEndpoints } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { storeSecret } from '../../src/utils/vault';
import {
    WEBHOOK_EVENTS, createEndpoint, emitWebhook, isDeliverableUrl, mintSigningSecret, vaultRefFor,
} from '../../src/utils/webhooks';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
});

const MANAGE_ROLES = ['owner', 'admin'];
const MAX_ENDPOINTS = 5;

function cleanEvents(raw: unknown): string[] {
    const asked = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
    // Unknown names are DROPPED rather than failing the request — but an empty result is refused
    // below, so a caller who sent only nonsense is told, and one who sent a typo among three good
    // names does not lose the whole endpoint over it.
    return WEBHOOK_EVENTS.filter((e) => asked.includes(e));
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        try {
            const endpoints = await db
                .select({
                    id: webhookEndpoints.id,
                    url: webhookEndpoints.url,
                    description: webhookEndpoints.description,
                    events: webhookEndpoints.events,
                    isActive: webhookEndpoints.isActive,
                    consecutiveFailures: webhookEndpoints.consecutiveFailures,
                    disabledAt: webhookEndpoints.disabledAt,
                    disabledReason: webhookEndpoints.disabledReason,
                    lastSuccessAt: webhookEndpoints.lastSuccessAt,
                    lastError: webhookEndpoints.lastError,
                    createdAt: webhookEndpoints.createdAt,
                })
                .from(webhookEndpoints)
                .where(eq(webhookEndpoints.organisationId, ctx.organisationId))
                .orderBy(desc(webhookEndpoints.createdAt));

            // ⚠️ The queue's own health, in front of the tenant rather than in a log. A backlog is
            // the symptom of the failure mode this feature was deferred over twice.
            const [queue] = await db
                .select({
                    pending: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'pending')::int`,
                    failed: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'failed')::int`,
                    delivered: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'delivered')::int`,
                })
                .from(webhookDeliveries)
                .where(and(
                    eq(webhookDeliveries.organisationId, ctx.organisationId),
                    sql`${webhookDeliveries.createdAt} >= ${new Date(Date.now() - 7 * 86400000).toISOString()}`,
                ));

            return json(200, { endpoints, events: WEBHOOK_EVENTS, queue, window: 'the last 7 days' });
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            return json(200, { endpoints: [], events: WEBHOOK_EVENTS, needsSetup: true });
        }
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: MANAGE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const guard = isDeliverableUrl(String(body.url || ''));
        if (!guard.ok) return json(400, { error: guard.reason });

        const events = cleanEvents(body.events);
        if (!events.length) {
            return json(400, { error: 'Choose at least one event to send.', allowed: WEBHOOK_EVENTS });
        }

        const existing = await db.select({ id: webhookEndpoints.id })
            .from(webhookEndpoints).where(eq(webhookEndpoints.organisationId, orgId));
        if (existing.length >= MAX_ENDPOINTS) {
            return json(400, { error: `You can have at most ${MAX_ENDPOINTS} webhook endpoints.` });
        }

        const created = await createEndpoint(db, {
            organisationId: orgId,
            url: guard.url,
            events,
            description: String(body.description || '').trim().slice(0, 200) || null,
            createdBy: ctx.userId,
        });
        // ⚠️ The only time the signing secret leaves the vault for a person to see.
        return json(200, { endpointId: created.endpointId, secret: created.secret, shownOnce: true });
    }

    const id = Number(body.id || '');
    if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid endpoint.' });

    const [endpoint] = await db.select().from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.organisationId, orgId))).limit(1);
    if (!endpoint) return json(404, { error: 'Endpoint not found.' });

    if (action === 'update') {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if ('events' in body) {
            const events = cleanEvents(body.events);
            if (!events.length) return json(400, { error: 'Choose at least one event to send.' });
            patch.events = events.join(',');
        }
        if ('url' in body) {
            const guard = isDeliverableUrl(String(body.url || ''));
            if (!guard.ok) return json(400, { error: guard.reason });
            patch.url = guard.url;
        }
        if ('description' in body) patch.description = String(body.description || '').trim().slice(0, 200) || null;
        if ('isActive' in body) {
            patch.isActive = body.isActive === true;
            // ⚠️ Switching a disabled endpoint back on CLEARS the failure count. Otherwise it is
            // one failure away from switching itself off again, and the tenant who has just fixed
            // their server watches it die immediately for reasons that predate the fix.
            if (body.isActive === true) {
                patch.consecutiveFailures = 0;
                patch.disabledAt = null;
                patch.disabledReason = null;
                patch.lastError = null;
            }
        }
        await db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, id));
        return json(200, { updated: true });
    }

    if (action === 'rotate') {
        const secret = mintSigningSecret();
        await storeSecret(db as never, vaultRefFor(id), { secret });
        await db.update(webhookEndpoints).set({ secretRef: vaultRefFor(id), updatedAt: new Date() })
            .where(eq(webhookEndpoints.id, id));
        // Same one-time showing as creation. Anything already verifying with the old secret breaks
        // the moment this returns, which is what rotation means and is said in the UI.
        return json(200, { secret, shownOnce: true });
    }

    if (action === 'delete') {
        await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
        return json(200, { deleted: true });
    }

    if (action === 'test') {
        // A real delivery through the real path — signature, headers, retry row and all. A test
        // that took a shortcut would prove the shortcut works.
        const queued = await emitWebhook(db, {
            organisationId: orgId,
            event: 'contact.subscribed',
            data: { email: 'test@example.com', status: 'subscribed', test: true },
        });
        return json(200, { queued });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
