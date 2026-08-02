// src/utils/account-memory.ts
// The long-term semantic memory tier — everything ever said about an account. Phase 3, plan §5.3.
//
// The ONE writer of account_memory, because of the GDPR invariant below: it holds only if there is
// a single implementation of it.
//
// ── ⚠️ THE GDPR PAIRING ──────────────────────────────────────────────────────
// Every embedded row MUST be accompanied by a vector_embeddings row with source_type
// 'account_memory'. That map is the ONLY registration of these vectors. The insert and the map row
// go in ONE TRANSACTION — a memory row committed without its map row is an unregistered vector,
// and there is no way to find it afterwards to prove it was erased.
//
// Worth knowing when auditing: the plan claims the erasure paths "already read that table". They do
// not read it by source_type. src/utils/gdpr-asset-purge.ts is the only reader, it is scoped to
// workspace assets, and until 2026-08-02 it deleted by source_id ALONE — which would have destroyed
// these rows on any unrelated erasure (see src/config/vector-sources.ts). What actually protects
// this data today is ON DELETE CASCADE from organisations. Both should hold; write the map row
// anyway, because the cascade only covers whole-org deletion and the map is what a per-subject
// erasure will need.
//
// ── Best-effort by contract ──────────────────────────────────────────────────
// Writes resolve to null on failure and never throw. Memory is an observer: failing to remember
// something must not fail the send, the reply or the discovery run that produced it.
// Reads return [] and log — a memory-less answer is degraded, not broken.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { accountMemory, vectorEmbeddings } from '../../db/schema';
import { embedTexts, embeddingsConfigured } from './kb-embeddings';
import {
    DEFAULT_MEMORY_TOP_K, MAX_MEMORY_CHARS, MAX_MEMORY_TOP_K,
    isMemorySourceType, type MemorySourceType,
} from '../config/account-graph';
import type { VectorSourceType } from '../config/vector-sources';

type Db = ReturnType<typeof getDb>;

/** The source_type this module registers in vector_embeddings. Named once, used everywhere. */
const VECTOR_SOURCE: VectorSourceType = 'account_memory';

export interface MemoryInput {
    organisationId: number;
    accountNodeId?: number | null;
    sourceType: MemorySourceType;
    /** The id in whichever table sourceType names. Drives the ingestion idempotency key. */
    sourceId?: number | null;
    content: string;
    occurredAt: Date;
}

/**
 * Write one memory row, embedding it when a provider is configured.
 *
 * Returns the row id, or null when skipped (empty content, duplicate source row) or failed.
 * A duplicate is the COMMON case, not an error: the ingestion worker re-scans the same source
 * tables every tick and account_memory_source_uidx is what stops it re-embedding them.
 */
export async function writeMemory(db: Db, input: MemoryInput): Promise<number | null> {
    const rows = await writeMemories(db, [input]);
    return rows[0] ?? null;
}

/**
 * Batch form — ONE embedding request for many rows.
 *
 * The batch exists for cost, not speed: Voyage bills per token but the per-request overhead is
 * real, and the ingestion worker would otherwise make forty round trips per tick.
 */
export async function writeMemories(db: Db, inputs: MemoryInput[]): Promise<Array<number | null>> {
    if (!inputs.length) return [];

    const prepared = inputs.map((i) => ({
        ...i,
        content: String(i.content ?? '').trim().slice(0, MAX_MEMORY_CHARS),
    })).filter((i) => i.content && isMemorySourceType(i.sourceType) && Number.isInteger(i.organisationId));

    if (!prepared.length) return inputs.map(() => null);

    // Embed first, outside the transaction. A provider call inside a transaction holds the
    // connection open for the whole HTTP round trip; on a pooled Neon connection that is how a
    // slow provider turns into pool exhaustion for everything else.
    let vectors: number[][] | null = null;
    if (embeddingsConfigured()) {
        try {
            vectors = await embedTexts(prepared.map((p) => p.content), 'document');
        } catch (err) {
            // Store unembedded rather than losing the memory. Retrieval falls back to full-text
            // search, which is degraded but real — and a later backfill can fill the vector in.
            console.error('[account-memory] embedding failed, storing without vectors', err);
            vectors = null;
        }
    }

    const results: Array<number | null> = [];
    for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        const vector = vectors ? vectors[i] : null;
        try {
            // ⚠️ ONE TRANSACTION. A memory row committed without its map row is an unregistered
            // vector — invisible to any future erasure audit. Do not split these.
            const id = await db.transaction(async (tx) => {
                const [row] = await tx.insert(accountMemory).values({
                    organisationId: p.organisationId,
                    accountNodeId: p.accountNodeId ?? null,
                    sourceType: p.sourceType,
                    sourceId: p.sourceId ?? null,
                    content: p.content,
                    embedding: vector,
                    occurredAt: p.occurredAt,
                }).onConflictDoNothing().returning({ id: accountMemory.id });

                if (!row) return null;   // already ingested — the idempotency index did its job

                if (vector) {
                    await tx.insert(vectorEmbeddings).values({
                        sourceType: VECTOR_SOURCE,
                        sourceId: row.id,
                        vectorStoreId: `account_memory:${row.id}`,
                        organisationId: p.organisationId,
                    });
                }
                return row.id;
            });
            results.push(id);
        } catch (err) {
            logQuietly('writeMemories', err);
            results.push(null);
        }
    }
    return results;
}

export interface MemoryHit {
    id: number;
    accountNodeId: number | null;
    sourceType: string;
    sourceId: number | null;
    content: string;
    occurredAt: Date;
    /** Cosine distance (lower is closer) on a vector search; null on the full-text fallback. */
    distance: number | null;
}

/**
 * Semantic search over an organisation's memory.
 *
 * Falls back to Postgres full-text search when no embedding provider is configured or the query
 * cannot be embedded — the same two-path design as kb_chunks. The fallback is deliberately kept
 * rather than returning nothing: a keyword match is a worse answer than a semantic one, but it is
 * enormously better than an empty one, and it is what makes the feature work on an environment
 * with no VOYAGE_API_KEY.
 */
export async function searchMemory(
    db: Db,
    organisationId: number,
    query: string,
    opts: { topK?: number; accountNodeId?: number | null } = {},
): Promise<MemoryHit[]> {
    const topK = Math.max(1, Math.min(Math.floor(opts.topK ?? DEFAULT_MEMORY_TOP_K), MAX_MEMORY_TOP_K));
    const text = String(query ?? '').trim();
    if (!text) return [];

    let queryVector: number[] | null = null;
    if (embeddingsConfigured()) {
        try {
            // inputType 'query' — asymmetric retrieval. Embedding a question the same way as a
            // document measurably degrades ranking on this model.
            const out = await embedTexts([text], 'query');
            queryVector = out?.[0] ?? null;
        } catch (err) {
            console.error('[account-memory] query embedding failed, falling back to full text', err);
        }
    }

    try {
        if (queryVector) {
            const literal = `[${queryVector.join(',')}]`;
            const rows = await db.execute<{
                id: number; account_node_id: number | null; source_type: string;
                source_id: number | null; content: string; occurred_at: Date; distance: number;
            }>(sql`
                SELECT id, account_node_id, source_type, source_id, content, occurred_at,
                       embedding <=> ${literal}::vector AS distance
                  FROM account_memory
                 WHERE organisation_id = ${organisationId}
                   AND embedding IS NOT NULL
                   ${opts.accountNodeId ? sql`AND account_node_id = ${opts.accountNodeId}` : sql``}
                 ORDER BY embedding <=> ${literal}::vector
                 LIMIT ${topK}
            `);
            return mapHits(rows);
        }

        const rows = await db.execute<{
            id: number; account_node_id: number | null; source_type: string;
            source_id: number | null; content: string; occurred_at: Date;
        }>(sql`
            SELECT id, account_node_id, source_type, source_id, content, occurred_at
              FROM account_memory
             WHERE organisation_id = ${organisationId}
               AND content_tsv @@ plainto_tsquery('english', ${text})
               ${opts.accountNodeId ? sql`AND account_node_id = ${opts.accountNodeId}` : sql``}
             ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ${text})) DESC
             LIMIT ${topK}
        `);
        return mapHits(rows);
    } catch (err) {
        logQuietly('searchMemory', err);
        return [];
    }
}

function mapHits(rows: unknown): MemoryHit[] {
    return Array.from(rows as Array<{
        id: number; account_node_id: number | null; source_type: string;
        source_id: number | null; content: string; occurred_at: Date; distance?: number;
    }>).map((r) => ({
        id: r.id,
        accountNodeId: r.account_node_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
        content: r.content,
        occurredAt: r.occurred_at,
        distance: typeof r.distance === 'number' ? r.distance : null,
    }));
}

/**
 * The most recent memories for one account, newest first.
 *
 * The cheap path — no embedding, no search. This is the working-memory read the plan describes:
 * when the question is "what happened with this company lately?", a kNN search is the wrong tool.
 */
export async function recentMemoryForNode(
    db: Db, organisationId: number, accountNodeId: number, limit = 20,
): Promise<MemoryHit[]> {
    try {
        const rows = await db
            .select({
                id: accountMemory.id,
                accountNodeId: accountMemory.accountNodeId,
                sourceType: accountMemory.sourceType,
                sourceId: accountMemory.sourceId,
                content: accountMemory.content,
                occurredAt: accountMemory.occurredAt,
            })
            .from(accountMemory)
            .where(and(
                eq(accountMemory.organisationId, organisationId),
                eq(accountMemory.accountNodeId, accountNodeId),
            ))
            .orderBy(desc(accountMemory.occurredAt))
            .limit(Math.max(1, Math.min(limit, 100)));
        return rows.map((r) => ({ ...r, distance: null }));
    } catch (err) {
        logQuietly('recentMemoryForNode', err);
        return [];
    }
}

function logQuietly(fn: string, err: unknown): void {
    const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
    console.error(`[account-memory] ${fn} failed (non-fatal)`, {
        pgCode: pg?.code,
        pgConstraint: pg?.constraint_name ?? pg?.constraint,
        cause: pg?.cause,
    }, err);
}
