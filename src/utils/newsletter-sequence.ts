// src/utils/newsletter-sequence.ts
// Enrolling a new subscriber in the welcome sequence, and sending the next step when it is due.
//
// ── Three properties, each of which is a decision ───────────────────────────────────────────────
//
// 1. ENROLMENT IS BEST-EFFORT AND NEVER FAILS THE THING THAT TRIGGERED IT. It hangs off the
//    double-opt-in confirmation, and a confirmation that 500s because a welcome email could not be
//    scheduled would leave somebody who clicked "confirm" believing they had failed to subscribe.
//    Every function here swallows and logs.
//
// 2. THE SEQUENCE IS OFF UNTIL A HUMAN ENABLES IT, and the worker re-reads that flag on every
//    send — not just at enrolment. Turning it off has to stop mail that is already queued, or the
//    switch is decorative for everyone currently mid-series.
//
// 3. CONSENT IS RE-CHECKED PER SEND, through the same resolver as everything else. Somebody
//    unsubscribing on day two of a five-step series must not receive step three, and the audience
//    status alone is not enough — an opt-out recorded by the Lead Generator counts too.

import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    audienceContacts, newsletterSequenceEnrolments, newsletterSequenceSteps, newsletterSequences,
    organisations,
} from '../../db/schema';
import { checkAudienceConsentBulk } from './audience-consent';
import { renderForRecipient, newsletterUnsubscribeUrl, type IssueSnapshot } from './newsletter-render';
import { mintUnsubscribeToken, resolveSendRoute, type SendRoute } from './newsletter-send';
import { sendEmail } from './email';
import { sendGmailMessage } from './gmail';
import { sendOutlookMessage } from './outlook';

type Db = ReturnType<typeof getDb>;

/** Enrolments processed per tick. The cron is every 15 minutes; a backlog is not urgent. */
export const SEQUENCE_BATCH = 50;

/** Give up on a step after this many failed attempts and halt, rather than retrying for ever. */
export const MAX_ATTEMPTS = 3;

export type HaltReason =
    | 'unsubscribed' | 'bounced' | 'complained' | 'suppressed' | 'consent_check_failed'
    | 'no_route' | 'send_failed' | 'sequence_disabled' | 'no_steps' | 'manual';

/**
 * Put a newly-subscribed contact into their organisation's welcome sequence.
 *
 * ⚠️ Called from the double opt-in confirmation and from a manual "mark as subscribed". Returns
 * quietly on every failure — including no sequence, a disabled one, or an existing enrolment.
 * The unique index on (sequence_id, contact_id) is what makes a repeat call a no-op rather than a
 * second welcome series.
 */
export async function enrolInWelcomeSequence(
    db: Db,
    args: { organisationId: number; contactId: number; email: string },
): Promise<{ enrolled: boolean; reason?: string }> {
    try {
        const [seq] = await db
            .select({ id: newsletterSequences.id, isEnabled: newsletterSequences.isEnabled })
            .from(newsletterSequences)
            .where(and(
                eq(newsletterSequences.organisationId, args.organisationId),
                eq(newsletterSequences.triggerEvent, 'subscribed'),
            ))
            .limit(1);

        if (!seq) return { enrolled: false, reason: 'no_sequence' };
        // Enrol even when it is disabled? No. An enrolment carries a next_send_at, and creating one
        // against a sequence nobody has switched on would fire the moment they did — sending a
        // "welcome" to somebody who subscribed weeks earlier.
        if (!seq.isEnabled) return { enrolled: false, reason: 'sequence_disabled' };

        const [firstStep] = await db
            .select({ delayDays: newsletterSequenceSteps.delayDays })
            .from(newsletterSequenceSteps)
            .where(and(
                eq(newsletterSequenceSteps.sequenceId, seq.id),
                eq(newsletterSequenceSteps.isEnabled, true),
            ))
            .orderBy(asc(newsletterSequenceSteps.stepNumber))
            .limit(1);
        if (!firstStep) return { enrolled: false, reason: 'no_steps' };

        const due = new Date(Date.now() + (firstStep.delayDays ?? 0) * 24 * 60 * 60 * 1000);

        await db.insert(newsletterSequenceEnrolments).values({
            organisationId: args.organisationId,
            sequenceId: seq.id,
            contactId: args.contactId,
            email: args.email,
            // Minted here, once, and reused by every step — through the SAME minter the send
            // worker uses, because newsletter-unsubscribe.ts format-checks the token before it
            // looks it up. A second definition of the shape here is a link that fails that check
            // and never reaches the lookup at all.
            unsubscribeToken: mintUnsubscribeToken(),
            nextSendAt: due,
        }).onConflictDoNothing();

        return { enrolled: true };
    } catch (err) {
        // Best effort, always. See the header: this hangs off a confirmation click.
        console.error('[newsletter-sequence] enrolment failed', { orgId: args.organisationId, contactId: args.contactId }, err);
        return { enrolled: false, reason: 'error' };
    }
}

/**
 * Stop every active enrolment for a contact.
 *
 * Called when they unsubscribe, hard-bounce or complain. The consent check at send time would
 * catch them anyway — this is belt and braces, and it also makes "why did this stop?" answerable
 * from the row rather than inferable from an absence.
 */
export async function haltEnrolmentsForContact(
    db: Db,
    args: { organisationId: number; contactId?: number | null; email?: string | null; reason: HaltReason },
): Promise<number> {
    try {
        const where = args.contactId
            ? and(
                eq(newsletterSequenceEnrolments.organisationId, args.organisationId),
                eq(newsletterSequenceEnrolments.contactId, args.contactId),
                eq(newsletterSequenceEnrolments.state, 'active'),
            )
            : and(
                eq(newsletterSequenceEnrolments.organisationId, args.organisationId),
                eq(newsletterSequenceEnrolments.email, String(args.email ?? '').trim().toLowerCase()),
                eq(newsletterSequenceEnrolments.state, 'active'),
            );

        const halted = await db.update(newsletterSequenceEnrolments)
            .set({ state: 'halted', haltReason: args.reason, nextSendAt: null, updatedAt: new Date() })
            .where(where)
            .returning({ id: newsletterSequenceEnrolments.id });
        return halted.length;
    } catch (err) {
        console.error('[newsletter-sequence] halt failed', { orgId: args.organisationId, reason: args.reason }, err);
        return 0;
    }
}

async function deliverStep(
    db: Db,
    route: SendRoute,
    organisationId: number,
    msg: { to: string; subject: string; html: string; text: string; listUnsubscribe: string | null },
): Promise<void> {
    if (route.provider === 'resend') {
        await sendEmail({
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            from: route.from || undefined,
            replyTo: route.replyTo || undefined,
            headers: msg.listUnsubscribe
                ? { 'List-Unsubscribe': msg.listUnsubscribe, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
                : undefined,
        });
        return;
    }
    const common = {
        to: msg.to, subject: msg.subject, body: msg.text, html: msg.html,
        listUnsubscribe: msg.listUnsubscribe || undefined,
    };
    if (route.provider === 'outlook') { await sendOutlookMessage(db, organisationId, common); return; }
    await sendGmailMessage(db, organisationId, common);
}

export interface SequenceSweepResult {
    due: number;
    sent: number;
    halted: number;
    completed: number;
    failed: number;
}

/**
 * Send the next due step for every active enrolment.
 *
 * The claim is status-guarded like every other worker here: the UPDATE re-asserts `state = 'active'`
 * and the same `next_send_at` it read, and a lost race simply skips. Two overlapping ticks cannot
 * both send step two to the same person.
 */
export async function processDueSequenceSteps(
    db: Db,
    opts: { baseUrl: string; now?: Date; limit?: number },
): Promise<SequenceSweepResult> {
    const now = opts.now ?? new Date();
    const out: SequenceSweepResult = { due: 0, sent: 0, halted: 0, completed: 0, failed: 0 };

    const due = await db
        .select({
            id: newsletterSequenceEnrolments.id,
            organisationId: newsletterSequenceEnrolments.organisationId,
            sequenceId: newsletterSequenceEnrolments.sequenceId,
            contactId: newsletterSequenceEnrolments.contactId,
            email: newsletterSequenceEnrolments.email,
            lastStepSent: newsletterSequenceEnrolments.lastStepSent,
            unsubscribeToken: newsletterSequenceEnrolments.unsubscribeToken,
            nextSendAt: newsletterSequenceEnrolments.nextSendAt,
            attempt: newsletterSequenceEnrolments.attempt,
        })
        .from(newsletterSequenceEnrolments)
        .where(and(
            eq(newsletterSequenceEnrolments.state, 'active'),
            lte(newsletterSequenceEnrolments.nextSendAt, now),
        ))
        .orderBy(asc(newsletterSequenceEnrolments.nextSendAt))
        .limit(opts.limit ?? SEQUENCE_BATCH);

    out.due = due.length;
    if (!due.length) return out;

    const halt = async (id: number, reason: HaltReason) => {
        await db.update(newsletterSequenceEnrolments)
            .set({ state: 'halted', haltReason: reason, nextSendAt: null, updatedAt: new Date() })
            .where(eq(newsletterSequenceEnrolments.id, id));
        out.halted++;
    };

    for (const row of due) {
        // ⚠️ Status-guarded claim. Without re-asserting BOTH the state and the timestamp it read,
        // two overlapping ticks would both send this person the same step.
        const [claimed] = await db.update(newsletterSequenceEnrolments)
            .set({ attempt: sql`${newsletterSequenceEnrolments.attempt} + 1`, updatedAt: new Date() })
            .where(and(
                eq(newsletterSequenceEnrolments.id, row.id),
                eq(newsletterSequenceEnrolments.state, 'active'),
                row.nextSendAt
                    ? eq(newsletterSequenceEnrolments.nextSendAt, row.nextSendAt)
                    : isNull(newsletterSequenceEnrolments.nextSendAt),
            ))
            .returning({ attempt: newsletterSequenceEnrolments.attempt });
        if (!claimed) continue;

        try {
            // Re-read the switch on EVERY send. Turning a sequence off has to stop mail already
            // queued, or the control is decorative for everyone mid-series.
            const [seq] = await db
                .select({ isEnabled: newsletterSequences.isEnabled, assistantId: newsletterSequences.assistantId })
                .from(newsletterSequences)
                .where(eq(newsletterSequences.id, row.sequenceId))
                .limit(1);
            if (!seq?.isEnabled) { await halt(row.id, 'sequence_disabled'); continue; }

            const [step] = await db
                .select()
                .from(newsletterSequenceSteps)
                .where(and(
                    eq(newsletterSequenceSteps.sequenceId, row.sequenceId),
                    eq(newsletterSequenceSteps.isEnabled, true),
                    sql`${newsletterSequenceSteps.stepNumber} > ${row.lastStepSent}`,
                ))
                .orderBy(asc(newsletterSequenceSteps.stepNumber))
                .limit(1);

            if (!step) {
                // Nothing left — they finished the series.
                await db.update(newsletterSequenceEnrolments)
                    .set({ state: 'completed', nextSendAt: null, updatedAt: new Date() })
                    .where(eq(newsletterSequenceEnrolments.id, row.id));
                out.completed++;
                continue;
            }

            const snapshot = step.renderedPayload as IssueSnapshot | null;
            if (!snapshot?.html) { await halt(row.id, 'no_steps'); continue; }

            // Same resolver as every other send path. An unsubscribe on day two must stop step three.
            const verdicts = await checkAudienceConsentBulk(db, row.organisationId, [row.email]);
            const verdict = verdicts.get(row.email.trim().toLowerCase());
            if (!verdict?.sendable) {
                const reason = verdict?.reason;
                // ⚠️ A PAUSE IS NOT A STOP. Halting here would end somebody's welcome series for
                // ever because they asked for thirty days of quiet — and a halted enrolment is
                // never resumed by anything. Deferred to the moment the pause lifts instead, which
                // the verdict carries so this worker does not have to know what a pause is.
                if (reason === 'paused' && verdict?.retryAfter) {
                    await db.update(newsletterSequenceEnrolments)
                        .set({ attempt: 0, nextSendAt: verdict.retryAfter, updatedAt: new Date() })
                        .where(eq(newsletterSequenceEnrolments.id, row.id));
                    continue;
                }
                await halt(row.id, reason === 'opted_out' ? 'unsubscribed'
                    : reason === 'bounced_previously' ? 'bounced'
                    : reason === 'complained_previously' ? 'complained'
                    : reason === 'suppressed' ? 'suppressed'
                    : 'consent_check_failed');
                continue;
            }

            const [org] = await db
                .select({ name: organisations.name, postalAddress: organisations.outreachPostalAddress })
                .from(organisations).where(eq(organisations.id, row.organisationId)).limit(1);
            const senderName = org?.name || 'Your business';

            const routed = await resolveSendRoute(db, row.organisationId, { recipientCount: 1, senderName });
            if ('error' in routed) { await halt(row.id, 'no_route'); continue; }

            const [contact] = await db
                .select({
                    firstName: audienceContacts.firstName,
                    lastName: audienceContacts.lastName,
                    company: audienceContacts.company,
                })
                .from(audienceContacts).where(eq(audienceContacts.id, row.contactId)).limit(1);

            // ⚠️ The enrolment's OWN token, not a fresh one per send. A welcome step has no
            // newsletter_sends row to hang a token on, so it lives on the enrolment and stays
            // stable across the series — a subscriber who keeps the first email and clicks its
            // unsubscribe link three weeks later must still be able to leave.
            //
            // Backfilled here for any enrolment created before the column existed, rather than
            // sending a footer whose link resolves to nothing.
            let token = row.unsubscribeToken;
            if (!token) {
                token = mintUnsubscribeToken();
                await db.update(newsletterSequenceEnrolments)
                    .set({ unsubscribeToken: token, updatedAt: new Date() })
                    .where(eq(newsletterSequenceEnrolments.id, row.id));
            }

            const rendered = renderForRecipient({
                snapshot,
                contact: { ...(contact ?? {}), email: row.email },
                senderName,
                unsubscribeUrl: newsletterUnsubscribeUrl(opts.baseUrl, token),
                postalAddress: org?.postalAddress ?? null,
            });

            await deliverStep(db, routed.route, row.organisationId, {
                to: row.email,
                subject: step.subject,
                html: rendered.html,
                text: rendered.text,
                listUnsubscribe: rendered.listUnsubscribe,
            });

            // Schedule the one after this, using ITS delay. Null when there is nothing further,
            // which the next tick reads as "completed".
            const [nextStep] = await db
                .select({ delayDays: newsletterSequenceSteps.delayDays })
                .from(newsletterSequenceSteps)
                .where(and(
                    eq(newsletterSequenceSteps.sequenceId, row.sequenceId),
                    eq(newsletterSequenceSteps.isEnabled, true),
                    sql`${newsletterSequenceSteps.stepNumber} > ${step.stepNumber}`,
                ))
                .orderBy(asc(newsletterSequenceSteps.stepNumber))
                .limit(1);

            await db.update(newsletterSequenceEnrolments).set({
                lastStepSent: step.stepNumber,
                attempt: 0,
                state: nextStep ? 'active' : 'completed',
                nextSendAt: nextStep
                    ? new Date(now.getTime() + (nextStep.delayDays ?? 0) * 24 * 60 * 60 * 1000)
                    : null,
                updatedAt: new Date(),
            }).where(eq(newsletterSequenceEnrolments.id, row.id));

            out.sent++;
            if (!nextStep) out.completed++;
        } catch (err) {
            const message = String((err as Error)?.message ?? err).slice(0, 500);
            console.error('[newsletter-sequence] step failed', { enrolmentId: row.id }, err);
            out.failed++;
            // Retry a couple of times, then stop. An enrolment retrying for ever is a queue that
            // never drains and a log nobody reads.
            if ((claimed.attempt ?? 0) >= MAX_ATTEMPTS) {
                await db.update(newsletterSequenceEnrolments)
                    .set({ state: 'halted', haltReason: 'send_failed', lastError: message, nextSendAt: null, updatedAt: new Date() })
                    .where(eq(newsletterSequenceEnrolments.id, row.id));
                out.halted++;
            } else {
                await db.update(newsletterSequenceEnrolments)
                    .set({ lastError: message, nextSendAt: new Date(now.getTime() + 60 * 60 * 1000), updatedAt: new Date() })
                    .where(eq(newsletterSequenceEnrolments.id, row.id));
            }
        }
    }

    return out;
}
