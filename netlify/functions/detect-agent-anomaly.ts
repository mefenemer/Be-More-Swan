// netlify/functions/detect-agent-anomaly.ts
// US-GOV-4.2.1: Anomaly-Based Agent Kill-Switch.
// Called by the agent execution layer after each tool call to check for anomalous patterns.
// POST /.netlify/functions/detect-agent-anomaly
//   Body: {
//     taskRunId: number,
//     assistantId: number,
//     recentToolCalls: Array<{ name: string, params: object, status: 'ok'|'error'|'rate_limited', timestamp: string }>,
//   }
//   Auth: aura_session cookie (run owner)
//
// Returns { anomalyDetected: boolean, anomalyType?, anomalyId?, action: 'continue'|'suspend'|'terminate' }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, avg, eq, gte, isNull, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, taskRuns, aiAssistants, agentAnomalies,
    agentAnomalyThresholds, agentRunSummaries,
} from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

interface ToolCall {
    name: string;
    params: object;
    status: 'ok' | 'error' | 'rate_limited';
    timestamp: string;
}

function detectLoop(calls: ToolCall[], limit: number): boolean {
    if (calls.length < limit) return false;
    const last = calls.slice(-limit);
    const first = last[0];
    return last.every(c =>
        c.name === first.name &&
        JSON.stringify(c.params) === JSON.stringify(first.params)
    );
}

function detectErrorRate(calls: ToolCall[], windowMs: number, threshold: number): boolean {
    const now = Date.now();
    const windowCalls = calls.filter(c => now - new Date(c.timestamp).getTime() <= windowMs);
    if (windowCalls.length < 3) return false; // too few to judge
    const errorCount = windowCalls.filter(c => c.status === 'error').length;
    return (errorCount / windowCalls.length) * 100 >= threshold;
}

function detectConsecutiveRateLimits(calls: ToolCall[], consecutiveLimit: number): boolean {
    if (calls.length < consecutiveLimit) return false;
    return calls.slice(-consecutiveLimit).every(c => c.status === 'rate_limited');
}

async function detectRateAnomaly(
    db: ReturnType<typeof getDb>,
    assistantId: number | null,
    currentRunToolCallCount: number,
    multiplier: number,
): Promise<boolean> {
    if (!assistantId || currentRunToolCallCount < 5) return false; // too few calls to be meaningful
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [row] = await db
        .select({ avgToolCalls: avg(agentRunSummaries.totalToolCalls) })
        .from(agentRunSummaries)
        .innerJoin(taskRuns, eq(taskRuns.id, agentRunSummaries.taskRunId))
        .where(and(
            eq(taskRuns.assistantId, assistantId),
            gte(agentRunSummaries.createdAt, sevenDaysAgo),
        ));
    const rollingAvg = parseFloat(String(row?.avgToolCalls ?? '0'));
    if (rollingAvg < 1) return false; // no baseline yet
    return currentRunToolCallCount > rollingAvg * multiplier;
}

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

    const { taskRunId, assistantId, recentToolCalls } = body;
    if (!taskRunId || !Array.isArray(recentToolCalls)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId and recentToolCalls[] are required.' }) };
    }

    const db = getDb();

    // Load the run — verify it belongs to this user and is in a runnable state
    const [run] = await db.select({
        id: taskRuns.id,
        status: taskRuns.status,
        organisationId: taskRuns.organisationId,
        anomalyCount: taskRuns.anomalyCount,
    }).from(taskRuns).where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, userId))).limit(1);

    if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };
    if (run.status === 'suspended') {
        return { statusCode: 200, body: JSON.stringify({ anomalyDetected: false, action: 'suspended', message: 'Run is already suspended — awaiting manual resume.' }) };
    }
    if (run.status === 'terminated') {
        return { statusCode: 200, body: JSON.stringify({ anomalyDetected: false, action: 'terminate', message: 'Run is permanently terminated.' }) };
    }

    // Load thresholds (workspace override takes precedence over platform default)
    const thresholdRows = await db.select().from(agentAnomalyThresholds).where(
        or(
            isNull(agentAnomalyThresholds.organisationId),
            run.organisationId ? eq(agentAnomalyThresholds.organisationId, run.organisationId) : isNull(agentAnomalyThresholds.organisationId),
        )
    );
    // Workspace-specific row overrides platform default
    const wsThreshold = thresholdRows.find(r => r.organisationId === run.organisationId);
    const thresholds = wsThreshold ?? thresholdRows.find(r => r.organisationId === null) ?? {
        loopDetectionLimit: 5,
        toolRateMultiplier: 2,
        errorRatePercent: 20,
        consecutiveRateLimitHits: 3,
    };

    // Detect anomalies — checked in severity order
    let anomalyType: string | null = null;
    if (detectLoop(recentToolCalls, thresholds.loopDetectionLimit)) {
        anomalyType = 'loop';
    } else if (detectErrorRate(recentToolCalls, 5 * 60 * 1000, thresholds.errorRatePercent)) {
        anomalyType = 'error_rate';
    } else if (detectConsecutiveRateLimits(recentToolCalls, thresholds.consecutiveRateLimitHits)) {
        anomalyType = 'consecutive_429';
    } else if (await detectRateAnomaly(db, assistantId ?? null, recentToolCalls.length, thresholds.toolRateMultiplier ?? 2)) {
        anomalyType = 'tool_call_rate';
    }

    if (!anomalyType) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anomalyDetected: false, action: 'continue' }),
        };
    }

    // Anomaly detected — determine action
    // Second anomaly in same run → permanently terminate
    const isPermanentTermination = (run.anomalyCount ?? 0) >= 1;
    const newStatus = isPermanentTermination ? 'terminated' : 'suspended';

    await db.update(taskRuns)
        .set({ status: newStatus, anomalyCount: (run.anomalyCount ?? 0) + 1 })
        .where(eq(taskRuns.id, taskRunId));

    const [anomaly] = await db.insert(agentAnomalies).values({
        taskRunId,
        assistantId: assistantId ?? null,
        organisationId: run.organisationId ?? null,
        userId,
        anomalyType,
        toolCallExcerpt: recentToolCalls.slice(-10), // last 10 calls for context
        status: newStatus === 'terminated' ? 'terminated' : 'suspended',
        ...(newStatus === 'terminated' ? { terminatedAt: new Date() } : {}),
    }).returning();

    // Notify the run owner
    await createNotification(db, newStatus === 'terminated' ? 'agent_run_terminated' : 'agent_run_suspended', {
        userId,
        context: { anomaly: { type: anomalyType.replace('_', ' ') }, run: { id: taskRunId } },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            anomalyDetected: true,
            anomalyType,
            anomalyId: anomaly.id,
            action: newStatus === 'terminated' ? 'terminate' : 'suspend',
            runStatus: newStatus,
        }),
    };
});
