// The Note Taker joins a call itself: the DATABASE half (src/utils/meeting-bot.ts holds the rules,
// meeting-bot-recall.ts talks to Recall). db/z-meeting-bots.sql. docs/note-taker-bot-plan.md §4.
//
//   sendMeetingBot      — the ONE server action that sends a bot (the GUI dialog and the chat card both call it)
//   listMeetingBots / removeMeetingBot
//   applyBotEvent       — a Recall event (webhook or poll) moves the bot on; 'done' hands the transcript to the
//                         meeting pick-up engine as a meeting_imports row (via 'bot'), which writes the minutes
//   pollMeetingBots     — the 15-minute safety net for missed webhooks, plus deleting Recall's media once finished
//   meetingBotSource    — the engine's MeetingSource for bot meetings; chargeBotMeeting — the charge after filing

import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, billingInformation, dpaAcceptances, masterAssistants, meetingBots, meetingImports, organisations, userOrganisations } from '../../db/schema';
import { canAccessAssistant, type AssistantAccess } from './assistant-access';
import { isFeatureEnabled } from './feature-flags';
import {
    BOT_STATUS_WORDS, FINAL_BOT_STATUSES, MEETING_BOT_FLAG, OPEN_BOT_STATUSES, SCHEDULE_AHEAD_MS, chargeUnits, cleanJoinAt, cleanLengthLimit,
    cleanMeetingLink, minutesInCall, nextBotState, recallBotRequest, recallRegionFor, replayBotState, reserveUnits,
    type BotStatePatch, type BotStatus, type RecallRegion,
} from './meeting-bot';
import { createRecallBot, deleteRecallMedia, fetchRecallTranscript, getRecallBot, recallKey, removeRecallBot, RecallError } from './meeting-bot-recall';
import { PICKUP_PLATFORM_LABELS, type MeetingSource, type PickupPlatform } from './meeting-pickup';
import { getTaskCosts } from './task-costs';
import { TASK_LIMIT_MESSAGE, hasTaskCapacity, recordCompletedWork } from './work-metering';

type Db = ReturnType<typeof getDb>;
type BotRow = typeof meetingBots.$inferSelect;

/**
 * The DPA versions that cover meetings the Note Taker joins (clause 13, docs/note-taker-bot-legal.md §4). A workspace must
 * have accepted one before a bot can be sent. 1.2 is drafted but not yet published, so today no workspace can.
 */
export const BOT_DPA_VERSIONS = ['1.2'];

// ── What the GUI and chat see ────────────────────────────────────────────────────────────────────

export interface MeetingBotView {
    id: number;
    assistantId: number | null;
    platform: PickupPlatform;
    platformLabel: string;
    title: string | null;
    meetingUrl: string;
    joinAt: string;
    status: BotStatus;
    statusWords: string;
    statusReason: string | null;
    joinedAt: string | null;
    leftAt: string | null;
    minutesInCall: number | null;
    /** The meeting record in the Inbox, once the minutes are written. */
    recordId: number | null;
}

export function botView(r: BotRow, recordId: number | null = null): MeetingBotView {
    const status = r.status as BotStatus;
    const platform = r.platform as PickupPlatform;
    return {
        id: r.id, assistantId: r.aiAssistantId, platform, platformLabel: PICKUP_PLATFORM_LABELS[platform] ?? platform,
        title: r.title, meetingUrl: r.meetingUrl, joinAt: r.joinAt.toISOString(), status,
        statusWords: BOT_STATUS_WORDS[status] ?? status, statusReason: r.statusReason,
        joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null, leftAt: r.leftAt ? r.leftAt.toISOString() : null,
        minutesInCall: r.minutesInCall, recordId,
    };
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────

export interface SendBotInput {
    organisationId: number;
    userId: number;
    assistantId: number;
    meetingUrl: unknown;
    title?: unknown;
    joinAt?: unknown;
    lengthLimitMinutes?: unknown;
    source: 'link' | 'chat';
}

export type SendBotResult =
    | { ok: true; bot: MeetingBotView; alreadySent: boolean }
    | { ok: false; status: number; code: string; error: string };

const fail = (status: number, code: string, error: string): SendBotResult => ({ ok: false, status, code, error });

export async function hasAcceptedBotDpa(db: Db, organisationId: number): Promise<boolean> {
    const [r] = await db.select({ id: dpaAcceptances.id }).from(dpaAcceptances)
        .where(and(eq(dpaAcceptances.organisationId, organisationId), inArray(dpaAcceptances.version, BOT_DPA_VERSIONS))).limit(1);
    return Boolean(r);
}

/**
 * The Recall region for a WORKSPACE, from its owner's billing country (UK first: no country = EU). The owner, not the
 * sender, so every bot of one workspace runs in one region (review of #769; legal drafts §2).
 */
async function regionFor(db: Db, organisationId: number): Promise<RecallRegion> {
    const [b] = await db.select({ country: billingInformation.country }).from(userOrganisations)
        .innerJoin(billingInformation, eq(billingInformation.userId, userOrganisations.userId))
        .where(and(eq(userOrganisations.organisationId, organisationId), eq(userOrganisations.role, 'owner')))
        .limit(1).catch(() => [] as { country: string | null }[]);
    return recallRegionFor(b?.country ?? null);
}

/**
 * The partial unique index's condition (z-meeting-bots.sql), as the insert's ON CONFLICT predicate so Postgres infers that
 * index. Unqualified on purpose: it must read like the index's own WHERE.
 */
const OPEN_BOT_SQL = sql.raw("status IN ('scheduled', 'joining', 'waiting_room', 'in_call', 'ended')");

export async function sendMeetingBot(db: Db, i: SendBotInput, now: Date = new Date()): Promise<SendBotResult> {
    if (!(await isFeatureEnabled(i.organisationId, MEETING_BOT_FLAG))) return fail(403, 'not_available', 'Sending the Note Taker into a call isn\'t switched on for this workspace yet.');

    const [assistant] = await db.select({ id: aiAssistants.id, lifecycleStatus: aiAssistants.lifecycleStatus, roleKey: masterAssistants.roleKey })
        .from(aiAssistants).leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, i.assistantId), eq(aiAssistants.organisationId, i.organisationId))).limit(1);
    if (!assistant || assistant.roleKey !== 'meeting_note_taker') return fail(404, 'no_assistant', 'Meeting assistant not found in this workspace.');
    if (assistant.lifecycleStatus === 'archived') return fail(409, 'archived', 'This assistant has been archived.');

    if (!(await hasAcceptedBotDpa(db, i.organisationId))) {
        return fail(409, 'dpa_required', 'Your workspace owner needs to accept the updated Data Processing Agreement (version 1.2) before the Note Taker can join calls.');
    }

    const link = cleanMeetingLink(i.meetingUrl);
    if (!link.ok) return fail(400, 'bad_link', link.error);
    const when = cleanJoinAt(i.joinAt, now);
    if (!when.ok) return fail(400, 'bad_time', when.error);
    const title = typeof i.title === 'string' && i.title.trim() ? i.title.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    const lengthLimitMinutes = cleanLengthLimit(i.lengthLimitMinutes);

    // Pressing Send twice sends one bot: the same link, still open, sent in the last few hours (or booked for the same
    // time). "Now" also sees a bot booked for the next 10 minutes (it is about to join this same call), but not a recurring
    // link's LATER booking (next week's standup is a different meeting). Two presses racing past this check still send
    // one: an immediate join is stored on the minute (immediateJoinAt), so the second insert hits the unique index below.
    const [open] = await db.select().from(meetingBots).where(and(
        eq(meetingBots.organisationId, i.organisationId), eq(meetingBots.meetingUrl, link.url),
        inArray(meetingBots.status, [...OPEN_BOT_STATUSES]),
        when.scheduled
            ? eq(meetingBots.joinAt, when.joinAt)
            : and(gt(meetingBots.joinAt, new Date(now.getTime() - 3 * 60 * 60 * 1000)), lte(meetingBots.joinAt, new Date(now.getTime() + SCHEDULE_AHEAD_MS))),
    )).limit(1);
    if (open) return { ok: true, bot: botView(open), alreadySent: true };

    const region = await regionFor(db, i.organisationId);
    if (!recallKey(region)) return fail(503, 'not_configured', 'The Note Taker can\'t join calls right now. Please try again later.');

    // Check before: room in the allowance for the whole length limit (the charge after is by the real minutes).
    const weight = (await getTaskCosts()).weights.meeting_bot_call;
    const reserve = reserveUnits(lengthLimitMinutes, weight);
    if (reserve > 0 && !(await hasTaskCapacity(db, i.organisationId, reserve))) return fail(402, 'task_limit', TASK_LIMIT_MESSAGE);

    const [row] = await db.insert(meetingBots).values({
        organisationId: i.organisationId, aiAssistantId: assistant.id, requestedByUserId: i.userId, source: i.source,
        platform: link.platform, meetingUrl: link.url, title, joinAt: when.joinAt, lengthLimitMinutes, recallRegion: region,
        status: when.scheduled ? 'scheduled' : 'joining', createdAt: now, updatedAt: now,
    }).onConflictDoNothing({ target: [meetingBots.organisationId, meetingBots.meetingUrl, meetingBots.joinAt], where: OPEN_BOT_SQL }).returning();
    if (!row) {
        // Only an OPEN bot can have collided (the index is partial), so this is the press that raced us.
        const [existing] = await db.select().from(meetingBots).where(and(
            eq(meetingBots.organisationId, i.organisationId), eq(meetingBots.meetingUrl, link.url), eq(meetingBots.joinAt, when.joinAt),
            inArray(meetingBots.status, [...OPEN_BOT_STATUSES]))).limit(1);
        if (existing) return { ok: true, bot: botView(existing), alreadySent: true };
        return fail(500, 'not_saved', 'The Note Taker could not be sent. Please try again.');
    }

    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, i.organisationId)).limit(1);
    let recallBotId: string;
    try {
        recallBotId = await createRecallBot(region, recallBotRequest({
            meetingUrl: link.url, businessName: org?.name ?? null, joinAt: when.joinAt, scheduled: when.scheduled,
            lengthLimitMinutes, botRowId: row.id, organisationId: i.organisationId,
        }));
    } catch (err) {
        const reason = err instanceof RecallError ? err.message : 'not_sent';
        await db.update(meetingBots).set({ status: 'failed', statusReason: reason.slice(0, 160), updatedAt: new Date() }).where(eq(meetingBots.id, row.id));
        console.error('[meeting-bot] send failed', { botId: row.id, region, status: err instanceof RecallError ? err.status : null });
        return fail(502, 'recall_refused', 'The Note Taker couldn\'t be sent to that meeting. Check the link and try again.');
    }
    try {
        // Only onto a row that is still open: if Remove was pressed while Recall was answering, the bot is withdrawn
        // rather than left to join a call nobody tracks (review of #769).
        const [saved] = await db.update(meetingBots).set({ recallBotId, updatedAt: new Date() })
            .where(and(eq(meetingBots.id, row.id), inArray(meetingBots.status, [...OPEN_BOT_STATUSES]))).returning();
        if (!saved) {
            await removeRecallBot(region, recallBotId, true).catch(() => null);
            const [now2] = await db.select().from(meetingBots).where(eq(meetingBots.id, row.id)).limit(1);
            return { ok: true, bot: botView(now2 ?? row), alreadySent: false };
        }
        return { ok: true, bot: botView(saved), alreadySent: false };
    } catch (err) {
        // Recall has the bot but we can't record its id, so its events could never be matched: take it back out rather
        // than let an untracked bot join (no minutes, no charge, media never deleted). Review of #769.
        const back = await removeRecallBot(region, recallBotId, true).catch(() => null);
        await db.update(meetingBots).set({ status: 'failed', statusReason: back ? 'not_saved' : 'not_saved_bot_still_sent', updatedAt: new Date() })
            .where(eq(meetingBots.id, row.id)).catch(() => undefined);
        console.error('[meeting-bot] bot sent but its id could not be saved', { botId: row.id, region, withdrawn: back, err: err instanceof Error ? err.message : err });
        return fail(500, 'not_saved', 'The Note Taker could not be sent. Please try again.');
    }
}

// ── Listing and removing ─────────────────────────────────────────────────────────────────────────

/** Booked, live and the last 30 days' bots for one Note Taker, newest first. */
export async function listMeetingBots(db: Db, organisationId: number, assistantId: number, now: Date = new Date()): Promise<MeetingBotView[]> {
    const rows = await db.select({ bot: meetingBots, recordId: meetingImports.recordId }).from(meetingBots)
        .leftJoin(meetingImports, eq(meetingBots.importId, meetingImports.id))
        .where(and(
            eq(meetingBots.organisationId, organisationId), eq(meetingBots.aiAssistantId, assistantId),
            or(inArray(meetingBots.status, [...OPEN_BOT_STATUSES]), gt(meetingBots.joinAt, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))),
        )).orderBy(desc(meetingBots.joinAt)).limit(50);
    return rows.map((r) => botView(r.bot, r.recordId ?? null));
}

export type RemoveBotResult = { ok: true; bot: MeetingBotView } | { ok: false; status: number; error: string };

/**
 * "Cancel" a booked bot or "Remove from call" a live one. A bot already in the call leaves; what it heard is still
 * written up (plan §6), and its state follows from Recall's events.
 */
export async function removeMeetingBot(db: Db, organisationId: number, botId: number, access: AssistantAccess = null): Promise<RemoveBotResult> {
    const [row] = await db.select().from(meetingBots).where(and(eq(meetingBots.id, botId), eq(meetingBots.organisationId, organisationId))).limit(1);
    // A member limited to other assistants can't touch this Note Taker's bots (the request names only a bot id, so
    // requireTenant's assistant check can't see it; review of #769). Same answer as not found: no hint it exists.
    if (!row || (row.aiAssistantId !== null && !canAccessAssistant(access, row.aiAssistantId))) return { ok: false, status: 404, error: 'That Note Taker was not found.' };
    if (!OPEN_BOT_STATUSES.includes(row.status as BotStatus) || row.status === 'ended') return { ok: true, bot: botView(row) };
    // Just sent and Recall hasn't answered yet: there is nothing to withdraw yet, and marking it cancelled now would let
    // the bot join untracked once Recall answers (review of #769). Ask to try again in a moment.
    if (!row.recallBotId && row.createdAt.getTime() > Date.now() - 60_000) {
        return { ok: false, status: 409, error: 'The Note Taker is still being sent. Try again in a moment.' };
    }
    const notJoinedYet = !row.joinedAt;
    let how: 'deleted' | 'left' | null = 'deleted';
    if (row.recallBotId) {
        how = await removeRecallBot(row.recallRegion as RecallRegion, row.recallBotId, notJoinedYet).catch(() => null);
        if (!how) return { ok: false, status: 502, error: 'The Note Taker couldn\'t be taken out of the call. Please try again, or remove it from the meeting yourself.' };
    }
    // Only a bot Recall deleted is cancelled. One that was already on its way in was asked to LEAVE: it may have heard
    // part of the call, so its own events decide (review of #769: marking it cancelled lost those minutes).
    if (how !== 'deleted') return { ok: true, bot: botView(row) };
    const [saved] = await db.update(meetingBots).set({ status: 'cancelled', statusReason: 'cancelled_by_user', updatedAt: new Date() })
        .where(and(eq(meetingBots.id, row.id), inArray(meetingBots.status, ['scheduled', 'joining', 'waiting_room']))).returning();
    return { ok: true, bot: botView(saved ?? row) };
}

// ── Recall's events ──────────────────────────────────────────────────────────────────────────────

export async function loadBotByRecallId(db: Db, region: RecallRegion, recallBotId: string): Promise<BotRow | null> {
    const [r] = await db.select().from(meetingBots)
        .where(and(eq(meetingBots.recallRegion, region), eq(meetingBots.recallBotId, recallBotId))).limit(1);
    return r ?? null;
}

/** Applies one Recall status to a bot. 'done' after being in the call hands the transcript to the writer. */
export async function applyBotEvent(
    db: Db, row: BotRow, code: string, subCode: string | null | undefined, at: Date,
    dispatch: (importId: number) => Promise<boolean>,
): Promise<BotStatus> {
    const patch = nextBotState({ status: row.status as BotStatus, joinedAt: row.joinedAt, leftAt: row.leftAt, statusReason: row.statusReason }, code, subCode, at);
    return applyBotPatch(db, row, patch, dispatch);
}

/** Saves a worked-out change (one event, or a replay) and hands a finished call to the writer. */
async function applyBotPatch(db: Db, row: BotRow, patch: BotStatePatch | null, dispatch: (importId: number) => Promise<boolean>): Promise<BotStatus> {
    if (!patch) return row.status as BotStatus;
    // Only from the state this patch was worked out from, so two events racing can't move it backwards.
    const [saved] = await db.update(meetingBots).set({
        status: patch.status, statusReason: patch.statusReason, joinedAt: patch.joinedAt, leftAt: patch.leftAt,
        ...(patch.minutesInCall !== null ? { minutesInCall: patch.minutesInCall } : {}), updatedAt: new Date(),
    }).where(and(eq(meetingBots.id, row.id), eq(meetingBots.status, row.status))).returning();
    if (!saved) return row.status as BotStatus;
    if (saved.status === 'done' && saved.joinedAt) await ensureBotImport(db, saved, dispatch);
    return saved.status as BotStatus;
}

export const botExternalId = (region: string, recallBotId: string) => `recall:${region}:${recallBotId}`;

export function parseBotExternalId(externalId: string): { region: RecallRegion; recallBotId: string } | null {
    const m = /^recall:(eu|us):(.+)$/.exec(externalId);
    return m ? { region: m[1] as RecallRegion, recallBotId: m[2] } : null;
}

/** The meeting the engine writes up, once per bot (the import's unique key holds that). */
export async function ensureBotImport(db: Db, row: BotRow, dispatch: (importId: number) => Promise<boolean>): Promise<number | null> {
    if (!row.recallBotId) return null;
    const externalId = botExternalId(row.recallRegion, row.recallBotId);
    const [added] = await db.insert(meetingImports).values({
        organisationId: row.organisationId, aiAssistantId: row.aiAssistantId, platform: row.platform, externalId, via: 'bot',
        title: row.title, meetingLink: row.meetingUrl, startedAt: row.joinedAt, endedAt: row.leftAt ?? new Date(),
    }).onConflictDoNothing({ target: [meetingImports.organisationId, meetingImports.platform, meetingImports.externalId] })
        .returning({ id: meetingImports.id });
    let importId = added?.id ?? null;
    if (!importId) {
        const [existing] = await db.select({ id: meetingImports.id }).from(meetingImports).where(and(
            eq(meetingImports.organisationId, row.organisationId), eq(meetingImports.platform, row.platform), eq(meetingImports.externalId, externalId))).limit(1);
        importId = existing?.id ?? null;
    }
    if (!importId) return null;
    if (row.importId !== importId) await db.update(meetingBots).set({ importId, updatedAt: new Date() }).where(eq(meetingBots.id, row.id));
    // A hand-off that fails is picked up by the next 15-minute check (the import is 'found').
    if (added) await dispatch(importId).catch(() => false);
    return importId;
}

// ── The 15-minute safety net ─────────────────────────────────────────────────────────────────────

export interface BotPollResult { checked: number; moved: number; imported: number; mediaDeleted: number; errors: number }

/**
 * Catches what a missed webhook would have left: open bots not heard from for 5 minutes are read from Recall; a 'done'
 * bot with no import gets one; a bot that never reached Recall is failed; and Recall's media is deleted once a bot is
 * finished with (minutes written or given up, a bot that never got in, or 24 hours after the call).
 */
/** The poll's share of the scheduled run (Netlify scheduled functions stop at 30 s; the pick-up check runs first). */
export const BOT_POLL_BUDGET_MS = 15_000;
const POLL_BATCH = 5;

export async function pollMeetingBots(db: Db, dispatch: (importId: number) => Promise<boolean>, now: Date = new Date(), budgetMs = BOT_POLL_BUDGET_MS): Promise<BotPollResult> {
    const out: BotPollResult = { checked: 0, moved: 0, imported: 0, mediaDeleted: 0, errors: 0 };
    // Stops starting new Recall calls once its budget is spent, so the run never overruns and every step gets a turn;
    // what is left is picked up next run (oldest-checked first).
    const started = Date.now();
    const timeLeft = () => Date.now() - started < budgetMs;
    const quiet = new Date(now.getTime() - 5 * 60 * 1000);

    await db.update(meetingBots).set({ status: 'failed', statusReason: 'not_sent', updatedAt: now }).where(and(
        isNull(meetingBots.recallBotId), inArray(meetingBots.status, [...OPEN_BOT_STATUSES]), lt(meetingBots.createdAt, new Date(now.getTime() - 10 * 60 * 1000))));

    const open = await db.select().from(meetingBots).where(and(
        isNotNull(meetingBots.recallBotId), inArray(meetingBots.status, [...OPEN_BOT_STATUSES]), lt(meetingBots.updatedAt, quiet),
        or(sql`${meetingBots.status} <> 'scheduled'`, lt(meetingBots.joinAt, now)),
    )).orderBy(meetingBots.updatedAt).limit(50);
    const pollOne = async (row: BotRow) => {
        out.checked++;
        try {
            const bot = await getRecallBot(row.recallRegion as RecallRegion, row.recallBotId!);
            const before = row.status;
            // EVERY change, replayed in order: the last one alone would lose a call whose webhooks were all missed.
            const patch = replayBotState({ status: row.status as BotStatus, joinedAt: row.joinedAt, leftAt: row.leftAt, statusReason: row.statusReason }, bot.changes);
            const after = await applyBotPatch(db, row, patch, dispatch);
            if (after !== before) out.moved++;
            else await db.update(meetingBots).set({ updatedAt: now }).where(and(eq(meetingBots.id, row.id), eq(meetingBots.status, row.status)));
        } catch (err) {
            out.errors++;
            // Moved to the back of the queue, so a bot Recall keeps failing on can't stop the others being checked.
            await db.update(meetingBots).set({ updatedAt: now }).where(eq(meetingBots.id, row.id)).catch(() => undefined);
            console.error('[meeting-bot] poll failed', { botId: row.id, status: err instanceof RecallError ? err.status : null });
        }
    };
    // In small batches (each Recall call may take up to 15 s), never past the budget.
    for (let i = 0; i < open.length && timeLeft(); i += POLL_BATCH) await Promise.all(open.slice(i, i + POLL_BATCH).map(pollOne));

    const orphaned = await db.select().from(meetingBots).where(and(
        eq(meetingBots.status, 'done'), isNotNull(meetingBots.joinedAt), isNull(meetingBots.importId), isNotNull(meetingBots.recallBotId))).limit(25);
    for (const row of orphaned) if (await ensureBotImport(db, row, dispatch).catch(() => null)) out.imported++;
    // Media deletion is cheap and must not starve behind a slow poll: it gets its own short window.
    const mediaStarted = Date.now();

    const finished = await db.select({ bot: meetingBots, importStatus: meetingImports.status }).from(meetingBots)
        .leftJoin(meetingImports, eq(meetingBots.importId, meetingImports.id))
        .where(and(
            isNotNull(meetingBots.recallBotId), isNull(meetingBots.mediaDeletedAt), inArray(meetingBots.status, [...FINAL_BOT_STATUSES]),
            or(
                sql`${meetingBots.status} <> 'done'`,
                inArray(meetingImports.status, ['written', 'skipped', 'failed']),
                lt(meetingBots.updatedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
            ),
        )).limit(25);
    for (let i = 0; i < finished.length && Date.now() - mediaStarted < 5_000; i += POLL_BATCH) {
        const done = await Promise.all(finished.slice(i, i + POLL_BATCH).map(({ bot }) => deleteBotMedia(db, bot)));
        out.mediaDeleted += done.filter(Boolean).length;
    }
    return out;
}

/**
 * Takes a workspace's (or some assistants') bots back from Recall before they would be lost track of: booked or live
 * bots are withdrawn (a booked one is cancelled; a live one leaves), and Recall's media is deleted. Called when a Note
 * Taker is archived or purged and before a workspace is deleted, so a bot booked weeks ahead never joins a call for an
 * assistant or workspace that is gone (review of #769). Never throws; how many bots it touched.
 */
export async function withdrawMeetingBots(db: Db, organisationId: number, assistantIds?: readonly number[]): Promise<number> {
    try {
        if (assistantIds && !assistantIds.length) return 0;
        const rows = await db.select().from(meetingBots).where(and(
            eq(meetingBots.organisationId, organisationId), isNotNull(meetingBots.recallBotId),
            ...(assistantIds ? [inArray(meetingBots.aiAssistantId, [...assistantIds])] : []),
            or(inArray(meetingBots.status, [...OPEN_BOT_STATUSES]), isNull(meetingBots.mediaDeletedAt)),
        ));
        for (const row of rows) {
            if (OPEN_BOT_STATUSES.includes(row.status as BotStatus) && row.status !== 'ended') {
                const how = await removeRecallBot(row.recallRegion as RecallRegion, row.recallBotId!, !row.joinedAt).catch(() => null);
                if (how) await db.update(meetingBots).set({ status: 'cancelled', statusReason: 'assistant_or_workspace_removed', updatedAt: new Date() }).where(eq(meetingBots.id, row.id));
            }
            await deleteBotMedia(db, row).catch(() => false);
        }
        return rows.length;
    } catch (err) {
        console.error('[meeting-bot] withdraw failed', { organisationId, err: err instanceof Error ? err.message : err });
        return 0;
    }
}

/** Deletes Recall's copy of the recording; marks the row once Recall agrees. */
export async function deleteBotMedia(db: Db, row: BotRow): Promise<boolean> {
    if (!row.recallBotId || row.mediaDeletedAt) return false;
    const done = await deleteRecallMedia(row.recallRegion as RecallRegion, row.recallBotId).catch(() => false);
    if (done) await db.update(meetingBots).set({ mediaDeletedAt: new Date(), updatedAt: new Date() }).where(eq(meetingBots.id, row.id));
    return done;
}

// ── The engine's side ────────────────────────────────────────────────────────────────────────────

/**
 * The MeetingSource for bot meetings. It never discovers meetings (the webhook and the poll add them); it only reads a
 * finished bot's transcript for the writer. `platform` is unused: sourceFor matches bot meetings on any platform.
 */
export function meetingBotSource(db: Db): MeetingSource {
    return {
        platform: 'google_meet',
        via: 'bot',
        async accounts() { return []; },
        async account(organisationId) { return { organisationId, assistantId: 0, platform: 'google_meet' }; },
        async listFinished() { return []; },
        async fetchTranscript(account, externalId) {
            const id = parseBotExternalId(externalId);
            if (!id) return null;
            const row = await loadBotByRecallId(db, id.region, id.recallBotId);
            if (!row || row.organisationId !== account.organisationId) return null;
            const t = await fetchRecallTranscript(id.region, id.recallBotId);
            if (t.state !== 'ready') return null;
            return { lines: t.lines, attendees: t.attendees };
        },
    };
}

/** Plan B3: tasks for each started 5 minutes in the call, once the minutes are filed; then Recall's copy is deleted. */
export async function chargeBotMeeting(db: Db, organisationId: number, assistantId: number, importId: number): Promise<void> {
    const [row] = await db.select().from(meetingBots)
        .where(and(eq(meetingBots.importId, importId), eq(meetingBots.organisationId, organisationId))).limit(1);
    if (!row) return;
    const minutes = row.minutesInCall ?? minutesInCall(row.joinedAt, row.leftAt);
    const units = chargeUnits(minutes, (await getTaskCosts()).weights.meeting_bot_call);
    if (units > 0) await recordCompletedWork(db, organisationId, 'meeting_bot_call', { units, ref: `meeting_bot:${row.id}`, assistantId });
    await deleteBotMedia(db, row).catch(() => false);
}
