// netlify/functions/newsletter-issues.ts
// Newsletter Assistant — issue CRUD, drafting, preview and approval. Org-scoped via requireTenant.
// Mirrors netlify/functions/blog-posts.ts, which is the same shape for the long-form surface.
//
//   GET    ?id=<n>                 → one issue, with its resolved audience size
//   GET                            → the org's issues (summary rows)
//   POST   { action: 'create' }    → a new draft
//   POST   { action: 'update' }    → subject / preheader / body / segment
//   POST   { action: 'generate' }  → draft it with the assistant (src/utils/newsletter-generate.ts)
//   POST   { action: 'preview' }   → the rendered email, merged against sample data
//   POST   { action: 'approve' }   → snapshot rendered_payload and move to approved/scheduled
//   POST   { action: 'reject' }    → back to draft, with the reason recorded
//   POST   { action: 'resend' }    → a NEW issue repeating this one to whoever did not open it
//   DELETE ?id=<n>                 → archive (never destroyed)
//
// ⚠️ THE SNAPSHOT IS TAKEN AT APPROVAL, and nothing after that reads body_markdown. A human
// approved a specific set of words; re-rendering at send time would let an edit land mid-send and
// ship two different issues to two halves of one list.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants, audienceContactSegments, audienceContacts, audienceSegments, blogPosts,
    newsletterIssues, organisations,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { generateIssueBody, IssueNotFoundError, scrubMergeTags, NEWSLETTER_DRAFT_REASON } from '../../src/utils/newsletter-generate';
import { renderForRecipient, renderIssueSnapshot } from '../../src/utils/newsletter-render';
import { resendEligibility } from '../../src/utils/newsletter-resend';
import { buildSegmentCondition } from '../../src/utils/audience-segment-rules';
import { loadCustomFieldDefs, loadCustomFieldKeys } from '../../src/utils/audience-custom-fields';
import { linkReportForIssue } from '../../src/utils/newsletter-link-clicks';
import { sampleMergeContext } from '../../src/config/newsletter-merge-vars';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

/** generation_reason on a resend, so the list can label it without a join. */
const RESEND_REASON = 'resend_unopened';

const WRITE_ROLES = ['owner', 'admin', 'member'];
/** Approving an issue is the decision to email real people. Kept with the account's decision-makers. */
const APPROVE_ROLES = ['owner', 'admin'];

const MAX_SUBJECT = 200;
const MAX_BODY = 40000;

/**
 * How many contacts this issue would actually reach.
 *
 * Counts only 'subscribed' contacts in the target segment — the audience-side state. It is
 * deliberately an ESTIMATE and says so: the per-address opt-out and suppression checks run at send
 * time (src/utils/audience-consent.ts), so the real number can only be lower. Presenting this as
 * exact is how "why did only 900 of my 1,400 get it?" becomes a support conversation.
 */
async function estimateAudience(db: ReturnType<typeof getDb>, orgId: number, segmentId: number | null): Promise<number> {
    try {
        if (segmentId) {
            const [segment] = await db
                .select({ kind: audienceSegments.kind, rules: audienceSegments.rules })
                .from(audienceSegments)
                .where(and(eq(audienceSegments.id, segmentId), eq(audienceSegments.organisationId, orgId)))
                .limit(1);

            // A dynamic segment is a rule, not a membership list. Counted through the SAME compiler
            // the send uses — a preview that disagrees with the send is only ever discovered by the
            // recipients. Rules that will not compile count as 0, matching the send's refusal
            // rather than showing a number for an issue that cannot go out.
            if (segment?.kind === 'dynamic') {
                const rule = buildSegmentCondition(orgId, segment.rules);
                if (!rule) return 0;
                const [row] = await db
                    .select({ n: sql<number>`count(*)::int` })
                    .from(audienceContacts)
                    .where(and(
                        eq(audienceContacts.organisationId, orgId),
                        eq(audienceContacts.status, 'subscribed'),
                        rule,
                    ));
                return row?.n ?? 0;
            }

            const [row] = await db
                .select({ n: sql<number>`count(*)::int` })
                .from(audienceContactSegments)
                .innerJoin(audienceContacts, eq(audienceContacts.id, audienceContactSegments.contactId))
                .where(and(
                    eq(audienceContactSegments.segmentId, segmentId),
                    eq(audienceContacts.organisationId, orgId),
                    eq(audienceContacts.status, 'subscribed'),
                ));
            return row?.n ?? 0;
        }
        const [row] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(audienceContacts)
            .where(and(eq(audienceContacts.organisationId, orgId), eq(audienceContacts.status, 'subscribed')));
        return row?.n ?? 0;
    } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } })?.code
            ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code !== '42P01') throw err;
        return 0;
    }
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        const orgId = ctx.organisationId;
        const idParam = event.queryStringParameters?.id;

        if (idParam) {
            const id = Number(idParam);
            if (!Number.isFinite(id)) return json(400, { error: 'Invalid issue id.' });
            const [issue] = await db
                .select()
                .from(newsletterIssues)
                .where(and(eq(newsletterIssues.id, id), eq(newsletterIssues.organisationId, orgId)))
                .limit(1);
            if (!issue) return json(404, { error: 'Issue not found.' });

            // The post this issue was drafted from, when it came from a blog hand-off. Org-scoped
            // again rather than trusted from the issue row: the id is a foreign key we wrote, but
            // reading it back through the tenant filter costs nothing and keeps one rule for
            // every read on this endpoint.
            const [sourcePost] = issue.sourceBlogPostId
                ? await db
                    .select({ id: blogPosts.id, title: blogPosts.title, canonicalUrl: blogPosts.canonicalUrl })
                    .from(blogPosts)
                    .where(and(
                        eq(blogPosts.id, issue.sourceBlogPostId),
                        eq(blogPosts.organisationId, orgId),
                    ))
                    .limit(1)
                : [];

            return json(200, {
                issue,
                sourcePost: sourcePost ?? null,
                // Only for an issue that has been sent — before that there is nothing to report,
                // and an empty "which link worked" table on a draft reads as a broken feature.
                links: issue.sentAt ? await linkReportForIssue(db, orgId, issue.id) : [],
                // Resolved here rather than guessed in the browser, so the button and the server
                // are never offering different answers. Cheap: every refusal but the last two
                // returns before it touches the database.
                resend: await resendEligibility(db, issue),
                audienceEstimate: await estimateAudience(db, orgId, issue.segmentId),
            });
        }

        const assistantIdParam = event.queryStringParameters?.assistantId;
        const filters = [eq(newsletterIssues.organisationId, orgId)];
        if (assistantIdParam && Number.isFinite(Number(assistantIdParam))) {
            filters.push(eq(newsletterIssues.assistantId, Number(assistantIdParam)));
        }

        const issues = await db
            .select({
                id: newsletterIssues.id,
                subject: newsletterIssues.subject,
                preheader: newsletterIssues.preheader,
                status: newsletterIssues.status,
                segmentId: newsletterIssues.segmentId,
                scheduledFor: newsletterIssues.scheduledFor,
                sentAt: newsletterIssues.sentAt,
                recipientCount: newsletterIssues.recipientCount,
                deliveredCount: newsletterIssues.deliveredCount,
                openedCount: newsletterIssues.openedCount,
                isAutonomous: newsletterIssues.isAutonomous,
                generationReason: newsletterIssues.generationReason,
                sourceBlogPostId: newsletterIssues.sourceBlogPostId,
                resendOfIssueId: newsletterIssues.resendOfIssueId,
                updatedAt: newsletterIssues.updatedAt,
            })
            .from(newsletterIssues)
            .where(and(...filters))
            .orderBy(desc(newsletterIssues.updatedAt))
            .limit(500);

        const segments = await db
            .select({ id: audienceSegments.id, name: audienceSegments.name, kind: audienceSegments.kind })
            .from(audienceSegments)
            .where(eq(audienceSegments.organisationId, orgId));

        // The editor's "insert a personalisation tag" menu is built from this — the vocabulary has
        // to come from the server now that part of it is per-organisation.
        return json(200, { issues, segments, customFields: await loadCustomFieldDefs(db, orgId) });
    }

    if (event.httpMethod === 'DELETE') {
        const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
        if ('error' in ctx) return ctx.error;
        const id = Number(event.queryStringParameters?.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid issue id.' });

        // Archive, never destroy — an issue that went out is the record of what subscribers were
        // sent, and `sent` issues are refused outright.
        const [updated] = await db.update(newsletterIssues)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(
                eq(newsletterIssues.id, id),
                eq(newsletterIssues.organisationId, ctx.organisationId),
                inArray(newsletterIssues.status, ['draft', 'pending_approval', 'in_review', 'rejected', 'approved', 'scheduled']),
            ))
            .returning({ id: newsletterIssues.id });
        if (!updated) return json(409, { error: 'Only an unsent issue can be archived.' });
        return json(200, { archived: true });
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
        const assistantId = Number(body.assistantId || '') || null;
        if (assistantId) {
            const [a] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
            if (!a) return json(404, { error: 'Assistant not found.' });
        }
        const subject = String(body.subject || 'Untitled issue').trim().slice(0, MAX_SUBJECT) || 'Untitled issue';
        // Scrubbed on the way in, like every other write path: a chat draft can carry a tag the
        // send worker cannot resolve just as easily as a generated one.
        const bodyMarkdown = 'bodyMarkdown' in body
            ? scrubMergeTags(String(body.bodyMarkdown || '').slice(0, MAX_BODY)).text
            : '';

        // ⚠️ DEDUPE. A stored uiElement re-renders its buttons on every transcript reload, so the
        // chat card's Save can be pressed again next week — and the same conversation scrolled back
        // to twice would otherwise leave two identical issues in the Studio. Matched on exact
        // (subject, body) within the org, the same grain blog-posts uses.
        if (bodyMarkdown) {
            const [existing] = await db
                .select({ id: newsletterIssues.id })
                .from(newsletterIssues)
                .where(and(
                    eq(newsletterIssues.organisationId, orgId),
                    eq(newsletterIssues.subject, subject),
                    eq(newsletterIssues.bodyMarkdown, bodyMarkdown),
                ))
                .limit(1);
            if (existing) return json(200, { issue: existing, deduped: true });
        }

        const [issue] = await db.insert(newsletterIssues).values({
            organisationId: orgId,
            userId: ctx.userId,
            assistantId,
            subject,
            preheader: String(body.preheader || '').trim().slice(0, 200) || null,
            bodyMarkdown,
            segmentId: Number(body.segmentId || '') || null,
            // ⚠️ A body that arrives with the create was written by the assistant, and an issue
            // saved without this marker is indistinguishable from one a human typed. Same rule as
            // blog-posts POST — the AI-provenance stamp is the load-bearing part.
            ...(bodyMarkdown ? { generationReason: NEWSLETTER_DRAFT_REASON } : {}),
        }).returning();
        return json(200, { issue, deduped: false });
    }

    const id = Number(body.id || '');
    if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid issue id.' });

    const [issue] = await db.select()
        .from(newsletterIssues)
        .where(and(eq(newsletterIssues.id, id), eq(newsletterIssues.organisationId, orgId)))
        .limit(1);
    if (!issue) return json(404, { error: 'Issue not found.' });

    // ⚠️ One gate, checked before every mutating action. Once an issue is sending or sent, its
    // words are already in people's inboxes and editing the row would rewrite history — the
    // opposite of what a record of what we sent is for.
    const LOCKED = ['sending', 'sent'];
    // 'resend' is exempt because it CHANGES NOTHING about the sent issue — it creates a new one
    // that repeats it. The lock exists so a record of what went out cannot be rewritten, and a
    // resend does not rewrite it; it is also only ever valid on an issue that has already sent.
    if (LOCKED.includes(issue.status) && action !== 'preview' && action !== 'resend') {
        return json(409, { error: 'This issue has already been sent and can no longer be changed.' });
    }

    if (action === 'resend') {
        // The same gate as approving: a resend is the decision to email real people again.
        if (!APPROVE_ROLES.includes(ctx.role)) {
            return json(403, { error: 'Only an owner or admin can resend an issue.' });
        }

        // ⚠️ Re-checked on the server even though the UI only draws the button when it passes. The
        // count moves on its own — someone opens the email while the tab is open — and the
        // engagement_tracked rule is the difference between a resend and a second unrequested
        // send to the whole list.
        const eligibility = await resendEligibility(db, issue);
        if (!eligibility.canResend) {
            return json(409, { error: eligibility.message, reason: eligibility.reason });
        }

        const subject = String(body.subject || '').trim().slice(0, MAX_SUBJECT) || issue.subject;

        // The APPROVED SNAPSHOT is copied, not rebuilt. These are the exact words a human signed
        // off and that some of the list has already received; re-rendering from body_markdown here
        // would let an intervening edit change what the non-openers get.
        const [resend] = await db.insert(newsletterIssues).values({
            organisationId: orgId,
            userId: ctx.userId,
            assistantId: issue.assistantId,
            subject,
            preheader: issue.preheader,
            bodyMarkdown: issue.bodyMarkdown,
            renderedPayload: issue.renderedPayload,
            // Not the original's segment: the audience is "who did not open", which is already
            // narrower than any segment. See materialiseRecipients.
            segmentId: null,
            resendOfIssueId: issue.id,
            generationReason: RESEND_REASON,
            // Straight to scheduled, now. The confirm dialog named the number of people, and that
            // was the human decision — a second "send now" step here would leave a resend sitting
            // in the list looking as though the button had not worked.
            status: 'scheduled',
            scheduledFor: new Date(),
        }).onConflictDoNothing().returning();

        // The unique index refused it: another admin, or a retried request, got there first.
        if (!resend) {
            return json(409, { error: 'This issue has already been resent once.', reason: 'already_resent' });
        }

        return json(200, { issue: resend, recipients: eligibility.unopened });
    }

    if (action === 'update') {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if ('subject' in body) patch.subject = String(body.subject || '').trim().slice(0, MAX_SUBJECT) || 'Untitled issue';
        if ('preheader' in body) patch.preheader = String(body.preheader || '').trim().slice(0, 200) || null;
        if ('bodyMarkdown' in body) {
            // Scrubbed on the way in as well as at generation: a human can paste a tag the send
            // worker cannot resolve just as easily as a model can invent one.
            // The org's own columns are part of the allowed vocabulary, or pasting a tag the
            // assistant just wrote would strip it back out again.
            const customKeys = await loadCustomFieldKeys(db, orgId);
            patch.bodyMarkdown = scrubMergeTags(String(body.bodyMarkdown || '').slice(0, MAX_BODY), customKeys).text;
        }
        if ('segmentId' in body) {
            const segId = Number(body.segmentId || '');
            if (Number.isFinite(segId) && segId) {
                const [seg] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
                    .where(and(eq(audienceSegments.id, segId), eq(audienceSegments.organisationId, orgId))).limit(1);
                if (!seg) return json(404, { error: 'Segment not found.' });
                patch.segmentId = segId;
            } else patch.segmentId = null;
        }
        if ('scheduledFor' in body) {
            const when = body.scheduledFor ? new Date(body.scheduledFor) : null;
            if (when && Number.isNaN(when.getTime())) return json(400, { error: 'Invalid send date.' });
            patch.scheduledFor = when;
        }
        // Any edit invalidates the approved snapshot: the words a human signed off no longer match
        // the words on file, so the issue goes back to draft rather than silently keeping approval.
        if (['approved', 'scheduled'].includes(issue.status) && ('bodyMarkdown' in body || 'subject' in body)) {
            patch.status = 'draft';
            patch.renderedPayload = null;
        }
        const [updated] = await db.update(newsletterIssues).set(patch)
            .where(and(eq(newsletterIssues.id, id), eq(newsletterIssues.organisationId, orgId)))
            .returning();
        return json(200, { issue: updated, approvalCleared: patch.status === 'draft' });
    }

    if (action === 'generate') {
        try {
            const result = await generateIssueBody(db, {
                issueId: id,
                organisationId: orgId,
                userId: ctx.userId,
                topic: body.topic,
                notes: body.notes,
                tone: body.tone,
            });
            return json(200, result);
        } catch (err) {
            if (err instanceof IssueNotFoundError) return json(404, { error: err.message });
            console.error('[newsletter-issues] draft failed', { orgId, id }, err);
            return json(502, { error: 'The assistant could not draft this issue. Try again in a moment.' });
        }
    }

    if (action === 'preview') {
        const [org] = await db.select({ name: organisations.name }).from(organisations)
            .where(eq(organisations.id, orgId)).limit(1);
        const senderName = org?.name || 'Your business';
        const snapshot = await renderIssueSnapshot({
            bodyMarkdown: issue.bodyMarkdown,
            preheader: issue.preheader,
            senderName,
        });
        // Rendered against SAMPLE data, and the footer is included — the reviewer should see the
        // email a subscriber sees, unsubscribe line and all, not a fragment of it.
        const merged = renderForRecipient({
            snapshot,
            contact: {
                firstName: 'Jane', lastName: 'Okafor', company: 'Acme Ltd', email: 'jane@example.com',
                // The field's own LABEL as its sample value, so an author can see which field
                // landed where. A made-up "Bristol" would not tell them that.
                customFields: Object.fromEntries((await loadCustomFieldDefs(db, orgId)).map((f) => [f.key, f.label])),
            },
            senderName,
            unsubscribeUrl: '#preview-unsubscribe',
            postalAddress: body.postalAddress ?? null,
        });
        const previewFields = await loadCustomFieldDefs(db, orgId);
        return json(200, {
            html: merged.html,
            text: merged.text,
            sampleContext: sampleMergeContext(senderName, previewFields),
        });
    }

    if (action === 'approve') {
        if (!APPROVE_ROLES.includes(ctx.role)) {
            return json(403, { error: 'Only an owner or admin can approve an issue for sending.' });
        }
        if (!issue.bodyMarkdown.trim()) return json(400, { error: 'There is nothing to send yet — draft the issue first.' });

        const [org] = await db.select({ name: organisations.name }).from(organisations)
            .where(eq(organisations.id, orgId)).limit(1);

        const snapshot = await renderIssueSnapshot({
            bodyMarkdown: issue.bodyMarkdown,
            preheader: issue.preheader,
            senderName: org?.name || 'Your business',
        });

        const when = body.scheduledFor ? new Date(body.scheduledFor) : issue.scheduledFor;
        if (when && Number.isNaN(when.getTime())) return json(400, { error: 'Invalid send date.' });

        const [updated] = await db.update(newsletterIssues).set({
            renderedPayload: snapshot,
            status: when ? 'scheduled' : 'approved',
            scheduledFor: when ?? null,
            ownerId: ctx.userId,
            updatedAt: new Date(),
        }).where(and(eq(newsletterIssues.id, id), eq(newsletterIssues.organisationId, orgId)))
            .returning();

        return json(200, {
            issue: updated,
            audienceEstimate: await estimateAudience(db, orgId, updated.segmentId),
        });
    }

    if (action === 'send') {
        // "Send now" — approval already happened; this only makes it due. The worker is the only
        // thing that sends, so there is one code path whether an issue was scheduled or sent by
        // hand, and one place where consent is re-checked.
        if (!APPROVE_ROLES.includes(ctx.role)) {
            return json(403, { error: 'Only an owner or admin can send an issue.' });
        }
        if (!['approved', 'scheduled'].includes(issue.status)) {
            return json(409, { error: 'Approve the issue before sending it.' });
        }
        if (!issue.renderedPayload) {
            return json(409, { error: 'This issue needs approving again before it can be sent.' });
        }
        const [updated] = await db.update(newsletterIssues).set({
            status: 'scheduled',
            scheduledFor: new Date(),
            failureReason: null,
            updatedAt: new Date(),
        }).where(and(
            eq(newsletterIssues.id, id),
            eq(newsletterIssues.organisationId, orgId),
            inArray(newsletterIssues.status, ['approved', 'scheduled']),
        )).returning();
        if (!updated) return json(409, { error: 'This issue is no longer ready to send.' });
        // Picked up by process-newsletter-sends within the next tick (*/5).
        return json(200, { issue: updated, queued: true });
    }

    if (action === 'reject') {
        const [updated] = await db.update(newsletterIssues).set({
            status: 'draft',
            renderedPayload: null,
            generationReason: issue.generationReason,
            updatedAt: new Date(),
        }).where(and(eq(newsletterIssues.id, id), eq(newsletterIssues.organisationId, orgId)))
            .returning({ id: newsletterIssues.id });
        if (!updated) return json(404, { error: 'Issue not found.' });
        return json(200, { issue: updated, status: 'draft' });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
