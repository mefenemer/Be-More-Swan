// netlify/functions/submit-action-for-approval.ts
// US-GOV-4.1.2: Classify an agent action by reversibility tier and either
// auto-approve (Tier 0/1), notify + log (Tier 2), or queue for HITL (Tier 3/4).
//
// POST /.netlify/functions/submit-action-for-approval
//   Body: {
//     taskRunId: number,
//     assistantId: number,
//     actionType: string,          // e.g. 'send_email', 'delete_record', 'search_web'
//     actionPayload: object,       // sanitised proposed action details
//     affectedRecordCount?: number,
//     tier2RunCount?: number,      // caller tracks how many Tier 2 actions this run
//   }
//   Auth: aura_session (run owner / deployer)
//
// Returns {
//   decision: 'auto_approved' | 'pending_approval' | 'blocked',
//   tier: 0|1|2|3|4,
//   pendingActionId?: number,      // set when decision is 'pending_approval'
//   reason?: string,
// }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, taskRuns, pendingActions, actionPolicies, notifications,
} from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// Default reversibility tier map — platform classification
const DEFAULT_TIER: Record<string, number> = {
    // Tier 0 — read-only
    search_web: 0, fetch_url: 0, list_records: 0, get_record: 0, read_file: 0,
    // Tier 1 — low-risk reversible
    save_draft: 1, create_internal_note: 1, update_draft: 1, add_tag: 1,
    // Tier 2 — costly/visible
    send_email: 2, post_to_cms: 2, create_calendar_event: 2, publish_post: 2,
    create_task: 2, update_record: 2,
    // Tier 3 — hard-to-reverse
    delete_record: 3, charge_customer: 3, remove_integration: 3, archive_record: 3,
    send_bulk_email_small: 3, // < 100 recipients
    // Tier 4 — blast-radius
    bulk_delete: 4, mass_charge: 4, bulk_email: 4, reset_all: 4,
};

function classifyTier(actionType: string, policyMinTier: number, integrationMap?: Record<string, number> | null): number {
    const baseTier = DEFAULT_TIER[actionType] ?? 2; // unknown → treat as Tier 2
    const integrationOverride = integrationMap?.[actionType] ?? null;
    const effectiveTier = integrationOverride != null ? Math.max(baseTier, integrationOverride) : baseTier;
    // Policy can only raise, never lower
    return Math.max(effectiveTier, policyMinTier);
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { taskRunId, assistantId, actionType, actionPayload, affectedRecordCount, tier2RunCount = 0 } = body;
    if (!taskRunId || !actionType || !actionPayload) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId, actionType, and actionPayload are required.' }) };
    }

    const db = getDb();

    const [run] = await db.select({ id: taskRuns.id, organisationId: taskRuns.organisationId })
        .from(taskRuns)
        .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, userId)))
        .limit(1);
    if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };

    // Load effective policy (assistant-level overrides platform default)
    const policies = await db.select().from(actionPolicies).where(
        or(
            isNull(actionPolicies.assistantId),
            assistantId ? eq(actionPolicies.assistantId, assistantId) : isNull(actionPolicies.assistantId),
        )
    );
    const assistantPolicy = policies.find(p => p.assistantId === assistantId);
    const platformPolicy  = policies.find(p => p.assistantId === null);
    const effectivePolicy = assistantPolicy ?? platformPolicy;

    const hitlMinTier = effectivePolicy?.hitlMinimumTier ?? 3;
    const tier2Limit  = effectivePolicy?.tier2RateLimit  ?? 10;
    const integMap    = effectivePolicy?.integrationTypeMinTiers as Record<string, number> | null;

    const tier = classifyTier(actionType, hitlMinTier, integMap);

    // ── Tier 0 / 1: auto-approve ─────────────────────────────────────────────
    if (tier <= 1) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'auto_approved', tier }),
        };
    }

    // ── Tier 2: rate-limit check then auto-approve (or queue if over limit) ──
    if (tier === 2) {
        if (tier2RunCount >= tier2Limit) {
            // Over rate limit — queue for deployer release
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const [pending] = await db.insert(pendingActions).values({
                taskRunId, assistantId: assistantId ?? null,
                organisationId: run.organisationId ?? null,
                userId,
                actionType, reversibilityTier: tier,
                actionPayload, affectedRecordCount: affectedRecordCount ?? null,
                expiresAt,
            }).returning({ id: pendingActions.id });

            await db.insert(notifications).values({
                userId,
                type: 'action_rate_limited',
                title: 'Publishing rate limit reached',
                message: `Rate limit reached for ${actionType} actions in run #${taskRunId}. Review and release pending actions in your workspace.`,
                metadata: { taskRunId, assistantId: assistantId ?? null },
            }).catch(() => {});

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    decision: 'pending_approval',
                    tier,
                    pendingActionId: pending.id,
                    reason: `Tier 2 rate limit (${tier2Limit} actions/run) reached — queued for deployer release.`,
                }),
            };
        }

        // Within limit — auto-approve Tier 2
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'auto_approved', tier }),
        };
    }

    // ── Tier 3 / 4: always queue for HITL ────────────────────────────────────
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [pending] = await db.insert(pendingActions).values({
        taskRunId, assistantId: assistantId ?? null,
        organisationId: run.organisationId ?? null,
        userId,
        actionType, reversibilityTier: tier,
        actionPayload, affectedRecordCount: affectedRecordCount ?? null,
        expiresAt,
    }).returning({ id: pendingActions.id });

    const warning = tier === 4
        ? `⛔ Blast-radius action blocked pending HITL approval.`
        : `⚠ Hard-to-reverse action blocked pending HITL approval.`;

    await db.insert(notifications).values({
        userId,
        type: 'hitl_approval_required',
        title: `Approval required: ${actionType}`,
        message: `${warning} Run #${taskRunId} proposes: ${actionType}${affectedRecordCount ? ` (${affectedRecordCount} records affected)` : ''}. Expires in 24 hours.`,
        metadata: { taskRunId, pendingActionId: pending.id, assistantId: assistantId ?? null },
    }).catch(() => {});

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            decision: 'pending_approval',
            tier,
            pendingActionId: pending.id,
            reason: `Tier ${tier} action requires Human-in-the-Loop approval before execution.`,
        }),
    };
};
