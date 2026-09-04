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
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolvePostingSchedule, computeScheduleSlots, resolveHorizonDays, intervalHoursFor, DEFAULT_HORIZON_DAYS, MAX_HORIZON_DAYS } from '../../src/config/posting-cadence';
import { withLambda } from '@netlify/aws-lambda-compat';

type Db = ReturnType<typeof getDb>;
const DAY_MS = 24 * 60 * 60 * 1000;

// Cadence auto-scheduling on approval: the Blog Writer "picks the post up" and schedules it into the
// next free slot of its posting cadence (onboarding_context.posting_frequency for the cadence, the
// ai_assistants.draft_horizon_days COLUMN for the window — see DEFAULT_HORIZON_DAYS for why the
// jsonb key of the same name must not be read),
// skipping slots already taken by its other active posts. Mirrors approve-post.ts's pickOptimalSlot.
// Falls back to the post's own future date, else now+24h, when the cadence is on-demand (no slots).
//
// Exported for tests/blog-approve-slot-collision.test.ts only — the collision this function used to
// produce (two approvals, one instant) is behaviour, not text, so the test drives it against a stub
// db rather than scanning the source for a fixed phrase.
export async function pickCadenceSlot(
    db: Db,
    orgId: number,
    post: { id: number; assistantId: number | null; publishDate: Date | null },
    now: Date,
): Promise<Date> {
    let ctx: Record<string, unknown> = {};
    let horizonDays = DEFAULT_HORIZON_DAYS;
    if (post.assistantId != null) {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, draftHorizonDays: aiAssistants.draftHorizonDays })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, post.assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (assistant) {
            ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};
            // The COLUMN is the one source of truth for the horizon — same read as approve-post.ts's
            // pickOptimalSlot, blog-gap-fill and schedule-gap-fill. This line used to prefer
            // `onboarding_context.draft_horizon_days` and fall back to 14, which made it the only
            // reader in the codebase disagreeing with the other four. The two stores drift by
            // design: the onboarding wizard writes the jsonb answer while set-draft-horizon.ts
            // writes the column, and nothing synced them — on staging assistant 23 that was jsonb
            // "30" against column 7. Approve then scheduled into a 30-day window that gap-fill only
            // ever filled to 7 days, so slots past day 7 were never treated as covered.
            horizonDays = resolveHorizonDays(assistant);
        }
    }

    const schedule = resolvePostingSchedule(ctx);
    // Look BEYOND the draft horizon when hunting for a free slot — same widening as approve-post.ts.
    // The horizon governs how far ahead the assistant pre-DRAFTS; it must not cap where an approved
    // post may land. A weekly Blog Writer on the default 7-day horizon has exactly ONE slot in the
    // window, so searching only the horizon meant the second approval of the day had nowhere to go.
    // computeScheduleSlots caps horizon at 30 days internally.
    const searchDays = Math.min(MAX_HORIZON_DAYS, Math.max(horizonDays, horizonDays * 3, 14));
    const slots = computeScheduleSlots({ schedule, horizonDays: searchDays, now });
    if (!slots.length) {
        // On-demand cadence: honour a future manual date, else default to tomorrow.
        return post.publishDate && post.publishDate.getTime() > now.getTime()
            ? post.publishDate : new Date(now.getTime() + DAY_MS);
    }

    // Slots already occupied by this org's other active blog posts.
    //
    // Deliberately NOT capped at the last slot of the window. The overflow branch below hunts for a
    // free instant PAST it, and bounding this query by windowEnd made every one of those candidates
    // look unoccupied. 'draft' is included so the statuses match blog-gap-fill's coverage query: a
    // draft sitting on a future slot is holding it (a chat-saved draft has no publish_date at all,
    // so it is excluded by the `gte` and cannot block anything).
    const taken = await db
        .select({ publishDate: blogPosts.publishDate })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.organisationId, orgId),
            ne(blogPosts.id, post.id),
            gte(blogPosts.publishDate, now),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled','publishing')`,
        ));
    const takenMs = new Set(taken.map(r => new Date(r.publishDate as unknown as string).getTime()));

    // Keep the slot it is already on, when that is a real future cadence slot and nothing else has
    // claimed it. Autopilot drafts are CREATED on a cadence slot (process-blog-jobs stamps the job's
    // target_publish_date onto the post), so rehoming them to the earliest opening is not scheduling
    // — it is churn, and with two posts approved back to back it is what collapsed both onto one
    // date. A past date, or a hand-picked time that is not a cadence slot, still falls through and
    // gets rehomed.
    const ownMs = post.publishDate ? new Date(post.publishDate).getTime() : NaN;
    if (Number.isFinite(ownMs)
        && ownMs > now.getTime()
        && slots.some(s => s.getTime() === ownMs)
        && !takenMs.has(ownMs)) {
        return new Date(ownMs);
    }

    const free = slots.find(s => !takenMs.has(s.getTime()));
    if (free) return free;

    // Every slot in the search window is occupied, so this post has to go past the end of it. Roll
    // the SAME slot machinery forward rather than doing arithmetic on the last slot: real slots
    // respect the assistant's posting days, times and timezone (including DST). This is where the
    // old code gave up and returned slots[0] — the first slot of the window, which is exactly the
    // instant the previous approval had just taken.
    let cursor = slots[slots.length - 1];
    for (let round = 0; round < 6; round++) {
        const next = computeScheduleSlots({ schedule, horizonDays: searchDays, now: cursor });
        if (!next.length) break;
        const nextFree = next.find(s => s.getTime() > cursor.getTime() && !takenMs.has(s.getTime()));
        if (nextFree) return nextFree;
        const last = next[next.length - 1];
        if (last.getTime() <= cursor.getTime()) break;   // no forward progress; don't spin
        cursor = last;
    }

    // Roughly six months out and every slot still taken. Step by the cadence interval so the
    // function always returns something schedulable; in practice unreachable.
    const stepHours = intervalHoursFor(schedule.frequency) ?? 24;
    let candidate = new Date(cursor.getTime() + stepHours * 3600 * 1000);
    for (let guard = 0; guard < 60 && takenMs.has(candidate.getTime()); guard++) {
        candidate = new Date(candidate.getTime() + stepHours * 3600 * 1000);
    }
    return candidate;
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
