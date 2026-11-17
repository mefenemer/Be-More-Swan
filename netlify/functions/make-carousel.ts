// netlify/functions/make-carousel.ts
// "Make it a carousel" — Top lists Phase 2 (docs/top-lists-plan.md §6; owner decisions 3 and 4,
// 2026-11-15: on request only, one task per carousel).
//
// POST { postId } → { ok, slides: [{ assetId, url, kind }], postIds, formats: { [postId]: formatKey } }
//   Auth: aura_session (requireTenant). The post must be this org's, still editable, on Instagram,
//   Threads or LinkedIn, and its caption must hold a numbered list of at least 2 items.
//
// ── What it does ──────────────────────────────────────────────────────────────────────────────────
// Reads the numbered items already in the caption (top-lists.ts carouselSlideTexts — no AI call,
// so a slide can never say something the post doesn't), renders a cover brand card plus one card
// per item, attaches them as the post's slides and switches the row to its platform's carousel
// format. The caption is left as it is: it still carries the full list for anyone who reads it.
//
// ── Which rows ────────────────────────────────────────────────────────────────────────────────────
// A cross-post is one post on several platforms. The carousel goes on every row of the group whose
// platform has a live carousel format (Instagram, Threads, LinkedIn) and that can still change —
// never on Facebook or X, whose feed formats take one picture. The cards are rendered once at 4:5,
// which all three accept, and shared. LinkedIn's row gets the same slide images with `li_document`;
// the publisher turns them into one PDF when it posts (publishLinkedInDocument, social-publish.ts).
//
// ── Cost ──────────────────────────────────────────────────────────────────────────────────────────
// One `carousel` task per press, however many slides or platform rows (decision 4). Asked before
// rendering, recorded after the slides are saved — the work-metering order (tests/work-metering).
//
// The same action backs the chat's `carousel` post action (src/utils/chat-post-action.ts), whose card
// calls this endpoint — one server action for GUI and chat.

import { and, eq, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isMediaEditable } from '../../src/config/post-status';
import { resolveBrandKitForOrg } from '../../src/lib/brand-extract-fetch';
import { renderAndPersistBrandCard } from '../../src/lib/media-persist';
import { resolvePostMediaList } from '../../src/utils/social-publish';
import { writePostSlides } from '../../src/utils/post-slides';
import { carouselFormatFor, carouselSlideTexts } from '../../src/utils/top-lists';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from '../../src/utils/work-metering';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Every live carousel format accepts 4:5 (post-formats.ts), and it is the taller, better-read one. */
const CAROUSEL_ASPECT = '4:5' as const;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { postId?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }
    const postId = Number(body.postId);
    if (!Number.isInteger(postId) || postId <= 0) return json(400, { error: 'postId required.' });

    const [post] = await db
        .select({
            id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform,
            caption: scheduledPosts.caption, crosspostGroupId: scheduledPosts.crosspostGroupId,
            assistantId: scheduledPosts.assistantId,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    // Every row of the cross-post that can carry a carousel and can still change.
    const group = post.crosspostGroupId
        ? await db.select({ id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, orgId),
                or(eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId), eq(scheduledPosts.id, post.id)),
            ))
        : [{ id: post.id, status: post.status, platform: post.platform }];
    const targets = group.filter((r) => carouselFormatFor(r.platform) && isMediaEditable(r.status));
    if (!targets.length) {
        const onCarouselPlatform = group.some((r) => carouselFormatFor(r.platform));
        return json(422, {
            error: onCarouselPlatform
                ? 'This post has already gone out, so it can’t become a carousel now.'
                : 'Carousels are made for Instagram, Threads and LinkedIn. Add one of those to this post first.',
        });
    }

    const texts = carouselSlideTexts(String(post.caption ?? ''));
    if (!texts) {
        return json(422, { error: 'This post has no numbered list to turn into slides. A carousel needs at least 2 numbered items in the caption ("1. …", "2. …").' });
    }

    if (!await hasTaskCapacity(db, orgId)) return json(402, { error: TASK_LIMIT_MESSAGE });

    const [kit, [org]] = await Promise.all([
        resolveBrandKitForOrg(db, orgId, new Date()),
        db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
    ]);

    // One after another, not all at once: each render holds a canvas in memory, and a 10-item list
    // rendered in parallel is the one way this could run out. Seeded by the post id plus the slide's
    // place, so the cover and items alternate light/bold like consecutive posts do.
    const words = [texts.cover, ...texts.items];
    const assetIds: number[] = [];
    try {
        for (let i = 0; i < words.length; i++) {
            assetIds.push(await renderAndPersistBrandCard(db, {
                orgId, userId, headline: words[i], kit, aspectRatio: CAROUSEL_ASPECT,
                seed: post.id + i, orgName: org?.name ?? null,
            }));
        }
    } catch (err) {
        console.error('[make-carousel] slide render failed', { postId, slide: assetIds.length, message: err instanceof Error ? err.message : String(err) });
        return json(502, { error: 'The slides couldn’t be made just now, so nothing was changed. Please try again.' });
    }

    // Slides and format in the same row update, per platform, so a row is never a carousel format
    // with one picture or a feed post with ten.
    const formats: Record<number, string> = {};
    for (const t of targets) {
        const formatKey = carouselFormatFor(t.platform)!;
        await writePostSlides(db, [t.id], assetIds, { formatKey });
        formats[t.id] = formatKey;
    }

    await recordCompletedWork(db, orgId, 'carousel', { ref: post.id, assistantId: post.assistantId ?? null });

    const slides = await resolvePostMediaList(db, assetIds);
    return json(200, {
        ok: true,
        slides: slides.map(s => ({ assetId: s.assetId, url: s.url, kind: s.kind })),
        postIds: targets.map((t) => t.id),
        formats,
        slideCount: assetIds.length,
    });
});
