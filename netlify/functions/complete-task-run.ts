// netlify/functions/complete-task-run.ts
// US-DB-1.5.1: Worker signals run outcome — complete, fail, or enter review cycle.
// Also handles quality-reviewer verdict processing.
//
// POST /.netlify/functions/complete-task-run
//   Headers: X-Worker-Token
//   Body: {
//     taskRunId: number,
//     workerId: string,
//     outcome: 'completed' | 'failed' | 'submit_for_review',
//     reviewerAssistantId?: number,   // required when outcome='submit_for_review'
//     reviewVerdict?: 'approved' | 'revise' | 'escalated',  // for review cycle completion
//     failureReason?: string,
//   }
//
// Returns { status: string, requeued?: boolean }

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/client';
import { taskRuns } from '../../db/schema';
import { checkRepeatedTaskFailure } from '../../src/utils/churn';
import { logAiUsage } from '../../src/utils/ai-usage';
import { withLambda } from '@netlify/aws-lambda-compat';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SCORE_MODEL = 'claude-haiku-4-5-20251001';

async function scoreOutputConfidence(taskRunId: number, outputText: string, userId: number): Promise<void> {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await anthropic.messages.create({
            model: SCORE_MODEL,
            max_tokens: 256,
            messages: [{
                role: 'user',
                content: `You are a factual confidence reviewer for AI-generated task outputs.\n\nRespond with a single JSON object (no markdown):\n{\n  "confidenceLevel": "green" | "amber" | "red",\n  "verifyHint": "<one sentence — what to verify, or null if green>"\n}\n\nRules:\n- green: factually safe, no misleading claims\n- amber: contains unverified claims or ambiguous language\n- red: likely incorrect or could cause harm if used without verification\n\nOutput:\n"""\n${outputText.slice(0, 2000)}\n"""`,
            }],
        }, { signal: controller.signal as any });
        clearTimeout(timeoutId);

        const raw = (response.content[0] as any).text?.trim() || '{}';
        const parsed = JSON.parse(raw);
        const confidenceLevel = ['green', 'amber', 'red'].includes(parsed.confidenceLevel) ? parsed.confidenceLevel : 'amber';
        const verifyHint      = parsed.verifyHint || null;

        await logAiUsage({
            userId,
            model: SCORE_MODEL,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
        });

        const db = getDb();
        const [existing] = await db.select({ metadata: taskRuns.metadata }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
        await db.update(taskRuns).set({
            metadata: { ...(existing?.metadata as object || {}), confidenceLevel, verifyHint },
        }).where(eq(taskRuns.id, taskRunId));
    } catch {
        clearTimeout(timeoutId);
        // non-fatal — fall back to amber (set only if not already set)
        try {
            const db = getDb();
            const [existing] = await db.select({ metadata: taskRuns.metadata }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
            const meta = existing?.metadata as any || {};
            if (!meta.confidenceLevel) {
                await db.update(taskRuns).set({ metadata: { ...meta, confidenceLevel: 'amber', verifyHint: null } }).where(eq(taskRuns.id, taskRunId));
            }
        } catch { /* ignore */ }
    }
}

const WORKER_SECRET = process.env.WORKER_SECRET;
const MAX_REVIEW_CYCLES = 3;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const workerToken = event.headers['x-worker-token'];
    if (WORKER_SECRET && workerToken !== WORKER_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid worker token.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { taskRunId, workerId, outcome, reviewerAssistantId, reviewVerdict, failureReason, outputText } = body;
    if (!taskRunId || !workerId || !outcome) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId, workerId, and outcome are required.' }) };
    }

    const db = getDb();
    const now = new Date();

    const [run] = await db.select().from(taskRuns)
        .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.lockedBy, workerId)))
        .limit(1);

    if (!run) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Run not found or not owned by this worker.' }) };
    }

    // ── Completed ─────────────────────────────────────────────────────────────
    if (outcome === 'completed') {
        await db.update(taskRuns).set({
            status:         'completed',
            completedAt:    now,
            lockedBy:       null,
            lockedAt:       null,
            leaseExpiresAt: null,
        }).where(eq(taskRuns.id, taskRunId));
        if (outputText && typeof outputText === 'string' && outputText.trim()) {
            void scoreOutputConfidence(taskRunId, outputText.trim(), run.userId);
        }
        return { statusCode: 200, body: JSON.stringify({ status: 'completed' }) };
    }

    // ── Failed ────────────────────────────────────────────────────────────────
    if (outcome === 'failed') {
        const canRetry = (run.attemptCount ?? 0) < (run.maxAttempts ?? 3);
        await db.update(taskRuns).set({
            status:         canRetry ? 'pending' : 'failed',
            suspendReason:  failureReason?.trim() || null,
            lockedBy:       null,
            lockedAt:       null,
            leaseExpiresAt: null,
            ...(canRetry ? {} : { completedAt: now }),
        }).where(eq(taskRuns.id, taskRunId));
        if (!canRetry && run.assistantId) {
            void checkRepeatedTaskFailure(db, run.userId, run.assistantId, run.taskType || 'general');
        }
        return { statusCode: 200, body: JSON.stringify({ status: canRetry ? 'pending' : 'failed', requeued: canRetry }) };
    }

    // ── Submit for review ─────────────────────────────────────────────────────
    if (outcome === 'submit_for_review') {
        if (!reviewerAssistantId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'reviewerAssistantId required for submit_for_review.' }) };
        }
        await db.update(taskRuns).set({
            status:              'reviewing',
            reviewerAssistantId,
            reviewCycleCount:    (run.reviewCycleCount ?? 0) + 1,
            lockedBy:            null,
            lockedAt:            null,
            leaseExpiresAt:      null,
        }).where(eq(taskRuns.id, taskRunId));
        return { statusCode: 200, body: JSON.stringify({ status: 'reviewing' }) };
    }

    // ── Review verdict ────────────────────────────────────────────────────────
    if (outcome === 'review_verdict') {
        if (!reviewVerdict) {
            return { statusCode: 400, body: JSON.stringify({ error: 'reviewVerdict required.' }) };
        }
        const cycleCount = run.reviewCycleCount ?? 0;

        if (reviewVerdict === 'approved') {
            await db.update(taskRuns).set({
                status:        'completed',
                reviewVerdict: 'approved',
                completedAt:   now,
                lockedBy:      null,
                lockedAt:      null,
                leaseExpiresAt: null,
            }).where(eq(taskRuns.id, taskRunId));
            return { statusCode: 200, body: JSON.stringify({ status: 'completed' }) };
        }

        if (reviewVerdict === 'revise' && cycleCount < MAX_REVIEW_CYCLES) {
            // Re-queue for regeneration
            await db.update(taskRuns).set({
                status:         'pending',
                reviewVerdict:  'revise',
                lockedBy:       null,
                lockedAt:       null,
                leaseExpiresAt: null,
            }).where(eq(taskRuns.id, taskRunId));
            return { statusCode: 200, body: JSON.stringify({ status: 'pending', requeued: true }) };
        }

        // 'escalated' or max review cycles exceeded → failed
        await db.update(taskRuns).set({
            status:        'failed',
            reviewVerdict: reviewVerdict === 'escalated' ? 'escalated' : 'revise',
            suspendReason: reviewVerdict === 'escalated'
                ? 'escalated_by_reviewer'
                : `max_review_cycles_exceeded (${cycleCount})`,
            completedAt:   now,
            lockedBy:      null,
            lockedAt:      null,
            leaseExpiresAt: null,
        }).where(eq(taskRuns.id, taskRunId));
        if (run.assistantId) {
            void checkRepeatedTaskFailure(db, run.userId, run.assistantId, run.taskType || 'general');
        }
        return { statusCode: 200, body: JSON.stringify({ status: 'failed', reason: 'escalated_or_max_cycles' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown outcome: ${outcome}` }) };
});
