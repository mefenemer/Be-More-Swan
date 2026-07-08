// netlify/functions/content-provenance.ts
// US-GOV-3.2.1: C2PA Metadata Tagging — record, query and export content provenance
//
// POST /.netlify/functions/content-provenance
//   Auth: aura_session (any authenticated user / assistant runtime)
//   Body: { contentId, assistantId, modelUsed, hitlReviewed?, publishedAt? }
//   → { ok: true, provenanceId: number, contentId: string }
//
// GET /.netlify/functions/content-provenance?contentId=<uuid>
//   Auth: aura_session — workspace admin or super_admin only
//   → provenance record + linked post(s)
//
// GET /.netlify/functions/content-provenance?action=export&contentId=<uuid>
//   Auth: aura_session — super_admin only
//   → signed JSON export (provenance chain + HMAC signature)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { createHmac, createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users,
    organisations,
    userOrganisations,
    aiAssistants,
    contentProvenance,
    scheduledPosts,
} from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const C2PA_SCHEMA_VERSION = '1.0';

interface SessionPayload {
    userId: number;
    organisationId?: number;
}

async function resolveSession(cookieHeader: string): Promise<SessionPayload | null> {
    if (!jwtSecret) return null;
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        return jwt.verify(match[1], jwtSecret) as SessionPayload;
    } catch {
        return null;
    }
}

function pseudonymiseOrg(organisationId: number): string {
    return createHmac('sha256', jwtSecret || 'fallback')
        .update(`org:${organisationId}`)
        .digest('hex')
        .slice(0, 16);
}

function hashModel(model: string): string {
    return createHash('sha256').update(model).digest('hex').slice(0, 32);
}

function signExport(payload: object): string {
    return createHmac('sha256', jwtSecret || 'fallback')
        .update(JSON.stringify(payload))
        .digest('hex');
}

async function getUserRole(db: any, userId: number): Promise<{ platformRole: string; organisationId: number | null; orgRole: string }> {
    const [user] = await db.select({ role: users.role, organisationId: userOrganisations.organisationId }).from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId)).limit(1);
    const [orgMember] = await db.select({ role: userOrganisations.role }).from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);
    return {
        platformRole: user?.role || 'user',
        organisationId: user?.organisationId || null,
        orgRole: orgMember?.role || 'member',
    };
}

export default withLambda(async (event) => {
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    }

    const session = await resolveSession(event.headers.cookie || '');
    if (!session) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };
    }

    const db = getDb();
    const { userId } = session;
    const userCtx = await getUserRole(db, userId);

    // ── POST: Record provenance ────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { contentId, assistantId, modelUsed, hitlReviewed, publishedAt } = body;
        if (!contentId || typeof contentId !== 'string') {
            return { statusCode: 400, body: JSON.stringify({ error: 'contentId (UUID string) required.' }) };
        }
        if (!modelUsed || typeof modelUsed !== 'string') {
            return { statusCode: 400, body: JSON.stringify({ error: 'modelUsed required.' }) };
        }

        const orgId = userCtx.organisationId;
        if (!orgId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'No organisation found for this user.' }) };
        }

        // Upsert: if contentId already exists, return the existing record
        const [existing] = await db.select({ id: contentProvenance.id }).from(contentProvenance).where(eq(contentProvenance.contentId, contentId)).limit(1);
        if (existing) {
            return { statusCode: 200, body: JSON.stringify({ ok: true, provenanceId: existing.id, contentId }) };
        }

        const [row] = await db.insert(contentProvenance).values({
            contentId,
            assistantId: assistantId || null,
            organisationId: orgId,
            workspaceIdHash: pseudonymiseOrg(orgId),
            modelUsedHash: hashModel(modelUsed),
            hitlReviewed: Boolean(hitlReviewed),
            hitlReviewedAt: hitlReviewed ? new Date() : null,
            publishedAt: publishedAt ? new Date(publishedAt) : null,
            c2paSchemaVersion: C2PA_SCHEMA_VERSION,
        }).returning({ id: contentProvenance.id });

        return {
            statusCode: 201,
            body: JSON.stringify({ ok: true, provenanceId: row.id, contentId }),
        };
    }

    // ── GET ────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const action = event.queryStringParameters?.action;
        const contentId = event.queryStringParameters?.contentId;

        if (!contentId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'contentId required.' }) };
        }

        const isSuperAdmin = userCtx.platformRole === 'super_admin';
        const isWorkspaceAdmin = userCtx.orgRole === 'owner' || userCtx.orgRole === 'admin' || isSuperAdmin;
        if (!isWorkspaceAdmin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Workspace admin or super_admin required.' }) };
        }

        const [record] = await db.select().from(contentProvenance).where(eq(contentProvenance.contentId, contentId)).limit(1);
        if (!record) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Provenance record not found.' }) };
        }

        // Scope check: workspace admins can only query their own org's records
        if (!isSuperAdmin && record.organisationId !== userCtx.organisationId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
        }

        // Fetch linked published posts
        const linkedPosts = await db
            .select({ id: scheduledPosts.id, platform: scheduledPosts.platform, publishedAt: scheduledPosts.publishedAt, status: scheduledPosts.status, platformPostUrl: scheduledPosts.platformPostUrl })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.provenanceContentId, contentId));

        // ── Signed export ──────────────────────────────────────────────────────
        if (action === 'export') {
            if (!isSuperAdmin) {
                return { statusCode: 403, body: JSON.stringify({ error: 'super_admin required for signed export.' }) };
            }

            const payload = {
                schemaVersion: C2PA_SCHEMA_VERSION,
                exportedAt: new Date().toISOString(),
                provenance: {
                    contentId: record.contentId,
                    creatorSystem: record.creatorSystem,
                    assistantId: record.assistantId,
                    workspaceIdHash: record.workspaceIdHash,
                    modelUsedHash: record.modelUsedHash,
                    hitlReviewed: record.hitlReviewed,
                    hitlReviewedAt: record.hitlReviewedAt,
                    generatedAt: record.generatedAt,
                    publishedAt: record.publishedAt,
                    c2paSchemaVersion: record.c2paSchemaVersion,
                },
                publishedRecords: linkedPosts,
            };
            const signature = signExport(payload);

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Disposition': `attachment; filename="provenance-${contentId}.json"`,
                },
                body: JSON.stringify({ ...payload, signature }),
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                provenance: {
                    ...record,
                    // Re-expose which assistant generated it (name lookup)
                },
                linkedPosts,
            }),
        };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed.' }) };
});
