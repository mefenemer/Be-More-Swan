// netlify/functions/lead-threads.ts
// The Conversations read API — the human-facing surface over Phase 2's lead_threads /
// lead_messages (docs/lead-generator-revenue-engine-plan.md §5.1-5.2).
//
//   POST { action: 'list',   assistantId, state?, cursor? }
//        → { threads: ThreadSummary[], counts, nextCursor }
//   POST { action: 'get',    assistantId, threadId }
//        → { thread, messages: Message[], enrolment }
//   POST { action: 'nudge',  assistantId, threadId }
//        → { ok, sent, enrolment }        — bring the next chaser forward to now
//   POST { action: 'stop_follow_ups', assistantId, threadId }
//        → { ok, enrolment }              — stop the cadence, permanently
//   POST { action: 'calendar', assistantId, from?, to? }
//        → { followUps: PendingFollowUp[] } — the chasers DUE in a window, for the Calendar tab
//   POST { action: 'reschedule_follow_up', assistantId, threadId, nextSendAt }
//        → { ok, enrolment }              — move the next chaser; the past is refused
//
// ── Read-only ABOUT THE THREAD, deliberately ──────────────────────────────────
// Everything that WRITES lead_threads / lead_messages has exactly one owner: src/utils/lead-threads.ts,
// for the same reason recordEvent() is the only ledger writer. That has not changed, and this
// function must not become a second writer of those tables — it projects what they recorded.
//
// The two actions added above write `sequence_enrolments`, which is a DIFFERENT table with a
// different owner (src/utils/outreach-sequences.ts), and they go through that owner's helpers
// rather than issuing their own UPDATEs. They are here because of a gap users hit immediately:
// the follow-up cadence was entirely automatic with no handle on it anywhere in the product, so
// "where do chaser emails come from?" and "they told me to stop by phone" had no answer and no
// control. A worker that can only be waited on is not a feature the user has.
//
// ── The gap this closes ───────────────────────────────────────────────────────
// Phase 2a shipped the reply path and Phase 2b the sequence engine, both server-side, with NO
// surface that renders a thread. Outreach could be sent, replied to, classified and halted and a
// user could see none of it. That is what this reads back.

import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, assistantRecords, leadMessages, leadThreads, sequenceEnrolments, users,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { haltReasonLabel } from '../../src/config/outreach-sequences';
import { haltEnrolment } from '../../src/utils/outreach-sequences';
import { drainSequenceSends } from './process-sequence-sends';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * One page of threads. Threads are far lower-volume than signals, so this is generous.
 *
 * ⚠️ Raised from 40 to 200 when the Conversations tab gained client-side filtering, sorting and
 * grouping. Those controls compare the RENDERED cell across every conversation the client holds —
 * so a small server page silently redefines "filter to Replied" as "filter to Replied among the
 * forty most recent", which is the failure mode where the strip says 3 and the truth is 40. The
 * client drains the cursor to a cap of its own and says so when it hits it; this size just makes
 * that drain one request instead of five.
 */
const PAGE_SIZE = 200;

/** Excerpt length for the list view. Full bodies are only ever pulled by `get`. */
const EXCERPT_CHARS = 180;

/**
 * The deal outcome off a lead record's `data`, or null.
 *
 * ⚠️ Lifts ONE key rather than returning `data` wholesale. The rest of it — the outreach draft,
 * the scoring rationale, the contact provenance — is nothing this screen renders, and this is the
 * response that already has to be careful about what it selects (`reply_token` is never in it).
 *
 * Null is returned for all three of "nothing recorded yet", "no linked record" and "data is not an
 * object", because the screen treats them identically: there is no outcome to show.
 *
 * ⚠️ This is the CURRENT outcome as stamped on the record, which is the latest one — correcting an
 * outcome overwrites `data.dealOutcome` while APPENDING a second row to the revenue ledger. Any
 * aggregate reading the ledger must take the latest terminal event per record itself.
 */
function dealOutcomeOf(data: unknown): Record<string, unknown> | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const outcome = (data as Record<string, unknown>).dealOutcome;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
    return outcome as Record<string, unknown>;
}

/**
 * The lead's running notes off its record `data`, or ''.
 *
 * Lifted for the same reason `dealOutcome` is, and with the same restraint — one key, never the
 * whole blob. The Conversations tab is where a user learns the things notes are FOR ("they rang
 * back", "wrong contact, try the founder"), and until this shipped the only way to write one down
 * was to leave the conversation and find the lead on another tab. lead-generation.ts `add_note`
 * appends; this only reads what it stored, so the two cannot disagree about the format.
 */
function notesOf(data: unknown): string {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
    const notes = (data as Record<string, unknown>).notes;
    return typeof notes === 'string' ? notes : '';
}

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

    let body: {
        action?: string; assistantId?: number; threadId?: number; state?: string; cursor?: string;
        from?: string; to?: string; nextSendAt?: string;
    };
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
                    // Same one key as `get` lifts (see dealOutcomeOf) — on the list it answers
                    // "which of these are closed out?" without opening each one, which is the
                    // question that makes a list of conversations navigable at all.
                    recordData: assistantRecords.data,
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
                        dealOutcome: dealOutcomeOf(t.recordData),
                        // The list carries the notes too, so opening a row can offer "Add note"
                        // (and show what is already there) without a second round trip per row.
                        notes: notesOf(t.recordData),
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

        // ── calendar ──────────────────────────────────────────────────────────
        // Every follow-up this assistant is going to SEND in a date window — the Calendar tab's
        // pending-outreach chips.
        //
        // ⚠️ This is a different fact from the chips the calendar already drew. Those come from
        // assistant_records (`approval_status='scheduled'`), and for a lead `scheduled_for` is the
        // CHASE REMINDER: the opening email has already gone out and the date is a prompt for a
        // human. Nothing sends on it. The rows below are the opposite — `next_send_at` IS the
        // worker's queue (process-sequence-sends.ts claims on it), so each one is an email that
        // will actually be delivered on that date unless something stops it.
        //
        // Active enrolments only, and only ones with a date. A halted/completed row has
        // next_send_at NULL by invariant, so the state filter is belt-and-braces against a row
        // that broke it — a terminal enrolment drawn on a calendar is a send that is never coming.
        if (action === 'calendar') {
            const from = body.from ? new Date(String(body.from)) : null;
            const to = body.to ? new Date(String(body.to)) : null;
            if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
                return json(400, { error: 'from/to must be valid dates.' });
            }

            const rows = await db
                .select({
                    enrolmentId: sequenceEnrolments.id,
                    threadId: sequenceEnrolments.leadThreadId,
                    assistantRecordId: sequenceEnrolments.assistantRecordId,
                    contactEmail: sequenceEnrolments.contactEmail,
                    lastStepSent: sequenceEnrolments.lastStepSent,
                    nextSendAt: sequenceEnrolments.nextSendAt,
                    threadState: leadThreads.state,
                    threadContactEmail: leadThreads.contactEmail,
                    recordTitle: assistantRecords.title,
                })
                .from(sequenceEnrolments)
                // ⚠️ INNER join to the thread. The ASSISTANT scope lives there, the same reason
                // nudge/stop join it rather than reading the enrolment alone.
                .innerJoin(leadThreads, eq(leadThreads.id, sequenceEnrolments.leadThreadId))
                .leftJoin(assistantRecords, eq(assistantRecords.id, sequenceEnrolments.assistantRecordId))
                .where(and(
                    eq(sequenceEnrolments.organisationId, orgId),
                    eq(leadThreads.aiAssistantId, assistantId),
                    eq(sequenceEnrolments.state, 'active'),
                    sql`${sequenceEnrolments.nextSendAt} IS NOT NULL`,
                    ...(from ? [gte(sequenceEnrolments.nextSendAt, from)] : []),
                    ...(to ? [lte(sequenceEnrolments.nextSendAt, to)] : []),
                ))
                .orderBy(sequenceEnrolments.nextSendAt);

            return json(200, {
                followUps: rows.map((r) => ({
                    enrolmentId: r.enrolmentId,
                    threadId: r.threadId,
                    assistantRecordId: r.assistantRecordId,
                    // Same fallback chain the list action uses: a thread whose record was deleted
                    // still has to be identifiable on the grid.
                    title: r.recordTitle || r.contactEmail || r.threadContactEmail || `Thread #${r.threadId}`,
                    contactEmail: r.contactEmail || r.threadContactEmail,
                    // The step this send WILL be, not the one already sent. The user is looking at
                    // a future email; numbering it by what has gone is off by one on every chip.
                    nextStep: (r.lastStepSent ?? 0) + 1,
                    lastStepSent: r.lastStepSent ?? 0,
                    nextSendAt: r.nextSendAt?.toISOString() ?? null,
                    // The worker refuses to send into a thread that is no longer 'open'. A chip for
                    // one of those is drawn, but drawn as blocked rather than as a pending send.
                    threadState: r.threadState,
                })),
            });
        }

        // ── reschedule_follow_up ──────────────────────────────────────────────
        // Move the next chaser to another moment — the Calendar tab's drag-and-drop.
        //
        // The mirror image of `nudge`, which is the same one-column write pinned to now(). Every
        // safety gate stays exactly where it was: this only says WHEN the worker should next look
        // at this row, and the worker re-checks the reply halt, suppression, do-not-contact, the
        // per-org daily ceiling and the step ceiling when it gets there. Moving a date can
        // therefore never cause a send that would otherwise have been refused.
        //
        // ⚠️ The past is refused server-side, not only in the UI. `next_send_at` is a due-date
        // queue — a date behind now() means "send on the next tick", so accepting one would quietly
        // turn a mis-drop into an immediate cold email. The client shows the same rule as a dialog
        // before it ever gets here; this is what makes the rule true rather than merely displayed.
        if (action === 'reschedule_follow_up') {
            const threadId = Number(body.threadId);
            if (!Number.isInteger(threadId) || threadId <= 0) {
                return json(400, { error: 'A threadId is required.' });
            }
            const when = body.nextSendAt ? new Date(String(body.nextSendAt)) : null;
            if (!when || isNaN(when.getTime())) {
                return json(400, { error: 'nextSendAt (a valid date) is required.' });
            }
            // A minute of slack, so a drop onto today at a time that has just ticked past is not
            // rejected for being a few seconds old.
            if (when.getTime() < Date.now() - 60_000) {
                return json(400, {
                    error: 'A follow-up email cannot be scheduled in the past.',
                    code: 'PAST_DATE',
                });
            }

            const [row] = await db
                .select({
                    enrolmentId: sequenceEnrolments.id,
                    enrolmentState: sequenceEnrolments.state,
                    lastStepSent: sequenceEnrolments.lastStepSent,
                    threadState: leadThreads.state,
                })
                .from(leadThreads)
                .leftJoin(sequenceEnrolments, eq(sequenceEnrolments.leadThreadId, leadThreads.id))
                .where(and(
                    eq(leadThreads.id, threadId),
                    eq(leadThreads.organisationId, orgId),
                    eq(leadThreads.aiAssistantId, assistantId),
                ))
                .limit(1);

            if (!row) return json(404, { error: 'Conversation not found.' });
            if (!row.enrolmentId) {
                return json(409, {
                    error: 'There is no follow-up sequence on this conversation.',
                    code: 'NOT_ENROLLED',
                });
            }
            if (row.enrolmentState !== 'active') {
                return json(409, {
                    error: 'Follow-ups on this conversation have stopped, so there is no next one to move.',
                    code: 'NOT_ACTIVE',
                });
            }

            await db.update(sequenceEnrolments)
                .set({ nextSendAt: when, updatedAt: new Date() })
                .where(eq(sequenceEnrolments.id, row.enrolmentId));

            return json(200, {
                ok: true,
                enrolment: {
                    state: row.enrolmentState,
                    lastStepSent: row.lastStepSent ?? 0,
                    nextSendAt: when.toISOString(),
                },
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
                    // For the "Record outcome" control on the thread. Only `dealOutcome` is lifted
                    // out below — the rest of a lead's `data` (the outreach draft, the scoring
                    // rationale, the contact provenance) has no business on this screen, and this
                    // response is already the one that must not leak `reply_token`.
                    recordData: assistantRecords.data,
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
                    // How this deal ended, if it has. Drives the "Record outcome" / "Change
                    // outcome" control and the banner above it. Null covers three different
                    // things, all of which mean the same to this screen: nothing recorded yet, no
                    // linked record at all, and a `data` blob that isn't an object.
                    dealOutcome: dealOutcomeOf(thread.recordData),
                    notes: notesOf(thread.recordData),
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

        // ── nudge / stop_follow_ups ───────────────────────────────────────────
        // Both act on the thread's sequence enrolment, so they share the lookup.
        if (action === 'nudge' || action === 'stop_follow_ups') {
            const threadId = Number(body.threadId);
            if (!Number.isInteger(threadId) || threadId <= 0) {
                return json(400, { error: 'A threadId is required.' });
            }

            // ⚠️ The thread is joined in rather than the enrolment read on its own. sequence_enrolments
            // carries an organisation_id, but the ASSISTANT scope lives on the thread — without the
            // join, a threadId belonging to another of this org's assistants would be actionable
            // from a page that is not showing it.
            const [row] = await db
                .select({
                    enrolmentId: sequenceEnrolments.id,
                    enrolmentState: sequenceEnrolments.state,
                    lastStepSent: sequenceEnrolments.lastStepSent,
                    assistantRecordId: sequenceEnrolments.assistantRecordId,
                    discoveredLeadId: sequenceEnrolments.discoveredLeadId,
                    threadState: leadThreads.state,
                    contactEmail: leadThreads.contactEmail,
                })
                .from(leadThreads)
                .leftJoin(sequenceEnrolments, eq(sequenceEnrolments.leadThreadId, leadThreads.id))
                .where(and(
                    eq(leadThreads.id, threadId),
                    eq(leadThreads.organisationId, orgId),
                    eq(leadThreads.aiAssistantId, assistantId),
                ))
                .limit(1);

            if (!row) return json(404, { error: 'Conversation not found.' });
            if (!row.enrolmentId) {
                // No cadence was ever started on this conversation — a lead emailed manually, or one
                // whose enrolment was never created. Saying so beats a generic failure: there is
                // nothing broken and nothing to retry.
                return json(409, {
                    error: 'There is no follow-up sequence on this conversation.',
                    code: 'NOT_ENROLLED',
                });
            }

            const ref = {
                id: row.enrolmentId,
                organisationId: orgId,
                aiAssistantId: assistantId,
                assistantRecordId: row.assistantRecordId ?? null,
                discoveredLeadId: row.discoveredLeadId ?? null,
                lastStepSent: row.lastStepSent ?? 0,
            };

            if (action === 'stop_follow_ups') {
                if (row.enrolmentState !== 'active') {
                    return json(409, { error: 'Follow-ups on this conversation have already stopped.', code: 'NOT_ACTIVE' });
                }
                // 'manual' is the closed vocabulary's own key for "a human stopped it", and
                // haltEnrolment writes the sequence_halted ledger row with actor 'user'. Never
                // invent a reason string here — the CHECK constraint would reject the row and the
                // halt would be lost, leaving an active enrolment that keeps sending.
                const ok = await haltEnrolment(db, ref, 'manual', null);
                if (!ok) return json(502, { error: 'Could not stop the follow-ups — please try again.' });
                return json(200, { ok: true, enrolment: { state: 'halted', haltReason: 'manual', haltReasonLabel: haltReasonLabel('manual'), lastStepSent: ref.lastStepSent, nextSendAt: null } });
            }

            // ── nudge ─────────────────────────────────────────────────────────
            if (row.enrolmentState !== 'active') {
                return json(409, { error: 'Follow-ups on this conversation have stopped, so there is no next one to send.', code: 'NOT_ACTIVE' });
            }
            // The worker refuses to send into a thread that is no longer 'open' (that is Phase 2a's
            // reply detection acting as 2b's stop condition). Checking here too means the user gets
            // the REASON rather than a button that appears to do nothing.
            if (row.threadState !== 'open') {
                return json(409, { error: 'They have already replied — follow-ups stop once a conversation is live.', code: 'NOT_OPEN' });
            }

            // Bring the next step forward. This is the ONLY thing this action changes: every
            // safety gate the cadence has — the claim lease, the per-(thread,step) idempotency
            // check, the reply halt, the suppression check, the per-org daily ceiling and the
            // per-enrolment step ceiling — is enforced by the worker below, on this row, exactly as
            // it would be on a scheduled tick. A "send now" that bypassed those would be a way to
            // email a suppressed domain by clicking twice.
            await db.update(sequenceEnrolments)
                .set({ nextSendAt: new Date(), updatedAt: new Date() })
                .where(eq(sequenceEnrolments.id, row.enrolmentId));

            // Run the worker inline and AWAIT it. An un-awaited trigger is how jobs get stranded in
            // this codebase; and the whole point of the button is that the user finds out what
            // happened while they are still looking at the screen. The drain carries its own wall-
            // clock budget, and anything it does not reach keeps its place for the hourly cron.
            let sent = 0;
            try {
                ({ sent } = await drainSequenceSends());
            } catch (e) {
                // The row is already due, so the cron will still get it. Report the honest
                // "queued, not sent" rather than failing a request whose write succeeded.
                console.warn('[lead-threads] inline sequence drain failed after nudge', e);
            }

            const [after] = await db
                .select({
                    state: sequenceEnrolments.state,
                    haltReason: sequenceEnrolments.haltReason,
                    lastStepSent: sequenceEnrolments.lastStepSent,
                    nextSendAt: sequenceEnrolments.nextSendAt,
                    lastError: sequenceEnrolments.lastError,
                })
                .from(sequenceEnrolments)
                .where(eq(sequenceEnrolments.id, row.enrolmentId))
                .limit(1);

            // `sent` counts the whole drain, not just this enrolment — the honest signal that OUR
            // follow-up went out is that the step counter moved.
            const advanced = (after?.lastStepSent ?? 0) > (row.lastStepSent ?? 0);
            return json(200, {
                ok: true,
                sent: advanced,
                drainSent: sent,
                enrolment: after ? {
                    state: after.state,
                    haltReason: after.haltReason,
                    haltReasonLabel: haltReasonLabel(after.haltReason),
                    lastStepSent: after.lastStepSent,
                    nextSendAt: after.nextSendAt?.toISOString() ?? null,
                    lastError: after.lastError,
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
