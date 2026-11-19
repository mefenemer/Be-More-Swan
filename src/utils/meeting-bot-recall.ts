// The ONLY file that talks to Recall.ai (docs/note-taker-bot-plan.md §4, B1). Switching vendor means replacing this
// file. Each region is its own Recall account with its own key (RECALL_EU_API_KEY, RECALL_US_API_KEY). Never logs a
// key, a transcript or a name.
//
// Proven by hand on 2026-11-19 (plan Phase 0): create → status_changes → recordings[0].media_shortcuts.transcript →
// presigned download → delete_media, on free Google Meet and Teams.

import { RECALL_HOSTS, recallTranscriptLines, type BotStatusChange, type BotTranscriptLine, type RecallRegion } from './meeting-bot';

const TIMEOUT_MS = 15_000;

export function recallKey(region: RecallRegion): string | null {
    const key = region === 'eu' ? process.env.RECALL_EU_API_KEY : process.env.RECALL_US_API_KEY;
    return key && key.trim() ? key.trim() : null;
}

export class RecallError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

async function call<T = Record<string, unknown>>(region: RecallRegion, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const key = recallKey(region);
    if (!key) throw new RecallError(`Recall ${region} is not configured`, 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`https://${RECALL_HOSTS[region]}/api/v1${path}`, {
            method,
            headers: { Authorization: `Token ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const json = (await res.json().catch(() => ({}))) as T;
        return { status: res.status, json };
    } finally {
        clearTimeout(timer);
    }
}

/** Short words from a Recall error body, for the bot's status_reason. Never the request. */
function reasonOf(json: unknown): string {
    if (!json || typeof json !== 'object') return '';
    const j = json as Record<string, unknown>;
    const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
    const r = first(j.detail) ?? first(j.code) ?? first(j.meeting_url) ?? first(j.non_field_errors) ?? '';
    return String(r).slice(0, 160);
}

/** Sends the bot. Its Recall id. */
export async function createRecallBot(region: RecallRegion, request: Record<string, unknown>): Promise<string> {
    const r = await call<{ id?: string }>(region, 'POST', '/bot/', request);
    if ((r.status === 200 || r.status === 201) && r.json.id) return String(r.json.id);
    throw new RecallError(reasonOf(r.json) || `Recall refused the bot (${r.status})`, r.status);
}

export interface RecallBotState {
    /** The newest status change (Recall has no top-level status). */
    code: string | null;
    subCode: string | null;
    at: Date | null;
    /** Every status change, oldest first (the poll replays them all). */
    changes: BotStatusChange[];
    transcriptUrl: string | null;
    transcriptStatus: string | null;
}

export async function getRecallBot(region: RecallRegion, botId: string): Promise<RecallBotState> {
    const r = await call<{ status_changes?: { code?: string; sub_code?: string | null; created_at?: string }[]; recordings?: { media_shortcuts?: { transcript?: { status?: { code?: string }; data?: { download_url?: string } } } }[] }>(
        region, 'GET', `/bot/${encodeURIComponent(botId)}/`);
    if (r.status !== 200) throw new RecallError(reasonOf(r.json) || `Recall bot read failed (${r.status})`, r.status);
    const changes = Array.isArray(r.json.status_changes) ? r.json.status_changes : [];
    const last = changes[changes.length - 1];
    const transcript = r.json.recordings?.[0]?.media_shortcuts?.transcript;
    const at = last?.created_at ? new Date(last.created_at) : null;
    const all: BotStatusChange[] = changes.flatMap((c) => {
        const t = c.created_at ? new Date(c.created_at) : null;
        return typeof c.code === 'string' && t && !Number.isNaN(t.getTime()) ? [{ code: c.code, subCode: c.sub_code ?? null, at: t }] : [];
    });
    return {
        code: last?.code ?? null,
        subCode: last?.sub_code ?? null,
        at: at && !Number.isNaN(at.getTime()) ? at : null,
        changes: all,
        transcriptUrl: typeof transcript?.data?.download_url === 'string' ? transcript.data.download_url : null,
        transcriptStatus: transcript?.status?.code ?? null,
    };
}

export type RecallTranscript =
    | { state: 'ready'; lines: BotTranscriptLine[]; attendees: string[] }
    | { state: 'not_ready' }
    | { state: 'none' };

/** The transcript once Recall has finished it. 'none' when the bot ended with no transcript at all. */
export async function fetchRecallTranscript(region: RecallRegion, botId: string): Promise<RecallTranscript> {
    const bot = await getRecallBot(region, botId);
    if (!bot.transcriptUrl) {
        if (bot.code === 'done' && bot.transcriptStatus && /failed|deleted/.test(bot.transcriptStatus)) return { state: 'none' };
        return { state: 'not_ready' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        // Presigned: no Authorization header.
        const res = await fetch(bot.transcriptUrl, { signal: controller.signal });
        if (!res.ok) return { state: 'not_ready' };
        const lines = recallTranscriptLines(await res.json());
        const attendees = [...new Set(lines.map((l) => l.speaker).filter((n): n is string => Boolean(n)))];
        return { state: 'ready', lines, attendees };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Takes the bot out of the meeting: a booked bot that hasn't joined is deleted; one that is joining or in the call is
 * asked to leave. 'deleted' = it will never join (safe to mark cancelled); 'left' = it was on its way in or in the call,
 * so its own events decide what happens (what it heard is still written up); null = Recall refused.
 */
export async function removeRecallBot(region: RecallRegion, botId: string, notJoinedYet: boolean): Promise<'deleted' | 'left' | null> {
    const id = encodeURIComponent(botId);
    const ok = (s: number) => s >= 200 && s < 300;
    if (notJoinedYet) {
        const del = await call(region, 'DELETE', `/bot/${id}/`);
        if (ok(del.status) || del.status === 404) return 'deleted';
        // It has already started joining, so it refuses the delete: ask it to leave instead.
    }
    const leave = await call(region, 'POST', `/bot/${id}/leave_call/`);
    return ok(leave.status) || leave.status === 404 ? 'left' : null;
}

/** Deletes Recall's copy of the recording and transcript. True when done (or already gone); false while the bot runs. */
export async function deleteRecallMedia(region: RecallRegion, botId: string): Promise<boolean> {
    const r = await call(region, 'POST', `/bot/${encodeURIComponent(botId)}/delete_media/`);
    return r.status === 404 || r.status === 409 || (r.status >= 200 && r.status < 300);
}
