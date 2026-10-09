// netlify/functions/draft-newsletter-issues.ts
// Newsletter autopilot: draft the next issue for every Email Marketing Assistant on a cadence, and leave
// it waiting for a human. Scheduled daily — see netlify.toml.
//
// ⚠️ IT DRAFTS. IT NEVER SENDS. Nothing here touches newsletter_sends or moves an issue past
// 'pending_approval'; process-newsletter-sends only ever picks up an issue a person approved. The
// separation is the product promise — "you approve every issue" is a claim in the catalogue copy,
// so it has to be structurally true rather than a policy someone could relax later.
//
// ── Two rules that keep this from becoming a nuisance ───────────────────────────────────────────
// 1. NEVER MORE THAN ONE UNAPPROVED DRAFT. If last week's issue is still sitting in the review
//    queue, this week's is not written. A tenant who goes on holiday should come back to one draft
//    and a clear decision, not eight and a cleanup job. (The blank-draft sweep that had to be built
//    for the blog pipeline is the version of this problem solved after the fact.)
// 2. ONE DRAFT PER CADENCE PERIOD, measured from the last issue this assistant CREATED — not from
//    the last one sent. Measuring from sends would draft continuously for anyone who drafts and
//    never sends, which is precisely the tenant this feature is meant to help.

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, newsletterIssues } from '../../db/schema';
import { generateIssueBody } from '../../src/utils/newsletter-generate';
import { createNotification } from '../../src/utils/notify';
import { postsPerWeekFor } from '../../src/config/posting-cadence';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Statuses that mean "a human still owes this issue a decision". */
const AWAITING_HUMAN = ['draft', 'pending_approval', 'in_review'];

/** Bounded so one tick cannot run away; the cron is daily and a backlog is not urgent. */
const MAX_PER_RUN = 20;

export default withLambda(async () => {
    const db = getDb();
    const now = new Date();
    const out = { considered: 0, drafted: 0, skipped: 0, failed: 0, reasons: {} as Record<string, number> };
    const note = (reason: string) => { out.reasons[reason] = (out.reasons[reason] ?? 0) + 1; out.skipped++; };

    let assistants;
    try {
        assistants = await db
            .select({
                id: aiAssistants.id,
                organisationId: aiAssistants.organisationId,
                userId: aiAssistants.userId,
                name: aiAssistants.name,
                onboardingContext: aiAssistants.onboardingContext,
            })
            .from(aiAssistants)
            .where(and(
                sql`(${aiAssistants.configuration} ->> 'type') = 'newsletter_editor'`,
                ne(aiAssistants.lifecycleStatus, 'archived'),
                sql`(${aiAssistants.provisioningStatus} IS NULL OR ${aiAssistants.provisioningStatus} NOT IN ('pending','failed','blocked'))`,
            ))
            .limit(MAX_PER_RUN);
    } catch (err) {
        console.error('[draft-newsletter-issues] could not list assistants', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'lookup failed' }) };
    }

    for (const a of assistants) {
        out.considered++;
        const actx = (a.onboardingContext as Record<string, unknown> | null) ?? {};
        const perWeek = postsPerWeekFor(actx.posting_frequency);

        // 0 = "On demand" — the user said they start each issue themselves, and honouring that is
        // the whole difference between an assistant and spam.
        if (!perWeek) { note('on_demand'); continue; }

        // "Day you usually send" (setup: newsletterSendDay — "only used to time the draft so it is
        // ready before you need it"). It was asked at hire and read by NOTHING: drafts arrived on
        // whatever day the cadence clock happened to land. For a weekly-or-slower cadence the draft
        // is now written one or two days ahead of that day; more often than weekly, the send day
        // means nothing and is ignored.
        if (perWeek <= 1 && !isDraftDayForSend(now, actx.newsletterSendDay)) { note('not_draft_day'); continue; }

        try {
            const [outstanding] = await db
                .select({ id: newsletterIssues.id })
                .from(newsletterIssues)
                .where(and(
                    eq(newsletterIssues.assistantId, a.id),
                    eq(newsletterIssues.organisationId, a.organisationId),
                    inArray(newsletterIssues.status, AWAITING_HUMAN),
                ))
                .limit(1);
            if (outstanding) { note('draft_already_waiting'); continue; }

            const [latest] = await db
                .select({ createdAt: newsletterIssues.createdAt })
                .from(newsletterIssues)
                .where(and(
                    eq(newsletterIssues.assistantId, a.id),
                    eq(newsletterIssues.organisationId, a.organisationId),
                ))
                .orderBy(desc(newsletterIssues.createdAt))
                .limit(1);

            // A whole cadence period, minus a few hours of slack so a daily cron running at a
            // slightly later minute each week cannot drift a weekly issue into a fortnightly one.
            const periodMs = (7 / perWeek) * 24 * 60 * 60 * 1000 - (6 * 60 * 60 * 1000);
            if (latest?.createdAt && now.getTime() - latest.createdAt.getTime() < periodMs) {
                note('too_soon');
                continue;
            }

            const [issue] = await db.insert(newsletterIssues).values({
                organisationId: a.organisationId,
                userId: a.userId,
                assistantId: a.id,
                subject: 'Untitled email',
                isAutonomous: true,
                // Stamped BEFORE drafting so generateIssueBody's COALESCE keeps this more specific
                // reason rather than overwriting it with the generic assistant_draft marker.
                generationReason: 'newsletter_autopilot',
                status: 'draft',
            }).returning({ id: newsletterIssues.id });

            const topic = typeof actx.newsletterTopics === 'string' ? actx.newsletterTopics : '';
            await generateIssueBody(db, {
                issueId: issue.id,
                organisationId: a.organisationId,
                userId: a.userId,
                topic,
                notes: typeof actx.newsletterAudience === 'string' ? `Who this is for: ${actx.newsletterAudience}` : '',
            });

            // Waiting for a person, explicitly — not left as a bare 'draft' that looks like
            // something the user started and abandoned.
            //
            // The subject comes back from the UPDATE rather than a second read: generateIssueBody
            // wrote it a moment ago, and re-selecting would be a second round trip to learn
            // something this statement can return.
            const [ready] = await db.update(newsletterIssues)
                .set({ status: 'pending_approval', updatedAt: new Date() })
                .where(eq(newsletterIssues.id, issue.id))
                .returning({ subject: newsletterIssues.subject });

            // ⚠️ THE POINT OF THE WHOLE CRON. Nothing here sends, so an issue nobody is told about
            // is an issue nobody approves — this function drafted in complete silence until
            // 2026-08-23 while the preferences matrix already offered toggles for it.
            // Non-fatal by design, exactly as process-blog-jobs treats blog_draft_ready: a
            // notification failing must not roll back a draft that was written successfully.
            await createNotification(db, 'newsletter_issue_ready', {
                userId: a.userId,
                assistantId: a.id,
                // Explicit so the stored column is right without db/notifications-categorization.sql
                // having been re-applied; the DB trigger only stamps when this is NULL.
                category: 'state_change',
                context: { assistant: { name: a.name }, issue: { subject: ready?.subject || 'Untitled email' } },
                metadata: { assistantId: a.id, newsletterIssueId: issue.id },
            }).catch(err => console.error('[draft-newsletter-issues] notification failed', err));

            out.drafted++;
        } catch (err) {
            out.failed++;
            console.error('[draft-newsletter-issues] assistant failed', { assistantId: a.id }, err);
        }
    }

    // One line per tick, so a schedule that has silently stopped firing is visible in the log.
    console.log('[draft-newsletter-issues]', JSON.stringify(out));
    return { statusCode: 200, body: JSON.stringify(out) };
});

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Is today a good day to draft for an email the user sends on `sendDay`? One or two days before it
 * (UTC), so the draft is waiting, reviewable, before the day it goes out. No send day set — or one
 * we cannot read — means "any day", exactly as before the question was honoured.
 */
export function isDraftDayForSend(now: Date, sendDay: unknown): boolean {
    const target = typeof sendDay === 'string' ? WEEKDAYS.indexOf(sendDay) : -1;
    if (target === -1) return true;
    const ahead = (target - now.getUTCDay() + 7) % 7;
    return ahead === 1 || ahead === 2;
}
