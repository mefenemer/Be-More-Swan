// netlify/functions/sar-download.ts
//
// US-ADM-1.3.1: SAR download endpoint
//
// GET /.netlify/functions/sar-download?token=<uuid>
// Serves the SAR JSON as a downloadable file.
// Returns 410 Gone if the token has expired or been used.

import { Handler, HandlerResponse } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { dataExportRequests } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event): Promise<HandlerResponse> => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const token = event.queryStringParameters?.token;
    if (!token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'token parameter required.' }) };
    }

    const db = getDb();
    const [row] = await db
        .select()
        .from(dataExportRequests)
        .where(eq(dataExportRequests.downloadToken, token))
        .limit(1);

    if (!row) {
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Download link not found or has already been used.' }),
        };
    }

    // Check expiry
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
        // Mark as expired
        await db.update(dataExportRequests)
            .set({ status: 'expired' })
            .where(eq(dataExportRequests.id, row.id))
            .catch(() => {});
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'This download link has expired (72-hour limit). Request a new SAR export.' }),
        };
    }

    if (row.status === 'expired') {
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'This download link has expired.' }),
        };
    }

    // Serve the data as a JSON file download
    const filename = `sar-export-user-${row.userId}-${new Date().toISOString().slice(0, 10)}.json`;

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
        },
        body: row.downloadUrl || '{}',  // downloadUrl stores the JSON payload
    };
});
