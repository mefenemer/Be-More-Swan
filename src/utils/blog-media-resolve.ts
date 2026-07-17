// src/utils/blog-media-resolve.ts
// Read-time media resolution for a PUBLISHED blog snapshot, shared by every reader of the immutable
// published_payload — the native widget API (widget-api.ts) and the server-rendered permalink page
// (blog-page.ts). Both MUST resolve identically, so the logic lives here once.
//
// The invariant it protects: media is snapshotted at publish time as a src-less
// <img|video|audio data-bms-asset="N"> (and the feature image as a bare assetId). Presigned R2 URLs
// expire, so we never freeze one into the payload — instead we resolve a FRESH org-scoped URL at
// read time. Both callers cache under a TTL below the presigned-URL lifetime.

import { and, eq, inArray } from 'drizzle-orm';
import { contentAssets } from '../../db/schema';
import { resolveAssetDisplayUrl } from './social-publish';

// Escape a resolved URL for safe insertion into an HTML double-quoted attribute value.
export function escAttr(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Resolve every inline <img|video|audio data-bms-asset="N"> in a snapshotted body to a fresh,
// org-scoped src. A deleted/foreign asset is left src-less (graceful degrade). The tag is echoed
// back verbatim from the already-sanitised snapshot, so this can only re-emit an allowlisted tag.
export async function resolveInlineMedia(db: any, orgId: number, html: string): Promise<string> {
    if (!html || !html.includes('data-bms-asset')) return html;
    const ids = [...new Set([...html.matchAll(/data-bms-asset="(\d+)"/g)].map((x) => Number(x[1])))]
        .filter(Number.isFinite);
    if (!ids.length) return html;

    const assets = await db
        .select({
            id: contentAssets.id, assetType: contentAssets.assetType, storageUrl: contentAssets.storageUrl,
            storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
        })
        .from(contentAssets)
        .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));

    const urlById = new Map<number, string | null>();
    for (const a of assets) urlById.set(a.id, await resolveAssetDisplayUrl(a));

    return html.replace(/<(img|video|audio)([^>]*?)data-bms-asset="(\d+)"([^>]*)>/g,
        (full, tag, pre, id, post) => {
            const url = urlById.get(Number(id));
            return url ? `<${tag} src="${escAttr(url)}"${pre}data-bms-asset="${id}"${post}>` : full;
        });
}

// Resolve a fresh feature-image URL from a snapshotted assetId. Returns null for no/deleted asset.
export async function resolveFeatureImageUrl(db: any, orgId: number, assetId: unknown): Promise<string | null> {
    if (!Number.isFinite(Number(assetId))) return null;
    const [a] = await db
        .select({
            assetType: contentAssets.assetType, storageUrl: contentAssets.storageUrl,
            storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
        })
        .from(contentAssets)
        .where(and(eq(contentAssets.id, Number(assetId)), eq(contentAssets.organisationId, orgId)))
        .limit(1);
    return a ? await resolveAssetDisplayUrl(a) : null;
}
