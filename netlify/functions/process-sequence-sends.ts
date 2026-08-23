// netlify/functions/process-sequence-sends.ts
// The outreach-sequence worker — Phase 2b of docs/lead-generator-revenue-engine-plan.md §5.2.
// Finds enrolments whose next follow-up is due, drafts it in the context of the thread so far,
// sends it from the tenant's own mailbox, and advances (or ends) the cadence.
//
// ── Why one worker instead of dispatcher + queue ─────────────────────────────
// The plan says "cloned wholesale from discovery_schedules + dispatch-discovery-runs.ts". That
// split exists because a discovery RUN is long — many searches, resumable across ticks — so the
// dispatcher must stay cheap. A follow-up is one LLM call and one mail-API call, measured in
// seconds. A job queue in front of that would add a table, a second function and a whole class of
// stuck-job failure modes to buy nothing, so `sequence_enrolments.next_send_at` IS the queue.
// Deliberate deviation, not an oversight.
//
// ── The safety properties, in the order they are enforced ────────────────────
//  1. CLAIM WITH A LEASE. Claiming pushes next_send_at forward by LEASE_MINUTES in the same
//     statement that selects the row, so an overlapping invocation cannot pick up a row this one
//     is still working on. A crash mid-send costs a delay, never a duplicate.
//  2. IDEMPOTENCY. Before sending, check whether this exact (thread, step) already produced an
//     outbound message. This is what covers the one window the lease cannot: a send that succeeded
//     but whose bookkeeping failed afterwards.
//  3. THE REPLY HALT. The thread's state is re-read immediately before the send and the send is
//     refused unless it is still 'open'. This is Phase 2a's reply detection acting as 2b's stop
//     condition, and it is the reason 2b could not be built first.
//  4. SUPPRESSION. Checked per send, not once at enrolment — a domain can land on the tenant's
//     suppression list days after the cadence started, and that is exactly when it matters.
//  5. CAPS. Per-org daily send ceiling and a hard per-enrolment step ceiling, both enforced here
//     rather than trusted to the data.
//
// Never throws out of the drain loop: one bad enrolment must not stop the other twenty-four.

import { and, eq, lte, sql } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, leadMessages, leadThreads, organisations, sequenceEnrolments } from '../../db/schema';
import { appendOutreachFooter, buildOutreachFooter, isUsablePostalAddress } from '../../src/config/outreach-footer';
import { SENDER_IDENTITY_RULE, senderIdentityBlock, type SenderIdentity } from '../../src/config/sender-identity';
import { loadSenderIdentity } from '../../src/utils/sender-identity';
import { sendGmailMessage } from '../../src/utils/gmail';
import { sendOutlookMessage } from '../../src/utils/outlook';
import { IntegrationError } from '../../src/utils/workspace-integrations';
import { recordEvent } from '../../src/utils/revenue-ledger';
import { makeBlueprintVersionCache } from '../../src/utils/blueprint-version';
import { makeIcpSnapshotCache } from '../../src/utils/icp-snapshot';
import { recordOutboundMessage } from '../../src/utils/lead-threads';
import { replyAddress } from '../../src/utils/reply-address';
import { checkSuppression } from '../../src/utils/suppression';
import { logAiUsage } from '../../src/utils/ai-usage';
import { OUTREACH_SUBJECT_RULES } from '../../src/constants/outreach-subject';
import { evaluateDoNotContact } from '../../src/config/do-not-contact';
import {
    advanceEnrolment, haltEnrolment, loadSteps, recordSendFailure, sequenceSendsToday,
    threadHistory, threadState, type EnrolmentRef, type SequenceStepRow,
} from '../../src/utils/outreach-sequences';
import {
    MAX_SEND_ATTEMPTS, MAX_SENDS_PER_ORG_PER_DAY, MAX_STEPS_PER_ENROLMENT,
    WORKER_BATCH_SIZE, WORKER_BUDGET_MS, sequenceTemplateVersion,
} from '../../src/config/outreach-sequences';
import { parseModelJson } from '../../src/utils/model-json';

type Db = ReturnType<typeof getDb>;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

/**
 * How long a claimed enrolment is invisible to other invocations. Comfortably longer than one
 * send (an LLM call plus a mail-API call) and shorter than the cron interval, so a crashed send
 * retries on the next tick rather than sitting idle for hours.
 */
const LEASE_MINUTES = 5;

// Index signature: db.execute<T>() constrains T to Record<string, unknown> (it is describing an
// arbitrary result row, not a known shape).
interface ClaimedRow extends Record<string, unknown> {
    id: number;
    organisation_id: number;
    ai_assistant_id: number;
    sequence_id: number;
    lead_thread_id: number;
    assistant_record_id: number | null;
    discovered_lead_id: number | null;
    contact_email: string | null;
    last_step_sent: number;
    attempt: number;
}

function toRef(r: ClaimedRow): EnrolmentRef {
    return {
        id: r.id,
        organisationId: r.organisation_id,
        aiAssistantId: r.ai_assistant_id,
        assistantRecordId: r.assistant_record_id,
        discoveredLeadId: r.discovered_lead_id,
        lastStepSent: r.last_step_sent,
    };
}

/**
 * Claim a batch of due enrolments.
 *
 * The UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) form is one statement, so the row
 * locks are held for its whole duration and two concurrent workers cannot claim the same row.
 * Pushing next_send_at forward by the lease is what extends that protection across INVOCATIONS —
 * a plain SELECT ... FOR UPDATE SKIP LOCKED releases its locks at statement end and would let the
 * next tick re-claim a row still being processed.
 */
async function claimDue(db: Db, limit: number): Promise<ClaimedRow[]> {
    const rows = await db.execute<ClaimedRow>(
        `UPDATE sequence_enrolments e
            SET next_send_at = now() + interval '${LEASE_MINUTES} minutes', updated_at = now()
          WHERE e.id IN (
                SELECT id FROM sequence_enrolments
                 WHERE state = 'active' AND next_send_at IS NOT NULL AND next_send_at <= now()
                 ORDER BY next_send_at
                 LIMIT ${Math.max(1, Math.floor(limit))}
                 FOR UPDATE SKIP LOCKED)
      RETURNING e.id, e.organisation_id, e.ai_assistant_id, e.sequence_id, e.lead_thread_id,
                e.assistant_record_id, e.discovered_lead_id, e.contact_email,
                e.last_step_sent, e.attempt`,
    );
    return Array.from(rows as unknown as ClaimedRow[]);
}

/**
 * Has this exact step already gone out on this thread?
 *
 * The idempotency key is (thread, template_version), and template_version is stamped
 * `seq:<sequenceId>:<stepNumber>` at send time. Covers the window the lease cannot: a send that
 * reached the mail API but whose enrolment update failed afterwards. Without this the retry would
 * send step 2 twice to the same person.
 */
async function alreadySent(db: Db, leadThreadId: number, templateVersion: string): Promise<boolean> {
    const [row] = await db
        .select({ id: leadMessages.id })
        .from(leadMessages)
        .where(and(
            eq(leadMessages.leadThreadId, leadThreadId),
            eq(leadMessages.direction, 'outbound'),
            eq(leadMessages.templateVersion, templateVersion),
        ))
        .limit(1);
    return !!row;
}

/** The assistant's identity and mailbox setup — the same onboarding answers send_outreach reads. */
async function loadAssistant(db: Db, aiAssistantId: number): Promise<{
    name: string; provider: 'google' | 'microsoft' | null; salesTone: string;
} | null> {
    const [row] = await db
        .select({ name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, aiAssistantId))
        .limit(1);
    if (!row) return null;

    let onboarding: Record<string, unknown> = {};
    const ctx = row.onboardingContext;
    if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) onboarding = ctx as Record<string, unknown>;
    else if (typeof ctx === 'string') { try { onboarding = JSON.parse(ctx); } catch { /* leave empty */ } }

    // The onboarding answer says 'microsoft'; the OAuth provider key is 'outlook'. Same mapping as
    // send_outreach — kept here rather than renaming the stored answer, which would strand every
    // assistant already onboarded.
    const raw = typeof onboarding.outreachEmailProvider === 'string' ? onboarding.outreachEmailProvider.trim() : '';
    const provider = raw === 'google' || raw === 'microsoft' ? raw : null;
    const salesTone = typeof onboarding.salesTone === 'string' && onboarding.salesTone.trim()
        ? onboarding.salesTone.trim() : 'professional';

    return { name: row.name ?? 'our team', provider, salesTone };
}

/** Draft the follow-up in the context of the conversation so far. Null when the model gives us nothing usable. */
async function draftFollowUp(
    db: Db,
    enrolment: ClaimedRow,
    assistant: { name: string; salesTone: string },
    sender: SenderIdentity,
    step: SequenceStepRow,
    originalSubject: string | null,
): Promise<{ subject: string; body: string } | null> {
    const history = await threadHistory(db, enrolment.lead_thread_id, 6);

    // The transcript is the working-memory tier from §5.3 — a direct read, no embedding. It is what
    // lets the follow-up reference what was actually said rather than restating the opener, which
    // is the difference between a follow-up and a mail-merge.
    const transcript = history.length
        ? history.map((m) => `[${m.direction === 'outbound' ? 'US' : 'THEM'}] ${m.subject ? `Subject: ${m.subject}\n` : ''}${m.body}`).join('\n---\n').slice(0, 6000)
        : '(no earlier messages recorded)';

    const system =
`You write follow-up emails in a ${assistant.salesTone} tone.

WHO THE EMAIL IS FROM:
${senderIdentityBlock(sender)}

${SENDER_IDENTITY_RULE}

This is follow-up number ${step.stepNumber} in an outreach sequence to a prospect who has NOT replied.

What this specific follow-up must do:
${step.bodyPrompt}

Hard rules:
- The prospect has not answered. Do not thank them for their reply, do not reference a conversation that did not happen, and do not invent facts about their business that are not in the transcript below.
- No placeholders, no square brackets, no "Dear [Name]".
- Plain text only. No markdown, no links unless one already appears in the transcript.
- Keep the subject line as a reply to the original thread where that reads naturally. This thread genuinely exists — we sent the earlier message — so a "Re:" prefix is honest here.
- BUT do not inherit a bad subject. If the original subject breaks any rule below (it invents an account or relationship, manufactures urgency, or reads as phishing), do NOT prefix it with "Re:" and carry it forward. Write a fresh, honest subject for this follow-up instead — one bad opener must not contaminate the rest of the sequence.

${OUTREACH_SUBJECT_RULES}

If this email should NOT be written at all — the transcript or lead details say this contact is not a
genuine prospect, must not be contacted, or the only honest email would break the rules above — do NOT
write one anyway and do NOT put your reasoning in the subject or body. Return exactly:
{ "decline": "<one short line saying why>" }

Otherwise return STRICT JSON only (no markdown, no prose outside the JSON):
{ "subject": "<subject line>", "body": "<the email body>" }`;

    const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 640,
        system,
        messages: [{
            role: 'user',
            content: `Original subject: ${originalSubject ?? '(unknown)'}\n\nConversation so far, oldest first:\n${transcript}`,
        }],
    });

    void logAiUsage({
        workspaceId: enrolment.organisation_id,
        userId: null,
        assistantId: enrolment.ai_assistant_id,
        model: MODEL,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        sessionId: `sequence-send:${enrolment.ai_assistant_id}:step${step.stepNumber}`,
        dataCategories: ['business_context'],
    });

    const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    // Shared extractor. A follow-up whose model narrated above the fence used to return null here,
    // which routes into handleSendFailure — a cadence step silently skipped over a wrapper.
    const parsed = parseModelJson<{ subject?: unknown; body?: unknown; decline?: unknown }>(raw);
    if (!parsed) return null;

    // An explicit refusal. Without this channel the model has nowhere to put "this should not be
    // sent" except the subject and body — which then get emailed verbatim. Returning null routes it
    // into handleSendFailure, the same path as an unusable draft, so the step does not silently send.
    if (typeof parsed?.decline === 'string' && parsed.decline.trim()) {
        console.log(`[sequence-sends] model declined to draft step ${step.stepNumber}: ${parsed.decline.trim().slice(0, 200)}`);
        return null;
    }

    const body = typeof parsed?.body === 'string' ? parsed.body.trim().slice(0, 4000) : '';
    if (!body) return null;
    const subject = typeof parsed?.subject === 'string' && parsed.subject.trim()
        ? parsed.subject.trim().slice(0, 300)
        : (originalSubject ? `Re: ${originalSubject}`.slice(0, 300) : 'Following up');

    return { subject, body };
}

// ── One enrolment ────────────────────────────────────────────────────────────

async function processEnrolment(
    db: Db,
    row: ClaimedRow,
    blueprintVersionFor: (assistantId: number | null | undefined) => Promise<string | null>,
    icpSnapshotFor: (ref: { discoveredLeadId?: number | null; aiAssistantId?: number | null }) => Promise<Record<string, unknown> | null>,
): Promise<'sent' | 'halted' | 'skipped'> {
    const ref = toRef(row);

    // (3) THE REPLY HALT — re-read, do not trust the claim. The claim query filtered on the
    // enrolment's own state, but the authoritative signal lives on the THREAD and can have changed
    // between the two. Anything other than 'open' means the prospect has spoken.
    const tState = await threadState(db, row.lead_thread_id);
    if (tState !== 'open') {
        await haltEnrolment(db, ref, tState === 'replied' ? 'replied' : 'record_closed', `thread state: ${tState ?? 'missing'}`);
        return 'halted';
    }

    // The lead record still has to be live. A rejected or deleted lead must not keep receiving mail
    // just because a cadence was already running when someone rejected it.
    if (row.assistant_record_id) {
        const [rec] = await db
            .select({ approvalStatus: assistantRecords.approvalStatus, data: assistantRecords.data })
            .from(assistantRecords)
            .where(eq(assistantRecords.id, row.assistant_record_id))
            .limit(1);
        if (!rec || rec.approvalStatus === 'rejected') {
            await haltEnrolment(db, ref, 'record_closed', rec ? 'lead rejected' : 'lead record deleted');
            return 'halted';
        }

        // The do-not-contact gate has to run HERE as well as at send_outreach. That gate only
        // guards the first email; a cadence already in flight never passes through it again, so an
        // enrolment created before the gate existed would keep sending on schedule. Re-read per
        // step rather than trusting enrolment time — a lead can be re-scored mid-cadence.
        const dnc = evaluateDoNotContact(rec.data);
        if (dnc.blocked) {
            await haltEnrolment(db, ref, 'do_not_contact', dnc.reason ?? `flagged do-not-contact (${dnc.source})`);
            return 'halted';
        }
        if (dnc.overridden) {
            // The human override lives on the record, so the cadence keeps running rather than
            // halting at step 2 — which is the whole reason the override is persisted and not a
            // per-send flag. Logged per step so a bypass is never silent.
            console.log(`[sequence-sends] do-not-contact overridden for record ${row.assistant_record_id} by ${dnc.override?.by}: ${dnc.override?.reason}`);
        }
    }

    const steps = await loadSteps(db, row.sequence_id);
    if (!steps || !steps.length) {
        await haltEnrolment(db, ref, 'max_steps', 'sequence has no enabled steps');
        return 'halted';
    }

    const step = steps.find((s) => s.stepNumber > row.last_step_sent);
    // (5) Hard per-enrolment ceiling, independent of what the steps table holds.
    if (!step || step.stepNumber > MAX_STEPS_PER_ENROLMENT) {
        await advanceEnrolment(db, ref, row.last_step_sent, steps);
        return 'halted';
    }

    const recipient = row.contact_email;
    if (!recipient) {
        await haltEnrolment(db, ref, 'no_recipient');
        return 'halted';
    }

    // (4) Suppression, per send. A domain can join the tenant's list days after the cadence began —
    // and since 2026-08-21 this same call also carries the AUDIENCE's refusals, so an unsubscribe
    // or a preference-centre pause reaches the cadence too (src/utils/audience-objection.ts).
    const suppression = await checkSuppression(db, row.organisation_id, recipient);
    if (suppression.suppressed) {
        if (suppression.unknown) return 'skipped';   // lookup failed — retry next tick, do not halt

        // ⚠️ A PAUSE IS NOT A STOP. Halting would end this cadence for ever because somebody asked
        // for thirty days of quiet, and nothing ever resumes a halted enrolment. Deferred to the
        // moment the pause lifts instead — the verdict carries the date, so this worker does not
        // have to know what a pause is. Same shape as the welcome-sequence worker in
        // src/utils/newsletter-sequence.ts; the two must not diverge.
        if (suppression.retryAfter) {
            await db.update(sequenceEnrolments)
                .set({ attempt: 0, nextSendAt: suppression.retryAfter, updatedAt: new Date() })
                .where(eq(sequenceEnrolments.id, row.id));
            return 'skipped';
        }

        // ⚠️ `do_not_contact` for an audience refusal, `suppressed` for a list hit — the person
        // said stop, versus the tenant's own list said don't. Both keys are already in the
        // halt_reason CHECK, so neither needs DDL; inventing one would make the halt UPDATE fail
        // and leave the enrolment ACTIVE and still sending ([[outreach-do-not-contact-gate]]).
        await haltEnrolment(db, ref,
            suppression.source === 'audience' ? 'do_not_contact' : 'suppressed',
            suppression.reason ?? null);
        return 'halted';
    }

    const templateVersion = sequenceTemplateVersion(row.sequence_id, step.stepNumber);

    // (2) IDEMPOTENCY — the send may already have happened on a previous attempt whose bookkeeping
    // failed. Advance past it rather than sending a second copy.
    if (await alreadySent(db, row.lead_thread_id, templateVersion)) {
        console.warn('[sequence-sends] step already sent, advancing without resending', {
            enrolmentId: row.id, templateVersion,
        });
        await advanceEnrolment(db, ref, step.stepNumber, steps);
        return 'skipped';
    }

    const assistant = await loadAssistant(db, row.ai_assistant_id);
    if (!assistant) {
        await haltEnrolment(db, ref, 'record_closed', 'assistant deleted');
        return 'halted';
    }
    if (!assistant.provider) {
        await haltEnrolment(db, ref, 'not_connected', 'no outreach email provider configured');
        return 'halted';
    }

    // Reply-To must be the thread's own alias, so a reply to the FOLLOW-UP routes back to the same
    // conversation. Getting this wrong would mean a reply to step 2 never halts the cadence.
    const [thread] = await db
        .select({ replyToken: leadThreads.replyToken })
        .from(leadThreads)
        .where(eq(leadThreads.id, row.lead_thread_id))
        .limit(1);

    const [opener] = await db
        .select({ subject: leadMessages.subject })
        .from(leadMessages)
        .where(and(eq(leadMessages.leadThreadId, row.lead_thread_id), eq(leadMessages.direction, 'outbound')))
        .orderBy(leadMessages.occurredAt)
        .limit(1);

    // Read ONCE, above the draft. The identity half is needed by the prompt (who is this email
    // from?) and the postal-address half by the gate below, and two reads of the same row is how
    // the body and the footer ended up disagreeing about the sender in the first place.
    const [orgRow] = await db
        .select({ name: organisations.name, postalAddress: organisations.outreachPostalAddress })
        .from(organisations)
        .where(eq(organisations.id, row.organisation_id))
        .limit(1);
    const sender = await loadSenderIdentity(db, row.organisation_id);

    let draft: { subject: string; body: string } | null;
    try {
        draft = await draftFollowUp(db, row, assistant, sender, step, opener?.subject ?? null);
    } catch (err) {
        return await handleSendFailure(db, ref, row, err, 'draft failed');
    }
    if (!draft) return await handleSendFailure(db, ref, row, null, 'model returned no usable draft');

    // Last check before the irreversible step. The draft above took an LLM round trip — seconds in
    // which a reply could have landed. Re-reading here costs one indexed query and is the
    // difference between "we halt on reply" and "we halt on reply unless we were mid-draft".
    if (await threadState(db, row.lead_thread_id) !== 'open') {
        await haltEnrolment(db, ref, 'replied', 'reply arrived while drafting');
        return 'halted';
    }

    // Every follow-up carries the footer too, not just the opener. A cadence step is a separate
    // commercial email and each one independently needs its own opt-out route — and in practice a
    // step-3 chase is the message someone is most likely to want to stop.
    // Same hard gate as the opener (send_outreach): no postal address, no send. A follow-up is an
    // independent commercial email and needs the address just as much as step 1 did.
    //
    // ⚠️ SKIP, not halt — and not just to avoid touching the halt_reason CHECK constraint. A
    // missing address is a fixable configuration gap, not a verdict about this lead: halting would
    // permanently kill every in-flight cadence over a field the user can fill in in ten seconds,
    // and halts are not resumable. Skipping retries on the next tick, so the sequence picks up by
    // itself once the address is saved. Same reasoning as the suppression-lookup skip above.
    if (!isUsablePostalAddress(orgRow?.postalAddress)) {
        console.warn(`[process-sequence-sends] deferring enrolment ${ref.id}: org ${row.organisation_id} has no usable postal address`);
        return 'skipped';
    }

    const footer = buildOutreachFooter({
        senderName: orgRow?.name ?? assistant.name ?? '',
        postalAddress: orgRow?.postalAddress,
        replyToken: thread?.replyToken,
    });

    try {
        const outgoing = {
            to: recipient,
            subject: draft.subject,
            // As in lead-generation.ts, the STORED message below keeps the un-footered body — the
            // transcript is what the assistant wrote, not the boilerplate wrapped around it.
            body: appendOutreachFooter(draft.body, footer),
            ...(thread ? { replyTo: replyAddress(thread.replyToken) } : {}),
            ...(footer.listUnsubscribe ? { listUnsubscribe: footer.listUnsubscribe } : {}),
        };
        if (assistant.provider === 'microsoft') await sendOutlookMessage(db, row.organisation_id, outgoing);
        else await sendGmailMessage(db, row.organisation_id, outgoing);
    } catch (err) {
        if (err instanceof IntegrationError) {
            // A dead mailbox connection will not fix itself by the next tick — halt rather than
            // burning the retry budget, so the tenant sees one clear reason instead of three.
            await haltEnrolment(db, ref, 'not_connected', err.message);
            return 'halted';
        }
        return await handleSendFailure(db, ref, row, err, 'send failed');
    }

    // Past this point the email is delivered. Everything below is bookkeeping and must not be
    // allowed to surface as a failure — the same contract as the opening send in lead-generation.ts.
    const sentAt = new Date();
    await recordOutboundMessage(db, row.lead_thread_id, {
        organisationId: row.organisation_id,
        subject: draft.subject,
        body: draft.body,
        generatedBody: draft.body,   // nothing here was human-edited
        templateVersion,
    });

    // Same event type as the opening email, with the step in the payload. "How many emails did we
    // send this lead?" should not require unioning two event types — see revenue-events.ts.
    await recordEvent(db, 'outreach_sent', {
        organisationId: row.organisation_id,
        aiAssistantId: row.ai_assistant_id,
        discoveredLeadId: row.discovered_lead_id,
        assistantRecordId: row.assistant_record_id,
        actor: 'agent',
        blueprintVersion: await blueprintVersionFor(row.ai_assistant_id),
        icpSnapshot: await icpSnapshotFor({
            discoveredLeadId: row.discovered_lead_id,
            aiAssistantId: row.ai_assistant_id,
        }),
        payload: {
            provider: assistant.provider,
            sequenceId: row.sequence_id,
            sequenceStep: step.stepNumber,
            automated: true,
        },
    });

    await advanceEnrolment(db, ref, step.stepNumber, steps, sentAt);
    return 'sent';
}

/** Bump the attempt counter, and halt once the budget is gone. */
async function handleSendFailure(
    db: Db, ref: EnrolmentRef, row: ClaimedRow, err: unknown, label: string,
): Promise<'halted' | 'skipped'> {
    const message = err instanceof Error ? err.message : String(err ?? label);
    console.error('[sequence-sends] ' + label, { enrolmentId: row.id, error: message });

    const attempt = await recordSendFailure(db, row.id, `${label}: ${message}`);
    if (attempt !== null && attempt >= MAX_SEND_ATTEMPTS) {
        await haltEnrolment(db, ref, 'send_failed', `${label}: ${message}`);
        return 'halted';
    }
    // Leave the lease in place — the row retries on a later tick.
    return 'skipped';
}

// ── The drain loop ───────────────────────────────────────────────────────────

export interface DrainResult { claimed: number; sent: number; halted: number; skipped: number }

export async function drainSequenceSends(): Promise<DrainResult> {
    const result: DrainResult = { claimed: 0, sent: 0, halted: 0, skipped: 0 };
    const startedAt = Date.now();

    let db: Db;
    try {
        db = getDb();
    } catch (err) {
        console.error('[sequence-sends] no database handle', err);
        return result;
    }

    let claimed: ClaimedRow[];
    try {
        claimed = await claimDue(db, WORKER_BATCH_SIZE);
    } catch (err) {
        // A missing table means db/outreach-sequences.sql has not been applied. Log and return
        // cleanly rather than erroring the scheduled invocation — the product degrades to
        // "outreach sends once and never follows up", which is exactly today's behaviour.
        const pg = err as { code?: string; cause?: { code?: string } };
        const code = pg?.code ?? pg?.cause?.code;
        if (code === '42P01') {
            console.error('[sequence-sends] sequence_enrolments is missing — apply db/outreach-sequences.sql');
        } else {
            console.error('[sequence-sends] claim failed', { pgCode: code, cause: pg?.cause }, err);
        }
        return result;
    }

    result.claimed = claimed.length;
    if (!claimed.length) return result;

    // Per-org daily ceiling, evaluated once per org per tick and decremented locally as we send.
    const budget = new Map<number, number>();

    // Attribution (§7.2). A tick spans many orgs and assistants, so memoise — but per RUN, never at
    // module level: a warm container would keep stamping a version that a recompile has replaced.
    // Safe to memoise here because the loop below is sequential, so misses never overlap.
    const blueprintVersionFor = makeBlueprintVersionCache(db);
    // Per-run cache, same lifetime rule as the blueprint one: created here and left to fall out of
    // scope, never module-level, or a warm container would stamp a stale ICP after a retarget.
    const icpSnapshotFor = makeIcpSnapshotCache(db);

    for (const row of claimed) {
        if (Date.now() - startedAt > WORKER_BUDGET_MS) {
            // Out of wall clock. The unprocessed rows keep their lease and are picked up next tick.
            console.log('[sequence-sends] budget reached, stopping cleanly', { processed: result.sent + result.halted + result.skipped });
            break;
        }

        if (!budget.has(row.organisation_id)) {
            budget.set(row.organisation_id, Math.max(0, MAX_SENDS_PER_ORG_PER_DAY - await sequenceSendsToday(db, row.organisation_id)));
        }
        const remaining = budget.get(row.organisation_id) ?? 0;
        if (remaining <= 0) {
            // Not a halt — the cadence is fine, the org has simply hit today's ceiling. Push the
            // send into tomorrow rather than dropping it.
            console.warn('[sequence-sends] org daily cap reached, deferring', { organisationId: row.organisation_id });
            await db.update(sequenceEnrolments)
                .set({ nextSendAt: sql`now() + interval '12 hours'`, updatedAt: new Date() })
                .where(eq(sequenceEnrolments.id, row.id));
            result.skipped++;
            continue;
        }

        try {
            const outcome = await processEnrolment(db, row, blueprintVersionFor, icpSnapshotFor);
            if (outcome === 'sent') { result.sent++; budget.set(row.organisation_id, remaining - 1); }
            else if (outcome === 'halted') result.halted++;
            else result.skipped++;
        } catch (err) {
            // One bad enrolment must not stop the batch.
            console.error('[sequence-sends] enrolment failed', { enrolmentId: row.id }, err);
            result.skipped++;
        }
    }

    return result;
}

export default withLambda(async () => {
    const r = await drainSequenceSends();
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r),
    };
});
