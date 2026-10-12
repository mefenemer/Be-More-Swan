// netlify/functions/data-export-download.ts
// US-GAP-2.2.1 SC4: Serve the data export file via a time-limited token
//
// GET ?token=<downloadToken>  → the export file, as many times as wanted until the link expires (24h).
//
// The token in the link is the credential (it is emailed, and shown in My Account). Where the file is
// depends on data-export-background.ts: `r2:<key>` → a 5-minute signed R2 URL we redirect to;
// `b64:<json>` (no R2, e.g. a local run) or a pre-2026-10-12 bare base64 row → served from here.

import { HandlerResponse } from '@netlify/functions';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { eq, and, gte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { dataExportRequests } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';
import { checkImpersonationBlock } from '../../src/utils/impersonation';

export default withLambda(async (event): Promise<HandlerResponse> => {
    // US-ADM-1.2.1: never during an admin impersonation session (src/utils/impersonation.ts).
    const impersonationBlock = checkImpersonationBlock(event, 'data_export_download');
    if (impersonationBlock) return impersonationBlock;

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

    if (!request || request.status === 'expired' || request.status === 'failed') {
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

    const filename = `be-more-swan-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    const stored = request.downloadUrl;

    if (stored.startsWith('r2:')) {
        const s3 = new S3Client({
            region: 'auto',
            endpoint: process.env.R2_ENDPOINT,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
        });
        const signed = await getSignedUrl(s3, new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: stored.slice(3),
            ResponseContentDisposition: `attachment; filename="${filename}"`,
            ResponseContentType: 'application/json',
        }), { expiresIn: 300 });
        return { statusCode: 302, headers: { Location: signed, 'Cache-Control': 'no-store' }, body: '' };
    }

    const jsonPayload = Buffer.from(stored.startsWith('b64:') ? stored.slice(4) : stored, 'base64').toString('utf8');
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
        },
        body: jsonPayload,
    };
});
