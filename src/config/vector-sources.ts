// src/config/vector-sources.ts
// The closed vocabulary for `vector_embeddings.source_type`.
//
// `vector_embeddings` is a POLYMORPHIC map: `source_id` is a primary key in whichever table
// `source_type` names, and those tables have INDEPENDENT id sequences. kb_article #12,
// inspo_item #12, workspace_asset #12 and account_memory #12 are four unrelated rows.
//
// ⚠️ THE RULE THIS FILE EXISTS TO ENFORCE: never query, and above all never DELETE, by
// `source_id` alone. A `source_id` on its own does not identify a row — it identifies one row
// per source type. This is the same trap as [[two-asset-tables-confused]], where two tables with
// independent id sequences were reconciled by loosening a filter instead of tightening it.
//
// That is not hypothetical: until 2026-08-02 `src/utils/gdpr-asset-purge.ts` deleted with
// `inArray(vectorEmbeddings.sourceId, assetIds)` and no source_type predicate, so a GDPR erasure
// covering workspace assets [1,2,3] also deleted the map rows for kb_article 1, inspo_item 2 and
// any other tenant's row that happened to share a number. It had not yet caused damage only
// because the table held two rows in total.

/** Every table that registers rows in `vector_embeddings`. */
export const VECTOR_SOURCE_TYPES = [
    'workspace_asset',   // src/utils/gdpr-asset-purge.ts (uploaded files)
    'conversation',      // task_runs
    'kb_article',        // netlify/functions/kb-articles.ts → kb_chunks
    'inspo_item',        // netlify/functions/inspo-items.ts → inspo_chunks
    'account_memory',    // Phase 3 — src/utils/account-memory.ts
] as const;

export type VectorSourceType = typeof VECTOR_SOURCE_TYPES[number];

const SET: ReadonlySet<string> = new Set(VECTOR_SOURCE_TYPES);

export function isVectorSourceType(v: unknown): v is VectorSourceType {
    return typeof v === 'string' && SET.has(v);
}
