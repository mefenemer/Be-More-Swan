// verify.ts
import { Handler, HandlerResponse } from '@netlify/functions';
import { eq, and, gt, inArray, isNull } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users, plans, aiAssistants, onboardingDrafts, notifications, userProfiles } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { getEmailStrings } from '../../src/utils/email-i18n';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { resolveActiveOrg } from '../../src/utils/tenant';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';

// Define a helper to ensure type safety for headers
const getHeaders = (cookie?: string): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    if (cookie) {
        headers['Set-Cookie'] = cookie;
    }
    return headers;
};

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: getHeaders(),
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const jwtSecret = process.env.JWT_SECRET;
        const stripeSecret = process.env.STRIPE_SECRET_KEY;

        if (!jwtSecret || !stripeSecret) {
            console.error('CRITICAL: JWT_SECRET or STRIPE_SECRET_KEY env var is missing.');
            return {
                statusCode: 500,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Server configuration error. Please contact support.' })
            };
        }

        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });
        const body = JSON.parse(event.body || '{}');
        const { token: plainToken, priceId } = body;
        // US-ONB-2.1.2 AC9: safe relative post-login redirect (must start with / to prevent open redirect)
        const postLoginRedirect: string | undefined = typeof body.redirect === 'string' && body.redirect.startsWith('/') && !body.redirect.startsWith('//') ? body.redirect : undefined;

        if (!plainToken) {
            return {
                statusCode: 400,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Verification token is required.' })
            };
        }

        const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
        const db = getDb();

        const [user] = await db.select()
            .from(users)
            .where(and(eq(users.verificationToken, hashedToken), gt(users.tokenExpiresAt, new Date())))
            .limit(1);

        if (!user) {
            return {
                statusCode: 400,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Invalid or expired verification link.' })
            };
        }

        // US-ADM-1.1.1: Block locked accounts from logging in
        if (user.status === 'locked') {
            return {
                statusCode: 403,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Your account has been locked. Please contact support@bemoreswan.com for assistance.' })
            };
        }

        // Detect first-ever login (was 'pending_verification' → now 'active')
        const isFirstLogin = user.status === 'pending_verification';

        await db.update(users)
            .set({ status: 'active', verificationToken: null, tokenExpiresAt: null, updatedAt: new Date() })
            .where(eq(users.id, user.id));

        // ── US3 Sc3 + US2 Sc1: Welcome + onboard prompt on first login ───────
        if (isFirstLogin) {
            try {
                await db.insert(notifications).values([
                    {
                        userId: user.id,
                        type: 'welcome',
                        title: 'Welcome to Be More Swan!',
                        message: 'Thanks for registering and welcome to Be More Swan. Your workspace is ready.',
                    },
                    {
                        userId: user.id,
                        type: 'onboarding_prompt',
                        title: 'Finish setting up your workspace',
                        message: "Open the Setup Wizard to build your AI assistant — it walks you through every step, from your business details to going live.",
                        metadata: { action: 'open_wizard', ctaLabel: 'Open Setup Wizard' },
                    },
                ]);
            } catch (notifErr) {
                console.warn('[verify] Welcome notification insert failed (non-blocking):', notifErr);
            }

            // US-GAP-6.1.1 SC1/SC2: Welcome email — sent exactly once (SC3: gated by isFirstLogin)
            // SC4: arrives before the 24h onboarding reminder (onboarding-reminder.ts fires at 24h)
            const emailBaseUrl  = resolveBaseUrl(event.headers) || 'https://bemoreswan.com';
            const onboardingUrl = `${emailBaseUrl}/onboarding.html`;
            const helpUrl       = `${emailBaseUrl}/help.html`;
            const [verifyProfile] = await getDb().select({ language: userProfiles.language })
                .from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1);
            const emailStr = getEmailStrings(verifyProfile?.language);
            sendEmail({
                to: user.email,
                subject: emailStr.welcome_subject(user.firstName || 'there'),
                html: `<p>Hi ${user.firstName || 'there'},</p>
                       <p>Your email is verified — welcome to Be More Swan! You're moments away from having your own AI team member handling the work you don't have time for.</p>
                       <h3 style="margin-top:24px;">Here's how to get started in 3 steps:</h3>
                       <ol style="padding-left:1.2rem;line-height:2">
                         <li><strong>Complete your business profile</strong> — tell us about your business so your assistant understands your brand</li>
                         <li><strong>Choose your assistant</strong> — pick the role that matches the work you want automated</li>
                         <li><strong>Connect your tools</strong> — link your social accounts, calendar, or CRM to let your assistant get to work</li>
                       </ol>
                       <p style="margin-top:24px;">
                         <a href="${onboardingUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                           Set Up My First Assistant →
                         </a>
                       </p>
                       <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                         Need help? Visit our <a href="${helpUrl}">Help Centre</a> or reply to this email.
                       </p>
                       <p>The Be More Swan Team</p>`,
            }).catch(err => console.warn('[verify] Welcome email failed (non-blocking):', err));
        }

        // US-ADM-5.2.2: embed adminRole in JWT so the workspace sidebar can show the Admin Portal launcher
        const ADMIN_ROLES = ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent'];
        const tokenPayload: Record<string, unknown> = { userId: user.id, email: user.email };
        if (user.role && ADMIN_ROLES.includes(user.role)) tokenPayload.adminRole = user.role;
        // Select the active tenant for the session (sole / most-recently-joined membership).
        const activeOrg = await resolveActiveOrg(db, user.id);
        if (activeOrg) tokenPayload.activeOrganisationId = activeOrg.organisationId;
        const signedToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '7d' });
        const sessionCookie = `aura_session=${signedToken}; Path=/; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;

        const baseUrl = resolveBaseUrl(event.headers);
        if (!baseUrl) return { statusCode: 500, body: 'Server misconfigured.' };

        // Map Stripe price IDs → tier keys (test + live environments)
        const priceToTier: Record<string, string> = {
            // Test price IDs
            'price_1TgGNFE7lvVYjk1BAsnhUzBp': 'buster',
            'price_1TgGP8E7lvVYjk1BRBeEZVd6': 'saver',
            'price_1TgGPfE7lvVYjk1B1CQrS6pE': 'employee',
            // Live price IDs
            'price_1Tg6f1CuS8qyNSsFxeUsfi4a': 'buster',
            'price_1Tg6fQCuS8qyNSsF5DKmEqMu': 'saver',
            'price_1Tg6fiCuS8qyNSsF787zwCwh': 'employee',
        };

        // Onboarding path → HTML page map (mirrors onboarding-reminder.ts)
        const ONBOARDING_PAGE: Record<string, string> = {
            'social-media':  'onboarding-social-media.html',
            'social_media':  'onboarding-social-media.html',
            'custom':        'onboarding-custom.html',
            'inventory':     'onboarding-inventory.html',
            'performance':   'onboarding-performance.html',
        };

        // If no priceId — this is a returning user logging in (not a new registration).
        // Priority order:
        //   0. super_admin / admin role                    → admin portal
        //   1. active plan + incomplete onboarding draft   → resume onboarding step
        //   2. active plan + at least one assistant        → workspace (P3: re-discovery)
        //   3. active plan + no assistant                  → pricing / onboarding
        //   4. past_due plan (grace period) + assistants   → workspace with billing warning
        //   5. cancelled / no plan + existing assistants   → workspace (can view, not use)
        //   6. no plan + no assistants                     → pricing
        if (!priceId || !priceToTier[priceId]) {
            // Case 0: Admin / superuser
            // US-ADM-5.2.2: Dual-role — if the admin also has an active workspace plan, send them
            // to workspace.html (the Admin Portal launcher appears in the sidebar).
            // Admin-only accounts (no active plan) still go straight to the admin portal.
            if (user.role && ADMIN_ROLES.includes(user.role)) {
                const [adminPlan] = await db
                    .select({ id: plans.id })
                    .from(plans)
                    .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                    .limit(1);
                if (adminPlan) {
                    // Dual-role: has an active workspace — land on workspace dashboard
                    return {
                        statusCode: 200,
                        headers: getHeaders(sessionCookie),
                        body: JSON.stringify({ success: true, redirect: `${baseUrl}/workspace.html` })
                    };
                }
                // Admin-only: no active workspace plan → go straight to admin portal
                return {
                    statusCode: 200,
                    headers: getHeaders(sessionCookie),
                    body: JSON.stringify({ success: true, redirect: `${baseUrl}/admin.html` })
                };
            }
            // Check for any plan (active OR past_due — include grace-period plans)
            const [existingPlan] = await db
                .select({ id: plans.id, status: plans.status })
                .from(plans)
                .where(eq(plans.userId, user.id))
                .orderBy(plans.startedAt)
                .limit(1);

            // P3: Always check for existing assistants — even without an active plan
            // a user may have paused assistants they want to see in the workspace.
            const [existingAssistant] = await db
                .select({ id: aiAssistants.id, provisioningStatus: aiAssistants.provisioningStatus })
                .from(aiAssistants)
                .where(eq(aiAssistants.userId, user.id))
                .limit(1);

            const hasAnyPlan      = !!existingPlan;
            const hasActivePlan   = existingPlan?.status === 'active';
            const hasPastDuePlan  = existingPlan?.status === 'past_due';
            const hasAnyAssistant = !!existingAssistant;

            // Case 1: Has active plan — check onboarding completeness
            if (hasActivePlan) {
                if (!hasAnyAssistant) {
                    // Incomplete onboarding — US2 Sc2: fire reminder notification (best-effort).
                    // Dedup: this runs on EVERY login, so only insert if there isn't already an
                    // open (unresolved) setup reminder — otherwise they pile up (the "3 reminders" bug).
                    try {
                        const [existingReminder] = await db.select({ id: notifications.id })
                            .from(notifications)
                            .where(and(
                                eq(notifications.userId, user.id),
                                inArray(notifications.type, ['onboarding_incomplete', 'onboarding_prompt']),
                                isNull(notifications.resolvedAt),
                            ))
                            .limit(1);
                        if (!existingReminder) {
                            await db.insert(notifications).values({
                                userId: user.id,
                                type: 'onboarding_incomplete',
                                title: 'Complete your assistant setup',
                                message: 'You have not yet completed the onboarding of your digital assistant. Pick up where you left off.',
                            });
                        }
                    } catch { /* non-blocking */ }

                    // Route back to the exact step they left off
                    const [draft] = await db
                        .select({ currentStep: onboardingDrafts.currentStep, onboardingPath: onboardingDrafts.onboardingPath })
                        .from(onboardingDrafts)
                        .where(eq(onboardingDrafts.userId, user.id))
                        .limit(1);

                    if (draft) {
                        const page = ONBOARDING_PAGE[draft.onboardingPath] || 'onboarding.html';
                        return {
                            statusCode: 200,
                            headers: getHeaders(sessionCookie),
                            body: JSON.stringify({
                                success: true,
                                redirect: `${baseUrl}/${page}?step=${draft.currentStep}&resumed=true`
                            })
                        };
                    }
                }

                // Active plan + assistants → straight to workspace (honour post-login redirect if present)
                return {
                    statusCode: 200,
                    headers: getHeaders(sessionCookie),
                    body: JSON.stringify({ success: true, redirect: postLoginRedirect ? `${baseUrl}${postLoginRedirect}` : `${baseUrl}/workspace.html` })
                };
            }

            // Case 4 & 5: past_due / cancelled / no plan — if they have assistants
            // send to workspace so they can see their existing setup and take action.
            // The workspace will show a payment warning banner via check-capacity.ts.
            if (hasAnyAssistant) {
                const suffix = hasPastDuePlan ? '?alert=payment_overdue' : (hasAnyPlan ? '?alert=subscription_ended' : '?alert=no_plan');
                return {
                    statusCode: 200,
                    headers: getHeaders(sessionCookie),
                    body: JSON.stringify({ success: true, redirect: postLoginRedirect ? `${baseUrl}${postLoginRedirect}` : `${baseUrl}/workspace.html${suffix}` })
                };
            }

            // Case 6: No plan, no assistants → send to the workspace and open the (non-dismissible)
            // plan-selection gate via ?action=select-plan (workspace.html shows it immediately), rather
            // than the standalone pricing page. Honour an explicit post-login redirect if present.
            return {
                statusCode: 200,
                headers: getHeaders(sessionCookie),
                body: JSON.stringify({ success: true, redirect: postLoginRedirect ? `${baseUrl}${postLoginRedirect}` : `${baseUrl}/workspace.html?action=select-plan` })
            };
        }

        const tierKey = priceToTier[priceId];
        return {
            statusCode: 200,
            headers: getHeaders(sessionCookie),
            body: JSON.stringify({ success: true, redirect: `${baseUrl}/checkout.html?tier=${tierKey}` })
        };
    } catch (error: any) {
        // BUG-P1-5: Log full error server-side; never return internal detail to the client.
        console.error('[verify] Unhandled error:', error);
        return {
            statusCode: 500,
            headers: getHeaders(),
            body: JSON.stringify({ error: 'Verification failed. Please try again or request a new link.' }),
        };
    }
};