import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { payments, plans, aiAssistants, onboardingDrafts, notifications, users, masterPlans, planPrices, invoices, processedWebhookEvents, userReferrals, platformConfig, stripeDisputes, userOrganisations, userProfiles } from '../../db/schema';
import { sendEmail, buildAnnualRenewalEmail, buildDunningEmail } from '../../src/utils/email';
import { resolveActionNotifications, PAYMENT_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { recordCardFingerprint } from '../../src/utils/billing-fingerprint';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// dahlia: invoices no longer expose a top-level `payment_intent` or `subscription`.
// The PaymentIntent now lives on the invoice's `payments` list, and the subscription
// reference moved under `parent.subscription_details`. These helpers read the new
// shape and fall back to the legacy fields for any older event payloads.
function getInvoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
    const legacy = (invoice as any).payment_intent;
    if (typeof legacy === 'string') return legacy;
    if (legacy?.id) return legacy.id;
    for (const p of invoice.payments?.data ?? []) {
        const pi = p.payment?.payment_intent;
        if (typeof pi === 'string') return pi;
        if (pi?.id) return pi.id;
    }
    return null;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
    const fromParent = invoice.parent?.subscription_details?.subscription;
    const sub = fromParent ?? (invoice as any).subscription;
    return typeof sub === 'string' ? sub : sub?.id ?? null;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const sig = event.headers['stripe-signature'];
    let stripeEvent: Stripe.Event;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body!, sig!, webhookSecret);
    } catch (err: any) {
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    const db = getDb();

    // ── Idempotency guard — reject already-processed events ───────
    // Stripe retries webhooks on non-2xx responses; this prevents
    // double-charging, duplicate plans, and duplicate invoices.
    try {
        await db.insert(processedWebhookEvents).values({
            stripeEventId: stripeEvent.id,
            eventType: stripeEvent.type,
        });
    } catch {
        // Unique constraint violation = already processed; return 200 to stop retries
        console.log(`[stripe-webhook] Duplicate event ignored: ${stripeEvent.id}`);
        return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
    }

    // ── checkout.session.completed — plan-gate subscription checkout ──
    // create-plan-checkout-intent.ts uses Stripe Checkout in `subscription` mode. Stripe does NOT
    // route these through our custom payment_intent.succeeded metadata flow, and invoice.paid with
    // billing_reason `subscription_create` is skipped below — so the plan must be activated HERE,
    // otherwise check-capacity never sees an active plan and the plan-gate modal keeps reappearing.
    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        const { userId, organisationId, masterPlanId, planName: metaPlanName, referralCode } = session.metadata || {};

        // Only our plan-gate subscription sessions carry userId + organisationId in metadata;
        // organisationId is required to create the plan record (plans.organisationId is NOT NULL).
        if (session.mode !== 'subscription' || !userId || !organisationId) {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }
        console.log(`[stripe-webhook] checkout.session.completed activating plan for userId=${userId} org=${organisationId} masterPlan=${masterPlanId}`);

        const userIdInt        = parseInt(userId);
        const orgIdInt         = parseInt(organisationId);
        const masterPlanIdInt  = masterPlanId ? parseInt(masterPlanId) : null;
        const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
        const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
        const planName = metaPlanName || 'Be More Swan Subscription';

        // Create the active plan record — unique-constraint guard mirrors the payment_intent path
        let newPlan: typeof plans.$inferSelect;
        try {
            const [inserted] = await db.insert(plans).values({
                userId: userIdInt,
                organisationId: orgIdInt,
                masterPlanId: masterPlanIdInt,
                planName,
                planType: 'subscription',
                status: 'active',
                stripeCustomerId,
                stripeSubscriptionId,
            }).returning();
            newPlan = inserted;
        } catch (planErr: any) {
            if (planErr?.code === '23505' || planErr?.message?.includes('plans_one_active_per_org_unique')) {
                console.warn('[stripe-webhook] checkout.session.completed — active plan already exists, returning 200');
                return { statusCode: 200, body: JSON.stringify({ received: true, duplicate_plan: true }) };
            }
            throw planErr;
        }

        // Trial-to-paid: expire any active trial plan so check-capacity returns the paid plan
        await db.update(plans)
            .set(withUpdatedAt({ status: 'expired' as const }))
            .where(and(eq(plans.userId, userIdInt), eq(plans.planType, 'trial'), eq(plans.status, 'active')));

        // Record the first payment + invoice (subscription_create invoice.paid is skipped below,
        // so this is the only place the initial charge is persisted for the plan-gate flow).
        const amountPence = session.amount_total ?? 0;
        await db.insert(payments).values({
            userId: userIdInt,
            organisationId: orgIdInt,
            planId: newPlan.id,
            masterPlanId: masterPlanIdInt,
            amount: (amountPence / 100).toFixed(2),
            currency: (session.currency || 'gbp').toUpperCase(),
            status: 'completed',
            externalPaymentId: (typeof session.payment_intent === 'string' ? session.payment_intent : null) || session.id,
            description: `${planName} — first payment`,
        }).catch(err => console.error('[stripe-webhook] checkout.session payment insert failed:', (err as any)?.message));

        const sessBillingStart = new Date();
        const sessBillingEnd   = new Date(sessBillingStart);
        sessBillingEnd.setMonth(sessBillingEnd.getMonth() + 1);
        const sessInv = await _createInvoice({
            userId:                userIdInt,
            organisationId:        orgIdInt,
            planId:                newPlan.id,
            planName,
            amountPence,
            currency:              session.currency || 'gbp',
            billingPeriodStart:    sessBillingStart,
            billingPeriodEnd:      sessBillingEnd,
            stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        });
        if (sessInv) {
            await db.insert(notifications).values({
                userId: userIdInt,
                type: 'invoice_ready',
                title: `Your invoice for ${planName} is ready`,
                message: `Invoice ${sessInv.invoiceNumber} has been generated for your ${planName} subscription. View it in your Invoice History.`,
                isRead: false,
                metadata: { invoiceId: sessInv.id, invoiceNumber: sessInv.invoiceNumber, action: 'view_invoices' },
            }).catch(() => {});
        }

        // US-ONB-2.2.1: reset welcome flag + persistent welcome notification (AC15/AC16)
        await db.update(userProfiles)
            .set({ firstLoginWelcomeSeen: false, updatedAt: new Date() })
            .where(eq(userProfiles.userId, userIdInt))
            .catch(() => {});
        await db.insert(notifications).values({
            userId: userIdInt,
            type: 'welcome',
            title: 'Welcome to Be More Swan!',
            message: 'Your workspace is ready. Open the Setup Wizard to build your AI assistant and go live.',
            isRead: false,
            metadata: { action: 'open_wizard', ctaLabel: 'Open Setup Wizard' },
        }).catch(() => {});

        // Referral Program Expansion: earn a referral TOKEN (not an instant £10 credit).
        // The token matures after the 14-day refund window and is then spendable in the
        // Reward Vault for £10 credit or a free assistant.
        try {
            const [pendingReferral] = await db
                .select({ id: userReferrals.id, referrerId: userReferrals.referrerId })
                .from(userReferrals)
                .where(and(eq(userReferrals.referredUserId, userIdInt), eq(userReferrals.status, 'pending')))
                .limit(1);

            if (pendingReferral) {
                await db.update(userReferrals)
                    .set({ status: 'qualified', qualifiedAt: new Date() })
                    .where(eq(userReferrals.id, pendingReferral.id));

                await db.insert(notifications).values({
                    userId: pendingReferral.referrerId,
                    type: 'referral_reward',
                    title: '🎉 Referral Token Earned',
                    message: 'A friend you referred just made their first payment — you\'ve earned a referral token! It unlocks after their 14-day refund window. Save up 5 for a free assistant, or redeem 1 for £10 credit.',
                    isRead: false,
                    metadata: { referralId: pendingReferral.id },
                });
            }
        } catch (refErr) {
            console.warn('[stripe-webhook] checkout.session referral token grant failed (non-blocking):', refErr);
        }

        return { statusCode: 200, body: JSON.stringify({ received: true, activated: true }) };
    }

    // ── payment_intent.succeeded — initial checkout ───────────────
    if (stripeEvent.type === 'payment_intent.succeeded') {
        const pi = stripeEvent.data.object as Stripe.PaymentIntent;
        const { userId, organisationId, tier, masterPlanId, stripePriceId, stripeCustomerId, billingCycle } = pi.metadata || {};

        // Only handle payment intents created by our checkout flow (they have userId in metadata)
        if (!userId || !stripeCustomerId) {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const userIdInt       = parseInt(userId);
        const orgIdInt        = parseInt(organisationId);
        const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;
        const amountGbp       = pi.amount ? (pi.amount / 100).toFixed(2) : '0.00';

        // ── Expand PaymentMethod to capture card details at checkout ──
        // PAN and CVC are never stored — only brand, last4, and expiry.
        let cardBrand: string | null      = null;
        let cardLast4: string | null      = null;
        let cardExpMonth: number | null   = null;
        let cardExpYear: number | null    = null;
        let cardPostalCode: string | null = null;

        if (pi.payment_method) {
            try {
                const pm = await stripe.paymentMethods.retrieve(pi.payment_method as string);
                if (pm.card) {
                    cardBrand      = pm.card.brand     || null;
                    cardLast4      = pm.card.last4      || null;
                    cardExpMonth   = pm.card.exp_month  || null;
                    cardExpYear    = pm.card.exp_year   || null;
                    // US3 AC3.1/AC3.2: record the card fingerprint for this workspace and flag
                    // billing_review_required if the same physical card is on ≥2 workspaces.
                    if (orgIdInt) await recordCardFingerprint(db, orgIdInt, pm.card.fingerprint);
                }
                // Billing address postal code stored at checkout
                cardPostalCode = pm.billing_details?.address?.postal_code || null;
            } catch (pmErr) {
                console.warn('[stripe-webhook] Could not retrieve payment method for card details:', (pmErr as any)?.message);
            }
        }

        // Look up plan name + keep masterPlan record for subscription creation below
        let planName = tier ? `Be More Swan (${tier})` : 'Be More Swan Subscription';
        let masterPlan: typeof masterPlans.$inferSelect | null = null;
        if (masterPlanIdInt) {
            const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
            if (mp) { planName = mp.name; masterPlan = mp; }
        }

        // The Stripe subscription is now created up-front by create-subscription.ts using the
        // `default_incomplete` pattern, and THIS PaymentIntent is that subscription's first
        // invoice payment. We must NOT create another subscription here — doing so charged the
        // customer a second time for the first period. Carry the existing subscription id
        // (stamped onto the PI metadata at creation) onto the plan record below.
        const createdStripeSubscriptionId: string | null = pi.metadata?.stripeSubscriptionId || null;

        // Create plan record — include Stripe references for future upgrade/downgrade/cancel.
        // BUG-P0-4: Wrap in try-catch to handle the plans_one_active_per_org_unique violation
        // gracefully — two concurrent checkout completions for the same org would otherwise cause
        // an unhandled error; returning 200 tells Stripe not to retry the event.
        let newPlan: typeof plans.$inferSelect;
        try {
            const [inserted] = await db.insert(plans).values({
                userId: userIdInt,
                organisationId: orgIdInt,
                masterPlanId: masterPlanIdInt,
                planName,
                planType: 'subscription',
                status: 'active',
                stripeCustomerId,
                stripeSubscriptionId: createdStripeSubscriptionId,
            }).returning();
            newPlan = inserted;
        } catch (planErr: any) {
            if (planErr?.code === '23505' || planErr?.message?.includes('plans_one_active_per_org_unique')) {
                console.warn('[stripe-webhook] Duplicate active plan insert blocked by unique constraint — returning 200 to stop retries');
                return { statusCode: 200, body: JSON.stringify({ received: true, duplicate_plan: true }) };
            }
            throw planErr;
        }

        // US-GAP-8.1.1 SC7: Trial-to-paid conversion — expire any active trial plan for this user
        // so check-capacity returns the new paid plan rather than the trial
        await db.update(plans)
            .set(withUpdatedAt({ status: 'expired' as const }))
            .where(and(eq(plans.userId, userIdInt), eq(plans.planType, 'trial'), eq(plans.status, 'active')));

        // Create payment record — include card details
        await db.insert(payments).values({
            userId: userIdInt,
            organisationId: orgIdInt,
            planId: newPlan.id,
            masterPlanId: masterPlanIdInt,
            amount: amountGbp,
            currency: (pi.currency || 'gbp').toUpperCase(), // US-I18N-2.1 SC6: from Stripe event
            status: 'completed',
            externalPaymentId: pi.id,
            description: `${planName} — first payment`,
            cardBrand,
            cardLast4,
            cardExpMonth,
            cardExpYear,
            cardPostalCode,
            paymentMethod: cardBrand && cardLast4 ? `${cardBrand} ending ${cardLast4}` : null,
        });

        // ── Create invoice record ─────────────────────────────────
        const billingPeriodStart = new Date();
        const billingPeriodEnd   = new Date(billingPeriodStart);
        billingPeriodEnd.setMonth(billingPeriodEnd.getMonth() + 1);

        const inv = await _createInvoice({
            userId:               userIdInt,
            organisationId:       orgIdInt || null,
            planId:               newPlan.id,
            planName,
            amountPence:          pi.amount || 0,
            currency:             pi.currency || 'gbp',
            billingPeriodStart,
            billingPeriodEnd,
            stripePaymentIntentId: pi.id,
        });

        // ── Notifications ─────────────────────────────────────────
        // 1. Invoice ready notification
        if (inv) {
            await db.insert(notifications).values({
                userId: userIdInt,
                type: 'invoice_ready',
                title: `Your invoice for ${planName} is ready`,
                message: `Invoice ${inv.invoiceNumber} has been generated for your ${planName} subscription. View it in your Invoice History.`,
                isRead: false,
                metadata: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, action: 'view_invoices' },
            });
        }

        // 2. Onboarding nudge
        await db.insert(notifications).values({
            userId: userIdInt,
            type: 'billing',
            title: 'Payment Successful — Set Up Your Assistant',
            message: 'Your subscription is active. Click "Resume Setup" on your dashboard to build your Digital Assistant now.',
            isRead: false,
        });

        // 3. US-ONB-2.2.1: Reset firstLoginWelcomeSeen + insert persistent welcome notification (AC15/AC16)
        await db.update(userProfiles)
            .set({ firstLoginWelcomeSeen: false, updatedAt: new Date() })
            .where(eq(userProfiles.userId, userIdInt))
            .catch(() => {});
        await db.insert(notifications).values({
            userId: userIdInt,
            type: 'welcome',
            title: 'Welcome to Be More Swan!',
            message: 'Your workspace is ready. Open the Setup Wizard to build your AI assistant and go live.',
            isRead: false,
            metadata: { action: 'open_wizard', ctaLabel: 'Open Setup Wizard' },
        }).catch(() => {});

        // ── Referral Program Expansion: earn a referral TOKEN ────────
        // The referred friend's first payment qualifies the referral. We no longer apply
        // an instant £10 credit — the referrer gets a token (matures after the 14-day
        // refund window) to spend in the Reward Vault for £10 credit or a free assistant.
        try {
            const [pendingReferral] = await db
                .select({ id: userReferrals.id, referrerId: userReferrals.referrerId })
                .from(userReferrals)
                .where(and(eq(userReferrals.referredUserId, userIdInt), eq(userReferrals.status, 'pending')))
                .limit(1);

            if (pendingReferral) {
                await db.update(userReferrals)
                    .set({ status: 'qualified', qualifiedAt: new Date() })
                    .where(eq(userReferrals.id, pendingReferral.id));

                await db.insert(notifications).values({
                    userId: pendingReferral.referrerId,
                    type: 'referral_reward',
                    title: '🎉 Referral Token Earned',
                    message: 'A friend you referred just made their first payment — you\'ve earned a referral token! It unlocks after their 14-day refund window. Save up 5 for a free assistant, or redeem 1 for £10 credit.',
                    isRead: false,
                    metadata: { referralId: pendingReferral.id },
                });
            }
        } catch (refErr) {
            console.warn('[stripe-webhook] Referral token grant failed (non-blocking):', refErr);
        }
    }

    // ── invoice.upcoming — renewal due in ~3 days ─────────────────
    // Stripe fires this automatically 3 days before a subscription renews.
    // For annual plans (period ≥ 300 days) we also send a pre-renewal email
    // (DMCCA / FTC compliance requires advance notice for auto-renewing annual plans).
    if (stripeEvent.type === 'invoice.upcoming') {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        const userId  = await _resolveUserId(invoice.customer as string);
        if (userId) {
            const amount     = invoice.amount_due ? `£${(invoice.amount_due / 100).toFixed(2)}` : '';
            const renewalDay = invoice.period_end
                ? new Date(invoice.period_end * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                : 'soon';

            // Detect annual plan: period_end − period_start ≥ 300 days
            const periodDays = invoice.period_start && invoice.period_end
                ? (invoice.period_end - invoice.period_start) / 86400
                : 0;
            const isAnnual = periodDays >= 300;

            // Avoid duplicate notifications: check if one was already sent for this invoice
            const existing = await db.select({ id: notifications.id })
                .from(notifications)
                .where(and(
                    eq(notifications.userId, userId),
                    eq(notifications.type, 'billing_renewal_due'),
                ))
                .limit(1);

            const alreadySent = existing.some(n => (n as any).metadata?.invoiceId === invoice.id);

            if (!alreadySent) {
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_renewal_due',
                    title: 'Subscription Renewal Due Soon',
                    message: `Your subscription will renew on ${renewalDay}${amount ? ` for ${amount}` : ''}. Make sure your payment details are up to date.`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        customerId: invoice.customer,
                        amountDue: invoice.amount_due,
                        renewalDate: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
                    },
                });

                // US-LEGAL-1.5: Send pre-renewal email for annual plans (DMCCA compliance)
                if (isAnnual) {
                    // BUG-P0-5: users table has firstName/lastName, not a name column
                    const [userRow] = await db.select({ email: users.email, firstName: users.firstName })
                        .from(users).where(eq(users.id, userId)).limit(1);
                    if (userRow?.email) {
                        await sendEmail({
                            to: userRow.email,
                            subject: `Your Be More Swan annual plan renews on ${renewalDay}`,
                            html: buildAnnualRenewalEmail(userRow.firstName || 'there', renewalDay, amount),
                        // BUG-P1-1: Log at error level so this surfaces in alerts — compliance-critical email
                        }).catch(err => console.error('[stripe-webhook] Annual renewal compliance email failed:', { userId, err: (err as any)?.message }));
                    }
                }
            }
        }
    }

    // ── invoice.paid — successful renewal / recurring charge ──────
    // Fires on every successful invoice payment (both initial and recurring).
    // We skip the initial charge here as payment_intent.succeeded covers it.
    if (stripeEvent.type === 'invoice.paid') {
        const invoice    = stripeEvent.data.object as Stripe.Invoice;
        const billingReason = (invoice as any).billing_reason as string | undefined;

        // 'subscription_create' = first charge (already handled above); skip to avoid double notification
        if (billingReason === 'subscription_create') {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const userId = await _resolveUserId(invoice.customer as string);
        if (userId) {
            const amount     = invoice.amount_paid ? `£${(invoice.amount_paid / 100).toFixed(2)}` : '';
            const periodEnd  = invoice.period_end
                ? new Date(invoice.period_end * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                : null;

            // Resolve card details from the invoice's charge
            let renewCardBrand: string | null      = null;
            let renewCardLast4: string | null      = null;
            let renewCardExpMonth: number | null   = null;
            let renewCardExpYear: number | null    = null;
            let renewCardPostalCode: string | null = null;

            const invoicePaymentIntentId = getInvoicePaymentIntentId(invoice);
            try {
                // payment intent → expand payment_method → card + billing address
                if (invoicePaymentIntentId) {
                    const pi = await stripe.paymentIntents.retrieve(invoicePaymentIntentId, {
                        expand: ['payment_method'],
                    });
                    const pm = pi.payment_method as Stripe.PaymentMethod | null;
                    if (pm?.card) {
                        renewCardBrand      = pm.card.brand     || null;
                        renewCardLast4      = pm.card.last4      || null;
                        renewCardExpMonth   = pm.card.exp_month  || null;
                        renewCardExpYear    = pm.card.exp_year   || null;
                    }
                    renewCardPostalCode = pm?.billing_details?.address?.postal_code || null;
                }
            } catch (cardErr) {
                console.warn('[stripe-webhook] Could not retrieve card for renewal:', (cardErr as any)?.message);
            }

            // Record the renewal payment in our payments table.
            // BUG-P1-2: Scope plan lookup by stripeSubscriptionId so a user who belongs to
            // multiple orgs credits the renewal against the correct org's plan.
            // Falls back to userId+status if invoice.subscription is absent (edge case).
            const subscriptionId = getInvoiceSubscriptionId(invoice);
            const planRecord = subscriptionId
                ? await db.select({ id: plans.id, planName: plans.planName })
                    .from(plans)
                    .where(and(
                        eq(plans.userId, userId),
                        eq(plans.status, 'active'),
                        eq(plans.stripeSubscriptionId, subscriptionId),
                    ))
                    .limit(1)
                : await (async () => {
                    console.warn('[stripe-webhook] invoice.paid has no subscription ID — falling back to userId+status plan lookup');
                    return db.select({ id: plans.id, planName: plans.planName })
                        .from(plans)
                        .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
                        .limit(1);
                })();

            if (planRecord.length > 0) {
                const plan = planRecord[0];
                // BUG-P1-1: Remove silent catch — a failed payment insert loses the financial record.
                // Stripe will retry the webhook on 500, giving us a second chance to persist it.
                await db.insert(payments).values({
                    userId,
                    planId: plan.id,
                    amount: invoice.amount_paid ? (invoice.amount_paid / 100).toFixed(2) : '0.00',
                    currency: (invoice.currency || 'gbp').toUpperCase(),
                    status: 'completed',
                    externalPaymentId: invoicePaymentIntentId || invoice.id,
                    description: `${plan.planName} — renewal`,
                    cardBrand:      renewCardBrand,
                    cardLast4:      renewCardLast4,
                    cardExpMonth:   renewCardExpMonth,
                    cardExpYear:    renewCardExpYear,
                    cardPostalCode: renewCardPostalCode,
                    paymentMethod:  renewCardBrand && renewCardLast4 ? `${renewCardBrand} ending ${renewCardLast4}` : null,
                });
            }

            // ── Create invoice record for this renewal ────────────
            const renewPlanRecord = planRecord[0]; // already fetched above
            const periodStart = invoice.period_start ? new Date(invoice.period_start * 1000) : null;
            const periodEndDate = invoice.period_end ? new Date(invoice.period_end * 1000) : null;

            const renewInv = await _createInvoice({
                userId,
                planId:               renewPlanRecord?.id ?? null,
                planName:             renewPlanRecord?.planName ?? 'Be More Swan Subscription',
                amountPence:          invoice.amount_paid || 0,
                currency:             invoice.currency || 'gbp',
                billingPeriodStart:   periodStart,
                billingPeriodEnd:     periodEndDate,
                stripeInvoiceId:      invoice.id,
                stripePaymentIntentId: invoicePaymentIntentId || null,
            });

            // ── Invoice ready notification ────────────────────────
            if (renewInv) {
                await db.insert(notifications).values({
                    userId,
                    type: 'invoice_ready',
                    title: `Your invoice for ${renewPlanRecord?.planName ?? 'your subscription'} is ready`,
                    message: `Invoice ${renewInv.invoiceNumber} has been generated. View it in your Invoice History.`,
                    isRead: false,
                    metadata: { invoiceId: renewInv.id, invoiceNumber: renewInv.invoiceNumber, action: 'view_invoices' },
                });
            }

            // ── Grace period recovery — restore assistants if plan was past_due ─
            // If the user had a payment failure + grace period active, a successful payment
            // should restore the plan to 'active' and re-enable any 'paused_payment' assistants.
            const [maybePastDuePlan] = await db
                .select({ id: plans.id })
                .from(plans)
                .where(and(eq(plans.userId, userId), eq(plans.status, 'past_due')))
                .limit(1);

            if (maybePastDuePlan) {
                await db.update(plans)
                    .set({ status: 'active', gracePeriodEndsAt: null, updatedAt: new Date() })
                    .where(eq(plans.id, maybePastDuePlan.id));

                // Re-enable assistants that were paused specifically due to payment failure
                await db.update(aiAssistants)
                    .set({ isActive: true, provisioningStatus: 'complete', updatedAt: new Date() })
                    .where(and(
                        eq(aiAssistants.userId, userId),
                        eq(aiAssistants.provisioningStatus, 'paused_payment'),
                    ));
            }

            // Auto-resolve any open "your billing is broken" action items — the payment
            // just succeeded, so the prompt to fix it is moot whether or not the plan was past_due.
            await resolveActionNotifications(db, userId, PAYMENT_RESTORED_TYPES);

            // In-app notification: Subscription renewed
            if (billingReason === 'subscription_cycle') {
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_renewed',
                    title: 'Subscription Renewed',
                    message: `Your subscription has been renewed successfully${amount ? ` — ${amount} charged` : ''}${periodEnd ? `. Active until ${periodEnd}.` : '.'}`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        amountPaid: invoice.amount_paid,
                        periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
                    },
                });
            } else {
                // Manual payment / other invoice paid (covers grace-period recovery payments)
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_payment_received',
                    title: maybePastDuePlan ? 'Payment Received — Assistants Restored' : 'Payment Received',
                    message: maybePastDuePlan
                        ? `A payment of ${amount || 'your invoice'} has been received. Your account is back to active and your assistants have been re-enabled.`
                        : `A payment of ${amount || 'your invoice'} has been received and your account is up to date.`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        amountPaid: invoice.amount_paid,
                    },
                });
            }
        }
    }

    // ── invoice.payment_failed — declined card / grace-period policy ─
    // Grace period: 7 days from first failure — assistants keep running.
    // After grace period expires (enforced by check-capacity at runtime) assistants are blocked.
    // On attempt ≥ 3 (Stripe default final attempt): pause assistants immediately.
    if (stripeEvent.type === 'invoice.payment_failed') {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        const userId  = await _resolveUserId(invoice.customer as string);
        if (userId) {
            const attemptCount = (invoice as any).attempt_count as number || 1;
            const amount       = invoice.amount_due ? `£${(invoice.amount_due / 100).toFixed(2)}` : '';
            const nextAttempt  = (invoice as any).next_payment_attempt as number | null;
            const nextTry      = nextAttempt
                ? new Date(nextAttempt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
                : null;

            // Set grace period to 7 days from now on first failure; don't extend it on subsequent failures
            const now = new Date();
            const gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

            const [existingPlan] = await db
                .select({ id: plans.id, gracePeriodEndsAt: plans.gracePeriodEndsAt })
                .from(plans)
                .where(and(eq(plans.userId, userId), inArray(plans.status, ['active', 'past_due'])))
                .limit(1);

            if (existingPlan) {
                await db.update(plans)
                    .set({
                        status: 'past_due',
                        // Only set grace period on first failure; preserve it on subsequent attempts
                        gracePeriodEndsAt: existingPlan.gracePeriodEndsAt ?? gracePeriodEndsAt,
                        updatedAt: now,
                    })
                    .where(eq(plans.id, existingPlan.id));
            }

            // On final attempt (≥ 3): immediately pause all assistants
            if (attemptCount >= 3) {
                await db.update(aiAssistants)
                    .set({ isActive: false, provisioningStatus: 'paused_payment', updatedAt: now })
                    .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));
            }

            const urgency = attemptCount >= 3
                ? 'Your assistants have been paused. Please update your payment details immediately to restore access. '
                : attemptCount === 1
                    ? `Your assistants will continue running for 7 days while we retry. `
                    : nextTry ? `We will try again on ${nextTry}. ` : '';

            await db.insert(notifications).values({
                userId,
                type: 'billing_payment_failed',
                title: `Payment Failed${attemptCount >= 3 ? ' — Assistants Paused' : ''}`,
                message: `We were unable to charge ${amount || 'your account'} for your subscription. ${urgency}Update your payment details in the Billing section.`,
                isRead: false,
                metadata: {
                    invoiceId: invoice.id,
                    amountDue: invoice.amount_due,
                    attemptCount,
                    gracePeriodEndsAt: attemptCount < 3 ? gracePeriodEndsAt.toISOString() : null,
                    nextPaymentAttempt: nextAttempt ? new Date(nextAttempt * 1000).toISOString() : null,
                },
            });

            // US-GAP-3.2.1 SC1/SC2: Day 0 dunning email — mandatory transactional (always sent, SC4)
            // SC3: Idempotency — skip if already sent for this invoice+attempt combination
            // We use processedWebhookEvents keyed on "dunning:{invoiceId}:{attemptCount}"
            const dunningDedupeKey = `dunning:${invoice.id}:attempt${attemptCount}`;
            const [alreadySent] = await db
                .select({ id: processedWebhookEvents.id })
                .from(processedWebhookEvents)
                .where(eq(processedWebhookEvents.stripeEventId, dunningDedupeKey))
                .limit(1);

            if (!alreadySent) {
                // Mark as sent before actually sending to prevent duplicate sends on concurrent retries
                await db.insert(processedWebhookEvents)
                    .values({ stripeEventId: dunningDedupeKey, eventType: 'dunning_email_sent' })
                    .onConflictDoNothing();

                // Fetch user email
                const [userRecord] = await db
                    .select({ email: users.email, firstName: users.firstName })
                    .from(users)
                    .where(eq(users.id, userId))
                    .limit(1);

                if (userRecord) {
                    // Generate Stripe billing portal URL for payment update CTA (SC2d)
                    let portalUrl = (process.env.BASE_URL || '') + '/billing.html';
                    try {
                        const portal = await stripe.billingPortal.sessions.create({
                            customer: invoice.customer as string,
                            return_url: (process.env.BASE_URL || '') + '/billing.html',
                        });
                        portalUrl = portal.url;
                    } catch { /* fall back to billing.html */ }

                    const nextRetryLine = nextTry
                        ? `<p>💳 <strong>Next automatic retry:</strong> ${nextTry}</p>`
                        : '';
                    const assistantWarning = attemptCount >= 3
                        ? `<p style="color:#dc2626;font-weight:bold;">⚠️ Your assistants have been paused due to repeated payment failures. Restore access by updating your payment details immediately.</p>`
                        : `<p>✅ Your data and assistants are safe — no changes have been made yet. We'll automatically retry the payment.</p>`;

                    // BUG-P1-1: Log at error level — dunning email is a compliance-critical touchpoint
                    await sendEmail({
                        to: userRecord.email,
                        subject: `Payment failed — action required`,
                        html: buildDunningEmail(userRecord.firstName || 'there', amount || 'see your billing page', nextRetryLine, assistantWarning, portalUrl),
                    }).catch(err => console.error('[stripe-webhook] Day 0 dunning email failed:', { userId, invoiceId: invoice.id, err: (err as any)?.message }));
                }
            }
        }
    }

    // ── charge.dispute.created — chargeback opened ────────────────
    // US-ADM-2.2.1: Record dispute, notify super_admins via in-app notification.
    if (stripeEvent.type === 'charge.dispute.created') {
        const dispute = stripeEvent.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;

        try {
            // Find the affected user via charge → payment_intent → metadata
            let affectedUserId: number | null = null;
            let chargeCustomerId: string | null = null;

            if (chargeId) {
                const charge = await stripe.charges.retrieve(chargeId) as Stripe.Charge;
                chargeCustomerId = typeof charge.customer === 'string' ? charge.customer : null;
                if (chargeCustomerId) {
                    affectedUserId = await _resolveUserId(chargeCustomerId);
                }
            }

            const amountGbp = dispute.amount ? `£${(dispute.amount / 100).toFixed(2)}` : 'unknown';
            const deadline = dispute.evidence_details?.due_by
                ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : 'check Stripe dashboard';

            // Notify the affected user (if found)
            if (affectedUserId) {
                await db.insert(notifications).values({
                    userId: affectedUserId,
                    type:   'system',
                    title:  '⚠️ Payment Dispute Opened',
                    message: `A dispute of ${amountGbp} has been opened on your account. Our team will be in touch. Evidence deadline: ${deadline}.`,
                    isRead: false,
                    metadata: { disputeId: dispute.id, reason: dispute.reason, chargeId },
                }).catch(() => {});
            }

            // Persist dispute record to DB for admin portal disputes tab
            let affectedOrgId: number | null = null;
            if (affectedUserId) {
                const [uoRow] = await db.select({ organisationId: userOrganisations.organisationId })
                    .from(userOrganisations)
                    .where(eq(userOrganisations.userId, affectedUserId))
                    .limit(1);
                affectedOrgId = uoRow?.organisationId ?? null;
            }
            // BUG-P1-1: Dispute insert must propagate — a silent swallow loses the chargeback record entirely.
            // onConflictDoNothing handles Stripe retry duplicates; genuine failures bubble to the outer catch.
            await db.insert(stripeDisputes).values({
                stripeDisputeId: dispute.id,
                stripeChargeId:  chargeId ?? null,
                userId:          affectedUserId,
                organisationId:  affectedOrgId,
                amount:          dispute.amount ?? null,
                currency:        dispute.currency ?? 'gbp',
                reason:          dispute.reason ?? null,
                status:          dispute.status,
                evidenceDeadline: dispute.evidence_details?.due_by
                    ? new Date(dispute.evidence_details.due_by * 1000)
                    : null,
            }).onConflictDoNothing();

            // Notify all super_admins
            const superAdmins = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.role, 'super_admin'));

            // BUG-P1-1: Non-critical (in-app pings) — log errors but don't return 5xx
            for (const admin of superAdmins) {
                await db.insert(notifications).values({
                    userId:  admin.id,
                    type:    'system',
                    title:   `🚨 Dispute Opened — ${amountGbp}`,
                    message: `Dispute ID: ${dispute.id}. Reason: ${dispute.reason || 'unknown'}. Affected user ID: ${affectedUserId ?? 'unknown'}. Evidence deadline: ${deadline}.`,
                    isRead: false,
                    metadata: { disputeId: dispute.id, reason: dispute.reason, amountGbp, chargeId, affectedUserId, deadline },
                }).catch(err => console.error('[stripe-webhook] Super-admin dispute notification failed:', { adminId: admin.id, disputeId: dispute.id, err: (err as any)?.message }));
            }
        } catch (dispErr) {
            console.warn('[stripe-webhook] dispute.created handling error (non-blocking):', dispErr);
        }
    }

    // ── customer.subscription.updated — plan change / downgrade ──
    // Fires when Stripe changes the subscription (upgrade, downgrade, cancel_at_period_end).
    // We enforce the new assistant limit: pause excess assistants oldest-first.
    if (stripeEvent.type === 'customer.subscription.updated') {
        const sub    = stripeEvent.data.object as Stripe.Subscription;
        const userId = await _resolveUserIdFromSub(sub);
        if (userId) {
            // Resolve new plan limits from subscription metadata
            const newMasterPlanId = sub.metadata?.masterPlanId ? parseInt(sub.metadata.masterPlanId) : null;
            if (newMasterPlanId) {
                const [newMasterPlan] = await db
                    .select({ assistantLimit: masterPlans.assistantLimit, name: masterPlans.name })
                    .from(masterPlans)
                    .where(eq(masterPlans.id, newMasterPlanId))
                    .limit(1);

                if (newMasterPlan?.assistantLimit !== null && newMasterPlan?.assistantLimit !== undefined) {
                    // Count currently active assistants
                    const activeAssistants = await db
                        .select({ id: aiAssistants.id, name: aiAssistants.name, createdAt: aiAssistants.createdAt })
                        .from(aiAssistants)
                        .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)))
                        .orderBy(desc(aiAssistants.createdAt)); // newest first → pause oldest

                    const excess = activeAssistants.length - newMasterPlan.assistantLimit;
                    if (excess > 0) {
                        // Pause the oldest (last in desc-sorted list) excess assistants
                        const toPause = activeAssistants.slice(newMasterPlan.assistantLimit);
                        const pauseIds = toPause.map(a => a.id);
                        const pausedNames = toPause.map(a => a.name).join(', ');

                        await db.update(aiAssistants)
                            .set({ isActive: false, provisioningStatus: 'paused_limit', updatedAt: new Date() })
                            .where(and(eq(aiAssistants.userId, userId), inArray(aiAssistants.id, pauseIds)));

                        await db.insert(notifications).values({
                            userId,
                            type: 'assistants_paused_downgrade',
                            title: 'Assistants Paused — Plan Limit Reached',
                            message: `Your plan change reduced your assistant limit to ${newMasterPlan.assistantLimit}. The following assistant${excess > 1 ? 's have' : ' has'} been paused: ${pausedNames}. You can delete or swap assistants from your workspace.`,
                            isRead: false,
                            metadata: { pausedIds: pauseIds, newLimit: newMasterPlan.assistantLimit },
                        });
                    }
                }
            }
        }
    }

    // ── customer.subscription.deleted — subscription cancelled ────
    if (stripeEvent.type === 'customer.subscription.deleted') {
        const sub    = stripeEvent.data.object as Stripe.Subscription;
        const userId = await _resolveUserIdFromSub(sub);
        if (userId) {
            // Mark plans as cancelled — capture cancelledAt for win-back email scheduling (US-GAP-4.2.1)
            const cancelledNow = new Date();
            await db.update(plans)
                .set({ status: 'cancelled', cancelledAt: cancelledNow, updatedAt: cancelledNow })
                .where(and(eq(plans.userId, userId), inArray(plans.status, ['active', 'cancelling', 'past_due'])));

            // Pause ALL active assistants — no active subscription
            await db.update(aiAssistants)
                .set(withUpdatedAt({ isActive: false, provisioningStatus: 'paused_payment' as const }))
                .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));

            await db.insert(notifications).values({
                userId,
                type: 'billing_cancelled',
                title: 'Subscription Cancelled — Assistants Paused',
                message: 'Your subscription has been cancelled and your Digital Assistants have been paused. You can re-subscribe at any time from the Billing area to restore full access.',
                isRead: false,
                metadata: { subscriptionId: sub.id },
            });
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a sequential invoice number and insert an invoice record.
 * Returns the newly inserted invoice.
 */
async function _createInvoice(params: {
    userId: number;
    organisationId?: number | null;
    planId?: number | null;
    planName: string;
    amountPence: number;   // Stripe amount in smallest currency unit (pence for GBP)
    currency: string;
    billingPeriodStart?: Date | null;
    billingPeriodEnd?: Date | null;
    stripeInvoiceId?: string | null;
    stripePaymentIntentId?: string | null;
}): Promise<typeof invoices.$inferSelect | null> {
    try {
        const db = getDb();
        const total    = (params.amountPence / 100).toFixed(2);
        const taxRate  = '0';    // Adjust if you collect VAT; update per-region logic here
        const taxAmt   = '0.00';
        const subtotal = total;  // subtotal == total when taxRate is 0

        // Insert with placeholder invoice number, then update once we have the DB id
        const [inv] = await db.insert(invoices).values({
            userId:               params.userId,
            organisationId:       params.organisationId ?? null,
            planId:               params.planId ?? null,
            invoiceNumber:        'PENDING',
            issueDate:            new Date(),
            billingPeriodStart:   params.billingPeriodStart ?? null,
            billingPeriodEnd:     params.billingPeriodEnd ?? null,
            planName:             params.planName,
            subtotal,
            taxRate,
            taxAmount:            taxAmt,
            total,
            currency:             (params.currency || 'GBP').toUpperCase(),
            status:               'paid',
            stripeInvoiceId:      params.stripeInvoiceId ?? null,
            stripePaymentIntentId: params.stripePaymentIntentId ?? null,
        }).returning();

        if (!inv) return null;

        // Assign deterministic invoice number: INV-YYYYMM-000001
        const now     = new Date();
        const yyyymm  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
        const invNum  = `INV-${yyyymm}-${String(inv.id).padStart(6, '0')}`;

        const [updated] = await db.update(invoices)
            .set({ invoiceNumber: invNum })
            .where(eq(invoices.id, inv.id))
            .returning();

        return updated ?? null;
    } catch (err) {
        console.error('[stripe-webhook] _createInvoice failed:', (err as any)?.message);
        return null;
    }
}

/**
 * Resolve our internal userId from a Stripe customer ID.
 * Checks customer metadata first (auraUserId), then falls back to email lookup.
 */
async function _resolveUserId(customerId: string): Promise<number | null> {
    try {
        const customerResp = await stripe.customers.retrieve(customerId);
        if (!customerResp || (customerResp as Stripe.DeletedCustomer).deleted) return null;
        const customer = customerResp as Stripe.Customer;

        // Fast path: metadata set at checkout
        if (customer.metadata?.auraUserId) {
            return parseInt(customer.metadata.auraUserId);
        }

        // Fallback: email lookup in our DB
        if (customer.email) {
            const db = getDb();
            const [user] = await db.select({ id: users.id })
                .from(users).where(eq(users.email, customer.email));
            return user?.id ?? null;
        }
    } catch (err) {
        console.warn('[stripe-webhook] _resolveUserId failed:', (err as any)?.message);
    }
    return null;
}

/**
 * Resolve userId from a Stripe Subscription object.
 * Uses subscription metadata first, then falls back to customer lookup.
 */
async function _resolveUserIdFromSub(sub: Stripe.Subscription): Promise<number | null> {
    if (sub.metadata?.userId) return parseInt(sub.metadata.userId);
    return _resolveUserId(sub.customer as string);
}
