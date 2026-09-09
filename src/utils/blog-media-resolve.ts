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
import type { CardImageRef } from './blog-card-image';

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

/**
 * Resolve a whole list of card images in ONE query.
 *
 * A Swan Index list draws up to seven cards, and every one of them can belong to a DIFFERENT
 * contributor's organisation. Calling resolveFeatureImageUrl per card would put seven round trips
 * on the page whose entire design goal is a single indexed scan — see the note on CARD_COLUMNS in
 * swan-index/queries.ts.
 *
 * ⚠️ Tenant scoping is applied PER ITEM, not as a WHERE clause. One `organisationId = X` filter
 * would be wrong here, because the cards legitimately span organisations; dropping the check
 * altogether would let one contributor's post display another org's private asset by guessing an
 * id. So the ids are fetched together and each asset is handed back only to the item whose org
 * actually owns it.
 *
 * Returns one entry per input item, in order. A deleted, foreign or unresolvable asset degrades to
 * null — the caller then draws its placeholder, which is the honest result.
 */
export async function resolveCardImageUrls(
    db: any,
    items: { orgId: number; ref: CardImageRef }[],
): Promise<(string | null)[]> {
    const ids = [...new Set(
        items.map((i) => (i.ref?.kind === 'asset' ? i.ref.assetId : null)).filter((n): n is number => !!n),
    )];

    const byId = new Map<number, { organisationId: number; url: string | null }>();
    if (ids.length) {
        const assets = await db
            .select({
                id: contentAssets.id, organisationId: contentAssets.organisationId,
                assetType: contentAssets.assetType, storageUrl: contentAssets.storageUrl,
                storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
            })
            .from(contentAssets)
            .where(inArray(contentAssets.id, ids));
        for (const a of assets) {
            byId.set(a.id, { organisationId: a.organisationId, url: await resolveAssetDisplayUrl(a) });
        }
    }

    return items.map((i) => {
        if (!i.ref) return null;
        if (i.ref.kind === 'url') return i.ref.url;
        const hit = byId.get(i.ref.assetId);
        return hit && hit.organisationId === i.orgId ? hit.url : null;
    });
}
