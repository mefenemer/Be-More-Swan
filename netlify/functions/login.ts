// netlify/functions/login.ts
import { Handler } from '@netlify/functions';
import { eq, and, or, isNull, lt, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users, userProfiles } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { getEmailStrings } from '../../src/utils/email-i18n';
import { resolveBaseUrl } from '../../src/utils/base-url';

export const handler: Handler = async (event) => {
    const db = getDb();

    if (event.httpMethod === 'POST') {
        try {
            // SC2 — US-GAP-7.1.1: IP-level rate limit: 5 requests per IP per 60 seconds
            // (Email-level rate limiting is already handled atomically via lastMagicLinkSentAt.)
            const ip = getClientIp(event.headers);
            const rl = await checkRateLimit(db, 'login', ip, { maxAttempts: 5, windowSecs: 60 });
            if (!rl.allowed) {
                return {
                    statusCode: 429,
                    headers: { 'Retry-After': String(rl.retryAfterSecs) },
                    body: JSON.stringify({ error: 'Too many requests. Please try again later.' }),
                };
            }

            const body = JSON.parse(event.body || '{}');
            const email = body.email?.trim().toLowerCase();
            // US-ONB-2.1.2 AC9: post-login redirect destination (e.g. /workspace.html?action=select-plan)
            const postLoginRedirect: string | undefined = typeof body.redirect === 'string' && body.redirect.startsWith('/') ? body.redirect : undefined;

            if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };

            const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

            if (user && user.status === 'active') {
                // ── Race-safe rate limit (SCENARIO 5) ──────────────────────
                // A naive read-then-write check has a TOCTOU race: two concurrent
                // requests both pass the check before either writes the fence.
                //
                // Fix: use a single conditional UPDATE that sets lastMagicLinkSentAt
                // only when the previous value is NULL or older than 60 seconds.
                // If 0 rows are updated, another request just won the race → silently drop.
                const RATE_WINDOW_MS = 60 * 1000; // 60 seconds
                const rateFence = new Date(Date.now() - RATE_WINDOW_MS);

                const plainToken = crypto.randomBytes(32).toString('hex');
                const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
                const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
                const now = new Date();

                // Atomically claim the send slot and write the token in one UPDATE.
                // Only updates if lastMagicLinkSentAt IS NULL or < (now - 60s).
                const updated = await db.update(users)
                    .set({
                        verificationToken: hashedToken,
                        tokenExpiresAt,
                        lastMagicLinkSentAt: now,
                        updatedAt: now,
                    })
                    .where(and(
                        eq(users.id, user.id),
                        or(
                            isNull(users.lastMagicLinkSentAt),
                            lt(users.lastMagicLinkSentAt, rateFence),
                        ),
                    ))
                    .returning({ id: users.id });

                if (updated.length === 0) {
                    // Rate-limited (or concurrent request won the race) — return 200 to prevent enumeration
                    console.log(`[Rate Limit] Magic link blocked for: ${email}`);
                    return { statusCode: 200, body: JSON.stringify({ message: 'If an account exists, a link was sent.' }) };
                }

                // Prefer BASE_URL; fall back to DEPLOY_PRIME_URL / request host for deploy previews.
                const baseUrl = resolveBaseUrl(event.headers);
                if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
                const magicLink = `${baseUrl}/verify-account.html?token=${plainToken}${postLoginRedirect ? `&redirect=${encodeURIComponent(postLoginRedirect)}` : ''}`;

                // US-I18N-1.2 SC4: use user's preferred language for email subject/greeting
                const [profile] = await db.select({ language: userProfiles.language })
                    .from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1);
                const emailStr = getEmailStrings(profile?.language);
                const greeting = emailStr.magic_link_greeting(user.firstName || 'there');

                await sendMagicLinkEmail({
                    to: email,
                    subject: emailStr.magic_link_subject,
                    html: `
                        <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                            <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                                <h2 style="color: #1f1e1b; margin-top: 0;">${greeting}</h2>
                                <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">Click the button below to securely log into your Be More Swan dashboard.</p>
                                <a href="${magicLink}" style="background-color: #00e55c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 24px 0; font-weight: bold; font-size: 16px;">
                                    Log In
                                </a>
                                <p style="color: #787263; font-size: 14px; margin-bottom: 0;">This secure link expires in 15 minutes.</p>
                            </div>
                        </div>
                    `
                });
            }

            // Always return 200 OK (Enumeration Protection)
            return { statusCode: 200, body: JSON.stringify({ message: 'If an account exists, a link was sent.' }) };
        } catch (error) {
            console.error('Login Request Error:', error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
        }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};