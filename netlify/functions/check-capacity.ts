// check-capacity.ts
// GET → returns the authenticated user's assistant & task capacity metrics.
// Used by the workspace before letting the user hire a new assistant (SC2)
// and by the task-volume notification logic (SC3).
//
// Response shape:
// {
//   assistantCount: number,          // active assistants right now
//   assistantLimit: number|null,     // null = unlimited
//   taskCount: number,               // task_runs this calendar month
//   taskLimit: number|null,          // null = unlimited
//   tokenUsage: number,              // tokens used this calendar month (sum of taskRuns.tokensUsed)
//   monthlyTokenLimit: number|null,  // null = unlimited
//   appConnectionLimit: number|null, // per-assistant max connections; null = unlimited
//   assistantPct: number,            // 0-100
//   taskPct: number,                 // 0-100
//   tokenPct: number,                // 0-100
//   tierKey: string|null,
//   tierName: string|null,
//   gracePeriodEndsAt: string|null,  // ISO string if plan is past_due with grace period active
//   nextPlan: { tierKey, name, monthlyPriceGbp, assistantLimit } | null,  // null = already on highest plan
// }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and, gte, gt, count, sum, asc, desc, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { plans, masterPlans, planPrices, aiAssistants, taskRuns, usageCounters, userOrganisations, users, systemConnections, organisations } from '../../db/schema';
import { getPeriodStart } from '../../src/utils/atomic-cap-check';

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    try {
        const db = getDb();

        // ── 1. Resolve the user's current active plan & its limits ──
        const activePlan = await db
            .select({
                planId: plans.id,
                planStatus: plans.status,
                planType: plans.planType,
                expiresAt: plans.expiresAt,
                gracePeriodEndsAt: plans.gracePeriodEndsAt,
                masterPlanId: plans.masterPlanId,
                tierKey: masterPlans.tierKey,
                tierName: masterPlans.name,
                monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                assistantLimit: masterPlans.assistantLimit,
                monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                appConnectionLimit: masterPlans.appConnectionLimit,
                seatLimit: masterPlans.seatLimit,
                features: masterPlans.features,
            })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .orderBy(plans.startedAt)
            .limit(1);

        // Also check for past_due plans (grace period)
        const pastDuePlan = activePlan.length === 0
            ? await db
                .select({
                    planId: plans.id,
                    planStatus: plans.status,
                    planType: plans.planType,
                    expiresAt: plans.expiresAt,
                    gracePeriodEndsAt: plans.gracePeriodEndsAt,
                    masterPlanId: plans.masterPlanId,
                    stripeCustomerId: plans.stripeCustomerId,
                    tierKey: masterPlans.tierKey,
                    tierName: masterPlans.name,
                    monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                    assistantLimit: masterPlans.assistantLimit,
                    monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                    monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                    appConnectionLimit: masterPlans.appConnectionLimit,
                    seatLimit: masterPlans.seatLimit,
                    features: masterPlans.features,
                })
                .from(plans)
                .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.userId, userId), eq(plans.status, 'past_due')))
                .orderBy(plans.startedAt)
                .limit(1)
            : [];

        // SC6c: check for expired trial plans when no active or past_due plan exists
        const expiredTrialPlan = (activePlan.length === 0 && pastDuePlan.length === 0)
            ? await db
                .select({ planType: plans.planType, expiresAt: plans.expiresAt })
                .from(plans)
                .where(and(eq(plans.userId, userId), eq(plans.planType, 'trial'), eq(plans.status, 'expired')))
                .orderBy(desc(plans.expiresAt))
                .limit(1)
            : [];

        const plan = activePlan[0] ?? pastDuePlan[0] ?? null;
        // Referral Program Expansion: bonus_assistants (earned via referral tokens) stacks on
        // top of the tier limit below, once orgId is resolved (AC2.2/AC4.2).
        let assistantLimit: number | null = plan?.assistantLimit ?? null;
        const monthlyTaskLimit: number | null = plan?.monthlyTaskLimit ?? null;
        const monthlyTokenLimit: number | null = plan?.monthlyTokenLimit ?? null;
        const appConnectionLimit: number | null = plan?.appConnectionLimit ?? null;
        const seatLimit: number | null = plan?.seatLimit ?? null;

        // ── 2. Resolve orgId and count seats ─────────────────────────────
        const [userOrg] = await db
            .select({ organisationId: userOrganisations.organisationId })
            .from(userOrganisations)
            .where(eq(userOrganisations.userId, userId))
            .limit(1);

        const orgId = userOrg?.organisationId ?? null;

        // Add referral bonus assistants to the tier limit (null tier = unlimited, bonus moot).
        let bonusAssistants = 0;
        let betaAccess = false;
        if (orgId) {
            const [org] = await db.select({ bonusAssistants: organisations.bonusAssistants, betaAccess: organisations.betaAccess })
                .from(organisations).where(eq(organisations.id, orgId)).limit(1);
            bonusAssistants = org?.bonusAssistants ?? 0;
            betaAccess = org?.betaAccess ?? false;
            if (assistantLimit !== null) assistantLimit += bonusAssistants;
        }

        let seatCount = 1;
        if (orgId) {
            const [{ value: orgMemberCount }] = await db
                .select({ value: count() })
                .from(userOrganisations)
                .where(eq(userOrganisations.organisationId, orgId));
            seatCount = orgMemberCount || 1;
        }

        // US-DB-1.4.1: Counts are now org-level, not user-level
        // Assistants occupying a seat across the whole organisation.
        // US2 (Digital Assistant Lifecycle): count by lifecycle state rather than isActive.
        // A newly provisioned assistant now sits in `ready_for_work` (inactive) until the user
        // kicks it off, so an isActive-only count would let users provision past their plan
        // limit. provisioning/ready_for_work/working all occupy a seat; paused, system_paused
        // and archived do not (preserves the prior "paused frees a seat" behaviour).
        const [{ value: assistantCount }] = await db
            .select({ value: count() })
            .from(aiAssistants)
            .where(and(
                orgId ? eq(aiAssistants.organisationId, orgId) : eq(aiAssistants.userId, userId),
                inArray(aiAssistants.lifecycleStatus, ['provisioning', 'ready_for_work', 'working']),
            ));

        // ── 3. Task & token counts from usageCounters (authoritative) ──
        // Fall back to live COUNT if no usage_counters row exists yet (new org)
        const periodStart = getPeriodStart();
        let taskCount  = 0;
        let tokenUsage = 0;

        if (orgId) {
            const [ucRow] = await db
                .select({ taskCount: usageCounters.taskCount, tokenCount: usageCounters.tokenCount })
                .from(usageCounters)
                .where(and(
                    eq(usageCounters.organisationId, orgId),
                    eq(usageCounters.periodStart, periodStart),
                ))
                .limit(1);

            if (ucRow) {
                taskCount  = ucRow.taskCount  ?? 0;
                tokenUsage = ucRow.tokenCount ?? 0;
            } else {
                // No counter row yet — fall back to live aggregate (pre-migration orgs)
                const [taskStats] = await db
                    .select({ taskCount: count(), tokenUsage: sum(taskRuns.tokensUsed) })
                    .from(taskRuns)
                    .where(and(
                        eq(taskRuns.organisationId, orgId),
                        gte(taskRuns.createdAt, periodStart),
                    ));
                taskCount  = taskStats?.taskCount  ?? 0;
                tokenUsage = Number(taskStats?.tokenUsage ?? 0);
            }
        } else {
            // Solo user with no org — live aggregate keyed on userId
            const [taskStats] = await db
                .select({ taskCount: count(), tokenUsage: sum(taskRuns.tokensUsed) })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.userId, userId),
                    gte(taskRuns.createdAt, periodStart),
                ));
            taskCount  = taskStats?.taskCount  ?? 0;
            tokenUsage = Number(taskStats?.tokenUsage ?? 0);
        }

        // ── 4a. US-DB-1.3.1: count app connections by assistantId for cap enforcement ──
        // Returns the max connection count across all active assistants in the org,
        // so the UI can gate adding new integrations when appConnectionLimit is reached.
        let maxAppConnectionCount = 0;
        let connectedPlatforms: string[] = [];
        if (orgId) {
            const connRows = await db
                .select({ assistantId: systemConnections.assistantId, cnt: count(), serviceName: systemConnections.serviceName })
                .from(systemConnections)
                .where(and(
                    eq(systemConnections.organisationId, orgId),
                    eq(systemConnections.isActive, true),
                ))
                .groupBy(systemConnections.assistantId, systemConnections.serviceName);
            if (appConnectionLimit !== null) {
                maxAppConnectionCount = connRows.reduce((m, r) => Math.max(m, r.cnt), 0);
            }
            const SOCIAL_PLATFORMS = new Set(['instagram', 'facebook', 'x', 'twitter', 'linkedin', 'tiktok', 'youtube', 'pinterest']);
            connectedPlatforms = [...new Set(
                connRows.map(r => r.serviceName.toLowerCase()).filter(s => SOCIAL_PLATFORMS.has(s))
            )];
        }

        // ── 4. Compute percentages ──────────────────────────────────
        const assistantPct = assistantLimit
            ? Math.min(100, Math.round((assistantCount / assistantLimit) * 100))
            : 0;
        const taskPct = monthlyTaskLimit
            ? Math.min(100, Math.round((taskCount / monthlyTaskLimit) * 100))
            : 0;
        const tokenPct = monthlyTokenLimit
            ? Math.min(100, Math.round((tokenUsage / monthlyTokenLimit) * 100))
            : 0;

        // ── 5. Resolve next plan tier (for upgrade modal SC2 / SC5) ──────────
        // Find the cheapest plan that costs more than the current plan — that's the next tier up.
        // Returns null if the user is already on the highest-paid plan (enterprise contact path).
        const userCurrency = (plan as any)?.currency || 'GBP';
        let nextPlan: { tierKey: string; name: string; monthlyPriceGbp: string; monthlyPrice: string; assistantLimit: number | null } | null = null;
        if (plan?.monthlyPriceGbp != null) {
            const [nextTierRow] = await db
                .select({
                    tierKey: masterPlans.tierKey,
                    name: masterPlans.name,
                    monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                    assistantLimit: masterPlans.assistantLimit,
                    masterPlanId: masterPlans.id,
                })
                .from(masterPlans)
                .where(and(
                    eq(masterPlans.isActive, true),
                    gt(masterPlans.monthlyPriceGbp, plan.monthlyPriceGbp as any),
                ))
                .orderBy(asc(masterPlans.monthlyPriceGbp))
                .limit(1);
            if (nextTierRow) {
                // US-I18N-2.1 SC5: look up price in user's billing currency
                let monthlyPrice = String(nextTierRow.monthlyPriceGbp);
                if (userCurrency !== 'GBP') {
                    const [priceRow] = await db
                        .select({ monthlyPriceMajorUnit: planPrices.monthlyPriceMajorUnit })
                        .from(planPrices)
                        .where(and(eq(planPrices.masterPlanId, nextTierRow.masterPlanId), eq(planPrices.currency, userCurrency), eq(planPrices.isActive, true)))
                        .limit(1);
                    if (priceRow) monthlyPrice = String(priceRow.monthlyPriceMajorUnit);
                }
                nextPlan = { tierKey: nextTierRow.tierKey, name: nextTierRow.name, monthlyPriceGbp: String(nextTierRow.monthlyPriceGbp), monthlyPrice, assistantLimit: nextTierRow.assistantLimit };
            }
        }

        // ── 6. Grace period — expose expiry for UI warning banner ───
        const gracePeriodEndsAt = plan?.gracePeriodEndsAt
            ? (plan.gracePeriodEndsAt as Date).toISOString()
            : null;
        const graceExpired = gracePeriodEndsAt ? new Date() > new Date(gracePeriodEndsAt) : false;

        // ── 7. US-GAP-3.1.1 SC1/SC2: past_due invoice details for Payment Required banner ─
        let pastDueAmountGbp: string | null = null;
        let pastDueAttemptCount: number | null = null;
        let stripePortalUrl: string | null = null;
        if (plan?.planStatus === 'past_due' && (plan as any).stripeCustomerId && stripe) {
            try {
                const openInvoices = await stripe.invoices.list({
                    customer: (plan as any).stripeCustomerId,
                    status: 'open',
                    limit: 1,
                });
                const inv = openInvoices.data[0];
                if (inv) {
                    pastDueAmountGbp  = ((inv.amount_due || 0) / 100).toFixed(2);
                    pastDueAttemptCount = (inv as any).attempt_count ?? null;
                }
                // Generate Stripe billing portal URL
                const portal = await stripe.billingPortal.sessions.create({
                    customer: (plan as any).stripeCustomerId,
                    return_url: (process.env.BASE_URL || '') + '/billing.html',
                });
                stripePortalUrl = portal.url;
            } catch { /* non-critical — banner will still show without amount */ }
        }

        const seatPct = seatLimit
            ? Math.min(100, Math.round((seatCount / seatLimit) * 100))
            : 0;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assistantCount,
                assistantLimit,
                bonusAssistants,
                betaAccess,
                features: (plan as any)?.features ?? {}, // AC3.2.4: active plan's feature unlocks
                taskCount,
                taskLimit: monthlyTaskLimit,
                tokenUsage,
                monthlyTokenLimit,
                appConnectionLimit,
                appConnectionCount: maxAppConnectionCount,
                seatCount,
                seatLimit,
                seatPct,
                assistantPct,
                taskPct,
                tokenPct,
                tierKey: plan?.tierKey ?? null,
                tierName: plan?.tierName ?? null,
                planStatus: plan?.planStatus ?? null,
                planType: plan?.planType ?? null,
                gracePeriodEndsAt,
                graceExpired,    // true if grace period has passed and access should be blocked
                // US-GAP-8.1.1 SC3/SC6c: trial countdown badge and expired gate data
                trialExpired: expiredTrialPlan.length > 0,
                isTrial: plan?.planType === 'trial',
                trialExpiresAt: plan?.planType === 'trial' && plan?.expiresAt
                    ? (plan.expiresAt instanceof Date ? plan.expiresAt : new Date(plan.expiresAt as string)).toISOString()
                    : null,
                trialDaysRemaining: plan?.planType === 'trial' && plan?.expiresAt
                    ? Math.max(0, Math.ceil((new Date(plan.expiresAt instanceof Date ? plan.expiresAt : plan.expiresAt as string).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
                    : null,
                currency: userCurrency,      // US-I18N-2.1 SC5: user's billing currency
                pastDueAmountGbp,            // amount owed on open Stripe invoice (SC2)
                pastDueAmount: pastDueAmountGbp, // alias — use formatCurrency(pastDueAmount, currency) in UI
                pastDueAttemptCount,         // number of charge attempts (SC2)
                stripePortalUrl,             // Stripe billing portal URL for payment update CTA (SC2)
                nextPlan,                    // next tier up — null if already on highest plan
                connectedPlatforms,          // lowercase service names for active connections e.g. ['instagram','facebook']
            }),
        };

    } catch (err: any) {
        console.error('[check-capacity]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check capacity.' }) };
    }
};
