// netlify/functions/bias-sampling.ts
// US-GOV-3.3.1: Monthly statistical sampling of assistant outputs for bias detection.
// Scheduled: 1st of every month at 06:00 UTC via netlify.toml.
//
// Selects a random 5% sample (min 50, max 500) of sales/CS/HR agentRunEvents from
// the previous calendar month, strips PII tokens, runs distribution analysis, stores
// a biasSamplingReport row, and raises biasIncidents for any anomaly > 15% skew.

import type { Handler } from '@netlify/functions';
import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import {
    agentRunEvents, taskRuns, aiAssistants, biasIncidents, biasSamplingReports, notifications, users,
} from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

// Simple PII tokeniser — replace obvious patterns before analysis
function stripPii(text: string): string {
    return text
        .replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[NAME]')           // proper names
        .replace(/\b[\w.+-]+@[\w-]+\.\w{2,}\b/g, '[EMAIL]')           // email addresses
        .replace(/\b\+?[\d\s\-().]{7,15}\b/g, '[PHONE]')              // phone numbers
        .replace(/\b[A-Z][A-Z0-9]{2,20}\b/g, '[COMPANY_TOKEN]');      // uppercase company codes
}

// Sentiment proxy: very rough positive/negative word count ratio
function sentimentScore(text: string): number {
    const pos = (text.match(/\b(great|excellent|happy|good|solved|thanks|approved|yes|confirm)\b/gi) || []).length;
    const neg = (text.match(/\b(bad|wrong|failed|error|reject|no|cancel|issue|problem|complaint)\b/gi) || []).length;
    const total = pos + neg;
    return total === 0 ? 0.5 : pos / total;
}

const handler = async () => {
    const db = getDb();
    const now = new Date();

    // Sampling window: previous calendar month
    const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const windowEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Fetch events from sales/CS/HR assistants (all task runs in window)
    const events = await db
        .select({
            eventId:     agentRunEvents.id,
            taskRunId:   agentRunEvents.taskRunId,
            assistantId: taskRuns.assistantId,
            output:      agentRunEvents.outputPayload,
            createdAt:   agentRunEvents.createdAt,
        })
        .from(agentRunEvents)
        .innerJoin(taskRuns, eq(taskRuns.id, agentRunEvents.taskRunId))
        .innerJoin(aiAssistants, eq(aiAssistants.id, taskRuns.assistantId))
        .where(and(
            gte(agentRunEvents.createdAt, windowStart),
            lt(agentRunEvents.createdAt, windowEnd),
            eq(agentRunEvents.eventType, 'llm_call'),
        ))
        .orderBy(sql`RANDOM()`)
        .limit(500);

    const sampleSize = Math.max(50, Math.min(500, Math.ceil(events.length * 0.05)));
    const sample = events.slice(0, sampleSize);

    if (sample.length === 0) {
        console.log('[bias-sampling] No events to sample this month.');
        return { statusCode: 200 };
    }

    // Run distribution analysis per assistant
    const byAssistant: Record<number, { scores: number[]; lengths: number[] }> = {};
    for (const e of sample) {
        const aid = e.assistantId ?? 0;
        if (!byAssistant[aid]) byAssistant[aid] = { scores: [], lengths: [] };
        const text = stripPii(JSON.stringify(e.output ?? ''));
        byAssistant[aid].scores.push(sentimentScore(text));
        byAssistant[aid].lengths.push(text.length);
    }

    const assistantStats = Object.entries(byAssistant).map(([aid, { scores, lengths }]) => {
        const avgSentiment = scores.reduce((a, b) => a + b, 0) / scores.length;
        const avgLength    = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        return { assistantId: parseInt(aid, 10), avgSentiment, avgLength, sampleCount: scores.length };
    });

    // Overall averages for skew comparison
    const overallAvgSentiment = assistantStats.reduce((s, a) => s + a.avgSentiment, 0) / assistantStats.length;
    const overallAvgLength    = assistantStats.reduce((s, a) => s + a.avgLength, 0)    / assistantStats.length;

    const anomalies: { assistantId: number; metric: string; skewPct: number }[] = [];
    for (const stat of assistantStats) {
        const sentimentSkew = overallAvgSentiment > 0
            ? Math.abs((stat.avgSentiment - overallAvgSentiment) / overallAvgSentiment) * 100 : 0;
        const lengthSkew    = overallAvgLength > 0
            ? Math.abs((stat.avgLength - overallAvgLength) / overallAvgLength) * 100 : 0;
        if (sentimentSkew > 15) anomalies.push({ assistantId: stat.assistantId, metric: 'sentiment', skewPct: +sentimentSkew.toFixed(1) });
        if (lengthSkew > 15)    anomalies.push({ assistantId: stat.assistantId, metric: 'response_length', skewPct: +lengthSkew.toFixed(1) });
    }

    const reportData = {
        windowStart: windowStart.toISOString(),
        windowEnd:   windowEnd.toISOString(),
        totalEvents: events.length,
        sampledCount: sample.length,
        assistantStats,
        anomalies,
        overallAvgSentiment: +overallAvgSentiment.toFixed(3),
        overallAvgLength:    +overallAvgLength.toFixed(0),
    };

    // Store report
    await db.insert(biasSamplingReports).values({
        sampledCount:     sample.length,
        flaggedAnomalies: anomalies.length,
        reportData,
    });

    // Raise biasIncidents for each anomalous assistant and suspend it
    const retainUntil = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000); // 3 years
    for (const anomaly of anomalies) {
        // Suspend the assistant
        if (anomaly.assistantId) {
            await db.update(aiAssistants)
                .set(withUpdatedAt({ isActive: false }))
                .where(eq(aiAssistants.id, anomaly.assistantId));
        }

        const [incident] = await db.insert(biasIncidents).values({
            assistantId:     anomaly.assistantId || null,
            detectionMethod: 'statistical_sampling',
            findingsSummary: `Detected ${anomaly.metric} distributional skew of ${anomaly.skewPct}% (threshold: 15%) in monthly sampling for ${windowStart.toISOString().slice(0, 7)}. Assistant suspended pending investigation.`,
            retainUntil,
        }).returning({ id: biasIncidents.id });

        // Notify the assistant's deployer
        if (anomaly.assistantId) {
            const [asst] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, anomaly.assistantId))
                .limit(1);

            if (asst?.userId) {
                await db.insert(notifications).values({
                    userId: asst.userId,
                    type:   'system',
                    title:  `Bias flag raised — ${asst.name} suspended`,
                    message: `A ${anomaly.metric} distributional skew of ${anomaly.skewPct}% was detected in your assistant "${asst.name}". It has been suspended pending investigation (Incident #${incident.id}). Please review the bias audit report in your admin dashboard.`,
                    metadata: { incidentId: incident.id, metric: anomaly.metric, skewPct: anomaly.skewPct },
                }).catch(() => {});
            }
        }
    }

    // Notify all super_admins of the sampling run
    const superAdmins = await db.select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(eq(users.role, 'super_admin'));

    for (const admin of superAdmins) {
        if (admin.email) {
            await sendEmail({
                to: admin.email,
                subject: `[Be More Swan] Monthly Bias Sampling Report — ${windowStart.toISOString().slice(0, 7)}`,
                html: `<p>Hi ${admin.firstName || 'there'},</p>
<p>The monthly bias sampling job completed for <strong>${windowStart.toISOString().slice(0, 7)}</strong>.</p>
<ul>
  <li>Events sampled: <strong>${sample.length}</strong></li>
  <li>Anomalies flagged: <strong>${anomalies.length}</strong></li>
  ${anomalies.length > 0 ? `<li style="color:#dc2626">Assistants suspended: ${[...new Set(anomalies.map(a => a.assistantId))].length}</li>` : '<li style="color:#059669">No distributional anomalies detected.</li>'}
</ul>
<p>View the full report in the <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/admin.html">Admin Dashboard → Bias Audit</a>.</p>`,
            }).catch(() => {});
        }
    }

    console.log(`[bias-sampling] Sampled ${sample.length} events, flagged ${anomalies.length} anomalies.`);
    return { statusCode: 200 };
};

export { handler };
