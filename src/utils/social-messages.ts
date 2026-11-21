// src/utils/social-messages.ts
// The Social Media assistant's Messages tab — Facebook Page + Instagram messages, Phase 2
// (docs/meta-messages-plan.md). The ONE server path behind the tab's buttons, the chat's message
// card (src/utils/chat-message-action.ts) and the 15-minute tick (social-messages-tick.ts).
// Receiving is Phase 1 (meta-webhook.ts → src/utils/meta-messaging.ts).
//
// What it does:
//  1. List this assistant's conversations with their recent messages, and fill in who the person
//     is (name from Meta, best effort, stored once).
//  2. On request, the assistant drafts a reply in the brand's voice. Nothing is sent by drafting.
//  3. "Send" sends the reply AS the Page / Instagram account — only ever from a person's click (the
//     tab's button or the chat card's), never from a schedule or a model turn (owner decision D1).
//     Meta allows a reply only within 24 hours of the person's LAST message; that is checked here,
//     on the server, immediately before the call — never trusted from the page.
//  4. The tick sends one "4 hours left" reminder per window and blanks message text after 90 days
//     (owner decision D6).
//
// Drafting is help with a reply, not a piece of work: metered like the Comments tab's drafts (fair
// use, no task) — page-comments.ts draftReply.

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, socialConversations, socialMessages, systemConnections } from '../../db/schema';
import { getSecret } from './vault';
import { FB_GRAPH_VERSION } from './social-publish';
import { messagingEnabled, pageTokenFor, type MessagingPlatform } from './meta-messaging';
import { notArchivedAssistant } from './archived-assistant-drafts';
import { loadSenderIdentity } from './sender-identity';
import { loadBusinessKnowledgeBlock } from './business-knowledge';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { loadRoleModel, roleKeyOfAssistant, withRoleModel } from './assistant-model';
import { businessBlock } from '../lib/discussion-triage';
import { meterInteraction } from './task-credit';
import { chargeHelper } from './basic-work';
import { isGlobalAiDisabled } from './platform-config';
import { adaptForModel, replyText } from '../config/model-options';
import { parseModelJson } from './model-json';
import { logMessageUsage } from './ai-usage';
import { loadVoice } from './page-comments';
import { createNotification } from './notify';

type Db = ReturnType<typeof getDb>;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRAFT_MODEL = 'claude-haiku-5-5';

export const CONVERSATION_STATUSES = ['new', 'replied', 'dismissed'] as const;
export type ConversationStatus = typeof CONVERSATION_STATUSES[number];

/** Longest reply each platform takes. Messenger: 2,000 characters; Instagram: 1,000. */
export const MAX_REPLY_CHARS: Record<MessagingPlatform, number> = { facebook: 2000, instagram: 1000 };
/** Conversations listed on the tab per status (newest message first). The chips show full counts. */
export const LIST_CONVERSATIONS = 100;
/** Messages shown per conversation on the tab (the most recent). */
export const THREAD_MESSAGES = 20;
/** Messages the drafting prompt sees. */
const DRAFT_CONTEXT_MESSAGES = 12;
/** Names looked up from Meta per list (each is one call). */
const NAME_LOOKUPS_PER_LIST = 10;
/** "4 hours left" reminder (owner decision D5). */
export const REMINDER_BEFORE_MS = 4 * 60 * 60 * 1000;
/** Send calls Meta only if it got this far within this long — leaving room under the 26s function
 *  timeout for Meta (≤8s) and the bookkeeping. */
export const SEND_DEADLINE_MS = 12_000;
/** Message text is blanked after this many days (owner decision D6); counts stay. */
export const RETENTION_DAYS = 90;

export const PLATFORM_LABEL: Record<MessagingPlatform, string> = { facebook: 'Facebook', instagram: 'Instagram' };

function toIso(v: Date | string | null | undefined): string | null {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────

/** Tidy a reply as typed or drafted: plain text, at most the platform's limit. Pure. */
export function tidyReply(text: string, platform: MessagingPlatform): string {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_REPLY_CHARS[platform]);
}

/** Is Meta still allowing a reply? Pure. */
export function windowOpen(windowClosesAt: Date | string | null | undefined, now = Date.now()): boolean {
    const iso = toIso(windowClosesAt as Date | string | null);
    return !!iso && new Date(iso).getTime() > now;
}

export type SendRefusal = 'window_closed' | 'not_connected' | 'scope_missing' | 'instagram_access_off' | 'person_unavailable' | 'meta_error' | 'unconfirmed';

/**
 * Meta's error body → why the reply didn't go. Pure, so tests can feed it Meta's documented shapes.
 * The 24-hour rule is error (#10) subcode 2018278 on Messenger and 2534022 on Instagram; the
 * wording is matched too, because the codes have moved before.
 */
export function classifySendError(status: number, body: unknown): SendRefusal {
    const e = ((body as { error?: Record<string, unknown> } | null)?.error ?? {}) as { code?: number; error_subcode?: number; message?: string; type?: string };
    const msg = String(e.message ?? '');
    if (e.error_subcode === 2018278 || e.error_subcode === 2534022 || /outside (of )?(the )?allowed window|24[- ]hour/i.test(msg)) return 'window_closed';
    if (e.code === 190 || e.type === 'OAuthException' && /expired|invalid|session/i.test(msg)) return 'not_connected';
    if (/allow access to messages|connected tools/i.test(msg)) return 'instagram_access_off';
    if (e.code === 551 || /isn'?t available right now/i.test(msg)) return 'person_unavailable';
    if (e.code === 200 || e.code === 230 || e.code === 10 || /requires .*permission|pages_messaging|instagram_manage_messages/i.test(msg)) return 'scope_missing';
    return 'meta_error';
}

export const REFUSAL_COPY: Record<SendRefusal, string> = {
    window_closed: 'Meta only lets you reply within 24 hours of their last message, and that time has passed. You can still answer in the Facebook or Instagram app.',
    not_connected: 'This Facebook / Instagram connection needs reconnecting. Reconnect it in Connections, then send again.',
    scope_missing: 'Your connection doesn’t allow sending messages yet. Reconnect Facebook / Instagram in Connections and leave the messaging permissions ticked.',
    instagram_access_off: 'Instagram is blocking apps from your messages. In the Instagram app: Settings → Messages and story replies → Connected tools → turn on “Allow access to messages”.',
    person_unavailable: 'Meta says this person can’t be messaged right now (they may have blocked the account or closed theirs).',
    meta_error: 'Meta didn’t accept the reply just now — please try again.',
    unconfirmed: 'Meta didn’t answer in time, so the reply may or may not have gone. Check the conversation in the Facebook / Instagram app before sending it again.',
};

// ── Credentials ──────────────────────────────────────────────────────────────────────────────

/**
 * The Page id and Page token a conversation's connection answers with. A Facebook row's
 * external_user_id IS the Page; an Instagram row answers through its linked Page (metadata.fbPageId).
 * Null when the connection is gone or Meta won't give a Page token. Never throws.
 */
export async function pageCredentialsForConnection(db: Db, connectionId: number, fetchImpl: typeof fetch = fetch): Promise<{ pageId: string; pageToken: string } | null> {
    try {
        const [conn] = await db.select({
            serviceName: systemConnections.serviceName, externalUserId: systemConnections.externalUserId,
            vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata, isActive: systemConnections.isActive,
        }).from(systemConnections).where(eq(systemConnections.id, connectionId)).limit(1);
        if (!conn?.isActive || !conn.vaultRefKey) return null;
        const pageId = (conn.metadata as { fbPageId?: string | null } | null)?.fbPageId ?? (conn.serviceName === 'facebook' ? conn.externalUserId : null);
        if (!pageId) return null;
        const secret = await getSecret(db, conn.vaultRefKey) as { token?: string } | null;
        if (!secret?.token) return null;
        const pageToken = await pageTokenFor(secret.token, pageId, fetchImpl);
        return pageToken ? { pageId, pageToken } : null;
    } catch (err) {
        console.warn(`[social-messages] conn ${connectionId}: no page credentials —`, err instanceof Error ? err.message : err);
        return null;
    }
}

/** Who the person is, from Meta. Best effort; null when Meta won't say. Never throws. */
export async function fetchParticipantName(platform: MessagingPlatform, participantId: string, pageToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    try {
        const fields = platform === 'instagram' ? 'name,username' : 'name';
        const res = await fetchImpl(`https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(participantId)}?fields=${fields}&access_token=${encodeURIComponent(pageToken)}`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const d = await res.json().catch(() => ({})) as { name?: string; username?: string };
        const name = (d.name || '').trim() || (d.username ? `@${d.username}` : '');
        return name ? name.slice(0, 120) : null;
    } catch { return null; }
}

// ── Read ─────────────────────────────────────────────────────────────────────────────────────

export interface MessageView { id: number; direction: 'in' | 'out'; body: string | null; attachmentType: string | null; sentAt: string | null; sentHere: boolean }

export interface ConversationView {
    id: number;
    platform: MessagingPlatform;
    personLabel: string;
    status: ConversationStatus;
    lastInboundAt: string | null;
    windowClosesAt: string | null;
    windowOpen: boolean;
    draftReply: string | null;
    maxReplyChars: number;
    messages: MessageView[];
}

type ConvRow = typeof socialConversations.$inferSelect;
type MsgRow = typeof socialMessages.$inferSelect;

export function conversationView(c: ConvRow, msgs: MsgRow[], now = Date.now()): ConversationView {
    const platform: MessagingPlatform = c.platform === 'instagram' ? 'instagram' : 'facebook';
    return {
        id: c.id,
        platform,
        personLabel: c.participantName || `Someone on ${PLATFORM_LABEL[platform]}`,
        status: (CONVERSATION_STATUSES as readonly string[]).includes(c.status) ? c.status as ConversationStatus : 'new',
        lastInboundAt: toIso(c.lastInboundAt),
        windowClosesAt: toIso(c.windowClosesAt),
        windowOpen: windowOpen(c.windowClosesAt, now),
        draftReply: c.draftReply,
        maxReplyChars: MAX_REPLY_CHARS[platform],
        messages: msgs
            .slice()
            .sort((a, b) => new Date(toIso(a.sentAt) ?? 0).getTime() - new Date(toIso(b.sentAt) ?? 0).getTime())
            .map((m) => ({ id: m.id, direction: m.direction === 'out' ? 'out' : 'in', body: m.body, attachmentType: m.attachmentType, sentAt: toIso(m.sentAt), sentHere: m.sentBy != null })),
    };
}

/** The workspace's Facebook / Instagram connections and whether messages reach us through them. */
export async function messagingConnectionState(db: Db, organisationId: number) {
    const rows = await db.select({ serviceName: systemConnections.serviceName, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), inArray(systemConnections.serviceName, ['facebook', 'instagram']), eq(systemConnections.isActive, true)));
    const subscribed = (r: { metadata: unknown }) => (r.metadata as { messaging?: { subscribed?: boolean } } | null)?.messaging?.subscribed === true;
    return {
        /** Messages are switched on for this server (META_MESSAGING_ENABLED). */
        enabled: messagingEnabled(),
        connected: rows.length > 0,
        /** At least one connection subscribed its Page — messages are arriving. */
        receiving: rows.some(subscribed),
        /** Connected but never subscribed: reconnecting turns messages on. */
        needsReconnect: rows.length > 0 && !rows.some(subscribed),
    };
}

/** Fill in names Meta will give us, at most NAME_LOOKUPS_PER_LIST per call. Best effort. */
async function fillNames(db: Db, rows: ConvRow[]): Promise<void> {
    // A lookup Meta refused is not tried again for a day (name_looked_up_at) — otherwise every tab
    // load would repeat up to NAME_LOOKUPS_PER_LIST Graph calls for people who keep their name private.
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const missing = rows
        .filter((r) => !r.participantName && (!r.nameLookedUpAt || new Date(toIso(r.nameLookedUpAt) ?? 0).getTime() < dayAgo))
        .slice(0, NAME_LOOKUPS_PER_LIST);
    if (!missing.length) return;
    await db.update(socialConversations).set({ nameLookedUpAt: sql`now()` })
        .where(inArray(socialConversations.id, missing.map((r) => r.id))).catch(() => {});
    const creds = new Map<number, Promise<{ pageId: string; pageToken: string } | null>>();
    await Promise.all(missing.map(async (r) => {
        if (!creds.has(r.connectionId)) creds.set(r.connectionId, pageCredentialsForConnection(db, r.connectionId));
        const c = await creds.get(r.connectionId)!;
        if (!c) return;
        const name = await fetchParticipantName(r.platform === 'instagram' ? 'instagram' : 'facebook', r.participantId, c.pageToken);
        if (!name) return;
        r.participantName = name;
        await db.update(socialConversations).set({ participantName: name }).where(eq(socialConversations.id, r.id)).catch(() => {});
    }));
}

async function messagesFor(db: Db, conversationIds: number[], perConversation: number): Promise<Map<number, MsgRow[]>> {
    const out = new Map<number, MsgRow[]>();
    if (!conversationIds.length) return out;
    // The most recent N per conversation in one query.
    const rows = await db.execute(sql`
        SELECT * FROM (
            SELECT m.*, row_number() OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at DESC, m.id DESC) AS rn
            FROM social_messages m WHERE m.conversation_id IN (${sql.join(conversationIds.map((id) => sql`${id}`), sql`, `)})
        ) t WHERE t.rn <= ${perConversation}`) as unknown as Array<Record<string, unknown>>;
    for (const r of (Array.isArray(rows) ? rows : (rows as { rows?: Array<Record<string, unknown>> }).rows ?? [])) {
        const m: MsgRow = {
            id: Number(r.id), organisationId: Number(r.organisation_id), conversationId: Number(r.conversation_id),
            direction: String(r.direction), mid: String(r.mid), body: (r.body as string | null) ?? null,
            attachmentType: (r.attachment_type as string | null) ?? null, sentAt: r.sent_at as Date,
            sentBy: r.sent_by == null ? null : Number(r.sent_by), createdAt: r.created_at as Date,
        };
        const list = out.get(m.conversationId) ?? [];
        list.push(m);
        out.set(m.conversationId, list);
    }
    return out;
}

export async function listConversations(db: Db, organisationId: number, assistantId: number, opts: { lookUpNames?: boolean } = {}) {
    const scope = and(eq(socialConversations.organisationId, organisationId), eq(socialConversations.aiAssistantId, assistantId));
    const [rows, counts, connection] = await Promise.all([
        // Per status, so a long Replied history can never push a waiting conversation off the tab.
        Promise.all(CONVERSATION_STATUSES.map((st) => db.select().from(socialConversations).where(and(scope, eq(socialConversations.status, st)))
            .orderBy(desc(sql`coalesce(${socialConversations.lastInboundAt}, ${socialConversations.lastOutboundAt}, ${socialConversations.createdAt})`))
            .limit(LIST_CONVERSATIONS))).then((lists) => lists.flat()),
        db.select({ status: socialConversations.status, n: sql<number>`count(*)::int` }).from(socialConversations).where(scope).groupBy(socialConversations.status),
        messagingConnectionState(db, organisationId),
    ]);
    // The tab looks names up; the chat block (every turn) never waits on Meta.
    if (opts.lookUpNames !== false) await fillNames(db, rows);
    const msgs = await messagesFor(db, rows.map((r) => r.id), THREAD_MESSAGES);
    const c = { new: 0, replied: 0, dismissed: 0 };
    for (const r of counts) if (r.status in c) c[r.status as keyof typeof c] = Number(r.n);
    const now = Date.now();
    return { conversations: rows.map((r) => conversationView(r, msgs.get(r.id) ?? [], now)), counts: c, connection };
}

export async function loadConversation(db: Db, organisationId: number, assistantId: number, id: number): Promise<ConvRow | null> {
    const [row] = await db.select().from(socialConversations)
        .where(and(eq(socialConversations.id, id), eq(socialConversations.organisationId, organisationId), eq(socialConversations.aiAssistantId, assistantId)))
        .limit(1);
    return row ?? null;
}

async function viewOf(db: Db, row: ConvRow): Promise<ConversationView> {
    const msgs = await messagesFor(db, [row.id], THREAD_MESSAGES);
    return conversationView(row, msgs.get(row.id) ?? []);
}

// ── Write ────────────────────────────────────────────────────────────────────────────────────

/** Dismiss / put back to new. Never "replied" — only a send (here or in Meta's apps) files that. */
export async function setConversationStatus(
    db: Db, organisationId: number, assistantId: number, id: number, status: 'new' | 'dismissed', userId: number | null,
): Promise<ConversationView | null> {
    const [row] = await db.update(socialConversations)
        .set({ status, decidedBy: status === 'new' ? null : userId, decidedAt: status === 'new' ? null : sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(socialConversations.id, id), eq(socialConversations.organisationId, organisationId), eq(socialConversations.aiAssistantId, assistantId)))
        .returning();
    return row ? viewOf(db, row) : null;
}

export async function saveDraft(db: Db, organisationId: number, assistantId: number, id: number, text: string): Promise<ConversationView | null> {
    const row = await loadConversation(db, organisationId, assistantId, id);
    if (!row) return null;
    const draft = tidyReply(text, row.platform === 'instagram' ? 'instagram' : 'facebook');
    if (!draft) return null;
    const [updated] = await db.update(socialConversations).set({ draftReply: draft, updatedAt: sql`now()` }).where(eq(socialConversations.id, row.id)).returning();
    return updated ? viewOf(db, updated) : null;
}

export const REPLY_RULES = `How to write the reply:
- You are replying AS the business, in a private message on its Facebook Page or Instagram account, to someone who messaged it. Write in the first person plural ("we"), in the brand's voice.
- Answer what they actually asked, using the conversation so far. Warm and direct, like a helpful person at the business — not a press release.
- Short: one to four sentences. Plain text: no markdown, no hashtags, no emoji unless they used them.
- Use their first name only if it is given below and it reads naturally. Never guess a name.
- Never invent facts, prices, availability, bookings, dates, offers or promises that are not in the business details. If you can't answer from the details, say you'll check and come back to them — never make something up.
- Never ask for card numbers, passwords or other sensitive details.
- If it is a complaint, acknowledge it calmly, say sorry where it fits and offer to put it right. Never argue.
- If the message is spam, abusive or a sales pitch, reply with an empty string — the person will dismiss it.`;

/** "Draft a reply" / "Redraft" — the assistant writes the reply. Stored as the draft; nothing is sent. */
export async function draftReply(
    db: Db, organisationId: number, assistantId: number, id: number, instruction: string | null,
): Promise<{ ok: true; conversation: ConversationView } | { ok: false; status: number; error: string; code?: string }> {
    const row = await loadConversation(db, organisationId, assistantId, id);
    if (!row) return { ok: false, status: 404, error: 'That conversation isn’t on this assistant’s Messages tab.' };
    if (await isGlobalAiDisabled()) return { ok: false, status: 503, error: 'AI services are temporarily unavailable. Please try again later.' };
    const platform: MessagingPlatform = row.platform === 'instagram' ? 'instagram' : 'facebook';
    const [sender, knowledgeBlock, rulesBlock, voice, roleKey, history] = await Promise.all([
        loadSenderIdentity(db, organisationId, assistantId),
        loadBusinessKnowledgeBlock(db, organisationId),
        loadAssistantRulesBlock(db, { assistantId, organisationId }),
        loadVoice(db, assistantId),
        roleKeyOfAssistant(db, assistantId),
        messagesFor(db, [row.id], DRAFT_CONTEXT_MESSAGES),
    ]);
    const thread = conversationView(row, history.get(row.id) ?? []).messages;
    if (!thread.some((m) => m.direction === 'in' && (m.body || '').trim())) {
        return { ok: false, status: 422, error: 'There’s no written message to answer yet (only a picture or a sticker). Write your own reply, or open it in the Facebook / Instagram app.', code: 'no_text' };
    }
    // Charged only once there is something to answer.
    const credit = await meterInteraction(db, organisationId, 'helpers');
    if (!credit.allowed) {
        if (credit.failed) return { ok: false, status: 503, error: credit.limitMessage ?? 'Please try again.' };
        if (credit.fairUse) return { ok: false, status: 429, error: credit.limitMessage ?? 'Please try again later.', code: 'FAIR_USE_LIMIT' };
        return { ok: false, status: 403, error: credit.limitMessage ?? 'You need a plan for this.', code: 'UPGRADE_REQUIRED' };
    }
    const modelChoice = await loadRoleModel(db, roleKey ?? 'social_media_manager');
    const payload = {
        platform: PLATFORM_LABEL[platform],
        person: row.participantName || null,
        conversation: thread.map((m) => ({ from: m.direction === 'in' ? 'them' : 'us', text: m.body ? m.body.slice(0, 1500) : `[${m.attachmentType || 'attachment'}]` })),
        current_draft: row.draftReply || null,
        max_characters: MAX_REPLY_CHARS[platform],
    };
    let reply: string | null = null;
    try {
        const { resp, model: used } = await withRoleModel(modelChoice, DRAFT_MODEL, async (model, thinking) => ({ model, resp: await anthropic.messages.create(adaptForModel({
            model,
            max_tokens: 700,
            system: `You draft the reply a business sends in a private ${PLATFORM_LABEL[platform]} message to someone who messaged it.

${businessBlock({ ...sender, knowledgeBlock, rulesBlock })}
${voice ? `\n${voice}\n` : ''}
${REPLY_RULES}

Return STRICT JSON only (no markdown): { "reply": "<the reply, or an empty string>" }`,
            messages: [{
                role: 'user',
                content: `${JSON.stringify(payload)}\n\n${instruction ? `What the business owner wants changed: ${instruction.trim().slice(0, 600)}` : row.draftReply ? 'Write a better reply.' : 'Write the reply to their latest message.'}`,
            }],
        }, model, thinking) as Anthropic.MessageCreateParamsNonStreaming, { timeout: 20_000, maxRetries: 0 }) }), { requestPath: true, label: 'social-message-reply' });
        await logMessageUsage(resp, used, { workspaceId: organisationId, assistantId, sessionId: 'social-message-reply' });
        const parsed = parseModelJson(replyText(resp.content)) as { reply?: unknown } | null;
        reply = parsed && typeof parsed.reply === 'string' ? tidyReply(parsed.reply, platform) : null;
    } catch (err) {
        console.error('[social-messages] draft failed', err instanceof Error ? err.message : err);
        return { ok: false, status: 502, error: 'The reply couldn’t be drafted just now — please try again.' };
    }
    if (reply === null) return { ok: false, status: 502, error: 'The reply couldn’t be drafted just now — please try again.' };
    await chargeHelper(db, organisationId, assistantId, `social-message-${id}`);
    if (!reply) return { ok: false, status: 422, error: 'This looks like spam or a sales pitch, so no reply was drafted. You can dismiss it, or write a reply yourself.', code: 'no_reply' };
    const [updated] = await db.update(socialConversations).set({ draftReply: reply, updatedAt: sql`now()` }).where(eq(socialConversations.id, row.id)).returning();
    return { ok: true, conversation: await viewOf(db, updated) };
}

/** POST /{page-id}/messages — the Send API, for Messenger and Instagram alike (Page token). */
export async function callSendApi(
    creds: { pageId: string; pageToken: string }, recipientId: string, text: string, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; messageId: string | null } | { ok: false; status: number; reason: SendRefusal; detail: string }> {
    try {
        const res = await fetchImpl(`https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(creds.pageId)}/messages?access_token=${encodeURIComponent(creds.pageToken)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } }),
            signal: AbortSignal.timeout(8000),
        });
        const data: any = await res.json().catch(() => ({}));
        if (res.ok && (data?.message_id || data?.recipient_id)) return { ok: true, messageId: data.message_id ? String(data.message_id) : null };
        // A 5xx is Meta failing on its side after it may have accepted the message.
        if (res.status >= 500) return { ok: false, status: res.status, reason: 'unconfirmed', detail: String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
        return { ok: false, status: res.status, reason: classifySendError(res.status, data), detail: String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
    } catch (err) {
        // Timed out or the connection dropped: Meta may already have delivered it. Never say "try again".
        return { ok: false, status: 0, reason: 'unconfirmed', detail: String((err as Error)?.message ?? err).slice(0, 300) };
    }
}

/**
 * "Send" — the ONLY path that sends a message. Sends `text` (or the saved draft) as the Page /
 * Instagram account, then files the conversation as replied. Called from a person's click only.
 *
 * ⚠️ The 24-hour window is checked against the database clock right before the call. A transaction-
 * scoped advisory lock per conversation stops the tab and the chat card (or a double click) sending
 * at the same moment; the same text as the latest reply, with nothing new from them since, is refused
 * as a repeat (isRepeatSend) — whenever it was sent.
 */
export async function sendReply(
    db: Db, organisationId: number, assistantId: number, id: number, text: string | null, userId: number | null,
    deps: { fetchImpl?: typeof fetch; credsFor?: (db: Db, connectionId: number) => Promise<{ pageId: string; pageToken: string } | null> } = {},
): Promise<{ ok: true; conversation: ConversationView } | { ok: false; status: number; error: string; code?: string }> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const credsFor = deps.credsFor ?? ((d: Db, cid: number) => pageCredentialsForConnection(d, cid, fetchImpl));
    // Set the moment Meta accepts — from then on nothing may report a failure (that invites a second send).
    let accepted: { mid: string | null } | null = null;
    // Meta is called only while there is time left to record what it says (the function stops at 26s).
    const startedAt = Date.now();
    const first = await loadConversation(db, organisationId, assistantId, id);
    if (!first) return { ok: false, status: 404, error: 'That conversation isn’t on this assistant’s Messages tab.' };
    const platform: MessagingPlatform = first.platform === 'instagram' ? 'instagram' : 'facebook';
    const reply = tidyReply(text ?? first.draftReply ?? '', platform);
    if (!reply) return { ok: false, status: 400, error: 'Write a reply first.' };
    if (!messagingEnabled()) return { ok: false, status: 409, error: 'Sending messages isn’t switched on for this workspace yet.', code: 'not_enabled' };

    return db.transaction(async (txAny) => {
        const tx = txAny as unknown as Db;
        const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`social-send:${id}`})) AS ok`) as unknown as Array<{ ok: boolean }>;
        if (lock && lock.ok === false) return { ok: false as const, status: 409, error: 'This reply is already being sent.', code: 'busy' };

        // Re-read under the lock, with the database's own clock deciding the window.
        const [row] = await tx.select({
            c: socialConversations,
            open: sql<boolean>`${socialConversations.windowClosesAt} > now()`,
        }).from(socialConversations)
            .where(and(eq(socialConversations.id, id), eq(socialConversations.organisationId, organisationId), eq(socialConversations.aiAssistantId, assistantId)))
            .limit(1);
        if (!row) return { ok: false as const, status: 404, error: 'That conversation isn’t on this assistant’s Messages tab.' };
        if (!row.open) return { ok: false as const, status: 409, error: REFUSAL_COPY.window_closed, code: 'window_closed' };

        // The same text as the latest reply, with nothing new from them since, is a repeat — a double
        // click, or an old chat card pressed after the tab already answered — never a choice.
        const [latestOut] = await tx.select({ body: socialMessages.body, sentAt: socialMessages.sentAt }).from(socialMessages)
            .where(and(eq(socialMessages.conversationId, id), eq(socialMessages.direction, 'out')))
            .orderBy(desc(socialMessages.sentAt), desc(socialMessages.id)).limit(1);
        if (isRepeatSend(reply, latestOut ?? null, row.c.lastInboundAt)) {
            return { ok: false as const, status: 409, error: 'You’ve already sent this reply, and they haven’t written since.', code: 'duplicate' };
        }

        const creds = await credsFor(tx, row.c.connectionId);
        if (!creds) return { ok: false as const, status: 409, error: REFUSAL_COPY.not_connected, code: 'not_connected' };

        // Too slow so far (a cold database, a slow token): stop BEFORE Meta — nothing has gone, so trying
        // again is safe. Past this point a timeout could cut us off after Meta delivered.
        if (Date.now() - startedAt > SEND_DEADLINE_MS) {
            return { ok: false as const, status: 503, error: 'That took too long to get ready, so nothing was sent. Please try again.', code: 'too_slow' };
        }
        const sent = await callSendApi(creds, row.c.participantId, reply, fetchImpl);
        if (!sent.ok) {
            console.warn(`[social-messages] send refused for conversation ${id}: ${sent.reason} — ${sent.detail}`);
            // Keep what they typed as the draft so nothing is lost.
            await tx.update(socialConversations).set({ draftReply: reply, updatedAt: sql`now()` }).where(eq(socialConversations.id, id));
            return { ok: false as const, status: sent.reason === 'meta_error' || sent.reason === 'unconfirmed' ? 502 : 409, error: REFUSAL_COPY[sent.reason], code: sent.reason };
        }
        accepted = { mid: sent.messageId };
        // ⚠️ From here the message HAS gone. Bookkeeping runs in a savepoint: if it fails, the outer
        // transaction still commits and the rows are written again after it — the user is never told
        // to try again (which would send it twice).
        const mid = sent.messageId;
        try {
            await (txAny as { transaction: (f: (t: unknown) => Promise<void>) => Promise<void> }).transaction(async (sp) => recordSent(sp as Db, { organisationId, id, mid, reply, userId }));
        } catch (err) {
            console.error(`[social-messages] conversation ${id}: sent, but recording it failed — retrying after commit`, err instanceof Error ? err.message : err);
            return { ok: true as const, recordLater: { mid } as { mid: string | null } };
        }
        return { ok: true as const, recordLater: null };
    }).catch((err) => {
        // The commit itself failed. Before Meta accepted: an ordinary error. After: it went — record it below.
        if (!accepted) throw err;
        console.error(`[social-messages] conversation ${id}: sent, but the commit failed — recording after`, err instanceof Error ? err.message : err);
        return { ok: true as const, recordLater: { mid: accepted.mid } };
    }).then(async (r) => {
        if (!r.ok) return r;
        if (r.recordLater) await recordSent(db, { organisationId, id, mid: r.recordLater.mid, reply, userId }).catch((err) => console.error(`[social-messages] conversation ${id}: recording a sent reply failed twice`, err instanceof Error ? err.message : err));
        const fresh = await loadConversation(db, organisationId, assistantId, id).catch(() => null);
        return { ok: true as const, conversation: fresh ? await viewOf(db, fresh).catch(() => conversationView(fresh, [])) : conversationView(first, []) };
    });
}

/** Same text as the latest reply, and nothing from them since. Pure. */
export function isRepeatSend(reply: string, latestOut: { body: string | null; sentAt: Date | string | null } | null, lastInboundAt: Date | string | null): boolean {
    if (!latestOut || latestOut.body == null || latestOut.body.trim() !== reply.trim()) return false;
    const outAt = new Date(toIso(latestOut.sentAt as Date | string | null) ?? 0).getTime();
    const inAt = lastInboundAt ? new Date(toIso(lastInboundAt as Date | string) ?? 0).getTime() : 0;
    return inAt <= outAt;
}

/**
 * File a reply Meta accepted. Idempotent on mid: the echo webhook delivers the same message, and
 * whichever lands first, the row ends up marked as sent from here. With no message id from Meta it
 * is filed under a `pending:` placeholder at once — so the repeat guard sees it — and the echo gives
 * that row Meta's real id instead of filing it again (meta-messaging.ts storeInTx, step 1b).
 */
async function recordSent(db: Db, a: { organisationId: number; id: number; mid: string | null; reply: string; userId: number | null }): Promise<void> {
    await db.insert(socialMessages).values({
        organisationId: a.organisationId, conversationId: a.id, direction: 'out',
        mid: a.mid ?? `pending:${a.id}:${Date.now()}`, body: a.reply, sentAt: sql`now()` as unknown as Date, sentBy: a.userId,
    }).onConflictDoUpdate({ target: socialMessages.mid, set: { sentBy: sql`COALESCE(${socialMessages.sentBy}, excluded.sent_by)` } });
    await db.update(socialConversations)
        .set({ status: 'replied', lastOutboundAt: sql`now()`, draftReply: null, decidedBy: a.userId, decidedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(socialConversations.id, a.id));
}

// ── Notifications + the tick ─────────────────────────────────────────────────────────────────

/** The webhook filed a message that opened a conversation: tell the assistant's owner. Never throws. */
export async function notifyConversationOpened(db: Db, r: { conversationId: number; organisationId: number; assistantId: number | null; platform: MessagingPlatform }): Promise<void> {
    try {
        if (!r.assistantId) return;
        const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name, lifecycle: aiAssistants.lifecycleStatus }).from(aiAssistants).where(eq(aiAssistants.id, r.assistantId)).limit(1);
        // An archived assistant's conversations are kept but nobody is pinged (as the tick skips them).
        if (!owner?.userId || owner.lifecycle === 'archived') return;
        await createNotification(db, 'social_message_received', {
            userId: owner.userId, assistantId: r.assistantId, category: 'suggested_action',
            context: { assistant: { name: owner.name }, platform: { name: PLATFORM_LABEL[r.platform] } },
            metadata: { assistantId: r.assistantId, conversationId: r.conversationId, platform: r.platform },
        });
    } catch (err) {
        console.error('[social-messages] notify failed', err instanceof Error ? err.message : err);
    }
}

/**
 * Every 15 minutes (social-messages-tick.ts):
 *  1. one "4 hours left" reminder per waiting conversation per window (reminded_for_window);
 *  2. message text older than RETENTION_DAYS is blanked (owner decision D6) — the rows and counts stay.
 */
export async function runMessagesTick(db: Db): Promise<{ reminded: number; purged: number }> {
    let reminded = 0;
    const due = await db.select({
        id: socialConversations.id, organisationId: socialConversations.organisationId, assistantId: socialConversations.aiAssistantId,
        platform: socialConversations.platform, windowClosesAt: socialConversations.windowClosesAt, participantName: socialConversations.participantName,
    }).from(socialConversations).where(and(
        eq(socialConversations.status, 'new'),
        sql`${socialConversations.windowClosesAt} > now()`,
        sql`${socialConversations.windowClosesAt} <= now() + make_interval(secs => ${REMINDER_BEFORE_MS / 1000})`,
        sql`${socialConversations.remindedForWindow} IS DISTINCT FROM ${socialConversations.windowClosesAt}`,
        notArchivedAssistant(socialConversations.aiAssistantId),
    )).limit(500);
    for (const c of due) {
        // Claim first: a second tick running at the same time must not remind twice.
        const [claimed] = await db.update(socialConversations)
            .set({ remindedForWindow: sql`${socialConversations.windowClosesAt}` })
            .where(and(eq(socialConversations.id, c.id), sql`${socialConversations.remindedForWindow} IS DISTINCT FROM ${socialConversations.windowClosesAt}`))
            .returning({ id: socialConversations.id });
        if (!claimed || !c.assistantId) continue;
        const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, c.assistantId)).limit(1);
        if (!owner?.userId) continue;
        const platform: MessagingPlatform = c.platform === 'instagram' ? 'instagram' : 'facebook';
        const ok = await createNotification(db, 'social_message_window_closing', {
            userId: owner.userId, assistantId: c.assistantId, category: 'suggested_action',
            context: { assistant: { name: owner.name }, platform: { name: PLATFORM_LABEL[platform] }, person: { name: c.participantName || 'Someone' } },
            metadata: { assistantId: c.assistantId, conversationId: c.id, platform },
        });
        if (ok) reminded++;
    }
    const purged = await db.update(socialMessages)
        .set({ body: null })
        .where(and(lt(socialMessages.sentAt, sql`now() - make_interval(days => ${RETENTION_DAYS})`), sql`${socialMessages.body} IS NOT NULL`))
        .returning({ id: socialMessages.id });
    await db.update(socialConversations)
        .set({ draftReply: null })
        .where(and(
            sql`coalesce(${socialConversations.lastInboundAt}, ${socialConversations.createdAt}) < now() - make_interval(days => ${RETENTION_DAYS})`,
            sql`${socialConversations.draftReply} IS NOT NULL`,
        ));
    return { reminded, purged: purged.length };
}

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────

/** How many waiting conversations the chat sees by name. The block says when there are more. */
export const CHAT_SNAPSHOT_CONVERSATIONS = 10;

/** Hours and minutes left, for the chat and the tab. Pure. */
export function timeLeftLabel(windowClosesAt: string | null, now = Date.now()): string {
    if (!windowClosesAt) return 'closed';
    const ms = new Date(windowClosesAt).getTime() - now;
    if (ms <= 0) return 'closed';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h ? `${h}h ${m}m left` : `${m}m left`;
}

/**
 * What the Social Media assistant's chat knows about its Messages tab, per turn, and the card it may
 * propose. Null when the tables are missing or the read failed — the prompt then says nothing
 * rather than something false.
 */
export async function buildMessagesChatBlock(db: Db, organisationId: number, assistantId: number): Promise<string | null> {
    try {
        const { conversations, counts, connection } = await listConversations(db, organisationId, assistantId, { lookUpNames: false });
        if (!connection.enabled && !conversations.length) return null;
        const waiting = conversations.filter((c) => c.status === 'new').slice(0, CHAT_SNAPSHOT_CONVERSATIONS);
        const lines = waiting.map((c) => {
            const last = [...c.messages].reverse().find((m) => m.direction === 'in');
            const said = last?.body ? `"${last.body.replace(/\s+/g, ' ').slice(0, 140)}"` : `[${last?.attachmentType || 'attachment'}]`;
            return `#${c.id} · ${PLATFORM_LABEL[c.platform]} · ${c.personLabel} · ${said} · ${c.windowOpen ? timeLeftLabel(c.windowClosesAt) : 'reply window closed'}${c.draftReply ? ' · reply drafted' : ''}`;
        });
        const state = !connection.connected
            ? 'No Facebook Page or Instagram account is connected, so no messages arrive. The user connects them in Connections.'
            : connection.needsReconnect
                ? 'Facebook / Instagram is connected but messages aren’t switched on for it yet: the user reconnects Facebook (and Instagram) in Connections and leaves the messaging permissions ticked.'
                : 'Messages from the connected Facebook Page and Instagram account arrive here as they are sent.';
        return `YOUR MESSAGES TAB — private messages people sent to the business's Facebook Page and Instagram account. ${state}
Conversations: ${counts.new} waiting, ${counts.replied} replied, ${counts.dismissed} dismissed.${lines.length ? `\nWaiting${counts.new > lines.length ? ` (the ${lines.length} most recent of ${counts.new})` : ''}:\n${lines.join('\n')}` : ''}
Meta only lets the business reply within 24 hours of the person's last message ("reply window"). After that the reply can only be written in the Facebook or Instagram app.

To act on a conversation, emit a message_action_proposal uiElement — the user confirms on the card, and only their click changes anything:
{ "type": "message_action_proposal", "action": "draft" | "send" | "dismiss",
  "conversationId": <the number after # above>,
  "instruction": "<what to change, in the user's words>" | null }   // draft only
"draft" writes (or rewrites) the reply on the card, in the brand's voice, without sending it. "send" sends the reply shown on the card to that person as the business — offer it only after a reply is drafted and only while the reply window is open. Never write the reply in your own message: the card shows it and the user can edit it there. Never say a message HAS been sent, drafted or dismissed — the card does nothing until the user presses its button; say "Press Send on the card to send it". ONE card per message.
You never message anyone on your own, never message someone who hasn't messaged the business first, and never send after the reply window closes.`;
    } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } } | null;
        const code = e?.code ?? e?.cause?.code;
        if (code !== '42P01' && code !== '42703') console.error('[social-messages] chat block failed', err instanceof Error ? err.message : err);
        return null;
    }
}

