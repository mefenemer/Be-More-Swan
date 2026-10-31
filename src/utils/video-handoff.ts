// src/utils/video-handoff.ts
// "Make a video version" — a post hands over to the Video Producer (docs/video-producer-plan.md §5.10,
// Phase 7). The post's own words become the brief; the storyboard lands on the Video Producer's
// Videos tab for the owner to check, exactly like one they asked for. Nothing is made or spent until
// they press "Make the video" there.
//
// Rules, each enforced here rather than hoped for:
//   · Only an ACTIVE Video Producer gets the work (owner, 2026-10-24: never hand off to an unhired
//     or paused assistant). With none, the button is not offered and the server refuses.
//   · ONE live video per post: the partial unique index (db/z-video-producer-phase7.sql) holds it; a
//     second click returns the first video instead of planning another.
//   · A post the Video Producer itself made is already a video — refused by name.
//   · It goes to the post's own platform when that takes a vertical video (Instagram, YouTube,
//     Facebook); otherwise to Instagram, as the Videos tab defaults.

import { and, asc, eq, ne } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, scheduledPosts, videoProjects } from '../../db/schema';
import { VIDEO_PRODUCER_ROLE_KEY } from '../constants/roles';
import { startProject, VIDEO_DESTINATIONS } from './video-producer';

type Db = ReturnType<typeof getDb>;

/**
 * Working, and not paused for any reason — the same rule as teamState() === 'active' in
 * mentor-snapshot.ts, inlined because that module pulls the whole Mentor snapshot into this function. Pure.
 */
export function isWorking(lifecycleStatus: string | null, provisioningStatus: string | null): boolean {
    return lifecycleStatus === 'working' && !String(provisioningStatus ?? '').startsWith('paused');
}

/** The workspace's active Video Producer (the earliest hired, if there are several), or null. */
export async function activeVideoProducer(db: Db, orgId: number): Promise<{ id: number; name: string; onboardingContext: unknown } | null> {
    const rows = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext,
        lifecycleStatus: aiAssistants.lifecycleStatus, provisioningStatus: aiAssistants.provisioningStatus,
    })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.organisationId, orgId), eq(aiAssistants.isActive, true), eq(masterAssistants.roleKey, VIDEO_PRODUCER_ROLE_KEY)))
        .orderBy(asc(aiAssistants.id));
    const a = rows.find((r) => isWorking(r.lifecycleStatus, r.provisioningStatus));
    return a ? { id: a.id, name: a.name, onboardingContext: a.onboardingContext } : null;
}

/** The brief a post hands over. Pure; null when the post has too few words to make a video from. */
export function briefFromPost(post: { caption: string | null; platform: string }): Record<string, unknown> | null {
    const caption = (post.caption ?? '').replace(/\s+/g, ' ').trim();
    if (caption.length < 10) return null;
    const platform = String(post.platform || '').toLowerCase();
    return {
        purpose: 'promo',
        message: `Make a short video version of this post, saying the same thing: ${caption}`.slice(0, 1200),
        platforms: [platform in VIDEO_DESTINATIONS ? platform : 'instagram'],
    };
}

export type HandoffResult =
    | { ok: true; created: boolean; project: typeof videoProjects.$inferSelect; assistantId: number; assistantName: string }
    | { ok: false; status: number; error: string };

/** Hand a post to the Video Producer. Never spends: it starts a free storyboard, or returns the one it already started. */
export async function videoFromPost(db: Db, args: {
    organisationId: number; userId: number; postId: number; headers?: Record<string, string | undefined>;
}): Promise<HandoffResult> {
    const producer = await activeVideoProducer(db, args.organisationId);
    if (!producer) return { ok: false, status: 409, error: 'Hire a Video Producer (or resume yours) to make video versions of your posts.' };

    const [post] = await db.select({ id: scheduledPosts.id, caption: scheduledPosts.caption, platform: scheduledPosts.platform })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.organisationId))).limit(1);
    if (!post) return { ok: false, status: 404, error: 'Post not found.' };

    const [madeHere] = await db.select({ id: videoProjects.id }).from(videoProjects)
        .where(and(eq(videoProjects.organisationId, args.organisationId), eq(videoProjects.scheduledPostId, post.id))).limit(1);
    if (madeHere) return { ok: false, status: 409, error: 'This post is already a video from your Video Producer.' };

    const existing = async () => (await db.select().from(videoProjects)
        .where(and(eq(videoProjects.organisationId, args.organisationId), eq(videoProjects.aiAssistantId, producer.id),
            eq(videoProjects.sourcePostId, post.id), ne(videoProjects.status, 'cancelled'))).limit(1))[0] ?? null;
    const already = await existing();
    if (already) return { ok: true, created: false, project: already, assistantId: producer.id, assistantName: producer.name };

    const brief = briefFromPost(post);
    if (!brief) return { ok: false, status: 400, error: 'This post has too few words to make a video from. Add a caption first.' };

    try {
        const started = await startProject(db, {
            organisationId: args.organisationId, assistantId: producer.id, createdBy: args.userId, brief,
            onboardingContext: producer.onboardingContext, origin: 'handoff', sourcePostId: post.id, headers: args.headers,
        });
        if (!started.ok) return { ok: false, status: 400, error: started.error };
        return { ok: true, created: true, project: started.row, assistantId: producer.id, assistantName: producer.name };
    } catch (err) {
        // Two clicks at once: the unique index let one through — return that one.
        const won = await existing();
        if (won) return { ok: true, created: false, project: won, assistantId: producer.id, assistantName: producer.name };
        throw err;
    }
}
