// netlify/functions/storage-download-url.ts
// US-STOR-1.2.1: Issues a pre-signed R2 GET URL for a confirmed asset.
//
// GET ?assetId={id}
// → { downloadUrl }
//
// AC10: cross-tenant access impossible — caller's org must own the asset
// AC11: 1-hour TTL
// AC12: response-content-disposition: attachment; filename="{originalFilename}"
// AC13: r2Key never returned

import { Handler } from '@netlify/functions';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, workspaceAssets } from '../../db/schema';
import { keyBelongsToOrg } from '../../src/utils/storage-keys';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET  = process.env.JWT_SECRET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET   = process.env.R2_BUCKET_NAME;

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    const assetId = event.queryStringParameters?.assetId ? Number(event.queryStringParameters.assetId) : null;
    if (!assetId) return { statusCode: 400, body: JSON.stringify({ error: 'assetId required.' }) };

    const db = getDb();

    const [asset] = await db
        .select({
            id: workspaceAssets.id,
            organisationId: workspaceAssets.organisationId,
            r2Key: workspaceAssets.r2Key,
            originalFilename: workspaceAssets.originalFilename,
            status: workspaceAssets.status,
        })
        .from(workspaceAssets)
        .where(eq(workspaceAssets.id, assetId))
        .limit(1);

    if (!asset || asset.status !== 'confirmed') {
        return { statusCode: 404, body: JSON.stringify({ error: 'Asset not found or not yet confirmed.' }) };
    }

    // AC10: cross-tenant guard — caller must be a member of the asset's org
    const [membership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, asset.organisationId)))
        .limit(1);
    if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    // AC12: defence-in-depth — the stored key must live under the owning org's prefix.
    // A key that does not match the asset's org indicates tampering/corruption; never sign it.
    if (!keyBelongsToOrg(asset.r2Key, asset.organisationId)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden — tenant key mismatch.' }) };
    }

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        return { statusCode: 200, body: JSON.stringify({ downloadUrl: `/.netlify/functions/storage-download-url?mock=1&assetId=${assetId}`, mock: true }) };
    }

    const s3 = getR2Client();
    const safeFilename = (asset.originalFilename || `file-${assetId}`).replace(/[^\w.\-]/g, '_');
    const command = new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: asset.r2Key!,
        ResponseContentDisposition: `attachment; filename="${safeFilename}"`,  // AC12
    });
    // AC11: 1-hour TTL; AC13: raw r2Key never in response body
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadUrl }),
    };
});
