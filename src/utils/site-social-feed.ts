// src/utils/site-social-feed.ts
// The `social_feed` website section: the workspace's latest social posts, drawn on its own hosted site.
//
// Owner decisions 2026-10-20: hosted sites only (no paste-in embed), and ONLY posts published through
// Be More Swan — read from scheduled_posts, never fetched from the platforms. So this needs no
// platform API, no token and no Meta review, and a post shows exactly what we published: its words,
// its first picture or video from the library, and a link to it on the platform when we have one.
//
// The section holds no posts of its own — only which platforms and how many. The posts are read here
// when the page is drawn (like reviews and products), so a new post appears without republishing.
// A post sent to several platforms at once (one crosspost group) is ONE card with a link per platform.

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, scheduledPosts } from '../../db/schema';
import { PLATFORM_FORMATS, SOCIAL_PLATFORMS, type SocialPlatform } from '../config/platform-formats';
import { displayCaption } from './model-json';
import { clampText } from './text-safe';
import type { SiteDefinition } from './site-definition';

type Db = ReturnType<typeof getDb>;

/** Most posts one section shows; the newest this many groups are read for every section on the site. */
export const SOCIAL_FEED_MAX = 12;
/** How much of a caption a card shows — the full post is one click away on the platform. */
export const SOCIAL_FEED_CAPTION = 280;

export interface SiteRenderSocialPost {
    /** Newest-first key: the crosspost group, else the post id. */
    key: string;
    caption: string;
    publishedAt: string;
    /** Every platform the post went to, with its live address where the platform gave us one. */
    links: Array<{ platform: SocialPlatform; label: string; url: string | null }>;
    /** The first library picture or video of the post, if it had one. */
    media: { assetId: number; video: boolean } | null;
}
export interface SiteRenderSocialFeed { posts: SiteRenderSocialPost[]; }

const isPlatform = (p: string): p is SocialPlatform => (SOCIAL_PLATFORMS as string[]).includes(p);
const canonical = (p: string | null): string => (p === 'twitter' ? 'x' : String(p ?? ''));
export const socialPlatformLabel = (p: SocialPlatform): string => PLATFORM_FORMATS[p]?.label ?? p;

/** A live post address we are willing to link: https only. Anything else is shown without a link. */
function cleanPostUrl(v: string | null): string | null {
    if (!v) return null;
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null; }
    catch { return null; }
}

/**
 * The newest published posts, grouped. Pure — exported for tests. `rows` newest first; `assets` the
 * org's own assets by id (anything not in it — someone else's, deleted, audio — is not drawn).
 */
export function groupFeedPosts(
    rows: Array<{ id: number; platform: string | null; caption: string | null; publishedAt: Date | string | null; platformPostUrl: string | null; contentAssetIds: unknown; crosspostGroupId: string | null }>,
    assets: Map<number, string>,
    max = SOCIAL_FEED_MAX * 4,
): SiteRenderSocialPost[] {
    const byKey = new Map<string, SiteRenderSocialPost>();
    for (const r of rows) {
        const platform = canonical(r.platform);
        // An unreadable date skips the post rather than throwing — one bad row must not take the page down.
        const at = r.publishedAt ? new Date(r.publishedAt) : null;
        if (!isPlatform(platform) || !at || Number.isNaN(at.getTime())) continue;
        const key = r.crosspostGroupId ? `g:${r.crosspostGroupId}` : `p:${r.id}`;
        let card = byKey.get(key);
        if (!card) {
            if (byKey.size >= max) continue;
            const caption = clampText(displayCaption(r.caption).replace(/\n{3,}/g, '\n\n').trim(), SOCIAL_FEED_CAPTION);
            const first = (Array.isArray(r.contentAssetIds) ? r.contentAssetIds : []).map(Number).find((n) => Number.isInteger(n) && assets.has(n));
            card = {
                key, caption,
                publishedAt: at.toISOString(),
                links: [],
                media: first ? { assetId: first, video: assets.get(first) === 'video' } : null,
            };
            byKey.set(key, card);
        }
        if (!card.links.some((l) => l.platform === platform)) card.links.push({ platform, label: socialPlatformLabel(platform), url: cleanPostUrl(r.platformPostUrl) });
    }
    // A post with neither words nor a picture would be an empty card.
    return [...byKey.values()].filter((c) => c.caption || c.media);
}

/** Every post a site's social sections may need; null when the site has none (nothing is read). */
export async function loadSiteSocialFeed(db: Db, orgId: number, def: SiteDefinition): Promise<SiteRenderSocialFeed | null> {
    if (!def.pages.some((p) => p.sections.some((s) => s.type === 'social_feed'))) return null;
    const rows = await db.select({
        id: scheduledPosts.id, platform: scheduledPosts.platform, caption: scheduledPosts.caption,
        publishedAt: scheduledPosts.publishedAt, platformPostUrl: scheduledPosts.platformPostUrl,
        contentAssetIds: scheduledPosts.contentAssetIds, crosspostGroupId: scheduledPosts.crosspostGroupId,
    }).from(scheduledPosts)
        .where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'published'), isNotNull(scheduledPosts.publishedAt)))
        .orderBy(desc(scheduledPosts.publishedAt), desc(scheduledPosts.id))
        // Enough rows for SOCIAL_FEED_MAX cards per platform once crossposts collapse.
        .limit(SOCIAL_FEED_MAX * SOCIAL_PLATFORMS.length * 2);
    const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.contentAssetIds) ? r.contentAssetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)))];
    const owned = ids.length
        ? await db.select({ id: contentAssets.id, assetType: contentAssets.assetType }).from(contentAssets)
            .where(and(eq(contentAssets.organisationId, orgId), inArray(contentAssets.id, ids), inArray(contentAssets.assetType, ['image', 'video'])))
        : [];
    return { posts: groupFeedPosts(rows, new Map(owned.map((a) => [a.id, a.assetType]))) };
}

/** For the chat and the editor: which platforms they have published to through us, and how much. */
export async function socialFeedSummary(db: Db, orgId: number): Promise<Array<{ platform: SocialPlatform; label: string; posts: number }>> {
    const rows = await db.select({ platform: scheduledPosts.platform, n: sql<number>`count(*)::int` }).from(scheduledPosts)
        .where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'published')))
        .groupBy(scheduledPosts.platform);
    const n = new Map<SocialPlatform, number>();
    for (const r of rows) { const p = canonical(r.platform); if (isPlatform(p)) n.set(p, (n.get(p) ?? 0) + Number(r.n)); }
    return SOCIAL_PLATFORMS.filter((p) => n.has(p)).map((p) => ({ platform: p, label: socialPlatformLabel(p), posts: n.get(p)! }));
}

export async function socialFeedForPrompt(db: Db, orgId: number): Promise<string> {
    const s = await socialFeedSummary(db, orgId);
    return s.length
        ? `Posts they have published through Be More Swan (for a social_feed section's platforms): ${s.map((x) => `${x.platform} (${x.label}, ${x.posts} post${x.posts === 1 ? '' : 's'})`).join('; ')}. A social_feed section only ever shows posts published through Be More Swan — never posts they made directly on a platform.`
        : 'They have not published any social posts through Be More Swan yet — a social_feed section would show nothing until they do (it only shows posts published through Be More Swan).';
}
