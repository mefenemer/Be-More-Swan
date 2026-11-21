// src/utils/meta-messaging.ts
// Facebook Page + Instagram messages, Phase 1 (docs/meta-messages-plan.md): everything the webhook
// and the connect / disconnect paths need, kept here so the pure parts are unit-tested.
//
//   verifyMetaSignature   — X-Hub-Signature-256 check over the RAW body (the webhook's only lock)
//   parseMessagingWebhook — Meta's payload → flat list of messages we store (pure)
//   storeMessagingEvent   — one message → social_conversations + social_messages (idempotent on mid)
//   subscribePageToMessages / unsubscribePageFromMessages — POST/DELETE /{page-id}/subscribed_apps
//
// ⚠️ Nothing here SENDS a message. Replies go out only from a person's click (Phase 2), and only
// while the 24-hour window Meta allows is open: window_closes_at = the person's last message + 24h.
// Our own replies never extend it.
//
// META_MESSAGING_ENABLED (env, 'true' to switch on) gates the three messaging permissions on the
// Facebook Login dialog and the Page subscription on connect. Off until Meta approves them: asking
// a customer for a permission the app isn't approved for is exactly what App Review is about.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { socialConversations, socialMessages, systemConnections } from '../../db/schema';
import { FB_GRAPH_VERSION } from './social-publish';

type Db = ReturnType<typeof getDb>;

/** The permissions messages need on top of the posting ones (meta-oauth.ts SCOPES). */
export const MESSAGING_SCOPES = ['pages_messaging', 'instagram_manage_messages', 'pages_manage_metadata'] as const;

/** The Page webhook fields we subscribe to. Instagram DMs arrive through the same Page subscription. */
export const SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,message_echoes';

/** Meta lets a Page / IG account reply for this long after the person's LAST message. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function messagingEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return env.META_MESSAGING_ENABLED === 'true';
}

/** `base` plus the messaging permissions when switched on. Never duplicates one already in `base`. */
export function withMessagingScopes(base: string, enabled: boolean): string {
    if (!enabled) return base;
    const have = new Set(base.split(',').map(s => s.trim()).filter(Boolean));
    const extra = MESSAGING_SCOPES.filter(s => !have.has(s));
    return extra.length ? `${base},${extra.join(',')}` : base;
}

// ── Signature ────────────────────────────────────────────────────────────────────────────────

/**
 * Meta signs every webhook POST with HMAC-SHA256 of the raw body, keyed with the app secret, as
 * `X-Hub-Signature-256: sha256=<hex>`. Must see the exact bytes Meta sent — never a re-serialised
 * JSON. Missing secret or header → false (fail closed).
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined | null, appSecret: string | undefined): boolean {
    if (!appSecret || !header) return false;
    const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
    if (!m) return false;
    const expected = createHmac('sha256', appSecret).update(rawBody).digest();
    const given = Buffer.from(m[1], 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

export type MessagingPlatform = 'facebook' | 'instagram';

export interface ParsedMessage {
    platform: MessagingPlatform;
    /** The Page id (facebook) or IG professional account id (instagram) — the webhook entry id. */
    accountId: string;
    /** The person on the other side: page-scoped / Instagram-scoped id. */
    participantId: string;
    direction: 'in' | 'out';
    mid: string;
    text: string | null;
    attachmentType: string | null;
    sentAt: Date;
    /** Instagram tells us when the person unsent a message: blank our copy. */
    deleted: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : (typeof v === 'number' ? String(v) : null));

/**
 * Meta's webhook body → the messages we keep. `object` 'page' = Messenger, 'instagram' = Instagram.
 * Kept: messages (text and/or attachments), echoes of the Page's own replies (sent here or in
 * Meta's apps — that's how a reply typed in Messenger marks the conversation replied), postbacks
 * (a button the person tapped — stored as inbound text), Instagram unsends.
 * Dropped: read / delivery / reaction / typing events, anything without ids or a mid.
 */
export function parseMessagingWebhook(body: unknown): ParsedMessage[] {
    const b = body as { object?: unknown; entry?: unknown } | null;
    if (!b || typeof b !== 'object') return [];
    const platform: MessagingPlatform | null = b.object === 'page' ? 'facebook' : b.object === 'instagram' ? 'instagram' : null;
    if (!platform || !Array.isArray(b.entry)) return [];

    const out: ParsedMessage[] = [];
    for (const entry of b.entry as any[]) {
        const accountId = str(entry?.id);
        if (!accountId || !Array.isArray(entry?.messaging)) continue;
        for (const ev of entry.messaging as any[]) {
            const senderId = str(ev?.sender?.id);
            const recipientId = str(ev?.recipient?.id);
            if (!senderId || !recipientId || senderId === recipientId) continue;
            const ts = typeof ev?.timestamp === 'number' ? ev.timestamp : Number(ev?.timestamp);
            const sentAt = sentAtFrom(ts);

            if (ev.message && typeof ev.message === 'object') {
                const msg = ev.message;
                const mid = str(msg.mid);
                if (!mid) continue;
                const isEcho = msg.is_echo === true;
                // An echo comes FROM the account; anything else must come from someone else TO it.
                // A message that names neither side as the account is not ours to file.
                if (isEcho ? senderId !== accountId : recipientId !== accountId) continue;
                const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
                out.push({
                    platform, accountId,
                    participantId: isEcho ? recipientId : senderId,
                    direction: isEcho ? 'out' : 'in',
                    mid,
                    text: typeof msg.text === 'string' && msg.text.length ? msg.text : null,
                    attachmentType: attachments.length ? (str(attachments[0]?.type) ?? 'file') : null,
                    sentAt,
                    deleted: msg.is_deleted === true,
                });
                continue;
            }

            if (ev.postback && typeof ev.postback === 'object') {
                if (recipientId !== accountId) continue;
                // Postbacks have a mid on Instagram, not always on Messenger: derive a stable one so
                // a retried delivery still dedupes.
                // Hashed from the event itself, so it is the same on every retry even with no timestamp.
                const mid = str(ev.postback.mid) ?? `postback:${createHash('sha256').update(JSON.stringify([accountId, senderId, ev.timestamp ?? null, ev.postback])).digest('hex').slice(0, 32)}`;
                out.push({
                    platform, accountId, participantId: senderId, direction: 'in', mid,
                    text: str(ev.postback.title) ?? str(ev.postback.payload),
                    attachmentType: null, sentAt, deleted: false,
                });
            }
        }
    }
    return out;
}

/**
 * Meta's millisecond timestamp → a Date we can store. Anything missing, non-numeric, before 2015 or
 * more than a day ahead becomes "now": an out-of-range value would make an Invalid Date, whose
 * toISOString() throws, and the webhook would answer 500 for that delivery forever.
 */
export function sentAtFrom(ts: number, now = Date.now()): Date {
    return Number.isFinite(ts) && ts > 1_420_070_400_000 && ts < now + REPLY_WINDOW_MS ? new Date(ts) : new Date(now);
}

/** When Meta stops letting the account reply, given the person's last message. */
export function windowClosesAt(lastInboundAt: Date): Date {
    return new Date(lastInboundAt.getTime() + REPLY_WINDOW_MS);
}

// ── Storing ──────────────────────────────────────────────────────────────────────────────────

export type StoreResult =
    /** `opened`: the conversation now waits on the business when it didn't a moment ago — a new
     *  conversation, or a new message after a reply / dismiss. The webhook notifies only then. */
    | { stored: true; conversationId: number; opened: boolean; organisationId: number; assistantId: number | null; platform: MessagingPlatform }
    | { stored: false; reason: 'duplicate' | 'unknown_account' | 'ambiguous_account' | 'deleted_applied' | 'deleted_unknown' };

/**
 * The active connection a webhook entry belongs to. facebook → the Page's 'facebook' row,
 * instagram → the IG account's 'instagram' row (external_user_id is that id in both cases, see
 * meta-accounts.ts). More than one active row (should be impossible with the one-workspace-per-
 * account block) → refuse rather than guess whose inbox it is.
 */
export async function findMessagingConnection(db: Db, platform: MessagingPlatform, accountId: string) {
    const rows = await db
        .select({ id: systemConnections.id, organisationId: systemConnections.organisationId, assistantId: systemConnections.assistantId })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.serviceName, platform),
            eq(systemConnections.externalUserId, accountId),
            eq(systemConnections.isActive, true),
        ))
        .limit(2);
    if (rows.length === 0) return { error: 'unknown_account' as const };
    if (rows.length > 1) return { error: 'ambiguous_account' as const };
    return { connection: rows[0] };
}

/**
 * File one parsed message. Idempotent: the message row is unique on mid, and the conversation's
 * clocks only ever move forward (GREATEST), so a retried or out-of-order delivery changes nothing.
 *
 * Status: a new message from the person → 'new' (even if it was replied or dismissed) unless the
 * account has already replied after it; a reply from the account sent after the person's last
 * message → 'replied'.
 */
export async function storeMessagingEvent(db: Db, m: ParsedMessage): Promise<StoreResult> {
    // One transaction: if moving the clocks failed after the message row was written, Meta's retry
    // would see a duplicate and stop, leaving the conversation without that message's window and
    // status for good. All or nothing, so the retry redoes the lot.
    return db.transaction(async (tx) => storeInTx(tx as unknown as Db, m));
}

async function storeInTx(db: Db, m: ParsedMessage): Promise<StoreResult> {
    if (m.deleted) {
        const res = await db.update(socialMessages)
            .set({ body: null, attachmentType: null })
            .where(eq(socialMessages.mid, m.mid))
            .returning({ id: socialMessages.id });
        return { stored: false, reason: res.length ? 'deleted_applied' : 'deleted_unknown' };
    }

    const found = await findMessagingConnection(db, m.platform, m.accountId);
    if ('error' in found) return { stored: false, reason: found.error! };
    const conn = found.connection;

    // 1. The conversation row (created or found) — the no-op update makes RETURNING give the id.
    const [conv] = await db.insert(socialConversations)
        .values({
            organisationId: conn.organisationId,
            aiAssistantId: conn.assistantId,
            connectionId: conn.id,
            platform: m.platform,
            accountExternalId: m.accountId,
            participantId: m.participantId,
        })
        .onConflictDoUpdate({
            target: [socialConversations.connectionId, socialConversations.participantId],
            // Follow the connection if a reconnect moved it to another assistant, so its earlier
            // conversations show on the new one. updatedAt untouched: this is bookkeeping, not news.
            set: {
                aiAssistantId: conn.assistantId ?? sql`${socialConversations.aiAssistantId}`,
                updatedAt: sql`${socialConversations.updatedAt}`,
            },
        })
        // xmax = 0 only on a freshly inserted row: tells a new conversation from a found one.
        .returning({
            id: socialConversations.id, created: sql<boolean>`(xmax = 0)`,
            statusBefore: socialConversations.status, windowBefore: socialConversations.windowClosesAt,
        });

    // 1b. The echo of a reply sent from the Messages tab when Meta gave no message id: that reply was
    // filed under a placeholder (social-messages.ts recordSent). Give it Meta's real id instead of
    // filing it a second time — so it shows once and keeps "sent from here".
    if (m.direction === 'out' && m.text) {
        const reconciled = await db.execute(sql`
            UPDATE social_messages SET mid = ${m.mid}
            WHERE id = (SELECT id FROM social_messages
                        WHERE conversation_id = ${conv.id} AND direction = 'out' AND mid LIKE 'pending:%' AND body = ${m.text}
                        ORDER BY id LIMIT 1)
            RETURNING id`) as unknown as unknown[];
        if ((Array.isArray(reconciled) ? reconciled : (reconciled as { rows?: unknown[] }).rows ?? []).length) return { stored: false, reason: 'duplicate' };
    }

    // 2. The message. Already have it → nothing else to do.
    const inserted = await db.insert(socialMessages)
        .values({
            organisationId: conn.organisationId,
            conversationId: conv.id,
            direction: m.direction,
            mid: m.mid,
            body: m.text,
            attachmentType: m.attachmentType,
            sentAt: m.sentAt,
        })
        .onConflictDoNothing({ target: socialMessages.mid })
        .returning({ id: socialMessages.id });
    if (inserted.length === 0) return { stored: false, reason: 'duplicate' };

    // 3. Move the clocks and the status. The time goes in as a plain UTC `timestamp`, the way
    // Drizzle writes these columns — a raw Date parameter would arrive as timestamptz and be shifted
    // by the session's time zone when mixed with the column in GREATEST.
    const at = sql`${m.sentAt.toISOString()}::timestamp`;
    if (m.direction === 'in') {
        await db.update(socialConversations).set({
            lastInboundAt: sql`GREATEST(COALESCE(${socialConversations.lastInboundAt}, ${at}), ${at})`,
            windowClosesAt: sql`GREATEST(COALESCE(${socialConversations.lastInboundAt}, ${at}), ${at}) + interval '24 hours'`,
            status: sql`CASE WHEN ${socialConversations.lastOutboundAt} IS NULL OR ${socialConversations.lastOutboundAt} < ${at} THEN 'new' ELSE ${socialConversations.status} END`,
            updatedAt: new Date(),
        }).where(eq(socialConversations.id, conv.id));
        const [after] = await db.select({ status: socialConversations.status }).from(socialConversations).where(eq(socialConversations.id, conv.id)).limit(1);
        // Also when it was still "waiting" but Meta had closed the reply window before this message: the
        // business can answer again now, and only a notification tells them so (the 4-hour reminder
        // would come ~20 hours later).
        const windowHadClosed = conv.windowBefore != null && new Date(conv.windowBefore).getTime() <= m.sentAt.getTime();
        const opened = after?.status === 'new' && (conv.created === true || conv.statusBefore !== 'new' || windowHadClosed);
        return { stored: true, conversationId: conv.id, opened, organisationId: conn.organisationId, assistantId: conn.assistantId, platform: m.platform };
    } else {
        await db.update(socialConversations).set({
            lastOutboundAt: sql`GREATEST(COALESCE(${socialConversations.lastOutboundAt}, ${at}), ${at})`,
            status: sql`CASE WHEN ${socialConversations.lastInboundAt} IS NULL OR ${socialConversations.lastInboundAt} <= ${at} THEN 'replied' ELSE ${socialConversations.status} END`,
            updatedAt: new Date(),
        }).where(eq(socialConversations.id, conv.id));
    }
    return { stored: true, conversationId: conv.id, opened: false, organisationId: conn.organisationId, assistantId: conn.assistantId, platform: m.platform };
}

/**
 * Postgres "relation does not exist" — the tables aren't created on this database yet. Drizzle 1.0
 * wraps driver errors (DrizzleQueryError) and puts the Postgres error on `.cause`, so `err.code`
 * alone is always undefined; check both.
 */
export function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

/**
 * Disconnect skipped the unsubscribe because another active row still uses the Page: hand the
 * subscription over to those rows, so the last one to go undoes it (Disconnect only unsubscribes a
 * row marked subscribed).
 */
export async function markPageSubscribedOnOtherRows(db: Db, pageId: string, exceptConnectionId: number): Promise<void> {
    await db.update(systemConnections).set({
        metadata: sql`jsonb_set(COALESCE(${systemConnections.metadata}, '{}'::jsonb), '{messaging}', '{"subscribed": true}'::jsonb)`,
    }).where(and(
        sql`${systemConnections.serviceName} IN ('facebook','instagram')`,
        eq(systemConnections.isActive, true),
        sql`${systemConnections.id} <> ${exceptConnectionId}`,
        sql`(${systemConnections.metadata}->>'fbPageId' = ${pageId} OR (${systemConnections.serviceName} = 'facebook' AND ${systemConnections.externalUserId} = ${pageId}))`,
    ));
}

// ── Page subscription ────────────────────────────────────────────────────────────────────────

export type SubscribeResult = { ok: true } | { ok: false; error: string };

export async function pageTokenFor(userToken: string, pageId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    const res = await fetchImpl(
        `https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(userToken)}`,
        { signal: AbortSignal.timeout(5000) },
    );
    const data: any = await res.json().catch(() => ({}));
    return res.ok ? (data?.access_token ?? null) : null;
}

/**
 * Ask Meta to send this Page's messages (and its linked Instagram account's DMs) to our webhook.
 * Needs pages_manage_metadata. Never throws: the result is recorded on the connection and a failure
 * must not break connecting.
 */
export async function subscribePageToMessages(userToken: string, pageId: string, fetchImpl: typeof fetch = fetch): Promise<SubscribeResult> {
    try {
        const pageToken = await pageTokenFor(userToken, pageId, fetchImpl);
        if (!pageToken) return { ok: false, error: 'no_page_token' };
        const res = await fetchImpl(`https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ subscribed_fields: SUBSCRIBED_FIELDS, access_token: pageToken }).toString(),
            signal: AbortSignal.timeout(5000),
        });
        const data: any = await res.json().catch(() => ({}));
        if (res.ok && data?.success === true) return { ok: true };
        return { ok: false, error: String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
    } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
    }
}

/** Stop Meta sending this Page's messages to us. Best effort, never throws. */
export async function unsubscribePageFromMessages(userToken: string, pageId: string, fetchImpl: typeof fetch = fetch): Promise<SubscribeResult> {
    try {
        const pageToken = await pageTokenFor(userToken, pageId, fetchImpl);
        if (!pageToken) return { ok: false, error: 'no_page_token' };
        const res = await fetchImpl(
            `https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`,
            { method: 'DELETE', signal: AbortSignal.timeout(5000) },
        );
        const data: any = await res.json().catch(() => ({}));
        if (res.ok && data?.success === true) return { ok: true };
        return { ok: false, error: String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
    } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
    }
}

/**
 * Disconnecting one Facebook / Instagram row may unsubscribe its Page only when no OTHER active
 * facebook/instagram row, in any workspace, still points at that Page: a Page's Facebook row and
 * its Instagram row share one subscription.
 */
export async function pageStillInUse(db: Db, pageId: string, exceptConnectionId: number): Promise<boolean> {
    const rows = await db.select({ id: systemConnections.id }).from(systemConnections).where(and(
        sql`${systemConnections.serviceName} IN ('facebook','instagram')`,
        eq(systemConnections.isActive, true),
        sql`${systemConnections.id} <> ${exceptConnectionId}`,
        sql`(${systemConnections.metadata}->>'fbPageId' = ${pageId} OR (${systemConnections.serviceName} = 'facebook' AND ${systemConnections.externalUserId} = ${pageId}))`,
    )).limit(1);
    return rows.length > 0;
}
