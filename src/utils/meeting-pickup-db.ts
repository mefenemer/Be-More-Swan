// The database half of meeting pick-up (src/utils/meeting-pickup.ts holds the rules): the meeting_imports store,
// the real writer dependencies, and the hand-off to the background writer. db/z-meeting-imports.sql.

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, meetingImports, meetingPickupState } from '../../db/schema';
import { resolveBaseUrl } from './base-url';
import { persistHubRecordsWithTitles } from './hub-records';
import { meetingHubRecord } from './meeting-minutes';
import { writeMeetingMinutes } from './meeting-minutes-writer';
import {
    DUE_PER_RUN, LEASE_MS, MEETING_SOURCES, PICKUP_CHANNEL_BLOCK, SETTLE_MS, discoverMeetings,
    type ImportRow, type MeetingSource, type PickupPlatform, type PickupStore, type WriterDeps,
} from './meeting-pickup';
import { enforcePromptModeration } from './moderation';
import { getTaskCosts } from './task-costs';
import { hasTaskCapacity, recordCompletedWork } from './work-metering';

type Db = ReturnType<typeof getDb>;

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

export function writerDeps(db: Db, sources: readonly MeetingSource[] = MEETING_SOURCES): WriterDeps {
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
        async hasCapacity(organisationId) {
            return hasTaskCapacity(db, organisationId, (await getTaskCosts()).weights.meeting_pickup);
        },
        async blocked(organisationId, text) {
            return (await enforcePromptModeration({ text, userId: null, organisationId, source: 'meeting_pickup' })) !== null;
        },
        writeMinutes(organisationId, assistant, message) {
            return writeMeetingMinutes(db, {
                organisationId, userId: null, assistant, message, channelBlock: PICKUP_CHANNEL_BLOCK,
                sessionId: `meeting-pickup:${assistant.id}`, requestPath: false,
            });
        },
        async file(organisationId, assistantId, card) {
            // Its own meeting: the record writer never overwrites a meeting, it adds the time to a repeated title.
            const [saved] = await persistHubRecordsWithTitles(db, organisationId, assistantId, [meetingHubRecord(card)]);
            return saved?.id ?? null;
        },
        async charge(organisationId, assistantId, importId) {
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
export async function runMeetingPickup(db: Db, sources: readonly MeetingSource[] = MEETING_SOURCES): Promise<{ accounts: number; found: number; due: number; dispatched: number; errors: number }> {
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
    let dispatched = 0;
    for (const id of due) if (await triggerMeetingImport(id)) dispatched++;
    const out = { ...found, due: due.length, dispatched };
    console.log('[meeting-pickup]', out);
    return out;
}
