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
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

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
            const recordType = String(event.queryStringParameters?.recordType || '');
            if (!RECORD_TYPES.has(recordType)) return json(400, { error: 'recordType must be one of lead, enrichment, meeting, invoice, ticket.' });
            if (!(await ownsAssistant(assistantId))) return json(404, { error: 'Assistant not found.' });

            const records = await db
                .select({
                    id: assistantRecords.id,
                    recordType: assistantRecords.recordType,
                    title: assistantRecords.title,
                    status: assistantRecords.status,
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

            return json(200, { records });
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
            let body: { id?: number; status?: unknown; data?: unknown };
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
            const id = Number(body.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });

            const patch: Record<string, unknown> = { updatedAt: new Date() };
            if (body.status !== undefined) {
                if (body.status !== null && typeof body.status !== 'string') return json(400, { error: 'status must be a string or null.' });
                patch.status = body.status === null ? null : String(body.status).trim().slice(0, 60);
            }
            if (body.data !== undefined) {
                if (!body.data || typeof body.data !== 'object') return json(400, { error: 'data must be an object.' });
                if (JSON.stringify(body.data).length > MAX_DATA_CHARS) return json(400, { error: 'data payload too large.' });
                patch.data = body.data;
            }

            const [row] = await db.update(assistantRecords)
                .set(patch)
                .where(and(eq(assistantRecords.id, id), eq(assistantRecords.organisationId, orgId)))
                .returning({ id: assistantRecords.id, status: assistantRecords.status, updatedAt: assistantRecords.updatedAt });
            if (!row) return json(404, { error: 'Record not found.' });
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
        // Table not migrated yet (npm run db:push) — an empty hub beats a 500 on GET.
        const msg = err instanceof Error ? err.message : '';
        if (event.httpMethod === 'GET' && msg.includes('relation') && msg.includes('does not exist')) {
            return json(200, { records: [] });
        }
        console.error('[assistant-records]', err);
        return json(500, { error: 'Failed to process the request.' });
    }
};
