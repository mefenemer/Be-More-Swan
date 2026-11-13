// src/utils/mailbox-snapshot.ts — what the Email Assistant's chat sees of the user's email, per turn
// (docs/email-assistant-plan.md §5.2, chat-orchestrator.ts route email_assistant).
//
// ⚠️ Privacy, in this order:
//   - Only the signed-in person's OWN mailboxes (a mailbox is one person's, plan §7.3).
//   - An admin viewing through impersonation gets counts only — no sender, no subject.
//   - Email from a PRIVATE sender is never in it, not even its subject: those senders are never sent
//     to any AI model, and the chat is one.
//   - Headers and our one-line summaries only. Never an email body (we don't store any).

import { and, desc, isNull, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { mailboxMessages } from '../../db/schema';
import { gmailMailboxConfigured, listOwnMailboxes } from './mailboxes';
import { PRIORITY_LABELS, categoryLabel, PRIVATE_CATEGORY, type Priority } from './email-sort';

type Db = ReturnType<typeof getDb>;

/** Recent emails listed for the chat (newest first), beyond the ones that need the user. */
const RECENT_LINES = 60;

export interface SnapshotMessage {
    mailboxId: number; fromName: string | null; fromAddress: string | null; subject: string | null;
    receivedAt: Date | null; category: string | null; priority: string | null; summary: string | null; sortedBy: string;
}

/** One line per email. Pure. */
export function snapshotLine(m: SnapshotMessage): string {
    const when = m.receivedAt ? m.receivedAt.toISOString().slice(0, 16).replace('T', ' ') : 'unknown time';
    const who = [m.fromName, m.fromAddress ? `<${m.fromAddress}>` : ''].filter(Boolean).join(' ') || 'unknown sender';
    const pr = m.priority ? PRIORITY_LABELS[m.priority as Priority] ?? m.priority : 'not sorted yet';
    return `- [${pr}] ${when} UTC · ${who} · "${(m.subject ?? '(no subject)').slice(0, 140)}" · ${categoryLabel(m.category)}${m.summary ? ` — ${m.summary}` : ''}`;
}

/** The snapshot text. Pure: given the rows, builds what the model reads. */
export function formatMailboxSnapshot(
    boxes: { id: number; address: string; status: string; lastSyncAt: Date | null }[],
    messages: SnapshotMessage[],
    privateCount: number,
    countsOnly: boolean,
): string {
    if (!boxes.length) {
        return gmailMailboxConfigured()
            ? 'YOUR MAILBOXES: none connected yet. To start, the user opens the "Emails" tab and presses "Connect Outlook" (Microsoft 365 or Outlook.com) or "Connect Gmail" (Gmail or Google Workspace). You cannot connect it from this chat.'
            : 'YOUR MAILBOXES: none connected yet. To start, the user opens the "Emails" tab and presses "Connect Outlook" (Microsoft 365 or Outlook.com; Gmail is coming soon). You cannot connect it from this chat.';
    }
    const head = boxes.map((b) => `- ${b.address}: ${b.status === 'active' ? 'connected' : 'needs reconnecting (a Reconnect link is on the Emails tab)'}, last read ${b.lastSyncAt ? b.lastSyncAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'not yet (first sort in progress)'}`).join('\n');
    if (countsOnly) {
        return `YOUR MAILBOXES (support view: email content is only shown to the mailbox owner):\n${head}\n${messages.length} emails sorted. Do not describe any email.`;
    }
    const needs = messages.filter((m) => m.priority === 'now' || m.priority === 'today');
    const rest = messages.filter((m) => !(m.priority === 'now' || m.priority === 'today')).slice(0, RECENT_LINES);
    const byCat = new Map<string, number>();
    for (const m of messages) byCat.set(categoryLabel(m.category), (byCat.get(categoryLabel(m.category)) ?? 0) + 1);
    const pending = messages.filter((m) => m.sortedBy === 'pending').length;
    return [
        `YOUR MAILBOXES:\n${head}`,
        `IN THE INBOX NOW (last 14 days at most): ${messages.length + privateCount} emails. By category: ${[...byCat.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}${privateCount ? `, Private ${privateCount}` : ''}.${pending ? ` ${pending} still being sorted.` : ''}`,
        needs.length ? `NEEDS THE USER (Now first, then Today):\n${needs.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'now' ? -1 : 1)).map(snapshotLine).join('\n')}` : 'NEEDS THE USER: nothing right now.',
        rest.length ? `OTHER RECENT EMAIL (newest first, up to ${RECENT_LINES}):\n${rest.map(snapshotLine).join('\n')}` : '',
        privateCount ? `PRIVATE: ${privateCount} emails are from senders the user marked private. You are never shown them: say they exist if asked, never guess who they are from or what they say.` : '',
    ].filter(Boolean).join('\n\n');
}

/** Read and format the snapshot for this person. Never throws to the chat: the caller catches. */
export async function buildMailboxSnapshot(db: Db, orgId: number, userId: number, countsOnly: boolean): Promise<string> {
    const boxes = await listOwnMailboxes(db, orgId, userId);
    if (!boxes.length) return formatMailboxSnapshot([], [], 0, countsOnly);
    const idList = sql.join(boxes.map((b) => sql`${b.id}`), sql`, `);
    const inBoxes = sql`${mailboxMessages.mailboxId} IN (${idList})`;
    const rows = await db.select({
        mailboxId: mailboxMessages.mailboxId, fromName: mailboxMessages.fromName, fromAddress: mailboxMessages.fromAddress,
        subject: mailboxMessages.subject, receivedAt: mailboxMessages.receivedAt, category: mailboxMessages.category,
        priority: mailboxMessages.priority, summary: mailboxMessages.summary, sortedBy: mailboxMessages.sortedBy,
    }).from(mailboxMessages)
        // Private senders' email never leaves the database for an AI model.
        .where(and(inBoxes, isNull(mailboxMessages.removedAt), sql`coalesce(${mailboxMessages.category}, '') <> ${PRIVATE_CATEGORY}`, ne(mailboxMessages.sortedBy, 'private')))
        .orderBy(desc(mailboxMessages.receivedAt)).limit(400);
    const [priv] = await db.select({ n: sql<number>`count(*)::int` }).from(mailboxMessages)
        .where(and(inBoxes, isNull(mailboxMessages.removedAt), sql`(${mailboxMessages.category} = ${PRIVATE_CATEGORY} OR ${mailboxMessages.sortedBy} = 'private')`));
    return formatMailboxSnapshot(boxes, rows, priv?.n ?? 0, countsOnly);
}
