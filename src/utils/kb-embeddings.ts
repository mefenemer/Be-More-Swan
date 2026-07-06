// src/utils/kb-embeddings.ts
// Embedding + chunking helpers for the Knowledge Base phase (kb_articles / kb_chunks).
//
// Anthropic has no embeddings endpoint, so vectors come from Voyage AI (Anthropic's
// recommended embeddings partner) via plain fetch — set VOYAGE_API_KEY to enable.
// Without the key every function degrades gracefully: embedTexts() returns null,
// ingestion stores chunks with a NULL embedding, and retrieval falls back to the
// Postgres full-text index on kb_chunks.content_tsv (db/kb-articles.sql).
//
// Model + dimensions are pinned together: kb_chunks.embedding is vector(1024) and
// the HNSW index assumes cosine distance, so changing EMBEDDING_MODEL to one with a
// different output size needs a migration and a re-embed of every article.

export const EMBEDDING_MODEL = 'voyage-3.5-lite';
export const EMBEDDING_DIMENSIONS = 1024;

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
// Voyage caps batch size at 128 inputs; our callers stay far below it.
const MAX_BATCH = 128;

/** True when an embedding provider is configured (VOYAGE_API_KEY present). */
export function embeddingsConfigured(): boolean {
    return !!process.env.VOYAGE_API_KEY;
}

/**
 * Embed a batch of texts. `inputType` lets Voyage optimise asymmetric retrieval:
 * 'document' at ingestion time, 'query' at search time.
 *
 * Returns null when no provider is configured (callers fall back to full-text
 * search); throws on provider errors so ingestion can mark the article 'failed'.
 */
export async function embedTexts(texts: string[], inputType: 'document' | 'query'): Promise<number[][] | null> {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) return null;
    if (texts.length === 0) return [];
    if (texts.length > MAX_BATCH) throw new Error(`embedTexts: batch too large (${texts.length} > ${MAX_BATCH})`);

    const res = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL, input_type: inputType }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Voyage embeddings request failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const payload = await res.json() as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
        throw new Error('Voyage embeddings response shape unexpected.');
    }
    // The API documents data[] as input-ordered; sort by index to be safe.
    return [...payload.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Chunking targets ~1200 chars (≈300 tokens) per retrieval unit — big enough to hold
// a whole policy answer, small enough that 5 injected chunks stay cheap.
const CHUNK_TARGET_CHARS = 1200;
const CHUNK_MAX_CHARS = 1600;

/**
 * Split article content into retrieval chunks on paragraph boundaries, packing
 * consecutive paragraphs up to the target size. A single oversized paragraph is
 * hard-split at sentence-ish boundaries so no chunk exceeds CHUNK_MAX_CHARS.
 */
export function chunkArticle(content: string): string[] {
    const paragraphs = content
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .flatMap((p) => (p.length <= CHUNK_MAX_CHARS ? [p] : splitLongParagraph(p)));

    const chunks: string[] = [];
    let current = '';
    for (const p of paragraphs) {
        if (current && current.length + p.length + 2 > CHUNK_TARGET_CHARS) {
            chunks.push(current);
            current = p;
        } else {
            current = current ? `${current}\n\n${p}` : p;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function splitLongParagraph(paragraph: string): string[] {
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    const parts: string[] = [];
    let current = '';
    for (const s of sentences) {
        if (current && current.length + s.length + 1 > CHUNK_MAX_CHARS) {
            parts.push(current);
            current = s;
        } else {
            current = current ? `${current} ${s}` : s;
        }
        // A single "sentence" longer than the cap (no punctuation) gets hard-cut.
        while (current.length > CHUNK_MAX_CHARS) {
            parts.push(current.slice(0, CHUNK_MAX_CHARS));
            current = current.slice(CHUNK_MAX_CHARS);
        }
    }
    if (current) parts.push(current);
    return parts;
}
