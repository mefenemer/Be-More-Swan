// netlify/functions/get-newsletter-performance.ts
// The four Overview KPI cards for a Newsletter Assistant. Routed here by
// `metricsSource: 'newsletter'` in src/components/assistant-dashboard-registry.js.
//
// ⚠️ WHY THIS EXISTS AT ALL. Without a metricsSource the role falls through to
// get-assistant-performance, which reads Instagram post_insights — a table a Newsletter Assistant
// never writes to. The cards would sit at "no data" for ever while the labels above them promised
// figures from a completely different product surface. The Blog Writer shipped in exactly that
// state for months.
//
// ⚠️ OPENS AND CLICKS ARE COMPUTED OVER TRACKED ISSUES ONLY. An issue sent from a tenant's own
// mailbox embeds no pixel and rewrites no links, so it can report neither — folding those sends
// into the denominator would drag the rate down in proportion to how many issues we could not
// measure, which reads as failing content when it is missing instrumentation. Issues where
// engagement_tracked = false are excluded, and `engagementMeasurable` tells the UI whether there
// was anything to measure at all.
//
// ⚠️ AN OPEN IS NOT A READ. It is a 1×1 image, and Apple Mail Privacy Protection pre-fetches it
// whether or not a human looks. The card copy says "indicative" for that reason.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContacts, newsletterIssues } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

/** Missing tables mean the feature is not applied here — report "no data", never a 500 on a card. */
function isMissingTable(err: unknown): boolean {
    const pg = err as { code?: string; cause?: { code?: string } };
    return (pg?.code ?? pg?.cause?.code) === '42P01';
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const assistantIdParam = event.queryStringParameters?.assistantId;
    const assistantId = assistantIdParam && Number.isFinite(Number(assistantIdParam)) ? Number(assistantIdParam) : null;

    try {
        // The audience is ORG-wide, not per-assistant, and the card says "shared with every
        // assistant you hire" for that reason. Scoping it to one assistant would report a smaller
        // number than the send will actually reach.
        const [audience] = await db
            .select({ subscribers: sql<number>`count(*)::int` })
            .from(audienceContacts)
            .where(and(eq(audienceContacts.organisationId, orgId), eq(audienceContacts.status, 'subscribed')));

        const issueFilters = [eq(newsletterIssues.organisationId, orgId), eq(newsletterIssues.status, 'sent')];
        if (assistantId) issueFilters.push(eq(newsletterIssues.assistantId, assistantId));

        const [totals] = await db
            .select({
                issuesSent: sql<number>`count(*)::int`,
                recipients: sql<number>`COALESCE(SUM(${newsletterIssues.recipientCount}), 0)::int`,
                delivered: sql<number>`COALESCE(SUM(${newsletterIssues.deliveredCount}), 0)::int`,
                unsubscribed: sql<number>`COALESCE(SUM(${newsletterIssues.unsubscribedCount}), 0)::int`,
                complained: sql<number>`COALESCE(SUM(${newsletterIssues.complainedCount}), 0)::int`,
                // Engagement sums and their OWN denominator, restricted to issues that could be
                // measured. FILTER, not a second query: one pass, and the two denominators can
                // never drift apart the way they would if a later edit touched only one of them.
                trackedIssues: sql<number>`count(*) FILTER (WHERE ${newsletterIssues.engagementTracked})::int`,
                trackedRecipients: sql<number>`COALESCE(SUM(${newsletterIssues.recipientCount}) FILTER (WHERE ${newsletterIssues.engagementTracked}), 0)::int`,
                opened: sql<number>`COALESCE(SUM(${newsletterIssues.openedCount}) FILTER (WHERE ${newsletterIssues.engagementTracked}), 0)::int`,
                clicked: sql<number>`COALESCE(SUM(${newsletterIssues.clickedCount}) FILTER (WHERE ${newsletterIssues.engagementTracked}), 0)::int`,
            })
            .from(newsletterIssues)
            .where(and(...issueFilters));

        const [last] = await db
            .select({
                subject: newsletterIssues.subject,
                sentAt: newsletterIssues.sentAt,
                recipientCount: newsletterIssues.recipientCount,
                deliveredCount: newsletterIssues.deliveredCount,
                unsubscribedCount: newsletterIssues.unsubscribedCount,
            })
            .from(newsletterIssues)
            .where(and(...issueFilters))
            .orderBy(desc(newsletterIssues.sentAt))
            .limit(1);

        const recipients = totals?.recipients ?? 0;
        const delivered = totals?.delivered ?? 0;

        // ⚠️ THE HONEST NULL. Delivery counts come from the provider webhook. If it has never been
        // configured, every issue reports delivered = 0 — which as a percentage renders "0%" and
        // reads as catastrophic deliverability rather than as "we are not being told". Distinguish
        // the two: no delivery events at all across a list that definitely received mail is
        // unknown, not zero.
        const deliveryUnknown = recipients > 0 && delivered === 0;
        const deliveryRate = recipients > 0 && !deliveryUnknown ? delivered / recipients : null;

        const lastRecipients = last?.recipientCount ?? 0;
        const unsubscribeRate = lastRecipients > 0 ? (last?.unsubscribedCount ?? 0) / lastRecipients : null;

        // The denominator is recipients of TRACKED issues, and both rates are null when there is
        // nothing measurable — never 0%, which would read as "nobody opened it".
        const trackedRecipients = totals?.trackedRecipients ?? 0;
        const engagementMeasurable = (totals?.trackedIssues ?? 0) > 0 && trackedRecipients > 0;
        const openRate = engagementMeasurable ? (totals?.opened ?? 0) / trackedRecipients : null;
        const clickRate = engagementMeasurable ? (totals?.clicked ?? 0) / trackedRecipients : null;

        return json(200, {
            hasData: (totals?.issuesSent ?? 0) > 0 || (audience?.subscribers ?? 0) > 0,
            subscribers: audience?.subscribers ?? 0,
            issuesSent: totals?.issuesSent ?? 0,
            deliveryRate,
            deliveryUnknown,
            unsubscribeRate,
            openRate,
            clickRate,
            engagementMeasurable,
            trackedIssues: totals?.trackedIssues ?? 0,
            complained: totals?.complained ?? 0,
            lastIssue: last ? { subject: last.subject, sentAt: last.sentAt, recipients: lastRecipients } : null,
        });
    } catch (err) {
        if (isMissingTable(err)) {
            return json(200, { hasData: false, needsSetup: true, subscribers: 0, issuesSent: 0, deliveryRate: null, unsubscribeRate: null, openRate: null, clickRate: null, engagementMeasurable: false });
        }
        console.error('[get-newsletter-performance] failed', { orgId }, err);
        return json(500, { error: 'Could not load newsletter performance.' });
    }
});
