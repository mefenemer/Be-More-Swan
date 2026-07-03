// netlify/functions/register.ts
import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users, organisations, userOrganisations, userProfiles, plans, masterPlans, userReferrals, referralInvites } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { isRegistrationLocked } from '../../src/utils/platform-config';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { businessDomainOf } from '../../src/utils/email-domain';
import { findPaidDomainWorkspace } from '../../src/utils/domain-workspace';
import { isEuCountry } from '../../src/config/compliance';

const slugify = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

// EU AI Act Article 50: EU-jurisdiction orgs must have aiDisclosureFooterEnabled=true by default.
// Jurisdiction list lives in src/config/compliance.ts (AC4.1 modular compliance layer).
function isEuJurisdiction(headers: Record<string, string | undefined>): boolean {
    // Netlify edge provides x-nf-country on all requests
    return isEuCountry(headers['x-nf-country'] || headers['x-country']);
}

const SUPPORTED_LANGS = ['en', 'fr', 'de', 'es', 'pt'];

function detectLangFromHeader(acceptLanguage: string | undefined): string {
    if (!acceptLanguage) return 'en';
    const preferred = acceptLanguage.split(',').map(s => s.split(';')[0].trim().slice(0, 2).toLowerCase());
    return preferred.find(l => SUPPORTED_LANGS.includes(l)) || 'en';
}


export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // TEMP DEBUG (staging): track how far we get so a 500 names the failing phase. Remove after diagnosis.
    let phase = 'init';
    try {
        // SC1 — US-GAP-7.1.1: IP-level rate limit: 5 requests per IP per 60 seconds
        phase = 'rate-limit';
        const db = getDb();
        const ip = getClientIp(event.headers);
        const rl = await checkRateLimit(db, 'register', ip, { maxAttempts: 5, windowSecs: 60 });
        if (!rl.allowed) {
            return {
                statusCode: 429,
                headers: { 'Retry-After': String(rl.retryAfterSecs) },
                body: JSON.stringify({ error: 'Too many requests. Please try again later.' }),
            };
        }

        // US-ADM-3.2.1: New registration lock
        if (await isRegistrationLocked()) {
            return { statusCode: 403, body: JSON.stringify({ error: 'New registrations are temporarily paused. Please check back soon.' }) };
        }

        phase = 'parse-validate';
        const body = JSON.parse(event.body || '{}');

        const rawEmail = body.email || '';
        const email = rawEmail.trim().toLowerCase();
        const firstName = body.firstName?.trim();
        const lastName = body.lastName?.trim();
        const businessName = body.businessName?.trim() || `${firstName}'s Workspace`;
        const priceId = body.priceId?.trim() || null;
        const isTrial = body.trial === true || body.trial === 'true'; // US-GAP-8.1.1 SC1
        const attributionRef = body.attributionRef?.trim() || null; // US-AUD-5.3.1 SC5
        const referralRef = body.referralRef?.trim() || null;        // US-GAP-8.2: workspace referral code
        // US4 (Domain Consolidation): set once the user has seen the consolidation prompt and
        // explicitly chose to create their own separate workspace anyway.
        const forceNewWorkspace = body.forceNewWorkspace === true || body.forceNewWorkspace === 'true';
        const preferredLang = detectLangFromHeader(event.headers['accept-language']);

        if (!email || !firstName || !lastName) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
        }

        // Resolve the verification-link origin up front — BEFORE any DB writes — so a missing
        // BASE_URL can never leave behind a half-registered user with no email sent.
        const baseUrl = resolveBaseUrl(event.headers);
        if (!baseUrl) {
            console.error('[register] Could not resolve base URL (BASE_URL unset and no host header)');
            return { statusCode: 500, body: JSON.stringify({ error: 'Registration failed. Please try again.' }) };
        }

        // BUG-P2-9: Enforce maximum field lengths to prevent oversized DB inserts
        if (firstName.length > 100 || lastName.length > 100 || businessName.length > 200) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Input fields exceed maximum length.' }) };
        }

        // --- SCENARIO 5: ENUMERATION PROTECTION ---
        // Check if user already exists BEFORE doing anything else
        phase = 'duplicate-check';
        const existingUsers = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (existingUsers.length > 0) {
            // Silently return success to the UI to prevent scraping, do not create a duplicate
            console.log(`[Security] Blocked duplicate registration attempt for: ${email}`);
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // US-GAP-8.1.1 SC8: One trial per email — check historical user records
        // (Even if the user deleted their account, the email may have had a trial before)
        // We check `plans` via the deleted user's email match via users join — but since
        // we do a hard-delete cascade, check instead via a dedicated trialHistory or
        // rely on the existingUsers check above (returning users just see the login flow).

        // --- US4: CORPORATE DOMAIN CONSOLIDATION ---
        // Before creating anything, if this is a non-public business email whose domain already
        // belongs to a PAID workspace, pause onboarding and offer to request to join it (AC4.2/4.3)
        // — unless the user already saw the prompt and chose to make their own workspace anyway.
        // The silent domain AUTO-JOIN path (allow_domain_join && domain_verified) takes precedence
        // and is handled inside the transaction below, so we never prompt when we'd auto-join.
        phase = 'domain-consolidation';
        if (!forceNewWorkspace) {
            const businessDomain = businessDomainOf(email);
            if (businessDomain) {
                const target = await findPaidDomainWorkspace(db, businessDomain);
                const willAutoJoin = !!target && target.allowDomainJoin && target.domainVerified;
                if (target && !willAutoJoin) {
                    // Pause: surface the consolidation prompt. We deliberately do NOT reveal the
                    // workspace name or owner — only that the company already uses Be More Swan.
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            consolidation: { domain: businessDomain, appName: 'Be More Swan' },
                        }),
                    };
                }
            }
        }

        // Generate Security Tokens (15 min expiry per AC)
        const plainToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
        const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

        phase = 'transaction';
        // --- SCENARIO 2: NEW REGISTRATION & DATA CAPTURE ---
        const resultUser = await db.transaction(async (tx) => {

            // 1. Create User
            const [newUser] = await tx.insert(users).values({
                email,
                firstName,
                lastName,
                status: 'pending_verification',
                verificationToken: hashedToken, // Save the HASHED token
                tokenExpiresAt
            }).returning();

            // 2. Resolve the organisation — join an existing one by business domain, or create.
            // #2: if the email is a NON-public business domain and an existing org has opted in
            // to domain join (allow_domain_join + domain_verified), the user joins THAT org as a
            // member instead of getting their own isolated workspace. Public providers
            // (gmail/outlook/…) resolve to null here, so unrelated users are never merged.
            const businessDomain = businessDomainOf(email);
            let joinOrg: { id: number } | null = null;
            if (businessDomain) {
                const [match] = await tx.select({ id: organisations.id })
                    .from(organisations)
                    .where(and(
                        eq(organisations.businessDomain, businessDomain),
                        eq(organisations.allowDomainJoin, true),
                        eq(organisations.domainVerified, true),
                    ))
                    .limit(1);
                joinOrg = match ?? null;
            }

            let orgId: number;
            if (joinOrg) {
                // Join the existing workspace as a member (no new org/plan — shares the org's plan).
                orgId = joinOrg.id;
                await tx.insert(userOrganisations).values({
                    userId: newUser.id, organisationId: orgId, role: 'member',
                });
            } else {
                // Create a fresh organisation owned by this user.
                // EU AI Act Art. 50: enable disclosure footer by default for EU workspaces.
                const euJurisdiction = isEuJurisdiction(event.headers);
                const [newOrg] = await tx.insert(organisations).values({
                    name: businessName,
                    slug: `${slugify(businessName)}-${crypto.randomBytes(3).toString('hex')}`,
                    businessDomain: businessDomain ?? null, // stored for a future opt-in; join stays OFF by default
                    ...(euJurisdiction ? { aiDisclosureFooterEnabled: true } : {}),
                }).returning();
                orgId = newOrg.id;
                await tx.insert(userOrganisations).values({
                    userId: newUser.id, organisationId: orgId, role: 'owner',
                });
            }

            // 4. Update User with Org ID
            await tx.update(users)
                .set({ organisationId: orgId, updatedAt: new Date() })
                .where(eq(users.id, newUser.id));

            // 5. Create default User Profile (Crucial for Account Settings hydration)
            await tx.insert(userProfiles).values({
                userId: newUser.id,
                timezone: 'Europe/London',
                language: preferredLang,
                notifyWins: true,
                notifyBilling: true,
                notifyAvailability: false,
                // Default email delivery preferences (Scenario 3)
                // Transactional types are always true; others default as shown.
                emailPreferences: {
                    payment_confirmation:    true,  // transactional — locked on
                    account_creation:        true,  // transactional — locked on
                    account_cancellation:    true,  // transactional — locked on
                    invoice_ready:           true,
                    assistant_tasks:         true,
                    onboarding_reminders:    true,
                    new_role_availability:   false,
                    content_calendar:        true,
                },
            });

            // BUG-P2-5: Trial masterPlan catalog row must exist before registration runs.
            // The upsert was removed from here — it belongs in db/seed-catalog.ts so it
            // only runs once at deploy time, not on every registration request.
            // Members joining an existing org share that org's plan — only start a trial
            // for a brand-new org.
            if (isTrial && !joinOrg) {
                const [trialMasterPlan] = await tx
                    .select({ id: masterPlans.id })
                    .from(masterPlans)
                    .where(eq(masterPlans.tierKey, 'trial'))
                    .limit(1);

                if (!trialMasterPlan) {
                    throw new Error('Trial plan not seeded. Run db/seed-catalog.ts before accepting trial registrations.');
                }

                const trialExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

                await tx.insert(plans).values({
                    userId: newUser.id,
                    organisationId: orgId,
                    masterPlanId: trialMasterPlan.id,
                    planName: 'Free Trial',
                    planType: 'trial',
                    status: 'active',
                    expiresAt: trialExpiresAt,
                });
            }

            return newUser;
        });

        // Send the First-Time Verification Email — baseUrl was resolved above (prefers BASE_URL env,
        // falls back to the request host for deploy previews). Resolved before the DB transaction
        // so a missing config fails fast rather than orphaning a half-created user.
        const magicLink = `${baseUrl}/verify-account.html?token=${plainToken}${priceId ? `&priceId=${encodeURIComponent(priceId)}` : ''}${isTrial ? '&trial=true' : ''}`;

        // Verification email is BEST-EFFORT: the account + workspace are already committed
        // above, so a transient email failure (Resend outage, unverified domain, missing key)
        // must NOT 500 the request and orphan an account the user can never get into. We record
        // whether it actually sent so the client can surface a "Resend verification" affordance.
        // (sendMagicLinkEmail returns null when no Resend key is configured — nothing was sent.)
        phase = 'send-email';
        let emailSent = false;
        try {
            const sendResult = await sendMagicLinkEmail({
                to: email,
                subject: 'Welcome to Be More Swan - Verify your email',
                html: `
                    <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                        <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                            <h2 style="color: #1f1e1b; margin-top: 0;">Welcome, ${firstName}!</h2>
                            <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">Click the button below to securely verify your account and complete your workspace setup.</p>
                            <a href="${magicLink}" style="background-color: #00e55c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 24px 0; font-weight: bold; font-size: 16px;">
                                Verify & Log In
                            </a>
                            <p style="color: #787263; font-size: 14px; margin-bottom: 0;">This secure link expires in 15 minutes.</p>
                        </div>
                    </div>
                `
            });
            emailSent = sendResult !== null;
        } catch (emailErr) {
            console.error('[register] Verification email failed to send (account created; user can resend):', emailErr);
        }

        // US-GAP-8.2: Record workspace referral if signup came from a referral link
        if (referralRef && resultUser) {
            try {
                // SC5: Prevent self-referral — look up owner of this code
                const [referrer] = await db.select({ id: users.id })
                    .from(users)
                    .where(eq(users.referralCode, referralRef))
                    .limit(1);

                if (referrer && referrer.id !== resultUser.id) {
                    // SC6: Only create one referral row per referred user (unique constraint on referredUserId)
                    await db.insert(userReferrals).values({
                        referrerId: referrer.id,
                        referredUserId: resultUser.id,
                        referralCode: referralRef,
                        status: 'pending',
                    }).onConflictDoNothing();

                    // Close the loop on a sent invite: if this email was invited by the
                    // referrer, mark it accepted so it advances past "awaiting sign-up".
                    await db.update(referralInvites)
                        .set({ status: 'accepted', acceptedUserId: resultUser.id, acceptedAt: new Date() })
                        .where(and(
                            eq(referralInvites.referrerId, referrer.id),
                            eq(referralInvites.email, email),   // already normalized lowercase
                            eq(referralInvites.status, 'invited'),
                        ));
                }
            } catch (refErr) {
                console.warn('[referral] Failed to record referral:', refErr);
            }
        }

        // US-AUD-5.3.1 SC5: Record referral attribution if signup came from agency badge link
        if (attributionRef && resultUser) {
            try {
                const { organisations: orgsTable, referralAttribution } = await import('../../db/schema');
                const { and: andOp } = await import('drizzle-orm');
                const [referrerOrg] = await db
                    .select({ id: orgsTable.id })
                    .from(orgsTable)
                    .where(andOp(eq(orgsTable.slug, attributionRef), eq(orgsTable.agencyAttributionEnabled, true)))
                    .limit(1);
                if (referrerOrg) {
                    await db.insert(referralAttribution).values({
                        referrerOrgId: referrerOrg.id,
                        newUserId: resultUser.id,
                        sourceType: 'agency_badge',
                    });
                }
            } catch (refErr) {
                console.warn('[attribution] Failed to record referral:', refErr);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                emailSent,
                message: emailSent
                    ? 'Registration processed.'
                    : 'Your account was created, but we could not send the verification email. Please use the “Resend verification” option to receive your link.',
            }),
        };
    } catch (error: any) {
        // BUG-P1-5: Log full error server-side but never return internal detail to the client.
        // DB constraint names, column names, and query fragments aid attacker reconnaissance.
        console.error(`[register] Unhandled error at phase "${phase}":`, error);
        return {
            statusCode: 500,
            // TEMP DEBUG (staging): _debug surfaces the failing phase + error message in the
            // response so it can be read from the Network tab while function logs are unavailable.
            // REMOVE _debug (and the phase tracking) once the cause is identified.
            body: JSON.stringify({
                error: 'Registration failed. Please try again.',
                _debug: { phase, detail: String(error?.message || error) },
            }),
        };
    }
};