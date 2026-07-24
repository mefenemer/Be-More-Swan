// media-resolver.ts — the per-assistant Media Source priority matrix with graceful fallback.
//
// Given an assistant's ordered mediaSources preference, resolveMediaForPost() walks the enabled
// sources in priority order (default: Manual Library → AI Stock Search (Pexels) → AI Generation)
// and returns the FIRST source that yields a usable asset (AC3.1). A source that returns nothing —
// empty library, zero Pexels results, a Pexels rate-limit, a failed AI render — is skipped and the
// next source is tried (AC2.3 graceful fallback). If every enabled source is exhausted the caller
// is told so it can log a notification for the user to review.
//
// The resolver only PRODUCES an asset id (content_assets row); the caller wires it onto a post and
// records dedup (posted_assets) at the appropriate point in its own flow.

import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';
import { normalizeMediaSources, type MediaSource } from './media-sources';
import { searchUniqueImages, searchUniqueVideos, createPexelsAsset } from './pexels';

type Db = ReturnType<typeof getDb>;

export interface ResolveArgs {
    assistant: { mediaSources?: unknown };
    orgId: number;
    userId: number;
    context: string;                       // topic / caption / media description used for stock keywords
    mediaType?: 'image' | 'video';         // technical note: asset format by role; default image
    // Injected AI generator so the resolver stays free of credit-ledger / Fal specifics. Returns a
    // new content_assets id, or throws when AI generation failed. Omit to treat 'ai' as unavailable.
    generateAi?: () => Promise<number>;
    // Injected brand-card renderer, same contract as generateAi. Kept out of the resolver for the
    // same reason: this module knows about SOURCE PRIORITY, not about satori, R2 or brand kits.
    // Omit to treat 'brand_card' as unavailable.
    renderBrandCard?: () => Promise<number>;
    // Stable per-post number (the post id) used to alternate stock ↔ brand_card. Same value in ⇒
    // same source out, so a retried job re-resolves the same way and a test can assert the choice.
    rotationKey?: number;
}

export type ResolvedMedia =
    | { ok: true; assetId: number; source: MediaSource }
    | { ok: false; exhausted: true; tried: MediaSource[]; lastError?: string };

/**
 * Swap the relative priority of 'stock' and 'brand_card' on odd rotation keys.
 *
 * Both sources almost always succeed, so a fixed priority order means the lower one NEVER runs —
 * an assistant with both enabled would post nothing but photos (or nothing but cards) forever.
 * Alternating by post id is what turns "both enabled" into the mixed feed it reads as. Every other
 * source keeps its position; only these two trade places.
 */
export function rotateSources(order: MediaSource[], rotationKey: number): MediaSource[] {
    const i = order.indexOf('stock');
    const j = order.indexOf('brand_card');
    if (i === -1 || j === -1) return order;
    if (Math.abs(Math.trunc(rotationKey)) % 2 === 0) return order;
    const out = [...order];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
}

export async function resolveMediaForPost(db: Db, args: ResolveArgs): Promise<ResolvedMedia> {
    const { orgId, userId, context, generateAi, renderBrandCard } = args;
    const mediaType = args.mediaType ?? 'image';
    const order = rotateSources(normalizeMediaSources(args.assistant?.mediaSources), args.rotationKey ?? 0);

    const tried: MediaSource[] = [];
    let lastError: string | undefined;

    for (const source of order) {
        tried.push(source);
        try {
            if (source === 'manual') {
                const id = await pickManualAsset(db, orgId, mediaType);
                if (id != null) return { ok: true, assetId: id, source };
            } else if (source === 'stock') {
                const id = await pickStockAsset(db, { orgId, userId, context, mediaType });
                if (id != null) return { ok: true, assetId: id, source };
            } else if (source === 'brand_card') {
                // Typography only — there is no video equivalent of a card, and a still image in a
                // video slot would fail the platform upload.
                if (mediaType !== 'image' || !renderBrandCard) continue;
                const id = await renderBrandCard();
                return { ok: true, assetId: id, source };
            } else if (source === 'ai') {
                // AI video generation is async (generate-ai-video) and out of this synchronous path;
                // only image AI generation is resolved inline.
                if (mediaType !== 'image' || !generateAi) continue;
                const id = await generateAi();
                return { ok: true, assetId: id, source };
            }
        } catch (err) {
            // A failing source must never abort the chain (AC2.3) — record and fall through.
            lastError = err instanceof Error ? err.message : String(err);
        }
    }

    return { ok: false, exhausted: true, tried, lastError };
}

// Manual source: the org's own uploaded library — provider IS NULL, matching asset type, has a
// storage location, not rejected/purged, and not already attached to any post (LRU = oldest first).
async function pickManualAsset(db: Db, orgId: number, mediaType: 'image' | 'video'): Promise<number | null> {
    const [row] = await db
        .select({ id: contentAssets.id })
        .from(contentAssets)
        .where(and(
            eq(contentAssets.organisationId, orgId),
            isNull(contentAssets.provider),
            eq(contentAssets.assetType, mediaType),
            ne(contentAssets.status, 'rejected'),
            isNull(contentAssets.purgedAt),
            sql`(${contentAssets.storageKey} IS NOT NULL OR ${contentAssets.storageUrl} IS NOT NULL OR ${contentAssets.externalUrl} IS NOT NULL)`,
            sql`NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ${contentAssets.id})`,
        ))
        .orderBy(asc(contentAssets.createdAt))
        .limit(1);
    return row?.id ?? null;
}

// Stock source: Pexels search (image or video) with per-org dedup; the first unique candidate is
// persisted as a content_assets row (provider='pexels') and its id returned.
async function pickStockAsset(
    db: Db,
    args: { orgId: number; userId: number; context: string; mediaType: 'image' | 'video' },
): Promise<number | null> {
    const { orgId, userId, context, mediaType } = args;

    if (mediaType === 'video') {
        const { candidates } = await searchUniqueVideos(db, orgId, context);
        const pick = candidates[0];
        if (!pick) return null;
        return createPexelsAsset(db, { userId, orgId, candidate: pick, assetType: 'video' });
    }

    const { candidates } = await searchUniqueImages(db, orgId, context);
    const pick = candidates[0];
    if (!pick) return null;
    return createPexelsAsset(db, { userId, orgId, candidate: pick, assetType: 'image' });
}
