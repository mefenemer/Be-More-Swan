// src/utils/chat-email-action.ts
// The Email Marketing chat's hands on single emails that ALREADY exist: approve one, approve it for a
// time the user names, or send one back to draft. The email twin of chat-blog-action.ts.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The email chat could write emails and read its list, but was told it could not approve or
// schedule any of them — the Email Studio was the only way.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// The model never acts. It proposes an `email_action_proposal` naming an email by the "#id" its list
// shows. This module checks the proposal against newsletter_issues — this assistant's, this
// organisation's, in a state the action applies to — and rebuilds the card from the row. For
// "schedule" the time in the user's words is worked out now, so the card shows the exact instant.
// The click calls the Email Studio's own endpoint (newsletter-issues `approve` / `reject`), so its
// gates apply: only an owner or admin may approve, and an empty email is refused.
//
// There is no "send now", deliberately: sending to a list is the one step the chat leaves to the
// Email Studio, where the user can preview the email and see who it goes to.
//
// ⚠️ Never throws.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { newsletterIssues } from '../../db/schema';
import type { ParseWhen } from './chat-blog-action';

type Db = ReturnType<typeof getDb>;

export const EMAIL_ACTION_PROPOSAL_TYPE = 'email_action_proposal';
export const EMAIL_ACTIONS = ['approve', 'schedule', 'reject'] as const;
export type EmailAction = typeof EMAIL_ACTIONS[number];

/** Which statuses each action applies to. Mirrors the Emails tab's columns (_RQ_NEWSLETTER_STATUS). */
const ACTIONABLE: Record<EmailAction, readonly string[]> = {
    // newsletter-issues `approve` with no time → 'approved', waiting in the Approved column.
    approve: ['draft', 'pending_approval', 'in_review'],
    // `approve` with scheduledFor → 'scheduled'. Also moves an approved or already-booked email.
    // Never 'sending', 'sent' or 'failed' (a failed send may have reached part of the list).
    schedule: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'],
    // `reject` → back to a draft, approval snapshot dropped. Nothing to send back from 'draft'.
    reject: ['pending_approval', 'in_review', 'approved', 'scheduled'],
};

const NOT_NOW: Record<EmailAction, string> = {
    approve: 'This email is not waiting for approval, so there is nothing to approve.',
    schedule: 'This email can’t be given a send time: it has been sent, is sending right now, or failed to send.',
    reject: 'This email is already a draft, or has gone out, so there is nothing to send back.',
};

const SUBJECT_MAX = 200;
const WHEN_MAX = 300;

export interface EmailActionRequest {
    action: EmailAction;
    issueId: number;
    /** Schedule: the time in the user's own words. */
    when: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function emailActionFromUiElement(uiElement: unknown): EmailActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== EMAIL_ACTION_PROPOSAL_TYPE) return null;
    const action = EMAIL_ACTIONS.find((a) => a === ui.action);
    const issueId = Number(String(ui.issueId ?? ui.postId ?? '').replace(/^#/, ''));
    if (!action || !Number.isInteger(issueId) || issueId <= 0) return null;
    const when = typeof ui.when === 'string' && ui.when.trim() ? ui.when.trim().slice(0, WHEN_MAX) : null;
    if (action === 'schedule' && !when) return null;
    return { action, issueId, when: action === 'schedule' ? when : null };
}

export interface EmailActionCard {
    type: typeof EMAIL_ACTION_PROPOSAL_TYPE;
    action: EmailAction;
    issueId: number;
    subject: string;
    status: string;
    /** ISO — when it is booked to send now, if it is. */
    scheduledFor: string | null;
    /** Schedule: the ISO instant the click books it for. */
    scheduleAt: string | null;
    timezone: string | null;
    when: string | null;
    blocked: string | null;
    settled?: boolean;
}

/**
 * Check a proposal against the database and return the card the user confirms — built only from
 * rows. Null when the email is not this assistant's.
 */
export async function resolveEmailActionProposal(
    db: Db, organisationId: number, aiAssistantId: number, req: EmailActionRequest,
    timezone: string | null | undefined, parseWhen: ParseWhen, now: Date = new Date(),
): Promise<EmailActionCard | null> {
    try {
        const [issue] = await db.select({
            id: newsletterIssues.id, status: newsletterIssues.status, subject: newsletterIssues.subject,
            scheduledFor: newsletterIssues.scheduledFor,
        })
            .from(newsletterIssues)
            .where(and(eq(newsletterIssues.id, req.issueId), eq(newsletterIssues.organisationId, organisationId), eq(newsletterIssues.assistantId, aiAssistantId)))
            .limit(1);
        if (!issue) return null;

        const subject = String(issue.subject ?? '').replace(/\s+/g, ' ').trim();
        const card: EmailActionCard = {
            type: EMAIL_ACTION_PROPOSAL_TYPE,
            action: req.action,
            issueId: issue.id,
            subject: subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX)}…` : subject,
            status: issue.status,
            scheduledFor: issue.scheduledFor ? new Date(issue.scheduledFor).toISOString() : null,
            scheduleAt: null,
            timezone: timezone ?? null,
            when: req.when,
            blocked: ACTIONABLE[req.action].includes(issue.status) ? null : NOT_NOW[req.action],
        };

        if (!card.blocked && req.action === 'schedule' && req.when) {
            let at: Date | null = null;
            try { at = await parseWhen(req.when, now, timezone || 'Europe/London'); }
            catch (err) {
                console.error('[chat-email-action] could not read the time (non-fatal)', err);
                card.blocked = 'I couldn’t work out the time just now. Try again, or set it in the Email Studio.';
                return card;
            }
            if (!at) card.blocked = `I couldn’t work out a time from “${req.when}”. Say a day and a time, e.g. “Tuesday at 10am”.`;
            else if (at.getTime() <= now.getTime()) card.blocked = 'That time has already passed. Pick one in the future.';
            else card.scheduleAt = at.toISOString();
        }
        return card;
    } catch (err) {
        console.error('[chat-email-action] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

const NOW_WORDS: Record<string, string> = {
    draft: 'a draft', pending_approval: 'waiting for approval', in_review: 'waiting for approval',
    approved: 'approved, waiting to be sent', scheduled: 'booked to send', sending: 'sending right now',
    sent: 'sent', failed: 'failed to send', archived: 'archived',
};

/** Re-check every stored email_action_proposal in a transcript. Mutates nothing it is given. */
export async function refreshEmailActionCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[], now: Date = new Date(),
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== EMAIL_ACTION_PROPOSAL_TYPE) return m;
        const req = emailActionFromUiElement(ui);
        if (!req) return m;
        try {
            const [issue] = await db.select({ id: newsletterIssues.id, status: newsletterIssues.status })
                .from(newsletterIssues)
                .where(and(eq(newsletterIssues.id, req.issueId), eq(newsletterIssues.organisationId, organisationId), eq(newsletterIssues.assistantId, aiAssistantId)))
                .limit(1);
            if (!issue) return { ...m, uiElement: { ...ui, settled: true, blocked: 'This email no longer exists.' } };
            if (!ACTIONABLE[req.action].includes(issue.status)) {
                return { ...m, uiElement: { ...ui, status: issue.status, settled: true, blocked: `Already dealt with — this email is now ${NOW_WORDS[issue.status] ?? issue.status}.` } };
            }
            const at = typeof ui.scheduleAt === 'string' ? new Date(ui.scheduleAt) : null;
            if (req.action === 'schedule' && at && at.getTime() <= now.getTime()) {
                return { ...m, uiElement: { ...ui, status: issue.status, settled: true, blocked: 'That time has passed. Ask again with a new one.' } };
            }
            return { ...m, uiElement: { ...ui, status: issue.status } };
        } catch (err) {
            console.error('[chat-email-action] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
