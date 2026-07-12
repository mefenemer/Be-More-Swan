// identify-leads.ts
// US-SALES-1.1 Part 4 — Nightly data analysis job.
// Scheduled via netlify.toml: runs every night at 02:00 UTC.
// Identifies users matching 4 behavioural patterns and upserts them into the leads table.

import { Handler } from '@netlify/functions';
import { eq, and, lt, lte, gte, isNull, sql, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, aiAssistants, taskRuns, leads, leadAnalysisRuns } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async () => {
    const db = getDb();
    const now = new Date();
    let leadsCreated = 0;
    let leadsUpdated = 0;
    // Free trial removed (product decision): the former "trial expiry" lead pattern is gone —
    // there are no trial plans to expire.
    const patternCounts: Record<string, number> = {
        never_onboarded: 0,
        cancellation_approaching: 0,
        upgrade_candidates: 0,
    };

    try {
        // ── (b) NEVER ONBOARDED: registered >48h ago, zero assistants, zero task runs ──
        const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const neverOnboardedRows = await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(
                and(
                    lt(users.createdAt, fortyEightHoursAgo),
                    eq(users.status, 'active'),
                    isNull(
                        db.select({ id: aiAssistants.id })
                            .from(aiAssistants)
                            .where(eq(aiAssistants.userId, users.id))
                            .limit(1)
                            .as('sub')
                    )
                )
            )
            .limit(500);

        // Fallback approach using raw SQL subquery for cleaner semantics
        const neverOnboardedSql = await db.execute<{ id: number; email: string }>(sql`
            SELECT u.id, u.email
            FROM users u
            WHERE u.created_at < NOW() - INTERVAL '48 hours'
              AND u.status = 'active'
              AND NOT EXISTS (
                  SELECT 1 FROM ai_assistants aa WHERE aa.user_id = u.id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM task_runs tr
                  INNER JOIN ai_assistants aa2 ON tr.assistant_id = aa2.id
                  WHERE aa2.user_id = u.id
              )
            LIMIT 500
        `);

        for (const row of neverOnboardedSql) {
            const res = await db.insert(leads)
                .values({
                    email: row.email,
                    opportunityReason: 'Never onboarded',
                    action: 'never_onboarded_identified',
                    leadType: 'never_onboarded',
                    source: 'data_analysis_job',
                    userId: row.id,
                    priority: 'medium',
                })
                .onConflictDoUpdate({
                    target: [leads.email, leads.opportunityReason],
                    set: { updatedAt: new Date() },
                })
                .returning({ id: leads.id });
            if (res[0]) leadsCreated++;
            patternCounts.never_onboarded++;
        }

        // ── (c) CANCELLATION APPROACHING: cancel_at_period_end cancelling within 7 days ──
        const cancelCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const cancellingRows = await db
            .select({
                userId: plans.userId,
                organisationId: plans.organisationId,
                email: users.email,
                planName: plans.planName,
                cancelledAt: plans.cancelledAt,
            })
            .from(plans)
            .innerJoin(users, eq(plans.userId, users.id))
            .where(
                and(
                    eq(plans.status, 'cancelling'),
                    lte(plans.cancelledAt, cancelCutoff),
                    gte(plans.cancelledAt, now),
                )
            );

        for (const row of cancellingRows) {
            if (!row.userId || !row.email) continue;
            const res = await db.insert(leads)
                .values({
                    email: row.email,
                    opportunityReason: `Cancellation initiated — ${row.planName}`,
                    action: 'cancellation_approaching',
                    leadType: 'cancellation_intent',
                    source: 'data_analysis_job',
                    userId: row.userId,
                    organisationId: row.organisationId,
                    priority: 'high',
                })
                .onConflictDoUpdate({
                    target: [leads.email, leads.opportunityReason],
                    set: { updatedAt: new Date() },
                })
                .returning({ id: leads.id });
            if (res[0]) leadsUpdated++;
            patternCounts.cancellation_approaching++;
        }

        // ── (d) UPGRADE CANDIDATES: task usage >80% for 3+ consecutive days ──
        // Uses a raw SQL window query — Drizzle doesn't support CONSECUTIVE day grouping natively.
        const upgradeCandidates = await db.execute<{ user_id: number; email: string; org_id: number; plan_name: string }>(sql`
            SELECT DISTINCT u.id AS user_id, u.email, p.organisation_id AS org_id, p.plan_name
            FROM plans p
            INNER JOIN users u ON p.user_id = u.id
            WHERE p.status = 'active'
              AND (
                SELECT COUNT(DISTINCT DATE(tr.created_at))
                FROM task_runs tr
                INNER JOIN ai_assistants aa ON tr.assistant_id = aa.id
                WHERE aa.user_id = u.id
                  AND tr.created_at >= NOW() - INTERVAL '5 days'
              ) >= 3
              AND (
                SELECT COUNT(*)
                FROM task_runs tr2
                INNER JOIN ai_assistants aa2 ON tr2.assistant_id = aa2.id
                WHERE aa2.user_id = u.id
                  AND tr2.created_at >= NOW() - INTERVAL '30 days'
              ) > COALESCE(
                (SELECT mp.monthlyTaskLimit FROM master_plans mp WHERE mp.id = p.master_plan_id) * 0.8,
                1000
              )
            LIMIT 200
        `);

        for (const row of upgradeCandidates) {
            const res = await db.insert(leads)
                .values({
                    email: row.email,
                    opportunityReason: `Upgrade candidate — high task volume`,
                    action: 'upgrade_candidate_identified',
                    leadType: 'upgrade_intent',
                    source: 'data_analysis_job',
                    userId: row.user_id,
                    organisationId: row.org_id,
                    priority: 'medium',
                })
                .onConflictDoUpdate({
                    target: [leads.email, leads.opportunityReason],
                    set: { updatedAt: new Date() },
                })
                .returning({ id: leads.id });
            if (res[0]) leadsCreated++;
            patternCounts.upgrade_candidates++;
        }

        // ── Write run summary ──────────────────────────────────────────────────
        await db.insert(leadAnalysisRuns).values({
            leadsCreated,
            leadsUpdated,
            patternCounts,
            status: 'success',
        });

        console.log(`[identify-leads] created=${leadsCreated} updated=${leadsUpdated}`, patternCounts);
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, leadsCreated, leadsUpdated, patternCounts }),
        };
    } catch (err: any) {
        console.error('[identify-leads] fatal error:', err);
        await db.insert(leadAnalysisRuns).values({
            leadsCreated,
            leadsUpdated,
            patternCounts,
            status: 'failed',
            errorMessage: err.message,
        }).catch(() => {});
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message }),
        };
    }
});
