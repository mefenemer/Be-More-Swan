// netlify/functions/data-export.ts
// US-GAP-2.2.1: User Requests Personal Data Export (GDPR Right of Portability)
//
//  POST → SC2: queues export job (async), returns "preparing" message
//  GET  → SC1: entry point info (returns status of any pending export)
//
// The export is built in-process (synchronous for simplicity — typical accounts are small).
// SC4: Download link is a signed URL in the response, valid 24 hours.
// SC5: Rate limit — one export per user per 24 hours.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { eq, and, desc, gte } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import {
    users, userProfiles, aiAssistants, contentAssets, billingInformation,
    invoices, supportTickets, systemConnections, notifications, dataExportRequests, plans,
} from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { requireOnboarding } from '../../src/utils/onboarding-guard';

const jwtSecret = process.env.JWT_SECRET!;
const BASE_URL  = process.env.BASE_URL || '';

function parseSession(event: any): number | null {
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) return { statusCode: 405, body: 'Method Not Allowed' };

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // US3 (AC3.1/AC3.2): Export is gated until onboarding is complete.
    const denied = await requireOnboarding(db, userId);
    if (denied) return denied;

    // SC5: Rate limit — one export per 24 hours
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentExport] = await db
        .select({ id: dataExportRequests.id, status: dataExportRequests.status })
        .from(dataExportRequests)
        .where(and(eq(dataExportRequests.userId, userId), gte(dataExportRequests.requestedAt, cutoff24h)))
        .orderBy(desc(dataExportRequests.requestedAt))
        .limit(1);

    if (event.httpMethod === 'GET') {
        return {
            statusCode: 200,
            body: JSON.stringify({
                recentRequest: recentExport
                    ? { status: recentExport.status, requestedAt: recentExport.id }
                    : null,
            }),
        };
    }

    // POST: trigger export
    if (recentExport) {
        return {
            statusCode: 429,
            body: JSON.stringify({ error: 'An export was recently requested. Please check your email.' }),
        };
    }

    // Create the request record
    const downloadToken = crypto.randomBytes(32).toString('hex');
    const expiresAt     = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [exportRequest] = await db.insert(dataExportRequests).values({
        userId,
        downloadToken,
        expiresAt,
        status: 'pending',
    }).returning();

    // Build the export payload (SC3: contents specification)
    const [user] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName,
                  createdAt: users.createdAt, role: users.role })
        .from(users).where(eq(users.id, userId)).limit(1);

    const [profile] = await db
        .select({ timezone: userProfiles.timezone, notifyBilling: userProfiles.notifyBilling,
                  emailPreferences: userProfiles.emailPreferences, language: userProfiles.language })
        .from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1)
        .catch(() => [null]);

    const assistantList = await db
        .select({ name: aiAssistants.name, assistantRole: (aiAssistants as any).assistantRole, createdAt: aiAssistants.createdAt })
        .from(aiAssistants).where(eq(aiAssistants.userId, userId));

    const assetList = await db
        .select({ name: contentAssets.name, assetType: contentAssets.assetType, createdAt: contentAssets.createdAt })
        .from(contentAssets).where(eq(contentAssets.userId, userId))
        .catch(() => []);

    const [billing] = await db
        .select({ fullName: billingInformation.fullName, addressLine1: billingInformation.addressLine1,
                  city: billingInformation.city, country: billingInformation.country })
        .from(billingInformation).where(eq(billingInformation.userId, userId)).limit(1)
        .catch(() => [null]);

    const invoiceList = await db
        .select({ invoiceNumber: invoices.invoiceNumber, amount: invoices.total,
                  currency: invoices.currency, issueDate: invoices.issueDate })
        .from(invoices).where(eq(invoices.userId, userId))
        .catch(() => []);

    const ticketList = await db
        .select({ subject: supportTickets.subject, status: supportTickets.status, category: supportTickets.category })
        .from(supportTickets).where(eq(supportTickets.userId, userId))
        .catch(() => []);

    const connectionList = await db
        .select({ serviceName: systemConnections.serviceName, status: systemConnections.status })
        .from(systemConnections).where(eq(systemConnections.userId, userId))
        .catch(() => []);

    const exportData = {
        exportedAt: new Date().toISOString(),
        profile: {
            firstName: user?.firstName,
            lastName: user?.lastName,
            email: user?.email,
            role: user?.role,
            createdAt: user?.createdAt,
            timezone: profile?.timezone,
            language: profile?.language,
            emailPreferences: profile?.emailPreferences,
        },
        assistants: assistantList,
        contentAssets: assetList,
        billingInformation: billing ? {
            fullName: billing.fullName,
            addressLine1: billing.addressLine1,
            city: billing.city,
            country: billing.country,
        } : null,
        invoices: invoiceList,
        supportTickets: ticketList,
        integrationConnections: connectionList,
    };

    const exportJson = JSON.stringify(exportData, null, 2);

    // SC4: Build a signed download URL embedded in a data: URI proxy
    // For production, this would upload to S3/Blob and return a signed URL.
    // Here we store the payload inline (base64) and serve via a download endpoint.
    const encodedPayload = Buffer.from(exportJson).toString('base64');

    await db.update(dataExportRequests)
        .set(withUpdatedAt({
            status: 'ready',
            downloadUrl: encodedPayload, // stored as base64 — served by data-export-download.ts
        }))
        .where(eq(dataExportRequests.id, exportRequest.id));

    const downloadUrl = `${BASE_URL}/.netlify/functions/data-export-download?token=${downloadToken}`;

    // SC4: Send email with download link
    sendEmail({
        to: user?.email || '',
        subject: 'Your Be More Swan data export is ready',
        html: `<p>Hi ${user?.firstName || 'there'},</p>
               <p>Your personal data export is ready. Click the button below to download it — the link is valid for 24 hours.</p>
               <p style="margin-top:20px;">
                 <a href="${downloadUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                   Download My Data →
                 </a>
               </p>
               <p style="font-size:0.8rem;color:#9ca3af;margin-top:12px;">This link expires in 24 hours. After that, you can request a new export from your account settings.</p>
               <p>The Be More Swan Team</p>`,
    }).catch(() => {});

    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            message: 'Your data export is being prepared. You\'ll receive an email when it\'s ready.',
        }),
    };
};
