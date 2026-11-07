// netlify/functions/accept-invite.ts
// US-GAP-5.1.1: Accept an organisation invite via magic link
//
// GET  ?invite=<rowId>&orgId=<id>&role=<role>&exp=<ms>&sig=<signature>  says what the invite is. Writes nothing.
// POST { invite, orgId, role, exp, sig }                                accepts it. Only a person's click sends this.
//
// Links emailed before 2026-11-07 carry `token` instead of `invite` and `exp`. See invite-link.ts.
//
// Email scanners (Outlook / Hotmail Safe Links) open links and run page scripts before the person
// does (prod user 39, 2026-10-27). Accepting on GET let one join the workspace in the person's place,
// and their own click then found the link spent. Anything a scanner can reach by opening the link
// must stay read-only.
//
// SECURITY: two checks prove an invite, both before anything is written: the signature made by
// invite-member.ts (src/utils/invite-link.ts), and this user's pending 'invited' row for this org.
//
// SC2:  Resolves the stub user, sets password/status, joins org with correct role
// SC5:  If token expired (> 7 days) — answers 410 and the page says so
// Flow: Sets JWT session cookie and tells the page to go to /workspace.html

import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, organisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { recordLogin } from '../../src/utils/login-events';
import { isInviteRole, verifyInviteLink, verifyInviteSignature } from '../../src/utils/invite-link';
import { maskEmail, sessionUserId } from '../../src/utils/login-link';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET!;
const BASE_URL  = process.env.BASE_URL || '';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const answer = (statusCode: number, body: Record<string, unknown>) =>
    ({ statusCode, headers: JSON_HEADERS as Record<string, string>, body: JSON.stringify(body) });

/** One reply for every refusal, so it never reveals whether a workspace or an invite exists. */
const INVALID_INVITE = answer(400, { error: 'Invalid invite link. Please ask your workspace admin to send a new invite.' });
const EXPIRED_INVITE = answer(410, { error: 'Please ask your workspace admin to send a new invite.', expired: true });

const wholeNumber = (value: unknown): number | null =>
    typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : null;

export default withLambda(async (event) => {
    const isAccept = event.httpMethod === 'POST';
    if (!isAccept && event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    let link: Record<string, unknown>;
    try {
        link = isAccept ? JSON.parse(event.body || '{}') : (event.queryStringParameters || {});
    } catch {
        return INVALID_INVITE;
    }
    if (!link || typeof link !== 'object') return INVALID_INVITE;

    const plainToken = typeof link.token === 'string' ? link.token : '';
    const inviteId   = wholeNumber(link.invite);
    const expiresAtMs = wholeNumber(link.exp);
    const orgId      = parseInt(typeof link.orgId === 'string' ? link.orgId : '');
    const role       = typeof link.role === 'string' && link.role ? link.role : 'member';
    const sig        = typeof link.sig === 'string' ? link.sig : null;

    const isRowLink = inviteId !== null && expiresAtMs !== null;
    if ((!isRowLink && !plainToken) || !orgId || !isInviteRole(role)) return INVALID_INVITE;
    if (!jwtSecret) return answer(500, { error: 'Server misconfigured.' });
    const signed = isRowLink
        ? verifyInviteLink(inviteId, orgId, role, expiresAtMs, sig, jwtSecret)
        : verifyInviteSignature(plainToken, orgId, role, sig, jwtSecret);
    if (!signed) return INVALID_INVITE;

    const db = getDb();
    const now = new Date();

    const userColumns = { id: users.id, email: users.email, tokenExpiresAt: users.tokenExpiresAt, status: users.status };
    let user: { id: number; email: string; tokenExpiresAt: Date | string | null; status: string } | undefined;

    /** Opening an invite again after joining. Signs nobody in: only someone already logged in as them goes on. */
    const alreadyJoined = async (userId: number) => {
        const [joined] = await db
            .select({ name: organisations.name })
            .from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const loggedIn = sessionUserId(event.headers.cookie) === userId;
        return answer(200, { alreadyJoined: true, orgName: joined?.name || null, ...(loggedIn ? { redirect: `${BASE_URL}/workspace.html` } : {}) });
    };

    if (isRowLink) {
        const [invite] = await db
            .select({ userId: userOrganisations.userId, role: userOrganisations.role })
            .from(userOrganisations)
            .where(and(eq(userOrganisations.id, inviteId), eq(userOrganisations.organisationId, orgId)))
            .limit(1);
        if (!invite) return INVALID_INVITE; // Replaced by a resend, or withdrawn
        if (invite.role !== 'invited') return alreadyJoined(invite.userId);
        // SC5: Check expiry
        if (now.getTime() > expiresAtMs) return EXPIRED_INVITE;
        [user] = await db.select(userColumns).from(users).where(eq(users.id, invite.userId)).limit(1);
    } else {
        const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
        [user] = await db.select(userColumns).from(users).where(eq(users.verificationToken, hashedToken)).limit(1);
        if (!user) {
            // The token is gone once used, so only a session can say whose link this was.
            const sessionUser = sessionUserId(event.headers.cookie);
            if (sessionUser !== null) {
                const [membership] = await db
                    .select({ role: userOrganisations.role })
                    .from(userOrganisations)
                    .where(and(eq(userOrganisations.userId, sessionUser), eq(userOrganisations.organisationId, orgId)))
                    .limit(1);
                if (membership && membership.role !== 'invited') return alreadyJoined(sessionUser);
            }
            return INVALID_INVITE;
        }
        // SC5: Check expiry
        const tokenExpiry = user.tokenExpiresAt instanceof Date
            ? user.tokenExpiresAt
            : user.tokenExpiresAt ? new Date(user.tokenExpiresAt as string) : null;
        if (tokenExpiry && now > tokenExpiry) return EXPIRED_INVITE;
    }

    if (!user) return INVALID_INVITE;
    // Accepting makes an account active, so it must never be how a locked one gets back in.
    if (user.status === 'locked') return INVALID_INVITE;
    const userId = user.id;

    // Opening the link stops here. This is all a scanner ever reaches.
    if (!isAccept) {
        const [pending] = await db
            .select({ id: userOrganisations.id })
            .from(userOrganisations)
            .where(and(
                eq(userOrganisations.userId, userId),
                eq(userOrganisations.organisationId, orgId),
                eq(userOrganisations.role, 'invited'),
            ))
            .limit(1);
        if (!pending) return INVALID_INVITE;
        const [invitedTo] = await db
            .select({ name: organisations.name })
            .from(organisations).where(eq(organisations.id, orgId)).limit(1);
        return answer(200, { orgName: invitedTo?.name || null, role, email: maskEmail(user.email) });
    }

    // An invite must be waiting for this person in this workspace. Claiming the row is the first
    // write, and only an 'invited' row can be claimed, so a member's or owner's role never changes here.
    const assignedRole = role;
    const claimed = await db.update(userOrganisations)
        .set({ role: assignedRole })
        .where(and(
            eq(userOrganisations.userId, userId),
            eq(userOrganisations.organisationId, orgId),
            eq(userOrganisations.role, 'invited'),
            ...(isRowLink ? [eq(userOrganisations.id, inviteId)] : []),
        ))
        .returning({ id: userOrganisations.id });
    if (claimed.length === 0) return INVALID_INVITE;

    // Mark user as verified. Only a token-based link clears the token: otherwise it belongs to a
    // login or sign-up link that is nothing to do with this invite.
    await db.update(users)
        .set({
            status:    'active',
            updatedAt: now,
            ...(isRowLink ? {} : { verificationToken: null, tokenExpiresAt: null }),
        })
        .where(eq(users.id, userId));

    // In-app notification: welcome to the org
    const [org] = await db
        .select({ name: organisations.name })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const orgName = org?.name || 'your new workspace';

    await createNotification(db, 'org_joined', {
        userId,
        context: { org: { name: orgName, role: assignedRole } },
        metadata: { orgId, role: assignedRole },
    });

    // Issue a session JWT. ⚠️ NOT HttpOnly: auth-check.js reads this cookie from document.cookie, so a
    // hardened one sends the person to the login page the moment they arrive (see review-login.ts).
    const token = jwt.sign({ userId, activeOrganisationId: orgId }, jwtSecret, { expiresIn: '7d' });
    await recordLogin(db, { userId, organisationId: orgId, method: 'invite', headers: event.headers });
    const cookieOpts = [
        `aura_session=${token}`,
        'Path=/',
        'SameSite=Lax',
        'Max-Age=604800',
        ...(COOKIE_DOMAIN ? [`Domain=${COOKIE_DOMAIN}`] : []),
        ...(BASE_URL.startsWith('https') ? ['Secure'] : []),
    ].join('; ');

    return {
        statusCode: 200,
        headers: { ...JSON_HEADERS, 'Set-Cookie': cookieOpts } as Record<string, string>,
        body: JSON.stringify({ success: true, redirect: `${BASE_URL}/workspace.html?joined=${encodeURIComponent(orgName)}` }),
    };
});
