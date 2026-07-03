// scripts/set-r2-cors.ts
// One-off: apply a CORS policy to the R2 bucket so the browser can PUT brand assets
// directly to the presigned URL issued by storage-request-upload.ts.
//
// Without this, the browser's preflight (OPTIONS) to
//   https://<bucket>.<account>.r2.cloudflarestorage.com/...
// gets no Access-Control-Allow-Origin header and the upload is blocked by CORS.
//
// Run (env must contain the R2_* vars — pull them from Netlify or set inline):
//   npx tsx scripts/set-r2-cors.ts
//   R2_CORS_ORIGINS="https://staging--bemoreswan.netlify.app,https://bemoreswan.com" npx tsx scripts/set-r2-cors.ts
//
// Idempotent: re-running just overwrites the bucket's CORS rules.

import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { config } from 'dotenv';

config();

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME;

// Origins allowed to upload. Override with R2_CORS_ORIGINS (comma-separated) to add
// preview/custom domains without editing this file.
const DEFAULT_ORIGINS = [
    'https://staging--bemoreswan.netlify.app',
    'https://bemoreswan.com',
    'https://www.bemoreswan.com',
];
const allowedOrigins = (process.env.R2_CORS_ORIGINS
    ? process.env.R2_CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS);

async function main() {
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        console.error('Missing R2 env: need R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.');
        process.exit(1);
    }

    const s3 = new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

    console.log(`Applying CORS to bucket "${R2_BUCKET}" for origins:\n  ${allowedOrigins.join('\n  ')}`);

    await s3.send(new PutBucketCorsCommand({
        Bucket: R2_BUCKET,
        CORSConfiguration: {
            CORSRules: [
                {
                    // Browser direct-upload (presigned PUT) + read-back of objects.
                    AllowedOrigins: allowedOrigins,
                    AllowedMethods: ['PUT', 'GET', 'HEAD'],
                    AllowedHeaders: ['*'],
                    ExposeHeaders: ['ETag'],
                    MaxAgeSeconds: 3600,
                },
            ],
        },
    }));

    const current = await s3.send(new GetBucketCorsCommand({ Bucket: R2_BUCKET }));
    console.log('\n✓ CORS applied. Bucket now reports:');
    console.log(JSON.stringify(current.CORSRules, null, 2));
}

main().catch((err) => {
    console.error('Failed to set R2 CORS:', err);
    process.exit(1);
});
