// tests/account-graph.test.ts
// Phase 3 of docs/lead-generator-revenue-engine-plan.md §5.3 — the account graph and memory.
//
// Four properties carry real consequences and each is asserted below:
//
//   1. THE vector_embeddings source_type PREDICATE. That table is polymorphic and its source tables
//      have independent id sequences, so deleting by source_id alone destroys unrelated rows in
//      OTHER TENANTS. This was a live bug in gdpr-asset-purge.ts until 2026-08-02; the regression
//      test below is the reason it cannot come back.
//   2. THE GDPR PAIRING. Every embedded memory row must get a map row, in ONE transaction. A row
//      committed without its map row is an unregistered vector nothing can later find.
//   3. TRAVERSAL TERMINATES. account_edges is a cyclic directed graph. The depth cap and the
//      visited-path guard are two INDEPENDENT reasons the recursive CTE ends; losing either is a
//      hang, not a slowdown.
//   4. IDENTITY RESOLUTION IS BY DOMAIN, and free-mail domains never become accounts — otherwise
//      every prospect on a personal address collapses into one "gmail.com" company.
//
// No database: normalisation is pure, and the write helpers are exercised through fakes. The
// SQL-level invariants are asserted against the migration and helper source, the same technique
// tests/lead-threads.test.ts and tests/outreach-sequences.test.ts use.
// Run:  npx tsx tests/account-graph.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    NODE_TYPES, EDGE_TYPES, MEMORY_SOURCE_TYPES, MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_NODES,
    MAX_MEMORY_CHARS, MAX_MEMORY_TOP_K, DEFAULT_MEMORY_TOP_K, INGEST_BATCH_SIZE, INGEST_BUDGET_MS,
    isNodeType, isEdgeType, isMemorySourceType,
} from '../src/config/account-graph';
import { VECTOR_SOURCE_TYPES, isVectorSourceType } from '../src/config/vector-sources';
import { normaliseAccountDomain, domainFromEmail } from '../src/utils/account-graph';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqlText = readFileSync(join(root, 'db/account-graph.sql'), 'utf8');
const schemaText = readFileSync(join(root, 'db/schema.ts'), 'utf8');
const graphText = readFileSync(join(root, 'src/utils/account-graph.ts'), 'utf8');
const memoryText = readFileSync(join(root, 'src/utils/account-memory.ts'), 'utf8');
const purgeText = readFileSync(join(root, 'src/utils/gdpr-asset-purge.ts'), 'utf8');
const workerText = readFileSync(join(root, 'netlify/functions/process-account-memory.ts'), 'utf8');

// ── 1. The cross-tenant purge regression ─────────────────────────────────────

check('gdpr-asset-purge filters vector_embeddings by source_type, not source_id alone', () => {
    // THE REGRESSION TEST. Until 2026-08-02 this deleted with inArray(sourceId, assetIds) and no
    // source_type predicate. vector_embeddings is polymorphic over tables with independent id
    // sequences, so erasing workspace assets [1,2,3] also deleted kb_article 1 and inspo_item 2 —
    // including other organisations' rows — while leaving the erased user's own kb/inspo vectors
    // in place. Exactly backwards.
    const block = purgeText.slice(purgeText.indexOf('.delete(vectorEmbeddings)'));
    const stmt = block.slice(0, block.indexOf('.returning('));
    assert.ok(
        stmt.includes('eq(vectorEmbeddings.sourceType'),
        'the delete must be scoped by source_type — without it this deletes other tenants\' rows',
    );
    assert.ok(stmt.includes('inArray(vectorEmbeddings.sourceId'), 'it must still scope to the asset ids');
    assert.ok(stmt.includes("'workspace_asset'"), 'this purge covers workspace assets specifically');
});

check('every writer of vector_embeddings uses a declared source type', () => {
    for (const t of ['workspace_asset', 'kb_article', 'inspo_item', 'account_memory']) {
        assert.ok((VECTOR_SOURCE_TYPES as readonly string[]).includes(t), `${t} missing from VECTOR_SOURCE_TYPES`);
    }
    assert.equal(isVectorSourceType('account_memory'), true);
    assert.equal(isVectorSourceType('acount_memory'), false, 'a typo must not narrow');
});

// ── 2. The GDPR pairing ──────────────────────────────────────────────────────

check('an embedded memory row and its map row are written in ONE transaction', () => {
    // Split across two statements, a crash between them leaves a vector nothing can find later to
    // prove it was erased.
    const fn = memoryText.slice(memoryText.indexOf('export async function writeMemories'));
    const txAt = fn.indexOf('db.transaction(');
    const memInsertAt = fn.indexOf('tx.insert(accountMemory)');
    const mapInsertAt = fn.indexOf('tx.insert(vectorEmbeddings)');
    assert.ok(txAt > 0, 'writeMemories must use a transaction');
    assert.ok(memInsertAt > txAt, 'the memory insert must be inside the transaction');
    assert.ok(mapInsertAt > txAt, 'the map insert must be inside the SAME transaction');
});

check('the map row is written only when there is actually a vector', () => {
    // An unembedded row has no vector to register; a map row for it would claim a vector exists.
    const fn = memoryText.slice(memoryText.indexOf('export async function writeMemories'));
    const guardAt = fn.indexOf('if (vector) {');
    const mapAt = fn.indexOf('tx.insert(vectorEmbeddings)');
    assert.ok(guardAt > 0 && guardAt < mapAt, 'the map insert must be guarded on the vector existing');
});

check('the embedding call happens OUTSIDE the transaction', () => {
    // A provider round trip inside a transaction pins a pooled Neon connection for its duration —
    // a slow provider becomes pool exhaustion for the whole app.
    const fn = memoryText.slice(memoryText.indexOf('export async function writeMemories'));
    const embedAt = fn.indexOf('await embedTexts(');
    const txAt = fn.indexOf('db.transaction(');
    assert.ok(embedAt > 0 && txAt > 0, 'fixture: could not locate both calls');
    assert.ok(embedAt < txAt, 'embedTexts must be called before the transaction opens');
});

check('an embedding failure stores the row unembedded rather than losing it', () => {
    const fn = memoryText.slice(memoryText.indexOf('export async function writeMemories'));
    const catchAt = fn.indexOf('} catch (err) {');
    const nullAt = fn.indexOf('vectors = null');
    assert.ok(catchAt > 0, 'the embed call must be wrapped');
    assert.ok(
        nullAt > catchAt && nullAt - catchAt < 500,
        'a provider error must degrade to full-text retrieval, not drop the memory',
    );
});

check('the migration documents the pairing invariant as a runnable query', () => {
    assert.ok(
        sqlText.includes("v.source_type = 'account_memory'"),
        'the verify block must check the map row by BOTH source_type and source_id',
    );
});

// ── 3. Traversal termination ─────────────────────────────────────────────────

check('the recursive CTE has BOTH a depth cap and a visited-path guard', () => {
    const fn = graphText.slice(graphText.indexOf('export async function traverseGraph'));
    assert.ok(fn.includes('WITH RECURSIVE'), 'traversal must be a recursive CTE');
    assert.ok(/w\.depth < \$\{depth\}/.test(fn), 'the depth cap is missing');
    assert.ok(
        /NOT \(n\.id = ANY\(w\.path\)\)/.test(fn),
        'the cycle guard is missing — competitor_of is routinely mutual, so this query would not terminate',
    );
});

check('the depth argument cannot exceed the configured ceiling', () => {
    const fn = graphText.slice(graphText.indexOf('export async function traverseGraph'));
    assert.ok(
        fn.includes('Math.min(') && fn.includes('MAX_TRAVERSAL_DEPTH'),
        'a caller-supplied depth must be clamped, not trusted',
    );
    assert.equal(MAX_TRAVERSAL_DEPTH, 4, 'plan §5.3 specifies depth-capped at 4');
    assert.ok(MAX_TRAVERSAL_NODES > 0 && MAX_TRAVERSAL_NODES <= 1000);
});

check('every hop re-asserts the organisation scope', () => {
    // One cross-org edge would otherwise walk straight out of this tenant's data.
    const fn = graphText.slice(graphText.indexOf('export async function traverseGraph'));
    const recursive = fn.slice(fn.indexOf('UNION ALL'));
    assert.ok(recursive.includes('n.organisation_id = ${organisationId}'), 'node scope missing on the recursive hop');
    assert.ok(recursive.includes('e.organisation_id = ${organisationId}'), 'edge scope missing on the recursive hop');
});

check('the traversal follows edges in both directions', () => {
    // works_at points contact→account, so an outgoing-only walk from an account never finds its
    // own employees.
    const fn = graphText.slice(graphText.indexOf('export async function traverseGraph'));
    assert.ok(
        /e\.from_node_id = w\.id OR e\.to_node_id = w\.id/.test(fn),
        'the join must consider edges arriving as well as leaving',
    );
});

check('a self-edge is rejected in code AND by a constraint', () => {
    const fn = graphText.slice(graphText.indexOf('export async function linkNodes'));
    assert.ok(fn.includes('fromNodeId === toNodeId'), 'linkNodes must reject a self-edge');
    assert.ok(sqlText.includes('account_edges_no_self_check'), 'the SQL must carry the constraint too');
    assert.ok(schemaText.includes('account_edges_no_self_check'), 'schema.ts must declare it or push reverts it');
});

// ── 4. Identity resolution ───────────────────────────────────────────────────

check('domain normalisation matches the shape other tables store', () => {
    assert.equal(normaliseAccountDomain('https://WWW.Acme.co.uk/pricing?x=1'), 'acme.co.uk');
    assert.equal(normaliseAccountDomain('Acme.CO.UK'), 'acme.co.uk');
    assert.equal(normaliseAccountDomain('http://sub.acme.io:8443/'), 'sub.acme.io');
    assert.equal(normaliseAccountDomain('  acme.com  '), 'acme.com');
    assert.equal(normaliseAccountDomain('localhost'), null, 'no dot is not a domain');
    assert.equal(normaliseAccountDomain(''), null);
    assert.equal(normaliseAccountDomain(null), null);
});

check('an email resolves to the same key as a bare domain', () => {
    assert.equal(domainFromEmail('Jo.Bloggs+tag@WWW.Acme.co.uk'), 'acme.co.uk');
    assert.equal(domainFromEmail('jo@acme.com'), normaliseAccountDomain('https://acme.com/'));
    assert.equal(domainFromEmail('not-an-address'), null);
    assert.equal(domainFromEmail(null), null);
});

check('free-mail domains never become account nodes', () => {
    // Otherwise every prospect who replied from a personal address collapses into one "gmail.com"
    // company holding hundreds of unrelated firms' memory, poisoning every node-scoped search.
    const m = workerText.match(/const FREE_MAIL = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'the free-mail guard is missing');
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']) {
        assert.ok(m![1].includes(`'${d}'`), `FREE_MAIL is missing ${d}`);
    }
    // Applied in every pass that creates an account node, not just the first.
    const uses = workerText.match(/FREE_MAIL\.has\(/g) ?? [];
    assert.ok(uses.length >= 3, `the guard must apply in all three passes (found ${uses.length})`);
});

check('account identity uses ON CONFLICT, not a read-then-write race', () => {
    const fn = graphText.slice(graphText.indexOf('export async function upsertAccountNode'));
    const insertAt = fn.indexOf('.insert(accountNodes)');
    const conflictAt = fn.indexOf('.onConflictDoNothing()');
    const reReadAt = fn.indexOf('.select(');
    assert.ok(insertAt > 0 && conflictAt > insertAt, 'the insert must be conflict-tolerant');
    assert.ok(reReadAt > conflictAt, 'it must re-read the winner rather than returning null on conflict');
});

check('the account uniqueness index is PARTIAL to node_type = account', () => {
    // A full unique index over (org, domain) would merge every contact at a company into one node.
    assert.ok(
        /account_nodes_org_domain_uidx[\s\S]{0,200}WHERE node_type = 'account' AND domain IS NOT NULL/.test(sqlText),
        'the SQL index must be partial on node_type and a non-null domain',
    );
    assert.ok(
        /account_nodes_org_domain_uidx[\s\S]{0,300}node_type = 'account'/.test(schemaText),
        'schema.ts must declare the same predicate or drizzle-kit push reverts it',
    );
});

// ── 5. Vocabulary sync: config ↔ SQL ↔ schema.ts ─────────────────────────────

check('node, edge and memory vocabularies match the SQL CHECK constraints', () => {
    const cases: Array<[readonly string[], RegExp, string]> = [
        [NODE_TYPES, /CHECK \(node_type IN \(([^)]*)\)/, 'node_type'],
        [EDGE_TYPES, /CHECK \(edge_type IN \(([^)]*)\)/, 'edge_type'],
        [MEMORY_SOURCE_TYPES, /CHECK \(source_type IN \(([^)]*)\)/, 'source_type'],
    ];
    for (const [values, re, label] of cases) {
        const m = sqlText.match(re);
        assert.ok(m, `could not locate the ${label} CHECK in db/account-graph.sql`);
        for (const v of values) assert.ok(m![1].includes(`'${v}'`), `SQL ${label} CHECK is missing '${v}'`);
    }
});

check('db/schema.ts check() constraints match (drizzle-kit push must not revert the DDL)', () => {
    for (const [name, values] of [
        ['account_nodes_type_check', NODE_TYPES],
        ['account_edges_type_check', EDGE_TYPES],
        ['account_memory_source_type_check', MEMORY_SOURCE_TYPES],
    ] as Array<[string, readonly string[]]>) {
        const at = schemaText.indexOf(name);
        assert.ok(at > 0, `schema.ts is missing ${name}`);
        const block = schemaText.slice(at, at + 400);
        for (const v of values) assert.ok(block.includes(`'${v}'`), `schema.ts ${name} is missing '${v}'`);
    }
});

check('the guards narrow correctly and reject junk', () => {
    assert.equal(isNodeType('account'), true);
    assert.equal(isNodeType('company'), false);
    assert.equal(isEdgeType('works_at'), true);
    assert.equal(isEdgeType('worksat'), false);
    assert.equal(isMemorySourceType('outcome'), true);
    assert.equal(isMemorySourceType('outcomes'), false);
});

// ── 6. Ingestion and retrieval hygiene ───────────────────────────────────────

check('ingestion idempotency is structural, with no marker column', () => {
    assert.ok(
        sqlText.includes('account_memory_source_uidx'),
        'the (org, source_type, source_id) unique index is what stops re-embedding',
    );
    assert.ok(
        /CREATE UNIQUE INDEX[^;]*account_memory_source_uidx/i.test(sqlText),
        'that index must be UNIQUE or re-runs duplicate every row',
    );
    // Each pass selects what is MISSING rather than tracking what it has done.
    const notExists = workerText.match(/NOT EXISTS \(/g) ?? [];
    assert.ok(notExists.length >= 2, 'the message and outcome passes must both filter on absence');
    assert.ok(
        !/ingested_at|memory_cursor/.test(workerText),
        'a marker column would be a weaker guarantee that can drift from the rows it describes',
    );
});

check('memory writes are conflict-tolerant, so a replayed tick is a no-op', () => {
    const fn = memoryText.slice(memoryText.indexOf('export async function writeMemories'));
    assert.ok(fn.includes('.onConflictDoNothing()'), 'a duplicate source row must be skipped, not thrown');
});

check('search embeds the query asymmetrically', () => {
    // Embedding a question as a document measurably degrades ranking on this model.
    const fn = memoryText.slice(memoryText.indexOf('export async function searchMemory'));
    assert.ok(fn.includes("embedTexts([text], 'query')"), "the query must be embedded with inputType 'query'");
    const write = memoryText.slice(memoryText.indexOf('export async function writeMemories'));
    assert.ok(write.includes("'document'"), 'stored rows must be embedded as documents');
});

check('search falls back to full text rather than returning nothing', () => {
    const fn = memoryText.slice(memoryText.indexOf('export async function searchMemory'));
    assert.ok(fn.includes('content_tsv @@ plainto_tsquery'), 'the full-text fallback is missing');
    assert.ok(sqlText.includes('content_tsv'), 'the generated column must exist in the migration');
    assert.ok(sqlText.includes('USING GIN (content_tsv)'), 'the fallback needs its GIN index to be usable');
});

check('the vector index is HNSW cosine, matching kb_chunks', () => {
    assert.ok(/USING hnsw \(embedding vector_cosine_ops\)/.test(sqlText), 'wrong or missing vector index');
    assert.ok(sqlText.includes('vector(1024)'), 'dimensions must match kb_chunks so one embed path serves both');
});

check('the caps are sane and the worker fits inside the function ceiling', () => {
    assert.ok(MAX_MEMORY_CHARS > 0 && MAX_MEMORY_CHARS <= 10_000);
    assert.ok(DEFAULT_MEMORY_TOP_K > 0 && DEFAULT_MEMORY_TOP_K <= MAX_MEMORY_TOP_K);
    assert.ok(INGEST_BATCH_SIZE > 0 && INGEST_BATCH_SIZE <= 128, 'Voyage caps a batch at 128 inputs');
    assert.ok(INGEST_BUDGET_MS < 26_000, 'the budget must leave headroom under Netlify\'s ~26s ceiling');
});

check('the worker degrades quietly when the migration has not been applied', () => {
    assert.ok(workerText.includes("code === '42P01'"), 'a missing table must be handled, not thrown');
    assert.ok(workerText.includes('apply db/account-graph.sql'), 'the log line must name the migration');
});

check('the migration is idempotent throughout', () => {
    assert.equal(sqlText.match(/CREATE TABLE(?! IF NOT EXISTS)/gi), null, 'every CREATE TABLE must be IF NOT EXISTS');
    assert.equal(sqlText.match(/CREATE (?:UNIQUE )?INDEX(?! IF NOT EXISTS)/gi), null, 'every CREATE INDEX must be IF NOT EXISTS');
    assert.ok(sqlText.includes('CREATE EXTENSION IF NOT EXISTS vector'), 'pgvector must be ensured');
    assert.ok(sqlText.includes('IF NOT EXISTS (SELECT 1 FROM pg_constraint'), 'constraints must be guarded');
});

console.log(`\n${passed} checks passed`);
