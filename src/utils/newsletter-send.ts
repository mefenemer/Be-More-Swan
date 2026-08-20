// src/utils/newsletter-send.ts
// The send worker. Turns an approved issue into one email per subscriber, resumably.
//
// ── Three properties this file exists to guarantee ──────────────────────────────────────────────
//
// 1. NOBODY IS EMAILED TWICE. newsletter_sends is materialised BEFORE anything is sent, one row per
//    recipient, with UNIQUE (issue_id, email). That row — not a counter, not a cursor — is the unit
//    of work. A tick that dies halfway leaves the remaining rows 'queued' and the next tick picks
//    them up; a re-run of a finished issue inserts nothing. The claim on the issue is
//    STATUS-GUARDED and verified, because `FOR UPDATE SKIP LOCKED` outside a transaction guarantees
//    nothing (five blog jobs once produced nine published posts that way).
//
// 2. CONSENT IS RE-CHECKED PER RECIPIENT, AT SEND TIME. Approval and delivery can be days apart, and
//    someone who unsubscribes in between must not receive the issue. Every batch asks
//    src/utils/audience-consent.ts, which also consults lead_opt_outs and suppression_list — so an
//    opt-out recorded by the Lead Generator blocks a newsletter, which is the whole point of the
//    shared audience.
//
// 3. THE FOOTER IS APPENDED HERE, IN CODE. Never by the model, never stored in the draft. Each
//    recipient's unsubscribe link carries their own token.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import type { getDb } from '../../db/client';
import {
    audienceContactSegments, audienceContacts, newsletterIssues, newsletterSendingDomains,
    newsletterSends, organisations,
} from '../../db/schema';
import { checkAudienceConsentBulk, type AudienceSkipReason } from './audience-consent';
import { renderForRecipient, newsletterUnsubscribeUrl, type IssueSnapshot } from './newsletter-render';
import { buildFromAddress } from './sending-domain';
import { getIntegration } from './workspace-integrations';
import { sendEmail } from './email';
import { sendGmailMessage } from './gmail';
import { sendOutlookMessage } from './outlook';

type Db = ReturnType<typeof getDb>;

/**
 * The hard cap on the mailbox route (§6, option 2).
 *
 * A personal Gmail or Outlook mailbox has a daily recipient limit — roughly 500 for a free Google
 * account, ~2,000 for Workspace — and exceeding it suspends sending on the account the tenant runs
 * their business from. It also returns no bounce or complaint feedback at all, so above a small
 * list we would be flying blind on exactly the signals that keep a sender deliverable. 200 leaves
 * headroom under every plan's limit even if the tenant sends other mail the same day.
 */
export const MAILBOX_MAX_RECIPIENTS = 200;

/** Recipients handled per invocation. Bounded so one tick fits comfortably inside the budget. */
export const BATCH_PER_TICK = 100;

/** An issue stuck in 'sending' longer than this had its worker killed mid-tick. */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

export type SendProvider = 'resend' | 'gmail' | 'outlook';

export interface SendRoute {
    provider: SendProvider;
    /** Full From header. Null on the mailbox routes — the mailbox IS the from address. */
    from: string | null;
    replyTo: string | null;
    /** The verified domain, when there is one. For reporting only. */
    domain?: string | null;
}

/**
 * Which route may this organisation send on, and is it allowed for a list this size?
 *
 * Verified domain first, mailbox second, nothing third. The size check lives here rather than at
 * the send site so an issue is refused BEFORE a single email goes out — a half-sent list that stops
 * at the daily cap is the worst outcome available, because the tenant cannot tell who received it.
 */
export async function resolveSendRoute(
    db: Db,
    organisationId: number,
    opts: { recipientCount: number; senderName: string },
): Promise<{ route: SendRoute } | { error: string }> {
    const [domain] = await db
        .select()
        .from(newsletterSendingDomains)
        .where(and(
            eq(newsletterSendingDomains.organisationId, organisationId),
            eq(newsletterSendingDomains.status, 'verified'),
        ))
        .orderBy(sql`${newsletterSendingDomains.verifiedAt} DESC NULLS LAST`)
        .limit(1);

    if (domain) {
        return {
            route: {
                provider: 'resend',
                from: buildFromAddress(domain, opts.senderName),
                replyTo: domain.replyTo || null,
                domain: domain.domain,
            },
        };
    }

    // No verified domain — the small-list fallback. Which mailbox is connected decides the
    // provider; we do not ask the tenant to choose twice.
    const gmail = await getIntegration(db, organisationId, 'gmail').catch(() => null);
    const outlook = gmail ? null : await getIntegration(db, organisationId, 'outlook').catch(() => null);
    const mailbox: SendProvider | null = gmail ? 'gmail' : outlook ? 'outlook' : null;

    if (!mailbox) {
        return {
            error: 'There is no way to send this yet. Verify a sending domain, or connect the mailbox you want it to come from.',
        };
    }

    if (opts.recipientCount > MAILBOX_MAX_RECIPIENTS) {
        // Named numbers, and the fix. "Sending failed" here would send the tenant hunting through
        // their own list for a problem that is entirely on our side of the line.
        return {
            error: `This issue would go to ${opts.recipientCount.toLocaleString()} people, and sending from a connected mailbox is capped at ${MAILBOX_MAX_RECIPIENTS}. `
                + 'Verify a sending domain to send to your whole list — it takes a few DNS records.',
        };
    }

    return { route: { provider: mailbox, from: null, replyTo: null } };
}

/** Unguessable, URL-safe, and the same shape lead_threads.replyToken uses. */
export function mintUnsubscribeToken(): string {
    return randomBytes(18).toString('base64url');
}

/**
 * Create one newsletter_sends row per targeted contact.
 *
 * Runs before anything is sent, and is idempotent: ON CONFLICT DO NOTHING against
 * UNIQUE (issue_id, email) means a re-run adds only what is missing. This is what makes the whole
 * send resumable rather than duplicative.
 */
export async function materialiseRecipients(
    db: Db,
    issue: { id: number; organisationId: number; segmentId: number | null },
): Promise<number> {
    const CHUNK = 500;
    let created = 0;
    let cursor = 0;

    for (;;) {
        const base = db
            .select({
                id: audienceContacts.id,
                email: audienceContacts.email,
            })
            .from(audienceContacts);

        const rows = issue.segmentId
            ? await base
                .innerJoin(audienceContactSegments, eq(audienceContactSegments.contactId, audienceContacts.id))
                .where(and(
                    eq(audienceContacts.organisationId, issue.organisationId),
                    eq(audienceContacts.status, 'subscribed'),
                    eq(audienceContactSegments.segmentId, issue.segmentId),
                    sql`${audienceContacts.id} > ${cursor}`,
                ))
                .orderBy(audienceContacts.id)
                .limit(CHUNK)
            : await base
                .where(and(
                    eq(audienceContacts.organisationId, issue.organisationId),
                    eq(audienceContacts.status, 'subscribed'),
                    sql`${audienceContacts.id} > ${cursor}`,
                ))
                .orderBy(audienceContacts.id)
                .limit(CHUNK);

        if (!rows.length) break;
        cursor = rows[rows.length - 1].id;

        const inserted = await db.insert(newsletterSends)
            .values(rows.map((r) => ({
                organisationId: issue.organisationId,
                issueId: issue.id,
                contactId: r.id,
                email: r.email,
                unsubscribeToken: mintUnsubscribeToken(),
            })))
            .onConflictDoNothing()
            .returning({ id: newsletterSends.id });
        created += inserted.length;

        if (rows.length < CHUNK) break;
    }

    return created;
}

async function deliver(
    db: Db,
    route: SendRoute,
    organisationId: number,
    msg: { to: string; subject: string; html: string; text: string; listUnsubscribe: string | null },
): Promise<string> {
    if (route.provider === 'resend') {
        const res = await sendEmail({
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            from: route.from || undefined,
            replyTo: route.replyTo || undefined,
            headers: msg.listUnsubscribe
                ? {
                    'List-Unsubscribe': msg.listUnsubscribe,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
                : undefined,
        });
        return (res as { id?: string } | null)?.id ?? '';
    }

    const common = {
        to: msg.to,
        subject: msg.subject,
        body: msg.text,
        html: msg.html,
        listUnsubscribe: msg.listUnsubscribe || undefined,
    };
    if (route.provider === 'outlook') {
        await sendOutlookMessage(db, organisationId, common);
        return '';   // Graph returns 202 with an empty body — there is no id to record.
    }
    const res = await sendGmailMessage(db, organisationId, common);
    return res.id;
}

export interface IssueTickResult {
    issueId: number;
    sent: number;
    skipped: number;
    failed: number;
    /** True when no queued recipients remain. */
    done: boolean;
}

/**
 * Send one bounded batch for an already-claimed issue.
 *
 * Returns without finishing when there is more to do — the next tick continues. Nothing here
 * assumes it is the only worker: every write is keyed on the row it just read.
 */
export async function processIssueBatch(
    db: Db,
    issue: {
        id: number; organisationId: number; subject: string; renderedPayload: unknown;
        fromAddress: string | null; sendProvider: string | null;
    },
    ctx: { route: SendRoute; senderName: string; postalAddress: string | null; baseUrl: string },
): Promise<IssueTickResult> {
    const snapshot = issue.renderedPayload as IssueSnapshot | null;
    if (!snapshot || !snapshot.html) {
        throw new Error('This issue has no approved content to send. Approve it again to rebuild the email.');
    }

    const queued = await db
        .select({
            id: newsletterSends.id,
            email: newsletterSends.email,
            contactId: newsletterSends.contactId,
            token: newsletterSends.unsubscribeToken,
        })
        .from(newsletterSends)
        .where(and(eq(newsletterSends.issueId, issue.id), eq(newsletterSends.status, 'queued')))
        .orderBy(newsletterSends.id)
        .limit(BATCH_PER_TICK);

    if (!queued.length) return { issueId: issue.id, sent: 0, skipped: 0, failed: 0, done: true };

    // One consent question for the whole batch — per-address would be two queries per recipient.
    const verdicts = await checkAudienceConsentBulk(db, issue.organisationId, queued.map((q) => q.email));

    // Names come from the contact rows, for the merge vars.
    const contactIds = queued.map((q) => q.contactId).filter((v): v is number => v != null);
    const contacts = new Map<number, { firstName: string | null; lastName: string | null; company: string | null }>();
    if (contactIds.length) {
        const rows = await db
            .select({
                id: audienceContacts.id,
                firstName: audienceContacts.firstName,
                lastName: audienceContacts.lastName,
                company: audienceContacts.company,
            })
            .from(audienceContacts)
            .where(inArray(audienceContacts.id, contactIds));
        for (const r of rows) contacts.set(r.id, r);
    }

    let sent = 0; let skipped = 0; let failed = 0;

    for (const row of queued) {
        // A missing verdict is treated as unsendable — checkAudienceConsentBulk keys on the
        // normalised address, and anything it could not key is something we cannot vouch for.
        const verdict = verdicts.get(row.email) ?? { sendable: false, reason: 'consent_check_failed' as AudienceSkipReason };

        if (!verdict.sendable) {
            await db.update(newsletterSends)
                .set({ status: 'skipped', skipReason: verdict.reason, provider: ctx.route.provider, updatedAt: new Date() })
                .where(and(eq(newsletterSends.id, row.id), eq(newsletterSends.status, 'queued')));
            skipped++;
            continue;
        }

        const contact = row.contactId ? contacts.get(row.contactId) : undefined;
        const rendered = renderForRecipient({
            snapshot,
            contact: { ...(contact ?? {}), email: row.email },
            senderName: ctx.senderName,
            unsubscribeUrl: newsletterUnsubscribeUrl(ctx.baseUrl, row.token),
            postalAddress: ctx.postalAddress,
        });

        try {
            const messageId = await deliver(db, ctx.route, issue.organisationId, {
                to: row.email,
                subject: issue.subject,
                html: rendered.html,
                text: rendered.text,
                listUnsubscribe: rendered.listUnsubscribe,
            });
            await db.update(newsletterSends)
                .set({
                    status: 'sent',
                    provider: ctx.route.provider,
                    providerMessageId: messageId || null,
                    sentAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(and(eq(newsletterSends.id, row.id), eq(newsletterSends.status, 'queued')));
            // Stamped so the Audience page can show when someone was last emailed, and so a future
            // frequency cap has something to read.
            if (row.contactId) {
                await db.update(audienceContacts)
                    .set({ lastSentAt: new Date() })
                    .where(eq(audienceContacts.id, row.contactId));
            }
            sent++;
        } catch (err) {
            // One address failing is not the issue failing. Record it against the row and carry on
            // — the alternative strands everyone after the first bad address.
            await db.update(newsletterSends)
                .set({
                    status: 'failed',
                    provider: ctx.route.provider,
                    error: String((err as Error)?.message ?? err).slice(0, 500),
                    updatedAt: new Date(),
                })
                .where(and(eq(newsletterSends.id, row.id), eq(newsletterSends.status, 'queued')));
            failed++;
            console.error('[newsletter-send] recipient failed', { issueId: issue.id, sendId: row.id }, err);
        }
    }

    const [{ remaining }] = await db
        .select({ remaining: sql<number>`count(*)::int` })
        .from(newsletterSends)
        .where(and(eq(newsletterSends.issueId, issue.id), eq(newsletterSends.status, 'queued')));

    return { issueId: issue.id, sent, skipped, failed, done: remaining === 0 };
}

export interface SendSweepResult {
    claimed: number;
    sent: number;
    skipped: number;
    failed: number;
    completed: number;
    errors: { issueId: number; error: string }[];
}

/**
 * The cron entry point: pick up due issues and push each one along by a batch.
 */
export async function sendDueIssues(db: Db, opts: { baseUrl: string; now?: Date; maxIssues?: number }): Promise<SendSweepResult> {
    const now = opts.now ?? new Date();
    const out: SendSweepResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, completed: 0, errors: [] };

    // Reclaim anything a killed worker left mid-flight. Safe because the ledger rows carry the
    // real state — an issue put back to 'sending' resumes at its first still-queued recipient.
    await db.update(newsletterIssues)
        .set({ updatedAt: now })
        .where(and(
            eq(newsletterIssues.status, 'sending'),
            lt(newsletterIssues.updatedAt, new Date(now.getTime() - STALE_CLAIM_MS)),
        ));

    const due = await db
        .select({ id: newsletterIssues.id, status: newsletterIssues.status })
        .from(newsletterIssues)
        .where(sql`(${newsletterIssues.status} = 'scheduled' AND ${newsletterIssues.scheduledFor} <= ${now})
                   OR ${newsletterIssues.status} = 'sending'`)
        .orderBy(newsletterIssues.scheduledFor)
        .limit(opts.maxIssues ?? 5);

    for (const { id, status } of due) {
        // ⚠️ STATUS-GUARDED CLAIM, and we check we actually won it. Without the guard two
        // overlapping ticks both "claim" the same issue and both send to the same people.
        const [claimed] = await db
            .update(newsletterIssues)
            .set({ status: 'sending', sendingStartedAt: sql`COALESCE(${newsletterIssues.sendingStartedAt}, ${now})`, updatedAt: new Date() })
            .where(and(eq(newsletterIssues.id, id), eq(newsletterIssues.status, status)))
            .returning();
        if (!claimed) continue;   // another tick got there first
        out.claimed++;

        try {
            const [org] = await db
                .select({ name: organisations.name, postalAddress: organisations.outreachPostalAddress })
                .from(organisations)
                .where(eq(organisations.id, claimed.organisationId))
                .limit(1);
            const senderName = org?.name || 'Your business';

            const created = await materialiseRecipients(db, claimed);
            const [{ total }] = await db
                .select({ total: sql<number>`count(*)::int` })
                .from(newsletterSends)
                .where(eq(newsletterSends.issueId, claimed.id));

            if (total === 0) {
                // Nobody to send to. A "sent" issue with zero recipients would look like a success
                // and quietly hide an empty segment.
                await db.update(newsletterIssues).set({
                    status: 'failed',
                    failureReason: 'Nobody in this audience is subscribed, so there was nobody to send to.',
                    updatedAt: new Date(),
                }).where(eq(newsletterIssues.id, claimed.id));
                out.errors.push({ issueId: claimed.id, error: 'no recipients' });
                continue;
            }

            const routed = await resolveSendRoute(db, claimed.organisationId, { recipientCount: total, senderName });
            if ('error' in routed) {
                // Refused BEFORE the first email, and the reason is stored where the UI reads it.
                await db.update(newsletterIssues).set({
                    status: 'failed',
                    failureReason: routed.error,
                    updatedAt: new Date(),
                }).where(eq(newsletterIssues.id, claimed.id));
                out.errors.push({ issueId: claimed.id, error: routed.error });
                continue;
            }

            const route = routed.route;
            if (created > 0 || !claimed.sendProvider) {
                await db.update(newsletterIssues).set({
                    recipientCount: total,
                    sendProvider: route.provider,
                    fromAddress: route.from,
                    updatedAt: new Date(),
                }).where(eq(newsletterIssues.id, claimed.id));
            }

            const tick = await processIssueBatch(db, { ...claimed, sendProvider: route.provider }, {
                route,
                senderName,
                postalAddress: org?.postalAddress ?? null,
                baseUrl: opts.baseUrl,
            });
            out.sent += tick.sent;
            out.skipped += tick.skipped;
            out.failed += tick.failed;

            if (tick.done) {
                const [{ delivered }] = await db
                    .select({ delivered: sql<number>`count(*)::int` })
                    .from(newsletterSends)
                    .where(and(eq(newsletterSends.issueId, claimed.id), inArray(newsletterSends.status, ['sent', 'delivered'])));
                await db.update(newsletterIssues).set({
                    status: 'sent',
                    sentAt: new Date(),
                    recipientCount: delivered,
                    updatedAt: new Date(),
                }).where(and(eq(newsletterIssues.id, claimed.id), eq(newsletterIssues.status, 'sending')));
                out.completed++;
            } else {
                // Left in 'sending' on purpose — the next tick resumes at the first queued row.
                await db.update(newsletterIssues).set({ updatedAt: new Date() }).where(eq(newsletterIssues.id, claimed.id));
            }
        } catch (err) {
            const message = String((err as Error)?.message ?? err).slice(0, 500);
            console.error('[newsletter-send] issue failed', { issueId: id }, err);
            await db.update(newsletterIssues).set({
                status: 'failed',
                failureReason: message,
                updatedAt: new Date(),
            }).where(eq(newsletterIssues.id, id)).catch(() => undefined);
            out.errors.push({ issueId: id, error: message });
        }
    }

    return out;
}
