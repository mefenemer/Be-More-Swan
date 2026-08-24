// src/utils/lead-threads.ts
// Read/write helpers for lead conversations (Phase 2a of
// docs/lead-generator-revenue-engine-plan.md). The single place `lead_threads` / `lead_messages`
// are written, for the same reason recordEvent() is the only ledger writer: the invariants below
// only hold if there is one implementation of them.
//
// ── Best-effort by contract ──────────────────────────────────────────────────
// Every function here resolves to null / undefined on failure and NEVER throws. Conversation
// history is bookkeeping ABOUT the outreach, not part of it — an email that has already been
// delivered must not surface as a failure because a row could not be written, and inbound support
// mail must keep flowing if these tables are missing entirely.
//
// That is deliberate given db/lead-threads.sql is a manual apply: on an un-migrated environment
// every call here quietly no-ops and the product keeps working with no conversation history,
// rather than breaking a feature that worked yesterday (the 2026-08-02 lesson).
//
// The corollary: silence is a real outcome. If threads are missing, look for the console.error
// lines below before assuming the call site never ran.

import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { leadThreads, leadMessages } from '../../db/schema';
import { mintReplyToken, replyAddress } from './reply-address';
import { appendOutreachFooter, buildOutreachFooter } from '../config/outreach-footer';

type Db = ReturnType<typeof getDb>;

export interface OpenThreadInput {
    organisationId: number;
    aiAssistantId: number;
    assistantRecordId?: number | null;
    discoveredLeadId?: number | null;
    contactEmail?: string | null;
    channel?: 'email' | 'dm';
}

export interface ThreadRef { id: number; replyToken: string }

/** An address as a mailbox would compare it: trimmed and case-insensitive. '' means "unknown". */
function normaliseAddress(value: string | null | undefined): string {
    return String(value ?? '').trim().toLowerCase();
}

/**
 * Get the open thread for a lead record, or create one.
 *
 * Reuses an existing OPEN or REPLIED thread rather than minting a new alias per send: a follow-up
 * belongs to the same conversation the prospect is already reading, and a second Reply-To would
 * split one exchange across two threads. Only a closed thread starts a fresh one.
 *
 * ⚠️ A thread is reused ONLY when its recorded address is the one this send is going to. The
 * reply_token printed in an email is what lead-unsubscribe.ts resolves an opt-out against, and it
 * suppresses `lead_threads.contact_email` — so a token must map to exactly one address for the
 * lifetime of that thread. Before this rule the row kept whichever address it was CREATED with and
 * the current recipient was silently ignored, so a lead whose email changed after its first send
 * (enrichment finding a better address, a reviewer editing the lead) sent every later email to the
 * new address carrying the old address's token. Unsubscribing then suppressed a third party who
 * never asked, and left the person who did ask still receiving mail — an opt-out that opts nobody
 * out, which is the one thing CAN-SPAM and CASL both require to work. Observed on staging
 * 2026-08-24.
 *
 * Updating the row in place would have inverted the same bug rather than fixing it: an unsubscribe
 * clicked from an OLDER email, already delivered to the previous address, would then suppress the
 * new one. A changed address therefore starts a new thread with a new token, and the old thread is
 * left open — the prospect may still reply to it, and that reply belongs to the address that
 * received it.
 */
export async function openLeadThread(db: Db, input: OpenThreadInput): Promise<ThreadRef | null> {
    try {
        if (input.assistantRecordId) {
            const [existing] = await db
                .select({
                    id: leadThreads.id,
                    replyToken: leadThreads.replyToken,
                    state: leadThreads.state,
                    contactEmail: leadThreads.contactEmail,
                })
                .from(leadThreads)
                .where(and(
                    eq(leadThreads.organisationId, input.organisationId),
                    eq(leadThreads.assistantRecordId, input.assistantRecordId),
                ))
                .orderBy(desc(leadThreads.createdAt))
                .limit(1);
            if (existing && existing.state !== 'closed') {
                const known = normaliseAddress(existing.contactEmail);
                const wanted = normaliseAddress(input.contactEmail);

                // The caller does not know the address (a DM channel, or a send path that never
                // resolved one), or it is the address already on the thread. Same conversation.
                if (!wanted || known === wanted) {
                    return { id: existing.id, replyToken: existing.replyToken };
                }

                // The thread has never recorded an address and we now know it. Adopt it rather
                // than forking: nothing has been sent under a DIFFERENT one, so the token is not
                // yet bound to anybody — and until it is, lead-unsubscribe.ts can only 404 on it
                // (it refuses a thread with no contact_email), which is an opt-out link that
                // cannot opt anyone out.
                if (!known) {
                    await db.update(leadThreads)
                        .set({ contactEmail: String(input.contactEmail).trim(), updatedAt: new Date() })
                        .where(eq(leadThreads.id, existing.id));
                    return { id: existing.id, replyToken: existing.replyToken };
                }

                // Both known and different — fall through and mint a new thread for the new
                // address. The `desc(createdAt)` ordering above means the next send finds THIS
                // one, so the fork happens once per address change rather than on every send.
            }
        }

        const replyToken = mintReplyToken();
        const [created] = await db.insert(leadThreads).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            assistantRecordId: input.assistantRecordId ?? null,
            discoveredLeadId: input.discoveredLeadId ?? null,
            contactEmail: input.contactEmail ?? null,
            channel: input.channel ?? 'email',
            replyToken,
            state: 'open',
        }).returning({ id: leadThreads.id, replyToken: leadThreads.replyToken });

        return created ? { id: created.id, replyToken: created.replyToken } : null;
    } catch (err) {
        logQuietly('openLeadThread', err);
        return null;
    }
}

export interface OutboundMessageInput {
    organisationId: number;
    fromEmail?: string | null;
    subject?: string | null;
    body: string;
    /** The agent's draft. Differs from `body` only when a human edited before sending (plan §2.6). */
    generatedBody?: string | null;
    editedBy?: number | null;
    templateVersion?: string | null;
}

/** Append an outbound message and stamp the thread's last_outbound_at. */
export async function recordOutboundMessage(db: Db, threadId: number, input: OutboundMessageInput): Promise<number | null> {
    try {
        const now = new Date();
        const [row] = await db.insert(leadMessages).values({
            organisationId: input.organisationId,
            leadThreadId: threadId,
            direction: 'outbound',
            fromEmail: input.fromEmail ?? null,
            subject: input.subject ?? null,
            body: input.body,
            generatedBody: input.generatedBody ?? null,
            editedBy: input.editedBy ?? null,
            templateVersion: input.templateVersion ?? null,
            occurredAt: now,
        }).returning({ id: leadMessages.id });

        // An outbound message never revives a replied thread — the prospect has spoken, and the
        // state reflects THEIR last action, not ours.
        await db.update(leadThreads)
            .set({ lastOutboundAt: now, updatedAt: now })
            .where(eq(leadThreads.id, threadId));

        return row?.id ?? null;
    } catch (err) {
        logQuietly('recordOutboundMessage', err);
        return null;
    }
}

export interface InboundMessageInput {
    organisationId: number;
    fromEmail?: string | null;
    subject?: string | null;
    body: string;
    occurredAt?: Date;
}

/**
 * Append an inbound message and flip the thread to `replied`.
 *
 * The state change is what halts an outreach sequence (plan §5.2 — "any inbound reply immediately
 * halts the sequence"). It is applied HERE, in the same call that records the message, so there is
 * no window in which a reply exists but the sequence still believes it may send. A follow-up
 * landing minutes after someone answered is the single most damaging thing this system could do.
 */
export async function recordInboundMessage(db: Db, threadId: number, input: InboundMessageInput): Promise<number | null> {
    try {
        const now = input.occurredAt ?? new Date();
        const [row] = await db.insert(leadMessages).values({
            organisationId: input.organisationId,
            leadThreadId: threadId,
            direction: 'inbound',
            fromEmail: input.fromEmail ?? null,
            subject: input.subject ?? null,
            body: input.body,
            occurredAt: now,
        }).returning({ id: leadMessages.id });

        await db.update(leadThreads)
            .set({ state: 'replied', lastInboundAt: now, updatedAt: now })
            .where(eq(leadThreads.id, threadId));

        return row?.id ?? null;
    } catch (err) {
        logQuietly('recordInboundMessage', err);
        return null;
    }
}

export interface ReplyEnvelopeInput {
    organisationId: number;
    aiAssistantId: number;
    /** Subject line, already threaded (`Re: …`) by the caller. */
    subject: string;
    /** The human's text, un-footered. Stored as-is by recordOutboundMessage; footered only on the wire. */
    body: string;
    /** Who the prospect is hearing from — the organisation's name. */
    senderName: string;
    postalAddress?: string | null;
}

/** What a mail helper needs to send one reply, with no credential in it. */
export interface ReplyEnvelope {
    to: string;
    subject: string;
    /** `body` WITH the compliance footer appended — the wire copy, not the stored copy. */
    body: string;
    replyTo?: string;
    listUnsubscribe?: string;
}

/**
 * Build the outgoing envelope for a human reply in an existing thread.
 *
 * ⚠️ THIS LIVES HERE FOR ONE REASON: the thread's `replyToken` is a bearer credential — anyone
 * holding it can post into the conversation through the public Parse webhook — and it must not leave
 * this module. The Conversations function needs the Reply-To alias and the unsubscribe link that are
 * DERIVED from it, so it asks for the finished envelope rather than for the token.
 * tests/lead-threads.test.ts asserts the string `replyToken` appears in neither the read API nor the
 * UI, which is the guard that keeps this arrangement honest.
 *
 * Returns null when the thread is missing, belongs to another tenant or assistant, or has no contact
 * address. Never throws, like everything else in this file.
 */
export async function buildThreadReplyEnvelope(
    db: Db,
    threadId: number,
    input: ReplyEnvelopeInput,
): Promise<ReplyEnvelope | null> {
    try {
        const [row] = await db
            .select({ contactEmail: leadThreads.contactEmail, replyToken: leadThreads.replyToken })
            .from(leadThreads)
            .where(and(
                eq(leadThreads.id, threadId),
                eq(leadThreads.organisationId, input.organisationId),
                eq(leadThreads.aiAssistantId, input.aiAssistantId),
            ))
            .limit(1);

        const to = (row?.contactEmail || '').trim();
        if (!to) return null;

        // The same footer builder both send sites use. A reply is an independent commercial email and
        // needs its own opt-out route and sender identification, exactly as the opener and each
        // chaser do.
        const footer = buildOutreachFooter({
            senderName: input.senderName,
            postalAddress: input.postalAddress,
            replyToken: row?.replyToken,
        });

        return {
            to,
            subject: input.subject,
            body: appendOutreachFooter(input.body, footer),
            ...(row?.replyToken ? { replyTo: replyAddress(row.replyToken) } : {}),
            ...(footer.listUnsubscribe ? { listUnsubscribe: footer.listUnsubscribe } : {}),
        };
    } catch (err) {
        logQuietly('buildThreadReplyEnvelope', err);
        return null;
    }
}

/** Resolve a thread by its inbound alias token. Null when unknown — never throws. */
export async function findThreadByReplyToken(db: Db, token: string): Promise<{
    id: number; organisationId: number; aiAssistantId: number;
    assistantRecordId: number | null; discoveredLeadId: number | null; state: string;
} | null> {
    try {
        const [row] = await db
            .select({
                id: leadThreads.id,
                organisationId: leadThreads.organisationId,
                aiAssistantId: leadThreads.aiAssistantId,
                assistantRecordId: leadThreads.assistantRecordId,
                discoveredLeadId: leadThreads.discoveredLeadId,
                state: leadThreads.state,
            })
            .from(leadThreads)
            .where(eq(leadThreads.replyToken, token))
            .limit(1);
        return row ?? null;
    } catch (err) {
        logQuietly('findThreadByReplyToken', err);
        return null;
    }
}

/**
 * Log with the Postgres detail spelled out. A bare dump hides the constraint name, which is how
 * an assistant_records CHECK violation stayed invisible for weeks; and postgres-js wraps the real
 * failure so "Failed query" alone tells you nothing — read `cause`.
 */
function logQuietly(fn: string, err: unknown): void {
    const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
    console.error(`[lead-threads] ${fn} failed (non-fatal)`, {
        pgCode: pg?.code,
        pgConstraint: pg?.constraint_name ?? pg?.constraint,
        cause: pg?.cause,
    }, err);
}
