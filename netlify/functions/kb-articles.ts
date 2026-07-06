// netlify/functions/kb-articles.ts
// Knowledge Base API — CRUD + embeddings ingestion for kb_articles / kb_chunks, the
// support knowledge behind the Knowledge Base tab on assistant-detail.html and the
// retrieval grounding for the tier1_support_agent route (chat-orchestrator.ts).
//
//  GET    ?assistantId=<id>            → { articles: [...] } (content preview only)
//  GET    ?id=<id>                     → { article } (full content, for editing)
//  POST   { assistantId, title, content, source? }  → create + chunk + embed
//  PUT    { id, title?, content? }     → update; content changes re-chunk + re-embed
//  DELETE { id }                       → remove article, its chunks and GDPR map rows
//
// Ingestion: content is chunked (src/utils/kb-embeddings.ts) and embedded via Voyage
// when VOYAGE_API_KEY is set; without it chunks are stored embedding-less and retrieval
// uses the full-text index (embedding_status 'keyword_only'). Per US-GDPR-2.2.2 every
// embedded chunk gets a vector_embeddings map row (sourceType 'kb_article') in the same
// transaction, so erasure jobs can find and delete the vectors.
//
// Auth: aura_session + requireTenant; every query is tenant-scoped and the assistant
// is ownership-checked (IDOR guard), mirroring assistant-records.ts.

import { Handler } from '@netlify/functions';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, kbArticles, kbChunks, vectorEmbeddings } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { chunkArticle, embedTexts, embeddingsConfigured } from '../../src/utils/kb-embeddings';

const SOURCES = new Set(['manual', 'file_upload']);
const MAX_TITLE_CHARS = 300;
// Big enough for a long policy doc; a bigger corpus should be split into articles.
const MAX_CONTENT_CHARS = 50_000;
// Per-assistant article ceiling — keeps ingestion and the tab listing bounded.
const MAX_ARTICLES = 200;
const PREVIEW_CHARS = 240;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Re-chunk and re-embed one article's content, replacing any existing chunks and
 * their GDPR map rows. Returns the resulting embedding status + chunk count.
 * Embedding failures degrade, never throw: chunks are kept embedding-less (the
 * full-text fallback still works) and the article is marked 'failed' for the UI.
 */
async function ingestArticle(
    db: ReturnType<typeof getDb>,
    article: { id: number; organisationId: number; aiAssistantId: number; content: string },
    userId: number,
): Promise<{ embeddingStatus: string; chunkCount: number }> {
    const chunks = chunkArticle(article.content);

    let vectors: number[][] | null = null;
    let embeddingStatus = embeddingsConfigured() ? 'embedded' : 'keyword_only';
    if (chunks.length > 0 && embeddingsConfigured()) {
        try {
            vectors = await embedTexts(chunks, 'document');
        } catch (err) {
            console.error(`[kb-articles] embedding failed for article ${article.id}:`, err);
            embeddingStatus = 'failed';
        }
    }

    await db.transaction(async (tx) => {
        // Replace: old chunks and their vector-store map rows go together.
        await tx.delete(kbChunks).where(eq(kbChunks.kbArticleId, article.id));
        await tx.delete(vectorEmbeddings).where(and(
            eq(vectorEmbeddings.sourceType, 'kb_article'),
            eq(vectorEmbeddings.sourceId, article.id),
        ));

        for (let i = 0; i < chunks.length; i++) {
            const [row] = await tx.insert(kbChunks).values({
                kbArticleId: article.id,
                organisationId: article.organisationId,
                aiAssistantId: article.aiAssistantId,
                chunkIndex: i,
                content: chunks[i],
                embedding: vectors ? vectors[i] : null,
            }).returning({ id: kbChunks.id });

            // GDPR deletion map (US-GDPR-2.2.2) — one row per chunk in the vector store.
            if (vectors) {
                await tx.insert(vectorEmbeddings).values({
                    sourceType: 'kb_article',
                    sourceId: article.id,
                    vectorStoreId: String(row.id),
                    userId,
                    organisationId: article.organisationId,
                });
            }
        }

        await tx.update(kbArticles)
            .set({ embeddingStatus, chunkCount: chunks.length, updatedAt: new Date() })
            .where(eq(kbArticles.id, article.id));
    });

    return { embeddingStatus, chunkCount: chunks.length };
}

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    /** IDOR guard — the assistant must belong to the caller's org. */
    async function ownsAssistant(assistantId: number): Promise<boolean> {
        if (!Number.isInteger(assistantId)) return false;
        const [row] = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        return !!row;
    }

    /** Tenant-scoped article fetch. */
    async function getArticle(id: number) {
        if (!Number.isInteger(id)) return undefined;
        const [row] = await db
            .select()
            .from(kbArticles)
            .where(and(eq(kbArticles.id, id), eq(kbArticles.organisationId, orgId)))
            .limit(1);
        return row;
    }

    try {
        if (event.httpMethod === 'GET') {
            // Single article (full content) for the edit form.
            if (event.queryStringParameters?.id) {
                const article = await getArticle(Number(event.queryStringParameters.id));
                if (!article) return json(404, { error: 'Article not found.' });
                return json(200, { article });
            }

            const assistantId = Number(event.queryStringParameters?.assistantId);
            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            const rows = await db
                .select()
                .from(kbArticles)
                .where(and(eq(kbArticles.organisationId, orgId), eq(kbArticles.aiAssistantId, assistantId)))
                .orderBy(desc(kbArticles.updatedAt), asc(kbArticles.id));

            return json(200, {
                embeddingsConfigured: embeddingsConfigured(),
                articles: rows.map((a) => ({
                    id: a.id,
                    title: a.title,
                    preview: a.content.length > PREVIEW_CHARS ? `${a.content.slice(0, PREVIEW_CHARS)}…` : a.content,
                    contentChars: a.content.length,
                    source: a.source,
                    embeddingStatus: a.embeddingStatus,
                    chunkCount: a.chunkCount,
                    createdAt: a.createdAt,
                    updatedAt: a.updatedAt,
                })),
            });
        }

        if (event.httpMethod === 'POST') {
            let body: { assistantId?: number; title?: string; content?: string; source?: string };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const assistantId = Number(body.assistantId);
            const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_CHARS) : '';
            const content = typeof body.content === 'string' ? body.content.trim() : '';
            const source = SOURCES.has(String(body.source)) ? String(body.source) : 'manual';
            if (!title) return json(400, { error: 'title is required.' });
            if (!content) return json(400, { error: 'content is required.' });
            if (content.length > MAX_CONTENT_CHARS) return json(400, { error: `Article too long (max ${MAX_CONTENT_CHARS.toLocaleString()} characters) — split it into smaller articles.` });
            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            const existing = await db
                .select({ id: kbArticles.id })
                .from(kbArticles)
                .where(and(eq(kbArticles.organisationId, orgId), eq(kbArticles.aiAssistantId, assistantId)));
            if (existing.length >= MAX_ARTICLES) return json(400, { error: `Knowledge base is full (max ${MAX_ARTICLES} articles).` });

            const [article] = await db.insert(kbArticles).values({
                organisationId: orgId,
                aiAssistantId: assistantId,
                title,
                content,
                source,
                createdBy: userId,
            }).returning();

            const result = await ingestArticle(db, article, userId);
            return json(200, { article: { id: article.id, title, ...result } });
        }

        if (event.httpMethod === 'PUT') {
            let body: { id?: number; title?: string; content?: string };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const article = await getArticle(Number(body.id));
            if (!article) return json(404, { error: 'Article not found.' });

            const patch: { title?: string; content?: string; updatedAt: Date } = { updatedAt: new Date() };
            if (body.title !== undefined) {
                const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_CHARS) : '';
                if (!title) return json(400, { error: 'title cannot be empty.' });
                patch.title = title;
            }
            let reingest = false;
            if (body.content !== undefined) {
                const content = typeof body.content === 'string' ? body.content.trim() : '';
                if (!content) return json(400, { error: 'content cannot be empty.' });
                if (content.length > MAX_CONTENT_CHARS) return json(400, { error: `Article too long (max ${MAX_CONTENT_CHARS.toLocaleString()} characters) — split it into smaller articles.` });
                reingest = content !== article.content;
                patch.content = content;
            }

            await db.update(kbArticles).set(patch).where(eq(kbArticles.id, article.id));

            let result = { embeddingStatus: article.embeddingStatus, chunkCount: article.chunkCount };
            if (reingest) {
                result = await ingestArticle(db, { ...article, content: patch.content! }, userId);
            }
            return json(200, { article: { id: article.id, title: patch.title ?? article.title, ...result } });
        }

        if (event.httpMethod === 'DELETE') {
            let body: { id?: number };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const article = await getArticle(Number(body.id));
            if (!article) return json(404, { error: 'Article not found.' });

            await db.transaction(async (tx) => {
                // Chunks cascade off the article; the GDPR map rows need explicit cleanup.
                await tx.delete(vectorEmbeddings).where(and(
                    eq(vectorEmbeddings.sourceType, 'kb_article'),
                    eq(vectorEmbeddings.sourceId, article.id),
                ));
                await tx.delete(kbArticles).where(eq(kbArticles.id, article.id));
            });
            return json(200, { deleted: article.id });
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (err) {
        // Table not migrated yet (db/kb-articles.sql) — an empty KB beats a 500 on GET.
        const msg = err instanceof Error ? err.message : '';
        if (event.httpMethod === 'GET' && msg.includes('relation') && msg.includes('does not exist')) {
            return json(200, { embeddingsConfigured: embeddingsConfigured(), articles: [] });
        }
        console.error('[kb-articles]', err);
        return json(500, { error: 'Failed to process the request.' });
    }
};
