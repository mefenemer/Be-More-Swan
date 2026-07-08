// /netlify/functions/uploadToR2.ts
import { Handler } from "@netlify/functions";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { withLambda } from '@netlify/aws-lambda-compat';

// 1. Initialize the client outside the handler so it can be reused across function invocations
const s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
});

// 2. The actual serverless function that your frontend will call
export default withLambda(async (event) => {
    // Only allow POST requests
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        // Parse the file data sent from your React frontend
        const { fileName, fileData, mimeType } = JSON.parse(event.body || '{}');

        // Convert base64 or text data back to a buffer/Uint8Array as needed
        const buffer = Buffer.from(fileData, 'base64');

        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: mimeType,
        });

        await s3Client.send(command);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Upload successful!" }),
        };
    } catch (error) {
        console.error("R2 Upload Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to upload file" }),
        };
    }
});