// netlify/functions/lead-threads.ts
// The Conversations read API — the human-facing surface over Phase 2's lead_threads /
// lead_messages (docs/lead-generator-revenue-engine-plan.md §5.1-5.2).
//
//   POST { action: 'list', assistantId, state?, cursor? }
//        → { threads: ThreadSummary[], counts, nextCursor }
//   POST { action: 'get',  assistantId, threadId }
//        → { thread, messages: Message[], enrolment }
//
// ── Read-only, deliberately ───────────────────────────────────────────────────
// Everything that WRITES a thread already has exactly one owner: src/utils/lead-threads.ts, for
// the same reason recordEvent() is the only ledger writer. This function does not take that on —
// it projects what those writers recorded. "Take over thread" / "pause agent" from the mockup are
// state changes and belong with the writer, not here.
//
// ── The gap this closes ───────────────────────────────────────────────────────
// Phase 2a shipped the reply path and Phase 2b the sequence engine, both server-side, with NO
// surface that renders a thread. Outreach could be sent, replied to, classified and halted and a
// user could see none of it. That is what this reads back.

import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, assistantRecords, leadMessages, leadThreads, sequenceEnrolments, users,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { haltReasonLabel } from '../../src/config/outreach-sequences';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** One page of threads. Threads are far lower-volume than signals, so this is generous. */
const PAGE_SIZE = 40;

/** Excerpt length for the list view. Full bodies are only ever pulled by `get`. */
const EXCERPT_CHARS = 180;

/**
 * Composite cursor over (updatedAt, id) — the exact ORDER BY below.
 *
 * updatedAt is the right sort key because src/utils/lead-threads.ts stamps it on every message in
 * either direction, so "most recently active" and "most recently updated" are the same thing. An
 * OFFSET would drift as replies land mid-pagination.
 */
function encodeCursor(c: { updatedAt: string; id: number }): string {
    return Buffer.from(`${c.updatedAt}|${c.id}`, 'utf8').toString('base64url');
}
function decodeCursor(raw: unknown): { updatedAt: Date; id: number } | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const [ts, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
        const d = new Date(ts);
        const n = Number(id);
        if (Number.isNaN(d.getTime()) || !Number.isInteger(n)) return null;
        return { updatedAt: d, id: n };
    } catch { return null; }
}

/** A thread's four states, in the order a user thinks about them. */
const THREAD_STATES = ['open', 'replied', 'stalled', 'closed'] as const;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { action?: string; assistantId?: number; threadId?: number; state?: string; cursor?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const action = String(body.action || 'list');
    const assistantId = Number(body.assistantId);

    // IDOR guard — the assistant instance must belong to the caller's org. Every query below is
    // additionally scoped by organisationId, so a thread id from another tenant reads as missing.
    const [assistant] = await db
        .select({ id: aiAssistants.id, name: aiAssistants.name })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    try {
        // ── list ──────────────────────────────────────────────────────────────
        if (action === 'list') {
            const cursor = decodeCursor(body.cursor);
            const stateFilter = THREAD_STATES.includes(body.state as typeof THREAD_STATES[number])
                ? String(body.state)
                : null;

            const scope = and(
                eq(leadThreads.organisationId, orgId),
                eq(leadThreads.aiAssistantId, assistantId),
            );

            // Counts are over the WHOLE set, not the filtered page — the state chips have to show
            // what you'd get by clicking them, which a count of the current filter cannot tell you.
            const countRows = await db
                .select({ state: leadThreads.state, n: sql<number>`count(*)::int` })
                .from(leadThreads)
                .where(scope)
                .groupBy(leadThreads.state);

            const counts = { total: 0, open: 0, replied: 0, stalled: 0, closed: 0 } as Record<string, number>;
            for (const r of countRows) {
                counts[r.state] = Number(r.n) || 0;
                counts.total += Number(r.n) || 0;
            }

            const rows = await db
                .select({
                    id: leadThreads.id,
                    state: leadThreads.state,
                    channel: leadThreads.channel,
                    contactEmail: leadThreads.contactEmail,
                    lastOutboundAt: leadThreads.lastOutboundAt,
                    lastInboundAt: leadThreads.lastInboundAt,
                    updatedAt: leadThreads.updatedAt,
                    createdAt: leadThreads.createdAt,
                    assistantRecordId: leadThreads.assistantRecordId,
                    recordTitle: assistantRecords.title,
                })
                .from(leadThreads)
                .leftJoin(assistantRecords, eq(assistantRecords.id, leadThreads.assistantRecordId))
                .where(and(
                    scope,
                    ...(stateFilter ? [eq(leadThreads.state, stateFilter)] : []),
                    // Strictly after (updatedAt, id) in the sort order.
                    ...(cursor ? [or(
                        lt(leadThreads.updatedAt, cursor.updatedAt),
                        and(eq(leadThreads.updatedAt, cursor.updatedAt), lt(leadThreads.id, cursor.id)),
                    )!] : []),
                ))
                .orderBy(desc(leadThreads.updatedAt), desc(leadThreads.id))
                .limit(PAGE_SIZE + 1);

            const page = rows.slice(0, PAGE_SIZE);
            const last = page[page.length - 1];
            const nextCursor = rows.length > PAGE_SIZE && last
                ? encodeCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id })
                : null;

            const threadIds = page.map((t) => t.id);

            // Per-thread message rollup in ONE query. `left(body, N)` keeps full message bodies out
            // of the list response entirely — a 40-thread page would otherwise ship every word ever
            // exchanged, and the list only ever renders a one-line preview.
            const msgs = threadIds.length ? await db
                .select({
                    leadThreadId: leadMessages.leadThreadId,
                    direction: leadMessages.direction,
                    classification: leadMessages.classification,
                    sentiment: leadMessages.sentiment,
                    occurredAt: leadMessages.occurredAt,
                    excerpt: sql<string>`left(${leadMessages.body}, ${EXCERPT_CHARS})`,
                })
                .from(leadMessages)
                .where(and(
                    eq(leadMessages.organisationId, orgId),
                    inArray(leadMessages.leadThreadId, threadIds),
                ))
                .orderBy(leadMessages.leadThreadId, leadMessages.occurredAt) : [];

            const rollup = new Map<number, {
                messageCount: number; inboundCount: number;
                lastExcerpt: string; lastDirection: string | null;
                classification: string | null; sentiment: string | null;
            }>();
            for (const m of msgs) {
                const cur = rollup.get(m.leadThreadId) ?? {
                    messageCount: 0, inboundCount: 0, lastExcerpt: '', lastDirection: null,
                    classification: null, sentiment: null,
                };
                cur.messageCount += 1;
                if (m.direction === 'inbound') {
                    cur.inboundCount += 1;
                    // Latest inbound classification wins — it's what the thread means NOW, not what
                    // the first reply happened to say.
                    cur.classification = m.classification ?? cur.classification;
                    cur.sentiment = m.sentiment ?? cur.sentiment;
                }
                // Rows arrive ordered by occurredAt, so the final write is the newest message.
                cur.lastExcerpt = m.excerpt ?? '';
                cur.lastDirection = m.direction;
                rollup.set(m.leadThreadId, cur);
            }

            // Cadence state per thread. sequence_enrolments is unique on lead_thread_id, so this is
            // at most one row each.
            const enrolments = threadIds.length ? await db
                .select({
                    leadThreadId: sequenceEnrolments.leadThreadId,
                    state: sequenceEnrolments.state,
                    haltReason: sequenceEnrolments.haltReason,
                    lastStepSent: sequenceEnrolments.lastStepSent,
                    nextSendAt: sequenceEnrolments.nextSendAt,
                })
                .from(sequenceEnrolments)
                .where(and(
                    eq(sequenceEnrolments.organisationId, orgId),
                    inArray(sequenceEnrolments.leadThreadId, threadIds),
                )) : [];
            const enrolmentByThread = new Map(enrolments.map((e) => [e.leadThreadId, e]));

            return json(200, {
                counts,
                nextCursor,
                threads: page.map((t) => {
                    const r = rollup.get(t.id);
                    const e = enrolmentByThread.get(t.id);
                    return {
                        id: t.id,
                        state: t.state,
                        channel: t.channel,
                        contactEmail: t.contactEmail,
                        // The lead's name. Falls back to the address because a thread opened against
                        // a deleted record still has to be identifiable.
                        title: t.recordTitle || t.contactEmail || `Thread #${t.id}`,
                        assistantRecordId: t.assistantRecordId,
                        messageCount: r?.messageCount ?? 0,
                        inboundCount: r?.inboundCount ?? 0,
                        lastExcerpt: r?.lastExcerpt ?? '',
                        lastDirection: r?.lastDirection ?? null,
                        classification: r?.classification ?? null,
                        sentiment: r?.sentiment ?? null,
                        lastOutboundAt: t.lastOutboundAt?.toISOString() ?? null,
                        lastInboundAt: t.lastInboundAt?.toISOString() ?? null,
                        updatedAt: t.updatedAt.toISOString(),
                        createdAt: t.createdAt.toISOString(),
                        sequence: e ? {
                            state: e.state,
                            haltReason: e.haltReason,
                            haltReasonLabel: haltReasonLabel(e.haltReason),
                            lastStepSent: e.lastStepSent,
                            nextSendAt: e.nextSendAt?.toISOString() ?? null,
                        } : null,
                    };
                }),
            });
        }

        // ── get ───────────────────────────────────────────────────────────────
        if (action === 'get') {
            const threadId = Number(body.threadId);
            if (!Number.isInteger(threadId) || threadId <= 0) {
                return json(400, { error: 'A threadId is required.' });
            }

            const [thread] = await db
                .select({
                    id: leadThreads.id,
                    state: leadThreads.state,
                    channel: leadThreads.channel,
                    contactEmail: leadThreads.contactEmail,
                    lastOutboundAt: leadThreads.lastOutboundAt,
                    lastInboundAt: leadThreads.lastInboundAt,
                    createdAt: leadThreads.createdAt,
                    assistantRecordId: leadThreads.assistantRecordId,
                    recordTitle: assistantRecords.title,
                })
                .from(leadThreads)
                .leftJoin(assistantRecords, eq(assistantRecords.id, leadThreads.assistantRecordId))
                .where(and(
                    eq(leadThreads.id, threadId),
                    eq(leadThreads.organisationId, orgId),
                    eq(leadThreads.aiAssistantId, assistantId),
                ))
                .limit(1);
            if (!thread) return json(404, { error: 'Conversation not found.' });

            // replyToken is deliberately NOT selected. It is the inbound alias secret — anyone
            // holding it can post a message into this thread through the Parse endpoint.
            const messages = await db
                .select({
                    id: leadMessages.id,
                    direction: leadMessages.direction,
                    fromEmail: leadMessages.fromEmail,
                    subject: leadMessages.subject,
                    body: leadMessages.body,
                    generatedBody: leadMessages.generatedBody,
                    templateVersion: leadMessages.templateVersion,
                    classification: leadMessages.classification,
                    sentiment: leadMessages.sentiment,
                    objections: leadMessages.objections,
                    occurredAt: leadMessages.occurredAt,
                    editedByName: users.firstName,
                })
                .from(leadMessages)
                .leftJoin(users, eq(users.id, leadMessages.editedBy))
                .where(and(
                    eq(leadMessages.organisationId, orgId),
                    eq(leadMessages.leadThreadId, threadId),
                ))
                .orderBy(leadMessages.occurredAt, leadMessages.id);

            const [enrolment] = await db
                .select({
                    state: sequenceEnrolments.state,
                    haltReason: sequenceEnrolments.haltReason,
                    lastStepSent: sequenceEnrolments.lastStepSent,
                    nextSendAt: sequenceEnrolments.nextSendAt,
                    lastError: sequenceEnrolments.lastError,
                })
                .from(sequenceEnrolments)
                .where(and(
                    eq(sequenceEnrolments.organisationId, orgId),
                    eq(sequenceEnrolments.leadThreadId, threadId),
                ))
                .limit(1);

            return json(200, {
                thread: {
                    id: thread.id,
                    state: thread.state,
                    channel: thread.channel,
                    contactEmail: thread.contactEmail,
                    title: thread.recordTitle || thread.contactEmail || `Thread #${thread.id}`,
                    assistantRecordId: thread.assistantRecordId,
                    lastOutboundAt: thread.lastOutboundAt?.toISOString() ?? null,
                    lastInboundAt: thread.lastInboundAt?.toISOString() ?? null,
                    createdAt: thread.createdAt.toISOString(),
                },
                messages: messages.map((m) => ({
                    id: m.id,
                    direction: m.direction,
                    fromEmail: m.fromEmail,
                    subject: m.subject,
                    body: m.body,
                    // The mockup's "show changes vs template" diff needs both halves; the flag is
                    // what makes an edited message distinguishable at a glance without shipping a
                    // diff algorithm to the client for every message.
                    edited: !!m.generatedBody && m.generatedBody !== m.body,
                    generatedBody: m.generatedBody,
                    editedByName: m.editedByName,
                    templateVersion: m.templateVersion,
                    classification: m.classification,
                    sentiment: m.sentiment,
                    objections: Array.isArray(m.objections) ? m.objections : [],
                    occurredAt: m.occurredAt.toISOString(),
                })),
                enrolment: enrolment ? {
                    state: enrolment.state,
                    haltReason: enrolment.haltReason,
                    haltReasonLabel: haltReasonLabel(enrolment.haltReason),
                    lastStepSent: enrolment.lastStepSent,
                    nextSendAt: enrolment.nextSendAt?.toISOString() ?? null,
                    lastError: enrolment.lastError,
                } : null,
            });
        }

        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        // lead_threads / lead_messages arrive with db/lead-threads.sql and sequence_enrolments with
        // db/outreach-sequences.sql — both MANUAL applies. On an un-migrated environment say so
        // plainly; a generic 502 sends you looking for a bug that isn't there.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('does not exist') && (msg.includes('column') || msg.includes('relation'))) {
            console.error('[lead-threads] schema not migrated — apply db/lead-threads.sql + db/outreach-sequences.sql', err);
            return json(503, { error: 'Conversations are not set up on this environment yet.', code: 'MIGRATION_PENDING' });
        }
        // postgres-js wraps the real failure — "Failed query" alone tells you nothing, read `cause`.
        const pg = err as { code?: string; constraint_name?: string; cause?: unknown };
        console.error('[lead-threads]', { action, orgId, assistantId, pgCode: pg?.code, cause: pg?.cause }, err);
        return json(502, { error: 'Conversations are having trouble right now — please try again.' });
    }
});
