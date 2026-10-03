// netlify/functions/support-tickets.ts
import { HandlerEvent } from '@netlify/functions';
import { and, asc, eq, desc } from 'drizzle-orm';
import { Resend } from 'resend';
import { getDb } from '../../db/client';
import { users, supportTickets, ticketReplies } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { logAuditEvent } from '../../src/utils/audit';
import { checkRateLimit } from '../../src/utils/rate-limit';
import { checkEarlySupportTicket } from '../../src/utils/churn';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';
import { sendEmail } from '../../src/utils/email';
import { adminInbox } from '../../src/utils/admin-inbox';

const escHtml = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tell the business inbox — new tickets and customer replies used to reach nobody but the admin portal. */
async function alertInbox(subject: string, html: string) {
    for (const to of adminInbox()) {
        await sendEmail({ to, subject, html }).catch((e: unknown) => console.warn('[support-tickets] inbox alert failed:', e));
    }
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@bemoreswan.com';

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    // Authenticate + resolve the active organisation (verifies membership; never trusts the claim alone).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    try {

        // -------------------------------------------------------------
        // GET: Fetch Ticket History
        // -------------------------------------------------------------
        if (event.httpMethod === 'GET' && event.queryStringParameters?.ticketId) {
            // ── One ticket + its conversation, for its owner ─────────────────────────────────
            // The customer could see a list of tickets but never a reply: replies lived only in
            // ticket_replies, read by the admin helpdesk and emailed out. Internal notes stay
            // internal — isInternal rows are never returned here.
            const ticketId = Number(event.queryStringParameters.ticketId);
            if (!Number.isInteger(ticketId)) return { statusCode: 400, body: JSON.stringify({ error: 'ticketId is required.' }) };
            const [ticket] = await db.select().from(supportTickets)
                .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.userId, userId))).limit(1);
            if (!ticket) return { statusCode: 404, body: JSON.stringify({ error: 'Ticket not found.' }) };
            const rows = await db.select({
                id: ticketReplies.id, body: ticketReplies.body, createdAt: ticketReplies.createdAt, authorId: ticketReplies.authorId,
            }).from(ticketReplies)
                .where(and(eq(ticketReplies.ticketId, ticketId), eq(ticketReplies.isInternal, false)))
                .orderBy(asc(ticketReplies.createdAt));
            const replies = rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.createdAt, fromTeam: r.authorId !== userId }));
            return { statusCode: 200, body: JSON.stringify({ ticket, replies }) };
        }

        if (event.httpMethod === 'GET') {
            const userTickets = await db.select()
                .from(supportTickets)
                .where(eq(supportTickets.userId, userId))
                .orderBy(desc(supportTickets.createdAt));

            return { statusCode: 200, body: JSON.stringify(userTickets) };
        }

        // -------------------------------------------------------------
        // POST: Create New Ticket
        // -------------------------------------------------------------
        if (event.httpMethod === 'POST' && (() => { try { return JSON.parse(event.body || '{}').ticketId != null; } catch { return false; } })()) {
            // ── The customer replies on their own ticket ──────────────────────────────────────
            const { ticketId: rawId, message } = JSON.parse(event.body || '{}');
            const ticketId = Number(rawId);
            const body = typeof message === 'string' ? message.trim() : '';
            if (!Number.isInteger(ticketId) || !body) return { statusCode: 400, body: JSON.stringify({ error: 'A reply is required.' }) };
            if (body.length > 10000) return { statusCode: 400, body: JSON.stringify({ error: 'That reply is too long.' }) };
            const [ticket] = await db.select().from(supportTickets)
                .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.userId, userId))).limit(1);
            if (!ticket) return { statusCode: 404, body: JSON.stringify({ error: 'Ticket not found.' }) };
            if (ticket.status === 'closed') return { statusCode: 409, body: JSON.stringify({ error: 'This ticket is closed — open a new one.' }) };
            const [reply] = await db.insert(ticketReplies).values({ ticketId, authorId: userId, body, isInternal: false }).returning();
            // The ball is back with the team: a ticket waiting on the customer, or resolved and
            // then answered, is open again.
            await db.update(supportTickets).set({ status: 'open', updatedAt: new Date() }).where(eq(supportTickets.id, ticketId));
            const [user] = await db.select({ email: users.email, firstName: users.firstName }).from(users).where(eq(users.id, userId));
            await alertInbox(`[Ticket #${ticketId}] Customer replied: ${ticket.subject}`,
                `<p><strong>${escHtml(user?.firstName || user?.email || 'A customer')}</strong> replied on ticket #${ticketId} — <em>${escHtml(ticket.subject)}</em>:</p>
                 <blockquote style="border-left:3px solid #eae4d7;padding-left:12px;color:#444036;white-space:pre-wrap">${escHtml(body)}</blockquote>
                 <p><a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/admin.html?view=tickets">Open Support Tickets in the admin portal →</a></p>`);
            return { statusCode: 201, body: JSON.stringify({ success: true, reply: { id: reply.id, body: reply.body, createdAt: reply.createdAt, fromTeam: false } }) };
        }

        if (event.httpMethod === 'POST') {
            // SC4 — US-GAP-7.1.1: 10 ticket submissions per userId per 24 hours
            const rlSupport = await checkRateLimit(db, 'support', `user:${userId}`, { maxAttempts: 10, windowSecs: 24 * 60 * 60 });
            if (!rlSupport.allowed) {
                return {
                    statusCode: 429,
                    headers: { 'Retry-After': String(rlSupport.retryAfterSecs) },
                    body: JSON.stringify({
                        error: 'Daily ticket limit reached. Please contact hello@bemoreswan.com directly.',
                    }),
                };
            }

            const [user] = await db.select().from(users).where(eq(users.id, userId));
            if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

            const body = JSON.parse(event.body || '{}');
            const { subject, category, description } = body;

            if (!subject || !category || !description) {
                return { statusCode: 400, body: JSON.stringify({ error: 'All fields are required.' }) };
            }

            const [newTicket] = await db.insert(supportTickets).values({
                userId: userId,
                organisationId: orgId,
                subject: subject.trim(),
                category: category,
                description: description.trim(),
                status: 'open'
            }).returning();

            // FIXED: Removed 'referenceId' to match your strict Drizzle schema
            await createNotification(db, 'ticket_created', {
                userId: userId,
                context: { ticket: { id: newTicket.id, subject: newTicket.subject } },
                metadata: { ticketId: newTicket.id },
            });

            // Audit Log
            logAuditEvent({
                userId: userId,
                actionType: 'CREATE',
                resourceType: 'support_tickets',
                resourceId: newTicket.id,
                newState: { subject: newTicket.subject, category: newTicket.category }
            });

            // ── Email confirmation ─────────────────────────────────────────
            // Best-effort: send confirmation email but never fail the request.
            try {
                if (process.env.RESEND_API_KEY && user.email) {
                    await resend.emails.send({
                        from: FROM_EMAIL,
                        to: user.email,
                        subject: `[Ticket #${newTicket.id}] We received your request: ${newTicket.subject}`,
                        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="background:#111827;padding:28px 32px;text-align:center">
      <span style="color:#10b981;font-size:28px;font-weight:800;letter-spacing:-1px">Be More Swan</span>
      <span style="color:#fff;font-size:28px;font-weight:800;letter-spacing:-1px">-Assist</span>
    </div>
    <div style="padding:32px">
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827">We've got your message</h1>
      <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6">
        Your support ticket has been created. Our team typically responds within <strong>1–2 business days</strong>.
      </p>

      <div style="background:#f3f4f6;border-radius:8px;padding:20px;margin-bottom:24px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="color:#6b7280;padding:4px 0;width:120px">Ticket ID</td>
              <td style="color:#111827;font-weight:600">#${newTicket.id}</td></tr>
          <tr><td style="color:#6b7280;padding:4px 0">Subject</td>
              <td style="color:#111827;font-weight:600">${newTicket.subject}</td></tr>
          <tr><td style="color:#6b7280;padding:4px 0">Category</td>
              <td style="color:#111827">${newTicket.category}</td></tr>
          <tr><td style="color:#6b7280;padding:4px 0">Status</td>
              <td style="color:#10b981;font-weight:600">Open</td></tr>
          <tr><td style="color:#6b7280;padding:4px 0">Submitted</td>
              <td style="color:#111827">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>
        </table>
      </div>

      <p style="margin:0 0 8px;color:#374151;font-size:14px;line-height:1.6">
        <strong>What you reported:</strong><br>
        <span style="color:#6b7280">${newTicket.description}</span>
      </p>
    </div>
    <div style="background:#f9fafb;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb">
      <p style="margin:0;color:#9ca3af;font-size:13px">Please do not reply to this email.<br>
        To add information to your ticket, log into your <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/workspace.html" style="color:#10b981;text-decoration:none">Be More Swan workspace</a>.
      </p>
    </div>
  </div>
</body>
</html>`,
                    });
                }
            } catch (emailErr) {
                console.warn('[support-tickets] Confirmation email failed (non-blocking):', emailErr);
            }

            // The business inbox hears about every new ticket — before this, only the admin portal did.
            await alertInbox(`[Ticket #${newTicket.id}] New ${newTicket.category} ticket: ${newTicket.subject}`,
                `<p>New support ticket from <strong>${escHtml(user.email || '')}</strong>:</p>
                 <p><strong>${escHtml(newTicket.subject)}</strong> <span style="color:#787263">(${escHtml(newTicket.category)})</span></p>
                 <blockquote style="border-left:3px solid #eae4d7;padding-left:12px;color:#444036;white-space:pre-wrap">${escHtml(newTicket.description)}</blockquote>
                 <p><a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/admin.html?view=tickets">Open Support Tickets in the admin portal →</a></p>`);

            // US-AUD-3.1.1 SC6: Signal 5 — flag early support tickets from new users
            checkEarlySupportTicket(db, userId, newTicket.id); // fire-and-forget

            return { statusCode: 200, body: JSON.stringify({ success: true, ticket: newTicket }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error('Support Tickets API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
});