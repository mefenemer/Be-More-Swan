// netlify/functions/signal-inbox.ts
// The Signal Inbox read + batch-approve API (Phase 1a of docs/lead-generator-revenue-engine-plan.md).
//
//   POST { action: 'list',    assistantId, savedSearchId?, showFiltered?, cursor? }
//        → { signals: Signal[], counts, savedSearches, nextCursor, hasSocialFeed }
//   POST { action: 'approve', assistantId, ids: string[] }
//        → { approved, skipped } — the CLASS A batch gate
//
// ── Projection, not duplication ──────────────────────────────────────────────
// Saved-search signals are PROJECTED from discovered_leads on every read; there is no signals row
// for them. discovered_leads stays their single source of truth. See plan §4.2a — a dual-write
// would need the two stores kept in sync on every status change, and that shape has bitten this
// codebase twice already (the Threads/YouTube bridge; the two asset tables).
//
// ── Works with ONLY a Lead Generator ─────────────────────────────────────────
// The social feed (Phase 1b) is additive. `hasSocialFeed` tells the client whether to offer it;
// when false the inbox is still fully populated from saved searches. Plan §1.6.

import { Handler } from '@netlify/functions';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, assistantRecords, discoveredLeads, discoveryCampaigns, masterAssistants,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { recordEvent } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { enqueueLeadHandoff } from '../../src/utils/lead-handoff';
import {
    resolveSourceLabel, savedSearchLabel, isBatchable, decodeCursor, encodeCursor,
    INBOX_PAGE_SIZE, type Signal, type HandoffState,
} from '../../src/config/signal-sources';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Feed-prefixed id. The two feeds have independent id sequences — a bare int would collide. */
function signalId(leadId: number): string {
    return `search:${leadId}`;
}

/** Parse 'search:1188' back to 1188. Returns null for anything else, including a bare int. */
function parseSignalId(raw: unknown): number | null {
    if (typeof raw !== 'string') return null;
    const m = /^search:(\d+)$/.exec(raw);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
}

interface LeadRow {
    id: number;
    companyName: string;
    domain: string | null;
    score: number | null;
    rating: string | null;
    status: string;
    signals: unknown;
    matchedQuery: string | null;
    createdAt: Date;
    campaignId: number;
    campaignName: string | null;
    campaignIdea: string;
    assistantRecordId: number | null;
    approvalStatus: string | null;
    recordData: unknown;
}

/**
 * Decide where a projected lead sits in the gate.
 *
 * The `needs_review` branch is the load-bearing one: a scraped address belonging to a NAMED
 * individual is the weakest footing for cold B2B outreach under UK GDPR/PECR, and approving the
 * lead is what later authorises a send to it. lead-generation.ts already refuses to send to one
 * without an explicit per-lead confirmation; this keeps the same lead out of a bulk approve, so
 * the two gates cannot be bypassed by approving 47 leads at once.
 */
function classifySignal(row: LeadRow): { state: HandoffState; reviewReason: string | null; filterReason: string | null } {
    const sig = (row.signals && typeof row.signals === 'object') ? row.signals as Record<string, unknown> : {};
    const rec = (row.recordData && typeof row.recordData === 'object') ? row.recordData as Record<string, unknown> : {};
    const emailKind = String(rec.emailKind ?? sig.emailKind ?? '');
    const emailSource = String(rec.emailSource ?? sig.emailSource ?? '');

    // Already decided by a human (or auto-approved at promotion time).
    if (row.approvalStatus === 'approved' || row.approvalStatus === 'scheduled') {
        return { state: 'promoted', reviewReason: null, filterReason: null };
    }
    if (row.approvalStatus === 'rejected') {
        return { state: 'filtered', reviewReason: null, filterReason: 'You rejected this lead' };
    }

    // Cold leads are noise for the inbox's purposes — visible only behind "Show filtered".
    if (row.rating === 'cold' || (row.score !== null && row.score < 40)) {
        return { state: 'filtered', reviewReason: null, filterReason: 'Scored cold against your profile' };
    }

    if (emailKind === 'personal' && emailSource === 'scrape') {
        return {
            state: 'needs_review',
            reviewReason: 'The only contact found belongs to a named individual and was scraped — approve it yourself rather than in a batch.',
            filterReason: null,
        };
    }

    return { state: 'ready', reviewReason: null, filterReason: null };
}

function projectSignal(row: LeadRow, sourceLabel: string): Signal {
    const { state, reviewReason, filterReason } = classifySignal(row);
    const sig = (row.signals && typeof row.signals === 'object') ? row.signals as Record<string, unknown> : {};
    const snippet = typeof sig.snippet === 'string' ? sig.snippet : '';
    return {
        id: signalId(row.id),
        sourceKind: 'saved_search',
        sourceLabel,
        savedSearchId: row.campaignId,
        savedSearchName: savedSearchLabel(row.campaignName, row.campaignIdea),
        title: row.companyName,
        excerpt: snippet || row.domain || '',
        rating: row.rating,
        confidence: row.score,
        handoffStatus: state,
        filterReason,
        reviewReason,
        assistantRecordId: row.assistantRecordId,
        occurredAt: row.createdAt.toISOString(),
    };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { action?: string; assistantId?: number; savedSearchId?: number; showFiltered?: boolean; cursor?: string; ids?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const action = String(body.action || 'list');
    const assistantId = Number(body.assistantId);

    // IDOR guard — the assistant instance must belong to the caller's org.
    const [assistant] = await db
        .select({ id: aiAssistants.id, name: aiAssistants.name, roleKey: masterAssistants.roleKey })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    // Resolved on every read, never stored — renaming the assistant must relabel history too.
    const sourceLabel = resolveSourceLabel(assistant.name);

    try {
        // ── list ──────────────────────────────────────────────────────────────
        if (action === 'list') {
            const cursor = decodeCursor(body.cursor);
            const showFiltered = body.showFiltered === true;
            const savedSearchFilter = Number.isInteger(body.savedSearchId) ? Number(body.savedSearchId) : null;

            // One query, joined across the discovery row, its campaign and the mirrored record.
            // Ordered (created_at DESC, id DESC) to match the composite cursor exactly — an OFFSET
            // would drift as new leads arrive mid-pagination.
            const rows = await db
                .select({
                    id: discoveredLeads.id,
                    companyName: discoveredLeads.companyName,
                    domain: discoveredLeads.domain,
                    score: discoveredLeads.score,
                    rating: discoveredLeads.rating,
                    status: discoveredLeads.status,
                    signals: discoveredLeads.signals,
                    matchedQuery: discoveredLeads.matchedQuery,
                    createdAt: discoveredLeads.createdAt,
                    campaignId: discoveryCampaigns.id,
                    campaignName: discoveryCampaigns.name,
                    campaignIdea: discoveryCampaigns.idea,
                    assistantRecordId: discoveredLeads.assistantRecordId,
                    approvalStatus: assistantRecords.approvalStatus,
                    recordData: assistantRecords.data,
                })
                .from(discoveredLeads)
                .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
                .leftJoin(assistantRecords, eq(assistantRecords.id, discoveredLeads.assistantRecordId))
                .where(and(
                    eq(discoveredLeads.organisationId, orgId),
                    eq(discoveryCampaigns.aiAssistantId, assistantId),
                    ...(savedSearchFilter ? [eq(discoveryCampaigns.id, savedSearchFilter)] : []),
                ))
                .orderBy(sqlDesc(), sqlDescId());

            // Classify in JS rather than SQL: the rules read from two jsonb blobs with a precedence
            // order (record data wins over discovery signals) that is far clearer here, and the row
            // count per assistant is bounded by the campaign guardrails.
            const all = (rows as unknown as LeadRow[]).map((r) => projectSignal(r, sourceLabel));

            const counts = {
                total: all.length,
                ready: all.filter((s) => s.handoffStatus === 'ready').length,
                needsReview: all.filter((s) => s.handoffStatus === 'needs_review').length,
                promoted: all.filter((s) => s.handoffStatus === 'promoted').length,
                filtered: all.filter((s) => s.handoffStatus === 'filtered').length,
            };

            let visible = showFiltered ? all : all.filter((s) => s.handoffStatus !== 'filtered');

            // Composite cursor: strictly after (occurredAt, id) in the sort order.
            if (cursor) {
                visible = visible.filter((s) =>
                    s.occurredAt < cursor.occurredAt || (s.occurredAt === cursor.occurredAt && s.id < cursor.id));
            }
            const page = visible.slice(0, INBOX_PAGE_SIZE);
            const last = page[page.length - 1];
            const nextCursor = visible.length > page.length && last
                ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
                : null;

            // The saved-search sub-filter's options.
            const searches = await db
                .select({ id: discoveryCampaigns.id, name: discoveryCampaigns.name, idea: discoveryCampaigns.idea, status: discoveryCampaigns.status })
                .from(discoveryCampaigns)
                .where(and(
                    eq(discoveryCampaigns.organisationId, orgId),
                    eq(discoveryCampaigns.aiAssistantId, assistantId),
                ));

            // Does this org also run a Social Media Assistant? Drives whether the client offers the
            // social feed at all. Absent is the NORMAL case, not an error state — see plan §4.4a.
            const social = await db
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
                .where(and(
                    eq(aiAssistants.organisationId, orgId),
                    eq(masterAssistants.roleKey, 'social_media_manager'),
                    eq(aiAssistants.isActive, true),
                ))
                .limit(1);

            return json(200, {
                signals: page,
                counts,
                nextCursor,
                sourceLabel,
                hasSocialFeed: social.length > 0,
                savedSearches: searches.map((s) => ({
                    id: s.id,
                    label: savedSearchLabel(s.name, s.idea),
                    status: s.status,
                })),
            });
        }

        // ── batch approve (the class A gate) ──────────────────────────────────
        if (action === 'approve') {
            const raw = Array.isArray(body.ids) ? body.ids : [];
            const leadIds = raw.map(parseSignalId).filter((n): n is number => n !== null);
            if (leadIds.length === 0) return json(400, { error: 'No valid signal ids supplied.' });

            // Re-read and re-classify server-side. The client's view can be stale, and a signal
            // that became `needs_review` since the page rendered must not be approved because the
            // browser still thinks it is batchable. The gate lives HERE, not in the UI.
            const rows = await db
                .select({
                    id: discoveredLeads.id,
                    companyName: discoveredLeads.companyName,
                    domain: discoveredLeads.domain,
                    score: discoveredLeads.score,
                    rating: discoveredLeads.rating,
                    status: discoveredLeads.status,
                    signals: discoveredLeads.signals,
                    matchedQuery: discoveredLeads.matchedQuery,
                    createdAt: discoveredLeads.createdAt,
                    campaignId: discoveryCampaigns.id,
                    campaignName: discoveryCampaigns.name,
                    campaignIdea: discoveryCampaigns.idea,
                    assistantRecordId: discoveredLeads.assistantRecordId,
                    approvalStatus: assistantRecords.approvalStatus,
                    recordData: assistantRecords.data,
                })
                .from(discoveredLeads)
                .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
                .leftJoin(assistantRecords, eq(assistantRecords.id, discoveredLeads.assistantRecordId))
                .where(and(
                    eq(discoveredLeads.organisationId, orgId),
                    eq(discoveryCampaigns.aiAssistantId, assistantId),
                    inArray(discoveredLeads.id, leadIds),
                ));

            const approved: string[] = [];
            const skipped: { id: string; reason: string }[] = [];

            // Attribution (§7.2). Every row in this batch belongs to `assistantId` — the query above
            // filters on it — so one lookup covers the whole loop.
            const blueprintVersion = await getBlueprintVersion(db, assistantId);

            for (const row of rows as unknown as LeadRow[]) {
                const { state, reviewReason } = classifySignal(row);
                if (!isBatchable(state)) {
                    skipped.push({ id: signalId(row.id), reason: reviewReason ?? `not batchable (${state})` });
                    continue;
                }
                if (!row.assistantRecordId) {
                    skipped.push({ id: signalId(row.id), reason: 'not yet mirrored into the Review Queue' });
                    continue;
                }

                await db.update(assistantRecords)
                    .set({ approvalStatus: 'approved', updatedAt: new Date() })
                    .where(and(
                        eq(assistantRecords.id, row.assistantRecordId),
                        eq(assistantRecords.organisationId, orgId),
                    ));

                // Same outbound push the Review Queue fires — one shared mapping, so the two
                // approval surfaces cannot diverge (src/utils/lead-handoff.ts).
                await enqueueLeadHandoff(db, orgId, {
                    id: row.assistantRecordId,
                    aiAssistantId: assistantId,
                    title: row.companyName,
                    status: row.rating,
                    data: row.recordData,
                });

                // actor 'user': a batch approve is still a human decision, just an efficient one.
                // Recording it per lead (not per batch) keeps the ledger's unit consistent with the
                // single-approve path, so approval-rate aggregates do not need to know which
                // surface was used.
                await recordEvent(db, 'lead_approved', {
                    organisationId: orgId,
                    aiAssistantId: assistantId,
                    discoveredLeadId: row.id,
                    assistantRecordId: row.assistantRecordId,
                    actor: 'user',
                    actorUserId: userId,
                    blueprintVersion,
                    payload: { from: row.approvalStatus, to: 'approved', rating: row.rating, via: 'batch' },
                });

                approved.push(signalId(row.id));
            }

            return json(200, { approved: approved.length, approvedIds: approved, skipped });
        }

        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        // The signals_published_at / name columns are added by db/signal-inbox-1a.sql, which is a
        // MANUAL apply. Give that a distinct, actionable message rather than a generic 502 — the
        // "column does not exist" case is by far the most likely failure right after a deploy.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('does not exist') && (msg.includes('column') || msg.includes('relation'))) {
            console.error('[signal-inbox] schema not migrated — apply db/signal-inbox-1a.sql', err);
            return json(503, { error: 'The Signal Inbox is not set up on this environment yet.', code: 'MIGRATION_PENDING' });
        }
        const pg = err as { code?: string; constraint_name?: string; cause?: unknown };
        console.error('[signal-inbox]', { action, orgId, assistantId, pgCode: pg?.code, cause: pg?.cause }, err);
        return json(502, { error: 'The Signal Inbox is having trouble right now — please try again.' });
    }
});

// Drizzle's typed ORDER BY helpers, kept at the bottom so the handler reads top-down.
// Sort must match the composite cursor in src/config/signal-sources.ts exactly.
function sqlDesc() {
    return desc(discoveredLeads.createdAt);
}
function sqlDescId() {
    return desc(discoveredLeads.id);
}
