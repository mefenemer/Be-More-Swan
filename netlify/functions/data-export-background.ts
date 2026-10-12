// netlify/functions/data-export-background.ts
// Builds a self-serve data export queued by data-export.ts. A Netlify *background* function (the
// -background suffix): it acks 202 at once and may run up to 15 minutes — a large workspace is
// dozens of queries from us-east-1 to a London database, too slow for a 10-second request.
//
// POST { requestId, organisationId, includeWorkspace, sig }  — sig is data-export.ts's HMAC, so
// nobody else can start a build or widen its scope.
//
// The file goes to private R2 under `{orgId}/data-exports/…` (tenant-prefixed like every key —
// storage-keys.ts), recorded in data_export_requests.download_url as `r2:<key>`. Without R2 (a local
// run) it is stored inline as `b64:<json>`. data-export-download.ts serves either; the nightly
// storage-lifecycle-cleanup deletes both once the 24-hour link has expired.

import * as crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { dataExportRequests, users } from '../../db/schema';
import { buildDataExport, exportJobSignature } from '../../src/utils/workspace-export';
import { buildTenantKey } from '../../src/utils/storage-keys';
import { sendTemplatedEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

const DAY_MS = 24 * 60 * 60 * 1000;
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const r2Configured = !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && R2_BUCKET);

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { requestId?: number; organisationId?: number; includeWorkspace?: boolean; sig?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const { requestId, organisationId, sig } = body;
    const includeWorkspace = !!body.includeWorkspace;
    if (!requestId || !organisationId || !sig) return { statusCode: 400, body: 'Bad request.' };

    const expected = exportJobSignature(requestId, organisationId, includeWorkspace);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return { statusCode: 403, body: 'Forbidden.' };
    }

    const db = getDb();
    const [req] = await db.select().from(dataExportRequests)
        .where(and(eq(dataExportRequests.id, requestId), eq(dataExportRequests.status, 'pending'))).limit(1);
    if (!req) return { statusCode: 200, body: 'Nothing to do.' };

    try {
        const data = await buildDataExport(db, { userId: req.userId, organisationId, includeWorkspace });
        const jsonText = JSON.stringify(data, null, 2);

        let stored: string;
        if (r2Configured) {
            const key = buildTenantKey(organisationId, 'data-exports', 'export.json', crypto.randomUUID());
            const s3 = new S3Client({
                region: 'auto',
                endpoint: process.env.R2_ENDPOINT,
                credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
            });
            await s3.send(new PutObjectCommand({
                Bucket: R2_BUCKET, Key: key, Body: jsonText, ContentType: 'application/json',
            }));
            stored = `r2:${key}`;
        } else {
            stored = `b64:${Buffer.from(jsonText).toString('base64')}`;
        }

        const expiresAt = new Date(Date.now() + DAY_MS);
        await db.update(dataExportRequests)
            .set({ status: 'ready', downloadUrl: stored, expiresAt })
            .where(eq(dataExportRequests.id, req.id));

        const [user] = await db.select({ email: users.email, firstName: users.firstName })
            .from(users).where(eq(users.id, req.userId)).limit(1);
        const baseUrl = resolveBaseUrl(event.headers) || process.env.BASE_URL || '';
        if (user?.email) {
            await sendTemplatedEmail({
                triggerKey: 'data_export_ready',
                to: user.email,
                vars: {
                    user: { first_name: user.firstName || '' },
                    link: { action_url: `${baseUrl}/.netlify/functions/data-export-download?token=${req.downloadToken}` },
                },
            }).catch((err) => console.warn('[data-export-background] email failed:', err));
        }
        console.log(`[data-export-background] request ${req.id} ready (${jsonText.length} bytes, ${includeWorkspace ? 'workspace' : 'personal'})`);
    } catch (err) {
        console.error(`[data-export-background] request ${req.id} failed:`, err);
        await db.update(dataExportRequests).set({ status: 'failed' }).where(eq(dataExportRequests.id, req.id));
    }
    return { statusCode: 200, body: 'Done.' };
});
