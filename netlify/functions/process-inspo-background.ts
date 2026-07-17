// netlify/functions/process-inspo-background.ts
// Extraction worker for Inspo items of kind 'url' and 'file' — the kinds whose text isn't
// already in hand when the user hits save (unlike typed/dictated notes, which inspo-items.ts
// ingests inline). Fetches or reads the material, extracts text, chunks + embeds it, and
// flips the item to 'ready'. Triggered (awaited!) from inspo-items.ts.
//
// POST { inspoItemId }
//
// Extraction by kind:
//   url   → safeFetchText (SSRF-guarded) + cheerio text extraction
//   file  → R2 object: PDF via pdf-parse, text/* read directly
//   video → deliberately NOT extracted. Nothing in this stack watches an mp4, so the user's
//           note is the only real signal; we mark 'unsupported' and let the note carry it
//           rather than pretend we studied the footage.
//   image → deliberately NOT extracted in this phase. Claude vision could describe it, but
//           that's an LLM call per upload and a product decision that hasn't been made —
//           marked 'unsupported' so the note still counts. See docs/inspo-tab-plan.md.
//
// All extracted text is untrusted (someone else's web page / document), so it gets the same
// prompt-injection strip the workspace-asset path uses before it can reach a prompt.
//
// Failures are recorded on the row (ingest_status 'failed'), never thrown away: a silently
// stuck 'pending' item is indistinguishable from a slow one, and the tab would lie about it.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getDb } from '../../db/client';
import { inspoItems, inspoChunks, workspaceAssets, vectorEmbeddings } from '../../db/schema';
import { chunkArticle, embedTexts, embeddingsConfigured } from '../../src/utils/kb-embeddings';
import { safeFetchText, SafeFetchError } from '../../src/utils/safe-fetch';
import { stripPromptInjection } from '../../src/utils/prompt-injection';
import { withLambda } from '@netlify/aws-lambda-compat';

const R2_ENDPOINT          = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET            = process.env.R2_BUCKET_NAME;
const r2Configured = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

// Matches MAX_BODY_CHARS in inspo-items.ts — the DB column is free text, but a runaway
// scrape shouldn't turn into thousands of chunks.
const MAX_BODY_CHARS = 50_000;

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
}

/** Readable text from an HTML document — nav/script/style junk removed. */
function extractHtmlText(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, img, svg, nav, footer').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    let inspoItemId: number | undefined;
    try {
        inspoItemId = Number(JSON.parse(event.body || '{}').inspoItemId);
    } catch {
        return { statusCode: 400, body: 'Invalid JSON' };
    }
    if (!Number.isInteger(inspoItemId)) return { statusCode: 400, body: 'Missing inspoItemId' };

    const [item] = await db.select().from(inspoItems).where(eq(inspoItems.id, inspoItemId)).limit(1);
    if (!item) return { statusCode: 404, body: 'Inspo item not found' };

    let body = '';
    let ingestStatus: 'ready' | 'unsupported' | 'failed' = 'ready';

    try {
        if (item.kind === 'url' && item.sourceUrl) {
            const fetched = await safeFetchText(item.sourceUrl);
            // A link to a PDF/image is legitimate; we just have no text for the non-HTML ones.
            if (fetched.contentType.includes('html') || fetched.contentType.includes('xml')) {
                body = extractHtmlText(fetched.body);
            } else if (fetched.contentType.startsWith('text/')) {
                body = fetched.body.replace(/\s+/g, ' ').trim();
            } else {
                ingestStatus = 'unsupported';
            }
        } else if (item.kind === 'file' && item.workspaceAssetId) {
            const [asset] = await db
                .select()
                .from(workspaceAssets)
                .where(and(
                    eq(workspaceAssets.id, item.workspaceAssetId),
                    // Tenant scope: the worker is triggered internally, but reading an asset
                    // by id without checking the org would be a cross-tenant read waiting to
                    // happen the first time an id is ever attacker-influenced.
                    eq(workspaceAssets.organisationId, item.organisationId),
                ))
                .limit(1);
            if (!asset) throw new Error('Linked asset not found for this organisation.');

            const fname = (asset.name || asset.originalFilename || '').toLowerCase();
            const mime = (asset.mimeType || '').toLowerCase();
            const isPdf = mime.includes('pdf') || fname.endsWith('.pdf');
            const isText = mime.startsWith('text/') || fname.endsWith('.txt') || fname.endsWith('.md');

            if (!isPdf && !isText) {
                // Images and video: see the header note. The user's note carries these.
                ingestStatus = 'unsupported';
            } else if (!r2Configured || !asset.r2Key) {
                throw new Error('Object storage (R2) is not configured — cannot read the file.');
            } else {
                const s3 = getR2Client();
                const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key }));
                const buffer = Buffer.from(await obj.Body!.transformToByteArray());
                if (isPdf) {
                    const parser = new PDFParse({ data: buffer });
                    try { body = (await parser.getText()).text.replace(/\s+/g, ' ').trim(); }
                    finally { await parser.destroy(); }
                } else {
                    body = buffer.toString('utf-8').trim();
                }
            }
        } else {
            throw new Error(`Nothing to extract for kind '${item.kind}'.`);
        }

        // Untrusted third-party content — strip instruction-injection attempts before this
        // can ever reach a prompt. The structural INSPO START/END boundary at generation
        // time is the primary defence; this removes attempts to break out of it.
        if (body) body = stripPromptInjection(body).slice(0, MAX_BODY_CHARS);
        if (ingestStatus === 'ready' && !body) ingestStatus = 'unsupported';
    } catch (err) {
        // A SafeFetchError carries a message written for the user (bad scheme, private
        // address, too large); anything else is ours and stays in the logs.
        const detail = err instanceof SafeFetchError ? `${err.reason}: ${err.message}` : String(err);
        console.error(`[process-inspo-background] extraction failed for item ${inspoItemId}:`, detail);
        await db.update(inspoItems)
            .set({ ingestStatus: 'failed', embeddingStatus: 'failed', updatedAt: new Date() })
            .where(eq(inspoItems.id, inspoItemId));
        return { statusCode: 200, body: 'Extraction failed — item marked failed.' };
    }

    // ── Chunk + embed (mirrors ingestItem in inspo-items.ts) ────────────────
    // Embed body when we got one; otherwise the user's note is the only signal there is
    // (unsupported kinds), so embed that rather than leaving the item unretrievable.
    const source = (body || item.userNote || '').trim();
    const chunks = source ? chunkArticle(source) : [];

    let vectors: number[][] | null = null;
    let embeddingStatus = embeddingsConfigured() ? 'embedded' : 'keyword_only';
    if (chunks.length > 0 && embeddingsConfigured()) {
        try {
            vectors = await embedTexts(chunks, 'document');
        } catch (err) {
            console.error(`[process-inspo-background] embedding failed for item ${inspoItemId}:`, err);
            embeddingStatus = 'failed';
        }
    }

    await db.transaction(async (tx) => {
        await tx.delete(inspoChunks).where(eq(inspoChunks.inspoItemId, item.id));
        await tx.delete(vectorEmbeddings).where(and(
            eq(vectorEmbeddings.sourceType, 'inspo_item'),
            eq(vectorEmbeddings.sourceId, item.id),
        ));

        for (let i = 0; i < chunks.length; i++) {
            const [row] = await tx.insert(inspoChunks).values({
                inspoItemId: item.id,
                organisationId: item.organisationId,
                aiAssistantId: item.aiAssistantId,
                chunkIndex: i,
                content: chunks[i],
                embedding: vectors ? vectors[i] : null,
            }).returning({ id: inspoChunks.id });

            // GDPR deletion map (US-GDPR-2.2.2) — one row per chunk in the vector store.
            if (vectors) {
                await tx.insert(vectorEmbeddings).values({
                    sourceType: 'inspo_item',
                    sourceId: item.id,
                    vectorStoreId: String(row.id),
                    userId: item.createdBy,
                    organisationId: item.organisationId,
                });
            }
        }

        await tx.update(inspoItems).set({
            body: body || null,
            ingestStatus,
            embeddingStatus,
            chunkCount: chunks.length,
            updatedAt: new Date(),
        }).where(eq(inspoItems.id, item.id));
    });

    return { statusCode: 200, body: 'Inspo item processed.' };
});
