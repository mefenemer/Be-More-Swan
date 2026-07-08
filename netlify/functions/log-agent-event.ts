// netlify/functions/log-agent-event.ts
// US-GOV-4.2.2: Record a single agent run event to the per-run audit trail.
// POST /.netlify/functions/log-agent-event
//   Body: {
//     taskRunId: number,
//     eventType: 'llm_call' | 'tool_call' | 'human_intervention' | 'suspension' | 'termination',
//     eventIndex: number,
//     toolName?: string,
//     inputPayload?: object,
//     outputPayload?: object,
//     durationMs?: number,
//     costGbp?: number,
//     // For final event — include summary fields:
//     summary?: { totalLlmCalls, totalToolCalls, totalTokens, totalCostGbp, wallClockMinutes, terminationReason, humanInterventionCount }
//   }
//   Auth: aura_session cookie (run owner)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { taskRuns, agentRunEvents, agentRunSummaries } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

// PII patterns to sanitise before logging
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const NAME_MARKERS = /\b(Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+\b/g;

function sanitise(value: unknown): unknown {
    if (typeof value === 'string') {
        return value
            .replace(EMAIL_RE, '[EMAIL]')
            .replace(NAME_MARKERS, '[PERSON]');
    }
    if (Array.isArray(value)) return value.map(sanitise);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = sanitise(v);
        }
        return out;
    }
    return value;
}

const VALID_EVENT_TYPES = ['llm_call', 'tool_call', 'human_intervention', 'suspension', 'termination'];

export default withLambda(async (event) => {
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

    const { taskRunId, eventType, eventIndex, toolName, inputPayload, outputPayload, durationMs, costGbp, summary } = body;

    if (!taskRunId || !eventType || eventIndex === undefined) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId, eventType, and eventIndex are required.' }) };
    }
    if (!VALID_EVENT_TYPES.includes(eventType)) {
        return { statusCode: 400, body: JSON.stringify({ error: `eventType must be one of: ${VALID_EVENT_TYPES.join(', ')}` }) };
    }

    const db = getDb();

    const [run] = await db
        .select({ id: taskRuns.id, organisationId: taskRuns.organisationId })
        .from(taskRuns)
        .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, userId)))
        .limit(1);

    if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };

    // Sanitise PII before persisting
    const safeInput  = inputPayload  ? sanitise(inputPayload)  : null;
    const safeOutput = outputPayload ? sanitise(outputPayload) : null;

    const [inserted] = await db.insert(agentRunEvents).values({
        taskRunId,
        organisationId: run.organisationId ?? null,
        eventType,
        eventIndex,
        toolName:      toolName ?? null,
        inputPayload:  safeInput  as any,
        outputPayload: safeOutput as any,
        durationMs:    durationMs  ?? null,
        costGbp:       costGbp != null ? String(costGbp) : null,
    }).returning({ id: agentRunEvents.id });

    // If a summary is included, upsert the run summary row
    if (summary && ['suspension', 'termination', 'completed'].includes(eventType)) {
        await db.insert(agentRunSummaries).values({
            taskRunId,
            organisationId:          run.organisationId ?? null,
            totalLlmCalls:           summary.totalLlmCalls    ?? 0,
            totalToolCalls:          summary.totalToolCalls   ?? 0,
            totalTokens:             summary.totalTokens      ?? 0,
            totalCostGbp:            String(summary.totalCostGbp ?? 0),
            wallClockMinutes:        summary.wallClockMinutes != null ? String(summary.wallClockMinutes) : null,
            terminationReason:       summary.terminationReason ?? eventType,
            humanInterventionCount:  summary.humanInterventionCount ?? 0,
        }).onConflictDoUpdate({
            target: agentRunSummaries.taskRunId,
            set: {
                totalLlmCalls:          summary.totalLlmCalls    ?? 0,
                totalToolCalls:         summary.totalToolCalls   ?? 0,
                totalTokens:            summary.totalTokens      ?? 0,
                totalCostGbp:           String(summary.totalCostGbp ?? 0),
                wallClockMinutes:       summary.wallClockMinutes != null ? String(summary.wallClockMinutes) : null,
                terminationReason:      summary.terminationReason ?? eventType,
                humanInterventionCount: summary.humanInterventionCount ?? 0,
            },
        });
    }

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: inserted.id }),
    };
});
