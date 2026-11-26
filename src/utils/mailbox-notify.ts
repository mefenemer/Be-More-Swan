// src/utils/mailbox-notify.ts — the Email Assistant's notifications (docs/email-assistant-plan.md §5.3).
//
// Two, both to the MAILBOX'S OWNER only (a mailbox is one person's — never the workspace's admins):
//   email_needs_you      (Needs you)  newly sorted mail includes something time-critical ("Now").
//                                     At most ONE open per mailbox; it clears when the owner opens the
//                                     Emails tab (resolveNowNotification, called by mailboxes.ts).
//   email_morning_digest (an update)  once a day, 07:00–11:59 in the workspace's time zone:
//                                     "3 need you (1 now) · 12 sorted yesterday · 5 ready to clear".
//                                     Skipped when every count is 0.
//
// ⚠️ Counts and the owner's own mailbox address only: never a sender, subject or summary. A notification
// can be read on a shared screen and is listed in the bell; an email's details stay in the Emails tab.
//
// Why not a section in the Business Mentor's morning summary (plan §2.3): that summary is built once per
// WORKSPACE and sent to every owner and admin, while email is one person's; and the Mentor never reads
// mailboxes (mentor-data-inventory.ts). So the Email Assistant sends its own note, in the same window.

import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, bookingSettings, mailboxMessages, mailboxes, masterAssistants, notifications } from '../../db/schema';
import { createNotification } from './notify';
import { resolveActionNotifications } from './notification-actions';
import { dayWindows, localNow, safeTimeZone, SEND_FROM_HOUR, SEND_UNTIL_HOUR } from './mentor-morning';
import { cleanupSuggestions } from './mailbox-actions';
import { EMAIL_ASSISTANT_FLAG, type MailboxRow } from './mailboxes';
import { isFeatureEnabled } from './feature-flags';

type Db = ReturnType<typeof getDb>;

export const NOW_TYPE = 'email_needs_you';
export const DIGEST_TYPE = 'email_morning_digest';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The workspace's Email Assistant (not archived), for the notification's "Open emails" button. */
async function emailAssistantId(db: Db, orgId: number): Promise<number | null> {
    const [row] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
        .innerJoin(masterAssistants, eq(masterAssistants.id, aiAssistants.masterAssistantId))
        .where(and(eq(aiAssistants.organisationId, orgId), eq(masterAssistants.roleKey, 'email_assistant'), isNull(aiAssistants.archivedAt)))
        .limit(1);
    return row?.id ?? null;
}

/**
 * Whether this workspace can open the Email Assistant at all: the flag is on AND it has one that isn't
 * archived. Neither notification is sent otherwise — a note for a feature the owner can't open, with no
 * "Open emails" button, is noise. Returns the assistant id, or null.
 */
async function reachableAssistantId(db: Db, orgId: number): Promise<number | null> {
    if (!(await isFeatureEnabled(orgId, EMAIL_ASSISTANT_FLAG))) return null;
    return emailAssistantId(db, orgId);
}

/** "2 emails need you now" / "1 email needs you now". Pure. */
export function nowPhrase(n: number): string {
    return `${plural(n, 'email')} need${n === 1 ? 's' : ''} you now`;
}

/**
 * After a sync sorted `nowCount` new time-critical emails: tell the owner, once. A second run while the
 * first notification is still open adds nothing (no pile of "needs you" cards). Never throws.
 */
export async function notifyNowEmails(db: Db, box: Pick<MailboxRow, 'id' | 'organisationId' | 'userId' | 'address'>, nowCount: number): Promise<boolean> {
    if (nowCount <= 0) return false;
    try {
        const [open] = await db.select({ id: notifications.id }).from(notifications)
            .where(and(eq(notifications.userId, box.userId), eq(notifications.type, NOW_TYPE), isNull(notifications.resolvedAt),
                eq(notifications.isRead, false), sql`${notifications.metadata}->>'mailboxId' = ${String(box.id)}`))
            .limit(1);
        if (open) return false;
        const assistantId = await reachableAssistantId(db, box.organisationId);
        if (!assistantId) return false;
        return await createNotification(db, NOW_TYPE, {
            userId: box.userId,
            assistantId,
            // Explicit so the stored column is right without notifications-categorization.sql re-applied.
            category: 'suggested_action',
            context: { emails: { now: nowPhrase(nowCount) }, mailbox: { address: box.address } },
            metadata: { mailboxId: box.id, assistantId },
        });
    } catch (err) {
        console.error('[mailbox-notify] now notification failed', { mailboxId: box.id, err: err instanceof Error ? err.message : err });
        return false;
    }
}

/** The owner opened their Emails tab: the "needs you now" card has done its job. Never throws. */
export async function resolveNowNotification(db: Db, userId: number): Promise<void> {
    await resolveActionNotifications(db, userId, [NOW_TYPE]).catch(() => 0);
}

export interface DigestCounts { needsYou: number; now: number; sortedYesterday: number; toClear: number }

/** The morning line, or null when there is nothing to say. Pure. */
export function digestLine(c: DigestCounts): string | null {
    if (!c.needsYou && !c.sortedYesterday && !c.toClear) return null;
    const parts: string[] = [];
    if (c.needsYou) parts.push(`${plural(c.needsYou, 'email')} need${c.needsYou === 1 ? 's' : ''} you${c.now ? ` (${c.now} now)` : ''}`);
    else parts.push('Nothing needs you');
    if (c.sortedYesterday) parts.push(`${c.sortedYesterday} sorted yesterday`);
    if (c.toClear) parts.push(`${c.toClear} ready to clear`);
    return parts.join(' · ');
}

/**
 * The morning note for one mailbox, at most once per local day (the latch is written FIRST, atomically,
 * into mailboxes.settings.lastDigestDay — two overlapping ticks can't both send). Never throws.
 */
export async function sendMorningDigest(db: Db, box: MailboxRow, now: Date = new Date()): Promise<boolean> {
    try {
        const [bs] = await db.select({ tz: bookingSettings.timezone }).from(bookingSettings)
            .where(eq(bookingSettings.organisationId, box.organisationId)).limit(1);
        const tz = safeTimeZone(bs?.tz);
        const { date: dayStr, hour } = localNow(now, tz);
        if (hour < SEND_FROM_HOUR || hour > SEND_UNTIL_HOUR) return false;
        // Before the latch, so a workspace that turns the assistant back on still gets today's note.
        const assistantId = await reachableAssistantId(db, box.organisationId);
        if (!assistantId) return false;

        // Latch first: only one tick per day gets past this.
        const won = await db.update(mailboxes)
            .set({ settings: sql`jsonb_set(coalesce(${mailboxes.settings}, '{}'::jsonb), '{lastDigestDay}', to_jsonb(${dayStr}::text))` })
            .where(and(eq(mailboxes.id, box.id), sql`coalesce(${mailboxes.settings}->>'lastDigestDay', '') <> ${dayStr}`))
            .returning({ id: mailboxes.id });
        if (!won.length) return false;

        const { yesterdayStart, todayStart } = dayWindows(dayStr, tz);
        const [c] = await db.select({
            needsYou: sql<number>`count(*) FILTER (WHERE ${mailboxMessages.priority} IN ('now','today') AND ${mailboxMessages.removedAt} IS NULL)::int`,
            now: sql<number>`count(*) FILTER (WHERE ${mailboxMessages.priority} = 'now' AND ${mailboxMessages.removedAt} IS NULL)::int`,
        }).from(mailboxMessages).where(eq(mailboxMessages.mailboxId, box.id));
        const [y] = await db.select({ n: sql<number>`count(*)::int` }).from(mailboxMessages)
            .where(and(eq(mailboxMessages.mailboxId, box.id), sql`${mailboxMessages.sortedBy} <> 'pending'`,
                gte(mailboxMessages.createdAt, yesterdayStart), lt(mailboxMessages.createdAt, todayStart)));
        const toClear = (await cleanupSuggestions(db, box).catch(() => [])).reduce((n, b) => n + b.messageIds.length, 0);
        const line = digestLine({ needsYou: c?.needsYou ?? 0, now: c?.now ?? 0, sortedYesterday: y?.n ?? 0, toClear });
        if (!line) return false;

        return await createNotification(db, DIGEST_TYPE, {
            userId: box.userId,
            assistantId,
            category: 'state_change',
            context: { digest: { line }, mailbox: { address: box.address } },
            metadata: { mailboxId: box.id, assistantId },
        });
    } catch (err) {
        console.error('[mailbox-notify] morning digest failed', { mailboxId: box.id, err: err instanceof Error ? err.message : err });
        return false;
    }
}
