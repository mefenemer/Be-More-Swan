// netlify/functions/lead-unsubscribe.ts
// The front door for a PROSPECT opting out of a tenant's cold outreach.
//
//   GET  ?t=<replyToken>  → tenant-branded confirmation page, records the opt-out
//   POST ?t=<replyToken>  → RFC 8058 one-click (Gmail/Yahoo fire this with no user interaction)
//
// ⚠️ NOT win-back-unsubscribe.ts. That one is Be More Swan's OWN marketing to its OWN users
// (win_back_opt_outs, keyed on a userId). This is the tenant's prospect asking the TENANT to stop —
// different table, different grain, and the page must show the tenant's name, not ours: the
// prospect never signed up to Be More Swan and has no idea who we are.
//
// ── Why the thread's replyToken is the credential ───────────────────────────────────────────────
// It is already minted before the first send, already unguessable (18 random bytes — see
// mintReplyToken), and already resolves to exactly (organisation, thread, contactEmail). Inventing
// a second signed token would mean a new secret to manage and a second thing that can drift out of
// sync with the thread. The token is semi-public — it rides in the Reply-To address — but the only
// authority it grants here is "stop emailing the address this thread is already writing to", which
// is strictly weaker than the authority a reply to that same address already carries.
//
// ── Never 500 ───────────────────────────────────────────────────────────────────────────────────
// A person clicking unsubscribe must not see a stack trace, and a mail client's one-click POST must
// not be retried into a loop. Every failure path returns a page (or a 200 for POST) saying what to
// do next, and the error is logged loudly — an unrecorded opt-out means we keep emailing someone
// who asked us not to, which is the worst outcome this file can produce.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { leadOptOuts, leadThreads, organisations } from '../../db/schema';
import { haltEnrolmentsForThread } from '../../src/utils/outreach-sequences';
import { recordEvent } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { getIcpSnapshot } from '../../src/utils/icp-snapshot';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Mirrors reply-address.ts TOKEN_RE — a loose pattern would send junk to the thread lookup. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const esc = (s: string): string => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(statusCode: number, heading: string, body: string, icon = '✅') {
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
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#6b7280;font-size:.925rem;line-height:1.6;margin:.5rem 0}</style></head>
<body><div class="card">
  <div style="font-size:2rem;margin-bottom:1rem">${icon}</div>
  <h1>${esc(heading)}</h1>
  ${body}
</div></body></html>`,
    };
}

export default withLambda(async (event) => {
    const method = event.httpMethod;
    // HEAD is what some scanners and link-checkers send. Answer it without recording anything —
    // a security appliance pre-fetching the link must not opt the prospect out on their behalf.
    if (method === 'HEAD') return { statusCode: 200, body: '' };
    if (method !== 'GET' && method !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const oneClick = method === 'POST';

    const token = (event.queryStringParameters?.t || '').trim();
    if (!TOKEN_RE.test(token)) {
        return oneClick
            ? { statusCode: 200, body: 'ok' }
            : page(400, 'This link isn\'t valid', '<p>The unsubscribe link looks incomplete. Please reply to the email you received with the word <strong>UNSUBSCRIBE</strong> and you\'ll be removed straight away.</p>', '⚠️');
    }

    try {
        const db = getDb();

        const [thread] = await db
            .select({
                id: leadThreads.id,
                organisationId: leadThreads.organisationId,
                aiAssistantId: leadThreads.aiAssistantId,
                discoveredLeadId: leadThreads.discoveredLeadId,
                assistantRecordId: leadThreads.assistantRecordId,
                contactEmail: leadThreads.contactEmail,
                senderName: organisations.name,
            })
            .from(leadThreads)
            .leftJoin(organisations, eq(organisations.id, leadThreads.organisationId))
            .where(eq(leadThreads.replyToken, token))
            .limit(1);

        if (!thread || !thread.contactEmail) {
            // An expired or unknown token. Do NOT say "not found" — from the prospect's side that
            // reads as "your request failed", and they will either give up or complain. Point them
            // at the reply route, which works regardless of what happened to the thread.
            return oneClick
                ? { statusCode: 200, body: 'ok' }
                : page(404, 'We couldn\'t find that subscription', '<p>This link may have expired. Please reply to the email you received with the word <strong>UNSUBSCRIBE</strong> and you\'ll be removed straight away.</p>', '⚠️');
        }

        const senderName = (thread.senderName || 'the sender').trim();
        const email = thread.contactEmail.trim().toLowerCase();

        // Address grain, NOT the domain-grained suppression_list — one person at a 500-seat company
        // saying "stop" must not silently destroy their whole employer as a prospect.
        // Idempotent: clicking twice, or a client firing one-click after the human already clicked,
        // produces one row.
        await db.insert(leadOptOuts).values({
            organisationId: thread.organisationId,
            email,
            reason: 'link_opt_out',
            source: 'link',
            leadThreadId: thread.id,
            matchedRule: oneClick ? 'one_click_header' : 'unsubscribe_link',
            evidence: oneClick
                ? 'RFC 8058 one-click unsubscribe (List-Unsubscribe-Post)'
                : 'Clicked the unsubscribe link in the outreach email',
        }).onConflictDoNothing();

        // Stop anything already in flight. The cadence worker refuses to send to a non-'open'
        // thread, and checkSuppression blocks the address outright at both send paths — this closes
        // the enrolment at the SAME moment rather than leaving an active row until the next tick.
        // Belt and braces on purpose: a follow-up landing after someone pressed unsubscribe is the
        // single most damaging thing this system can do.
        let haltedCount = 0;
        try {
            haltedCount = await haltEnrolmentsForThread(db, thread.id);
            await db.update(leadThreads).set({ state: 'closed' }).where(and(
                eq(leadThreads.id, thread.id),
                eq(leadThreads.organisationId, thread.organisationId),
            ));
        } catch (err) {
            // The opt-out row is already written, so suppression holds even if this half failed.
            console.error('[lead-unsubscribe] opt-out RECORDED but cadence not halted', { threadId: thread.id }, err);
        }

        try {
            // §7.2 attribution, same as the reply-driven opt-out in inbound-email.ts. Both fields
            // are mandatory on every emit site (tests/icp-snapshot.test.ts enforces it): a row
            // without them is permanently unattributable, so an opt-out rate can never be
            // segmented by the targeting or the strategy that produced it — which is the one thing
            // an opt-out rate is worth measuring for.
            const blueprintVersion = await getBlueprintVersion(db, thread.aiAssistantId);
            const icpSnapshot = await getIcpSnapshot(db, {
                discoveredLeadId: thread.discoveredLeadId,
                aiAssistantId: thread.aiAssistantId,
            });
            await recordEvent(db, 'opt_out_received', {
                organisationId: thread.organisationId,
                aiAssistantId: thread.aiAssistantId,
                discoveredLeadId: thread.discoveredLeadId,
                assistantRecordId: thread.assistantRecordId,
                actor: 'system',
                blueprintVersion,
                icpSnapshot,
                payload: { threadId: thread.id, via: oneClick ? 'one_click' : 'link', sequencesHalted: haltedCount },
            });
        } catch { /* ledger is best-effort — never fail the prospect's request on analytics */ }

        console.log('[lead-unsubscribe] opt-out recorded', JSON.stringify({
            threadId: thread.id, via: oneClick ? 'one_click' : 'link', haltedCount,
        }));

        // RFC 8058: the client wants a 200 and nothing else. No body worth rendering.
        if (oneClick) return { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: 'ok' };

        return page(200, 'You\'ve been unsubscribed',
            `<p><strong>${esc(email)}</strong> has been removed from ${esc(senderName)}'s mailing list. You won't receive any further emails from them.</p>
             <p style="font-size:.8rem;color:#9ca3af;margin-top:1.5rem">This request was handled on behalf of ${esc(senderName)}, who sent you the email.</p>`);
    } catch (err) {
        console.error('[lead-unsubscribe] FAILED — this address may be emailed again:', { token }, err);
        return oneClick
            ? { statusCode: 200, body: 'ok' }
            : page(500, 'Something went wrong', '<p>We couldn\'t process that just now. Please reply to the email you received with the word <strong>UNSUBSCRIBE</strong> and you\'ll be removed straight away.</p>', '⚠️');
    }
});
