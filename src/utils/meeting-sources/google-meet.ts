// Google Meet as a meeting source for the Note Taker's pick-up engine (src/utils/meeting-pickup.ts,
// docs/meeting-apps-pickup-plan.md §3). Reads what Meet made itself — no bot, no recording, no Drive:
//
//   conferenceRecords (ended calls the connected account HOSTED) → participants (display names)
//   → transcripts (state ENDED / FILE_GENERATED) → transcripts.entries (speaker, text, times).
//
// Proven by hand on 2026-11-19 (plan Phase 0): entries are Google's ORIGINAL transcription; text typed into the
// transcript Doc afterwards is not in them. Only `meetings.space.readonly` (Sensitive) is needed.
//
// The connection is workspace_integrations provider 'google_meet' (oauth-integrations.ts). Pick-up is gated by the
// meeting_pickup feature flag until Google approves the scope and the Terms notice for the new charge has run.

import { and, asc, eq, ne } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { aiAssistants, masterAssistants, workspaceIntegrations } from '../../../db/schema';
import { isFeatureEnabled } from '../feature-flags';
import { MEETING_PICKUP_FLAG, type FinishedMeeting, type MeetingSource, type PickedTranscript, type PickupAccount } from '../meeting-pickup';
import { getFreshAccessToken } from '../workspace-integrations';

type Db = ReturnType<typeof getDb>;

export const GOOGLE_MEET_READ_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';
/** What the connect asks for: the Meet read scope, plus openid email to label the card with the account. */
export const GOOGLE_MEET_SCOPE = `${GOOGLE_MEET_READ_SCOPE} openid email`;

const API = 'https://meet.googleapis.com/v2/';
/** Most pages read from one list (100 a page) — a guard against a runaway loop, not a real limit. */
const MAX_PAGES = 20;

// ── The Meet REST shapes we read (only the fields used) ──────────────────────────────────────────
export interface MeetConferenceRecord { name: string; startTime?: string; endTime?: string; space?: string }
export interface MeetParticipant {
    name: string;
    signedinUser?: { displayName?: string };
    anonymousUser?: { displayName?: string };
    phoneUser?: { displayName?: string };
}
export interface MeetTranscript { name: string; state?: string }
export interface MeetTranscriptEntry { participant?: string; text?: string; startTime?: string }
export interface MeetSpace { name: string; meetingUri?: string }

/** One GET against the Meet API. Throws with the status (never a body or token in the message). */
export type MeetFetch = (path: string) => Promise<unknown>;

export function meetFetcher(accessToken: string, fetchImpl: typeof fetch = fetch): MeetFetch {
    return async (path) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
            const res = await fetchImpl(API + path, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: { status?: string } };
                throw new Error(`Google Meet ${res.status}${body.error?.status ? ` ${body.error.status}` : ''}`);
            }
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    };
}

/** Every item of a paged Meet list. */
export async function listAll<T>(get: MeetFetch, path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let token = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const j = await get(`${path}${sep}pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`) as Record<string, unknown>;
        const items = j[key];
        if (Array.isArray(items)) out.push(...(items as T[]));
        token = typeof j.nextPageToken === 'string' ? j.nextPageToken : '';
        if (!token) break;
    }
    return out;
}

/** The person's name for a participant (signed-in, guest or phone). Pure. */
export function participantName(p: MeetParticipant): string | null {
    const n = p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || '';
    return n.trim() || null;
}

/** Calls that ended in the window, oldest first, each with its join link. */
export async function listEndedCalls(get: MeetFetch, since: Date, now: Date): Promise<FinishedMeeting[]> {
    const filter = encodeURIComponent(`end_time>="${since.toISOString()}"`);
    const records = await listAll<MeetConferenceRecord>(get, `conferenceRecords?filter=${filter}`, 'conferenceRecords');
    const ended = records.filter((r) => r.name && r.endTime && new Date(r.endTime) <= now);
    const links = new Map<string, string | null>();
    const out: FinishedMeeting[] = [];
    for (const r of ended) {
        // The space carries the join link; one look-up per space, and a missing link never loses the meeting.
        if (r.space && !links.has(r.space)) {
            links.set(r.space, await (get(r.space) as Promise<MeetSpace>).then((s) => s.meetingUri ?? null).catch(() => null));
        }
        out.push({
            externalId: r.name,
            title: null, // Meet has no meeting title; the minutes writer names it from what was said.
            link: r.space ? links.get(r.space) ?? null : null,
            startedAt: r.startTime ? new Date(r.startTime) : null,
            endedAt: new Date(r.endTime!),
        });
    }
    return out.sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
}

/** How long after a call a transcript that is ENDED but never reached FILE_GENERATED is read anyway. */
export const ENDED_GRACE_MS = 30 * 60 * 1000;

/**
 * The call's transcript as speaker lines, or null when Meet has none ready yet. Ready means FILE_GENERATED (Google
 * has finished it). ENDED alone can still be filling in, so it is read only once the call is ENDED_GRACE_MS old — a
 * transcript whose Doc export failed would otherwise never be picked up. Any transcript still STARTED waits.
 */
export async function readTranscript(get: MeetFetch, recordName: string, endedAt?: Date | null, now: Date = new Date()): Promise<PickedTranscript | null> {
    const all = await listAll<MeetTranscript>(get, `${recordName}/transcripts`, 'transcripts');
    const graceOver = !!endedAt && now.getTime() - endedAt.getTime() >= ENDED_GRACE_MS;
    const ready = (t: MeetTranscript) => t.state === 'FILE_GENERATED' || (t.state === 'ENDED' && graceOver);
    if (!all.length || all.some((t) => !ready(t))) return null;
    const transcripts = all;
    const participants = await listAll<MeetParticipant>(get, `${recordName}/participants`, 'participants');
    const names = new Map(participants.map((p) => [p.name, participantName(p)]));
    const entries: MeetTranscriptEntry[] = [];
    // A call can have several transcripts (transcription stopped and started again): read them all, in time order.
    for (const t of transcripts) entries.push(...await listAll<MeetTranscriptEntry>(get, `${t.name}/entries`, 'transcriptEntries'));
    // By time, not by string: Meet writes some times with fractions of a second and some without.
    const at = (e: MeetTranscriptEntry) => { const t = Date.parse(String(e.startTime ?? '')); return Number.isNaN(t) ? 0 : t; };
    entries.sort((a, b) => at(a) - at(b));
    return {
        lines: entries.map((e) => ({ speaker: (e.participant && names.get(e.participant)) || null, text: String(e.text ?? '') })),
        attendees: [...names.values()].filter((n): n is string => !!n),
    };
}

/** Workspaces with Google Meet connected, the pick-up flag on, and an active Note Taker (the oldest, if several). */
export async function googleMeetAccounts(db: Db, onlyOrg?: number): Promise<PickupAccount[]> {
    const rows = await db.select({ organisationId: workspaceIntegrations.organisationId, assistantId: aiAssistants.id })
        .from(workspaceIntegrations)
        .innerJoin(aiAssistants, eq(aiAssistants.organisationId, workspaceIntegrations.organisationId))
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(workspaceIntegrations.provider, 'google_meet'),
            eq(workspaceIntegrations.status, 'active'),
            eq(masterAssistants.roleKey, 'meeting_note_taker'),
            ne(aiAssistants.lifecycleStatus, 'archived'),
            ...(onlyOrg ? [eq(workspaceIntegrations.organisationId, onlyOrg)] : []),
        ))
        .orderBy(asc(aiAssistants.id));
    const seen = new Set<number>();
    const out: PickupAccount[] = [];
    for (const r of rows) {
        if (seen.has(r.organisationId)) continue;
        seen.add(r.organisationId);
        if (!(await isFeatureEnabled(r.organisationId, MEETING_PICKUP_FLAG))) continue;
        out.push({ organisationId: r.organisationId, assistantId: r.assistantId, platform: 'google_meet' });
    }
    return out;
}

export function googleMeetSource(db: Db): MeetingSource {
    const getter = async (organisationId: number) => meetFetcher((await getFreshAccessToken(db, organisationId, 'google_meet')).accessToken);
    return {
        platform: 'google_meet',
        accounts: () => googleMeetAccounts(db),
        account: async (organisationId) => (await googleMeetAccounts(db, organisationId))[0] ?? null,
        listFinished: async (account, since, now) => listEndedCalls(await getter(account.organisationId), since, now),
        fetchTranscript: async (account, externalId, endedAt) => readTranscript(await getter(account.organisationId), externalId, endedAt),
    };
}
