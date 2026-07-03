// netlify/functions/admin-billing-override.ts
//
// US-ADM-2.1.1: Manual Stripe Subscription Override Console
//
// POST /.netlify/functions/admin-billing-override
//   Body: { targetUserId, action, ...actionParams }
//   Cookie: aura_session (must be billing_admin, platform_admin, or super_admin)
//
// Supported actions:
//   comp_month        — Issue a balance credit equal to the plan's MRR (pence)
//   upgrade_tier      — Switch Stripe subscription to a new price with prorations
//   downgrade_tier    — Same call, different price
//   extend_trial      — Extend Stripe trial_end by N days
//   pause_subscription — Set pause_collection={behavior:'void'}, plan.status='paused'

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '../../db/client';
import {
    users, plans, masterPlans, billingOverrides, notifications, userOrganisations,
} from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { sendEmail } from '../../src/utils/email';

const jwtSecret = process.env.JWT_SECRET;
const stripe    = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

const ALLOWED_ROLES = ['billing_admin', 'platform_admin', 'super_admin'];
const VALID_ACTIONS = ['comp_month', 'upgrade_tier', 'downgrade_tier', 'extend_trial', 'pause_subscription'] as const;
type OverrideAction = typeof VALID_ACTIONS[number];

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    if (!stripe)    return { statusCode: 503, body: JSON.stringify({ error: 'Stripe not configured.' }) };

    // ── 1. Auth ───────────────────────────────────────────────────────────────
    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as any;
        if (tok.scope === 'impersonate') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Action blocked during impersonation session.' }) };
        }
        adminId = tok.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [adminUser] = await db.select({ role: users.role, firstName: users.firstName, lastName: users.lastName })
        .from(users).where(eq(users.id, adminId)).limit(1);

    if (!adminUser || !ALLOWED_ROLES.includes(adminUser.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: `Requires one of: ${ALLOWED_ROLES.join(', ')}.` }) };
    }

    // ── 2. Parse request body ─────────────────────────────────────────────────
    let body: Record<string, any>;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { targetUserId, action, reason } = body;

    if (!targetUserId || !Number.isInteger(Number(targetUserId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId (integer) required.' }) };
    }
    if (!VALID_ACTIONS.includes(action as OverrideAction)) {
        return { statusCode: 400, body: JSON.stringify({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}.` }) };
    }
    if (!reason?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'An admin note (reason) is required for all overrides.' }) };
    }

    const uid = Number(targetUserId);

    // ── 3. Load target user + active plan ─────────────────────────────────────
    const [targetUser] = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName, organisationId: userOrganisations.organisationId })
        .from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, uid)).limit(1);
    if (!targetUser) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

    const [activePlan] = await db
        .select()
        .from(plans)
        .where(and(eq(plans.userId, uid), eq(plans.status, 'active')))
        .limit(1);

    if (!activePlan?.stripeSubscriptionId || !activePlan?.stripeCustomerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No active Stripe subscription found for this user.' }) };
    }

    // ── 4. Execute the requested action ──────────────────────────────────────
    let stripeRef: string | null = null;
    let billingAmount: string | null = null;
    let auditAction: string;
    let auditPrev: Record<string, any> = {};
    let auditNext: Record<string, any> = {};
    let auditMeta: Record<string, any> = {};

    try {
        switch (action as OverrideAction) {

            // ── comp_month: issue a credit balance ──────────────────────────
            case 'comp_month': {
                // Look up current plan price for credit amount
                const [masterPlan] = await db.select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
                    .from(masterPlans).where(eq(masterPlans.id, activePlan.masterPlanId!)).limit(1);

                const amountPence = masterPlan
                    ? Math.round(Number(masterPlan.monthlyPriceGbp) * 100)
                    : 0;

                const txn = await stripe.customers.createBalanceTransaction(
                    activePlan.stripeCustomerId!,
                    {
                        amount:      -amountPence,   // negative = credit to customer
                        currency:    'gbp',
                        description: `Admin comp: ${reason} (by ${adminUser.firstName} ${adminUser.lastName} #${adminId})`,
                    }
                );
                stripeRef    = txn.id;
                billingAmount = (amountPence / 100).toFixed(2);
                auditAction  = 'comp_credit';
                auditPrev    = { balance: 0 };
                auditNext    = { creditGbp: billingAmount, stripeRef };
                break;
            }

            // ── upgrade_tier / downgrade_tier: swap Stripe price ────────────
            case 'upgrade_tier':
            case 'downgrade_tier': {
                const { newPriceId, newTierKey, newPlanName } = body;
                if (!newPriceId) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'newPriceId required for tier change.' }) };
                }

                const sub = await stripe.subscriptions.retrieve(activePlan.stripeSubscriptionId!);
                const existingItemId = sub.items.data[0]?.id;
                if (!existingItemId) {
                    return { statusCode: 500, body: JSON.stringify({ error: 'Could not find Stripe subscription item.' }) };
                }

                await stripe.subscriptions.update(activePlan.stripeSubscriptionId!, {
                    items: [{ id: existingItemId, price: newPriceId }],
                    proration_behavior: 'create_prorations',
                });

                // Look up the new master plan if tierKey provided
                let newMasterId = activePlan.masterPlanId;
                if (newTierKey) {
                    const [mp] = await db.select({ id: masterPlans.id })
                        .from(masterPlans).where(eq(masterPlans.tierKey, newTierKey)).limit(1);
                    if (mp) newMasterId = mp.id;
                }

                await db.update(plans)
                    .set({
                        masterPlanId: newMasterId,
                        planName:     newPlanName || activePlan.planName,
                        updatedAt:    new Date(),
                    })
                    .where(eq(plans.id, activePlan.id));

                stripeRef   = activePlan.stripeSubscriptionId!;
                auditAction = 'tier_change';
                auditPrev   = { planName: activePlan.planName, masterPlanId: activePlan.masterPlanId };
                auditNext   = { planName: newPlanName || activePlan.planName, newPriceId };
                break;
            }

            // ── extend_trial: push trial_end forward ─────────────────────────
            case 'extend_trial': {
                const { extensionDays } = body;
                if (!extensionDays || extensionDays < 1) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'extensionDays (>0) required.' }) };
                }

                const sub = await stripe.subscriptions.retrieve(activePlan.stripeSubscriptionId!);
                const currentTrialEnd = sub.trial_end ?? Math.floor(Date.now() / 1000);
                const newTrialEnd     = currentTrialEnd + Number(extensionDays) * 86400;

                await stripe.subscriptions.update(activePlan.stripeSubscriptionId!, {
                    trial_end: newTrialEnd,
                });

                stripeRef   = activePlan.stripeSubscriptionId!;
                auditAction = 'trial_extension';
                auditPrev   = { trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null };
                auditNext   = { trialEnd: new Date(newTrialEnd * 1000).toISOString() };
                auditMeta   = { extensionDays: Number(extensionDays) };
                break;
            }

            // ── pause_subscription ────────────────────────────────────────────
            case 'pause_subscription': {
                const { resumeDateIso } = body;
                const updatePayload: Stripe.SubscriptionUpdateParams = {
                    pause_collection: { behavior: 'void' },
                };
                if (resumeDateIso) {
                    const resumeTs = Math.floor(new Date(resumeDateIso).getTime() / 1000);
                    updatePayload.trial_end = resumeTs; // re-activates subscription on this date
                }

                await stripe.subscriptions.update(activePlan.stripeSubscriptionId!, updatePayload);

                await db.update(plans)
                    .set({ status: 'paused', updatedAt: new Date() })
                    .where(eq(plans.id, activePlan.id));

                // Notify user — in-app notification
                const resumeDateDisplay = resumeDateIso
                    ? new Date(resumeDateIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                    : null;
                const pauseMessage = resumeDateDisplay
                    ? `Your subscription has been paused and will automatically resume on ${resumeDateDisplay}.`
                    : 'Your subscription has been paused. Contact support to resume.';

                await db.insert(notifications).values({
                    userId:  uid,
                    type:    'billing',
                    title:   'Your subscription has been paused',
                    message: pauseMessage,
                    metadata: { pausedBy: adminId, resumeDate: resumeDateIso || null },
                }).catch(() => {});

                // AC requirement: also send email notification
                sendEmail({
                    to: targetUser.email,
                    subject: 'Your subscription has been paused',
                    html: `<p>Hi ${targetUser.firstName || 'there'},</p>
                           <p>${pauseMessage}</p>
                           <p>If you have any questions, please reply to this email or contact our support team.</p>
                           <p>The Be More Swan Team</p>`,
                }).catch(() => {});

                stripeRef   = activePlan.stripeSubscriptionId!;
                auditAction = 'dunning_override'; // closest existing action type; 'pause_subscription' is custom
                auditPrev   = { status: activePlan.status };
                auditNext   = { status: 'paused', resumeDate: resumeDateIso || null };
                break;
            }

            default:
                return { statusCode: 400, body: JSON.stringify({ error: 'Unhandled action.' }) };
        }
    } catch (stripeErr: any) {
        console.error('[admin-billing-override] Stripe error:', stripeErr);
        return { statusCode: 502, body: JSON.stringify({ error: 'Stripe request failed: ' + stripeErr.message }) };
    }

    // ── 5. Write billing_overrides row ────────────────────────────────────────
    await db.insert(billingOverrides).values({
        workspaceId: targetUser.organisationId ?? null,
        adminId,
        action,
        amount:     billingAmount ?? null,
        reason,
        stripeRef:  stripeRef ?? null,
        metadata:   { ...auditMeta, targetUserId: uid },
    }).catch(err => console.warn('[admin-billing-override] Could not write billing_overrides:', err));

    // ── 6. Write admin audit log ──────────────────────────────────────────────
    await insertAdminAuditLog({
        adminId,
        action:       auditAction as any,
        targetType:   'user',
        targetId:     uid,
        previousState: auditPrev,
        newState:     auditNext,
        reason,
        ipAddress:    getAdminIp(event.headers),
        userAgent:    event.headers['user-agent'] || undefined,
        metadata:     { stripeRef, ...auditMeta },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, action, stripeRef }),
    };
};
