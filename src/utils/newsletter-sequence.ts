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

import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    audienceContacts, newsletterSequenceEnrolments, newsletterSequenceSends, newsletterSequenceSteps,
    newsletterSequences, notifications, organisations,
} from '../../db/schema';
import { checkAudienceConsentBulk } from './audience-consent';
import { renderForRecipient, newsletterUnsubscribeUrl, type IssueSnapshot } from './newsletter-render';
import { mintUnsubscribeToken, resolveSendRoute, type SendRoute } from './newsletter-send';
import { sendEmail } from './email';
import { sendGmailMessage } from './gmail';
import { sendOutlookMessage } from './outlook';
import { createNotification } from './notify';

type Db = ReturnType<typeof getDb>;

/** Enrolments processed per tick. The cron is every 15 minutes; a backlog is not urgent. */
export const SEQUENCE_BATCH = 50;

/** Give up on a step after this many failed attempts and halt, rather than retrying for ever. */
export const MAX_ATTEMPTS = 3;

/**
 * How long an enrolment waits for a way to send before it gives up.
 *
 * ⚠️ No route used to HALT on the spot, silently: no error, no notification, and a halted
 * enrolment is never resumed — so everyone who signed up before the tenant connected a mailbox
 * was lost for good, and nothing said so. Now it waits, retrying hourly, and the owner is told.
 * A week is the line past which a "welcome" email reads as a mistake rather than a welcome.
 */
export const NO_ROUTE_WAIT_DAYS = 7;
const NO_ROUTE_RETRY_MS = 60 * 60 * 1000;
/** One "your emails can't send" notification per person per day, however many are waiting. */
const BLOCKED_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
    return enrolInSequence(db, { ...args, sequenceId: null });
}

/**
 * Put a contact into ONE sequence — the welcome sequence (sequenceId null) or a specific email
 * campaign a sign-up form starts (db/form-builder.sql, trigger 'form'). Same rules for both: every
 * failure is swallowed and logged, nothing is enrolled into a disabled or empty sequence, and a
 * repeat is a no-op.
 */
export async function enrolInSequence(
    db: Db,
    args: { organisationId: number; contactId: number; email: string; sequenceId: number | null },
): Promise<{ enrolled: boolean; reason?: string }> {
    try {
        const [seq] = await db
            .select({ id: newsletterSequences.id, isEnabled: newsletterSequences.isEnabled })
            .from(newsletterSequences)
            .where(and(
                eq(newsletterSequences.organisationId, args.organisationId),
                // ⚠️ Scoped to the org even with an id: a form row carries the id, and a form must
                // never enrol anybody into another tenant's sequence.
                args.sequenceId
                    ? eq(newsletterSequences.id, args.sequenceId)
                    : eq(newsletterSequences.triggerEvent, 'subscribed'),
            ))
            // Several "everyone" campaigns may exist (2026-10-06) — new subscribers join the one
            // that is ON. At most one can be (unique index), so this is never a coin toss.
            .orderBy(desc(newsletterSequences.isEnabled), asc(newsletterSequences.createdAt))
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
 * Everything a fresh sign-up is enrolled into, in one place — called at the moment somebody became
 * subscribed: the confirmation click, or the submission itself on a single opt-in form.
 *
 * A form linked to an email campaign starts THAT campaign, and by default it REPLACES the welcome
 * sequence rather than running beside it (skipWelcome) — two series starting on the same day reads
 * as spam. An unlinked form gets the welcome sequence, as every form always has.
 */
export async function enrolAfterSignup(
    db: Db,
    args: { organisationId: number; contactId: number; email: string; formSequenceId: number | null; skipWelcome: boolean },
): Promise<void> {
    const base = { organisationId: args.organisationId, contactId: args.contactId, email: args.email };
    if (args.formSequenceId) await enrolInSequence(db, { ...base, sequenceId: args.formSequenceId });
    if (!args.formSequenceId || !args.skipWelcome) await enrolInWelcomeSequence(db, base);
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
): Promise<string | null> {
    // Returns the provider's message id where there is one (Resend) — the key the webhook matches
    // opens, clicks, bounces and complaints on. A mailbox send has none, so it is tracked as sent only.
    if (route.provider === 'resend') {
        const data = await sendEmail({
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
        return (data as { id?: string } | null)?.id ?? null;
    }
    const common = {
        to: msg.to, subject: msg.subject, body: msg.text, html: msg.html,
        listUnsubscribe: msg.listUnsubscribe || undefined,
    };
    if (route.provider === 'outlook') { await sendOutlookMessage(db, organisationId, common); return null; }
    await sendGmailMessage(db, organisationId, common);
    return null;
}

let _sendsTableMissingLogged = false;
/**
 * Record one campaign email in newsletter_sequence_sends. NEVER throws: the email has already gone,
 * and a missing table (db/newsletter-sequence-sends.sql not applied yet) or a duplicate from a retry
 * must not turn a delivered email into a "failed" step that sends again.
 */
async function recordSequenceSend(db: Db, row: typeof newsletterSequenceSends.$inferInsert): Promise<void> {
    try {
        await db.insert(newsletterSequenceSends).values(row).onConflictDoNothing();
    } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code === '42P01') {
            if (!_sendsTableMissingLogged) console.warn('[newsletter-sequence] newsletter_sequence_sends missing — apply db/newsletter-sequence-sends.sql for campaign stats');
            _sendsTableMissingLogged = true;
            return;
        }
        console.error('[newsletter-sequence] could not record a campaign send (email WAS sent)', err);
    }
}

export interface SequenceSweepResult {
    due: number;
    sent: number;
    halted: number;
    completed: number;
    failed: number;
    /** Waiting for a way to send (no verified domain, no mailbox) — retried hourly. */
    waiting: number;
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
    const out: SequenceSweepResult = { due: 0, sent: 0, halted: 0, completed: 0, failed: 0, waiting: 0 };

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
            createdAt: newsletterSequenceEnrolments.createdAt,
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

    // Tell the person who switched the sequence on (or created it) that its emails are not going
    // out. At most once a day per person — a list filling up must not become a notification storm.
    const notified = new Set<number>();
    const notifyBlocked = async (seq: { id: number; name: string; triggerEvent: string; assistantId: number | null; enabledBy: number | null; createdBy: number | null }, reason: string) => {
        const userId = seq.enabledBy ?? seq.createdBy;
        if (!userId || notified.has(userId)) return;
        notified.add(userId);
        try {
            const [recent] = await db.select({ id: notifications.id }).from(notifications)
                .where(and(
                    eq(notifications.userId, userId),
                    eq(notifications.type, 'newsletter_sequence_blocked'),
                    gte(notifications.createdAt, new Date(now.getTime() - BLOCKED_NOTIFY_COOLDOWN_MS)),
                ))
                .limit(1);
            if (recent) return;
            await createNotification(db, 'newsletter_sequence_blocked', {
                userId,
                assistantId: seq.assistantId ?? null,
                category: 'suggested_action',
                context: {
                    sequence: { name: seq.triggerEvent === 'subscribed' ? 'your welcome sequence' : `“${seq.name}”` },
                    reason,
                },
                metadata: { newsletterSequenceId: seq.id },
            });
        } catch (err) {
            console.error('[newsletter-sequence] blocked notification failed', { sequenceId: seq.id }, err);
        }
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
                .select({
                    id: newsletterSequences.id, name: newsletterSequences.name,
                    triggerEvent: newsletterSequences.triggerEvent,
                    isEnabled: newsletterSequences.isEnabled, assistantId: newsletterSequences.assistantId,
                    enabledBy: newsletterSequences.enabledBy, createdBy: newsletterSequences.createdBy,
                })
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
            if ('error' in routed) {
                // Wait for a route rather than dropping the person — see NO_ROUTE_WAIT_DAYS.
                const waitedMs = now.getTime() - new Date(row.createdAt).getTime();
                if (waitedMs > NO_ROUTE_WAIT_DAYS * 24 * 60 * 60 * 1000) {
                    await db.update(newsletterSequenceEnrolments)
                        .set({ state: 'halted', haltReason: 'no_route', lastError: routed.error, nextSendAt: null, updatedAt: new Date() })
                        .where(eq(newsletterSequenceEnrolments.id, row.id));
                    out.halted++;
                } else {
                    await db.update(newsletterSequenceEnrolments)
                        .set({ attempt: 0, lastError: routed.error, nextSendAt: new Date(now.getTime() + NO_ROUTE_RETRY_MS), updatedAt: new Date() })
                        .where(eq(newsletterSequenceEnrolments.id, row.id));
                    out.waiting++;
                }
                await notifyBlocked(seq, 'there is no way to send them yet. Verify a sending domain or connect a mailbox in Email Studio ▸ Sending — emails already waiting will then go out by themselves.');
                continue;
            }

            const [contact] = await db
                .select({
                    firstName: audienceContacts.firstName,
                    lastName: audienceContacts.lastName,
                    company: audienceContacts.company,
                    // Same reason as the issue send worker: without it every custom merge tag in a
                    // welcome step renders its fallback for everyone.
                    customFields: audienceContacts.customFields,
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
                contact: {
                    ...(contact ?? {}),
                    email: row.email,
                    customFields: (contact?.customFields ?? null) as Record<string, unknown> | null,
                },
                senderName,
                unsubscribeUrl: newsletterUnsubscribeUrl(opts.baseUrl, token),
                postalAddress: org?.postalAddress ?? null,
            });

            const messageId = await deliverStep(db, routed.route, row.organisationId, {
                to: row.email,
                subject: step.subject,
                html: rendered.html,
                text: rendered.text,
                listUnsubscribe: rendered.listUnsubscribe,
            });
            await recordSequenceSend(db, {
                organisationId: row.organisationId,
                sequenceId: row.sequenceId,
                stepId: step.id,
                stepNumber: step.stepNumber,
                enrolmentId: row.id,
                contactId: row.contactId,
                email: row.email,
                provider: routed.route.provider,
                providerMessageId: messageId,
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
