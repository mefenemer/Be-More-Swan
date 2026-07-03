// netlify/functions/delete-workspace-asset.ts
// Soft-deletes a workspace/brand asset from the Workspace Library.
//
// DELETE ?assetId={id}  (POST also accepted)
// → { success: true }
//
// Lets a user clear an asset — including a stuck "pending" upload that never
// confirmed (and so can't be downloaded). The row is soft-deleted (status='deleted',
// deletedAt=now) so get-workspace-assets hides it; the R2 object is best-effort deleted
// when one exists. Cross-tenant safe: caller must be a member of the asset's org.

import { Handler } from '@netlify/functions';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userOrganisations, workspaceAssets } from '../../db/schema';
import { keyBelongsToOrg } from '../../src/utils/storage-keys';

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

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    const fromQuery = event.queryStringParameters?.assetId;
    const fromBody = (() => { try { return JSON.parse(event.body || '{}').assetId; } catch { return undefined; } })();
    const assetId = Number(fromQuery ?? fromBody);
    if (!assetId) return { statusCode: 400, body: JSON.stringify({ error: 'assetId required.' }) };

    const db = getDb();

    const [asset] = await db
        .select({
            id: workspaceAssets.id,
            organisationId: workspaceAssets.organisationId,
            r2Key: workspaceAssets.r2Key,
            status: workspaceAssets.status,
        })
        .from(workspaceAssets)
        .where(eq(workspaceAssets.id, assetId))
        .limit(1);

    if (!asset || asset.status === 'deleted' || asset.status === 'tombstoned') {
        return { statusCode: 404, body: JSON.stringify({ error: 'Asset not found.' }) };
    }

    // Cross-tenant guard — caller must be a member of the asset's org.
    const [membership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, asset.organisationId)))
        .limit(1);
    if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    // Best-effort R2 cleanup — only for a key that belongs to the owning org, and never
    // fatal (pending uploads usually have no object; deleting must still succeed).
    if (asset.r2Key && R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
        && keyBelongsToOrg(asset.r2Key, asset.organisationId)) {
        try {
            await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key }));
        } catch (err) {
            console.warn('[delete-workspace-asset] R2 delete failed (non-fatal) for asset', assetId, err);
        }
    }

    await db.update(workspaceAssets)
        .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceAssets.id, assetId));

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
};
