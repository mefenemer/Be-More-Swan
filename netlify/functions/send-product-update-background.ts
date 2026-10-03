// netlify/functions/send-product-update-background.ts
// Delivers an APPROVED weekly "What's new" email to every recipient. Triggered by
// product-updates.ts (approve / resume); a -background function, so it has 15 minutes.
//
// ⚠️ AT MOST ONCE PER PERSON. Each recipient gets a product_update_sends row BEFORE the send, under
// a unique (digest, user) index, and only the invocation whose insert succeeds sends. A double
// trigger, a retried worker or a "Resume" press can therefore never email anyone twice. The cost is
// the other direction: a worker that dies between the insert and the send leaves that one person
// at 'sending' and they do not get it. For a feature-news email that is the right side to fail on.
//
// Unauthenticated by design, like every -background worker here: the only thing it can do is
// finish delivering an email an admin has already approved (status 'sending'). Anything else exits.

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { productUpdateDigests, productUpdateSends } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { renderProductUpdateEmail, whatsNewUnsubscribeUrl } from '../../src/utils/product-update-email';
import { recipientPage } from '../../src/utils/product-update-recipients';
import { withLambda } from '@netlify/aws-lambda-compat';

const PAGE = 200;
/** Resend's default limit is a few requests a second; this keeps comfortably under it. */
const GAP_MS = 550;
/** Stop starting new sends after 13 of the 15 minutes; the worker then re-triggers itself. */
const STOP_AFTER_MS = 13 * 60 * 1000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default withLambda(async (event) => {
    const startedAt = Date.now();
    let digestId: number;
    try { digestId = Number(JSON.parse(event.body || '{}').digestId); } catch { return { statusCode: 400, body: 'bad body' }; }
    if (!Number.isInteger(digestId) || digestId <= 0) return { statusCode: 400, body: 'digestId required' };

    const db = getDb();
    const [digest] = await db.select().from(productUpdateDigests).where(eq(productUpdateDigests.id, digestId)).limit(1);
    if (!digest || digest.status !== 'sending') {
        console.log('[send-product-update] digest', digestId, 'is not sending — nothing to do');
        return { statusCode: 200, body: 'not sending' };
    }
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
    if (!baseUrl) { console.error('[send-product-update] no BASE_URL — cannot build links'); return { statusCode: 500, body: 'no base url' }; }

    let afterId = 0;
    let timedOut = false;
    outer: while (true) {
        const page = await recipientPage(db, afterId, PAGE);
        if (page.length === 0) break;
        for (const r of page) {
            afterId = r.id;
            if (Date.now() - startedAt > STOP_AFTER_MS) { timedOut = true; break outer; }

            const [claim] = await db.insert(productUpdateSends).values({ digestId, userId: r.id })
                .onConflictDoNothing().returning({ id: productUpdateSends.id });
            if (!claim) continue; // already sent (or attempted) by an earlier run

            const unsubscribeUrl = whatsNewUnsubscribeUrl(baseUrl, r.id);
            const email = renderProductUpdateEmail(digest, { baseUrl, firstName: r.firstName, unsubscribeUrl });
            try {
                await sendEmail({
                    to: r.email, subject: email.subject, html: email.html, text: email.text,
                    replyTo: 'hello@bemoreswan.com',
                    headers: {
                        'List-Unsubscribe': `<${unsubscribeUrl}>`,
                        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                    },
                });
                await db.update(productUpdateSends).set({ status: 'sent', sentAt: new Date() }).where(eq(productUpdateSends.id, claim.id));
            } catch (err: any) {
                console.error('[send-product-update] send failed for user', r.id, err?.message || err);
                await db.update(productUpdateSends).set({ status: 'failed', error: String(err?.message || err).slice(0, 500) })
                    .where(eq(productUpdateSends.id, claim.id));
            }
            await sleep(GAP_MS);
        }
    }

    const [counts] = await db.select({
        sent: sql<number>`count(*) filter (where ${productUpdateSends.status} = 'sent')::int`,
        failed: sql<number>`count(*) filter (where ${productUpdateSends.status} = 'failed')::int`,
    }).from(productUpdateSends).where(eq(productUpdateSends.digestId, digestId));

    await db.update(productUpdateDigests).set({
        sentCount: counts.sent, failedCount: counts.failed, updatedAt: new Date(),
        ...(timedOut ? {} : { status: 'sent', sentAt: new Date() }),
    }).where(and(eq(productUpdateDigests.id, digestId), eq(productUpdateDigests.status, 'sending')));

    console.log(`[send-product-update] digest ${digestId}: sent ${counts.sent}, failed ${counts.failed}${timedOut ? ' — out of time, continuing in a fresh worker' : ''}`);

    // Out of time with people still to send to: hand over to a fresh worker. The claim rows mean
    // it skips everyone already done. If this hand-over fails, the admin page's Resume does the same.
    if (timedOut) {
        try {
            await fetch(`${baseUrl}/.netlify/functions/send-product-update-background`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ digestId }), signal: AbortSignal.timeout(5_000),
            });
        } catch (err) {
            console.error('[send-product-update] could not hand over to a fresh worker — use Resume on the admin page', err);
        }
    }
    return { statusCode: 200, body: 'ok' };
});
