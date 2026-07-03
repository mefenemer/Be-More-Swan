// contact.ts
// Public (no-auth) contact / role-request endpoint.
// POST { email, subject, message, source? }
// → Sends an internal notification email via Resend.

import { Handler } from '@netlify/functions';
import { Resend } from 'resend';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, leads } from '../../db/schema';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM_EMAIL  = process.env.FROM_EMAIL   || 'hello@bemoreswan.com';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || FROM_EMAIL; // internal inbox

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { email?: string; subject?: string; message?: string; source?: string };
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { email, subject, message, source } = body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid email address is required.' }) };
    }
    if (!subject || !message) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Subject and message are required.' }) };
    }

    try {
        if (process.env.RESEND_API_KEY) {
            await resend.emails.send({
                from: FROM_EMAIL,
                to: NOTIFY_EMAIL,
                replyTo: email,
                subject: `[Be More Swan Contact] ${subject}`,
                html: `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
  <div style="background:#111827;padding:20px 28px">
    <span style="color:#10b981;font-size:20px;font-weight:800">Be More Swan</span>
    <span style="color:#fff;font-size:20px;font-weight:800">-Assist</span>
    <span style="color:#9ca3af;font-size:13px;margin-left:12px">Internal notification</span>
  </div>
  <div style="padding:28px">
    <h2 style="margin:0 0 16px;color:#111827;font-size:18px">${subject}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
      <tr><td style="padding:6px 0;color:#6b7280;width:100px">From</td><td style="padding:6px 0;color:#111827;font-weight:600">${email}</td></tr>
      ${source ? `<tr><td style="padding:6px 0;color:#6b7280">Source</td><td style="padding:6px 0;color:#111827">${source}</td></tr>` : ''}
    </table>
    <div style="background:#f9fafb;border-left:3px solid #10b981;padding:16px;border-radius:4px;color:#374151;font-size:14px;line-height:1.7;white-space:pre-wrap">${message}</div>
  </div>
</div>`,
            });
        }

        // US-SALES-1.1 Part 2b: capture contact form as a lead row
        try {
            const db = getDb();
            const resolvedEmail = email.trim().toLowerCase();
            const [existingUser] = await db.select({ id: users.id })
                .from(users).where(eq(users.email, resolvedEmail)).limit(1);
            await db.insert(leads).values({
                email: resolvedEmail,
                opportunityReason: subject!,
                action: 'contact_form_submission',
                leadType: 'contact_form',
                source: source || 'contact_form',
                useCase: message,
                priority: 'medium',
                userId: existingUser?.id ?? null,
            }).onConflictDoUpdate({
                target: [leads.email, leads.opportunityReason],
                set: { useCase: message, updatedAt: new Date() },
            });
        } catch (leadErr) {
            console.error('[contact] lead capture failed (non-fatal):', leadErr);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true }),
        };
    } catch (err: any) {
        console.error('[contact] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to send. Please try again.' }) };
    }
};
