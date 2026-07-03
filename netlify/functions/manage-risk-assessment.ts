// netlify/functions/manage-risk-assessment.ts
// US-GOV-1.1.1: EU AI Act risk assessment submission and approval.
//
// GET  ?masterAssistantId=N  — returns assessment status for the caller's org
// POST { masterAssistantId, findings }  — workspace admin submits assessment
// PATCH { id, approvalStatus, findings? }  — SuperAdmin approves/rejects

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { masterAssistants, notifications, riskAssessments, users, userOrganisations } from '../../db/schema';
import { suggestsHighRisk } from '../../src/config/compliance';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): { userId: number } | null {
    if (!jwtSecret) return null;
    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        return { userId: (jwt.verify(match[1], jwtSecret) as { userId: number }).userId };
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    const auth = getAuth(event);
    if (!auth) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    const [caller] = await db
        .select({ role: users.role, organisationId: userOrganisations.organisationId })
        .from(users)
        .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
        .where(eq(users.id, auth.userId))
        .limit(1);

    if (!caller) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };

    // ── GET ───────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const masterAssistantId = parseInt(event.queryStringParameters?.masterAssistantId || '');
        if (!masterAssistantId) return { statusCode: 400, body: JSON.stringify({ error: 'masterAssistantId is required.' }) };

        const [master] = await db
            .select({ riskClassification: masterAssistants.riskClassification, name: masterAssistants.name, category: masterAssistants.category })
            .from(masterAssistants)
            .where(eq(masterAssistants.id, masterAssistantId))
            .limit(1);

        if (!master) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

        const conditions = [eq(riskAssessments.masterAssistantId, masterAssistantId)];
        if (caller.organisationId) conditions.push(eq(riskAssessments.organisationId, caller.organisationId));

        const [assessment] = await db
            .select()
            .from(riskAssessments)
            .where(and(...conditions))
            .limit(1);

        return {
            statusCode: 200,
            body: JSON.stringify({
                riskClassification: master.riskClassification,
                // High-risk keyword heuristic lives in src/config/compliance.ts (AC4.1).
                suggestedHighRisk: suggestsHighRisk(master.name, master.category),
                assessment: assessment ?? null,
            }),
        };
    }

    // ── POST — submit assessment ───────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        let body: { masterAssistantId?: number; findings?: string } = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { masterAssistantId, findings } = body;
        if (!masterAssistantId) return { statusCode: 400, body: JSON.stringify({ error: 'masterAssistantId is required.' }) };
        if (!caller.organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found for this user.' }) };

        const [master] = await db
            .select({ riskClassification: masterAssistants.riskClassification })
            .from(masterAssistants)
            .where(eq(masterAssistants.id, masterAssistantId))
            .limit(1);

        if (!master) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        if (master.riskClassification !== 'high_risk') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Risk assessments are only required for high_risk assistants.' }) };
        }

        // Upsert — replace any existing pending assessment
        const [existing] = await db
            .select({ id: riskAssessments.id, approvalStatus: riskAssessments.approvalStatus })
            .from(riskAssessments)
            .where(and(
                eq(riskAssessments.masterAssistantId, masterAssistantId),
                eq(riskAssessments.organisationId, caller.organisationId),
            ))
            .limit(1);

        let record;
        if (existing) {
            if (existing.approvalStatus === 'approved') {
                return { statusCode: 409, body: JSON.stringify({ error: 'An approved assessment already exists for this assistant.' }) };
            }
            [record] = await db
                .update(riskAssessments)
                .set({ findings: findings ?? null, approvalStatus: 'pending', assessorId: auth.userId, assessedAt: new Date(), updatedAt: new Date() })
                .where(eq(riskAssessments.id, existing.id))
                .returning();
        } else {
            [record] = await db
                .insert(riskAssessments)
                .values({
                    masterAssistantId,
                    organisationId: caller.organisationId,
                    assessorId: auth.userId,
                    findings: findings ?? null,
                    approvalStatus: 'pending',
                })
                .returning();
        }

        // Notify super_admin/platform_admin users of the new submission
        const admins = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.role as any, 'super_admin'));

        if (admins.length > 0) {
            await db.insert(notifications).values(admins.map(a => ({
                userId: a.id,
                type: 'risk_assessment_submitted',
                title: 'Risk Assessment Submitted',
                message: `A risk assessment has been submitted for master assistant #${masterAssistantId} and requires review.`,
                isRead: false,
            })));
        }

        return { statusCode: 201, body: JSON.stringify(record) };
    }

    // ── PATCH — approve / reject (SuperAdmin only) ────────────────────────────
    if (event.httpMethod === 'PATCH') {
        const isSuperAdmin = ['super_admin', 'platform_admin'].includes(caller.role ?? '');
        if (!isSuperAdmin) return { statusCode: 403, body: JSON.stringify({ error: 'SuperAdmin access required.' }) };

        let body: { id?: number; approvalStatus?: string; findings?: string } = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { id, approvalStatus, findings } = body;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };
        if (!['approved', 'rejected'].includes(approvalStatus ?? '')) {
            return { statusCode: 400, body: JSON.stringify({ error: 'approvalStatus must be approved or rejected.' }) };
        }

        const updates: any = {
            approvalStatus,
            approvedById: auth.userId,
            approvedAt: new Date(),
            updatedAt: new Date(),
        };
        if (findings !== undefined) updates.findings = findings;

        const [updated] = await db
            .update(riskAssessments)
            .set(updates)
            .where(eq(riskAssessments.id, id))
            .returning();

        if (!updated) return { statusCode: 404, body: JSON.stringify({ error: 'Risk assessment not found.' }) };

        // Notify the submitting assessor of the decision
        if (updated.assessorId) {
            await db.insert(notifications).values({
                userId: updated.assessorId,
                type: 'risk_assessment_decision',
                title: `Risk Assessment ${approvalStatus === 'approved' ? 'Approved' : 'Rejected'}`,
                message: `Your EU AI Act conformity assessment for assistant #${updated.masterAssistantId} has been ${approvalStatus}. ${approvalStatus === 'approved' ? 'You may now activate the assistant in EU-market workspaces.' : 'Please review the findings and resubmit.'}`,
                isRead: false,
            });
        }

        return { statusCode: 200, body: JSON.stringify(updated) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
