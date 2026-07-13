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
import { leads, leadReplies } from '../../db/schema';
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

    // Spam gate — ack (200) so SendGrid treats it as delivered, but never surface it.
    const spamScore = parseFloat(fields.spam_score || '');
    if (!Number.isNaN(spamScore) && spamScore > SPAM_THRESHOLD) {
        console.log('[inbound-email] dropped as spam', JSON.stringify({ sender: senderEmail, spamScore }));
        return { statusCode: 200, body: 'Dropped as spam.' };
    }

    const subject = (fields.subject || '').trim() || 'Inbound email';
    let messageBody = (fields.text || '').trim();
    if (!messageBody && fields.html) {
        messageBody = fields.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // crude HTML→text fallback
    }
    if (!messageBody) messageBody = '(no message body)';
    if (messageBody.length > MAX_BODY_CHARS) messageBody = messageBody.slice(0, MAX_BODY_CHARS) + '…';

    try {
        const db = getDb();

        // Thread onto the most recent enquiry from this sender, if one exists.
        const [existing] = await db.select({ id: leads.id, status: leads.status })
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
            // A fresh message on a parked lead reopens it for attention.
            const reopen = existing.status === 'converted' || existing.status === 'closed_lost';
            await db.update(leads)
                .set({ updatedAt: new Date(), ...(reopen ? { status: 'notification_pending' } : {}) })
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
            priority: 'medium',
        }).onConflictDoUpdate({
            target: [leads.email, leads.opportunityReason],
            set: { useCase: messageBody, updatedAt: new Date() },
        });

        console.log('[inbound-email] created new lead', JSON.stringify({ sender: senderEmail, subject }));
        return { statusCode: 200, body: 'Lead created.' };
    } catch (err) {
        console.error('[inbound-email] db error:', err);
        // 500 lets SendGrid retry a transient DB blip.
        return { statusCode: 500, body: 'Storage failed.' };
    }
});
