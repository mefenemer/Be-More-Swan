// src/utils/mailbox-sync.ts — read a mailbox's new email and sort it (docs/email-assistant-plan.md §4).
//
// Woken by mailbox-sync-background.ts: right after a mailbox connects, and every 10 minutes by
// poll-mailboxes.ts. One run:
//   1. takes the mailbox's lease (sync_lock_until) — ONE reader at a time per mailbox, across instances;
//   2. reads the inbox's changes from the saved cursor (Graph delta / Gmail history), stores headers, marks removals;
//   3. sorts what is still pending: private senders, the user's sender rules, headers, then AI;
//   4. saves the cursor and releases the lease.
// Never throws to its caller. Nothing here writes to the mailbox (Phase 1 is read-only).

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { mailboxes, mailboxMessages, organisations } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { resolveBaseUrl } from './base-url';
import { isFeatureEnabled } from './feature-flags';
import { EMAIL_ASSISTANT_FLAG, MailboxError, getMailboxAccessToken, parseMailboxSettings, type MailboxRow } from './mailboxes';
import { cursorExpired, providerHttpError, readerFor } from './mail-reader';
import {
    buildTriageSystem, buildTriageUser, headerSort, parseTriageResponse, privateSort, senderRuleSort, trimEmailBody,
    type SortResult, type TriageInput,
} from './email-sort';

type Db = ReturnType<typeof getDb>;

/** The model that sorts (plan §7.2: triage on a small model). */
export const EMAIL_SORT_MODEL = 'claude-haiku-5-5';
/** Emails per AI call. */
const AI_BATCH = 10;
/** Emails sorted per run (any method); the rest wait for the next run. */
const SORT_PER_RUN = 120;
/**
 * At most this many emails sorted BY AI per mailbox per day. Phase 1 charges no tasks (the rate is set
 * from Phase 1's measured cost, plan §8), so this is the cost ceiling until then.
 */
export const AI_SORT_DAILY_CAP = 300;
/** The lease: longer than a background run (15 min) can't be, so a crashed run frees itself. */
const LEASE_MINUTES = 14;
/** Stop reading new pages after this long, leaving time to sort and save. */
const READ_BUDGET_MS = 6 * 60 * 1000;

/** Wake the background worker for one mailbox. Never throws; false when not dispatched. */
export async function triggerMailboxSync(mailboxId: number): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[mailbox-sync] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { mailboxId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/mailbox-sync-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ mailboxId }),
            signal: controller.signal,
        });
        return res.status === 202 || res.ok;
    } catch (err) {
        console.error('[mailbox-sync] dispatch failed', { mailboxId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Take the lease, or null when another run holds it (or the mailbox isn't active). */
async function takeLease(db: Db, mailboxId: number): Promise<MailboxRow | null> {
    const rows = await db.update(mailboxes)
        .set({ syncLockUntil: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
        .where(and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.status, 'active'),
            sql`(${mailboxes.syncLockUntil} IS NULL OR ${mailboxes.syncLockUntil} < now())`,
        ))
        .returning();
    return rows[0] ?? null;
}

export interface SyncOutcome { ran: boolean; read: number; sorted: number; aiSorted: number; error?: string }

/** One read-and-sort run for a mailbox. Never throws. */
export async function runMailboxSync(db: Db, mailboxId: number): Promise<SyncOutcome> {
    const box = await takeLease(db, mailboxId);
    if (!box) return { ran: false, read: 0, sorted: 0, aiSorted: 0 };
    const out: SyncOutcome = { ran: true, read: 0, sorted: 0, aiSorted: 0 };
    let lastError: string | null = null;
    try {
        if (!(await isFeatureEnabled(box.organisationId, EMAIL_ASSISTANT_FLAG))) return out;
        const reader = readerFor(box.provider);
        if (!reader) return out;

        const token = await getMailboxAccessToken(db, box);

        // ── 1. Read changes ──────────────────────────────────────────────────────────────────────
        let changes;
        try {
            changes = await reader.listChanges(token, box.address, box.syncCursor, Date.now() + READ_BUDGET_MS);
        } catch (err) {
            // The saved cursor expired (Graph 410, Gmail 404): start again from the 14-day window.
            const http = providerHttpError(err);
            if (http && box.syncCursor && cursorExpired(box.provider, http.status)) {
                changes = await reader.listChanges(token, box.address, null, Date.now() + READ_BUDGET_MS);
            } else throw err;
        }
        for (const m of changes.messages) {
            if (m.removed) {
                await db.update(mailboxMessages).set({ removedAt: new Date(), updatedAt: new Date() })
                    .where(and(eq(mailboxMessages.mailboxId, box.id), eq(mailboxMessages.providerMessageId, m.id)));
                continue;
            }
            await db.insert(mailboxMessages).values({
                mailboxId: box.id, organisationId: box.organisationId, providerMessageId: m.id, threadId: m.threadId,
                fromName: m.fromName, fromAddress: m.fromAddress, subject: m.subject, receivedAt: m.receivedAt,
                isRead: m.isRead, webLink: m.webLink,
            }).onConflictDoUpdate({
                target: [mailboxMessages.mailboxId, mailboxMessages.providerMessageId],
                // An update (read in Outlook, moved back into the inbox) never resets the sorting.
                set: { isRead: m.isRead, removedAt: null, updatedAt: new Date() },
            });
            out.read++;
        }
        await db.update(mailboxes).set({ syncCursor: changes.cursor, lastSyncAt: new Date(), updatedAt: new Date() }).where(eq(mailboxes.id, box.id));

        // ── 2. Sort what is pending ──────────────────────────────────────────────────────────────
        const settings = parseMailboxSettings(box.settings);
        const pending = await db.select().from(mailboxMessages)
            .where(and(eq(mailboxMessages.mailboxId, box.id), eq(mailboxMessages.sortedBy, 'pending'), isNull(mailboxMessages.removedAt)))
            .orderBy(desc(mailboxMessages.receivedAt)).limit(SORT_PER_RUN);

        const save = async (id: number, r: SortResult) => {
            await db.update(mailboxMessages).set({
                category: r.category, priority: r.priority, summary: r.summary, reason: r.reason, sortedBy: r.sortedBy, updatedAt: new Date(),
            }).where(eq(mailboxMessages.id, id));
            out.sorted++;
        };

        const forAi: { id: number; input: TriageInput }[] = [];
        const aiLeft = Math.max(0, AI_SORT_DAILY_CAP - await aiSortedToday(db, box.id));
        for (const msg of pending) {
            const free = privateSort(msg.fromAddress, settings.privateSenders) ?? senderRuleSort(msg.fromAddress, settings.senderRules);
            if (free) { await save(msg.id, free); continue; }
            const headers = await reader.getHeaders(token, msg.providerMessageId).catch(() => ({} as Record<string, string>));
            const byHeaders = headerSort({ fromAddress: msg.fromAddress, providerFolderHint: null }, headers);
            if (byHeaders) { await save(msg.id, byHeaders); continue; }
            if (forAi.length >= aiLeft) continue; // over today's ceiling: stays pending until tomorrow
            const body = await reader.getBody(token, msg.providerMessageId).then((b) => trimEmailBody(b.text)).catch(() => '');
            forAi.push({ id: msg.id, input: { ref: forAi.length + 1, fromName: msg.fromName, fromAddress: msg.fromAddress, subject: msg.subject, receivedAt: msg.receivedAt, body } });
        }

        if (forAi.length) {
            const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, box.organisationId)).limit(1);
            const system = buildTriageSystem({ name: org?.name ?? '', description: null });
            for (let i = 0; i < forAi.length; i += AI_BATCH) {
                const batch = forAi.slice(i, i + AI_BATCH).map((b, j) => ({ ...b, input: { ...b.input, ref: j + 1 } }));
                try {
                    const res = await gatewayGenerate({
                        system,
                        messages: [{ role: 'user', content: buildTriageUser(batch.map((b) => b.input)) }],
                        model: EMAIL_SORT_MODEL,
                        maxTokens: 1500,
                        usage: { workspaceId: box.organisationId, userId: box.userId, sessionId: 'email-sort', dataCategories: ['business_context'] },
                    });
                    const parsed = parseTriageResponse(res.text, batch.map((b) => b.input.ref));
                    for (const b of batch) {
                        const r = parsed.get(b.input.ref);
                        if (r) { await save(b.id, r); out.aiSorted++; }
                    }
                } catch (err) {
                    // The batch stays pending and is tried again next run.
                    console.error('[mailbox-sync] AI sort batch failed', { mailboxId: box.id, err: err instanceof Error ? err.message : err });
                }
            }
        }
    } catch (err) {
        if (err instanceof MailboxError) lastError = err.message;
        else if (providerHttpError(err)?.status === 401) {
            lastError = `${providerName(box.provider)} asked for this mailbox to be connected again.`;
            await db.update(mailboxes).set({ status: 'needs_reconnect' }).where(eq(mailboxes.id, box.id)).catch(() => undefined);
        } else if (providerHttpError(err)?.status === 429) {
            lastError = `${providerName(box.provider)} asked us to slow down; trying again shortly.`;
        } else {
            lastError = 'Reading this mailbox failed; trying again shortly.';
            console.error('[mailbox-sync] run failed', { mailboxId: box.id, err: err instanceof Error ? err.message : err });
        }
        out.error = lastError;
    } finally {
        await db.update(mailboxes).set({ syncLockUntil: null, lastError, updatedAt: new Date() })
            .where(eq(mailboxes.id, box.id)).catch(() => undefined);
    }
    return out;
}

/** The provider's name, for messages the user reads. Pure. */
export function providerName(provider: string): string {
    return provider === 'gmail' ? 'Gmail' : provider === 'outlook' ? 'Outlook' : 'Your email provider';
}

/** How many of this mailbox's emails the AI sorted since midnight UTC. */
async function aiSortedToday(db: Db, mailboxId: number): Promise<number> {
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(mailboxMessages)
        .where(and(eq(mailboxMessages.mailboxId, mailboxId), eq(mailboxMessages.sortedBy, 'ai'), gte(mailboxMessages.updatedAt, midnight)));
    return row?.n ?? 0;
}

/** Active mailboxes due a run: not read for 9+ minutes and not mid-run. */
export async function mailboxesDueForSync(db: Db, limit = 50): Promise<number[]> {
    const rows = await db.select({ id: mailboxes.id }).from(mailboxes)
        .where(and(
            eq(mailboxes.status, 'active'),
            sql`(${mailboxes.syncLockUntil} IS NULL OR ${mailboxes.syncLockUntil} < now())`,
            sql`(${mailboxes.lastSyncAt} IS NULL OR ${mailboxes.lastSyncAt} < now() - interval '9 minutes')`,
        ))
        .orderBy(sql`${mailboxes.lastSyncAt} ASC NULLS FIRST`).limit(limit);
    return rows.map((r) => r.id);
}
