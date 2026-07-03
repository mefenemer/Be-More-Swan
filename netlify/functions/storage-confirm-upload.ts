// netlify/functions/storage-confirm-upload.ts
// US-STOR-1.2.1: Confirms an upload by verifying the object exists in R2 and updating DB.
//
// POST { assetId }
// → { assetId, assetType, fileSizeBytes }
//
// AC7: 404 if object not in R2
// AC8: 422 if Content-Type mismatch
// AC1 (STOR-1.1.2): Atomically increments storageUsage.usedBytes

import { Handler } from '@netlify/functions';
import { S3Client, HeadObjectCommand, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, workspaceAssets, storageUsage, organisations, plans, masterPlans } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';

// Fire-and-forget the AI extraction job so the assistant learns from uploaded brand docs.
function triggerExtraction(headers: Record<string, string | undefined>, assetId: number): void {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) {
        console.error('[storage-confirm-upload] Could not resolve base URL — extraction not triggered for asset', assetId);
        return;
    }
    fetch(`${baseUrl}/.netlify/functions/process-asset-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
    }).catch(err => console.error('[storage-confirm-upload] Failed to trigger extraction:', err));
}

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

function _fmtBytes(b: number): string {
    if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
    if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`;
    return `${(b / 1024).toFixed(0)} KB`;
}

async function _maybeWarnQuota(orgId: number, addedBytes: number): Promise<void> {
    const db = getDb();

    // Get current usage + limit + last warning time
    const [usage] = await db
        .select({ usedBytes: storageUsage.usedBytes, lastSentAt: storageUsage.quotaWarningLastSentAt })
        .from(storageUsage).where(eq(storageUsage.organisationId, orgId)).limit(1);
    const [planRow] = await db
        .select({ storageLimitBytes: masterPlans.storageLimitBytes })
        .from(plans).leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active'))).limit(1);

    const limitBytes = planRow?.storageLimitBytes ?? null;
    if (!limitBytes || !usage) return;

    const newUsed = (usage.usedBytes ?? 0) + addedBytes;
    const pct = newUsed / limitBytes;
    if (pct < 0.8) return; // below threshold — nothing to do

    // Enforce 7-day window
    if (usage.lastSentAt) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (usage.lastSentAt > sevenDaysAgo) return;
    }

    // Find workspace owner email
    const [owner] = await db.execute<{ email: string; first_name: string }>(sql`
        SELECT u.email, u.first_name
        FROM users u
        JOIN user_organisations uo ON uo.user_id = u.id
        WHERE uo.organisation_id = ${orgId} AND uo.role = 'owner'
        LIMIT 1
    `);
    if (!owner?.email) return;

    // Mark warning sent before email (prevent race)
    await db.execute(sql`
        UPDATE storage_usage SET quota_warning_last_sent_at = now()
        WHERE organisation_id = ${orgId}
    `);

    const pctLabel = Math.round(pct * 100);
    await sendMagicLinkEmail({
        to: owner.email,
        subject: `Be More Swan: You've used ${pctLabel}% of your storage quota`,
        html: `
            <div style="font-family:sans-serif;padding:32px 20px;background:#fdfcf9;">
              <div style="max-width:520px;margin:0 auto;background:#fff;padding:36px;border-radius:14px;border:1px solid #eae4d7;">
                <h2 style="color:#1f1e1b;margin-top:0;">Storage quota warning</h2>
                <p style="color:#5c564b;font-size:15px;line-height:1.6;">
                  Hi ${owner.first_name || 'there'},<br><br>
                  Your workspace is currently using <strong>${_fmtBytes(newUsed)}</strong> of your
                  <strong>${_fmtBytes(limitBytes)}</strong> storage quota
                  (<strong>${pctLabel}%</strong>).
                </p>
                <p style="color:#5c564b;font-size:15px;line-height:1.6;">
                  Once you reach 100%, new uploads will be blocked. You can free up space by removing
                  unused assets or upgrade your plan to increase your quota.
                </p>
                <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/billing.html"
                   style="display:inline-block;margin:16px 0;padding:12px 24px;background:#00e55c;color:#fff;font-weight:bold;border-radius:8px;text-decoration:none;">
                  View billing &amp; upgrade →
                </a>
                <p style="color:#9e9689;font-size:13px;margin-bottom:0;">You'll receive this reminder at most once every 7 days.</p>
              </div>
            </div>`,
    });
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    let body: { assetId?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const { assetId } = body;
    if (!assetId) return { statusCode: 400, body: JSON.stringify({ error: 'assetId required.' }) };

    const db = getDb();

    const [asset] = await db
        .select({
            id: workspaceAssets.id,
            organisationId: workspaceAssets.organisationId,
            r2Key: workspaceAssets.r2Key,
            mimeType: workspaceAssets.mimeType,
            fileSizeBytes: workspaceAssets.fileSizeBytes,
            assetType: workspaceAssets.assetType,
            status: workspaceAssets.status,
        })
        .from(workspaceAssets)
        .where(eq(workspaceAssets.id, assetId))
        .limit(1);

    if (!asset) return { statusCode: 404, body: JSON.stringify({ error: 'Asset not found.' }) };
    if (asset.status !== 'pending') return { statusCode: 409, body: JSON.stringify({ error: 'Asset already confirmed.' }) };

    // Verify caller is a member of the asset's org
    const [membership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, asset.organisationId)))
        .limit(1);
    if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    // Mock mode — skip R2 HEAD check
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        await db.update(workspaceAssets).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(workspaceAssets.id, assetId));
        triggerExtraction(event.headers, assetId);
        return { statusCode: 200, body: JSON.stringify({ assetId, assetType: asset.assetType, fileSizeBytes: asset.fileSizeBytes, mock: true }) };
    }

    // AC7: HEAD the object in R2
    const s3 = getR2Client();
    let head: HeadObjectCommandOutput;
    try {
        head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key! }));
    } catch (err: any) {
        if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found in storage. Please retry the upload.' }) };
        }
        throw err;
    }

    // AC8: Content-Type must match declared mimeType
    const r2ContentType = (head as any).ContentType || '';
    if (asset.mimeType && r2ContentType && !r2ContentType.startsWith(asset.mimeType.split(';')[0])) {
        return { statusCode: 422, body: JSON.stringify({ error: `Content-Type mismatch: expected ${asset.mimeType}, got ${r2ContentType}` }) };
    }

    // Mark confirmed and atomically increment storage usage (AC1 STOR-1.1.2)
    await db.update(workspaceAssets).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(workspaceAssets.id, assetId));
    if (asset.fileSizeBytes) {
        await db.execute(
            sql`INSERT INTO storage_usage (organisation_id, used_bytes, updated_at)
                VALUES (${asset.organisationId}, ${asset.fileSizeBytes}, now())
                ON CONFLICT (organisation_id)
                DO UPDATE SET used_bytes = storage_usage.used_bytes + ${asset.fileSizeBytes}, updated_at = now()`
        );

        // AC4: send 80% quota warning email (once per 7-day window)
        void _maybeWarnQuota(asset.organisationId, asset.fileSizeBytes).catch(() => {});
    }

    // Kick off AI context extraction now the object is confirmed in R2.
    triggerExtraction(event.headers, assetId);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, assetType: asset.assetType, fileSizeBytes: asset.fileSizeBytes }),
    };
};
