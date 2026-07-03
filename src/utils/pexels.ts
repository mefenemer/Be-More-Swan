// pexels.ts — Pexels image sourcing for the Social Media Assistant.
//
// Solves "where do post images come from": search Pexels for legally-safe stock images
// (US1), guarantee an image is never reused across a workspace's feed (US2, HARD rule),
// and respect Pexels' ToS — hotlink-only, attribution, rate limits (US3).
//
// We NEVER download/host the raw bytes permanently: the Pexels CDN URL is stored as
// contentAssets.externalUrl and hotlinked at publish time by resolvePostImage()
// (src/utils/social-publish.ts). See US3 AC3.1.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, postedAssets, scheduledPosts, scheduledPostAssets, pexelsSearchCache } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';

type Db = ReturnType<typeof getDb>;

// US3 AC3.4: user-facing copy when Pexels returns HTTP 429.
export const PEXELS_RATE_LIMIT_MESSAGE = 'Content search is resting. Please try again in a few minutes.';

// Thrown on a Pexels 429 so callers can map it to PEXELS_RATE_LIMIT_MESSAGE.
export class PexelsRateLimitError extends Error {
    constructor() {
        super(PEXELS_RATE_LIMIT_MESSAGE);
        this.name = 'PexelsRateLimitError';
    }
}

export interface PexelsCandidate {
    providerAssetId: string;   // Pexels photo id (string)
    url: string;               // CDN URL (src.large) — hotlinked, never permanently hosted
    title: string;             // alt text / description
    photographer: string;      // US3 AC3.2
    photographerUrl: string;   // US3 AC3.2
    width: number;
    height: number;
}

// Video stock search (Pexels for both images and videos). providerAssetId is prefixed 'v' so a
// video id can never collide with a photo id in the shared 'pexels' dedup namespace (posted_assets).
export interface PexelsVideoCandidate {
    providerAssetId: string;   // 'v' + Pexels video id
    url: string;               // direct .mp4 file URL (hotlinked, never permanently hosted)
    title: string;
    photographer: string;      // Pexels videographer (user.name)
    photographerUrl: string;   // user.url
    width: number;
    height: number;
}

const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';
const PEXELS_VIDEO_SEARCH_URL = 'https://api.pexels.com/videos/search';

// Search-term cache TTL (technical note: minimize redundant API calls). 24h.
const PEXELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// US1 AC1.2: turn a post's topic / suggestedMediaDescription into a short, specific query.
export async function generateImageKeywords(context: string): Promise<string> {
    const trimmed = (context || '').trim();
    if (!trimmed) return '';
    try {
        const { text } = await gatewayGenerate({
            system:
                'You generate concise stock-photo search keywords. Given a social post topic or media ' +
                'description, return 2–4 specific, visual search keywords (no hashtags, no punctuation, ' +
                'no quotes) best suited to finding a relevant photo. Reply with ONLY the keywords.',
            messages: [{ role: 'user', content: trimmed.slice(0, 500) }],
            maxTokens: 30,
        });
        const keywords = text.replace(/["'\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
        return keywords || trimmed.slice(0, 80);
    } catch {
        // LLM failure must not block image sourcing — fall back to the raw context.
        return trimmed.slice(0, 80);
    }
}

// US1 AC1.3/1.4: GET the Pexels search endpoint with safe_search forced on.
export async function pexelsSearch(query: string, page = 1, perPage = 15): Promise<PexelsCandidate[]> {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) throw new Error('PEXELS_API_KEY is not configured.');
    if (!query.trim()) return [];

    const params = new URLSearchParams({
        query,
        per_page: String(perPage),
        page: String(page),
        safe_search: 'true',   // US1 AC1.4 — never pull explicit content
    });

    const res = await fetch(`${PEXELS_SEARCH_URL}?${params}`, {
        headers: { Authorization: apiKey },
    });

    if (res.status === 429) throw new PexelsRateLimitError();   // US3 AC3.4
    if (!res.ok) throw new Error(`Pexels API error (${res.status})`);

    const data: any = await res.json().catch(() => ({}));
    const photos: any[] = Array.isArray(data?.photos) ? data.photos : [];
    return photos.map(p => ({
        providerAssetId: String(p.id),
        url: p?.src?.large || p?.src?.large2x || p?.src?.original || '',
        title: (p?.alt || '').trim() || `Pexels photo ${p.id}`,
        photographer: p?.photographer || 'Unknown',
        photographerUrl: p?.photographer_url || '',
        width: Number(p?.width) || 0,
        height: Number(p?.height) || 0,
    })).filter(c => c.url && c.providerAssetId);
}

// US1 AC1.3/1.4: GET the Pexels video search endpoint with safe_search forced on. Picks the most
// usable progressive .mp4 file per result (prefers an HD-ish rendition, falls back to the largest).
export async function pexelsVideoSearch(query: string, page = 1, perPage = 15): Promise<PexelsVideoCandidate[]> {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) throw new Error('PEXELS_API_KEY is not configured.');
    if (!query.trim()) return [];

    const params = new URLSearchParams({
        query,
        per_page: String(perPage),
        page: String(page),
        safe_search: 'true',   // US1 AC1.4 — never pull explicit content
    });

    const res = await fetch(`${PEXELS_VIDEO_SEARCH_URL}?${params}`, {
        headers: { Authorization: apiKey },
    });

    if (res.status === 429) throw new PexelsRateLimitError();   // US3 AC3.4
    if (!res.ok) throw new Error(`Pexels API error (${res.status})`);

    const data: any = await res.json().catch(() => ({}));
    const videos: any[] = Array.isArray(data?.videos) ? data.videos : [];
    return videos.map(v => {
        const files: any[] = Array.isArray(v?.video_files) ? v.video_files : [];
        const mp4s = files.filter(f => (f?.file_type === 'video/mp4' || /\.mp4/i.test(f?.link || '')) && f?.link);
        // Prefer an HD rendition ≤1080p, else the largest available.
        const sized = mp4s.map(f => ({ link: f.link as string, h: Number(f?.height) || 0, w: Number(f?.width) || 0 }));
        const hd = sized.filter(f => f.h && f.h <= 1080).sort((a, b) => b.h - a.h)[0];
        const best = hd || sized.sort((a, b) => b.h - a.h)[0];
        return {
            providerAssetId: `v${v?.id}`,
            url: best?.link || '',
            title: (v?.url ? `Pexels video ${v.id}` : `Pexels video ${v?.id}`),
            photographer: v?.user?.name || 'Unknown',
            photographerUrl: v?.user?.url || '',
            width: best?.w || Number(v?.width) || 0,
            height: best?.h || Number(v?.height) || 0,
        };
    }).filter(c => c.url && c.providerAssetId && c.providerAssetId !== 'vundefined');
}

// Cache wrapper (technical note): look up a normalized "kind|query|page" key, return fresh-enough
// rows, else fetch + upsert. Dedup (filterUnique) runs on the RESULT, so the cache never violates
// the never-reuse rule. All cache errors are swallowed — the live API is always the source of truth.
async function cachedSearch<T>(db: Db, kind: 'photo' | 'video', query: string, page: number): Promise<T[]> {
    const key = `${kind}|${query.toLowerCase().trim()}|${page}`;
    try {
        const [row] = await db.select().from(pexelsSearchCache)
            .where(eq(pexelsSearchCache.queryKey, key)).limit(1);
        if (row && Date.now() - new Date(row.createdAt).getTime() < PEXELS_CACHE_TTL_MS) {
            return (row.candidates as T[]) || [];
        }
    } catch { /* cache table may be unmigrated — fall through to a live fetch */ }

    const fresh = (kind === 'video'
        ? await pexelsVideoSearch(query, page)
        : await pexelsSearch(query, page)) as unknown as T[];

    try {
        await db.insert(pexelsSearchCache)
            .values({ queryKey: key, candidates: fresh as unknown as object, createdAt: new Date() })
            .onConflictDoUpdate({ target: pexelsSearchCache.queryKey, set: { candidates: fresh as unknown as object, createdAt: new Date() } });
    } catch { /* ignore cache write failures */ }

    return fresh;
}

// US2 AC2.2/2.3 (HARD rule): strip any candidate whose Pexels ID is already in posted_assets
// for this organisation, BEFORE it is presented to the LLM or user.
export async function filterUnique<T extends { providerAssetId: string }>(db: Db, orgId: number, candidates: T[]): Promise<T[]> {
    if (!candidates.length) return [];
    const ids = candidates.map(c => c.providerAssetId);
    const used = await db
        .select({ providerAssetId: postedAssets.providerAssetId })
        .from(postedAssets)
        .where(and(
            eq(postedAssets.organisationId, orgId),
            eq(postedAssets.provider, 'pexels'),
            inArray(postedAssets.providerAssetId, ids),
        ));
    const usedSet = new Set(used.map(u => u.providerAssetId));
    return candidates.filter(c => !usedSet.has(c.providerAssetId));
}

export interface SearchResult { keywords: string; candidates: PexelsCandidate[]; }
export interface VideoSearchResult { keywords: string; candidates: PexelsVideoCandidate[]; }

// US1 AC1.5 + US2 AC2.4: keywords → search page 1 → strip dupes → if none remain, pull page 2.
// Searches run through the cache (cachedSearch) to minimise redundant API calls.
export async function searchUniqueImages(
    db: Db,
    orgId: number,
    context: string,
    { limit = 5 }: { limit?: number } = {},
): Promise<SearchResult> {
    const keywords = await generateImageKeywords(context);
    if (!keywords) return { keywords, candidates: [] };

    let unique = await filterUnique(db, orgId, await cachedSearch<PexelsCandidate>(db, 'photo', keywords, 1));
    if (unique.length === 0) {
        // US2 AC2.4: first page was all duplicates — automatically request page 2.
        unique = await filterUnique(db, orgId, await cachedSearch<PexelsCandidate>(db, 'photo', keywords, 2));
    }
    return { keywords, candidates: unique.slice(0, limit) };
}

// Video equivalent — same keyword extraction + cache + per-org dedup, against the Pexels video API.
export async function searchUniqueVideos(
    db: Db,
    orgId: number,
    context: string,
    { limit = 5 }: { limit?: number } = {},
): Promise<VideoSearchResult> {
    const keywords = await generateImageKeywords(context);
    if (!keywords) return { keywords, candidates: [] };

    let unique = await filterUnique(db, orgId, await cachedSearch<PexelsVideoCandidate>(db, 'video', keywords, 1));
    if (unique.length === 0) {
        unique = await filterUnique(db, orgId, await cachedSearch<PexelsVideoCandidate>(db, 'video', keywords, 2));
    }
    return { keywords, candidates: unique.slice(0, limit) };
}

// US3 AC3.3: subtle, non-intrusive attribution line appended to the draft.
export function creditLine(photographer: string): string {
    return `\n\nPhoto by ${photographer} on Pexels`;
}

// Create a contentAssets row for a Pexels candidate (externalUrl = CDN URL → hotlinked), WITHOUT
// attaching it to any post. Used by the media resolver, which wires the asset to a post itself.
// Returns the new asset id. Handles both photos ('image') and videos ('video').
export async function createPexelsAsset(
    db: Db,
    args: { userId: number; orgId: number | null; candidate: PexelsCandidate | PexelsVideoCandidate; assetType?: 'image' | 'video' },
): Promise<number> {
    const { userId, orgId, candidate } = args;
    const assetType = args.assetType ?? 'image';
    const mimeType = assetType === 'video' ? 'video/mp4' : 'image/jpeg';

    const [asset] = await db.insert(contentAssets).values({
        userId,
        organisationId: orgId ?? null,
        name: candidate.title,
        assetType,
        mimeType,
        externalUrl: candidate.url,         // US3 AC3.1 — hotlink, never permanently hosted
        provider: 'pexels',
        providerAssetId: candidate.providerAssetId,
        attributionName: candidate.photographer,   // US3 AC3.2
        attributionUrl: candidate.photographerUrl, // US3 AC3.2
        status: 'pending',
    }).returning({ id: contentAssets.id });

    return asset.id;
}

// Create a contentAssets row for a Pexels candidate, attach it to the post via the
// scheduledPostAssets junction, and keep the deprecated contentAssetIds array in sync during the
// migration window. Returns the new asset id. Handles both photos and videos.
export async function attachPexelsImageToPost(
    db: Db,
    args: { postId: number; userId: number; orgId: number | null; candidate: PexelsCandidate | PexelsVideoCandidate; assetType?: 'image' | 'video' },
): Promise<number> {
    const { postId, userId, orgId, candidate } = args;
    const assetId = await createPexelsAsset(db, { userId, orgId, candidate, assetType: args.assetType });
    const asset = { id: assetId };

    await db.insert(scheduledPostAssets)
        .values({ scheduledPostId: postId, contentAssetId: asset.id, position: 0 })
        .onConflictDoNothing();

    // Keep the deprecated JSONB array in sync so resolvePostImage() (which reads it) works today.
    const [post] = await db.select({ ids: scheduledPosts.contentAssetIds })
        .from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    const existing = Array.isArray(post?.ids) ? (post!.ids as number[]) : [];
    if (!existing.includes(asset.id)) {
        await db.update(scheduledPosts)
            .set({ contentAssetIds: [...existing, asset.id], updatedAt: new Date() })
            .where(eq(scheduledPosts.id, postId));
    }

    return asset.id;
}

// US2 AC2.5: once a post is scheduled or published, write its chosen Pexels asset IDs to
// posted_assets so they can never be reused. Idempotent (unique constraint + onConflictDoNothing),
// so it is safe to call from both the approval and publish hooks.
export async function recordPostedAssets(
    db: Db,
    args: { orgId: number; userId?: number | null; scheduledPostId: number },
): Promise<void> {
    const { orgId, userId = null, scheduledPostId } = args;

    const rows = await db
        .select({ assetId: contentAssets.id, providerAssetId: contentAssets.providerAssetId })
        .from(scheduledPostAssets)
        .innerJoin(contentAssets, eq(scheduledPostAssets.contentAssetId, contentAssets.id))
        .where(and(
            eq(scheduledPostAssets.scheduledPostId, scheduledPostId),
            eq(contentAssets.provider, 'pexels'),
            isNotNull(contentAssets.providerAssetId),
        ));

    if (!rows.length) return;

    await db.insert(postedAssets)
        .values(rows.map(r => ({
            organisationId: orgId,
            userId: userId ?? null,
            provider: 'pexels',
            providerAssetId: r.providerAssetId!,
            scheduledPostId,
            contentAssetId: r.assetId,
        })))
        .onConflictDoNothing();
}
