// netlify/functions/data-export-download.ts
// US-GAP-2.2.1 SC4: Serve the data export file via a time-limited token
//
// GET ?token=<downloadToken>  → streams JSON file, then marks request as expired

import { Handler, HandlerResponse } from '@netlify/functions';
import { eq, and, gte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { dataExportRequests } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event): Promise<HandlerResponse> => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const token = event.queryStringParameters?.token;
    if (!token) return { statusCode: 400, body: 'Missing token.' };

    const db  = getDb();
    const now = new Date();

    const [request] = await db
        .select({ id: dataExportRequests.id, downloadUrl: dataExportRequests.downloadUrl,
                  expiresAt: dataExportRequests.expiresAt, status: dataExportRequests.status,
                  downloadToken: dataExportRequests.downloadToken })
        .from(dataExportRequests)
        .where(eq(dataExportRequests.downloadToken, token))
        .limit(1);

    if (!request || request.status === 'expired') {
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'text/html' },
            body: '<p>This download link has expired or is invalid. Please request a new data export from your account settings.</p>',
        };
    }

    const expiresAt = request.expiresAt instanceof Date
        ? request.expiresAt
        : request.expiresAt ? new Date(request.expiresAt as string) : null;

    if (expiresAt && now > expiresAt) {
        await db.update(dataExportRequests).set({ status: 'expired' }).where(eq(dataExportRequests.id, request.id));
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'text/html' },
            body: '<p>This download link has expired. Please request a new data export from your account settings.</p>',
        };
    }

    if (!request.downloadUrl) {
        return { statusCode: 503, body: 'Export not ready yet. Please wait and try again.' };
    }

    // Decode the base64 payload and serve as JSON file
    const jsonPayload = Buffer.from(request.downloadUrl, 'base64').toString('utf8');

    // Mark as expired so the link can only be used once (optional — comment out to allow re-downloads within 24h)
    // await db.update(dataExportRequests).set({ status: 'expired' }).where(eq(dataExportRequests.id, request.id));

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="aura-data-export-${new Date().toISOString().slice(0, 10)}.json"`,
        },
        body: jsonPayload,
    };
});
