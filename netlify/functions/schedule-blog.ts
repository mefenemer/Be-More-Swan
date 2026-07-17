// netlify/functions/schedule-blog.ts
// Autonomous Content Engine — US 4.1: schedule a blog post to auto-publish at a future time,
// or clear an existing schedule. The publish-blog-posts cron publishes due 'scheduled' posts.
// Org-scoped via requireTenant.
//
// POST { id, publishDate }          → status 'scheduled', publish_date set (must be a future time)
// POST { id, action:'approve' }     → cadence auto-schedule: the post's Blog Writer picks the next
//                                     free slot of its posting cadence (no manual date) → 'scheduled'
// POST { id, action:'unschedule' }  → status back to 'draft', publish_date cleared
//   →  { post: { id, status, publishDate } }
//
// No action here applies to a published post — it is live and possibly mirrored externally, so
// every path 409s on status 'published' (mirrors blog-posts.ts's delete guard).

import { HandlerEvent } from '@netlify/functions';
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolvePostingSchedule, computeScheduleSlots } from '../../src/config/posting-cadence';
import { withLambda } from '@netlify/aws-lambda-compat';

type Db = ReturnType<typeof getDb>;
const DAY_MS = 24 * 60 * 60 * 1000;

// Cadence auto-scheduling on approval: the Blog Writer "picks the post up" and schedules it into the
// next free slot of its posting cadence (onboarding_context.posting_frequency + draft_horizon_days),
// skipping slots already taken by its other active posts. Mirrors approve-post.ts's pickOptimalSlot.
// Falls back to the post's own future date, else now+24h, when the cadence is on-demand (no slots).
async function pickCadenceSlot(
    db: Db,
    orgId: number,
    post: { id: number; assistantId: number | null; publishDate: Date | null },
    now: Date,
): Promise<Date> {
    let ctx: Record<string, unknown> = {};
    let horizonDays = 14;
    if (post.assistantId != null) {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, draftHorizonDays: aiAssistants.draftHorizonDays })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, post.assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (assistant) {
            ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};
            horizonDays = Number(ctx.draft_horizon_days) || assistant.draftHorizonDays || 14;
        }
    }

    const slots = computeScheduleSlots({ schedule: resolvePostingSchedule(ctx), horizonDays, now });
    if (!slots.length) {
        // On-demand cadence: honour a future manual date, else default to tomorrow.
        return post.publishDate && post.publishDate.getTime() > now.getTime()
            ? post.publishDate : new Date(now.getTime() + DAY_MS);
    }

    // Skip slots already occupied by this org's other active blog posts.
    const windowEnd = slots[slots.length - 1];
    const taken = await db
        .select({ publishDate: blogPosts.publishDate })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.organisationId, orgId),
            ne(blogPosts.id, post.id),
            gte(blogPosts.publishDate, now),
            lte(blogPosts.publishDate, windowEnd),
            sql`status IN ('pending_approval','in_review','approved','scheduled','publishing')`,
        ));
    const takenMs = new Set(taken.map(r => new Date(r.publishDate as unknown as string).getTime()));
    return slots.find(s => !takenMs.has(s.getTime())) ?? slots[0];
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const id = Number(body.id);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    const [post] = await db
        .select({
            id: blogPosts.id, status: blogPosts.status, bodyMarkdown: blogPosts.bodyMarkdown,
            assistantId: blogPosts.assistantId, publishDate: blogPosts.publishDate,
        })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    // A published post is live on the user's site (widget-api serves status='published') and may
    // already be mirrored to external destinations, so no action here may move it off 'published'.
    if (post.status === 'published') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This post is published. Unpublish it before rescheduling.' }) };
    }

    // Clear an existing schedule → return to draft.
    if (body.action === 'unschedule') {
        const [updated] = await db.update(blogPosts)
            .set({ status: 'draft', publishDate: null, updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
            .returning({ id: blogPosts.id, status: blogPosts.status, publishDate: blogPosts.publishDate });
        return { statusCode: 200, body: JSON.stringify({ post: updated }) };
    }

    // Guard shared by both scheduling paths.
    if (!post.bodyMarkdown || !post.bodyMarkdown.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot schedule an empty post.' }) };
    }

    // Approve & schedule → the assistant picks the next free cadence slot (no manual date).
    if (body.action === 'approve') {
        const when = await pickCadenceSlot(db, ctx.organisationId, post, new Date());
        const [updated] = await db.update(blogPosts)
            .set({ status: 'scheduled', publishDate: when, updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
            .returning({ id: blogPosts.id, status: blogPosts.status, publishDate: blogPosts.publishDate });
        return { statusCode: 200, body: JSON.stringify({ post: updated }) };
    }

    // Manual schedule → validate a future date.
    const when = new Date(body.publishDate);
    if (Number.isNaN(when.getTime())) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid publishDate is required.' }) };
    }
    if (when.getTime() <= Date.now()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'publishDate must be in the future.' }) };
    }

    const [updated] = await db.update(blogPosts)
        .set({ status: 'scheduled', publishDate: when, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .returning({ id: blogPosts.id, status: blogPosts.status, publishDate: blogPosts.publishDate });

    return { statusCode: 200, body: JSON.stringify({ post: updated }) };
});
