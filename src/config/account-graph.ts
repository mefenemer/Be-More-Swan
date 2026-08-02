// src/config/account-graph.ts
// Vocabulary and limits for the account graph and memory — Phase 3, plan §5.3.
//
// Imported by src/utils/account-graph.ts and src/utils/account-memory.ts (the only writers) and by
// the ingestion worker. The CHECK constraints in db/account-graph.sql and the check() calls in
// db/schema.ts mirror these; tests/account-graph.test.ts asserts all three stay in sync.

/** What a node IS. Mirrors account_nodes_type_check. */
export const NODE_TYPES = ['account', 'contact', 'deal'] as const;
export type NodeType = typeof NODE_TYPES[number];

/**
 * How nodes relate. Directed — `works_at` reads from contact TO account, and reversing it would
 * make a company an employee of a person. The traversal follows direction unless asked not to.
 */
export const EDGE_TYPES = ['works_at', 'engaged_with', 'competitor_of', 'referred_by'] as const;
export type EdgeType = typeof EDGE_TYPES[number];

/** Where a memory came from. Mirrors account_memory_source_type_check. */
export const MEMORY_SOURCE_TYPES = ['message', 'engagement', 'note', 'outcome'] as const;
export type MemorySourceType = typeof MEMORY_SOURCE_TYPES[number];

const NODE_SET: ReadonlySet<string> = new Set(NODE_TYPES);
const EDGE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);
const MEM_SET: ReadonlySet<string> = new Set(MEMORY_SOURCE_TYPES);

export function isNodeType(v: unknown): v is NodeType { return typeof v === 'string' && NODE_SET.has(v); }
export function isEdgeType(v: unknown): v is EdgeType { return typeof v === 'string' && EDGE_SET.has(v); }
export function isMemorySourceType(v: unknown): v is MemorySourceType { return typeof v === 'string' && MEM_SET.has(v); }

/**
 * Hard ceiling on recursive-CTE traversal depth (plan §5.3: "depth-capped at 4").
 *
 * Not a tuning knob. `account_edges` is a general directed graph with cycles — `competitor_of` is
 * routinely mutual — so an uncapped recursive CTE does not terminate on its own. The depth cap and
 * the visited-path guard in traverseGraph() are TWO independent reasons the query ends; keep both,
 * because the cap alone still lets a dense graph explode combinatorially before reaching it.
 */
export const MAX_TRAVERSAL_DEPTH = 4;

/** Ceiling on rows returned by one traversal, whatever the depth allows. */
export const MAX_TRAVERSAL_NODES = 200;

/** Default kNN neighbours for a semantic memory search. */
export const DEFAULT_MEMORY_TOP_K = 8;
export const MAX_MEMORY_TOP_K = 50;

/**
 * Cap on the text stored in one account_memory row.
 *
 * Memory rows are embedded, and embedding cost scales with length — but the real reason for a cap
 * is retrieval quality: one 40kB row dominates a kNN result set while being too coarse to answer
 * anything. Long sources are truncated, not chunked, because a lead message is already about the
 * size of a chunk.
 */
export const MAX_MEMORY_CHARS = 4_000;

/** Memory rows ingested per worker invocation. Bounds the embedding spend per tick. */
export const INGEST_BATCH_SIZE = 40;

/** Wall-clock budget for one ingestion invocation, under Netlify's ~26s ceiling. */
export const INGEST_BUDGET_MS = 20_000;
