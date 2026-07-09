// content-upload-url.ts — Generates a presigned R2 PUT URL for direct browser-to-R2 uploads
// POST { fileName, mimeType, fileSize } → { uploadUrl, storageKey } (or { mock: true, storageKey })
//
// Storage backend is Cloudflare R2 (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET_NAME) — the same backend every other upload/download path in this app uses
// (see storage-request-upload.ts, storage-download-url.ts). Falls back to mock mode,
// matching those siblings, when R2 isn't configured.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET   = process.env.R2_BUCKET_NAME;

const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg',
]);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
        // See storage-request-upload.ts for why WHEN_REQUIRED is needed for R2 presigned PUTs.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { fileName, mimeType, fileSize, orgId } = body;

        if (!fileName || !mimeType) {
            return { statusCode: 400, body: JSON.stringify({ error: 'fileName and mimeType are required.' }) };
        }
        if (!ALLOWED_MIME_TYPES.has(mimeType)) {
            return { statusCode: 400, body: JSON.stringify({ error: `File type not allowed: ${mimeType}` }) };
        }
        if (fileSize && fileSize > MAX_FILE_SIZE) {
            return { statusCode: 400, body: JSON.stringify({ error: 'File exceeds 500 MB limit.' }) };
        }

        const ext = fileName.split('.').pop()?.toLowerCase() || 'bin';
        const uniqueId = crypto.randomUUID();
        const storageKey = `content/org-${orgId || 'unknown'}/user-${userId}/${uniqueId}.${ext}`;

        // ── Mock mode — R2 not yet configured ─────────────────────
        if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
            return { statusCode: 200, body: JSON.stringify({ mock: true, storageKey }) };
        }

        // ── Real R2 presigned URL ──────────────────────────────────
        const s3 = getR2Client();
        const command = new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: storageKey,
            ContentType: mimeType,
            ContentLength: fileSize,
        });
        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

        return {
            statusCode: 200,
            body: JSON.stringify({ uploadUrl, storageKey }),
        };

    } catch (err) {
        console.error('Upload URL Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
});
