// src/utils/mail-reader/gmail.ts — reading a Gmail inbox through the Gmail API (plan §4.1, §4.2).
//
// Same shapes as graph.ts, so sorting never cares which provider a mailbox is on.
//
// Phase 3a polls (push via Pub/Sub comes in 3b):
//   - first read: messages.list on the INBOX for the last FIRST_SORT_DAYS days, and the mailbox's current
//     historyId as the cursor;
//   - later reads: history.list from that historyId — messages added to / removed from the INBOX label,
//     and deleted. A historyId Google no longer keeps (404) means: read the 14-day window again.
//
// What this reads: headers (format=metadata, only the headers sorting needs) for every inbox email, and
// the body ONLY of an email being sorted by AI or opened by its owner — returned, never stored.
//
// Scope: gmail.modify (restricted; Google's review + CASA — docs/email-assistant-phase0.md §6.2). Reading
// needs only what gmail.readonly gives; modify is asked for now so Phase 2 (labels, trash, drafts, send)
// needs no second consent.

import type { MailChanges, MailMessageMeta } from './types';
import { FIRST_SORT_DAYS } from './graph';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** The headers sorting reads (email-sort.ts headerSort) plus sender, subject and date. */
const META_HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'];
/** Gmail's own tabs that mean "not a person writing to you". A hint, never a rule. */
const OTHER_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
/** Messages read per run on a first sort (the rest wait for the next run, via the saved page token). */
const FIRST_SORT_MAX = 400;

export class GmailError extends Error {
    constructor(public status: number, message: string, public retryAfterSec: number | null = null) { super(message); }
}

async function gmailGet(url: string, accessToken: string): Promise<Record<string, unknown>> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
        const retry = Number(res.headers.get('retry-after'));
        throw new GmailError(res.status, `Gmail ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return res.json() as Promise<Record<string, unknown>>;
}

/** "Jo Bloggs <jo@x.com>" → name and lower-cased address. Pure. */
export function parseFromHeader(raw: string | undefined): { name: string | null; address: string | null } {
    if (!raw) return { name: null, address: null };
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
    const bare = raw.trim();
    return /@/.test(bare) ? { name: null, address: bare.toLowerCase() } : { name: bare, address: null };
}

/** Headers of a metadata message, lower-cased names. Pure. */
export function gmailHeaders(m: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    const hs = ((m.payload as { headers?: { name?: string; value?: string }[] } | undefined)?.headers) ?? [];
    for (const h of hs) if (h.name && typeof h.value === 'string') out[h.name.toLowerCase()] = h.value.slice(0, 500);
    return out;
}

/** A Gmail message (format=metadata) as our shape. Pure. `address` builds the link for the right account. */
export function normaliseGmailMessage(m: Record<string, unknown>, address: string): MailMessageMeta {
    const h = gmailHeaders(m);
    const from = parseFromHeader(h['from']);
    const labels = new Set((m.labelIds as string[] | undefined) ?? []);
    const id = String(m.id ?? '');
    const internal = Number(m.internalDate);
    return {
        id,
        removed: false,
        threadId: typeof m.threadId === 'string' ? m.threadId : null,
        fromName: from.name ? from.name.slice(0, 200) : null,
        fromAddress: from.address ? from.address.slice(0, 320) : null,
        subject: typeof h['subject'] === 'string' ? h['subject'].slice(0, 500) : null,
        receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal) : (h['date'] ? new Date(h['date']) : null),
        isRead: !labels.has('UNREAD'),
        // authuser= opens the right Google account when several are signed in.
        webLink: id ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#all/${encodeURIComponent(id)}` : null,
        providerFolderHint: [...labels].some((l) => OTHER_LABELS.has(l)) ? 'other' : labels.has('CATEGORY_PERSONAL') ? 'focused' : null,
    };
}

async function getMeta(accessToken: string, id: string): Promise<Record<string, unknown>> {
    const q = META_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join('&');
    return gmailGet(`${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&${q}`, accessToken);
}

/**
 * The cursor we store for Gmail: the historyId to read from, plus — mid first-sort — the messages.list
 * page to resume. JSON so one text column holds both. Pure.
 */
export function encodeGmailCursor(c: { historyId: string; pageToken?: string | null }): string {
    return `gmail:${JSON.stringify({ h: c.historyId, ...(c.pageToken ? { p: c.pageToken } : {}) })}`;
}
export function decodeGmailCursor(raw: string | null): { historyId: string; pageToken: string | null } | null {
    if (!raw || !raw.startsWith('gmail:')) return null;
    try {
        const o = JSON.parse(raw.slice(6)) as { h?: unknown; p?: unknown };
        return typeof o.h === 'string' && /^\d+$/.test(o.h) ? { historyId: o.h, pageToken: typeof o.p === 'string' ? o.p : null } : null;
    } catch { return null; }
}

/** The 14-day INBOX query for a first read. Pure. */
export function firstSortQuery(): string {
    return `in:inbox newer_than:${FIRST_SORT_DAYS}d`;
}

/** Read the inbox's changes from `cursor` (null = first sort). Stops at `deadline` and resumes next run. */
export async function listGmailChanges(accessToken: string, address: string, cursor: string | null, deadline: number): Promise<MailChanges> {
    const saved = decodeGmailCursor(cursor);
    const messages: MailMessageMeta[] = [];

    // ── First sort (or resuming one): list the INBOX, newest first ──
    if (!saved || saved.pageToken) {
        // The historyId BEFORE listing: anything arriving while we list is then caught by history.list.
        const historyId = saved?.historyId ?? String((await gmailGet(`${GMAIL}/profile`, accessToken)).historyId ?? '');
        if (!historyId) throw new GmailError(502, 'Gmail returned no history id.');
        let pageToken: string | null = saved?.pageToken ?? null;
        let read = 0;
        do {
            const url = `${GMAIL}/messages?maxResults=100&labelIds=INBOX&q=${encodeURIComponent(firstSortQuery())}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
            const page = await gmailGet(url, accessToken);
            for (const ref of (page.messages as { id: string }[] | undefined) ?? []) {
                messages.push(normaliseGmailMessage(await getMeta(accessToken, ref.id), address));
                read++;
            }
            pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
            if (pageToken && (Date.now() > deadline || read >= FIRST_SORT_MAX)) {
                return { messages, cursor: encodeGmailCursor({ historyId, pageToken }), complete: false };
            }
        } while (pageToken);
        return { messages, cursor: encodeGmailCursor({ historyId }), complete: true };
    }

    // ── Later reads: what changed in the INBOX since historyId ──
    const added = new Set<string>();
    const removed = new Set<string>();
    let pageToken: string | null = null;
    let latest = saved.historyId;
    do {
        const types = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'].map((t) => `historyTypes=${t}`).join('&');
        const url: string = `${GMAIL}/history?startHistoryId=${saved.historyId}&labelId=INBOX&${types}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const page = await gmailGet(url, accessToken);
        const delta = applyGmailHistory((page.history as GmailHistory[] | undefined) ?? []);
        delta.added.forEach((id) => { added.add(id); removed.delete(id); });
        delta.removed.forEach((id) => { removed.add(id); added.delete(id); });
        if (typeof page.historyId === 'string') latest = page.historyId;
        pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
    } while (pageToken && Date.now() < deadline);

    for (const id of removed) messages.push({ ...emptyMeta(id), removed: true });
    for (const id of added) {
        try { messages.push(normaliseGmailMessage(await getMeta(accessToken, id), address)); }
        catch (err) {
            // Deleted between the history entry and now: treat as gone, not as an outage.
            if (err instanceof GmailError && err.status === 404) messages.push({ ...emptyMeta(id), removed: true });
            else throw err;
        }
    }
    return { messages, cursor: encodeGmailCursor({ historyId: latest }), complete: !pageToken };
}

function emptyMeta(id: string): MailMessageMeta {
    return { id, removed: false, threadId: null, fromName: null, fromAddress: null, subject: null, receivedAt: null, isRead: false, webLink: null, providerFolderHint: null };
}

interface GmailHistory {
    messagesAdded?: { message: { id: string; labelIds?: string[] } }[];
    messagesDeleted?: { message: { id: string } }[];
    labelsAdded?: { message: { id: string }; labelIds: string[] }[];
    labelsRemoved?: { message: { id: string }; labelIds: string[] }[];
}

/**
 * Fold history entries into "now in the inbox" and "left the inbox", in order (a later entry wins).
 * Pure. Only INBOX matters: a message gaining or losing another label doesn't move it.
 */
export function applyGmailHistory(history: readonly GmailHistory[]): { added: string[]; removed: string[] } {
    const state = new Map<string, 'in' | 'out'>();
    for (const h of history) {
        for (const a of h.messagesAdded ?? []) if ((a.message.labelIds ?? []).includes('INBOX')) state.set(a.message.id, 'in');
        for (const l of h.labelsAdded ?? []) if (l.labelIds.includes('INBOX')) state.set(l.message.id, 'in');
        for (const l of h.labelsRemoved ?? []) if (l.labelIds.includes('INBOX')) state.set(l.message.id, 'out');
        for (const d of h.messagesDeleted ?? []) state.set(d.message.id, 'out');
    }
    return {
        added: [...state].filter(([, v]) => v === 'in').map(([k]) => k),
        removed: [...state].filter(([, v]) => v === 'out').map(([k]) => k),
    };
}

/** The headers sorting reads, for one message. */
export async function getGmailHeaders(accessToken: string, messageId: string): Promise<Record<string, string>> {
    return gmailHeaders(await getMeta(accessToken, messageId));
}

/** base64url → text. Pure. */
function b64url(data: string): string {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name?: string; value?: string }[] }

/** The plain text of a message: text/plain if there is one, else text/html with the tags taken out. Pure. */
export function gmailBodyText(payload: GmailPart | undefined): string {
    if (!payload) return '';
    const plain: string[] = [];
    const html: string[] = [];
    const walk = (p: GmailPart) => {
        if (p.mimeType === 'text/plain' && p.body?.data) plain.push(b64url(p.body.data));
        else if (p.mimeType === 'text/html' && p.body?.data) html.push(b64url(p.body.data));
        for (const c of p.parts ?? []) walk(c);
    };
    walk(payload);
    if (plain.length) return plain.join('\n');
    return html.join('\n')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** An email's text, for AI sorting or for its owner to read. Returned, never stored. */
export async function getGmailBodyText(accessToken: string, messageId: string): Promise<{ text: string; to: string[] }> {
    const m = await gmailGet(`${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`, accessToken);
    const payload = m.payload as GmailPart | undefined;
    const to = (gmailHeaders(m)['to'] ?? '').split(',').map((s) => parseFromHeader(s).address ?? '').filter(Boolean);
    return { text: gmailBodyText(payload), to };
}
