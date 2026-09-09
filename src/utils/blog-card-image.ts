// src/utils/blog-card-image.ts
// "Which image represents this post in a list?" — one answer, shared by every surface that shows a
// post as a card: The Swan Index front page and section lists, and the blog widget embedded on
// customer sites.
//
// It lives here rather than in either caller because the surfaces are meant to agree. A post whose
// thumbnail is one picture on the author's own blog and a different one on the magazine that
// syndicated it looks like two different articles.
//
// ── The ladder ─────────────────────────────────────────────────────────────────────────────────
//   1. the feature image, if the author set one — their explicit choice, and the only tier that IS
//      a choice;
//   2. otherwise the FIRST image in the body — a decent proxy for what the piece is about, and the
//      reason most posts can have a thumbnail at all: hardly any set a feature image;
//   3. otherwise nothing, and the caller draws its own placeholder.
//
// Tier 3 is a real answer, not a failure. A text-only essay has no photograph, and a plate saying
// so reads better than a stretched stock image nobody chose.

/** Where a card image comes from. Resolved to a URL separately — see resolveCardImages. */
export type CardImageRef =
    // An asset in OUR storage, referenced by id. Presigned R2 URLs expire, so the id is what gets
    // stored and a fresh URL is minted at read time — the same rule the body media follows.
    | { kind: 'asset'; assetId: number; alt: string | null }
    // Somebody else's URL, used as-is. See the https note on firstBodyImage.
    | { kind: 'url'; url: string; alt: string | null }
    | null;

/**
 * External image URLs are accepted only over https.
 *
 * Not fussiness: every surface that renders these cards is served over https, so an http image is
 * mixed content and the browser blocks it. The card would then show a broken-image glyph — which
 * is precisely the state the "TSI" plate exists to avoid, and strictly worse than the plate,
 * because it reads as our bug rather than as an article without a photograph.
 *
 * Anything else — data:, javascript:, protocol-relative, a bare path — falls through to the next
 * tier. This text becomes an `src` attribute on a page carrying a third party's byline; the list
 * of schemes worth taking that risk for is exactly one item long.
 */
function isUsableExternalUrl(v: unknown): v is string {
    return typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) && v.length <= 2048;
}

function cleanAlt(v: unknown): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, 300) : null;
}

/**
 * The first image in a snapshotted body, as a reference.
 *
 * Regex rather than a parser, deliberately and consistently with resolveInlineMedia: this HTML is
 * not arbitrary input. It is the publish-time snapshot, already sanitised down to an allowlist of
 * tags, and we are reading two attributes out of it rather than trusting its structure.
 *
 * ⚠️ It scans for `<img` ONCE and inspects whichever tag comes first, rather than looking for an
 * asset image and a URL image separately and preferring one. Searching separately would pick the
 * first asset even when a URL image appears above it — so the thumbnail would be an illustration
 * from halfway down the article while the picture at the top went unused.
 */
export function firstBodyImage(html: unknown): CardImageRef {
    if (typeof html !== 'string' || !html.includes('<img')) return null;

    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
        const tag = m[0];
        const alt = cleanAlt((tag.match(/\balt="([^"]*)"/i) || [])[1]);

        // Internal media is snapshotted src-less as <img data-bms-asset="N">, so this branch has to
        // come first: such a tag has no src to find, and skipping it would step over the very
        // images the author uploaded in favour of an external one further down.
        const assetId = Number((tag.match(/\bdata-bms-asset="(\d+)"/i) || [])[1]);
        if (Number.isInteger(assetId) && assetId > 0) return { kind: 'asset', assetId, alt };

        const src = (tag.match(/\bsrc="([^"]*)"/i) || [])[1];
        if (isUsableExternalUrl(src)) return { kind: 'url', url: src, alt };

        // An <img> we cannot use (http, data:, src-less and asset-less) does not end the search —
        // the next one along may well be fine.
    }
    return null;
}

/**
 * The card image for a published post, from its `published_payload`.
 *
 * Pure: it decides WHICH image, never fetches one. Callers store the reference and resolve it at
 * read time, so this can be run at publish time without the answer going stale.
 */
export function pickCardImage(payload: unknown): CardImageRef {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;

    const featureId = Number(p.featureImage?.assetId);
    if (Number.isInteger(featureId) && featureId > 0) {
        return { kind: 'asset', assetId: featureId, alt: cleanAlt(p.featureImage?.alt) };
    }
    // A feature image given as a plain URL rather than an uploaded asset. Rare, but the payload
    // shape allows it and falling straight through to the body would ignore an explicit choice.
    if (isUsableExternalUrl(p.featureImage?.url)) {
        return { kind: 'url', url: p.featureImage.url, alt: cleanAlt(p.featureImage?.alt) };
    }

    return firstBodyImage(p.html);
}

/** The three columns a card image occupies when denormalised onto a row. */
export interface CardImageColumns {
    cardImageAssetId: number | null;
    cardImageUrl: string | null;
    cardImageAlt: string | null;
}

/** Flatten a reference for storage. Always returns all three, so a re-publish CLEARS a removed image. */
export function cardImageColumns(ref: CardImageRef): CardImageColumns {
    if (ref?.kind === 'asset') return { cardImageAssetId: ref.assetId, cardImageUrl: null, cardImageAlt: ref.alt };
    if (ref?.kind === 'url') return { cardImageAssetId: null, cardImageUrl: ref.url, cardImageAlt: ref.alt };
    return { cardImageAssetId: null, cardImageUrl: null, cardImageAlt: null };
}

/** Read a stored reference back out of a row. */
export function cardImageRef(row: Partial<CardImageColumns>): CardImageRef {
    if (row.cardImageAssetId) return { kind: 'asset', assetId: row.cardImageAssetId, alt: row.cardImageAlt ?? null };
    if (isUsableExternalUrl(row.cardImageUrl)) return { kind: 'url', url: row.cardImageUrl, alt: row.cardImageAlt ?? null };
    return null;
}
