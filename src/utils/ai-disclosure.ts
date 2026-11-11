// src/utils/ai-disclosure.ts
// Does a post's video contain AI-made footage? (docs/video-producer-footage-and-ai-plan.md §6, Phase 7,
// 2026-11-11.) Realistic AI video is expected to be labelled. Where a platform's publish API has a field
// for it, it is set:
//   • YouTube — status.containsSyntheticMedia (social-publish.ts publishYouTubeResumable).
// Meta's publishing APIs have no such field (Meta labels from its own detection); a visible "Made with AI"
// caption line there is the owner's decision D-F4, not made here.
//
// An AI video is: a raw AI clip (a video asset from fal), or a Video Producer finished video whose
// storyboard used AI (render_params.containsAi, written by video-render.ts). Org-scoped.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export interface AssetLike { assetType: string | null; provider: string | null; renderParams: unknown }

/** Is this asset AI-made video? Pure. */
export function isAiVideo(a: AssetLike): boolean {
    if ((a.assetType ?? '').toLowerCase() !== 'video') return false;
    if (a.provider === 'fal') return true;
    const rp = a.renderParams && typeof a.renderParams === 'object' ? a.renderParams as Record<string, unknown> : null;
    return rp?.containsAi === true;
}

/** Does any of the post's attached assets contain AI-made video? A failed read answers false (nothing is withheld from publishing). */
export async function postHasAiVideo(db: Db, organisationId: number, contentAssetIds: unknown): Promise<boolean> {
    const ids = (Array.isArray(contentAssetIds) ? contentAssetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
    if (!ids.length) return false;
    const rows = await db.select({ assetType: contentAssets.assetType, provider: contentAssets.provider, renderParams: contentAssets.renderParams })
        .from(contentAssets).where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, organisationId)))
        .catch(() => [] as AssetLike[]);
    return rows.some(isAiVideo);
}
