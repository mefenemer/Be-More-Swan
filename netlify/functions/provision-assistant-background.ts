// provision-assistant-background.ts — async assistant provisioning (US2 Lifecycle).
//
// MUST stay a Netlify *background* function (the `-background` filename suffix). It is fired
// from onboarding via fetch(); a background function is queued + acked with 202 immediately and
// then runs (up to 15 min) independently of the caller. A plain function invoked the same
// fire-and-forget way is NOT reliably delivered — the caller's Lambda freezes on return before
// the request lands — which historically left every assistant stuck in `provisioning`.
//
// On success the assistant lands in `ready_for_work` (inactive, action-locked) and waits for the
// user to Initiate Kick-Off (kickoff-assistant.ts) → `working`.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { aiAssistants, auditLogs, dpaAcceptances, masterAssistants, notifications, organisations, plans, riskAssessments, users, supportTickets } from '../../db/schema';
import { sendEmail, sendTemplatedEmail } from '../../src/utils/email';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { requireTosAcceptance, checkProhibitedUsePatterns } from '../../src/utils/tos-gate';
import { CURRENT_DPA_VERSION } from './accept-dpa';
import { isEuCountry } from '../../src/config/compliance';
import type { ProvisioningBlockReason } from '../../src/utils/assistant-lifecycle';
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

// A compliance/readiness gate stopped provisioning. Park the assistant in a distinguishable,
// user-actionable state instead of silently leaving it 'pending' (where it derives lifecycle
// 'provisioning' and looks identical to "still being built" forever). The dashboard, the Kick-Off
// 409 and the readiness panel read provisioning_blocked_reason to tell the user exactly what to
// fix; retry-provision-assistant / retryBlockedAssistants re-fire this function once it's fixed.
async function blockProvisioning(
    db: ReturnType<typeof getDb>,
    assistantId: number,
    reason: ProvisioningBlockReason,
): Promise<void> {
    await db.update(aiAssistants)
        .set(withUpdatedAt({ provisioningStatus: 'blocked', provisioningBlockedReason: reason }))
        .where(eq(aiAssistants.id, assistantId))
        .catch((e) => console.error(`[provision-assistant-background] Failed to persist blocked state (${reason}) for assistant ${assistantId}:`, e));
}

// EU jurisdiction list lives in src/config/compliance.ts (AC4.1 modular compliance layer).
async function isEuOrg(stripeCustomerId: string | null | undefined): Promise<boolean> {
    if (!stripe || !stripeCustomerId) return false;
    try {
        const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
        return isEuCountry(customer.address?.country);
    } catch {
        return false;
    }
}

export const handler: Handler = async (event) => {
    const { assistantId } = JSON.parse(event.body!);
    const db = getDb();

    // US-ADM-3.2.1: Global AI kill switch check
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    try {
        // Perform complex API integrations (Meta/LinkedIn) here
        // ... (API calls) ...

        // US-GOV-3.1.1 / US-GDPR-1.1.1: Pre-activation checks
        const [preCheck] = await db
            .select({ disclosureText: aiAssistants.disclosureText, organisationId: aiAssistants.organisationId, masterAssistantId: aiAssistants.masterAssistantId, userId: aiAssistants.userId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);

        if (!preCheck?.disclosureText?.trim()) {
            console.warn(`[provision-assistant-background] Blocked activation for assistant ${assistantId}: disclosureText missing (EU AI Act Art. 52)`);
            await blockProvisioning(db, assistantId, 'disclosure_missing');
            return { statusCode: 422, body: JSON.stringify({ error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).' }) };
        }

        // US-GOV-1.2.1 AC5: Block all write/activation operations until user has accepted current ToS
        if (preCheck?.userId) {
            const tosBlock = await requireTosAcceptance(preCheck.userId);
            if (tosBlock) {
                console.warn(`[provision-assistant-background] Blocked activation for assistant ${assistantId}: ToS not accepted (userId=${preCheck.userId})`);
                await blockProvisioning(db, assistantId, 'tos_required');
                return tosBlock;
            }
        }

        // US-GOV-1.2.1 AC4: Detect prohibited-use patterns in system prompt; require ack flag + log it
        const [assistantFull] = await db
            .select({ systemPrompt: aiAssistants.systemPrompt, prohibitedUseAcknowledged: aiAssistants.prohibitedUseAcknowledged })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);

        if (assistantFull?.systemPrompt) {
            const puCheck = checkProhibitedUsePatterns(assistantFull.systemPrompt);
            if (puCheck.detected) {
                // If the deployer has not acknowledged prohibited-use categories, block activation
                if (!assistantFull.prohibitedUseAcknowledged) {
                    console.warn(`[provision-assistant-background] Blocked activation for assistant ${assistantId}: prohibited-use patterns detected (${puCheck.categories.join(', ')}) without acknowledgment`);
                    await blockProvisioning(db, assistantId, 'prohibited_use_ack');
                    return {
                        statusCode: 422,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            error: 'The assistant\'s system prompt contains content that falls under prohibited-use categories. Please review the Terms of Service (clauses 10.3 and 11.4) and acknowledge compliance before activating.',
                            code: 'PROHIBITED_USE_ACK_REQUIRED',
                            categories: puCheck.categories,
                        }),
                    };
                }

                // Log the acknowledgment in audit_logs
                if (preCheck?.userId) {
                    const { CURRENT_TOS_VERSION } = await import('./accept-tos');
                    await db.insert(auditLogs).values({
                        userId: preCheck.userId,
                        actionType: 'PROHIBITED_USE_ACK',
                        resourceType: 'ai_assistants',
                        resourceId: String(assistantId),
                        newState: {
                            categories: puCheck.categories,
                            tosVersion: CURRENT_TOS_VERSION,
                            acknowledgedAt: new Date().toISOString(),
                        },
                    }).catch(() => {});
                }
            }
        }

        // US-GDPR-1.1.1: Block activation if organisation has not accepted the current DPA version
        if (preCheck?.organisationId) {
            const [dpa] = await db
                .select({ id: dpaAcceptances.id })
                .from(dpaAcceptances)
                .where(and(
                    eq(dpaAcceptances.organisationId, preCheck.organisationId),
                    eq(dpaAcceptances.version, CURRENT_DPA_VERSION),
                ))
                .limit(1);

            if (!dpa) {
                console.warn(`[provision-assistant-background] Blocked activation for assistant ${assistantId}: DPA not accepted for org ${preCheck.organisationId}`);
                await blockProvisioning(db, assistantId, 'dpa_required');
                return { statusCode: 403, body: JSON.stringify({ error: 'Your organisation must accept the Data Processing Agreement before activating an assistant.', code: 'DPA_REQUIRED' }) };
            }
        }

        // US-GOV-1.1.1: Block EU-market activation of high_risk assistants without an approved risk assessment
        if (preCheck?.organisationId && preCheck.masterAssistantId) {
            const [master] = await db
                .select({ riskClassification: masterAssistants.riskClassification })
                .from(masterAssistants)
                .where(eq(masterAssistants.id, preCheck.masterAssistantId))
                .limit(1);

            if (master?.riskClassification === 'high_risk') {
                // Determine EU jurisdiction via Stripe billing country
                const [plan] = await db
                    .select({ stripeCustomerId: plans.stripeCustomerId })
                    .from(plans)
                    .where(eq(plans.userId, preCheck.userId!))
                    .limit(1);

                const euJurisdiction = await isEuOrg(plan?.stripeCustomerId);

                if (euJurisdiction) {
                    // Check for an approved risk assessment for this assistant + org
                    const [assessment] = await db
                        .select({ id: riskAssessments.id })
                        .from(riskAssessments)
                        .where(and(
                            eq(riskAssessments.masterAssistantId, preCheck.masterAssistantId),
                            eq(riskAssessments.organisationId, preCheck.organisationId),
                            eq(riskAssessments.approvalStatus, 'approved'),
                        ))
                        .limit(1);

                    if (!assessment) {
                        console.warn(`[provision-assistant-background] Blocked EU activation for assistant ${assistantId}: high_risk classification requires approved conformity assessment`);
                        await blockProvisioning(db, assistantId, 'high_risk_eu');
                        return { statusCode: 403, body: JSON.stringify({
                            error: 'This assistant is classified as High Risk under the EU AI Act. A completed conformity assessment must be approved before EU-market deployment.',
                            code: 'HIGH_RISK_EU_BLOCKED',
                        }) };
                    }
                }
            }
        }

        // Guard: only update if still 'pending' — prevents race condition where
        // two parallel invocations both try to complete the same assistant.
        //
        // US2 (Digital Assistant Lifecycle): technical provisioning no longer auto-activates
        // the assistant. It lands in `ready_for_work` (inactive → action-locked) and waits for
        // the user to Initiate Kick-Off, which moves it to `working` (US3). isActive stays false
        // so background jobs/connectors remain disabled until kick-off. We set lifecycle_status
        // explicitly so the DB sync trigger keeps this forward-only state (it isn't derivable
        // from the legacy complete+inactive pair, which would otherwise read as 'paused').
        const [updated] = await db.update(aiAssistants)
            .set(withUpdatedAt({ provisioningStatus: 'complete', provisioningBlockedReason: null, isActive: false, lifecycleStatus: 'ready_for_work' }))
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.provisioningStatus, 'pending')))
            .returning();

        // ── US2 Sc3: "Provisioning complete" in-app notification ─────────────
        if (updated?.userId) {
            try {
                await db.insert(notifications).values({
                    userId: updated.userId,
                    type: 'provisioning_complete',
                    title: 'Ready for Work',
                    message: `${updated.name} is provisioned and ready for work. Open it and Initiate Kick-Off to put it to work.`,
                });
            } catch (notifErr) {
                console.warn('[provision-assistant-background] Notification insert failed (non-blocking):', notifErr);
            }

            // US-GAP-6.2.1 SC1/SC2: Assistant ready confirmation email
            try {
                const [userRecord] = await db
                    .select({ email: users.email, firstName: users.firstName })
                    .from(users)
                    .where(eq(users.id, updated.userId))
                    .limit(1);

                if (userRecord) {
                    const baseUrl   = process.env.BASE_URL || '';
                    const dashUrl   = `${baseUrl}/workspace.html`;
                    const intUrl    = `${baseUrl}/workspace.html#integrations`;
                    const role      = (updated as any).assistantRole || (updated as any).role || 'AI Assistant';
                    const firstName = userRecord.firstName || 'there';

                    // US-COMMS-1: admin-editable template (trigger 'assistant_ready').
                    void intUrl;
                    sendTemplatedEmail({
                        triggerKey: 'assistant_ready',
                        to: userRecord.email,
                        vars: {
                            user: { first_name: firstName },
                            assistant: { name: updated.name, role },
                            link: { action_url: dashUrl },
                        },
                    }).catch(() => {});
                }
            } catch (emailErr) {
                console.warn('[provision-assistant-background] Ready email failed (non-blocking):', emailErr);
            }
        }

        return { statusCode: 200, body: 'Done' };
    } catch (e) {
        // US-GAP-6.2.1 SC4: Provisioning failure — send failure email + create support ticket
        const failedAssistant = await db
            .update(aiAssistants)
            .set(withUpdatedAt({ provisioningStatus: 'failed' }))
            .where(eq(aiAssistants.id, assistantId))
            .returning()
            .catch(() => []);

        const failed = failedAssistant[0];
        if (failed?.userId) {
            const [userRecord] = await db
                .select({ email: users.email, firstName: users.firstName })
                .from(users)
                .where(eq(users.id, failed.userId))
                .limit(1)
                .catch(() => []);

            if (userRecord) {
                const baseUrl = process.env.BASE_URL || '';
                // SC4a: failure email — US-COMMS-1 template 'assistant_failed'.
                void baseUrl;
                sendTemplatedEmail({
                    triggerKey: 'assistant_failed',
                    to: userRecord.email,
                    vars: {
                        user: { first_name: userRecord.firstName || '' },
                        assistant: { name: failed.name || '' },
                    },
                }).catch(() => {});

                // SC4b: auto-create support ticket
                db.insert(supportTickets).values({
                    userId: failed.userId,
                    subject: `Provisioning failure — ${failed.name || 'assistant'} (ID: ${assistantId})`,
                    category: 'provisioning_failure',
                    description: `Automated report: assistant provisioning failed for assistant ID ${assistantId} (name: ${failed.name}). User: ${userRecord.email}. Error: ${(e as any)?.message || 'unknown'}`,
                    status: 'open',
                    priority: 'high',
                }).catch(() => {});
            }
        }

        return { statusCode: 500, body: 'Failed' };
    }
};