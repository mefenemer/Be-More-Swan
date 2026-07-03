// netlify/functions/admin-feature-requests.ts
// Feature Requests & Roadmap — admin moderation + Gantt API (US04, US05).
//
// GET    /admin-feature-requests                       → ALL requests (incl. pending_review)
// POST   /admin-feature-requests { title, description?, category?, priority? }
//                                                       → admin creates a request directly (source='manual', status='open')
// POST   /admin-feature-requests?action=enhance { text }
//                                                       → LLM-polished feature summary from raw text (US04)
// POST   /admin-feature-requests?action=merge { sourceId, targetId }
//                                                       → mark source a duplicate of target, combine votes (US04)
// POST   /admin-feature-requests?action=reorder { order: number[] }
//                                                       → persist admin board sort_order
// PATCH  /admin-feature-requests?id=N { status?, title?, description?, category?, assistantRef?, priority?, targetQuarter? }
//                                                       → moderate/edit; dragging onto the Gantt sets targetQuarter+status (US05)
// DELETE /admin-feature-requests?id=N                   → remove a request
//
// Admin-only. On any status change, notifies the submitter + voters (US06).
// Replaces the old admin-feature-roadmap.ts (unified into feature_requests).

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq, asc, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { featureRequests, featureRequestVotes, masterAssistants, users } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import {
    FR_CATEGORY_LABEL,
    FR_STATUS_LABEL,
    FR_PRIORITY_LABEL,
    isFeatureCategory,
    isFeaturePriority,
    isFeatureStatus,
    isQuarter,
    nextTopSortOrder,
    syncVoteCount,
    broadcastFeatureStatusChange,
    type FeatureStatus,
} from '../../src/utils/feature-requests';

const jwtSecret = process.env.JWT_SECRET;
const MODEL = 'claude-haiku-4-5-20251001';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number; role: string } | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    return { id: userId, role: row.role };
}

export const handler: Handler = async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'Access denied. Admin role required.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const id = qs.id ? Number(qs.id) : null;
    const action = qs.action || '';

    // ── POST ?action=enhance: LLM-polish raw text (US04) ─────────────────────────
    if (event.httpMethod === 'POST' && action === 'enhance') {
        if (await isGlobalAiDisabled()) {
            return json(503, { error: 'AI services are temporarily unavailable. Please try again later.' });
        }
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return json(400, { error: 'Provide some text to enhance.' });

        try {
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const response = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 512,
                messages: [{
                    role: 'user',
                    content: `You are a product manager refining a user-submitted feature request for an AI assistant SaaS platform. Rewrite the request below into a clear, concise, professional feature summary (2-4 sentences). Keep the user's intent; fix grammar and clarity; do NOT invent scope or commitments. Return ONLY the rewritten summary, no preamble or markdown.\n\nRaw request:\n"""${text}"""`,
                }],
            });
            const enhanced = ((response.content[0] as { text: string })?.text || '').trim();
            if (!enhanced) throw new Error('Empty LLM response.');

            void logAiUsage({
                userId: admin.id,
                workspaceId: null,
                model: MODEL,
                inputTokens: response.usage?.input_tokens ?? 0,
                outputTokens: response.usage?.output_tokens ?? 0,
            });
            return json(200, { enhanced });
        } catch (err) {
            console.error('[admin-feature-requests] enhance failed:', err);
            return json(500, { error: 'Could not enhance the description right now.' });
        }
    }

    // ── POST ?action=merge: fold source into target, combine votes (US04) ────────
    if (event.httpMethod === 'POST' && action === 'merge') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const sourceId = Number(body.sourceId);
        const targetId = Number(body.targetId);
        if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId === targetId) {
            return json(400, { error: 'Provide distinct sourceId and targetId.' });
        }
        const [target] = await db.select({ id: featureRequests.id }).from(featureRequests).where(eq(featureRequests.id, targetId)).limit(1);
        const [source] = await db.select({ id: featureRequests.id }).from(featureRequests).where(eq(featureRequests.id, sourceId)).limit(1);
        if (!target || !source) return json(404, { error: 'Source or target not found.' });

        // Move the source's votes onto the target, deduping against existing voters.
        const voters = await db.select({ userId: featureRequestVotes.userId })
            .from(featureRequestVotes).where(eq(featureRequestVotes.featureId, sourceId));
        for (const v of voters) {
            await db.insert(featureRequestVotes)
                .values({ featureId: targetId, userId: v.userId })
                .onConflictDoNothing();
        }
        await db.delete(featureRequestVotes).where(eq(featureRequestVotes.featureId, sourceId));
        await db.update(featureRequests)
            .set({ status: 'duplicate', mergedIntoId: targetId, updatedAt: new Date() })
            .where(eq(featureRequests.id, sourceId));

        const targetVotes = await syncVoteCount(db, targetId);
        await syncVoteCount(db, sourceId); // → 0
        return json(200, { ok: true, targetVotes });
    }

    // ── POST ?action=reorder: persist admin board order ──────────────────────────
    if (event.httpMethod === 'POST' && action === 'reorder') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const order = Array.isArray(body.order) ? body.order.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n)) : null;
        if (!order || !order.length) return json(400, { error: 'Provide an "order" array of ids.' });
        for (let i = 0; i < order.length; i++) {
            await db.update(featureRequests).set({ sortOrder: i, updatedAt: new Date() }).where(eq(featureRequests.id, order[i]));
        }
        return json(200, { ok: true });
    }

    // ── POST: admin creates a request directly (lands public/open) ───────────────
    if (event.httpMethod === 'POST') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return json(400, { error: 'Title is required.' });
        const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
        const category = isFeatureCategory(body.category) ? body.category : 'app_core';
        const priority = isFeaturePriority(body.priority) ? body.priority : 'medium';

        const sortOrder = await nextTopSortOrder(db);
        const [inserted] = await db.insert(featureRequests).values({
            title: title.slice(0, 200),
            description,
            category,
            priority,
            status: 'open',
            source: 'manual',
            sortOrder,
            reviewedBy: admin.id,
            reviewedAt: new Date(),
        }).returning({ id: featureRequests.id });
        return json(200, { ok: true, id: inserted.id });
    }

    // ── PATCH ?id: moderate / edit / Gantt placement ─────────────────────────────
    if (event.httpMethod === 'PATCH' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [current] = await db
            .select({ id: featureRequests.id, title: featureRequests.title, status: featureRequests.status, submittedBy: featureRequests.submittedBy, releasedAt: featureRequests.releasedAt })
            .from(featureRequests).where(eq(featureRequests.id, id)).limit(1);
        if (!current) return json(404, { error: 'Request not found.' });

        const set: Record<string, unknown> = { updatedAt: new Date() };

        if (typeof body.title === 'string') {
            const t = body.title.trim();
            if (!t) return json(400, { error: 'Title cannot be empty.' });
            set.title = t.slice(0, 200);
        }
        if (typeof body.description === 'string') set.description = body.description.trim() || null;
        if (body.category !== undefined) {
            if (!isFeatureCategory(body.category)) return json(400, { error: 'Invalid category.' });
            set.category = body.category;
        }
        if (body.assistantRef !== undefined) {
            const ref = typeof body.assistantRef === 'string' ? body.assistantRef.trim() : '';
            if (!ref) {
                set.assistantRef = null;
            } else {
                const [role] = await db.select({ roleKey: masterAssistants.roleKey })
                    .from(masterAssistants).where(eq(masterAssistants.roleKey, ref)).limit(1);
                if (!role) return json(400, { error: 'Unknown assistant.' });
                set.assistantRef = ref;
            }
        }
        if (body.priority !== undefined) {
            if (!isFeaturePriority(body.priority)) return json(400, { error: 'Invalid priority.' });
            set.priority = body.priority;
        }
        if (body.targetQuarter !== undefined) {
            if (body.targetQuarter === null || body.targetQuarter === '') {
                set.targetQuarter = null;
            } else if (isQuarter(body.targetQuarter)) {
                set.targetQuarter = body.targetQuarter;
            } else {
                return json(400, { error: 'Invalid target quarter (expected YYYY-Qn).' });
            }
        }

        let newStatus: FeatureStatus | null = null;
        if (body.status !== undefined) {
            if (!isFeatureStatus(body.status)) return json(400, { error: 'Invalid status.' });
            newStatus = body.status as FeatureStatus;
            set.status = newStatus;
            // First approval out of the review queue → stamp the reviewer.
            if (current.status === 'pending_review' || current.status === 'under_review') {
                set.reviewedBy = admin.id;
                set.reviewedAt = new Date();
            }
            // Stamp released_at the first time it ships (powers the avg-wait metric).
            if (newStatus === 'released' && !current.releasedAt) set.releasedAt = new Date();
        }

        if (Object.keys(set).length === 1) return json(400, { error: 'Nothing to update.' });

        await db.update(featureRequests).set(set).where(eq(featureRequests.id, id));

        // US06: notify submitter + voters when the status actually changes.
        if (newStatus && newStatus !== current.status) {
            await broadcastFeatureStatusChange(
                db,
                { id: current.id, title: (set.title as string) ?? current.title, submittedBy: current.submittedBy },
                newStatus,
            );
        }
        return json(200, { ok: true });
    }

    // ── DELETE ?id ───────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE' && id) {
        const [deleted] = await db.delete(featureRequests).where(eq(featureRequests.id, id)).returning({ id: featureRequests.id });
        if (!deleted) return json(404, { error: 'Request not found.' });
        return json(200, { ok: true });
    }

    // ── GET: every request, newest-pending first then board order ────────────────
    if (event.httpMethod === 'GET') {
        const rows = await db
            .select({
                id: featureRequests.id,
                title: featureRequests.title,
                description: featureRequests.description,
                submitterDescription: featureRequests.submitterDescription,
                category: featureRequests.category,
                assistantRef: featureRequests.assistantRef,
                status: featureRequests.status,
                priority: featureRequests.priority,
                targetQuarter: featureRequests.targetQuarter,
                voteCount: featureRequests.voteCount,
                sortOrder: featureRequests.sortOrder,
                source: featureRequests.source,
                issueId: featureRequests.issueId,
                mergedIntoId: featureRequests.mergedIntoId,
                createdAt: featureRequests.createdAt,
                updatedAt: featureRequests.updatedAt,
                submitterEmail: users.email,
            })
            .from(featureRequests)
            .leftJoin(users, eq(users.id, featureRequests.submittedBy))
            .orderBy(asc(featureRequests.sortOrder), desc(featureRequests.createdAt));

        return json(200, {
            requests: rows.map((r) => ({
                ...r,
                categoryLabel: FR_CATEGORY_LABEL[r.category as keyof typeof FR_CATEGORY_LABEL] || r.category,
                statusLabel: FR_STATUS_LABEL[r.status as keyof typeof FR_STATUS_LABEL] || r.status,
                priorityLabel: FR_PRIORITY_LABEL[r.priority as keyof typeof FR_PRIORITY_LABEL] || r.priority,
            })),
        });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
