// orchestrations.ts
// Epic 4 (Feature 4.1) — CRUD for cross-assistant workflow links (orchestration_links).
// A link = "when SOURCE assistant fires SOURCE_EVENT, hand off to TARGET assistant to do
// TARGET_ACTION". Definition + visualisation only for now (no runtime consumer yet).
//
// GET                                   → all links for the caller's org (+ source/target names)
// POST   { sourceAssistantId, sourceEvent, targetAssistantId, targetAction }  → create
// PATCH  { id, isActive }               → toggle on/off
// DELETE ?id=N                          → hard delete
//
// Tenant isolation: requireTenant (owner-path + manual org filter, no RLS) — same as content-rules.ts.

import { Handler } from '@netlify/functions';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { orchestrationLinks, orchestrationRuns, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const SOURCE_EVENTS = ['drafts_a_post', 'publishes_a_post', 'completes_a_task'];

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const orgId = ctx.organisationId;
    const userId = ctx.userId;
    const method = event.httpMethod;
    const params = event.queryStringParameters || {};

    // ── GET — list every link for the org, enriched with assistant names ──────
    if (method === 'GET') {
        const rows = await db.select().from(orchestrationLinks)
            .where(eq(orchestrationLinks.organisationId, orgId))
            .orderBy(orchestrationLinks.createdAt);

        // Resolve source/target assistant names in one query.
        const ids = Array.from(new Set(rows.flatMap(r => [r.sourceAssistantId, r.targetAssistantId])));
        const names = ids.length
            ? await db.select({ id: aiAssistants.id, name: aiAssistants.name })
                .from(aiAssistants)
                .where(inArray(aiAssistants.id, ids))
            : [];
        const nameById = new Map(names.map(n => [n.id, n.name]));

        // Latest firing per link (Phase 5) → powers the "· fired …" hint on the hub + assistant page.
        const linkIds = rows.map(r => r.id);
        const runAgg = linkIds.length
            ? await db.select({ linkId: orchestrationRuns.linkId, lastFiredAt: sql<string>`max(${orchestrationRuns.createdAt})` })
                .from(orchestrationRuns)
                .where(inArray(orchestrationRuns.linkId, linkIds))
                .groupBy(orchestrationRuns.linkId)
            : [];
        const lastFiredByLink = new Map(runAgg.map(r => [r.linkId, r.lastFiredAt]));

        const links = rows.map(r => ({
            ...r,
            sourceAssistantName: nameById.get(r.sourceAssistantId) ?? 'Unknown',
            targetAssistantName: nameById.get(r.targetAssistantId) ?? 'Unknown',
            lastFiredAt: lastFiredByLink.get(r.id) ?? null,
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ links }),
        };
    }

    // ── POST — create a link ──────────────────────────────────────────────────
    if (method === 'POST') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const sourceAssistantId = Number(body.sourceAssistantId);
        const targetAssistantId = Number(body.targetAssistantId);
        const sourceEvent = String(body.sourceEvent || '').trim();
        const targetAction = String(body.targetAction || '').trim();

        if (!sourceAssistantId || !targetAssistantId || !sourceEvent || !targetAction) {
            return { statusCode: 400, body: JSON.stringify({ error: 'sourceAssistantId, sourceEvent, targetAssistantId and targetAction are required.' }) };
        }
        if (sourceAssistantId === targetAssistantId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'An assistant cannot hand off to itself.' }) };
        }
        if (!SOURCE_EVENTS.includes(sourceEvent)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Unknown source event.' }) };
        }
        if (targetAction.length > 200) {
            return { statusCode: 400, body: JSON.stringify({ error: 'targetAction must be 200 characters or fewer.' }) };
        }

        // Both assistants must belong to the caller's org.
        const owned = await db.select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(
                inArray(aiAssistants.id, [sourceAssistantId, targetAssistantId]),
                eq(aiAssistants.organisationId, orgId),
            ));
        if (owned.length !== 2) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }

        const [link] = await db.insert(orchestrationLinks).values({
            organisationId:    orgId,
            sourceAssistantId,
            sourceEvent,
            targetAssistantId,
            targetAction,
            createdBy:         userId,
            isActive:          true,
        }).returning();

        return {
            statusCode: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link }),
        };
    }

    // ── PATCH — toggle isActive ───────────────────────────────────────────────
    if (method === 'PATCH') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }
        const id = Number(body.id);
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

        const [existing] = await db.select({ orgId: orchestrationLinks.organisationId })
            .from(orchestrationLinks).where(eq(orchestrationLinks.id, id)).limit(1);
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Link not found.' }) };
        if (existing.orgId !== orgId) return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };

        const [updated] = await db.update(orchestrationLinks)
            .set({ isActive: Boolean(body.isActive) })
            .where(eq(orchestrationLinks.id, id))
            .returning();

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link: updated }),
        };
    }

    // ── DELETE — hard delete ──────────────────────────────────────────────────
    if (method === 'DELETE') {
        const id = params.id ? Number(params.id) : NaN;
        if (isNaN(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

        const [existing] = await db.select({ orgId: orchestrationLinks.organisationId })
            .from(orchestrationLinks).where(eq(orchestrationLinks.id, id)).limit(1);
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Link not found.' }) };
        if (existing.orgId !== orgId) return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };

        await db.delete(orchestrationLinks).where(eq(orchestrationLinks.id, id));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleted: true, id }),
        };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};
