// netlify/functions/newsletter-unsubscribe.ts
// The front door for a SUBSCRIBER leaving a tenant's newsletter.
//
//   HEAD                  → 200, records nothing (link scanners pre-fetch)
//   GET  ?t=<token>       → the preference page: pause, cap the frequency, or leave
//   POST ?t=<token>       → applies the chosen preference, and RFC 8058 one-click
//
// ⚠️ THE ONE-CLICK POST IGNORES THE CHOICES AND ALWAYS UNSUBSCRIBES. RFC 8058 requires a
// List-Unsubscribe-Post request to unsubscribe with no further interaction, and mail clients fire
// it on the reader's behalf from a button labelled "unsubscribe". Answering it with a preference
// menu would be a spec violation and a dark pattern in the same move.
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
import { newsletterIssues, newsletterSends, newsletterSequenceEnrolments, organisations } from '../../db/schema';
import { setContactStatus } from '../../src/utils/audience-store';
import { applyPreference, parseChoice, PREFERENCE_OPTIONS } from '../../src/utils/audience-preferences';
import { haltEnrolmentsForContact } from '../../src/utils/newsletter-sequence';
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
button{cursor:pointer;background:#111827;color:#fff;border:none;font-size:.95rem;font-weight:700;padding:.75rem 1.25rem;border-radius:.6rem;margin-top:1rem}
.opt{display:flex;gap:.65rem;align-items:flex-start;text-align:left;border:1px solid #e5e7eb;border-radius:.6rem;padding:.75rem .85rem;margin-top:.6rem;cursor:pointer}
.opt:hover{background:#f9fafb}.opt input{margin-top:.25rem}
.opt small{color:#6b7280;line-height:1.45}</style></head>
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

        // Issue sends first — the common case by volume.
        const [sendRow] = await db
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

        // ⚠️ THEN welcome-sequence enrolments. A sequence step has no newsletter_sends row, so its
        // footer carries the ENROLMENT's token — and without this branch every welcome email in the
        // product would offer an unsubscribe link that answers "we couldn't find that
        // subscription". That reads as a company refusing to let you leave, which is worse than
        // sending no link at all.
        const [seqRow] = sendRow ? [] : await db
            .select({
                enrolmentId: newsletterSequenceEnrolments.id,
                organisationId: newsletterSequenceEnrolments.organisationId,
                contactId: newsletterSequenceEnrolments.contactId,
                email: newsletterSequenceEnrolments.email,
                senderName: organisations.name,
            })
            .from(newsletterSequenceEnrolments)
            .leftJoin(organisations, eq(organisations.id, newsletterSequenceEnrolments.organisationId))
            .where(eq(newsletterSequenceEnrolments.unsubscribeToken, token))
            .limit(1);

        const row = sendRow
            ? { ...sendRow, contactId: null as number | null, fromSequence: false }
            : seqRow
                ? { sendId: null as number | null, issueId: null as number | null, ...seqRow, fromSequence: true }
                : null;

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
            // ⚠️ The preference page, NOT a wall between the reader and the exit. "Stop all emails"
            // is one of the options, on the same page, styled as plainly as the rest — a centre
            // that makes leaving harder than it was is worse than none at all, because the reader
            // who cannot find the exit presses "report spam", and that costs the sending domain far
            // more than one lost subscriber.
            const options = PREFERENCE_OPTIONS.map((o, i) => `
                <label class="opt">
                  <input type="radio" name="choice" value="${esc(o.choice)}"${i === 0 ? ' checked' : ''}>
                  <span><strong>${esc(o.label)}</strong><br><small>${esc(o.detail)}</small></span>
                </label>`).join('');
            return page(200, 'Your email preferences',
                `<p>Emails from ${who} to <strong>${esc(row.email)}</strong>.</p>
                 <form method="POST" action="/api/newsletter/unsubscribe">
                   <input type="hidden" name="t" value="${esc(token)}">
                   <input type="hidden" name="confirmed" value="1">
                   ${options}
                   <button type="submit">Save my choice</button>
                 </form>`, '✉️');
        }

        // ⚠️ ONE-CLICK IS NEVER A PREFERENCE. RFC 8058 requires a List-Unsubscribe-Post request to
        // unsubscribe immediately with no further interaction, and mail clients send it on the
        // reader's behalf. Only a submitted form can carry a choice; anything else unsubscribes.
        const choice = oneClick ? 'unsubscribe' : (parseChoice(new URLSearchParams(event.body || '').get('choice')) ?? 'unsubscribe');

        if (choice !== 'unsubscribe') {
            const result = await applyPreference(db, {
                organisationId: row.organisationId,
                email: row.email,
                contactId: row.contactId,
                choice,
                channel: 'email_link',
                issueId: row.issueId,
            });
            // No contact row means the person was erased. Nothing to pause, and nothing that could
            // email them either — so this is a success from where they are standing.
            return page(200, 'That is saved',
                `<p>${esc(result?.message ?? 'You will not hear from us.')}</p>`);
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

        // Stop anything already queued. The consent check at send time would catch them anyway —
        // this closes the enrolment at the same moment, so "why did this stop?" is answerable from
        // the row rather than inferable from an absence.
        await haltEnrolmentsForContact(db, {
            organisationId: row.organisationId,
            contactId: row.contactId,
            email: row.email,
            reason: 'unsubscribed',
        });

        // Best-effort reporting. The person is already unsubscribed; a failure here costs a number
        // on a dashboard, and must not turn a completed unsubscribe into an error page.
        // A sequence step belongs to no issue, so there is no counter to move for one.
        if (row.issueId) {
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
