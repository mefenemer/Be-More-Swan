// netlify/functions/storage-request-upload.ts
// US-STOR-1.2.1: Issues a pre-signed R2 PUT URL for direct client-to-R2 uploads.
//
// POST { orgId, assetType, filename, mimeType, fileSizeBytes }
// → { uploadUrl (15-min TTL), assetId }
//
// Auth: caller must be a member of orgId.
// Quota: fileSizeBytes + usedBytes must not exceed plan storageLimitBytes.
// MIME: mimeType must be on the allowlist for assetType.

import { Handler } from '@netlify/functions';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, workspaceAssets, storageUsage, plans, masterPlans } from '../../db/schema';
import { buildTenantKey } from '../../src/utils/storage-keys';
import { requireTenant } from '../../src/utils/tenant';

const JWT_SECRET  = process.env.JWT_SECRET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;           // https://<accountId>.r2.cloudflarestorage.com
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET   = process.env.R2_BUCKET_NAME;

// AC3/AC14: MIME allowlist per assetType
const MIME_ALLOWLIST: Record<string, Set<string>> = {
    brand_logo:       new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']),
    brand_document:   new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']),
    social_image:     new Set(['image/png', 'image/jpeg', 'image/webp']),
    voice_recording:  new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']),
    generated_content:new Set(['image/png', 'image/jpeg', 'image/webp']),
    other:            new Set(['application/pdf', 'text/plain', 'image/png', 'image/jpeg']),
};

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
        // AWS SDK v3 (≥3.729) defaults requestChecksumCalculation to WHEN_SUPPORTED, which
        // bakes a CRC32 checksum (x-amz-checksum-crc32 / x-amz-sdk-checksum-algorithm) into
        // the presigned URL. The browser PUT can't reproduce that checksum over the real
        // bytes, so R2 rejects the upload. WHEN_REQUIRED drops it for PutObject (R2 requires
        // no checksum), keeping the presigned PUT a plain SigV4 request.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const db = getDb();

    // AC2: resolve the active org from the session and verify membership server-side
    // (the client never supplies orgId — never trust a client-supplied tenant prefix).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { assetType?: string; filename?: string; mimeType?: string; fileSizeBytes?: number; category?: string };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const { assetType, filename, mimeType, fileSizeBytes, category } = body;
    if (!assetType || !filename || !mimeType || !fileSizeBytes) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assetType, filename, mimeType, fileSizeBytes required.' }) };
    }

    // AC3/AC14: MIME allowlist check — SVG blocked for social_image and generated_content (AC15)
    const allowed = MIME_ALLOWLIST[assetType];
    if (!allowed) return { statusCode: 422, body: JSON.stringify({ error: `Unknown assetType: ${assetType}` }) };
    if (!allowed.has(mimeType)) {
        return { statusCode: 422, body: JSON.stringify({ error: `MIME type ${mimeType} not permitted for ${assetType}. Allowed: ${[...allowed].join(', ')}` }) };
    }

    // AC4: quota check
    const [usage] = await db.select({ usedBytes: storageUsage.usedBytes }).from(storageUsage).where(eq(storageUsage.organisationId, orgId)).limit(1);
    const usedBytes = usage?.usedBytes ?? 0;
    const [planRow] = await db
        .select({ storageLimitBytes: masterPlans.storageLimitBytes })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
        .limit(1);
    const limitBytes = planRow?.storageLimitBytes ?? null;
    if (limitBytes !== null && usedBytes + fileSizeBytes > limitBytes) {
        return { statusCode: 413, body: JSON.stringify({ error: 'storage_quota_exceeded', usedBytes, limitBytes }) };
    }

    // AC13: hard guard — key MUST begin with a valid orgId prefix; no zero/null can slip through
    if (!Number.isInteger(orgId) || orgId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid orgId — cannot issue key without valid tenant prefix.' }) };
    }

    // AC2 key format: /{orgId}/{assetType}/{uuid}.{ext} — derived via shared tenant-key util (AC12/AC13)
    const r2Key = buildTenantKey(orgId, assetType, filename, crypto.randomUUID());

    // Insert pending workspace_asset row
    const [asset] = await db.insert(workspaceAssets).values({
        organisationId: orgId,
        uploaderId: userId,
        name: filename,
        assetType,
        category: category || assetType,
        r2Key,
        mimeType,
        fileSizeBytes,
        originalFilename: filename,
        status: 'pending',
    }).returning({ id: workspaceAssets.id });

    // Generate pre-signed PUT URL (AC5: 15-min TTL)
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        // Mock mode — R2 not yet configured
        return {
            statusCode: 200,
            body: JSON.stringify({ uploadUrl: `/.netlify/functions/storage-request-upload?mock=1&key=${encodeURIComponent(r2Key)}`, assetId: asset.id, mock: true }),
        };
    }

    const s3 = getR2Client();
    const command = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,          // AC6: scoped to specific key only
        ContentType: mimeType,
        ContentLength: fileSizeBytes,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadUrl, assetId: asset.id }),
    };
};
