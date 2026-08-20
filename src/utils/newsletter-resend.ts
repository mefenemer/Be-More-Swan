// src/utils/newsletter-resend.ts
// "Send it again to the people who didn't open it."
//
// The cheapest reach increase in email — the same words, a different subject line, to the fraction
// of the list that never opened the first one — and the easiest one to turn into spam. Everything
// here is about the difference.
//
// ── ⚠️ THE GUARD THAT MATTERS MOST ──────────────────────────────────────────────────────────────
// An issue sent from a tenant's own Gmail or Outlook mailbox rewrites no links and embeds no pixel,
// so every recipient looks unopened. Resending THAT is not a resend to non-openers: it is a second
// unrequested email to the entire list, sent in the belief that nobody read the first. The
// engagement_tracked flag is the difference between the feature and the incident, and it is checked
// here rather than at the call site so no future caller can forget it.
//
// ── One definition of "did not open", used twice ────────────────────────────────────────────────
// The count shown on the button and the rows the send worker materialises come from the SAME
// predicate. A preview that disagrees with what actually gets sent is the classic version of this
// bug, and it is only ever discovered by the recipients.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceContacts, newsletterIssues, newsletterSends } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * How long after the original send a resend becomes available.
 *
 * ⚠️ Not a formality. Opens arrive over days, not minutes — somebody who reads their newsletter on
 * Sunday has not declined it on Friday. Resending inside the first couple of days mails people who
 * simply had not got to it yet, which is the version of this feature that generates complaints.
 */
export const MIN_RESEND_WAIT_HOURS = 48;

export type ResendBlockedReason =
    | 'not_sent' | 'not_tracked' | 'too_soon' | 'already_resent' | 'is_resend' | 'nobody_left'
    | 'no_opens_recorded';

export interface ResendEligibility {
    canResend: boolean;
    reason?: ResendBlockedReason;
    /** Shown to the tenant verbatim. Every refusal says what would make it possible. */
    message?: string;
    /** How many people were sent the original and never opened or clicked it. */
    unopened: number;
    /** When the wait expires, for a 'too_soon' refusal. */
    availableAt?: string;
}

/** The issue fields eligibility needs — a subset, so callers can pass a summary row. */
export interface ResendCandidate {
    id: number;
    organisationId: number;
    status: string;
    sentAt: Date | null;
    engagementTracked: boolean;
    resendOfIssueId: number | null;
}

/**
 * Everyone who was SENT this issue and never opened or clicked it, and is still subscribed.
 *
 * ⚠️ `status = 'sent'` is deliberate and load-bearing. A recipient the original SKIPPED (opted out)
 * or FAILED (a bad address) never received it, so they are not a non-opener — they are unsent, a
 * different problem with a different fix. Sweeping them in here would quietly turn "resend to
 * people who didn't open it" into "retry the addresses that bounced", which is how a sending
 * domain's reputation gets damaged.
 */
function unopenedFilter(originalIssueId: number, organisationId: number) {
    return and(
        eq(newsletterSends.issueId, originalIssueId),
        eq(newsletterSends.status, 'sent'),
        isNull(newsletterSends.openedAt),
        isNull(newsletterSends.clickedAt),
        eq(audienceContacts.organisationId, organisationId),
        eq(audienceContacts.status, 'subscribed'),
    );
}

/** How many people a resend would go to, right now. The number on the button. */
export async function countUnopened(db: Db, originalIssueId: number, organisationId: number): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(newsletterSends)
        .innerJoin(audienceContacts, eq(audienceContacts.id, newsletterSends.contactId))
        .where(unopenedFilter(originalIssueId, organisationId));
    return Number(row?.n ?? 0);
}

/**
 * One page of resend recipients, for materialiseRecipients. Keyset paged on contact id.
 *
 * Shares `unopenedFilter` with the count above on purpose: the preview and the send must be the
 * same question asked twice, not two queries that agree until one is edited.
 */
export async function unopenedRecipientPage(
    db: Db,
    args: { originalIssueId: number; organisationId: number; afterContactId: number; limit: number },
): Promise<{ id: number; email: string }[]> {
    return db
        .select({ id: audienceContacts.id, email: audienceContacts.email })
        .from(newsletterSends)
        .innerJoin(audienceContacts, eq(audienceContacts.id, newsletterSends.contactId))
        .where(and(
            unopenedFilter(args.originalIssueId, args.organisationId),
            sql`${audienceContacts.id} > ${args.afterContactId}`,
        ))
        .orderBy(audienceContacts.id)
        .limit(args.limit);
}

/**
 * May this issue be resent to its non-openers, and if not, why not?
 *
 * Called by the API before it does anything AND by the read that draws the button, so the UI never
 * offers something the server will refuse. Every refusal carries a sentence the tenant can act on.
 */
export async function resendEligibility(db: Db, issue: ResendCandidate): Promise<ResendEligibility> {
    const no = (reason: ResendBlockedReason, message: string, extra: Partial<ResendEligibility> = {}) =>
        ({ canResend: false, reason, message, unopened: 0, ...extra });

    if (issue.resendOfIssueId) {
        // A third email about the same content, to people who ignored it twice, is not a reach
        // increase — it is the point at which a subscriber marks you as spam.
        return no('is_resend', 'This issue is itself a resend. Write a new issue rather than sending the same one a third time.');
    }
    if (issue.status !== 'sent' || !issue.sentAt) {
        return no('not_sent', 'You can resend an issue once it has finished sending.');
    }
    if (!issue.engagementTracked) {
        // ⚠️ The incident guard. "Nobody opened it" and "we could not see opens" are the same 0%.
        return no('not_tracked',
            'This issue was sent from your connected mailbox, which cannot report opens — so we do not know who read it. '
            + 'Resending would email everyone who received it a second time. Verify a sending domain to measure opens on future issues.');
    }

    const readyAt = new Date(issue.sentAt.getTime() + MIN_RESEND_WAIT_HOURS * 60 * 60 * 1000);
    if (Date.now() < readyAt.getTime()) {
        return no('too_soon',
            `Opens arrive over several days, so a resend becomes available ${MIN_RESEND_WAIT_HOURS} hours after the original went out. `
            + 'Sending sooner reaches people who simply have not read it yet.',
            { availableAt: readyAt.toISOString() });
    }

    // ⚠️ TRACKING SWITCHED ON IS NOT THE SAME AS OPENS ARRIVING. `engagement_tracked` records that
    // we asked the provider to track this domain; it says nothing about whether the webhook is
    // subscribed to open events. Adding `email.opened` / `email.clicked` to the provider's event
    // list is a manual step (§11e), and if it was missed every recipient of every issue reads as a
    // non-opener — the same whole-list resend the check above exists to prevent, arriving through a
    // door that check does not watch.
    //
    // Placed AFTER the wait so a brand-new account that sent its first issue two hours ago is told
    // to wait rather than shown an alarming message about instrumentation it cannot see.
    const [everOpened] = await db
        .select({ id: newsletterSends.id })
        .from(newsletterSends)
        .where(and(
            eq(newsletterSends.organisationId, issue.organisationId),
            sql`${newsletterSends.openedAt} IS NOT NULL`,
        ))
        .limit(1);
    if (!everOpened) {
        // Loud in the log, because the fix is ours and not the tenant's — they cannot see our
        // provider configuration, so the copy must not send them looking for it.
        console.error('[newsletter-resend] refused: no open has EVER been recorded for this organisation, '
            + 'though the issue reports engagement_tracked. Check the provider webhook subscribes to '
            + 'email.opened and email.clicked.', { organisationId: issue.organisationId, issueId: issue.id });
        return no('no_opens_recorded',
            'We have never recorded an open on this account, even though tracking is switched on for this issue. '
            + 'That usually means open reporting is not working rather than that nobody read it — so we have not '
            + 'sent anything again on that basis. Get in touch and we will check the tracking setup.');
    }

    const [existing] = await db
        .select({ id: newsletterIssues.id })
        .from(newsletterIssues)
        .where(and(
            eq(newsletterIssues.resendOfIssueId, issue.id),
            eq(newsletterIssues.organisationId, issue.organisationId),
        ))
        .limit(1);
    if (existing) {
        return no('already_resent', 'This issue has already been resent once. Sending it a third time is not a reach increase.');
    }

    const unopened = await countUnopened(db, issue.id, issue.organisationId);
    if (!unopened) {
        return no('nobody_left', 'Everyone who is still subscribed and received this issue has opened it. There is nobody left to resend to.');
    }

    return { canResend: true, unopened };
}
