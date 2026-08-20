// netlify/functions/newsletter-sequences.ts
// The welcome sequence a new subscriber receives. Org-scoped via requireTenant.
//
//   GET                            → the org's sequence, its steps, and live enrolment counts
//   POST { action: 'create' }      → start one (disabled, with no steps)
//   POST { action: 'saveStep' }    → add or edit a step; re-renders its snapshot
//   POST { action: 'deleteStep' }  → remove a step
//   POST { action: 'enable' }      → turn it on / off
//
// ⚠️ ENABLING IS THE CONSEQUENTIAL ACTION and it is owner/admin only. Everything before it is
// drafting; enabling is the decision that these words go to every future subscriber automatically,
// with nobody reading them again.

import { HandlerEvent } from '@netlify/functions';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, newsletterSequenceEnrolments, newsletterSequenceSteps, newsletterSequences,
    organisations,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { renderIssueSnapshot } from '../../src/utils/newsletter-render';
import { scrubMergeTags } from '../../src/utils/newsletter-generate';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

const WRITE_ROLES = ['owner', 'admin', 'member'];
const ENABLE_ROLES = ['owner', 'admin'];
const MAX_STEPS = 8;
const MAX_BODY = 20000;

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        try {
            const [sequence] = await db.select().from(newsletterSequences)
                .where(and(
                    eq(newsletterSequences.organisationId, ctx.organisationId),
                    eq(newsletterSequences.triggerEvent, 'subscribed'),
                )).limit(1);
            if (!sequence) return json(200, { sequence: null, steps: [], enrolments: {} });

            const steps = await db.select().from(newsletterSequenceSteps)
                .where(eq(newsletterSequenceSteps.sequenceId, sequence.id))
                .orderBy(asc(newsletterSequenceSteps.stepNumber));

            // Counts by state. "How many people are part way through this?" is the question an
            // owner asks before switching it off, and it should not require a support request.
            const counts = await db
                .select({ state: newsletterSequenceEnrolments.state, n: sql<number>`count(*)::int` })
                .from(newsletterSequenceEnrolments)
                .where(eq(newsletterSequenceEnrolments.sequenceId, sequence.id))
                .groupBy(newsletterSequenceEnrolments.state);
            const enrolments: Record<string, number> = {};
            for (const c of counts) enrolments[c.state] = c.n;

            return json(200, { sequence, steps, enrolments });
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            return json(200, { sequence: null, steps: [], enrolments: {}, needsSetup: true });
        }
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        // ⚠️ IDEMPOTENT. Every read in this file and in the enrolment path resolves the org's
        // sequence with `LIMIT 1` and no ordering, so a second row is not a duplicate the tenant
        // can see — it is a coin toss over which sequence their steps attach to and which one
        // enrols new subscribers. A double-clicked button was enough to create it.
        const [existing] = await db.select().from(newsletterSequences)
            .where(and(
                eq(newsletterSequences.organisationId, orgId),
                eq(newsletterSequences.triggerEvent, 'subscribed'),
            )).limit(1);
        if (existing) return json(200, { sequence: existing });

        const assistantId = Number(body.assistantId || '') || null;
        if (assistantId) {
            const [a] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
            if (!a) return json(404, { error: 'Assistant not found.' });
        }
        const [sequence] = await db.insert(newsletterSequences).values({
            organisationId: orgId,
            assistantId,
            name: String(body.name || 'Welcome sequence').trim().slice(0, 80) || 'Welcome sequence',
            createdBy: ctx.userId,
        }).returning();
        return json(200, { sequence });
    }

    const [sequence] = await db.select().from(newsletterSequences)
        .where(and(
            eq(newsletterSequences.organisationId, orgId),
            eq(newsletterSequences.triggerEvent, 'subscribed'),
        )).limit(1);
    if (!sequence) return json(404, { error: 'No welcome sequence yet.' });

    if (action === 'saveStep') {
        const stepNumber = Number(body.stepNumber || 0);
        if (!Number.isFinite(stepNumber) || stepNumber < 1 || stepNumber > MAX_STEPS) {
            return json(400, { error: `A sequence can have at most ${MAX_STEPS} steps.` });
        }
        const subject = String(body.subject || '').trim().slice(0, 200);
        if (!subject) return json(400, { error: 'Give the email a subject line.' });

        // Scrubbed like every other write path — a step can carry a tag the send worker cannot
        // resolve just as easily as an issue can, and this one goes out unattended.
        const bodyMarkdown = scrubMergeTags(String(body.bodyMarkdown || '').slice(0, MAX_BODY)).text;
        if (!bodyMarkdown.trim()) return json(400, { error: 'Write the email before saving it.' });

        const [org] = await db.select({ name: organisations.name }).from(organisations)
            .where(eq(organisations.id, orgId)).limit(1);

        // ⚠️ The snapshot is rebuilt HERE, at save. The worker never renders from body_markdown, so
        // an edit made while somebody is part way through the series changes what they receive from
        // the NEXT step onward and never rewrites one already sent.
        const rendered = await renderIssueSnapshot({
            bodyMarkdown,
            preheader: String(body.preheader || '').trim().slice(0, 200) || null,
            senderName: org?.name || 'Your business',
        });

        const [step] = await db.insert(newsletterSequenceSteps).values({
            organisationId: orgId,
            sequenceId: sequence.id,
            stepNumber,
            delayDays: Math.max(0, Math.min(90, Number(body.delayDays ?? 0) || 0)),
            subject,
            preheader: String(body.preheader || '').trim().slice(0, 200) || null,
            bodyMarkdown,
            renderedPayload: rendered,
        }).onConflictDoUpdate({
            target: [newsletterSequenceSteps.sequenceId, newsletterSequenceSteps.stepNumber],
            set: {
                delayDays: Math.max(0, Math.min(90, Number(body.delayDays ?? 0) || 0)),
                subject,
                preheader: String(body.preheader || '').trim().slice(0, 200) || null,
                bodyMarkdown,
                renderedPayload: rendered,
                updatedAt: new Date(),
            },
        }).returning();

        return json(200, { step });
    }

    if (action === 'deleteStep') {
        const stepNumber = Number(body.stepNumber || 0);
        await db.delete(newsletterSequenceSteps).where(and(
            eq(newsletterSequenceSteps.sequenceId, sequence.id),
            eq(newsletterSequenceSteps.stepNumber, stepNumber),
        ));
        // Deliberately NOT renumbering the rest. An enrolment records last_step_sent as a NUMBER,
        // so shuffling the numbering underneath somebody mid-series would either re-send them a
        // step or skip one. Gaps are harmless: the worker asks for the next step GREATER than the
        // last one sent, not for a specific number.
        return json(200, { deleted: true });
    }

    if (action === 'enable') {
        if (!ENABLE_ROLES.includes(ctx.role)) {
            return json(403, { error: 'Only an owner or admin can switch the welcome sequence on.' });
        }
        const enable = body.enabled !== false;

        if (enable) {
            const [{ n }] = await db
                .select({ n: sql<number>`count(*)::int` })
                .from(newsletterSequenceSteps)
                .where(and(
                    eq(newsletterSequenceSteps.sequenceId, sequence.id),
                    eq(newsletterSequenceSteps.isEnabled, true),
                ));
            // Enabling an empty sequence would enrol every new subscriber into nothing and complete
            // them immediately — a switch that looks on and does nothing.
            if (!n) return json(400, { error: 'Write at least one email before switching this on.' });
        }

        const [updated] = await db.update(newsletterSequences).set({
            isEnabled: enable,
            enabledAt: enable ? new Date() : null,
            enabledBy: enable ? ctx.userId : null,
            updatedAt: new Date(),
        }).where(eq(newsletterSequences.id, sequence.id)).returning();

        // Say what switching off does NOT do: existing enrolments stop at their next step (the
        // worker re-reads this flag), but nothing already delivered is recalled.
        return json(200, { sequence: updated, note: enable ? null : 'Anyone part way through will not receive the rest.' });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
