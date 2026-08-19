// netlify/functions/audience-segments.ts
// Segments of the shared Audience — "Weekly newsletter", "Trial signups", "Lapsed customers".
// Org-scoped via requireTenant. See docs/newsletter-assistant-plan.md.
//
//   GET                            → the org's segments, each with its SUBSCRIBED member count
//   POST { action: 'create' }      → new segment
//   POST { action: 'rename' }      → rename / re-describe
//   POST { action: 'delete' }      → remove the segment (membership rows cascade; contacts stay)
//
// ⚠️ Deleting a segment must never delete contacts. The join table cascades, the people do not —
// a tenant tidying up their labels has not asked to lose their audience.

import { HandlerEvent } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContactSegments, audienceContacts, audienceSegments } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

const WRITE_ROLES = ['owner', 'admin', 'member'];
const MAX_NAME = 80;

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;

        // The count that matters is SENDABLE members, not members. A segment reading "1,400
        // contacts" that mails 900 people is the number a tenant plans a campaign around and then
        // has to explain. (This still excludes only the audience-side states — the opt-out and
        // suppression checks happen per send, in audience-consent.ts.)
        const rows = await db
            .select({
                id: audienceSegments.id,
                name: audienceSegments.name,
                description: audienceSegments.description,
                kind: audienceSegments.kind,
                createdAt: audienceSegments.createdAt,
                memberCount: sql<number>`count(${audienceContactSegments.contactId})::int`,
                subscribedCount: sql<number>`count(*) FILTER (WHERE ${audienceContacts.status} = 'subscribed')::int`,
            })
            .from(audienceSegments)
            .leftJoin(audienceContactSegments, eq(audienceContactSegments.segmentId, audienceSegments.id))
            .leftJoin(audienceContacts, eq(audienceContacts.id, audienceContactSegments.contactId))
            .where(eq(audienceSegments.organisationId, ctx.organisationId))
            .groupBy(audienceSegments.id)
            .orderBy(audienceSegments.name);

        return json(200, { segments: rows });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const name = String(body.name || '').trim().slice(0, MAX_NAME);
        if (!name) return json(400, { error: 'Give the segment a name.' });
        try {
            const [seg] = await db.insert(audienceSegments).values({
                organisationId: orgId,
                name,
                description: String(body.description || '').trim().slice(0, 300) || null,
                createdBy: ctx.userId,
            }).returning({ id: audienceSegments.id, name: audienceSegments.name });
            return json(200, { segment: seg });
        } catch (err) {
            // audience_segments_org_name_unique is case-insensitive — "Newsletter" and "newsletter"
            // as two segments is a support ticket, not a feature.
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code === '23505') return json(409, { error: 'You already have a segment with that name.' });
            throw err;
        }
    }

    if (action === 'rename') {
        const id = Number(body.id || '');
        const name = String(body.name || '').trim().slice(0, MAX_NAME);
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid segment.' });
        if (!name) return json(400, { error: 'Give the segment a name.' });

        const [updated] = await db.update(audienceSegments)
            .set({
                name,
                description: 'description' in body ? (String(body.description || '').trim().slice(0, 300) || null) : undefined,
                updatedAt: new Date(),
            })
            .where(and(eq(audienceSegments.id, id), eq(audienceSegments.organisationId, orgId)))
            .returning({ id: audienceSegments.id });
        if (!updated) return json(404, { error: 'Segment not found.' });
        return json(200, { updated: true });
    }

    if (action === 'delete') {
        const id = Number(body.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid segment.' });

        const [deleted] = await db.delete(audienceSegments)
            .where(and(eq(audienceSegments.id, id), eq(audienceSegments.organisationId, orgId)))
            .returning({ id: audienceSegments.id });
        if (!deleted) return json(404, { error: 'Segment not found.' });
        // Contacts are untouched by design — only their membership rows cascade away.
        return json(200, { deleted: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
