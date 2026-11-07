// netlify/functions/review-link.ts
// Signed in: make, list and revoke guest review links (src/utils/review-links.ts).
//
// GET  ?postId=N                                → { links: [...] }
// GET  ?postIds=1,2,3                           → { statuses: { postId: { label, at } } } for card chips
// POST { action:'create', postId, label?, email? } → { url, linkId, expiresAt, emailed }
// POST { action:'revoke', linkId }              → { revoked }
//
// The link's address is only ever returned by create, because only its hash is stored. Chat's card
// calls this same endpoint on the user's click.

import { withLambda } from '@netlify/aws-lambda-compat';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, users } from '../../db/schema';
import { looksLikeEmail, normaliseEmail } from '../../src/utils/audience-contacts';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { sendEmail } from '../../src/utils/email';
import { checkRateLimit } from '../../src/utils/rate-limit';
import {
    MAX_EMAILS_PER_ORG_PER_DAY, createReviewLink, listReviewLinks, reviewStatusForPosts, revokeReviewLink,
} from '../../src/utils/review-links';
import { requireTenant } from '../../src/utils/tenant';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (statusCode: number, body: unknown) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) });

const esc = (s: string): string => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function emailLink(to: string, url: string, sender: string, workspace: string): Promise<void> {
    await sendEmail({
        to,
        subject: `${workspace} would like your thoughts`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:32px auto;color:#111827">
  <p style="font-size:16px;line-height:1.6"><strong>${esc(sender)}</strong> at <strong>${esc(workspace)}</strong> would like your thoughts on a social media post before it goes out.</p>
  <p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;background:#d6006b;color:#fff;font-weight:700;text-decoration:none;border-radius:8px">Take a look</a></p>
  <p style="font-size:13px;color:#6b7280;line-height:1.6">No account is needed. If you weren't expecting this, you can ignore it.</p>
</div>`,
    });
}

export default withLambda(async (event) => {
    const db = getDb();
    // Viewers can look at responses, but only people who work on posts can share them.
    const ctx = await requireTenant(event, db, event.httpMethod === 'GET' ? undefined : { roles: ['owner', 'admin', 'member'] });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    if (event.httpMethod === 'GET') {
        const rawIds = event.queryStringParameters?.postIds;
        if (rawIds) {
            const ids = rawIds.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
            return json(200, { statuses: await reviewStatusForPosts(db, orgId, ids) });
        }
        const postId = Number(event.queryStringParameters?.postId);
        if (!Number.isInteger(postId) || postId <= 0) return json(400, { error: 'postId is required.' });
        const links = await listReviewLinks(db, orgId, postId);
        if (!links) return json(404, { error: 'That post could not be found.' });
        return json(200, { links });
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    if (body.action === 'revoke') {
        const linkId = Number(body.linkId);
        if (!Number.isInteger(linkId) || linkId <= 0) return json(400, { error: 'linkId is required.' });
        return json(200, { revoked: await revokeReviewLink(db, orgId, linkId) });
    }

    if (body.action !== 'create') return json(400, { error: 'Unknown action.' });
    const postId = Number(body.postId);
    if (!Number.isInteger(postId) || postId <= 0) return json(400, { error: 'postId is required.' });

    // Refuse a bad address before making a link nobody will receive.
    const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
    const email = rawEmail ? normaliseEmail(rawEmail) : '';
    if (rawEmail && !looksLikeEmail(email)) return json(400, { error: 'That email address does not look right.' });

    const base = resolveBaseUrl(event.headers);
    if (!base) return json(500, { error: 'Server misconfigured.' });

    if (email) {
        const limit = await checkRateLimit(db, 'review_link_email', `org:${orgId}`, { maxAttempts: MAX_EMAILS_PER_ORG_PER_DAY, windowSecs: 86_400 });
        if (!limit.allowed) return json(429, { error: 'You have sent a lot of review emails today. Copy the link instead, or try again tomorrow.' });
    }

    const made = await createReviewLink(db, { orgId, userId: ctx.userId, postId, label: body.label });
    if (!made.ok) return json(made.status, { error: made.error });
    const url = `${base}/r/${made.token}`;

    let emailed = false;
    if (email) {
        const [sender] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, ctx.userId)).limit(1);
        const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const senderName = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || 'Someone';
        try {
            await emailLink(email, url, senderName, org?.name || 'A Be More Swan customer');
            emailed = true;
        } catch (err) {
            // The link exists and can still be copied, so this is not a failure of the whole request.
            console.warn('[review-link] email failed:', (err as Error).message);
        }
    }

    return json(200, { url, linkId: made.linkId, expiresAt: made.expiresAt, emailed });
});
