// netlify/functions/review-login.ts
//
// Password sign-in for ONE named account, so an external reviewer can get into the product.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Google's OAuth verification team requires "active test credentials" with "all authentication
// blockers removed". Our only login is the magic link in login.ts: it emails a single-use token
// that expires in 15 minutes, and login.html only mails addresses that already have an account.
// That hands a reviewer a mailbox they must be able to OPEN, which is exactly the blocker Google
// asks us to remove — and handing over the credentials to a real Gmail inbox is worse, not better.
//
// ── The safety model, in order of what an attacker would have to beat ────────
//  1. DARK BY DEFAULT. With REVIEW_LOGIN_PASSWORD unset, every request gets a plain 404 — the
//     same response a nonexistent function gives. Deleting that env var in Netlify switches this
//     off completely with no deploy. That is the intended off switch.
//     ⚠️ It is the ONLY off switch. The account address is hardcoded (DEFAULT_REVIEW_EMAIL), so
//     unlike the first cut of this file there is no second env var to clear.
//  2. FAILS CLOSED ON A DATE. REVIEW_LOGIN_EXPIRES (an ISO date) turns it off by itself once
//     verification is done, so a forgotten backdoor stops being one. An unparseable value is
//     treated as EXPIRED, never as "no expiry" — a typo must not silently extend it.
//  3. ONE ACCOUNT ONLY. The address must equal REVIEW_LOGIN_EMAIL. There is no lookup path to any
//     other user, so this cannot become a general password login even if the secret leaks.
//  4. A WEAK SECRET IS REFUSED. Under MIN_SECRET_LEN characters the endpoint stays dark rather
//     than accepting a guessable password.
//  5. Constant-time comparison over SHA-256 digests (equal-length buffers, so neither the value
//     nor its length leaks through timing), and an IP rate limit on top.
//
// ⚠️ This is deliberately NOT wired into login.html. Normal users keep the magic-link flow
// untouched; this lives on its own page (review-login.html) whose URL goes only to the reviewer.
//
// The session it mints is byte-for-byte the one verify.ts issues — same JWT claims, same cookie
// attributes — because the workspace reads them both. In particular the cookie is NOT HttpOnly:
// auth-check.js and admin.html read it from document.cookie, and a hardened cookie here would
// produce a session that silently fails to work only on this path.

import { eq } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Short enough to type from an email, long enough that the rate limit is not the only defence. */
export const MIN_SECRET_LEN = 20;

/**
 * The account reviewer sign-in is for, unless REVIEW_LOGIN_EMAIL overrides it.
 *
 * ⚠️ This must name a user row that ALREADY EXISTS with status 'active' — this endpoint
 * authenticates, it never provisions. Pointing it at an address with no account produces a plain
 * "credentials were not recognised", which looks exactly like a wrong password and is the most
 * likely way to waste an afternoon here. The mismatch is logged at error level for that reason.
 *
 * ⚠️ Hardcoding it means REVIEW_LOGIN_PASSWORD is now the ONLY thing gating this endpoint. That is
 * deliberate — an address is not a secret and the password is what actually guards the door — but
 * it does mean deleting the password env var is the single off switch. There is no second lock.
 */
export const DEFAULT_REVIEW_EMAIL = 'bmsreview.test@gmail.com';

export type ReviewConfig =
    | { enabled: false; reason: 'unconfigured' | 'weak_secret' | 'expired' | 'bad_expiry' }
    | { enabled: true; email: string; secret: string };

/**
 * Decide whether reviewer sign-in is live, from environment alone.
 *
 * Pulled out of the handler so the rules that keep this endpoint dark are testable without a
 * database, a Request, or a deploy — see tests/review-login.test.ts. Every `enabled: false`
 * answer produces an identical 404 at the edge; the reason is for logs and tests only, and must
 * never reach the caller.
 */
export function resolveReviewConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ReviewConfig {
    const email = (env.REVIEW_LOGIN_EMAIL ?? DEFAULT_REVIEW_EMAIL).trim().toLowerCase();
    const secret = env.REVIEW_LOGIN_PASSWORD ?? '';
    const expiresRaw = (env.REVIEW_LOGIN_EXPIRES ?? '').trim();

    if (!email || !secret) return { enabled: false, reason: 'unconfigured' };
    if (secret.length < MIN_SECRET_LEN) return { enabled: false, reason: 'weak_secret' };

    if (expiresRaw) {
        const expiresAt = new Date(expiresRaw);
        // ⚠️ An unreadable date is EXPIRED, never "no expiry". A typo in the env var must not
        // silently extend a temporary credential into a permanent one.
        if (Number.isNaN(expiresAt.getTime())) return { enabled: false, reason: 'bad_expiry' };
        if (expiresAt.getTime() <= Date.now()) return { enabled: false, reason: 'expired' };
    }

    return { enabled: true, email, secret };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The 404 an unconfigured or expired endpoint returns — identical to a function that isn't there. */
const NOT_FOUND = { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Not found.' }) };

/**
 * Compare two secrets without leaking their contents or their lengths through timing.
 * Hashing first is what makes the buffers equal-length; timingSafeEqual throws on a mismatch.
 */
function secretsMatch(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a, 'utf8').digest();
    const hb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(ha, hb);
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // (1), (2) and (4) all live here. Any negative answer is the same 404 to the caller.
    const config = resolveReviewConfig(process.env);
    if (!config.enabled) {
        if (config.reason !== 'unconfigured') console.warn(`[review-login] Refused: ${config.reason}.`);
        return NOT_FOUND;
    }
    const { email: reviewEmail, secret: reviewSecret } = config;

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        console.error('[review-login] CRITICAL: JWT_SECRET is missing.');
        return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const db = getDb();

        const ip = getClientIp(event.headers);
        const rl = await checkRateLimit(db, 'review-login', ip, { maxAttempts: 8, windowSecs: 300 });
        if (!rl.allowed) {
            return {
                statusCode: 429,
                headers: { ...JSON_HEADERS, 'Retry-After': String(rl.retryAfterSecs) },
                body: JSON.stringify({ error: 'Too many attempts. Please wait a few minutes and try again.' }),
            };
        }

        const body = JSON.parse(event.body || '{}');
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!email || !password) {
            return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Email and password are required.' }) };
        }

        // (3) + (5). Both comparisons run every time — returning early on a wrong address would
        // turn response time into an oracle for "is this the review account?".
        const emailOk = secretsMatch(email, reviewEmail);
        const secretOk = secretsMatch(password, reviewSecret);
        if (!emailOk || !secretOk) {
            console.warn(`[review-login] Failed attempt from ${ip}.`);
            return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Those credentials were not recognised.' }) };
        }

        const [user] = await db.select().from(users).where(eq(users.email, reviewEmail)).limit(1);
        if (!user) {
            // Configured for an address with no account — a setup error, not a caller error. Say so
            // in the logs; the caller still gets nothing it could probe with.
            console.error(`[review-login] REVIEW_LOGIN_EMAIL names an address with no user row.`);
            return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Those credentials were not recognised.' }) };
        }
        if (user.status !== 'active') {
            return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: 'This account is not active.' }) };
        }

        // ── Mint the SAME session verify.ts does ─────────────────────────────
        // ⚠️ Kept in step with verify.ts by hand. The claims are what requireTenant and the admin
        // surfaces read; drop activeOrganisationId and the workspace loads with no tenant at all.
        const ADMIN_ROLES = ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent'];
        const tokenPayload: Record<string, unknown> = { userId: user.id, email: user.email };
        if (user.role && ADMIN_ROLES.includes(user.role)) tokenPayload.adminRole = user.role;
        const activeOrg = await resolveActiveOrg(db, user.id);
        if (activeOrg) tokenPayload.activeOrganisationId = activeOrg.organisationId;

        const signedToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '7d' });
        const sessionCookie = `aura_session=${signedToken}; Path=/; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;

        const baseUrl = resolveBaseUrl(event.headers);
        if (!baseUrl) {
            console.error('[review-login] resolveBaseUrl returned nothing — check the Host header.');
            return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Server misconfigured.' }) };
        }

        // Straight to the workspace. verify.ts branches across onboarding drafts, plan states and
        // admin portals to decide where a user lands; none of that applies here, because this path
        // serves one pre-provisioned account whose destination is known. A reviewer following
        // written steps needs the SAME page every time far more than it needs that cleverness.
        console.warn(`[review-login] Review session issued to user ${user.id} from ${ip}.`);
        return {
            statusCode: 200,
            headers: { ...JSON_HEADERS, 'Set-Cookie': sessionCookie },
            body: JSON.stringify({ success: true, redirect: `${baseUrl}/workspace.html` }),
        };
    } catch (error) {
        console.error('[review-login] Unhandled error:', error);
        return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Sign-in failed. Please try again.' }) };
    }
});
