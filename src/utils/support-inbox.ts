// src/utils/support-inbox.ts — Admin ▸ Customers ▸ Inbox: every request a person is waiting on us
// for, from the three places they reach us (owner decision 2026-10-18):
//   • support tickets   (support_tickets + ticket_replies — Help & Support ▸ Contact us, a question)
//   • reported problems (issue_reports + issue_report_messages — Contact us, "something isn't working")
//   • enquiries         (leads + lead_replies — the contact form and inbound email; Contacts)
// Nothing moved: each stays in its own table and opens in its own panel. This file only reads them
// into one list with one question answered the same way for all three — who is it waiting on?
//
// It also re-routes a request the customer filed under the wrong topic: a ticket that is really a
// fault goes to the fix pipeline, a "problem" that is really a question becomes a ticket. Both close
// the original with a note saying where it went, so the customer's own list stays truthful.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export type InboxKind = 'ticket' | 'issue' | 'enquiry';
/** us = we owe a reply or a decision · customer = we asked them · fixing = in the fix pipeline · done */
export type WaitingOn = 'us' | 'customer' | 'fixing' | 'done';

export interface InboxItem {
    kind: InboxKind;
    id: number;
    /** The Contacts record for this person, when there is one (matched by email). */
    contactId: number | null;
    name: string | null;
    email: string | null;
    title: string;
    detail: string | null;
    status: string;
    waitingOn: WaitingOn;
    createdAt: string;
    lastActivityAt: string;
}

// ── Who is it waiting on? Pure, so tests/support-inbox.test.ts pins every status. ─────────────

/** support_tickets.status: 'new' | 'open' | 'pending_customer' | 'resolved' | 'closed'. A customer reply reopens to 'open'. */
export function ticketWaitingOn(status: string): WaitingOn {
    if (status === 'pending_customer' || status === 'pending') return 'customer';
    if (status === 'resolved' || status === 'closed') return 'done';
    return 'us';
}

/**
 * issue_reports.status. `lastFromUser` = the newest message on it is the customer's — a comment
 * on an issue we are already fixing still needs someone to read it.
 */
export function issueWaitingOn(status: string, lastFromUser: boolean): WaitingOn {
    if (status === 'closed' || status === 'roadmap') return 'done';
    if (lastFromUser) return 'us';
    if (status === 'reported') return 'us';
    if (status === 'more_info_required' || status === 'fixed_ready_to_test') return 'customer';
    return 'fixing';   // backlog · on_hold · fix_in_progress · merge
}

/**
 * An enquiry is waiting on us when the newest message that isn't an internal note is theirs, or
 * when nobody has replied to the original request at all. `closed` = the lead is converted or lost.
 */
export function enquiryWaitingOn(lastDirection: string | null, closed: boolean): WaitingOn {
    if (closed) return 'done';
    if (lastDirection === 'outbound') return 'customer';
    return 'us';
}

/** Lead types that arrive as a message to us (Contacts' opportunity filter uses the same keys). */
export const ENQUIRY_LEAD_TYPES = ['contact_form', 'inbound_email', 'enterprise_enquiry', 'enterprise_inquiry', 'role_request'] as const;

/** Done items older than this drop off — the list is for work, the tables keep the history. */
export const DONE_WINDOW_DAYS = 60;

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString());
const firstLine = (s: string, n = 120): string => {
    const line = String(s || '').split('\n')[0].trim();
    return line.length > n ? `${line.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : line;
};

export interface InboxScope { tickets: boolean; issues: boolean; enquiries: boolean; }

/** The whole inbox, newest activity first. Each source is read only if the admin may see it. */
export async function loadInbox(db: Db, scope: InboxScope): Promise<InboxItem[]> {
    const since = sql`now() - make_interval(days => ${DONE_WINDOW_DAYS}::int)`;
    // One Contacts record per email: the most recently active lead row (Contacts dedupes the same way).
    const contactJoin = (emailExpr: ReturnType<typeof sql>) => sql`LEFT JOIN LATERAL (
        SELECT l.id FROM leads l WHERE lower(l.email) = lower(${emailExpr}) ORDER BY l.updated_at DESC LIMIT 1
      ) c ON true`;
    const items: InboxItem[] = [];

    if (scope.tickets) {
        const rows = await db.execute<{
            id: number; subject: string; category: string; status: string; created_at: Date; last_at: Date;
            email: string | null; first_name: string | null; last_name: string | null; contact_id: number | null;
        }>(sql`
            SELECT t.id, t.subject, t.category, t.status, t.created_at,
                   GREATEST(t.updated_at, COALESCE((SELECT max(r.created_at) FROM ticket_replies r WHERE r.ticket_id = t.id), t.created_at)) AS last_at,
                   u.email, u.first_name, u.last_name, c.id AS contact_id
              FROM support_tickets t
              JOIN users u ON u.id = t.user_id
              ${contactJoin(sql`u.email`)}
             WHERE t.status NOT IN ('resolved', 'closed') OR t.updated_at > ${since}`);
        for (const r of rows as unknown as Array<Record<string, any>>) {
            items.push({
                kind: 'ticket', id: Number(r.id), contactId: r.contact_id != null ? Number(r.contact_id) : null,
                name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null, email: r.email ?? null,
                title: r.subject, detail: r.category, status: r.status, waitingOn: ticketWaitingOn(r.status),
                createdAt: iso(r.created_at), lastActivityAt: iso(r.last_at),
            });
        }
    }

    if (scope.issues) {
        const rows = await db.execute<{
            id: number; description: string; source_location: string | null; status: string; created_at: Date; last_at: Date;
            last_author: string | null; email: string | null; first_name: string | null; last_name: string | null; contact_id: number | null;
        }>(sql`
            SELECT i.id, i.description, i.source_location, i.status, i.created_at,
                   GREATEST(i.updated_at, COALESCE(m.created_at, i.created_at)) AS last_at,
                   m.author_type AS last_author,
                   u.email, u.first_name, u.last_name, c.id AS contact_id
              FROM issue_reports i
              JOIN users u ON u.id = i.user_id  -- keeps automatic incidents (no reporter) out: they live on Issue Reports only
              LEFT JOIN LATERAL (
                SELECT author_type, created_at FROM issue_report_messages WHERE issue_id = i.id ORDER BY created_at DESC LIMIT 1
              ) m ON true
              ${contactJoin(sql`u.email`)}
             WHERE i.status NOT IN ('closed', 'roadmap') OR i.updated_at > ${since}`);
        for (const r of rows as unknown as Array<Record<string, any>>) {
            items.push({
                kind: 'issue', id: Number(r.id), contactId: r.contact_id != null ? Number(r.contact_id) : null,
                name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null, email: r.email ?? null,
                title: firstLine(r.description), detail: r.source_location ?? null, status: r.status,
                waitingOn: issueWaitingOn(r.status, r.last_author === 'user'),
                createdAt: iso(r.created_at), lastActivityAt: iso(r.last_at),
            });
        }
    }

    if (scope.enquiries) {
        // An enquiry = a person who WROTE to us: an inbound email/reply, or the original request of a
        // lead that came in as a message (contact form, enterprise, assistant request). Waitlist
        // sign-ups also carry a use_case — they are interest, not a question, and stay in Contacts.
        const rows = await db.execute<{
            id: number; name: string | null; email: string | null; use_case: string | null; opportunity_reason: string | null;
            lead_type: string | null; status: string | null; created_at: Date; last_at: Date;
            last_direction: string | null; last_inbound_body: string | null;
        }>(sql`
            SELECT l.id, l.name, l.email, l.use_case, l.opportunity_reason, l.lead_type, l.status, l.created_at,
                   GREATEST(l.created_at, COALESCE(m.created_at, l.created_at)) AS last_at,
                   m.direction AS last_direction, ib.body AS last_inbound_body
              FROM leads l
              LEFT JOIN LATERAL (
                SELECT direction, created_at FROM lead_replies
                 WHERE lead_id = l.id AND direction <> 'internal' ORDER BY created_at DESC LIMIT 1
              ) m ON true
              LEFT JOIN LATERAL (
                SELECT body FROM lead_replies WHERE lead_id = l.id AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1
              ) ib ON true
             WHERE (ib.body IS NOT NULL
                    OR (NULLIF(trim(l.use_case), '') IS NOT NULL AND l.lead_type IN (${sql.join(ENQUIRY_LEAD_TYPES.map((t) => sql`${t}`), sql`, `)})))
               AND (l.status NOT IN ('converted', 'lost') OR GREATEST(l.created_at, COALESCE(m.created_at, l.created_at)) > ${since})`);
        for (const r of rows as unknown as Array<Record<string, any>>) {
            items.push({
                kind: 'enquiry', id: Number(r.id), contactId: Number(r.id), name: r.name ?? null, email: r.email ?? null,
                title: firstLine(r.last_inbound_body || r.use_case || ''), detail: r.opportunity_reason || r.lead_type || null,
                status: r.status || 'new', waitingOn: enquiryWaitingOn(r.last_direction ?? null, r.status === 'converted' || r.status === 'lost'),
                createdAt: iso(r.created_at), lastActivityAt: iso(r.last_at),
            });
        }
    }

    return items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** How many are waiting on us, per source — the Dashboard's "Waiting on us" card. */
export function countWaitingOnUs(items: InboxItem[]): number {
    return items.filter((i) => i.waitingOn === 'us').length;
}

// ── Re-routing ──────────────────────────────────────────────────────────────────────────────

const REROUTE_TICKET_NOTE = (issueId: number) =>
    `We've passed this to the team that fixes problems — you can follow it as reported problem #${issueId} in Help & Support → Contact us. This conversation is closed so you only have one place to look.`;
const REROUTE_ISSUE_NOTE = (ticketId: number) =>
    `This looks like a question rather than a fault, so we've moved it to support request #TK-${ticketId} in Help & Support → Contact us, where we'll answer it. This report is closed so you only have one place to look.`;

export type RerouteResult =
    | { ok: true; from: { kind: 'ticket' | 'issue'; id: number }; to: { kind: 'ticket' | 'issue'; id: number }; userId: number; subject: string }
    | { ok: false; status: number; error: string };

/**
 * A ticket that is really a fault → a new issue report in the fix pipeline; the ticket gets a
 * public reply saying where it went and is closed. One transaction: never one without the other.
 */
export async function ticketToIssue(db: Db, ticketId: number, adminId: number): Promise<RerouteResult> {
    return db.transaction(async (tx) => {
        const [t] = await tx.execute<{ id: number; user_id: number; organisation_id: number | null; subject: string; description: string; status: string }>(sql`
            SELECT id, user_id, organisation_id, subject, description, status FROM support_tickets WHERE id = ${ticketId} FOR UPDATE`) as unknown as Array<any>;
        if (!t) return { ok: false as const, status: 404, error: 'Support request not found.' };
        if (t.status === 'closed') return { ok: false as const, status: 409, error: 'That request is already closed.' };
        // The whole public conversation travels with it, so the fix team sees what was said.
        const replies = await tx.execute<{ body: string; from_team: boolean; created_at: Date }>(sql`
            SELECT r.body, (r.author_id IS DISTINCT FROM ${t.user_id}) AS from_team, r.created_at
              FROM ticket_replies r WHERE r.ticket_id = ${ticketId} AND r.is_internal = false ORDER BY r.created_at`) as unknown as Array<any>;
        const description = [t.subject.trim() === firstLine(t.description) ? t.description : `${t.subject}\n\n${t.description}`]
            .concat(replies.map((r) => `\n— ${r.from_team ? 'Our reply' : 'Customer'} (${iso(r.created_at).slice(0, 10)}): ${r.body}`)).join('\n');
        const [issue] = await tx.execute<{ id: number }>(sql`
            INSERT INTO issue_reports (organisation_id, user_id, description, source_location, status)
            VALUES (${t.organisation_id}, ${t.user_id}, ${description}, ${`Moved from support request #TK-${ticketId}`}, 'reported')
            RETURNING id`) as unknown as Array<{ id: number }>;
        await tx.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body)
            VALUES (${issue.id}, 'admin', ${adminId}, ${`Moved here from support request #TK-${ticketId}.`})`);
        await tx.execute(sql`
            INSERT INTO ticket_replies (ticket_id, author_id, body, is_internal) VALUES (${ticketId}, ${adminId}, ${REROUTE_TICKET_NOTE(issue.id)}, false)`);
        await tx.execute(sql`UPDATE support_tickets SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = ${ticketId}`);
        return { ok: true as const, from: { kind: 'ticket' as const, id: ticketId }, to: { kind: 'issue' as const, id: issue.id }, userId: t.user_id, subject: t.subject };
    });
}

/**
 * A "problem" that is really a question → a new support ticket; the issue gets a message saying
 * where it went and is closed. The screenshot stays on the issue (tickets carry no images).
 */
export async function issueToTicket(db: Db, issueId: number, adminId: number): Promise<RerouteResult> {
    return db.transaction(async (tx) => {
        const [i] = await tx.execute<{ id: number; user_id: number | null; organisation_id: number | null; description: string; status: string }>(sql`
            SELECT id, user_id, organisation_id, description, status FROM issue_reports WHERE id = ${issueId} FOR UPDATE`) as unknown as Array<any>;
        if (!i) return { ok: false as const, status: 404, error: 'Reported problem not found.' };
        if (i.user_id == null) return { ok: false as const, status: 409, error: 'An automatic report has no customer to answer, so it can\'t become a support request.' };
        if (i.status === 'closed') return { ok: false as const, status: 409, error: 'That report is already closed.' };
        const msgs = await tx.execute<{ body: string; author_type: string; created_at: Date }>(sql`
            SELECT body, author_type, created_at FROM issue_report_messages WHERE issue_id = ${issueId} ORDER BY created_at`) as unknown as Array<any>;
        const subject = firstLine(i.description, 80) || `Reported problem #${issueId}`;
        const description = [i.description]
            .concat(msgs.map((m) => `\n— ${m.author_type === 'admin' ? 'Our reply' : 'Customer'} (${iso(m.created_at).slice(0, 10)}): ${m.body}`)).join('\n');
        const [ticket] = await tx.execute<{ id: number }>(sql`
            INSERT INTO support_tickets (user_id, organisation_id, subject, category, description, status)
            VALUES (${i.user_id}, ${i.organisation_id}, ${subject}, 'technical', ${description}, 'open')
            RETURNING id`) as unknown as Array<{ id: number }>;
        await tx.execute(sql`
            INSERT INTO ticket_replies (ticket_id, author_id, body, is_internal)
            VALUES (${ticket.id}, ${adminId}, ${`Moved here from reported problem #${issueId}.`}, true)`);
        await tx.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
            VALUES (${issueId}, 'admin', ${adminId}, ${REROUTE_ISSUE_NOTE(ticket.id)}, 'closed')`);
        await tx.execute(sql`UPDATE issue_reports SET status = 'closed', updated_at = now() WHERE id = ${issueId}`);
        return { ok: true as const, from: { kind: 'issue' as const, id: issueId }, to: { kind: 'ticket' as const, id: ticket.id }, userId: i.user_id, subject };
    });
}
