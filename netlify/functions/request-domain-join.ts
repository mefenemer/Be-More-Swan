// request-domain-join.ts — Abuse Prevention US4 (AC4.3, Corporate Domain Consolidation).
// POST { email, firstName?, lastName? }   (UNAUTHENTICATED — the requester has no account yet)
//
// Triggered from the registration "your company already uses Be More Swan" prompt. It looks up the
// PAID workspace that owns the email's business domain and notifies that workspace's owner (in-app
// suggested_action + email) so they can invite the requester via the normal team-invite flow,
// keeping billing consolidated. The requester never learns who owns the workspace.
//
// Always returns a generic { ok: true } (never reveals workspace existence/identity beyond what the
// registration prompt already implied) and never creates an account. Rate-limited per IP.

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { notifications } from '../../db/schema';
import { businessDomainOf } from '../../src/utils/email-domain';
import { findPaidDomainWorkspace } from '../../src/utils/domain-workspace';
import { sendEmail } from '../../src/utils/email';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();

    // Same envelope as registration: 5 requests / IP / 60s, so the prompt can't be used to fan out
    // join requests / probe which domains have workspaces.
    const ip = getClientIp(event.headers);
    const rl = await checkRateLimit(db, 'request-domain-join', ip, { maxAttempts: 5, windowSecs: 60 });
    if (!rl.allowed) {
        return { statusCode: 429, headers: { 'Retry-After': String(rl.retryAfterSecs) }, body: JSON.stringify({ error: 'Too many requests. Please try again later.' }) };
    }

    let body: { email?: string; firstName?: string; lastName?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    const email = (body.email || '').trim().toLowerCase();
    const firstName = body.firstName?.trim() || '';
    if (!email) return json(400, { error: 'email is required.' });

    // Recompute the domain server-side — never trust a client-supplied domain.
    const businessDomain = businessDomainOf(email);
    const target = businessDomain ? await findPaidDomainWorkspace(db, businessDomain) : null;

    // Generic response either way — timing/availability must not reveal more than the prompt did.
    if (!target) return json(200, { ok: true });

    const requesterLabel = firstName ? `${firstName} (${email})` : email;

    await db.insert(notifications).values({
        userId: target.ownerUserId,
        type: 'domain_join_request',
        category: 'suggested_action',
        title: 'Workspace join request',
        message: `${requesterLabel} signed up with a ${businessDomain} email and would like to join your workspace. Invite them to keep your team on one account?`,
        metadata: { requestingEmail: email, requestingFirstName: firstName, domain: businessDomain },
    }).catch((e) => { console.warn('[request-domain-join] notification insert failed (non-blocking):', e); });

    await sendEmail({
        to: target.ownerEmail,
        subject: `Someone from ${businessDomain} wants to join your workspace`,
        html: `<p>Hi ${target.ownerFirstName || 'there'},</p>
               <p><strong>${requesterLabel}</strong> tried to sign up for Be More Swan with a <strong>${businessDomain}</strong> email, which already belongs to your workspace.</p>
               <p>If this is a colleague, invite them to your workspace so your team stays on one account and billing stays consolidated. Log in and open your team members page to send the invite.</p>
               <p>If you don't recognise this person, you can safely ignore this email.</p>`,
    }).catch(() => {/* non-blocking */});

    return json(200, { ok: true });
};
