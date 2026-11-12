// src/utils/ticket-auto-close.ts — support tickets close themselves after 7 quiet days (2026-11-12).
//
// The same rule Issues follow (issue-fix-live.ts): a ticket waiting on the customer — the team
// replied ('pending_customer') or marked it 'resolved' — with nothing from them for 7 days is
// closed, with a reply in the thread and one notification. A reply within REOPEN_DAYS of closing
// reopens it (support-tickets.ts), which that note promises.
//
// Runs hourly inside check-fixes-live (prod) / run-fix-live-check (staging), so it needs no cron of
// its own. Compare-and-swap on status, capped per run, never throws.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { createNotification } from './notify';

type Db = ReturnType<typeof getDb>;

export const TICKET_AUTO_CLOSE_DAYS = 7;
/** A customer may reply to reopen a ticket for this long after it closed. */
export const TICKET_REOPEN_DAYS = 30;
export const MAX_TICKET_CLOSE_PER_RUN = 50;

export const TICKET_AUTO_CLOSE_NOTE =
    `We've closed this as we haven't heard back in ${TICKET_AUTO_CLOSE_DAYS} days. If you still need help, reply here within ${TICKET_REOPEN_DAYS} days and we'll pick it straight back up.`;

/** May a customer reply reopen this closed ticket? Only within TICKET_REOPEN_DAYS of closing. */
export function canReopenClosedTicket(closedAt: Date | string | null | undefined, now = Date.now()): boolean {
    if (!closedAt) return false;
    const t = new Date(closedAt).getTime();
    return Number.isFinite(t) && now - t <= TICKET_REOPEN_DAYS * 864e5;
}

export async function autoCloseQuietTickets(db: Db): Promise<number> {
    try {
        const closed = await db.execute(sql`
            UPDATE support_tickets t
               SET status = 'closed', closed_at = now(), updated_at = now()
             WHERE t.id IN (
                    SELECT s.id FROM support_tickets s
                     WHERE s.status IN ('pending_customer', 'resolved')
                       AND s.updated_at < now() - make_interval(days => ${TICKET_AUTO_CLOSE_DAYS})
                       AND NOT EXISTS (
                            SELECT 1 FROM ticket_replies r
                             WHERE r.ticket_id = s.id AND r.author_id = s.user_id AND r.is_internal = false
                               AND r.created_at > s.updated_at)
                     ORDER BY s.updated_at ASC
                     LIMIT ${MAX_TICKET_CLOSE_PER_RUN})
               AND t.status IN ('pending_customer', 'resolved')
            RETURNING t.id, t.user_id, t.subject`) as Array<{ id: number; user_id: number; subject: string }>;

        for (const row of closed) {
            // ticket_replies.author_id is NOT NULL: the note is signed by whoever last answered.
            const [last] = await db.execute(sql`
                SELECT author_id FROM ticket_replies
                 WHERE ticket_id = ${row.id} AND is_internal = false AND author_id <> ${row.user_id}
                 ORDER BY created_at DESC LIMIT 1`) as Array<{ author_id: number }>;
            if (last) {
                await db.execute(sql`
                    INSERT INTO ticket_replies (ticket_id, author_id, body, is_internal)
                    VALUES (${row.id}, ${last.author_id}, ${TICKET_AUTO_CLOSE_NOTE}, false)`);
            }
            await createNotification(db, 'ticket_auto_closed', {
                userId: row.user_id,
                context: { ticket: { id: row.id, subject: row.subject } },
                metadata: { ticketId: row.id },
            }).catch((e: unknown) => console.error('[ticket-auto-close] notify failed:', e instanceof Error ? e.message : e));
        }
        return closed.length;
    } catch (e) {
        console.error('[ticket-auto-close] failed:', e instanceof Error ? e.message : e);
        return 0;
    }
}
