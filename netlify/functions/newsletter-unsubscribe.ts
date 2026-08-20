// netlify/functions/newsletter-unsubscribe.ts
// The front door for a SUBSCRIBER leaving a tenant's newsletter.
//
//   HEAD                  → 200, records nothing (link scanners pre-fetch)
//   GET  ?t=<token>       → a page with a button
//   POST ?t=<token>       → the unsubscribe itself, and RFC 8058 one-click
//
// ⚠️ THREE UNSUBSCRIBE ROUTES NOW EXIST and they are not interchangeable:
//   • win-back-unsubscribe.ts  — Be More Swan's own marketing to our own USERS (win_back_opt_outs)
//   • lead-unsubscribe.ts      — a tenant's cold outreach to a PROSPECT (lead_opt_outs, replyToken)
//   • this one                 — a tenant's newsletter to a SUBSCRIBER (audience_contacts)
// Different tables, different credentials, different people. Reaching for the wrong one is the
// collision that has already happened twice in this codebase.
//
// ⚠️ UNLIKE THE CONFIRMATION LINK, a GET here is safe to answer with a page and a POST is safe to
// action without a human — including the automated one-click POST Gmail and Yahoo fire. The
// asymmetry is deliberate: a false positive on CONFIRM subscribes someone who never asked, while a
// false positive here costs one subscriber. Only one of those is a harm to a stranger.

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContacts, newsletterIssues, newsletterSends, organisations } from '../../db/schema';
import { setContactStatus } from '../../src/utils/audience-store';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Mirrors the token minted in the send worker — a loose pattern would send junk to the lookup. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const esc = (s: string): string => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(statusCode: number, heading: string, bodyHtml: string, icon = '✅') {
    return {
        statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(heading)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;padding:1rem}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:460px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#6b7280;font-size:.925rem;line-height:1.6;margin:.5rem 0}
button{cursor:pointer;background:#111827;color:#fff;border:none;font-size:.95rem;font-weight:700;padding:.75rem 1.25rem;border-radius:.6rem;margin-top:1rem}</style></head>
<body><div class="card">
  <div style="font-size:2rem;margin-bottom:1rem">${icon}</div>
  <h1>${esc(heading)}</h1>
  ${bodyHtml}
</div></body></html>`,
    };
}

export default withLambda(async (event) => {
    const method = event.httpMethod;
    if (method === 'HEAD') return { statusCode: 200, body: '' };
    if (method !== 'GET' && method !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // One-click clients POST with an empty or form-encoded body and no query string preserved by
    // some proxies, so the token is read from both places.
    const token = (event.queryStringParameters?.t
        || (method === 'POST' ? new URLSearchParams(event.body || '').get('t') : '')
        || '').trim();

    const oneClick = method === 'POST' && !new URLSearchParams(event.body || '').get('confirmed');

    if (!TOKEN_RE.test(token)) {
        return method === 'POST'
            ? { statusCode: 200, body: 'ok' }
            : page(400, 'This link is not valid',
                '<p>The unsubscribe link looks incomplete. Reply to the email you received and ask to be removed — we will do it by hand.</p>', '⚠️');
    }

    try {
        const db = getDb();

        const [row] = await db
            .select({
                sendId: newsletterSends.id,
                organisationId: newsletterSends.organisationId,
                issueId: newsletterSends.issueId,
                email: newsletterSends.email,
                senderName: organisations.name,
            })
            .from(newsletterSends)
            .leftJoin(organisations, eq(organisations.id, newsletterSends.organisationId))
            .where(eq(newsletterSends.unsubscribeToken, token))
            .limit(1);

        if (!row || !row.email) {
            // Never "not found" — from the reader's side that reads as "your request failed", and
            // they will either give up or press the spam button, which is far more expensive.
            return method === 'POST'
                ? { statusCode: 200, body: 'ok' }
                : page(404, 'We could not find that subscription',
                    '<p>This link may have expired. Reply to the email you received and ask to be removed — we will do it by hand.</p>', '⚠️');
        }

        const who = esc(row.senderName || 'this sender');

        if (method === 'GET') {
            return page(200, 'Unsubscribe',
                `<p>Stop receiving emails from ${who} at <strong>${esc(row.email)}</strong>?</p>
                 <form method="POST" action="/api/newsletter/unsubscribe">
                   <input type="hidden" name="t" value="${esc(token)}">
                   <input type="hidden" name="confirmed" value="1">
                   <button type="submit">Unsubscribe me</button>
                 </form>`, '✉️');
        }

        // ⚠️ The audience row is the source of truth for every assistant, so this is the write that
        // matters — not the ledger row below. setContactStatus records the consent event in the
        // same transaction, so an unsubscribe can never exist without evidence of how it happened.
        await setContactStatus(db, {
            organisationId: row.organisationId,
            email: row.email,
            status: 'unsubscribed',
            event: 'unsubscribed',
            channel: oneClick ? 'one_click' : 'email_link',
            issueId: row.issueId,
            evidence: oneClick
                ? 'RFC 8058 one-click unsubscribe (List-Unsubscribe-Post)'
                : 'Clicked the unsubscribe link in a newsletter',
        });

        // Best-effort reporting. The person is already unsubscribed; a failure here costs a number
        // on a dashboard, and must not turn a completed unsubscribe into an error page.
        try {
            await db.update(newsletterIssues)
                .set({ unsubscribedCount: sql`${newsletterIssues.unsubscribedCount} + 1` })
                .where(and(
                    eq(newsletterIssues.id, row.issueId),
                    eq(newsletterIssues.organisationId, row.organisationId),
                ));
        } catch (err) {
            console.error('[newsletter-unsubscribe] recorded, but the issue counter was not updated', { sendId: row.sendId }, err);
        }

        if (oneClick) return { statusCode: 200, body: 'ok' };
        return page(200, 'You are unsubscribed',
            `<p>You will not receive any more emails from ${who}.</p>`);
    } catch (err) {
        // An unrecorded unsubscribe means we keep emailing someone who asked us not to — the worst
        // outcome this file can produce, so it is logged loudly and never shown as a stack trace.
        console.error('[newsletter-unsubscribe] FAILED to record an unsubscribe', { token: token.slice(0, 6) + '…' }, err);
        return method === 'POST'
            ? { statusCode: 200, body: 'ok' }
            : page(500, 'Something went wrong',
                '<p>We could not process that just now. Please try the link again, or reply to the email and ask to be removed.</p>', '⚠️');
    }
});
