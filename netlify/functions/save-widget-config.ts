// netlify/functions/save-widget-config.ts
// Autonomous Content Engine — US 3.1 AC1/AC2: manage a workspace's embeddable widget config.
//
// GET  → the org's widget config (or { config: null } if none yet)
// POST { action:'create' }                                   → create with a fresh public_key
// POST { action:'update', theme?, badgeEnabled?, name?, allowedOrigins?, siteBaseUrl?, sitePostPath? }
//                                                            → update (admin/owner only)
//
// siteBaseUrl + sitePostPath tell us where the customer PUBLISHES so canonical URLs can credit their
// own domain (US 1.3). BOTH are required to canonicalise there; sitePostPath must be a rooted path
// containing the {slug} placeholder — a pattern without it would canonicalise every post to one URL
// and collapse the whole blog (see blog-seo-metadata.sql / blog-seo.ts resolveCanonical).
//
// public_key is the unguessable identifier baked into the embed <script data-bms-key>. Theming
// writes are gated to owner/admin. See docs §8.

import { HandlerEvent } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const WRITE_ROLES = ['owner', 'admin'];
const newPublicKey = () => 'wgt_' + randomBytes(12).toString('hex');

export default withLambda(async (event: HandlerEvent) => {
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

        // Public-site canonical settings. '' clears the field (back to self-canonical /b/:key/:slug).
        if (typeof body.siteBaseUrl === 'string') {
            const v = body.siteBaseUrl.trim();
            if (v === '') { updates.siteBaseUrl = null; }
            else if (/^https?:\/\/[^\s/]+/i.test(v)) { updates.siteBaseUrl = v.replace(/\/+$/, '').slice(0, 300); }
            else { return { statusCode: 400, body: JSON.stringify({ error: 'siteBaseUrl must be a full http(s) URL, e.g. https://acme.com' }) }; }
        }
        if (typeof body.sitePostPath === 'string') {
            const v = body.sitePostPath.trim();
            if (v === '') { updates.sitePostPath = null; }
            // Must mirror the DB CHECK: rooted path containing the {slug} placeholder.
            else if (v.startsWith('/') && v.includes('{slug}')) { updates.sitePostPath = v.slice(0, 300); }
            else { return { statusCode: 400, body: JSON.stringify({ error: 'sitePostPath must be a rooted path containing {slug}, e.g. /blog/{slug}' }) }; }
        }

        const [config] = await db
            .update(widgetConfigs)
            .set(updates)
            .where(eq(widgetConfigs.organisationId, ctx.organisationId))
            .returning();
        return { statusCode: 200, body: JSON.stringify({ config }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
});
