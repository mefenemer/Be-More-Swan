// netlify/functions/assistant-records.ts
// Internal Data Hub API (Golden Rule 2) — CRUD for assistant_records, the tenant
// work products behind the Data Hub tab on assistant-detail.html.
//
//  GET    ?assistantId=<id>&recordType=<type>[&format=csv]  → { records: [...] } or a CSV download
//  POST   { assistantId, recordType, records: [{ title, status?, data }, ...], source? }
//         → bulk insert (CSV import) or single insert; upserts on (assistant, type, title)
//  PATCH  { id, status?, data? }                            → update one record's lifecycle/state
//  DELETE { id }                                            → remove one record
//
// `data` is the uiElement wire shape (disruptive-ui-registry.js) so the hub tab and the
// chat transcript render records identically. Auth: aura_session + requireTenant; every
// query is tenant-scoped and the assistant is ownership-checked (IDOR guard).

import { Handler } from '@netlify/functions';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { actionItems, aiAssistants, assistantRecords, discoveredLeads } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enqueueScenarioTrigger, type TriggerSubject } from '../../src/utils/scenario-engine';

const RECORD_TYPES = new Set(['lead', 'enrichment', 'meeting', 'invoice', 'ticket']);
const SOURCES = new Set(['chat', 'csv_import', 'integration']);
// Bulk-import ceiling per request — a CSV bigger than this should be split client-side.
const MAX_BULK_RECORDS = 500;
// Serialised size cap per record's data payload (client-supplied, treat as untrusted).
const MAX_DATA_CHARS = 20_000;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** RFC 4180-style escaping: quote when the value contains a comma, quote, or newline. */
function csvCell(value: unknown): string {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Db = ReturnType<typeof getDb>;

// Approval states that count as "live" — a record already in one of these has already
// fired its handoff, so re-approving/editing it must not fire again.
const LIVE_APPROVAL = new Set(['approved', 'scheduled']);

// Meeting Note Taker Phase 3 — materialise the normalized action_items ledger from a meeting's
// data.tasks when it first goes live, so the create_tasks recipes have per-task rows to sync
// into Jira/Asana. Idempotent (upsert on meeting_record_id + description) and best-effort: a
// failure here never fails the approval. The sync-state columns are deliberately NOT reset on
// re-approval, so an already-synced task is never re-created. Design:
// docs/meeting-note-taker-phase3-plan.md.
async function materialiseActionItems(
    db: Db,
    orgId: number,
    record: { id: number; recordType: string; aiAssistantId: number; data: unknown },
): Promise<void> {
    if (record.recordType !== 'meeting') return;
    try {
        const data = (record.data && typeof record.data === 'object') ? record.data as Record<string, unknown> : {};
        const rawTasks = Array.isArray(data.tasks) ? data.tasks
            : Array.isArray(data.actionItems) ? data.actionItems : [];
        const rows = (rawTasks as unknown[])
            .filter((t): t is Record<string, unknown> =>
                !!t && typeof t === 'object' && typeof (t as Record<string, unknown>).description === 'string'
                && String((t as Record<string, unknown>).description).trim() !== '')
            .map((t) => ({
                organisationId: orgId,
                aiAssistantId: record.aiAssistantId,
                meetingRecordId: record.id,
                description: String(t.description).trim().slice(0, 2000),
                assignee: typeof t.assignee === 'string' ? t.assignee.slice(0, 200) : null,
                dueDate: typeof t.dueDate === 'string' ? t.dueDate.slice(0, 200) : null,
            }));
        for (const row of rows) {
            await db.insert(actionItems).values(row).onConflictDoUpdate({
                target: [actionItems.meetingRecordId, actionItems.description],
                // Re-approving refreshes owner/date and revives a task the user previously left
                // unsynced ('skipped') back to 'pending'; already 'synced'/'failed' rows keep
                // their state (failed auto-retries through the scenario-job queue).
                set: {
                    assignee: row.assignee,
                    dueDate: row.dueDate,
                    syncStatus: sql`CASE WHEN ${actionItems.syncStatus} = 'skipped' THEN 'pending' ELSE ${actionItems.syncStatus} END`,
                    updatedAt: new Date(),
                },
            });
        }
    } catch (err) {
        console.error('[assistant-records] materialiseActionItems failed (non-fatal):', err);
    }
}

// Meeting Note Taker Phase 3 (step 5) — attach the per-task sync ledger to meeting records so the
// Inbox card can surface "5 of 8 synced" + per-task ✓/⚠ pills. The action_items ledger only exists
// once a meeting has been approved+materialised, so review-column meetings carry no syncState (they
// haven't fired create_tasks yet). Best-effort: if the table isn't applied yet the meetings just
// render without sync state. Design: docs/meeting-note-taker-phase3-plan.md.
async function attachActionItemSync<T extends { id: number; recordType: string }>(
    db: Db,
    orgId: number,
    records: T[],
): Promise<(T & { actionItemSync?: unknown })[]> {
    const meetingIds = records.filter((r) => r.recordType === 'meeting').map((r) => r.id);
    if (meetingIds.length === 0) return records;
    try {
        const items = await db.select({
            meetingRecordId: actionItems.meetingRecordId,
            description: actionItems.description,
            assignee: actionItems.assignee,
            dueDate: actionItems.dueDate,
            syncStatus: actionItems.syncStatus,
            provider: actionItems.provider,
            externalUrl: actionItems.externalUrl,
            errorMessage: actionItems.errorMessage,
            syncedAt: actionItems.syncedAt,
        }).from(actionItems)
            .where(and(eq(actionItems.organisationId, orgId), inArray(actionItems.meetingRecordId, meetingIds)))
            .orderBy(actionItems.id);
        const byMeeting = new Map<number, typeof items>();
        for (const it of items) {
            const arr = byMeeting.get(it.meetingRecordId);
            if (arr) arr.push(it); else byMeeting.set(it.meetingRecordId, [it]);
        }
        return records.map((r) => {
            const its = byMeeting.get(r.id);
            if (!its || its.length === 0) return r;
            const count = (s: string) => its.filter((i) => i.syncStatus === s).length;
            return {
                ...r,
                actionItemSync: {
                    total: its.length,
                    synced: count('synced'),
                    failed: count('failed'),
                    pending: count('pending'),
                    skipped: count('skipped'),
                    items: its,
                },
            };
        });
    } catch {
        // Ledger table not applied yet — degrade to no sync state rather than 500 the whole hub.
        return records;
    }
}

// Integration Scenario Library — fire the outbound "Handoff" push (Scenario Type A) when a
// Review Queue record first goes live. lead → QUALIFIED, meeting → MEETING_BOOKED; the
// scenario engine enqueues a job that maps these fields into the tenant's active recipes.
// Best-effort: enqueueScenarioTrigger already swallows its own errors so approval never fails.
async function enqueueHandoffOnApproval(
    db: Db,
    orgId: number,
    record: { id: number; recordType: string; aiAssistantId: number; title: string | null; status: string | null; data: unknown },
): Promise<void> {
    const triggerStatus = record.recordType === 'lead' ? 'QUALIFIED'
        : record.recordType === 'meeting' ? 'MEETING_BOOKED'
        : null;
    if (!triggerStatus) return; // enrichment/invoice/ticket don't map to a handoff trigger

    const data = (record.data && typeof record.data === 'object') ? record.data as Record<string, unknown> : {};
    let fields: Record<string, unknown>;

    if (record.recordType === 'meeting') {
        // Meeting handoff — its own field set (summary, time, link, action items). Consumed by
        // CRM record-update recipes (mapped to properties), Slack/Notion summary recipes, or the
        // email_meeting_followup recipe (attendees + the reviewed draft email).
        const summary = data.summary ?? data.meetingSummary ?? data.notes;
        // Assistant display name — used by the follow-up email's AI disclosure footer + From line.
        // Best-effort: the footer falls back to a generic label if the lookup fails.
        let assistantName: string | undefined;
        try {
            const [a] = await db.select({ name: aiAssistants.name }).from(aiAssistants)
                .where(and(eq(aiAssistants.id, record.aiAssistantId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);
            assistantName = a?.name;
        } catch { /* name is best-effort — the email footer degrades to a generic label */ }
        fields = {
            company: data.company ?? record.title ?? undefined,
            contactName: data.contactName ?? data.attendee ?? data.with,
            contactEmail: data.contactEmail ?? data.email ?? data.attendeeEmail,
            meetingTitle: record.title ?? undefined,
            meetingSummary: summary,
            aiSummary: summary, // alias so CRM recipes can map the same text to a notes field
            decisionsMade: data.decisionsMade ?? data.decisions,
            identifiedRisks: data.identifiedRisks ?? data.risks,
            meetingTime: data.meetingTime ?? data.startTime ?? data.scheduledFor ?? data.when ?? data.date,
            meetingLink: data.meetingLink ?? data.link ?? data.joinUrl ?? data.location,
            tasks: data.tasks ?? data.actionItems,
            attendees: data.attendees, // [{name,email}] — emails filled in on the inbox card
            followupEmail: data.followupEmail, // { subject, body } — the reviewed draft
            assistantName,
            attribution: 'Be More Swan',
        };
    } else {
        // Lead handoff.
        fields = {
            company: record.title ?? undefined,
            rating: record.status ?? undefined,
            aiSummary: data.summary ?? data.aiSummary ?? data.reason ?? data.rationale,
            attribution: data.source ?? data.matchedQuery ?? 'Be More Swan',
            contactName: data.contactName ?? data.contact_name,
            contactEmail: data.contactEmail ?? data.email,
            domain: data.domain,
            score: data.score,
        };
        // Leads carry canonical company/contact/score on the linked discovered_leads row.
        try {
            const [dl] = await db.select({
                companyName: discoveredLeads.companyName, domain: discoveredLeads.domain,
                contactName: discoveredLeads.contactName, contactEmail: discoveredLeads.contactEmail,
                score: discoveredLeads.score,
            }).from(discoveredLeads)
                .where(and(eq(discoveredLeads.organisationId, orgId), eq(discoveredLeads.assistantRecordId, record.id)))
                .limit(1);
            if (dl) {
                fields.company = fields.company ?? dl.companyName;
                fields.domain = fields.domain ?? dl.domain;
                fields.contactName = fields.contactName ?? dl.contactName;
                fields.contactEmail = fields.contactEmail ?? dl.contactEmail;
                fields.score = fields.score ?? dl.score;
            }
        } catch { /* discovery not in play for this lead — the record's own data still maps */ }
    }

    const subject: TriggerSubject = { recordType: record.recordType, recordId: record.id, newStatus: triggerStatus, fields };
    await enqueueScenarioTrigger(db, {
        organisationId: orgId,
        assistantId: record.aiAssistantId,
        triggerEvent: 'lead.status_changed',
        subject,
    });
}

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

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

    try {
        if (event.httpMethod === 'GET') {
            const assistantId = Number(event.queryStringParameters?.assistantId);

            // Scheduled-work feed for the assistant Calendar tab: every scheduled record for this
            // assistant (across record types), optionally within a from/to window. No recordType.
            if (event.queryStringParameters?.scheduled) {
                if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });
                const fromParam = event.queryStringParameters?.from;
                const toParam = event.queryStringParameters?.to;
                const from = fromParam ? new Date(fromParam) : null;
                const to = toParam ? new Date(toParam) : null;
                const scheduled = await db
                    .select({
                        id: assistantRecords.id,
                        recordType: assistantRecords.recordType,
                        title: assistantRecords.title,
                        status: assistantRecords.status,
                        scheduledFor: assistantRecords.scheduledFor,
                    })
                    .from(assistantRecords)
                    .where(and(
                        eq(assistantRecords.organisationId, orgId),
                        eq(assistantRecords.aiAssistantId, assistantId),
                        eq(assistantRecords.approvalStatus, 'scheduled'),
                        ...(from && !isNaN(from.getTime()) ? [gte(assistantRecords.scheduledFor, from)] : []),
                        ...(to && !isNaN(to.getTime()) ? [lte(assistantRecords.scheduledFor, to)] : []),
                    ))
                    .orderBy(desc(assistantRecords.scheduledFor));
                return json(200, { records: scheduled });
            }

            const recordType = String(event.queryStringParameters?.recordType || '');
            if (!RECORD_TYPES.has(recordType)) return json(400, { error: 'recordType must be one of lead, enrichment, meeting, invoice, ticket.' });
            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            // Optional approval-gate filter — the Review Queue tab passes ?approvalStatus=pending_approval;
            // the Data Hub tab omits it (shows everything).
            const approvalFilter = event.queryStringParameters?.approvalStatus;
            const APPROVAL_STATES = new Set(['pending_approval', 'approved', 'scheduled', 'rejected']);

            const records = await db
                .select({
                    id: assistantRecords.id,
                    recordType: assistantRecords.recordType,
                    title: assistantRecords.title,
                    status: assistantRecords.status,
                    approvalStatus: assistantRecords.approvalStatus,
                    scheduledFor: assistantRecords.scheduledFor,
                    source: assistantRecords.source,
                    data: assistantRecords.data,
                    createdAt: assistantRecords.createdAt,
                    updatedAt: assistantRecords.updatedAt,
                })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistantId),
                    eq(assistantRecords.recordType, recordType),
                    ...(approvalFilter && APPROVAL_STATES.has(approvalFilter) ? [eq(assistantRecords.approvalStatus, approvalFilter)] : []),
                ))
                .orderBy(desc(assistantRecords.updatedAt));

            // Spreadsheet fallback (Golden Rule 1): export the hub as a flat CSV. Columns are
            // the union of each record's top-level scalar data fields plus the record envelope.
            if (event.queryStringParameters?.format === 'csv') {
                const dataKeys: string[] = [];
                for (const r of records) {
                    if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
                        for (const [k, v] of Object.entries(r.data as Record<string, unknown>)) {
                            if (k === 'type') continue;
                            if ((v === null || ['string', 'number', 'boolean'].includes(typeof v)) && !dataKeys.includes(k)) dataKeys.push(k);
                        }
                    }
                }
                const header = ['title', 'status', 'source', 'createdAt', ...dataKeys];
                const lines = [header.map(csvCell).join(',')];
                for (const r of records) {
                    const d = (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data as Record<string, unknown> : {};
                    lines.push([
                        r.title, r.status, r.source, r.createdAt.toISOString(),
                        ...dataKeys.map((k) => {
                            const v = d[k];
                            return (v === null || v === undefined || typeof v === 'object') ? '' : v;
                        }),
                    ].map(csvCell).join(','));
                }
                return {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'text/csv; charset=utf-8',
                        'Content-Disposition': `attachment; filename="${recordType}s-export.csv"`,
                    },
                    body: lines.join('\r\n'),
                };
            }

            // Meetings carry their per-task sync ledger so the Inbox card can show "N of M synced".
            const enriched = await attachActionItemSync(db, orgId, records);
            return json(200, { records: enriched });
        }

        if (event.httpMethod === 'POST') {
            let body: { assistantId?: number; recordType?: string; source?: string; records?: unknown };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            const assistantId = Number(body.assistantId);
            const recordType = String(body.recordType || '');
            const source = SOURCES.has(String(body.source)) ? String(body.source) : 'csv_import';
            if (!RECORD_TYPES.has(recordType)) return json(400, { error: 'recordType must be one of lead, enrichment, meeting, invoice, ticket.' });
            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            const rows = Array.isArray(body.records) ? body.records : [];
            if (rows.length === 0) return json(400, { error: 'records must be a non-empty array.' });
            if (rows.length > MAX_BULK_RECORDS) return json(400, { error: `Too many records in one request (max ${MAX_BULK_RECORDS}).` });

            const clean: { title: string; status: string | null; data: unknown }[] = [];
            for (const r of rows) {
                if (!r || typeof r !== 'object') continue;
                const rec = r as Record<string, unknown>;
                const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 300) : '';
                if (!title) continue;
                const data = (rec.data && typeof rec.data === 'object') ? rec.data : {};
                if (JSON.stringify(data).length > MAX_DATA_CHARS) return json(400, { error: `Record "${title}" is too large.` });
                clean.push({
                    title,
                    status: typeof rec.status === 'string' && rec.status.trim() ? rec.status.trim().slice(0, 60) : null,
                    data,
                });
            }
            if (clean.length === 0) return json(400, { error: 'No valid records — every record needs a non-empty title.' });

            // Upsert on (assistant, type, title): re-importing or re-processing the same
            // record refreshes it instead of duplicating the hub listing.
            let inserted = 0, updated = 0;
            await db.transaction(async (tx) => {
                for (const rec of clean) {
                    const [existing] = await tx
                        .select({ id: assistantRecords.id })
                        .from(assistantRecords)
                        .where(and(
                            eq(assistantRecords.organisationId, orgId),
                            eq(assistantRecords.aiAssistantId, assistantId),
                            eq(assistantRecords.recordType, recordType),
                            eq(assistantRecords.title, rec.title),
                        ))
                        .limit(1);
                    if (existing) {
                        await tx.update(assistantRecords)
                            .set({ status: rec.status, data: rec.data, source, updatedAt: new Date() })
                            .where(eq(assistantRecords.id, existing.id));
                        updated++;
                    } else {
                        await tx.insert(assistantRecords).values({
                            organisationId: orgId,
                            aiAssistantId: assistantId,
                            recordType,
                            title: rec.title,
                            status: rec.status,
                            // CSV imports are user-supplied → no AI review gate needed. AI-produced
                            // records (source 'chat'/'integration') inherit the pending_approval default.
                            approvalStatus: source === 'csv_import' ? 'approved' : 'pending_approval',
                            source,
                            data: rec.data,
                        });
                        inserted++;
                    }
                }
            });

            return json(200, { inserted, updated });
        }

        if (event.httpMethod === 'PATCH') {
            let body: { id?: number; title?: unknown; status?: unknown; data?: unknown; approvalStatus?: unknown; scheduledFor?: unknown };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
            const id = Number(body.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });

            const patch: Record<string, unknown> = { updatedAt: new Date() };
            if (body.title !== undefined) {
                if (typeof body.title !== 'string' || !body.title.trim()) return json(400, { error: 'title must be a non-empty string.' });
                patch.title = body.title.trim().slice(0, 300);
            }
            if (body.status !== undefined) {
                if (body.status !== null && typeof body.status !== 'string') return json(400, { error: 'status must be a string or null.' });
                patch.status = body.status === null ? null : String(body.status).trim().slice(0, 60);
            }
            if (body.data !== undefined) {
                if (!body.data || typeof body.data !== 'object') return json(400, { error: 'data must be an object.' });
                if (JSON.stringify(body.data).length > MAX_DATA_CHARS) return json(400, { error: 'data payload too large.' });
                patch.data = body.data;
            }
            // Approval-gate transitions (Review Queue): approve / reject / schedule. Scheduling a
            // record requires a scheduled_for and implies approval (so "Approve & Schedule" is one PATCH).
            // When a record FIRST goes live we fire the Integration Scenario Library handoff push —
            // prefetch it here so we can tell a genuine transition from a re-approval / edit.
            let handoffRecord: { id: number; recordType: string; aiAssistantId: number; title: string | null; status: string | null; data: unknown } | null = null;
            if (body.approvalStatus !== undefined) {
                const next = String(body.approvalStatus);
                if (!['pending_approval', 'approved', 'scheduled', 'rejected'].includes(next)) {
                    return json(400, { error: 'approvalStatus must be pending_approval, approved, scheduled or rejected.' });
                }
                patch.approvalStatus = next;
                if (next === 'scheduled') {
                    const when = body.scheduledFor ? new Date(String(body.scheduledFor)) : null;
                    if (!when || isNaN(when.getTime())) return json(400, { error: 'scheduledFor (a valid date) is required to schedule a record.' });
                    patch.scheduledFor = when;
                } else if (next !== 'approved') {
                    // Leaving the scheduled state clears the due date (rejected / sent back to review).
                    patch.scheduledFor = null;
                }

                if (LIVE_APPROVAL.has(next)) {
                    const [prev] = await db.select({
                        id: assistantRecords.id,
                        recordType: assistantRecords.recordType,
                        aiAssistantId: assistantRecords.aiAssistantId,
                        title: assistantRecords.title,
                        status: assistantRecords.status,
                        data: assistantRecords.data,
                        approvalStatus: assistantRecords.approvalStatus,
                    }).from(assistantRecords)
                        .where(and(eq(assistantRecords.id, id), eq(assistantRecords.organisationId, orgId)))
                        .limit(1);
                    // Only a transition INTO live fires the handoff — not an edit of an already-live record.
                    if (prev && !LIVE_APPROVAL.has(prev.approvalStatus ?? '')) {
                        handoffRecord = prev;
                    }
                }
            }

            const [row] = await db.update(assistantRecords)
                .set(patch)
                .where(and(eq(assistantRecords.id, id), eq(assistantRecords.organisationId, orgId)))
                .returning({
                    id: assistantRecords.id,
                    title: assistantRecords.title,
                    status: assistantRecords.status,
                    approvalStatus: assistantRecords.approvalStatus,
                    scheduledFor: assistantRecords.scheduledFor,
                    updatedAt: assistantRecords.updatedAt,
                });
            if (!row) return json(404, { error: 'Record not found.' });

            // Fire the outbound handoff after the approval commits. Uses the latest data (the
            // PATCH may have edited it in the same request).
            if (handoffRecord) {
                const liveRecord = {
                    ...handoffRecord,
                    title: (patch.title as string | undefined) ?? handoffRecord.title,
                    status: (patch.status as string | null | undefined) !== undefined ? (patch.status as string | null) : handoffRecord.status,
                    data: patch.data !== undefined ? patch.data : handoffRecord.data,
                };
                // Phase 3: normalise the meeting's action items BEFORE the handoff enqueues, so the
                // create_tasks recipes have the per-task ledger rows to sync.
                await materialiseActionItems(db, orgId, liveRecord);
                await enqueueHandoffOnApproval(db, orgId, liveRecord);
            }
            return json(200, { record: row });
        }

        if (event.httpMethod === 'DELETE') {
            let body: { id?: number };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
            const id = Number(body.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            const [row] = await db.delete(assistantRecords)
                .where(and(eq(assistantRecords.id, id), eq(assistantRecords.organisationId, orgId)))
                .returning({ id: assistantRecords.id });
            if (!row) return json(404, { error: 'Record not found.' });
            return json(200, { deleted: row.id });
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (err) {
        // Not migrated yet (missing table, or the approval_status/scheduled_for columns before
        // db/assistant-records-approval.sql is applied) — an empty hub beats a 500 on GET.
        const msg = err instanceof Error ? err.message : '';
        if (event.httpMethod === 'GET' && msg.includes('does not exist') && (msg.includes('relation') || msg.includes('column'))) {
            return json(200, { records: [] });
        }
        console.error('[assistant-records]', err);
        return json(500, { error: 'Failed to process the request.' });
    }
};
