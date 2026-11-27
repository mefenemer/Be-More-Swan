// The database half of meeting pick-up (src/utils/meeting-pickup.ts holds the rules): the meeting_imports store,
// the real writer dependencies, and the hand-off to the background writer. db/z-meeting-imports.sql.

import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, masterAssistants, meetingBots, meetingImports, meetingPickupState } from '../../db/schema';
import { resolveBaseUrl } from './base-url';
import { persistHubRecordsWithTitles } from './hub-records';
import { meetingHubRecord } from './meeting-minutes';
import { writeMeetingMinutes } from './meeting-minutes-writer';
import {
    BOT_BOOKED_EARLY_MS, BOT_MATCH_SLACK_MS, DUE_PER_RUN, LEASE_MS, MEETING_PICKUP_FLAG, PICKUP_CHANNEL_BLOCK, SETTLE_MS, discoverMeetings,
    type ImportRow, type ImportVia, type MeetingSource, type PickupPlatform, type PickupStore, type WriterDeps,
} from './meeting-pickup';
import { googleMeetSource } from './meeting-sources/google-meet';
import { chargeBotMeeting, meetingBotSource, pollMeetingBots } from './meeting-bot-db';
import { BOT_CHANNEL_BLOCK } from './meeting-bot';
import { enforcePromptModeration } from './moderation';
import { isFeatureEnabled } from './feature-flags';
import { getIntegration } from './workspace-integrations';
import { getTaskCosts } from './task-costs';
import { hasTaskCapacity, recordCompletedWork } from './work-metering';

type Db = ReturnType<typeof getDb>;

export interface MeetingAppState {
    provider: 'google_meet';
    connected: boolean;
    /** A row that exists but is not active: needs reconnecting. */
    status: string | null;
    accountName: string | null;
    lastCheckedAt: string | null;
    lastFound: number;
    lastError: string | null;
    /** Meetings written up from this app in the last 30 days. */
    writtenRecently: number;
}

/** What the Connections tab shows per meeting app, or null when pick-up is not switched on for the workspace. */
export async function loadMeetingApps(db: Db, organisationId: number): Promise<MeetingAppState[] | null> {
    if (!(await isFeatureEnabled(organisationId, MEETING_PICKUP_FLAG))) return null;
    const row = await getIntegration(db, organisationId, 'google_meet');
    const [st] = await db.select().from(meetingPickupState)
        .where(and(eq(meetingPickupState.organisationId, organisationId), eq(meetingPickupState.platform, 'google_meet'))).limit(1)
        .catch(() => [] as (typeof meetingPickupState.$inferSelect)[]);
    const [w] = await db.select({ n: sql<number>`count(*)::int` }).from(meetingImports).where(and(
        eq(meetingImports.organisationId, organisationId), eq(meetingImports.platform, 'google_meet'), eq(meetingImports.status, 'written'),
        gt(meetingImports.writtenAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    )).catch(() => [{ n: 0 }]);
    return [{
        provider: 'google_meet',
        connected: row?.status === 'active',
        status: row?.status ?? null,
        accountName: row?.externalAccountName ?? null,
        lastCheckedAt: st?.lastCheckedAt ? st.lastCheckedAt.toISOString() : null,
        lastFound: st?.lastFound ?? 0,
        // A platform error, shown so the owner knows to reconnect; never a transcript.
        lastError: st?.lastError ?? null,
        writtenRecently: w?.n ?? 0,
    }];
}

/**
 * The platforms meetings are picked up from (each one only lists workspaces with the meeting_pickup flag on), plus the
 * Note Taker's own bot (docs/note-taker-bot-plan.md), which only reads transcripts of bots already sent.
 */
export function meetingSources(db: Db): MeetingSource[] {
    return [googleMeetSource(db), meetingBotSource(db)];
}

export function pickupStore(db: Db): PickupStore {
    return {
        async checkedThrough(organisationId, platform) {
            const [r] = await db.select({ through: meetingPickupState.checkedThrough }).from(meetingPickupState)
                .where(and(eq(meetingPickupState.organisationId, organisationId), eq(meetingPickupState.platform, platform))).limit(1);
            return r?.through ?? null;
        },
        async saveCheck(organisationId, platform, s) {
            const set = {
                lastCheckedAt: s.at, lastFound: s.found, lastError: s.error, updatedAt: s.at,
                // A failed check leaves the window where it was, so the next one covers it again.
                ...(s.through ? { checkedThrough: s.through } : {}),
            };
            await db.insert(meetingPickupState).values({ organisationId, platform, ...set })
                .onConflictDoUpdate({ target: [meetingPickupState.organisationId, meetingPickupState.platform], set });
        },
        async addFound(account, meetings) {
            if (!meetings.length) return 0;
            const rows = await db.insert(meetingImports).values(meetings.map((m) => ({
                organisationId: account.organisationId,
                aiAssistantId: account.assistantId,
                platform: account.platform,
                externalId: m.externalId.slice(0, 300),
                title: m.title ? m.title.slice(0, 300) : null,
                meetingLink: m.link ? m.link.slice(0, 500) : null,
                startedAt: m.startedAt ?? null,
                endedAt: m.endedAt,
            }))).onConflictDoNothing({ target: [meetingImports.organisationId, meetingImports.platform, meetingImports.externalId] })
                .returning({ id: meetingImports.id });
            return rows.length;
        },
        async due(now, limit) {
            const rows = await db.select({ id: meetingImports.id }).from(meetingImports).where(and(
                inArray(meetingImports.status, ['found', 'writing']),
                or(isNull(meetingImports.leaseUntil), lt(meetingImports.leaseUntil, now)),
                lt(meetingImports.endedAt, new Date(now.getTime() - SETTLE_MS)),
            )).orderBy(meetingImports.endedAt).limit(limit);
            return rows.map((r) => r.id);
        },
        async claim(id, now) {
            const [r] = await db.update(meetingImports).set({
                status: 'writing', leaseUntil: new Date(now.getTime() + LEASE_MS),
                attempts: sql`${meetingImports.attempts} + 1`, updatedAt: now,
            }).where(and(
                eq(meetingImports.id, id),
                inArray(meetingImports.status, ['found', 'writing']),
                or(isNull(meetingImports.leaseUntil), lt(meetingImports.leaseUntil, now)),
            )).returning();
            if (!r) return null;
            return {
                id: r.id, organisationId: r.organisationId, assistantId: r.aiAssistantId, platform: r.platform as PickupPlatform,
                externalId: r.externalId, title: r.title, link: r.meetingLink, startedAt: r.startedAt, endedAt: r.endedAt, attempts: r.attempts,
                via: (r.via === 'bot' ? 'bot' : 'transcript') as ImportVia,
            } satisfies ImportRow;
        },
        async release(id, r, now) {
            const where = and(eq(meetingImports.id, id), eq(meetingImports.status, 'writing'));
            if (r.status === 'found') {
                await db.update(meetingImports).set({
                    status: 'found', leaseUntil: r.retryAt ?? null, lastError: r.lastError ?? null, updatedAt: now,
                    ...(r.refundAttempt ? { attempts: sql`GREATEST(${meetingImports.attempts} - 1, 0)` } : {}),
                }).where(where);
            } else if (r.status === 'skipped') {
                await db.update(meetingImports).set({ status: 'skipped', skipReason: r.skipReason, leaseUntil: null, updatedAt: now }).where(where);
            } else {
                await db.update(meetingImports).set({ status: 'failed', lastError: r.lastError, leaseUntil: null, updatedAt: now }).where(where);
            }
        },
        async markWritten(id, recordId, now) {
            const rows = await db.update(meetingImports)
                .set({ status: 'written', recordId, writtenAt: now, leaseUntil: null, lastError: null, updatedAt: now })
                .where(and(eq(meetingImports.id, id), eq(meetingImports.status, 'writing')))
                .returning({ id: meetingImports.id });
            return rows.length > 0;
        },
    };
}

export function writerDeps(db: Db, sources: readonly MeetingSource[] = meetingSources(db)): WriterDeps {
    return {
        store: pickupStore(db),
        sources,
        now: () => new Date(),
        async assistant(organisationId, assistantId) {
            const [a] = await db.select({
                id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext,
                lifecycleStatus: aiAssistants.lifecycleStatus, roleKey: masterAssistants.roleKey,
            }).from(aiAssistants)
                .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
            if (!a || a.roleKey !== 'meeting_note_taker' || a.lifecycleStatus === 'archived') return null;
            return { id: a.id, name: a.name, onboardingContext: a.onboardingContext };
        },
        async hasCapacity(organisationId, row) {
            // A bot's meeting: the allowance was checked for its whole length before it was sent.
            if (row.via === 'bot') return true;
            return hasTaskCapacity(db, organisationId, (await getTaskCosts()).weights.meeting_pickup);
        },
        async blocked(organisationId, text) {
            return (await enforcePromptModeration({ text, userId: null, organisationId, source: 'meeting_pickup' })) !== null;
        },
        writeMinutes(organisationId, assistant, message, row) {
            return writeMeetingMinutes(db, {
                organisationId, userId: null, assistant, message, channelBlock: row.via === 'bot' ? BOT_CHANNEL_BLOCK : PICKUP_CHANNEL_BLOCK,
                sessionId: `meeting-pickup:${assistant.id}`, requestPath: false,
            });
        },
        async file(organisationId, assistantId, card, importId) {
            const [already] = await db.select({ id: assistantRecords.id }).from(assistantRecords).where(and(
                eq(assistantRecords.organisationId, organisationId),
                eq(assistantRecords.recordType, 'meeting'),
                sql`${assistantRecords.data}->'pickedUpFrom'->>'importId' = ${String(importId)}`,
            )).limit(1);
            if (already) return already.id;
            // Its own meeting: the record writer never overwrites a meeting, it adds the time to a repeated title.
            const [saved] = await persistHubRecordsWithTitles(db, organisationId, assistantId, [meetingHubRecord(card)]);
            return saved?.id ?? null;
        },
        async botsOnCall(organisationId, row) {
            if (!row.endedAt) return [];
            const start = (row.startedAt ?? row.endedAt).getTime();
            return db.select({
                meetingUrl: meetingBots.meetingUrl, status: meetingBots.status, joinAt: meetingBots.joinAt,
                joinedAt: meetingBots.joinedAt, leftAt: meetingBots.leftAt, importStatus: meetingImports.status,
            }).from(meetingBots).leftJoin(meetingImports, eq(meetingImports.id, meetingBots.importId)).where(and(
                eq(meetingBots.organisationId, organisationId),
                eq(meetingBots.platform, row.platform),
                // A bot booked up to an hour before the call, or one that joined late; botCover does the exact match.
                gt(meetingBots.joinAt, new Date(start - BOT_MATCH_SLACK_MS - BOT_BOOKED_EARLY_MS)),
                lt(meetingBots.joinAt, new Date(row.endedAt.getTime() + BOT_MATCH_SLACK_MS)),
            )).limit(50);
        },
        async charge(organisationId, assistantId, importId, row) {
            if (row.via === 'bot') return chargeBotMeeting(db, organisationId, assistantId, importId);
            await recordCompletedWork(db, organisationId, 'meeting_pickup', { ref: `meeting_import:${importId}`, assistantId });
        },
    };
}

/** Hand one meeting to the background writer. False when it could not be handed over (the next check retries). */
export async function triggerMeetingImport(importId: number): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[meeting-pickup] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { importId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/meeting-import-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ importId }),
            signal: controller.signal,
        });
        return res.status === 202 || res.ok;
    } catch (err) {
        console.error('[meeting-pickup] dispatch failed', { importId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** The 15-minute check: find finished meetings, then hand each due one to a writer. Shared with run-meeting-pickup.ts. */
export async function runMeetingPickup(db: Db, sources: readonly MeetingSource[] = meetingSources(db)): Promise<{ accounts: number; found: number; due: number; dispatched: number; errors: number; bots?: unknown }> {
    if (!sources.length) return { accounts: 0, found: 0, due: 0, dispatched: 0, errors: 0 };
    const store = pickupStore(db);
    const now = new Date();
    let found = { accounts: 0, found: 0, errors: 0 };
    let due: number[] = [];
    try {
        found = await discoverMeetings(store, sources, now);
        due = await store.due(now, DUE_PER_RUN);
    } catch (err) {
        // The tables may not exist yet (z-meeting-imports.sql not applied): nothing to do, not an outage.
        console.error('[meeting-pickup] could not run', err instanceof Error ? err.message : err);
    }
    // In parallel: each hand-off waits up to 5 s, and 25 in turn could pass the function's time limit.
    const dispatched = (await Promise.all(due.map((id) => triggerMeetingImport(id)))).filter(Boolean).length;
    // The Note Taker's own bots: what a missed webhook left, and Recall's media once finished with.
    const bots = await pollMeetingBots(db, triggerMeetingImport).catch((err) => {
        // The table may not exist yet (z-meeting-bots.sql not applied).
        console.error('[meeting-pickup] bot poll could not run', err instanceof Error ? err.message : err);
        return null;
    });
    const out = { ...found, due: due.length, dispatched, ...(bots ? { bots } : {}) };
    console.log('[meeting-pickup]', out);
    return out;
}
