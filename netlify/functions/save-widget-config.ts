// netlify/functions/save-widget-config.ts
// Autonomous Content Engine — US 3.1 AC1/AC2: manage a workspace's embeddable widget config.
//
// GET  → the org's widget config (or { config: null } if none yet)
// POST { action:'create' }                                   → create with a fresh public_key
// POST { action:'update', theme?, badgeEnabled?, name?, allowedOrigins? } → update (admin/owner only)
//
// public_key is the unguessable identifier baked into the embed <script data-bms-key>. Theming
// writes are gated to owner/admin. See docs §8.

import { HandlerEvent } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const WRITE_ROLES = ['owner', 'admin'];
const newPublicKey = () => 'wgt_' + randomBytes(12).toString('hex');

export const handler = async (event: HandlerEvent) => {
    const db = getDb();

    // Reads: any member. Writes: owner/admin (enforced below on the write branch).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    if (event.httpMethod === 'GET') {
        const [config] = await db
            .select()
            .from(widgetConfigs)
            .where(eq(widgetConfigs.organisationId, ctx.organisationId))
            .limit(1);
        return { statusCode: 200, body: JSON.stringify({ config: config || null }) };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!WRITE_ROLES.includes(ctx.role)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Only an owner or admin can change the widget.' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const [existing] = await db
        .select()
        .from(widgetConfigs)
        .where(eq(widgetConfigs.organisationId, ctx.organisationId))
        .limit(1);

    if (body.action === 'create') {
        if (existing) return { statusCode: 200, body: JSON.stringify({ config: existing }) };
        const [config] = await db
            .insert(widgetConfigs)
            .values({
                organisationId: ctx.organisationId,
                publicKey: newPublicKey(),
                createdBy: ctx.userId,
            })
            .returning();
        return { statusCode: 201, body: JSON.stringify({ config }) };
    }

    if (body.action === 'update') {
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'No widget to update — create one first.' }) };
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.theme && typeof body.theme === 'object') updates.theme = body.theme;
        if (typeof body.name === 'string') updates.name = body.name.slice(0, 120);
        if (typeof body.badgeEnabled === 'boolean') updates.badgeEnabled = body.badgeEnabled;
        if (Array.isArray(body.allowedOrigins)) updates.allowedOrigins = body.allowedOrigins.slice(0, 50);

        const [config] = await db
            .update(widgetConfigs)
            .set(updates)
            .where(eq(widgetConfigs.organisationId, ctx.organisationId))
            .returning();
        return { statusCode: 200, body: JSON.stringify({ config }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
};
