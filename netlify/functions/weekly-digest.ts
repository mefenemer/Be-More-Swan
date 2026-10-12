// netlify/functions/weekly-digest.ts
// US-GAP-6.3.1: Weekly Usage Digest Email
//
// ⚠️ NOT SCHEDULED. There is deliberately no `[functions.weekly-digest]` entry in netlify.toml and
// no caller in .github/workflows, so this has never run anywhere. The digest is not sold — pricing
// describes basic reporting as the in-app Time-Saved Dashboard (2026-10-12) — and turning it on
// emails every paying workspace's owners weekly, so that is a product decision, not a deploy step.
// To enable: add `[functions.weekly-digest] schedule = "0 8 * * 1"` (Monday 08:00 UTC) next to the
// other crons in netlify.toml, and remember Netlify runs scheduled functions on PRODUCTION only —
// staging needs a poke from .github/workflows/staging-crons.yml to be exercised at all.
//
// One digest per WORKSPACE, not per user. A plan row is org-scoped (`plans.user_id` is only the
// purchaser and is nullable), so the first version's `plans.user_id = users.id` join reached the
// buyer alone, never an invited admin, and sent one email per plan row a person had bought.
//
// For each org with an `active` plan (beta plans included — they are `active` with plan_type 'beta';
// `past_due` is skipped, a dunning week is the wrong time for a "look what you got" email):
//   - skip if it has no non-archived assistant, or nothing was produced in the last 7 days
//   - count the week's work through src/utils/roi-activity.ts — the SAME module the dashboard's
//     "Tasks Handled / Hours Saved" tiles use, so the email can never disagree with the page it
//     links to. A degraded count (a source query failed) is not sent rather than sent low.
//   - read tasks used from usage_counters, the counter the task cap actually enforces, against
//     resolveTaskLimit() — not a raw task_runs count, which misses background work entirely
//   - send to the org's OWNERS and ADMINS (the people who manage the workspace and its allowance),
//     each gated on their own "Assistant Tasks & Summaries" email preference, plus the legacy
//     `weekly_digest: false` key so an old opt-out stays honoured
//   - render through the admin-editable `weekly_digest` template (email-templates-catalog.ts), so
//     copy, branding and the unsubscribe footer come from the shared shell
//
// Queries are batched per org, not per user: functions run in us-east-1 against a London DB at
// 0.5–4 s a round trip, and a per-user N+1 would run into the scheduled-function time limit.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, plans, userOrganisations, userProfiles, users } from '../../db/schema';
import { sendTemplatedEmail } from '../../src/utils/email';
import { isEmailEnabled } from '../../src/utils/notification-prefs';
import { activeAssistantIds, countRoiActivity } from '../../src/utils/roi-activity';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { resolveTaskLimit } from '../../src/utils/task-credit';
import { getPeriodStart } from '../../src/utils/atomic-cap-check';
import { withLambda } from '@netlify/aws-lambda-compat';

const BASE_URL = process.env.BASE_URL || '';

/** Roles that receive the digest. Plain members can see the same figures on the dashboard. */
export const DIGEST_ROLES = ['owner', 'admin'];

export async function runWeeklyDigest(now = new Date()) {
    const db = getDb();
    const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const periodStart = getPeriodStart();
    const multipliers = await getTimeMultipliers();

    // plans_one_active_per_org_unique guarantees at most one active plan per org, so this is one
    // row per org.
    const orgRows = await db
        .select({ organisationId: plans.organisationId, workspaceName: organisations.name })
        .from(plans)
        .innerJoin(organisations, eq(organisations.id, plans.organisationId))
        .where(eq(plans.status, 'active'));

    let sent = 0;
    let skipped = 0;

    for (const org of orgRows) {
        try {
            const assistantIds = await activeAssistantIds(db, org.organisationId);
            if (assistantIds.length === 0) { skipped++; continue; }

            const activity = await countRoiActivity(db, {
                organisationId: org.organisationId, assistantIds, windowStart, multipliers,
            });
            if (activity.degraded) {
                console.warn(`[weekly-digest] org=${org.organisationId}: activity count degraded — not sending`);
                skipped++; continue;
            }
            if (activity.completedTasks === 0) { skipped++; continue; }

            const recipients = await db
                .select({
                    userId: users.id,
                    email: users.email,
                    firstName: users.firstName,
                    emailPrefs: userProfiles.emailPreferences,
                })
                .from(userOrganisations)
                .innerJoin(users, eq(users.id, userOrganisations.userId))
                .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
                .where(and(
                    eq(userOrganisations.organisationId, org.organisationId),
                    inArray(userOrganisations.role, DIGEST_ROLES),
                    eq(users.status, 'active'),
                ));

            const wanted = recipients.filter(r => {
                const prefs = (r.emailPrefs || {}) as Record<string, boolean>;
                return prefs.weekly_digest !== false && isEmailEnabled(prefs, 'assistant_task');
            });
            if (wanted.length === 0) { skipped++; continue; }

            const { limit } = await resolveTaskLimit(db, org.organisationId);
            const usageRows = await db.execute(sql`
                SELECT task_count FROM usage_counters
                 WHERE organisation_id = ${org.organisationId} AND period_start = ${periodStart.toISOString()}
                 LIMIT 1`);
            const tasksUsed = Number((usageRows as unknown as Array<{ task_count: number }>)[0]?.task_count ?? 0);

            for (const r of wanted) {
                try {
                    const result = await sendTemplatedEmail({
                        triggerKey: 'weekly_digest',
                        to: r.email,
                        vars: {
                            user: { first_name: r.firstName ?? '' },
                            workspace: { name: org.workspaceName },
                            digest: {
                                tasks_handled: String(activity.completedTasks),
                                hours_saved: String(activity.hoursSaved),
                                tasks_used: String(tasksUsed),
                                task_allowance: limit == null ? 'unlimited' : String(limit),
                            },
                            link: { action_url: `${BASE_URL}/workspace.html` },
                        },
                    });
                    // null = template missing or deactivated by an admin; nothing was sent.
                    if (result === null) skipped++; else sent++;
                } catch (err) {
                    console.warn(`[weekly-digest] Email failed for userId=${r.userId}:`, err);
                    skipped++;
                }
            }
        } catch (err) {
            // One org's fault must not stop every later org's digest.
            console.error(`[weekly-digest] org=${org.organisationId} failed:`, err);
            skipped++;
        }
    }

    console.log(`[weekly-digest] Done — sent=${sent}, skipped=${skipped}`);
    return { sent, skipped };
}

export default withLambda(async () => {
    try {
        await runWeeklyDigest();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[weekly-digest]', err);
        return { statusCode: 500 };
    }
});
