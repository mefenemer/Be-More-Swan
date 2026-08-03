// inbound-email.ts
// Public webhook for SendGrid Inbound Parse. Turns a received email into a CRM lead so
// emailed enquiries land in the Admin → Sales Pipeline queue alongside contact-form ones.
//
// Setup (see docs): SendGrid → Settings → Inbound Parse → Add Host & URL
//   Host: parse.bemoreswan.com (a subdomain MX'd to mx.sendgrid.net — NOT the apex, which
//         stays on Google Workspace). Destination URL: this function + ?key=<INBOUND_PARSE_TOKEN>.
//   "Check for spam" = Yes (gives spam_score); "POST raw MIME" = No (parsed fields).
//
// SendGrid posts multipart/form-data with fields: from, to, subject, text, html, envelope,
// spam_score, attachments, ... We validate the URL token, drop obvious spam, then thread the
// message onto an existing enquiry from the same sender or open a new inbound_email lead.

import { HandlerEvent } from '@netlify/functions';
import Busboy from 'busboy';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { leads, leadReplies, leadOptOuts, leadThreads } from '../../db/schema';
import { detectOptOut } from '../../src/config/opt-out';
import { lookupContact, promoteContactType } from '../../src/utils/contact-type';
import { parseReplyToken, recipientFromParsePayload } from '../../src/utils/reply-address';
import { findThreadByReplyToken, recordInboundMessage } from '../../src/utils/lead-threads';
import { haltEnrolmentsForThread } from '../../src/utils/outreach-sequences';
import { recordEvent } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { withLambda } from '@netlify/aws-lambda-compat';

const INBOUND_TOKEN = process.env.INBOUND_PARSE_TOKEN;
const SPAM_THRESHOLD = 5; // SendGrid spam_score; >5 is treated as junk and dropped
const MAX_BODY_CHARS = 20000;

function parseForm(event: HandlerEvent): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
        const fields: Record<string, string> = {};
        const busboy = Busboy({
            headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] || '' },
        });
        // Attachments are ignored — drain the stream so busboy can finish.
        busboy.on('file', (_name, file) => file.resume());
        busboy.on('field', (name, val) => { fields[name] = val; });
        busboy.on('finish', () => resolve(fields));
        busboy.on('error', reject);
        busboy.end(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : (event.body || ''));
    });
}

// "Jane Doe <jane@x.com>" → { email, name }. Falls back to the raw string as the email.
function parseFrom(from: string): { email: string; name: string | null } {
    const m = (from || '').match(/<([^>]+)>/);
    const email = (m ? m[1] : from || '').trim().toLowerCase();
    let name: string | null = null;
    if (m) {
        name = (from.slice(0, from.indexOf('<')).trim().replace(/^"|"$/g, '')) || null;
    }
    return { email, name };
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Shared-secret gate — Inbound Parse URLs are otherwise public. Fail closed if unset.
    if (!INBOUND_TOKEN) return { statusCode: 503, body: 'Inbound webhook not configured.' };
    if ((event.queryStringParameters?.key || '') !== INBOUND_TOKEN) {
        return { statusCode: 403, body: 'Forbidden' };
    }

    let fields: Record<string, string>;
    try {
        fields = await parseForm(event);
    } catch (err) {
        console.error('[inbound-email] parse failed:', err);
        return { statusCode: 400, body: 'Could not parse payload.' };
    }

    console.log('[inbound-email] received', JSON.stringify({
        ct: (event.headers['content-type'] || event.headers['Content-Type'] || '').slice(0, 50),
        b64: event.isBase64Encoded,
        keys: Object.keys(fields),
        from: fields.from,
        envelope: fields.envelope,
        spam_score: fields.spam_score,
        subject: fields.subject,
    }));

    // Resolve the sender: the SMTP envelope is the most trustworthy, then the From header.
    let senderEmail = '';
    try {
        const env = fields.envelope ? JSON.parse(fields.envelope) : null;
        if (env?.from) senderEmail = String(env.from).trim().toLowerCase();
    } catch { /* envelope is best-effort */ }
    const fromHeader = parseFrom(fields.from || '');
    if (!senderEmail) senderEmail = fromHeader.email;
    if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
        // Nothing we can attribute — ack so SendGrid doesn't retry.
        console.log('[inbound-email] skipped: no usable sender', JSON.stringify({ from: fields.from, envelope: fields.envelope }));
        return { statusCode: 200, body: 'No usable sender; skipped.' };
    }

    // Spam handling — we do NOT drop on a high score. Support mail reaches this webhook via a
    // Google → SendGrid forward, which breaks SPF/DKIM alignment and pushes spam_score up for
    // perfectly legitimate customer enquiries. Silently dropping them would lose real support
    // requests with no trace. Instead we still record the message but flag it 'possible-spam'
    // (a visible, removable Contacts tag) and drop its priority, so a human triages rather than
    // the pipeline discarding it blind.
    const spamScore = parseFloat(fields.spam_score || '');
    const flaggedSpam = !Number.isNaN(spamScore) && spamScore > SPAM_THRESHOLD;
    if (flaggedSpam) {
        console.log('[inbound-email] flagged possible spam (recorded, not dropped)', JSON.stringify({ sender: senderEmail, spamScore }));
    }

    const subject = (fields.subject || '').trim() || 'Inbound email';
    let messageBody = (fields.text || '').trim();
    if (!messageBody && fields.html) {
        messageBody = fields.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // crude HTML→text fallback
    }
    if (!messageBody) messageBody = '(no message body)';

    // ── Lead-reply branch (Phase 2a) ─────────────────────────────────────────
    // A message addressed to reply+<token>@<parse domain> is a PROSPECT replying to tenant
    // outreach, not an enquiry to Be More Swan. Route it to that conversation and return.
    //
    // This branch sits AFTER sender/body resolution so it reuses the same parsing, and it is
    // deliberately narrow: anything without a valid token falls through to the support pipeline
    // below completely untouched. Ordinary support mail must keep working exactly as before —
    // that path is live on prod and predates this feature.
    //
    // Never throws: a failure here logs and falls through rather than 500ing at SendGrid, which
    // would trigger retries and eventually bounce a real prospect's reply.
    try {
        const replyToken = parseReplyToken(recipientFromParsePayload(fields));
        if (replyToken) {
            const db = getDb();
            const thread = await findThreadByReplyToken(db, replyToken);
            if (!thread) {
                // A token we minted but can no longer resolve (thread deleted, or an environment
                // mismatch — staging and prod share the Parse host). Ack so SendGrid stops retrying.
                console.log('[inbound-email] lead reply for unknown thread token; skipped');
                return { statusCode: 200, body: 'Unknown thread; skipped.' };
            }

            const messageId = await recordInboundMessage(db, thread.id, {
                organisationId: thread.organisationId,
                fromEmail: senderEmail,
                subject,
                body: messageBody.slice(0, MAX_BODY_CHARS),
            });

            // Attribution (§7.2) for both ledger events below — one webhook is one thread is one
            // assistant. Note what this version means on an INBOUND event: the strategy that was
            // live when they replied, not necessarily the one that wrote the message they answered.
            // Cycle-time attribution keys off the outreach_sent row, which carries its own.
            const blueprintVersion = await getBlueprintVersion(db, thread.aiAssistantId);

            // Halt any running cadence on this thread (Phase 2b). recordInboundMessage has already
            // flipped the thread to 'replied', and the sequence worker refuses to send to a thread
            // that is not 'open' — this closes the enrolment at the SAME moment rather than leaving
            // an active row pointing at a replied thread until the next tick notices. Belt and
            // braces on purpose: a follow-up landing after someone has answered is the single most
            // damaging thing this system can do.
            const haltedCount = await haltEnrolmentsForThread(db, thread.id);

            // ── Opt-out ──────────────────────────────────────────────────────
            // "Unsubscribe" in a reply used to do nothing: the cadence stopped only because a reply
            // had arrived at all, and nothing was recorded — so re-scoring or re-adding the same
            // person resumed outreach. Recorded at ADDRESS grain in lead_opt_outs (NOT the
            // domain-grained suppression_list, which would suppress their whole employer), and
            // checkSuppression() reads it before every send from both paths.
            //
            // Best-effort like everything else in this branch: a failure here must not 500 at
            // SendGrid, because the retry would eventually bounce a real prospect's reply. The
            // cadence is already halted by this point, so the worst case is a missed suppression
            // that the next send's own check cannot catch — logged loudly for that reason.
            const optOut = detectOptOut(messageBody, subject);
            if (optOut.optedOut) {
                try {
                    await db.insert(leadOptOuts).values({
                        organisationId: thread.organisationId,
                        email: senderEmail,
                        reason: 'reply_opt_out',
                        source: 'reply',
                        leadThreadId: thread.id,
                        matchedRule: optOut.matched,
                        evidence: optOut.evidence,
                    }).onConflictDoNothing();

                    // Close the conversation outright. 'replied' (set by recordInboundMessage) means
                    // "they answered, go look"; this person does not want a human follow-up either.
                    // 'closed' is already in the lead_threads state vocabulary — no DDL needed.
                    await db.update(leadThreads)
                        .set({ state: 'closed' })
                        .where(eq(leadThreads.id, thread.id));

                    await recordEvent(db, 'opt_out_received', {
                        organisationId: thread.organisationId,
                        aiAssistantId: thread.aiAssistantId,
                        discoveredLeadId: thread.discoveredLeadId,
                        assistantRecordId: thread.assistantRecordId,
                        actor: 'system',
                        blueprintVersion,
                        payload: { threadId: thread.id, messageId, matched: optOut.matched, sequencesHalted: haltedCount },
                    });
                    console.log('[inbound-email] opt-out recorded', JSON.stringify({
                        threadId: thread.id, matched: optOut.matched, sender: senderEmail,
                    }));
                } catch (err) {
                    console.error('[inbound-email] OPT-OUT NOT RECORDED — this address may be emailed again:', {
                        threadId: thread.id, sender: senderEmail, matched: optOut.matched,
                    }, err);
                }
            }

            // The ledger event is what makes reply RATE measurable — the first funnel metric this
            // system has ever been able to compute for outreach.
            await recordEvent(db, 'reply_received', {
                organisationId: thread.organisationId,
                aiAssistantId: thread.aiAssistantId,
                discoveredLeadId: thread.discoveredLeadId,
                assistantRecordId: thread.assistantRecordId,
                actor: 'system',
                blueprintVersion,
                payload: { threadId: thread.id, messageId, flaggedSpam, sequencesHalted: haltedCount },
            });

            console.log('[inbound-email] recorded lead reply', JSON.stringify({ threadId: thread.id, messageId, haltedCount }));
            return { statusCode: 200, body: 'Lead reply recorded.' };
        }
    } catch (err) {
        console.error('[inbound-email] lead-reply branch failed (falling through to support):', err);
    }
    if (messageBody.length > MAX_BODY_CHARS) messageBody = messageBody.slice(0, MAX_BODY_CHARS) + '…';

    try {
        const db = getDb();
        // A registered user is an existing customer → 'client'; anyone else → 'lead'.
        const { userId: leadUserId, contactType } = await lookupContact(db, senderEmail);

        // Thread onto the most recent enquiry from this sender, if one exists.
        const [existing] = await db.select({ id: leads.id, status: leads.status, contactType: leads.contactType, tags: leads.tags })
            .from(leads)
            .where(and(
                eq(leads.email, senderEmail),
                inArray(leads.leadType, ['contact_form', 'inbound_email']),
            ))
            .orderBy(desc(leads.createdAt))
            .limit(1);

        if (existing) {
            await db.insert(leadReplies).values({
                leadId: existing.id,
                direction: 'inbound',
                authorId: null,
                body: `${subject}\n\n${messageBody}`,
            });
            // A fresh inbound message always flags the lead for attention and bumps updatedAt,
            // so it resurfaces to the top of the (activity-sorted) Sales Pipeline as "New".
            // Upgrade the record's tier if we now know more (lead → registered → client);
            // never downgrade or override a manual 'other'.
            const nextType = promoteContactType(existing.contactType, contactType);
            const promote = nextType !== existing.contactType;
            // Tag the thread 'possible-spam' if this message tripped the score and the tag
            // isn't already there; never remove a tag a human may have cleared and re-added.
            const currentTags = existing.tags ?? [];
            const addSpamTag = flaggedSpam && !currentTags.includes('possible-spam');
            await db.update(leads)
                .set({
                    status: 'notification_pending',
                    updatedAt: new Date(),
                    ...(promote ? { contactType: nextType } : {}),
                    ...(addSpamTag ? { tags: [...currentTags, 'possible-spam'] } : {}),
                })
                .where(eq(leads.id, existing.id));
            console.log('[inbound-email] threaded onto existing lead', JSON.stringify({ leadId: existing.id, sender: senderEmail }));
            return { statusCode: 200, body: 'Threaded onto existing lead.' };
        }

        // Otherwise open a new inbound_email lead. useCase holds the first message (shown as the
        // original request in the slide-over); onConflict guards the (email, opportunity) unique key.
        await db.insert(leads).values({
            email: senderEmail,
            name: fromHeader.name,
            opportunityReason: subject,
            action: 'respond to inbound enquiry',
            status: 'notification_pending',
            leadType: 'inbound_email',
            source: 'inbound_email',
            useCase: messageBody,
            priority: flaggedSpam ? 'low' : 'medium',
            tags: flaggedSpam ? ['possible-spam'] : [],
            contactType,
            userId: leadUserId,
        }).onConflictDoNothing(); // find-by-email above already handles repeats; never overwrite

        console.log('[inbound-email] created new lead', JSON.stringify({ sender: senderEmail, subject }));
        return { statusCode: 200, body: 'Lead created.' };
    } catch (err) {
        console.error('[inbound-email] db error:', err);
        // 500 lets SendGrid retry a transient DB blip.
        return { statusCode: 500, body: 'Storage failed.' };
    }
});
