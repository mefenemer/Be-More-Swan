// admin-helpdesk.ts  (US7)
// Admin-only helpdesk: ticket assignment, threaded replies, status lifecycle, SLA.
//
// GET  ?ticketId=N               → ticket detail + full reply thread
// PATCH ?ticketId=N              → update status / priority / assignedTo
// POST  ?ticketId=N              → add reply (isInternal flag) + email customer if public
//
// SLA: first response within 24 h; breach flag set by scheduled purge or on-read check.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import { eq, and, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, supportTickets, ticketReplies, notifications, auditLogs } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@bemoreswan.com';

// 24-hour SLA threshold (ms)
const SLA_MS = 24 * 60 * 60 * 1000;

async function requireAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !['admin', 'super_admin'].includes(row.role)) return null;
    return userId;
}

async function audit(db: any, adminId: number, action: string, resourceId: number, payload?: any) {
    try {
        await db.insert(auditLogs).values({ userId: adminId, actionType: action, resourceType: 'support_tickets', resourceId: String(resourceId), newState: payload ?? null });
    } catch { /* non-blocking */ }
}

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    const adminId = await requireAdmin(event);
    if (!adminId) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Access denied.' }) };
    }

    const qs = event.queryStringParameters || {};
    const ticketId = parseInt(qs.ticketId || '');
    if (!ticketId) return { statusCode: 400, body: JSON.stringify({ error: 'ticketId is required.' }) };

    const db = getDb();

    // Load ticket + submitter
    const [ticket] = await db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.id, ticketId))
        .limit(1);
    if (!ticket) return { statusCode: 404, body: JSON.stringify({ error: 'Ticket not found.' }) };

    const [submitter] = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(eq(users.id, ticket.userId))
        .limit(1);

    try {
        // ── GET: ticket detail + thread ───────────────────────────────────────
        if (event.httpMethod === 'GET') {
            const replies = await db
                .select({
                    id: ticketReplies.id,
                    body: ticketReplies.body,
                    isInternal: ticketReplies.isInternal,
                    createdAt: ticketReplies.createdAt,
                    authorId: ticketReplies.authorId,
                    authorEmail: users.email,
                    authorFirstName: users.firstName,
                })
                .from(ticketReplies)
                .innerJoin(users, eq(users.id, ticketReplies.authorId))
                .where(eq(ticketReplies.ticketId, ticketId))
                .orderBy(asc(ticketReplies.createdAt));

            // SLA check — flag ticket if past 24 h with no first response
            let slaUpdated = false;
            if (!ticket.slaBreachedAt && !ticket.firstResponseAt) {
                const age = Date.now() - new Date(ticket.createdAt).getTime();
                if (age > SLA_MS) {
                    await db.update(supportTickets)
                        .set({ slaBreachedAt: new Date(), updatedAt: new Date() })
                        .where(eq(supportTickets.id, ticketId));
                    slaUpdated = true;
                }
            }

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket: { ...ticket, slaBreached: slaUpdated || !!ticket.slaBreachedAt }, replies, submitter }),
            };
        }

        // ── PATCH: update ticket metadata ─────────────────────────────────────
        if (event.httpMethod === 'PATCH') {
            const body = JSON.parse(event.body || '{}');
            const updates: Record<string, any> = { updatedAt: new Date() };

            const VALID_STATUSES = new Set(['new', 'open', 'pending_customer', 'resolved', 'closed']);
            const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

            if (body.status && VALID_STATUSES.has(body.status)) {
                updates.status = body.status;
                if (body.status === 'resolved') updates.resolvedAt = new Date();
                if (body.status === 'closed')   updates.closedAt   = new Date();
            }
            if (body.priority && VALID_PRIORITIES.has(body.priority)) updates.priority = body.priority;
            if (body.assignedTo !== undefined) updates.assignedTo = body.assignedTo;

            const [updated] = await db.update(supportTickets).set(updates).where(eq(supportTickets.id, ticketId)).returning();
            await audit(db, adminId, 'UPDATE', ticketId, updates);

            // US7 Sc5: "Resolved" → send closure confirmation email to customer
            if (body.status === 'resolved' && submitter?.email && process.env.RESEND_API_KEY) {
                try {
                    await resend.emails.send({
                        from: FROM_EMAIL,
                        to: submitter.email,
                        subject: `[Ticket #${ticketId}] Your request has been resolved`,
                        html: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#111827;padding:24px 32px">
    <span style="color:#10b981;font-size:22px;font-weight:800">Be More Swan</span>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 12px;color:#111827">Your support request is resolved</h2>
    <p style="margin:0 0 20px;color:#6b7280;font-size:15px;line-height:1.6">
      Hi ${submitter.firstName || 'there'},<br><br>
      Ticket <strong>#${ticketId} — ${ticket.subject}</strong> has been marked as resolved by our support team.
    </p>
    <p style="margin:0;color:#9ca3af;font-size:13px">If you have further questions, submit a new ticket from your workspace.</p>
  </div>
</div>`,
                    });
                } catch (e) { console.warn('[admin-helpdesk] Resolution email failed:', e); }
            }

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket: updated }),
            };
        }

        // ── POST: add reply ────────────────────────────────────────────────────
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const { replyBody, isInternal = false } = body;
            if (!replyBody?.trim()) return { statusCode: 400, body: JSON.stringify({ error: 'replyBody is required.' }) };

            const [reply] = await db.insert(ticketReplies).values({
                ticketId,
                authorId: adminId,
                body: replyBody.trim(),
                isInternal: !!isInternal,
            }).returning();

            // Record first response timestamp
            if (!ticket.firstResponseAt) {
                await db.update(supportTickets)
                    .set({ firstResponseAt: new Date(), updatedAt: new Date() })
                    .where(eq(supportTickets.id, ticketId));
            }

            // US7 Sc3: Public replies → email customer + transition to 'pending_customer'
            if (!isInternal) {
                await db.update(supportTickets)
                    .set({ status: 'pending_customer', updatedAt: new Date() })
                    .where(eq(supportTickets.id, ticketId));

                if (submitter?.email && process.env.RESEND_API_KEY) {
                    try {
                        await resend.emails.send({
                            from: FROM_EMAIL,
                            to: submitter.email,
                            subject: `Re: [Ticket #${ticketId}] ${ticket.subject}`,
                            html: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#111827;padding:24px 32px">
    <span style="color:#10b981;font-size:22px;font-weight:800">Be More Swan</span>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px">Ticket #${ticketId} — ${ticket.subject}</p>
    <div style="background:#f9fafb;border-left:3px solid #10b981;padding:16px;border-radius:4px;color:#374151;font-size:15px;line-height:1.7;white-space:pre-wrap">${replyBody.trim()}</div>
    <p style="margin:20px 0 0;color:#9ca3af;font-size:13px">Please do not reply to this email. Log in to your workspace to continue the conversation.</p>
  </div>
</div>`,
                        });
                    } catch (e) { console.warn('[admin-helpdesk] Reply email failed:', e); }
                }

                // In-app notification to the customer
                try {
                    await db.insert(notifications).values({
                        userId: ticket.userId,
                        type: 'ticket_reply',
                        title: `New reply on Ticket #${ticketId}`,
                        message: `Support has responded to your request: "${ticket.subject}".`,
                    });
                } catch { /* non-blocking */ }
            }

            await audit(db, adminId, 'CREATE', ticketId, { replyId: reply.id, isInternal });

            return {
                statusCode: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reply }),
            };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err: any) {
        console.error('[admin-helpdesk] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
