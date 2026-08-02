// src/utils/account-graph.ts
// The structural memory tier — who relates to whom. Phase 3, plan §5.3.
//
// The ONE writer of account_nodes / account_edges, for the same reason recordEvent() is the only
// ledger writer: identity resolution only works if there is a single implementation of it.
//
// ── Identity resolution is by DOMAIN ─────────────────────────────────────────
// An account is keyed on its normalised domain, not its name. "Acme Ltd", "Acme Limited" and
// "ACME" are one company; acme.co.uk is unambiguous. This is enforced by the partial unique index
// account_nodes_org_domain_uidx, so concurrent writers converge on one node instead of racing to
// create three — the read-then-insert version of this function would produce duplicates under the
// exact conditions that matter (a discovery run promoting many leads at once).
//
// Contacts are deliberately NOT domain-unique: many people share one company domain, and a unique
// index over contacts would merge distinct humans into a single node.
//
// ── Best-effort by contract ──────────────────────────────────────────────────
// Every function resolves to null/[] on failure and NEVER throws. Memory is an observer of the
// pipeline; a graph write must not be able to fail an outreach send or a discovery run.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { accountNodes, accountEdges } from '../../db/schema';
import {
    MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_NODES,
    isEdgeType, isNodeType, type EdgeType, type NodeType,
} from '../config/account-graph';

type Db = ReturnType<typeof getDb>;

/**
 * Normalise a domain or URL to the identity key.
 *
 * Mirrors normaliseDomain in src/utils/scenario-engine.ts — the same shape suppression_list and
 * discovered_leads store, so a domain resolved here matches a domain stored there without further
 * massaging. Returns null for anything that is not a domain.
 */
export function normaliseAccountDomain(input: string | null | undefined): string | null {
    if (!input) return null;
    const host = String(input)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, '')
        .replace(/[^a-z0-9.-]/g, '');
    return host.includes('.') ? host : null;
}

/** The domain part of an email address, normalised to the same key. */
export function domainFromEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const at = String(email).lastIndexOf('@');
    return at < 0 ? null : normaliseAccountDomain(String(email).slice(at + 1));
}

export interface NodeRef { id: number; nodeType: string; label: string; domain: string | null }

/**
 * Find or create an ACCOUNT node for a domain.
 *
 * ON CONFLICT against the partial unique index, then re-read: two discovery runs promoting leads
 * from the same company at the same moment must converge on one node. `label` is only set on
 * creation — a later run must not overwrite a name a human has since corrected.
 */
export async function upsertAccountNode(
    db: Db,
    organisationId: number,
    input: { domain?: string | null; label: string; attributes?: Record<string, unknown> },
): Promise<NodeRef | null> {
    try {
        const domain = normaliseAccountDomain(input.domain);
        const label = String(input.label ?? '').trim().slice(0, 300) || domain || 'Unknown company';

        // No domain means no identity key. Fall back to a plain insert — an unkeyed account cannot
        // be deduplicated, and inventing a key from the name would merge unrelated companies.
        if (!domain) return await insertNode(db, organisationId, 'account', label, null, input.attributes);

        const [created] = await db.insert(accountNodes).values({
            organisationId, nodeType: 'account', label, domain,
            attributes: input.attributes ?? {},
        }).onConflictDoNothing().returning({
            id: accountNodes.id, nodeType: accountNodes.nodeType,
            label: accountNodes.label, domain: accountNodes.domain,
        });
        if (created) return created;

        const [existing] = await db
            .select({
                id: accountNodes.id, nodeType: accountNodes.nodeType,
                label: accountNodes.label, domain: accountNodes.domain,
            })
            .from(accountNodes)
            .where(and(
                eq(accountNodes.organisationId, organisationId),
                eq(accountNodes.nodeType, 'account'),
                eq(accountNodes.domain, domain),
            ))
            .limit(1);
        return existing ?? null;
    } catch (err) {
        logQuietly('upsertAccountNode', err);
        return null;
    }
}

/**
 * Create a contact node and link it to its account.
 *
 * Contacts are keyed on (org, email) inside `attributes` rather than by a unique index, because a
 * contact with no email is still a real contact. Callers that have an email should pass it — the
 * ingestion worker uses it to avoid duplicating a person across messages.
 */
export async function upsertContactNode(
    db: Db,
    organisationId: number,
    input: { label: string; email?: string | null; accountNodeId?: number | null },
): Promise<NodeRef | null> {
    try {
        const email = input.email ? String(input.email).trim().toLowerCase().slice(0, 300) : null;
        const label = String(input.label ?? '').trim().slice(0, 300) || email || 'Unknown contact';

        if (email) {
            // Match on the attributes JSON rather than a column: contacts are sparse and adding a
            // dedicated email column would put a third party's address in a second place that every
            // erasure path then has to know about.
            const [hit] = await db
                .select({
                    id: accountNodes.id, nodeType: accountNodes.nodeType,
                    label: accountNodes.label, domain: accountNodes.domain,
                })
                .from(accountNodes)
                .where(and(
                    eq(accountNodes.organisationId, organisationId),
                    eq(accountNodes.nodeType, 'contact'),
                    sql`${accountNodes.attributes} ->> 'email' = ${email}`,
                ))
                .limit(1);
            if (hit) {
                if (input.accountNodeId) await linkNodes(db, organisationId, hit.id, input.accountNodeId, 'works_at');
                return hit;
            }
        }

        const node = await insertNode(db, organisationId, 'contact', label,
            domainFromEmail(email), email ? { email } : undefined);
        if (node && input.accountNodeId) {
            await linkNodes(db, organisationId, node.id, input.accountNodeId, 'works_at');
        }
        return node;
    } catch (err) {
        logQuietly('upsertContactNode', err);
        return null;
    }
}

async function insertNode(
    db: Db, organisationId: number, nodeType: NodeType, label: string,
    domain: string | null, attributes?: Record<string, unknown>,
): Promise<NodeRef | null> {
    if (!isNodeType(nodeType)) return null;
    const [row] = await db.insert(accountNodes).values({
        organisationId, nodeType, label, domain, attributes: attributes ?? {},
    }).returning({
        id: accountNodes.id, nodeType: accountNodes.nodeType,
        label: accountNodes.label, domain: accountNodes.domain,
    });
    return row ?? null;
}

/**
 * Create a directed edge, or bump its weight if it already exists.
 *
 * Weight is a repetition count, not a score: three separate exchanges with one contact is a
 * stronger `engaged_with` than one. It is what lets the traversal rank neighbours without a model.
 */
export async function linkNodes(
    db: Db,
    organisationId: number,
    fromNodeId: number,
    toNodeId: number,
    edgeType: EdgeType,
): Promise<boolean> {
    try {
        if (!isEdgeType(edgeType)) {
            console.error('[account-graph] unknown edgeType, not linked:', edgeType);
            return false;
        }
        // Guarded by a CHECK too, but failing here avoids a pointless round trip and a noisy log.
        if (fromNodeId === toNodeId) return false;

        await db.insert(accountEdges).values({
            organisationId, fromNodeId, toNodeId, edgeType, weight: 1,
        }).onConflictDoUpdate({
            target: [accountEdges.fromNodeId, accountEdges.toNodeId, accountEdges.edgeType],
            set: { weight: sql`${accountEdges.weight} + 1` },
        });
        return true;
    } catch (err) {
        logQuietly('linkNodes', err);
        return false;
    }
}

export interface TraversedNode {
    id: number;
    nodeType: string;
    label: string;
    domain: string | null;
    depth: number;
    /** How the node was reached — the edge type on the final hop. Null for the root. */
    viaEdge: string | null;
}

/**
 * Walk the graph outward from one node, following edges in BOTH directions.
 *
 * ⚠️ TWO INDEPENDENT TERMINATION GUARANTEES, and both are needed:
 *   1. `depth < MAX_TRAVERSAL_DEPTH` — the plan's depth cap.
 *   2. `NOT n.id = ANY(path)` — a visited-path guard.
 * `account_edges` is a general directed graph WITH CYCLES (`competitor_of` is routinely mutual), so
 * the depth cap alone bounds the walk but still lets it revisit the same nodes exponentially on a
 * dense graph — a 4-hop walk over a clique of 20 is millions of rows. The path guard is what makes
 * it linear. Removing either one is a hang, not a slowdown.
 *
 * Bidirectional on purpose: `works_at` points contact→account, so a walk from an account that only
 * followed outgoing edges would never find its own employees.
 */
export async function traverseGraph(
    db: Db,
    organisationId: number,
    rootNodeId: number,
    maxDepth = MAX_TRAVERSAL_DEPTH,
): Promise<TraversedNode[]> {
    try {
        const depth = Math.max(1, Math.min(Math.floor(maxDepth) || 1, MAX_TRAVERSAL_DEPTH));

        const rows = await db.execute<{
            id: number; node_type: string; label: string; domain: string | null;
            depth: number; via_edge: string | null;
        }>(sql`
            WITH RECURSIVE walk AS (
                SELECT n.id, n.node_type, n.label, n.domain,
                       0 AS depth, NULL::text AS via_edge, ARRAY[n.id] AS path
                  FROM account_nodes n
                 WHERE n.id = ${rootNodeId} AND n.organisation_id = ${organisationId}
                UNION ALL
                SELECT n.id, n.node_type, n.label, n.domain,
                       w.depth + 1, e.edge_type, w.path || n.id
                  FROM walk w
                  JOIN account_edges e
                    ON (e.from_node_id = w.id OR e.to_node_id = w.id)
                  JOIN account_nodes n
                    ON n.id = CASE WHEN e.from_node_id = w.id THEN e.to_node_id ELSE e.from_node_id END
                 WHERE w.depth < ${depth}
                   -- Tenant scope re-asserted on every hop. A single cross-org edge would otherwise
                   -- walk straight out of this organisation's data.
                   AND n.organisation_id = ${organisationId}
                   AND e.organisation_id = ${organisationId}
                   -- The cycle guard. Without it this query does not terminate.
                   AND NOT (n.id = ANY(w.path))
            )
            SELECT DISTINCT ON (id) id, node_type, label, domain, depth, via_edge
              FROM walk
             ORDER BY id, depth
             LIMIT ${MAX_TRAVERSAL_NODES}
        `);

        return Array.from(rows as unknown as Array<{
            id: number; node_type: string; label: string; domain: string | null;
            depth: number; via_edge: string | null;
        }>).map((r) => ({
            id: r.id, nodeType: r.node_type, label: r.label, domain: r.domain,
            depth: r.depth, viaEdge: r.via_edge,
        })).sort((a, b) => a.depth - b.depth || a.id - b.id);
    } catch (err) {
        logQuietly('traverseGraph', err);
        return [];
    }
}

/** Resolve an account node by domain without creating one. Null when unknown. */
export async function findAccountByDomain(
    db: Db, organisationId: number, domain: string | null | undefined,
): Promise<NodeRef | null> {
    try {
        const key = normaliseAccountDomain(domain);
        if (!key) return null;
        const [row] = await db
            .select({
                id: accountNodes.id, nodeType: accountNodes.nodeType,
                label: accountNodes.label, domain: accountNodes.domain,
            })
            .from(accountNodes)
            .where(and(
                eq(accountNodes.organisationId, organisationId),
                eq(accountNodes.nodeType, 'account'),
                eq(accountNodes.domain, key),
            ))
            .limit(1);
        return row ?? null;
    } catch (err) {
        logQuietly('findAccountByDomain', err);
        return null;
    }
}

/** Same shape as the other Phase 2/3 helpers — postgres-js wraps the real failure, read `cause`. */
function logQuietly(fn: string, err: unknown): void {
    const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
    console.error(`[account-graph] ${fn} failed (non-fatal)`, {
        pgCode: pg?.code,
        pgConstraint: pg?.constraint_name ?? pg?.constraint,
        cause: pg?.cause,
    }, err);
}
