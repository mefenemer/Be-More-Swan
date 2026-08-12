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
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, assistantRecords, discoveredLeads, discoveryCampaigns, discoveryJobs,
    discoverySchedules, masterAssistants,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { recordEvent } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { enqueueLeadHandoff } from '../../src/utils/lead-handoff';
import { CONTACT_AGGREGATE_SCOPE_SQL, CONTACT_BUCKET_SQL } from '../../src/config/lead-contact-state';
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
    campaignIcpSnapshot: unknown;
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
                    // Attribution (§7.2) for the batch-approve branch's ledger write. Free — the
                    // campaign is already joined — and it is the RIGHT snapshot: the ICP live when
                    // this lead was found, resolved per row rather than once for the batch, because
                    // a batch can span campaigns. Selected in BOTH queries on purpose: they share
                    // the `LeadRow` cast, so diverging them would make that cast lie for one.
                    campaignIcpSnapshot: discoveryCampaigns.icpSnapshot,
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

            // The saved-search sub-filter's options — and, since Searches is the landing tab, the
            // state of each search. The chips alone answered "which search", never "is it running,
            // did it ever run, and what am I meant to do next": a chat-proposed search lands here
            // as a DRAFT that has spent nothing and found nothing, and the tab rendered that
            // identically to a live search that had simply found nothing yet.
            //
            // Archived campaigns are excluded, matching discovery-campaigns.ts `list`. An archived
            // search offers no action and cannot run; leaving it as a chip is a dead control. Its
            // already-discovered signals still show under "All" — archiving stops a campaign, it
            // does not retract what it found.
            const searches = await db
                .select({
                    id: discoveryCampaigns.id,
                    name: discoveryCampaigns.name,
                    idea: discoveryCampaigns.idea,
                    status: discoveryCampaigns.status,
                    cadence: discoverySchedules.cadence,
                    // The dispatcher's own claim key, so the row can name a DATE instead of the
                    // generic "it repeats daily" it used to print. Both are returned because they
                    // answer different questions: isEnabled says whether a next run exists at all
                    // (a draft's schedule is disabled, and one_off never has one), nextRunAt says
                    // when. Sending nextRunAt alone would let the UI promise a run that nothing is
                    // scheduled to make.
                    nextRunAt: discoverySchedules.nextRunAt,
                    scheduleEnabled: discoverySchedules.isEnabled,
                    // Latest run first, matching the campaign list's subquery exactly — the two
                    // surfaces show the same search and must not disagree about its state.
                    //
                    // `status` on its own is NOT the state of a run, and reading it as if it were
                    // is what put a "Queued" chip on a search that had already filed fifteen leads.
                    // A run is sliced: the worker does ONE search query (~10s), writes the row back
                    // to 'queued' and returns, so all the way through searching → promoting →
                    // enriching the row reads 'queued' except for the few seconds a slice is
                    // actually executing. Hence the three companions below, and the `, j.id DESC`
                    // tiebreaker on every one of them — four subqueries that each pick "the latest
                    // job" must pick the SAME job, and created_at alone can tie.
                    latestJobStatus: sql<string | null>`(
                        SELECT j.status FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    // The discriminator. NULL means no slice has ever claimed this job — the only
                    // state that is honestly "Queued". Anything else (searching | promoting |
                    // enriching) means the run is under way and 'queued' is merely where it rests
                    // between slices.
                    latestJobStage: sql<string | null>`(
                        SELECT j.stage FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    // When the run last MOVED. A between-slices 'queued' is normal for seconds and
                    // suspicious after ten minutes: the on-demand drain loops for at most twelve,
                    // after which the run falls back to the ten-minute cron. Without this the UI
                    // would trade one lie ("Queued" while working) for another ("Searching now"
                    // forever on a run nothing is currently driving).
                    latestJobUpdatedAt: sql<string | null>`(
                        SELECT j.updated_at FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    // Position in the query plan, so a working run can prove it is advancing.
                    // `cursor.flat` is the generated query list and `queryIndex` the resume point;
                    // both are absent until the query_gen stage has run, hence the COALESCEs.
                    // jsonb_array_length is strict, so a missing `flat` yields NULL, not an error.
                    latestJobQueryIndex: sql<number>`(
                        SELECT COALESCE((j.cursor ->> 'queryIndex')::int, 0) FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    latestJobQueryTotal: sql<number>`(
                        SELECT COALESCE(jsonb_array_length(j.cursor -> 'flat'), 0) FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    // When the last run REACHED A CONCLUSION, not when the newest job was created:
                    // "last run 3 minutes ago" next to a queued job that hasn't started yet is a lie.
                    lastFinishedAt: sql<string | null>`(
                        SELECT j.updated_at FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                          AND j.status IN ('completed','failed')
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    leadsFound: sql<number>`(
                        SELECT COALESCE(SUM(j.leads_found), 0)::int FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                    )`,
                    // What the LATEST run found, as distinct from the campaign total above.
                    //
                    // ⚠️ These two diverge on every re-run, and the gap is not cosmetic.
                    // `leads_found` only counts rows the run actually INSERTED — the candidate
                    // insert is onConflictDoNothing on (campaign_id, domain)
                    // (process-discovery-jobs.ts) — so a repeat run of the same campaign that
                    // re-finds the same companies adds nothing and its own count is 0, while the
                    // cumulative total still reads whatever the first run banked. Printing only
                    // the total let a re-run that found nothing new report "15 leads found".
                    //
                    // Same ORDER BY as every other latest-job subquery here: four of them must
                    // pick the SAME job, and created_at alone can tie.
                    latestRunLeadsFound: sql<number>`(
                        SELECT COALESCE(j.leads_found, 0)::int FROM discovery_jobs j
                        WHERE j.campaign_id = ${discoveryCampaigns.id}
                        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                    )`,
                    // How many of this search's companies can actually be emailed (Phase 2 item 8).
                    //
                    // Counted over the CAMPAIGN, not the latest job, on purpose. `leads_found` is
                    // insert-only, so a re-run that re-finds the same companies banks 0 and a
                    // job-scoped aggregate would read "0 of 0" while 65 leads sit in the Leads tab.
                    // The copy names its own denominator so the two numbers cannot be confused.
                    //
                    // ⚠️ Predicates come from src/config/lead-contact-state.ts, which the Contact
                    // column's contactState() is pinned against by test. Do not inline them here:
                    // an aggregate that disagrees with the table under it is worse than no
                    // aggregate. sql.raw is safe — these are module constants, never user input.
                    contactTotal: sql<number>`(
                        SELECT count(*)::int FROM discovered_leads dl
                        WHERE dl.campaign_id = ${discoveryCampaigns.id} AND ${sql.raw(CONTACT_AGGREGATE_SCOPE_SQL)}
                    )`,
                    contactReachable: sql<number>`(
                        SELECT count(*)::int FROM discovered_leads dl
                        WHERE dl.campaign_id = ${discoveryCampaigns.id} AND ${sql.raw(CONTACT_AGGREGATE_SCOPE_SQL)}
                          AND (${sql.raw(CONTACT_BUCKET_SQL.reachable)})
                    )`,
                    contactNonePublished: sql<number>`(
                        SELECT count(*)::int FROM discovered_leads dl
                        WHERE dl.campaign_id = ${discoveryCampaigns.id} AND ${sql.raw(CONTACT_AGGREGATE_SCOPE_SQL)}
                          AND (${sql.raw(CONTACT_BUCKET_SQL.nonePublished)})
                    )`,
                    contactNotAttempted: sql<number>`(
                        SELECT count(*)::int FROM discovered_leads dl
                        WHERE dl.campaign_id = ${discoveryCampaigns.id} AND ${sql.raw(CONTACT_AGGREGATE_SCOPE_SQL)}
                          AND (${sql.raw(CONTACT_BUCKET_SQL.notAttempted)})
                    )`,
                    contactPending: sql<number>`(
                        SELECT count(*)::int FROM discovered_leads dl
                        WHERE dl.campaign_id = ${discoveryCampaigns.id} AND ${sql.raw(CONTACT_AGGREGATE_SCOPE_SQL)}
                          AND (${sql.raw(CONTACT_BUCKET_SQL.pending)})
                    )`,
                })
                .from(discoveryCampaigns)
                .leftJoin(discoverySchedules, eq(discoverySchedules.campaignId, discoveryCampaigns.id))
                .where(and(
                    eq(discoveryCampaigns.organisationId, orgId),
                    eq(discoveryCampaigns.aiAssistantId, assistantId),
                    ne(discoveryCampaigns.status, 'archived'),
                ))
                .orderBy(desc(discoveryCampaigns.createdAt));

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
                    cadence: s.cadence ?? 'one_off',
                    nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
                    scheduleEnabled: s.scheduleEnabled === true,
                    latestJobStatus: s.latestJobStatus ?? null,
                    latestJobStage: s.latestJobStage ?? null,
                    latestJobUpdatedAt: s.latestJobUpdatedAt ? new Date(s.latestJobUpdatedAt).toISOString() : null,
                    queryIndex: Number(s.latestJobQueryIndex ?? 0),
                    queryTotal: Number(s.latestJobQueryTotal ?? 0),
                    lastFinishedAt: s.lastFinishedAt ? new Date(s.lastFinishedAt).toISOString() : null,
                    leadsFound: Number(s.leadsFound ?? 0),
                    latestRunLeadsFound: Number(s.latestRunLeadsFound ?? 0),
                    contactTotal: Number(s.contactTotal ?? 0),
                    contactReachable: Number(s.contactReachable ?? 0),
                    contactNonePublished: Number(s.contactNonePublished ?? 0),
                    contactNotAttempted: Number(s.contactNotAttempted ?? 0),
                    contactPending: Number(s.contactPending ?? 0),
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
                    // Attribution (§7.2) for the batch-approve branch's ledger write. Free — the
                    // campaign is already joined — and it is the RIGHT snapshot: the ICP live when
                    // this lead was found, resolved per row rather than once for the batch, because
                    // a batch can span campaigns. Selected in BOTH queries on purpose: they share
                    // the `LeadRow` cast, so diverging them would make that cast lie for one.
                    campaignIcpSnapshot: discoveryCampaigns.icpSnapshot,
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
                    icpSnapshot: (row.campaignIcpSnapshot ?? null) as Record<string, unknown> | null,
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
            return json(503, { error: 'Searches is not set up on this environment yet.', code: 'MIGRATION_PENDING' });
        }
        const pg = err as { code?: string; constraint_name?: string; cause?: unknown };
        console.error('[signal-inbox]', { action, orgId, assistantId, pgCode: pg?.code, cause: pg?.cause }, err);
        return json(502, { error: 'Searches is having trouble right now — please try again.' });
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
