/**
 * netlify/functions/dpa-request.ts
 *
 * US-AUD-4.1.1 SC3 — DPA Request Form handler.
 *
 * POST body: { name: string, company: string, email: string }
 *
 * On success:
 *  (a) Inserts a row into dpa_requests for compliance audit
 *  (b) Sends notification email to platform legal contact
 *  (c) Sends auto-acknowledgement to the requester
 */

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { dpaRequests } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';

const LEGAL_EMAIL = process.env.LEGAL_EMAIL || 'hello@bemoreswan.com';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body || '{}');
        const { name, company, email } = body;

        if (!name?.trim() || !company?.trim() || !email?.trim()) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Name, company, and email are required.' }),
            };
        }

        // Basic email format validation
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Please provide a valid email address.' }),
            };
        }

        const db = getDb();

        // (a) Log the request for compliance audit
        await db.insert(dpaRequests).values({
            name: name.trim(),
            company: company.trim(),
            email: email.trim().toLowerCase(),
        });

        // (b) Notify platform legal team
        await sendMagicLinkEmail({
            to: LEGAL_EMAIL,
            subject: `New DPA Request from ${company.trim()} — ${email.trim()}`,
            html: `
                <div style="font-family:sans-serif;padding:24px;max-width:500px">
                    <h2>New DPA Request</h2>
                    <p><strong>Name:</strong> ${name.trim()}</p>
                    <p><strong>Company:</strong> ${company.trim()}</p>
                    <p><strong>Email:</strong> ${email.trim()}</p>
                    <p><strong>Requested at:</strong> ${new Date().toUTCString()}</p>
                    <p>Please send the Data Processing Agreement within 2 business days.</p>
                </div>
            `,
        });

        // (c) Auto-acknowledgement to the requester
        await sendMagicLinkEmail({
            to: email.trim(),
            subject: 'Your DPA Request — Be More Swan',
            html: `
                <div style="font-family:sans-serif;padding:24px;max-width:500px;background:#fff;border-radius:12px;border:1px solid #eae4d7">
                    <h2 style="color:#1f1e1b">DPA Request Received</h2>
                    <p style="color:#5c564b">Hi ${name.trim()},</p>
                    <p style="color:#5c564b">
                        Thank you for your Data Processing Agreement request on behalf of <strong>${company.trim()}</strong>.
                        We'll send your signed DPA within <strong>2 business days</strong>.
                    </p>
                    <p style="color:#5c564b">
                        If you have any questions in the meantime, reply to this email or contact us at
                        <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.
                    </p>
                    <p style="color:#787263;font-size:13px;margin-top:24px">Be More Swan · UK GDPR Compliant</p>
                </div>
            `,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: "We'll send your DPA within 2 business days." }),
        };

    } catch (err: any) {
        console.error('[dpa-request]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to submit DPA request.' }) };
    }
};
