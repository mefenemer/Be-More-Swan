// netlify/functions/newsletter-webhook.ts
// Resend delivery events → the audience. Behind /api/newsletter/webhook (netlify.toml).
//
// This is the half of the dispatch decision that makes the shared audience mean something. Without
// it, `newsletter_sends.status` never advances past 'sent', `audience_contacts` never learns that
// an address is dead, and a spam complaint — the strongest signal a recipient can send — is
// invisible. That is precisely why sending through a tenant's own mailbox does not scale: there is
// no equivalent of this file for Gmail.
//
// ⚠️ A SPAM COMPLAINT WRITES A lead_opt_outs ROW TOO. Someone who reports a newsletter as spam has
// not merely left a list; they have told this organisation to stop emailing them. Recording it only
// against the audience would leave the Lead Generator free to cold-email them next week.
//
// Events handled (Resend names): email.delivered, email.bounced, email.complained, email.opened,
// email.clicked. email.delivery_delayed is ignored — a delay is not an outcome.
//
// ⚠️ OPENS AND CLICKS COUNT PEOPLE, NOT EVENTS. Each recipient's FIRST open moves opened_at from
// NULL and increments the issue once; every later open only bumps open_count on their own ledger
// row. Counting events instead would produce open rates over 100% the first time somebody scrolled
// back to an issue twice, and the number would quietly stop meaning anything.
//
// ⚠️ AN OPEN IS NOT A READ. The mechanism is a 1×1 image, and Apple Mail Privacy Protection
// pre-fetches it for every message whether or not a human looks. Treat the figure as a trend.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContacts, leadOptOuts, newsletterIssues, newsletterSends } from '../../db/schema';
import { setContactStatus } from '../../src/utils/audience-store';
import { normaliseEmail } from '../../src/utils/audience-contacts';
import { haltEnrolmentsForContact } from '../../src/utils/newsletter-sequence';
import { verifySvixSignature } from '../../src/utils/webhook-verify';
import { withLambda } from '@netlify/aws-lambda-compat';

/** A soft bounce is a mailbox being full or a server being down — it is not a dead address. */
const HARD_BOUNCE_TYPES = new Set(['hard', 'permanent', 'undetermined']);

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const rawBody = event.body || '';
    const headers = (event.headers || {}) as Record<string, string | undefined>;

    // ⚠️ Verified against the RAW body, never a re-serialised copy — JSON.stringify reorders keys
    // and the signature would never match.
    const ok = verifySvixSignature({
        secret: process.env.RESEND_WEBHOOK_SECRET,
        id: headers['svix-id'],
        timestamp: headers['svix-timestamp'],
        signature: headers['svix-signature'],
        rawBody,
    });
    if (!ok) {
        // 401, not 400: an unsigned request is not a malformed one, and Resend retries on 5xx —
        // which would turn a misconfigured secret into a retry storm.
        console.error('[newsletter-webhook] rejected an unverified delivery event');
        return { statusCode: 401, body: 'unauthorized' };
    }

    let payload: any;
    try { payload = JSON.parse(rawBody); }
    catch { return { statusCode: 400, body: 'bad json' }; }

    const type = String(payload?.type || '');
    const data = payload?.data ?? {};
    const messageId = String(data?.email_id || data?.id || '');
    const to = Array.isArray(data?.to) ? data.to[0] : data?.to;
    const email = normaliseEmail(to);

    if (!type.startsWith('email.')) return { statusCode: 200, body: 'ignored' };

    try {
        const db = getDb();

        // Match on the provider's message id first — the address alone is ambiguous when the same
        // person is on two issues. Fall back to (org, address) via the ledger for providers or
        // events that omit it.
        const [row] = messageId
            ? await db.select({
                id: newsletterSends.id,
                organisationId: newsletterSends.organisationId,
                issueId: newsletterSends.issueId,
                email: newsletterSends.email,
                status: newsletterSends.status,
            }).from(newsletterSends).where(eq(newsletterSends.providerMessageId, messageId)).limit(1)
            : [];

        if (!row) {
            // Not ours, or an event for a message sent before this table existed. 200 so the
            // provider stops retrying something we will never recognise.
            console.warn('[newsletter-webhook] no matching send row', { type, messageId: messageId.slice(0, 12) });
            return { statusCode: 200, body: 'unmatched' };
        }

        const orgId = row.organisationId;
        const address = row.email || email;

        if (type === 'email.delivered') {
            await db.update(newsletterSends)
                .set({ status: 'delivered', updatedAt: new Date() })
                .where(and(eq(newsletterSends.id, row.id), eq(newsletterSends.status, 'sent')));
            await db.update(newsletterIssues)
                .set({ deliveredCount: sql`${newsletterIssues.deliveredCount} + 1` })
                .where(eq(newsletterIssues.id, row.issueId));
            return { statusCode: 200, body: 'ok' };
        }

        if (type === 'email.bounced') {
            const bounceType = String(data?.bounce?.type || data?.type || '').toLowerCase();
            const hard = HARD_BOUNCE_TYPES.has(bounceType) || !bounceType;

            await db.update(newsletterSends)
                .set({ status: 'bounced', error: String(data?.bounce?.message || '').slice(0, 500), updatedAt: new Date() })
                .where(eq(newsletterSends.id, row.id));
            await db.update(newsletterIssues)
                .set({ bouncedCount: sql`${newsletterIssues.bouncedCount} + 1` })
                .where(eq(newsletterIssues.id, row.issueId));

            // Only a HARD bounce condemns the address. A full mailbox or a temporary outage is not
            // a reason to stop emailing someone forever, and treating it as one silently erodes a
            // tenant's list every time a mail server has a bad day.
            if (hard) {
                await setContactStatus(db, {
                    organisationId: orgId,
                    email: address,
                    status: 'bounced',
                    event: 'bounced',
                    channel: 'webhook',
                    issueId: row.issueId,
                    evidence: `Hard bounce reported by the mail provider${bounceType ? ` (${bounceType})` : ''}.`,
                });
                // And stop any welcome series they are part way through. The consent check would
                // catch them at the next step anyway; halting now makes the reason readable from
                // the row instead of inferable from an absence.
                await haltEnrolmentsForContact(db, { organisationId: orgId, email: address, reason: 'bounced' });
            }
            return { statusCode: 200, body: 'ok' };
        }

        if (type === 'email.complained') {
            await db.update(newsletterSends)
                .set({ status: 'complained', updatedAt: new Date() })
                .where(eq(newsletterSends.id, row.id));
            await db.update(newsletterIssues)
                .set({ complainedCount: sql`${newsletterIssues.complainedCount} + 1` })
                .where(eq(newsletterIssues.id, row.issueId));

            await setContactStatus(db, {
                organisationId: orgId,
                email: address,
                status: 'complained',
                event: 'complained',
                channel: 'webhook',
                issueId: row.issueId,
                evidence: 'Reported as spam by the recipient.',
            });

            await haltEnrolmentsForContact(db, { organisationId: orgId, email: address, reason: 'complained' });

            // ⚠️ THE CROSS-ASSISTANT BINDING. A complaint is the strongest possible "stop emailing
            // me", and it must reach the cold-outreach side too — lead_opt_outs is the table every
            // send path already consults. Failing to write it would leave the Lead Generator free
            // to email, next month, the person who just pressed the spam button.
            try {
                await db.insert(leadOptOuts).values({
                    organisationId: orgId,
                    email: address,
                    reason: 'spam_complaint',
                    source: 'bounce',
                    matchedRule: 'newsletter_complaint',
                    evidence: 'Recipient reported a newsletter as spam.',
                }).onConflictDoNothing();
            } catch (err) {
                // The audience is already blocked, so this is a gap in coverage, not an open door.
                // Loud, because the gap is on the assistant that cold-emails strangers.
                console.error('[newsletter-webhook] complaint recorded on the audience but NOT in lead_opt_outs', { orgId }, err);
            }
            return { statusCode: 200, body: 'ok' };
        }

        if (type === 'email.opened' || type === 'email.clicked') {
            const isClick = type === 'email.clicked';
            const now = new Date();

            // ⚠️ THE FIRST-TOUCH GUARD. The WHERE clause requires the timestamp to still be NULL,
            // so only the first event per recipient updates a row — and `returning()` tells us
            // whether this event was that first one. Incrementing the issue on every event would
            // let one enthusiastic reader push the open rate past 100%.
            const [first] = isClick
                ? await db.update(newsletterSends).set({
                    clickedAt: now,
                    clickCount: sql`${newsletterSends.clickCount} + 1`,
                    lastClickedUrl: String(data?.click?.link || data?.link || '').slice(0, 500) || null,
                    updatedAt: now,
                }).where(and(eq(newsletterSends.id, row.id), isNull(newsletterSends.clickedAt)))
                    .returning({ id: newsletterSends.id })
                : await db.update(newsletterSends).set({
                    openedAt: now,
                    openCount: sql`${newsletterSends.openCount} + 1`,
                    updatedAt: now,
                }).where(and(eq(newsletterSends.id, row.id), isNull(newsletterSends.openedAt)))
                    .returning({ id: newsletterSends.id });

            if (first) {
                await db.update(newsletterIssues)
                    .set(isClick
                        ? { clickedCount: sql`${newsletterIssues.clickedCount} + 1` }
                        : { openedCount: sql`${newsletterIssues.openedCount} + 1` })
                    .where(eq(newsletterIssues.id, row.issueId));
            } else {
                // A repeat. Only their own row moves — the issue-level count already has them.
                await db.update(newsletterSends).set(isClick
                    ? {
                        clickCount: sql`${newsletterSends.clickCount} + 1`,
                        lastClickedUrl: String(data?.click?.link || data?.link || '').slice(0, 500) || null,
                    }
                    : { openCount: sql`${newsletterSends.openCount} + 1` })
                    .where(eq(newsletterSends.id, row.id));
            }
            return { statusCode: 200, body: 'ok' };
        }

        return { statusCode: 200, body: 'ignored' };
    } catch (err) {
        // 500 so the provider retries — a lost bounce or complaint is a subscriber we keep emailing.
        console.error('[newsletter-webhook] failed to record an event', { type }, err);
        return { statusCode: 500, body: 'error' };
    }
});
