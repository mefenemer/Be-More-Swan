// netlify/functions/bias-audit.ts
// US-GOV-3.3.1: Bias audit management — reviews, incidents, reactivation gate, CSV download.
//
// GET  ?resource=reviews                         — list quarterly review records
// GET  ?resource=incidents                       — list bias incidents
// GET  ?resource=reports                         — list sampling reports
// GET  ?resource=report-csv&reportId=N           — download report as CSV
// POST ?resource=review   body: { promptsReviewed, findingsCount, actionsRequired, notes }
// POST ?resource=resolve  body: { incidentId, resolution }
// POST ?resource=ack      body: { incidentId, ackNote }   — deployer acknowledges corrective action
//
// Auth: super_admin for all except ack (any authenticated user who owns the assistant)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc, and } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import {
    users, biasAuditReviews, biasIncidents, biasSamplingReports, aiAssistants, notifications,
} from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

function isSuperAdmin(role: string) { return role === 'super_admin'; }

export default withLambda(async (event) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

    const qs       = event.queryStringParameters || {};
    const resource = qs.resource || '';

    // ── GET: reviews ──────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'reviews') {
        if (!isSuperAdmin(user.role)) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required.' }) };
        const rows = await db.select().from(biasAuditReviews).orderBy(desc(biasAuditReviews.reviewDate)).limit(100);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
    }

    // ── GET: incidents ────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'incidents') {
        if (!isSuperAdmin(user.role)) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required.' }) };
        const rows = await db.select().from(biasIncidents).orderBy(desc(biasIncidents.createdAt)).limit(200);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
    }

    // ── GET: reports ──────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'reports') {
        if (!isSuperAdmin(user.role)) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required.' }) };
        const rows = await db.select({
            id: biasSamplingReports.id,
            runAt: biasSamplingReports.runAt,
            sampledCount: biasSamplingReports.sampledCount,
            flaggedAnomalies: biasSamplingReports.flaggedAnomalies,
        }).from(biasSamplingReports).orderBy(desc(biasSamplingReports.runAt)).limit(50);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
    }

    // ── GET: report-csv ───────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && resource === 'report-csv') {
        if (!isSuperAdmin(user.role)) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required.' }) };
        const reportId = parseInt(qs.reportId || '', 10);
        if (!reportId) return { statusCode: 400, body: JSON.stringify({ error: 'reportId required.' }) };
        const [report] = await db.select().from(biasSamplingReports).where(eq(biasSamplingReports.id, reportId)).limit(1);
        if (!report) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found.' }) };

        const data = report.reportData as any;
        const stats: any[] = data?.assistantStats ?? [];
        const lines = [
            'assistantId,avgSentiment,avgLength,sampleCount',
            ...stats.map((s: any) => `${s.assistantId},${s.avgSentiment},${s.avgLength},${s.sampleCount}`),
        ];
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="bias-report-${reportId}.csv"`,
            } as Record<string, string>,
            body: lines.join('\n'),
        };
    }

    // ── POST: review — record a quarterly review ──────────────────────────────
    if (event.httpMethod === 'POST' && resource === 'review') {
        if (!isSuperAdmin(user.role)) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required.' }) };
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }
        const { promptsReviewed, findingsCount, actionsRequired, notes } = body;
        if (promptsReviewed == null || findingsCount == null) {
            return { statusCode: 400, body: JSON.stringify({ error: 'promptsReviewed and findingsCount are required.' }) };
        }
        const [row] = await db.insert(biasAuditReviews).values({
            reviewerId:      userId,
            promptsReviewed: parseInt(promptsReviewed, 10),
            findingsCount:   parseInt(findingsCount, 10),
            actionsRequired: actionsRequired?.trim() || null,
            notes:           notes?.trim() || null,
        }).returning();
        return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) };
    }

    // ── POST: resolve — investigator documents resolution ─────────────────────
    if (event.httpMethod === 'POST' && resource === 'resolve') {
        if (!isSuperAdmin(user.role)) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required.' }) };
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }
        const { incidentId, resolution } = body;
        if (!incidentId || !resolution?.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'incidentId and resolution are required.' }) };
        }
        await db.update(biasIncidents).set({
            resolution:    resolution.trim(),
            resolvedAt:    new Date(),
            investigatorId: userId,
        }).where(eq(biasIncidents.id, incidentId));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
    }

    // ── POST: ack — deployer acknowledges corrective actions; reactivates assistant ──
    if (event.httpMethod === 'POST' && resource === 'ack') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }
        const { incidentId, ackNote } = body;
        if (!incidentId || !ackNote?.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'incidentId and ackNote are required.' }) };
        }

        const [incident] = await db.select().from(biasIncidents).where(eq(biasIncidents.id, incidentId)).limit(1);
        if (!incident) return { statusCode: 404, body: JSON.stringify({ error: 'Incident not found.' }) };
        if (!incident.resolvedAt) {
            return { statusCode: 409, body: JSON.stringify({ error: 'Incident must be resolved by an investigator before deployer acknowledgment.' }) };
        }
        if (incident.deployerAckAt) {
            return { statusCode: 409, body: JSON.stringify({ error: 'Already acknowledged.' }) };
        }

        // Verify user owns the assistant (or is super_admin)
        if (incident.assistantId && !isSuperAdmin(user.role)) {
            const [asst] = await db.select({ userId: aiAssistants.userId })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, incident.assistantId))
                .limit(1);
            if (asst?.userId !== userId) {
                return { statusCode: 403, body: JSON.stringify({ error: 'You do not own this assistant.' }) };
            }
        }

        // Record acknowledgment
        await db.update(biasIncidents).set({
            deployerAckAt:     new Date(),
            deployerAckUserId: userId,
            deployerAckNote:   ackNote.trim(),
        }).where(eq(biasIncidents.id, incidentId));

        // Reactivate the assistant
        if (incident.assistantId) {
            await db.update(aiAssistants).set(withUpdatedAt({ isActive: true })).where(eq(aiAssistants.id, incident.assistantId));
        }

        await db.insert(notifications).values({
            userId,
            type:    'system',
            title:   `Assistant reactivated after bias review`,
            message: `You acknowledged the corrective actions for bias incident #${incidentId}. The assistant has been reactivated.`,
            metadata: { incidentId },
        }).catch(() => {});

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, reactivated: !!incident.assistantId }) };
    }

    return { statusCode: 404, body: JSON.stringify({ error: 'Unknown resource.' }) };
});
