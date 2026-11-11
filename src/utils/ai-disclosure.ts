// src/utils/ai-disclosure.ts
// Does a post's video contain AI-made footage? (docs/video-producer-footage-and-ai-plan.md §6, Phase 7,
// 2026-11-11.) Realistic AI video is expected to be labelled. Where a platform's publish API has a field
// for it, it is set:
//   • YouTube — status.containsSyntheticMedia (social-publish.ts publishYouTubeResumable).
// Meta's publishing APIs have no such field (Meta labels from its own detection): there, and on every other
// platform without one, a "Made with AI" caption line is added for realistic AI video (below; owner D-F4, 2026-11-11).
//
// An AI video is: a raw AI clip (a video asset from fal), or a Video Producer finished video whose
// storyboard used AI (render_params.containsAi, written by video-render.ts). Org-scoped.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, organisations } from '../../db/schema';
import { isRealisticStyle } from '../lib/ai-clip';

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

// ── "Made with AI" in the caption (owner, 2026-11-11: realistic posts only, a workspace setting) ─────────
// Platforms with no publishing field for AI content (Facebook, Instagram, LinkedIn, X, Threads…) get a short
// line in the caption instead — only when the video looks real (not a 3D animated or 2D cartoon clip), and
// only while the workspace's setting is on (organisations.ai_video_label_enabled, default on). Added when the
// post is PUBLISHED, never stored in the caption, so an edited caption can't lose it. YouTube uses its field.

export const AI_VIDEO_LABEL = 'Made with AI';

/** Is this asset AI video that looks real? An older AI video with no style recorded counts as real (the safe side). Pure. */
export function isRealisticAiVideo(a: AssetLike): boolean {
    if (!isAiVideo(a)) return false;
    const rp = a.renderParams && typeof a.renderParams === 'object' ? a.renderParams as Record<string, unknown> : {};
    if (a.provider === 'fal') return isRealisticStyle(rp.aiStyle);
    return rp.containsRealisticAi !== false;
}

/**
 * The label to put in this post's caption, or null: the workspace's setting is on AND an attached video
 * looks real. A failed read of the setting counts as on (a missing column before its SQL runs must not
 * stop a post — and the label errs towards saying so).
 */
export async function aiVideoLabelFor(db: Db, organisationId: number, contentAssetIds: unknown): Promise<string | null> {
    const ids = (Array.isArray(contentAssetIds) ? contentAssetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
    if (!ids.length) return null;
    const rows = await db.select({ assetType: contentAssets.assetType, provider: contentAssets.provider, renderParams: contentAssets.renderParams })
        .from(contentAssets).where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, organisationId)))
        .catch(() => [] as AssetLike[]);
    if (!rows.some(isRealisticAiVideo)) return null;
    const on = await db.select({ on: organisations.aiVideoLabelEnabled }).from(organisations).where(eq(organisations.id, organisationId)).limit(1)
        .then((r) => r[0]?.on ?? true).catch(() => true);
    return on ? AI_VIDEO_LABEL : null;
}
