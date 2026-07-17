// netlify/functions/inspo-items.ts
// Inspo API — CRUD + embeddings ingestion for inspo_items / inspo_chunks, the
// inspiration material behind the Inspo tab on assistant-detail.html for the
// content roles (social_media_manager, blog_writer).
//
//  GET    ?assistantId=<id>   → { items: [...] } (note/body previews only)
//  GET    ?id=<id>            → { item } (full body, for editing)
//  POST   { assistantId, kind, body, title?, userNote? }  → create + chunk + embed
//  PUT    { id, title?, body?, userNote?, isActive? }     → update; body changes re-ingest
//  DELETE { id }              → remove item, its chunks and GDPR map rows
//
// Kinds:
//   'text'/'voice' → the body IS the input (voice is transcribed client-side by the Web
//                    Speech recogniser, so the server only ever sees text). Chunked+embedded
//                    inline here; ready the moment the request returns.
//   'url'/'file'   → nothing to embed yet. The row lands 'pending' and
//                    process-inspo-background.ts fetches/reads, extracts, chunks and embeds.
//
// Ingestion mirrors kb-articles.ts: body is chunked (src/utils/kb-embeddings.ts) and
// embedded via Voyage when VOYAGE_API_KEY is set; without it chunks are stored
// embedding-less and retrieval falls back to the full-text index
// (embedding_status 'keyword_only'). Per US-GDPR-2.2.2 every embedded chunk gets a
// vector_embeddings map row (sourceType 'inspo_item') in the same transaction.
//
// Auth: aura_session + requireTenant; every query is tenant-scoped and the assistant
// is ownership-checked (IDOR guard), mirroring kb-articles.ts.

import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, inspoItems, inspoChunks, inspoStyleProfiles, vectorEmbeddings, workspaceAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { chunkArticle, embedTexts, embeddingsConfigured } from '../../src/utils/kb-embeddings';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

const WRITABLE_KINDS = new Set(['text', 'voice', 'url', 'file']);
// Kinds whose text is already in hand — everything else needs the extraction worker.
const INLINE_KINDS = new Set(['text', 'voice']);
const MAX_TITLE_CHARS = 300;
// The user's "what I like about this" note — a paragraph of guidance, not an essay.
const MAX_NOTE_CHARS = 2_000;
const MAX_BODY_CHARS = 50_000;
// Per-assistant ceiling. Note this bounds STORAGE, not prompt size — prompt cost is
// already flat in item count by design (distilled profile + top-K retrieval).
const MAX_ITEMS = 200;
const PREVIEW_CHARS = 240;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function preview(value: string | null): string {
    const s = (value || '').trim();
    return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
}

/**
 * AC6: the distilled style profile is a CACHE of the library, so ANY mutation to an
 * item — create, edit, deactivate, delete — can make it wrong. Dropping the row is the
 * safe invalidation: the next generation recompiles from the current active set, and
 * no stale profile can ever be used in the meantime. Deliberately written before the
 * compiler exists (it's a no-op until then) so phase 4 cannot ship this hole.
 */
async function invalidateStyleProfile(db: ReturnType<typeof getDb>, assistantId: number): Promise<void> {
    await db.delete(inspoStyleProfiles).where(eq(inspoStyleProfiles.aiAssistantId, assistantId));
}

/**
 * Re-chunk and re-embed one item, replacing existing chunks and their GDPR map rows.
 * Embedding failures degrade, never throw: chunks are kept embedding-less (the
 * full-text fallback still works) and the item is marked 'failed' for the UI.
 *
 * We embed `body ?? userNote`: for a typed/voice item the body IS the idea, and for a
 * kind we can't extract (video — nothing in the stack watches an mp4) the user's note
 * is the only signal there is, so it should still be retrievable.
 */
async function ingestItem(
    db: ReturnType<typeof getDb>,
    item: { id: number; organisationId: number; aiAssistantId: number; body: string | null; userNote: string | null },
    userId: number,
): Promise<{ embeddingStatus: string; chunkCount: number }> {
    const source = (item.body || item.userNote || '').trim();
    const chunks = source ? chunkArticle(source) : [];

    let vectors: number[][] | null = null;
    let embeddingStatus = embeddingsConfigured() ? 'embedded' : 'keyword_only';
    if (chunks.length > 0 && embeddingsConfigured()) {
        try {
            vectors = await embedTexts(chunks, 'document');
        } catch (err) {
            console.error(`[inspo-items] embedding failed for item ${item.id}:`, err);
            embeddingStatus = 'failed';
        }
    }

    await db.transaction(async (tx) => {
        // Replace: old chunks and their vector-store map rows go together.
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
                    userId,
                    organisationId: item.organisationId,
                });
            }
        }

        await tx.update(inspoItems)
            .set({ embeddingStatus, chunkCount: chunks.length, updatedAt: new Date() })
            .where(eq(inspoItems.id, item.id));
    });

    return { embeddingStatus, chunkCount: chunks.length };
}

/** A quick note needs no title — derive a readable one from its first line. */
function deriveTitle(body: string): string {
    const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || 'Untitled note';
    return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
}

/**
 * Kick off extraction for a url/file item.
 *
 * MUST be awaited: on Lambda the runtime freezes the moment the handler returns, so an
 * un-awaited fetch is frozen mid-flight and never reaches the worker — the item would sit
 * 'pending' forever and the tab would show a spinner that never resolves. Posting to a
 * -background function returns 202 before the work runs, so the await only costs the trigger
 * round-trip; the AbortController caps a stalled one. (Same trap as `0cd64e7`.)
 */
async function triggerExtraction(headers: Record<string, string | undefined>, inspoItemId: number): Promise<void> {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) {
        console.error('[inspo-items] Could not resolve base URL — extraction not triggered for item', inspoItemId);
        return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await fetch(`${baseUrl}/.netlify/functions/process-inspo-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inspoItemId }),
            signal: controller.signal,
        });
    } catch (err) {
        console.error('[inspo-items] Failed to trigger extraction:', err);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Validate a user-supplied inspo URL at save time.
 *
 * Deliberately shape-only — no network. The real SSRF enforcement happens in safeFetchText()
 * inside the worker, at connect time, where it can't be raced by DNS. Checking here is purely
 * so an obviously-bad link fails in the composer with a clear message rather than silently
 * turning into a 'failed' card a minute later.
 */
function validateInspoUrl(raw: string): { url: string } | { error: string } {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return { error: "That doesn't look like a valid link." }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'Only http and https links can be added.' };
    }
    if (parsed.username || parsed.password) {
        return { error: 'Links with embedded credentials are not supported.' };
    }
    // Google Docs links are login walls, not documents: fetching one returns a sign-in page,
    // which would ingest as garbage and quietly teach the assistant nothing. Real support
    // needs Drive OAuth (out of scope) — so say so plainly instead of failing mysteriously.
    if (/(^|\.)docs\.google\.com$/i.test(parsed.hostname)) {
        return { error: 'Google Docs links need sign-in, so we can\'t read them. Download the doc and upload the file instead.' };
    }
    return { url: parsed.toString() };
}

export default withLambda(async (event) => {
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

    /** Tenant-scoped item fetch. */
    async function getItem(id: number) {
        if (!Number.isInteger(id)) return undefined;
        const [row] = await db
            .select()
            .from(inspoItems)
            .where(and(eq(inspoItems.id, id), eq(inspoItems.organisationId, orgId)))
            .limit(1);
        return row;
    }

    try {
        if (event.httpMethod === 'GET') {
            // Single item (full body) for the edit form.
            if (event.queryStringParameters?.id) {
                const item = await getItem(Number(event.queryStringParameters.id));
                if (!item) return json(404, { error: 'Inspo item not found.' });
                return json(200, { item });
            }

            const assistantId = Number(event.queryStringParameters?.assistantId);
            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            const rows = await db
                .select()
                .from(inspoItems)
                .where(and(eq(inspoItems.organisationId, orgId), eq(inspoItems.aiAssistantId, assistantId)))
                .orderBy(desc(inspoItems.updatedAt), asc(inspoItems.id));

            return json(200, {
                embeddingsConfigured: embeddingsConfigured(),
                items: rows.map((i) => ({
                    id: i.id,
                    kind: i.kind,
                    title: i.title,
                    sourceUrl: i.sourceUrl,
                    notePreview: preview(i.userNote),
                    bodyPreview: preview(i.body),
                    isActive: i.isActive,
                    ingestStatus: i.ingestStatus,
                    embeddingStatus: i.embeddingStatus,
                    chunkCount: i.chunkCount,
                    createdAt: i.createdAt,
                    updatedAt: i.updatedAt,
                })),
            });
        }

        if (event.httpMethod === 'POST') {
            let body: {
                assistantId?: number; kind?: string; title?: string; body?: string;
                userNote?: string; sourceUrl?: string; workspaceAssetId?: number;
            };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const assistantId = Number(body.assistantId);
            const kind = String(body.kind || 'text');
            if (!WRITABLE_KINDS.has(kind)) return json(400, { error: 'Unsupported inspo type.' });

            const userNote = typeof body.userNote === 'string' ? body.userNote.trim().slice(0, MAX_NOTE_CHARS) : '';
            const inline = INLINE_KINDS.has(kind);

            // Per-kind payload validation. Everything below assumes these hold.
            let text = '';
            let sourceUrl: string | null = null;
            let workspaceAssetId: number | null = null;

            if (inline) {
                text = typeof body.body === 'string' ? body.body.trim() : '';
                if (!text) return json(400, { error: 'Add some text before saving.' });
                if (text.length > MAX_BODY_CHARS) {
                    return json(400, { error: `That's too long (max ${MAX_BODY_CHARS.toLocaleString()} characters) — split it into separate notes.` });
                }
            } else if (kind === 'url') {
                const checked = validateInspoUrl(typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '');
                if ('error' in checked) return json(400, { error: checked.error });
                sourceUrl = checked.url;
            } else if (kind === 'file') {
                workspaceAssetId = Number(body.workspaceAssetId);
                if (!Number.isInteger(workspaceAssetId)) return json(400, { error: 'Upload the file first.' });
            }

            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            // IDOR: the asset id comes from the client, so confirm it's this org's before
            // linking it — otherwise a guessed id would attach (and later extract) another
            // tenant's file into this assistant's Inspo.
            if (kind === 'file') {
                const [asset] = await db
                    .select({ id: workspaceAssets.id, name: workspaceAssets.name })
                    .from(workspaceAssets)
                    .where(and(eq(workspaceAssets.id, workspaceAssetId!), eq(workspaceAssets.organisationId, orgId)))
                    .limit(1);
                if (!asset) return json(404, { error: 'File not found.' });
                if (!body.title && asset.name) body.title = asset.name;
            }

            const title = (typeof body.title === 'string' && body.title.trim())
                ? body.title.trim().slice(0, MAX_TITLE_CHARS)
                : (inline ? deriveTitle(text) : (sourceUrl ? new URL(sourceUrl).hostname : 'Uploaded file'));

            const existing = await db
                .select({ id: inspoItems.id })
                .from(inspoItems)
                .where(and(eq(inspoItems.organisationId, orgId), eq(inspoItems.aiAssistantId, assistantId)));
            if (existing.length >= MAX_ITEMS) {
                return json(400, { error: `Your Inspo library is full (max ${MAX_ITEMS} items). Delete a few to add more.` });
            }

            const [item] = await db.insert(inspoItems).values({
                organisationId: orgId,
                aiAssistantId: assistantId,
                kind,
                title,
                sourceUrl,
                workspaceAssetId,
                userNote: userNote || null,
                body: inline ? text : null,
                // Typed/voice arrive usable; url/file wait on the worker.
                ingestStatus: inline ? 'ready' : 'pending',
                createdBy: userId,
            }).returning();

            let result: { embeddingStatus: string; chunkCount: number } = { embeddingStatus: 'pending', chunkCount: 0 };
            if (inline) {
                result = await ingestItem(db, item, userId);
            } else {
                await triggerExtraction(event.headers as Record<string, string | undefined>, item.id);
            }
            await invalidateStyleProfile(db, assistantId);
            return json(200, { item: { id: item.id, title, kind, ingestStatus: item.ingestStatus, ...result } });
        }

        if (event.httpMethod === 'PUT') {
            let body: { id?: number; title?: string; body?: string; userNote?: string; isActive?: boolean };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const item = await getItem(Number(body.id));
            if (!item) return json(404, { error: 'Inspo item not found.' });

            const patch: { title?: string; body?: string; userNote?: string | null; isActive?: boolean; updatedAt: Date } =
                { updatedAt: new Date() };

            if (body.title !== undefined) {
                const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_CHARS) : '';
                if (!title) return json(400, { error: 'Give the item a title.' });
                patch.title = title;
            }
            if (body.userNote !== undefined) {
                const note = typeof body.userNote === 'string' ? body.userNote.trim().slice(0, MAX_NOTE_CHARS) : '';
                patch.userNote = note || null;
            }
            let reingest = false;
            if (body.body !== undefined) {
                const text = typeof body.body === 'string' ? body.body.trim() : '';
                if (!text) return json(400, { error: 'The note needs some text.' });
                if (text.length > MAX_BODY_CHARS) {
                    return json(400, { error: `That's too long (max ${MAX_BODY_CHARS.toLocaleString()} characters) — split it into separate notes.` });
                }
                reingest = text !== item.body;
                patch.body = text;
            }
            if (body.isActive !== undefined) patch.isActive = !!body.isActive;

            await db.update(inspoItems).set(patch).where(eq(inspoItems.id, item.id));

            let result = { embeddingStatus: item.embeddingStatus, chunkCount: item.chunkCount };
            if (reingest) {
                result = await ingestItem(db, { ...item, body: patch.body!, userNote: patch.userNote ?? item.userNote }, userId);
            }
            // Any edit can change what the profile should say — including a pure
            // isActive toggle, which is exactly AC6's "stop considering this item".
            await invalidateStyleProfile(db, item.aiAssistantId);

            return json(200, {
                item: {
                    id: item.id,
                    title: patch.title ?? item.title,
                    isActive: patch.isActive ?? item.isActive,
                    ...result,
                },
            });
        }

        if (event.httpMethod === 'DELETE') {
            let body: { id?: number };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const item = await getItem(Number(body.id));
            if (!item) return json(404, { error: 'Inspo item not found.' });

            await db.transaction(async (tx) => {
                // Chunks cascade off the item; the GDPR map rows need explicit cleanup.
                await tx.delete(vectorEmbeddings).where(and(
                    eq(vectorEmbeddings.sourceType, 'inspo_item'),
                    eq(vectorEmbeddings.sourceId, item.id),
                ));
                await tx.delete(inspoItems).where(eq(inspoItems.id, item.id));
            });
            await invalidateStyleProfile(db, item.aiAssistantId);

            return json(200, { deleted: item.id });
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (err) {
        // Table not migrated yet (db/inspo-items.sql) — an empty tab beats a 500 on GET.
        const msg = err instanceof Error ? err.message : '';
        if (event.httpMethod === 'GET' && msg.includes('relation') && msg.includes('does not exist')) {
            return json(200, { embeddingsConfigured: embeddingsConfigured(), items: [] });
        }
        console.error('[inspo-items]', err);
        return json(500, { error: 'Failed to process the request.' });
    }
});
