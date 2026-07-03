// content-upload-url.ts — Generates a presigned S3 PUT URL for direct browser-to-S3 uploads
// POST { fileName, mimeType, fileSize } → { uploadUrl, storageKey, storageUrl }
//
// When AWS credentials are configured (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// S3_BUCKET_NAME, S3_REGION), this returns a real presigned URL.
// Until then, it returns 501 (storage not configured) — no uploads are accepted.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const jwtSecret = process.env.JWT_SECRET;
const S3_BUCKET  = process.env.S3_BUCKET_NAME;
const S3_REGION  = process.env.S3_REGION || 'us-east-1';
const AWS_KEY    = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY;

const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg',
]);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

export const handler: Handler = async (event) => {
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

        // ── Real S3 presigned URL (when AWS is configured) ────────
        if (S3_BUCKET && AWS_KEY && AWS_SECRET) {
            // Dynamic import so the build doesn't fail when @aws-sdk is not installed
            const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
            const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

            const s3 = new S3Client({ region: S3_REGION });
            const command = new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: storageKey,
                ContentType: mimeType,
                ContentLength: fileSize,
            });

            const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
            const storageUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${storageKey}`;

            return {
                statusCode: 200,
                body: JSON.stringify({ uploadUrl, storageKey, storageUrl }),
            };
        }

        // ── Storage not yet configured ────────────────────
        return {
            statusCode: 501,
            body: JSON.stringify({ error: 'Content upload storage is not yet configured.' }),
        };

    } catch (err) {
        console.error('Upload URL Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
