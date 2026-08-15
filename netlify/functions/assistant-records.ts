// netlify/functions/assistant-records.ts
// Internal Data Hub API (Golden Rule 2) — CRUD for assistant_records, the tenant
// work products behind the Data Hub tab on assistant-detail.html.
//
//  GET    ?assistantId=<id>&recordType=<type>[&approvalStatus=<s>][&deliverable=1][&format=csv]
//         → { records: [...] } or a CSV download. `deliverable=1` keeps only records that have
//           both a resolvable recipient and a drafted body — see the block comment on the filter.
//  POST   { assistantId, recordType, records: [{ title, status?, data }, ...], source? }
//         → bulk insert (CSV import) or single insert; upserts on (assistant, type, title)
//  PATCH  { id, status?, data? }                            → update one record's lifecycle/state
//  DELETE { id, reason? } | { ids: [...], reason? }         → remove one record, or up to
//         MAX_BULK_DELETE of them; `reason` banks the targeting evidence (leads only)
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
import { recordEvent } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { getIcpSnapshot } from '../../src/utils/icp-snapshot';
import { enqueueLeadHandoff } from '../../src/utils/lead-handoff';
import { recordLeadRejection } from '../../src/utils/lead-reject-feedback';
import { LEAD_RECIPIENT_SQL_PATHS, LEAD_DRAFT_BODY_SQL_PATH } from '../../src/config/lead-recipient';
import { crmDescription, crmHeaders, crmRow, isCrmTarget, splitName, websiteUrl } from '../../src/config/crm-export';
import { withLambda } from '@netlify/aws-lambda-compat';

const RECORD_TYPES = new Set(['lead', 'enrichment', 'meeting', 'invoice', 'ticket']);
const SOURCES = new Set(['chat', 'csv_import', 'integration']);
// Bulk-import ceiling per request — a CSV bigger than this should be split client-side.
const MAX_BULK_RECORDS = 500;
// Serialised size cap per record's data payload (client-supplied, treat as untrusted).
const MAX_DATA_CHARS = 20_000;
// Bulk-delete ceiling per request. Lower than the import ceiling on purpose: each id costs a
// lookup, a discovery-row update and a delete — five round trips at 500 ids would sit close to the
// function timeout, and a delete that times out half-done is the worst thing this endpoint can do.
// The client chunks; going over is a 400, never a silent truncation.
const MAX_BULK_DELETE = 100;

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
        // Lead handoff — delegated to src/utils/lead-handoff.ts, which the Signal Inbox's BATCH
        // approve also calls. Two approval surfaces, one field mapping: keep it that way.
        await enqueueLeadHandoff(db, orgId, record);
        return;
    }

    const subject: TriggerSubject = { recordType: record.recordType, recordId: record.id, newStatus: triggerStatus, fields };
    await enqueueScenarioTrigger(db, {
        organisationId: orgId,
        assistantId: record.aiAssistantId,
        triggerEvent: 'lead.status_changed',
        subject,
    });
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

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

            // ── Optional deliverability filter (?deliverable=1) ──────────────────────────────
            // Stocks the lead Review Queue with the leads that actually have an email awaiting
            // sign-off, rather than every lead the last search happened to find.
            //
            // The complaint that produced this: a search returned 15 leads and Review showed 15,
            // because every promoted lead is inserted `pending_approval` and Review IS that slice.
            // But only a fraction are contactable — enrichment attempts hot/warm leads only and
            // hits roughly one in three — so a queue promising "read this email and send it" was
            // mostly stocked with leads that have no address and, for cold ones, no draft either.
            //
            // ⚠️ Deliberately NOT limited to leads: the param is generic so the predicate has one
            // definition, but callers only pass it for record types where it means something. It
            // is additive — omitted, this behaves exactly as it did before for every record type.
            //
            // Both paths come from src/config/lead-recipient.ts, which also generates the browser
            // copy. Keep the shape of this predicate identical to `isLeadDeliverable` there: the
            // Review badge counts what this returns, and a client that disagreed would render a
            // count beside a list that contradicts it.
            const deliverableOnly = event.queryStringParameters?.deliverable === '1';
            const recipientSql = sql.raw(
                LEAD_RECIPIENT_SQL_PATHS
                    .map((p) => `NULLIF(BTRIM(data #>> '${p}'), '')`)
                    .join(', '),
            );
            const deliverableWhere = sql`COALESCE(${recipientSql}) IS NOT NULL
                AND ${sql.raw(`NULLIF(BTRIM(data #>> '${LEAD_DRAFT_BODY_SQL_PATH}'), '')`)} IS NOT NULL`;

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
                    ...(deliverableOnly ? [deliverableWhere] : []),
                ))
                .orderBy(desc(assistantRecords.updatedAt));

            // CRM-shaped lead export (Phase 2 item 12). Same rows as the generic CSV below, with
            // the column headers HubSpot's and Salesforce's importers auto-match — see
            // src/config/crm-export.ts for what is deliberately left out and why.
            //
            // ⚠️ The website comes from `discovered_leads`, NOT from the record. A promoted lead's
            // `data` is its scoring card (discovery-scoring.ts `normaliseLeadCard` returns a closed
            // shape), which carries no domain and no contact name at all — so shaping the headers
            // alone would ship a Website column that is empty on every discovery-found lead, which
            // is the single most valuable column in a CRM import after the address. One extra query
            // per export, on the CSV path only.
            const crmTarget = event.queryStringParameters?.crm;
            if (event.queryStringParameters?.format === 'csv' && isCrmTarget(crmTarget) && recordType === 'lead') {
                const ids = records.map((r) => r.id);
                const discovery = ids.length
                    ? await db
                        .select({
                            assistantRecordId: discoveredLeads.assistantRecordId,
                            domain: discoveredLeads.domain,
                            contactName: discoveredLeads.contactName,
                        })
                        .from(discoveredLeads)
                        .where(and(
                            eq(discoveredLeads.organisationId, orgId),
                            inArray(discoveredLeads.assistantRecordId, ids),
                        ))
                    : [];
                const byRecord = new Map(discovery.map((d) => [d.assistantRecordId, d]));

                const lines = [crmHeaders(crmTarget).map(csvCell).join(',')];
                for (const r of records) {
                    const d = (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data as Record<string, unknown> : {};
                    const found = byRecord.get(r.id);
                    // A CSV-imported or hand-added lead has no discovery row, but may well carry
                    // these on the record itself — prefer whichever exists rather than assuming one
                    // provenance. `website` is what the import template calls the column.
                    const name = (typeof d.contactName === 'string' && d.contactName.trim())
                        ? d.contactName : (found?.contactName ?? '');
                    const domain = (typeof d.website === 'string' && d.website.trim())
                        ? d.website : (found?.domain ?? '');
                    // Everything the row knows that has nowhere else to go. The approval state is
                    // here rather than in a status column on purpose: as prose it can never be an
                    // invalid picklist value and fail the import.
                    const description = crmDescription({
                        score: d.score, reasons: d.reasons,
                        nextStep: d.suggestedNextStep, approvalStatus: r.approvalStatus,
                    });

                    lines.push(crmRow(crmTarget, {
                        company: r.title ?? '',
                        ...splitName(name),
                        email: typeof d.contactEmail === 'string' ? d.contactEmail : '',
                        website: websiteUrl(domain),
                        industry: typeof d.industry === 'string' ? d.industry : '',
                        rating: r.status ?? '',
                        description,
                    }).map(csvCell).join(','));
                }
                return {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'text/csv; charset=utf-8',
                        'Content-Disposition': `attachment; filename="leads-${crmTarget}.csv"`,
                    },
                    body: lines.join('\r\n'),
                };
            }

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

            // Phase 2 item 11. The Contact column shows "Checking…" for any hot/warm lead with no
            // attempt stamp — true only while something is actually scraping. `enrichBatch()` runs
            // per JOB, so once every job on a lead's campaign is terminal, nothing will ever visit
            // it and the chip was promising work that will never happen. One query per request,
            // lead hubs only; every other record type is unaffected and pays nothing.
            //
            // ⚠️ 'queued' counts as LIVE. A sliced discovery run rests at queued between slices and
            // spends most of its life there, so treating it as terminal would flip every in-flight
            // lead to "Not attempted" mid-run — the opposite lie, and a more convincing one.
            if (recordType === 'lead' && enriched.length) {
                const live = await db.execute<{ assistant_record_id: number }>(
                    `SELECT DISTINCT dl.assistant_record_id
                       FROM discovered_leads dl
                       JOIN discovery_jobs j ON j.campaign_id = dl.campaign_id
                      WHERE dl.organisation_id = ${orgId}
                        AND dl.assistant_record_id IS NOT NULL
                        AND j.status IN ('queued','processing')`,
                );
                const inFlight = new Set(live.map((r) => r.assistant_record_id));
                return json(200, {
                    records: enriched.map((r) => ({ ...r, enrichmentInFlight: inFlight.has(r.id) })),
                });
            }
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

                // Read the row before the update whenever the approval gate is being moved. This
                // used to be fetched only for LIVE_APPROVAL (the handoff case); the revenue ledger
                // also needs it for REJECTIONS, and both need the PREVIOUS status to tell a genuine
                // transition from an edit of an already-decided record.
                if (LIVE_APPROVAL.has(next) || next === 'rejected') {
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
                    if (LIVE_APPROVAL.has(next) && prev && !LIVE_APPROVAL.has(prev.approvalStatus ?? '')) {
                        handoffRecord = prev;
                    }

                    // Revenue ledger (Phase 0) — LEAD records only. assistant_records is shared by
                    // six roles; a meeting or invoice approval is not a revenue fact and must not
                    // land in a table whose whole purpose is lead win/loss aggregation.
                    const wasDecided = LIVE_APPROVAL.has(prev?.approvalStatus ?? '') || prev?.approvalStatus === 'rejected';
                    if (prev && prev.recordType === 'lead' && !wasDecided) {
                        // Link back to the discovery row when one exists. A manually-added lead has
                        // none, so this is legitimately null rather than a lookup failure.
                        const [link] = await db.select({ id: discoveredLeads.id })
                            .from(discoveredLeads)
                            .where(eq(discoveredLeads.assistantRecordId, prev.id))
                            .limit(1);
                        // actor 'user': this is the human gate — the one decision in the pipeline
                        // that is definitionally a person's, and the baseline every autonomy
                        // increase is later measured against.
                        await recordEvent(db, next === 'rejected' ? 'lead_rejected' : 'lead_approved', {
                            organisationId: orgId,
                            aiAssistantId: prev.aiAssistantId,
                            discoveredLeadId: link?.id ?? null,
                            assistantRecordId: prev.id,
                            actor: 'user',
                            actorUserId: userId,
                            blueprintVersion: await getBlueprintVersion(db, prev.aiAssistantId),
                            // Campaign snapshot via the lead when there is one; the assistant's
                            // onboarding otherwise. A manually added lead legitimately gets the
                            // weaker attribution rather than none.
                            icpSnapshot: await getIcpSnapshot(db, {
                                discoveredLeadId: link?.id ?? null,
                                aiAssistantId: prev.aiAssistantId,
                            }),
                            payload: { from: prev.approvalStatus, to: next, rating: prev.status },
                        });
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
            let body: { id?: number; ids?: unknown; reason?: unknown };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

            // ── One record or many, through the SAME code ────────────────────────────────
            // The Leads tab can now select rows and clear them in one go, which is how a user
            // works through a search that came back mostly junk. That must not become a second
            // delete implementation: everything below — the ownership check, the evidence write,
            // the discovery-row status, and the ORDER of all three — is the whole value of this
            // handler, and a bulk path that skipped any of it would silently destroy exactly the
            // targeting signal the single path was built to keep. So `ids` is just a loop over the
            // one-record body.
            //
            // Capped, and REFUSED rather than truncated past the cap. Silently deleting 200 of the
            // 500 rows someone selected, and reporting success, is the worst available answer; the
            // client chunks instead.
            const idList = Array.isArray(body.ids)
                ? [...new Set((body.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n)))]
                : [];
            const bulk = Array.isArray(body.ids);
            if (bulk && idList.length > MAX_BULK_DELETE) {
                return json(400, { error: `Delete up to ${MAX_BULK_DELETE} records at a time.` });
            }
            const ids = bulk ? idList : (Number.isInteger(Number(body.id)) ? [Number(body.id)] : []);
            if (!ids.length) return json(400, { error: 'id is required.' });

            const deletedIds: number[] = [];
            let feedbackRecorded = false;
            let feedbackCount = 0;
            let notFound = 0;

            for (const id of ids) {
                // ── Everything below runs BEFORE the delete, and that ordering is load-bearing ──
                //
                // `discovered_leads.assistant_record_id` is ON DELETE SET NULL (db/schema.ts), so the
                // moment this record goes, the link back to its discovery row is gone with it. That is
                // how a prod assistant ended up with 35 discovered leads all marked 'promoted' and only
                // 14 still linked: 21 records were deleted by hand, and each one silently severed its
                // own provenance while leaving the discovery row claiming it had been promoted.
                //
                // Two consequences, both fixed here:
                //   1. recordLeadRejection() resolves provenance BY assistant_record_id, so a reason
                //      captured after the delete could never find the lead, the campaign, or the domain.
                //   2. The discovery row's status must move to its real terminal state. 'discarded' is
                //      already in the CHECK constraint; leaving it at 'promoted' with a null link makes
                //      the lifecycle vocabulary describe something that is no longer true.
                const [existing] = await db.select({
                    id: assistantRecords.id,
                    recordType: assistantRecords.recordType,
                    aiAssistantId: assistantRecords.aiAssistantId,
                }).from(assistantRecords)
                    .where(and(eq(assistantRecords.id, id), eq(assistantRecords.organisationId, orgId)))
                    .limit(1);
                // A single delete of something that is not yours (or is already gone) is a 404. In a
                // bulk run it is counted and skipped: the other 49 rows the user selected are theirs,
                // and failing all of them because one had already been deleted in another tab would be
                // a worse answer than doing the work and saying what was missing.
                if (!existing) {
                    if (!bulk) return json(404, { error: 'Record not found.' });
                    notFound++;
                    continue;
                }

                if (existing.recordType === 'lead') {
                    // Optional: deleting is a decision the user has already made, and a reason they
                    // decline to give must never block it. An unknown value is dropped by
                    // recordLeadRejection (closed vocabulary), which logs the offending value.
                    const reason = typeof body.reason === 'string' ? body.reason : '';
                    if (reason) {
                        const result = await recordLeadRejection(db, {
                            organisationId: orgId,
                            aiAssistantId: existing.aiAssistantId,
                            assistantRecordId: existing.id,
                            reason,
                        });
                        if (result.id !== null) { feedbackRecorded = true; feedbackCount++; }
                    }

                    // Mark the discovery row discarded whether or not a reason was given — the state
                    // is a fact about the row, not about how thoughtfully it was removed.
                    await db.update(discoveredLeads)
                        .set({ status: 'discarded', updatedAt: new Date() })
                        .where(and(
                            eq(discoveredLeads.assistantRecordId, existing.id),
                            eq(discoveredLeads.organisationId, orgId),
                        ));
                }

                const [row] = await db.delete(assistantRecords)
                    .where(and(eq(assistantRecords.id, id), eq(assistantRecords.organisationId, orgId)))
                    .returning({ id: assistantRecords.id });
                if (!row) {
                    if (!bulk) return json(404, { error: 'Record not found.' });
                    notFound++;
                    continue;
                }
                deletedIds.push(row.id);
            }

            // `deleted` stays the single id on the single path — nothing in the app reads it, but
            // the shape is the one the endpoint has always returned and there is no reason to
            // churn it. The bulk path reports what actually happened, all three numbers, because
            // "50 selected, 48 deleted, 2 were already gone" is a sentence the client has to be
            // able to write.
            return bulk
                ? json(200, { deleted: deletedIds, count: deletedIds.length, feedbackRecorded: feedbackCount, notFound })
                : json(200, { deleted: deletedIds[0], feedbackRecorded });
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
});
