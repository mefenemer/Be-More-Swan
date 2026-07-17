// netlify/functions/process-asset-background.ts
import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse'; // pdf-parse v2 exports a named PDFParse class
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getDb } from '../../db/client';
import { workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';
import { safeFetchText } from '../../src/utils/safe-fetch';
import { stripPromptInjection } from '../../src/utils/prompt-injection';
import { withLambda } from '@netlify/aws-lambda-compat';

const R2_ENDPOINT          = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET            = process.env.R2_BUCKET_NAME;
const r2Configured = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
}

// Prompt-injection sanitiser — now shared with the Inspo ingestion path via
// src/utils/prompt-injection.ts (was a private copy here). Aliased so the call sites below
// read unchanged. Still belt-and-braces: the real defence is the structural data boundary
// in the system prompt.
const _stripPromptInjection = stripPromptInjection;

export default withLambda(async (event: HandlerEvent) => {
    try {
        const body = JSON.parse(event.body || '{}');
        const assetId = body.assetId;

        if (!assetId) return { statusCode: 400, body: 'Missing assetId' };

        const db = getDb();

        // 1. Fetch the processing asset from the database
        const [asset] = await db.select().from(workspaceAssets).where(eq(workspaceAssets.id, assetId));
        if (!asset) return { statusCode: 404, body: 'Asset not found' };

        // ── RAG Namespace safety note ────────────────────────────────
        // When a vector database is wired, ALL upserts and queries MUST
        // be namespaced by organisationId to prevent cross-tenant RAG leakage:
        //   namespace = `org_${asset.organisationId}`
        // Never use a global namespace — see security audit finding RAG/Vector Namespace Collision.
        const _ragNamespace = `org_${asset.organisationId}`; // used when vector DB is connected

        let extractedText = '';

        try {
            // ---------------------------------------------------------
            // EXTRACTION LOGIC A: WEBSITES & URLS
            // ---------------------------------------------------------
            if (asset.assetType === 'url' && asset.externalUrl) {
                // SSRF: externalUrl is user-supplied, so a plain fetch() here would let a user
                // aim this Lambda at cloud metadata (169.254.169.254 → IAM credentials) or at
                // VPC-internal services they can't reach themselves. safeFetchText validates
                // the scheme, pins the connection to pre-validated public addresses (closing
                // the DNS-rebind window), re-checks every redirect hop, and caps size/time.
                const fetched = await safeFetchText(asset.externalUrl);
                const $ = cheerio.load(fetched.body);

                // Strip out code, styling, and navigation junk
                $('script, style, noscript, iframe, img, svg, nav, footer').remove();

                // Extract clean text and normalize whitespace
                extractedText = $('body').text().replace(/\s+/g, ' ').trim();

                // ── Prompt-injection defence ─────────────────────────────
                // Scraped web content is untrusted. Strip common LLM instruction
                // injection patterns before it reaches the RAG pipeline.
                // We wrap the text in a structural boundary at query time (see
                // system prompt template) — this strip removes attempts to break out.
                extractedText = _stripPromptInjection(extractedText);
            }
                // ---------------------------------------------------------
                // EXTRACTION LOGIC B: R2-STORED FILES (PDF / TXT / CSV; images skipped)
            // ---------------------------------------------------------
            else if (asset.r2Key) {
                const fname = (asset.name || asset.originalFilename || '').toLowerCase();
                const mime  = (asset.mimeType || '').toLowerCase();
                const isPdf  = mime.includes('pdf')    || fname.endsWith('.pdf');
                const isText = mime.startsWith('text/') || fname.endsWith('.txt') || fname.endsWith('.csv');

                if (!r2Configured) {
                    // Fail loudly rather than seeding the RAG store with placeholder text.
                    // Storing fake content would silently corrupt the assistant's knowledge base.
                    throw new Error('Object storage (R2) is not configured — cannot extract asset text.');
                } else if (isPdf || isText) {
                    const s3  = getR2Client();
                    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key }));
                    const buffer = Buffer.from(await obj.Body!.transformToByteArray());
                    if (isPdf) {
                        const parser = new PDFParse({ data: buffer });
                        try { extractedText = (await parser.getText()).text.replace(/\s+/g, ' ').trim(); }
                        finally { await parser.destroy(); }
                    } else {
                        extractedText = buffer.toString('utf-8').trim();
                    }
                } else {
                    // Images (brand_logo) / other binaries — nothing textual for the assistant.
                    extractedText = '';
                }
            }
                // ---------------------------------------------------------
                // EXTRACTION LOGIC C (legacy): direct storageUrl fetch
                //   Pre-R2 'file' assets store a fetchable URL instead of an r2Key.
                // ---------------------------------------------------------
            else if (asset.assetType === 'file' && asset.storageUrl) {
                const fname = (asset.name || '').toLowerCase();
                const response = await fetch(asset.storageUrl);
                if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());

                if (fname.endsWith('.pdf')) {
                    const parser = new PDFParse({ data: buffer });
                    try { extractedText = (await parser.getText()).text.replace(/\s+/g, ' ').trim(); }
                    finally { await parser.destroy(); }
                } else if (fname.endsWith('.txt') || fname.endsWith('.csv')) {
                    extractedText = buffer.toString('utf-8').trim();
                } else {
                    // Non-textual binary (e.g. image) — nothing for the assistant to read.
                    extractedText = '';
                }
            }

            // Also sanitise file-extracted text (legacy 'file' assets and new R2-keyed ones)
            if (asset.assetType === 'file' || asset.r2Key) {
                extractedText = _stripPromptInjection(extractedText);
            }

            // 2. Cap the token length for safety (e.g., 100,000 characters)
            const safeText = extractedText.substring(0, 100000);

            // 3. Update the Database to 'Ready'
            await db.update(workspaceAssets)
                .set({
                    extractedText: safeText,
                    status: 'ready',
                    updatedAt: new Date()
                })
                .where(eq(workspaceAssets.id, assetId));

            // Log Success
            logAuditEvent({
                actionType: 'UPDATE',
                resourceType: 'workspace_assets',
                resourceId: assetId,
                newState: { status: 'ready', textLength: safeText.length }
            });

            return { statusCode: 200, body: 'Asset processed successfully.' };

        } catch (extractionError: any) {
            console.error(`Extraction failed for Asset ${assetId}:`, extractionError);

            // Handle failures gracefully by updating the UI state
            await db.update(workspaceAssets)
                .set({ status: 'failed', updatedAt: new Date() })
                .where(eq(workspaceAssets.id, assetId));

            return { statusCode: 500, body: 'Failed to extract text.' };
        }

    } catch (error) {
        console.error('Background Worker Critical Error:', error);
        return { statusCode: 500, body: 'Internal Server Error' };
    }
});