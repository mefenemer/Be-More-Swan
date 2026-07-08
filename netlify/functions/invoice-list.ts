// invoice-list.ts
// GET → returns a chronological (newest first) list of invoices for the authenticated user

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { invoices } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── Auth ──────────────────────────────────────────────────────
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    try {
        const db = getDb();

        const userInvoices = await db.select({
            id:                  invoices.id,
            invoiceNumber:       invoices.invoiceNumber,
            issueDate:           invoices.issueDate,
            billingPeriodStart:  invoices.billingPeriodStart,
            billingPeriodEnd:    invoices.billingPeriodEnd,
            planName:            invoices.planName,
            subtotal:            invoices.subtotal,
            taxRate:             invoices.taxRate,
            taxAmount:           invoices.taxAmount,
            total:               invoices.total,
            currency:            invoices.currency,
            status:              invoices.status,
            createdAt:           invoices.createdAt,
        })
        .from(invoices)
        .where(eq(invoices.userId, userId))
        .orderBy(desc(invoices.createdAt));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoices: userInvoices }),
        };
    } catch (err: any) {
        console.error('[invoice-list]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load invoices.' }) };
    }
});
