// src/utils/blog-picture-swap.ts — find and swap one picture in a blog body by its asset id. Pure, no
// imports, so the chat card check (chat-blog-action.ts) can use it without the image pipeline.
// Used by "replace this picture" (blog-add-images.ts → replacePicture).

/** Is this asset one of the body's pictures? Pure. */
export function bodyHasPicture(body: string, assetId: number): boolean {
    return swapPicture(String(body || ''), assetId, assetId, '') !== null;
}

/**
 * Swap ONE picture for another in the same place: the first `:::media{… asset=OLD …}` (also inside a
 * column group) or `![…](asset://OLD)`. The new picture is always an image; the alt text becomes
 * `alt` when one is given; align and caption stay (they are the author's). Null when the body has no
 * such picture. Pure. Issue 35, 2026-11-10: "replace this picture" used to go to Add pictures, which
 * can only insert new ones, and answered that the article already had what it needed.
 */
export function swapPicture(body: string, oldId: number, newId: number, alt: string): string | null {
    const text = String(body || '');
    const cleanAlt = String(alt || '').replace(/["\n]/g, ' ').trim().slice(0, 140);
    const media = new RegExp(`:::media\\{([^}\\n]*?\\basset\\s*=\\s*["']?${oldId}["']?(?![\\w])[^}\\n]*)\\}`);
    const m = media.exec(text);
    if (m) {
        let attrs = m[1].replace(new RegExp(`\\basset\\s*=\\s*["']?${oldId}["']?(?![\\w])`), `asset=${newId}`);
        attrs = /\btype\s*=/.test(attrs) ? attrs.replace(/\btype\s*=\s*(?:"[^"]*"|'[^']*'|[^\s}]+)/, 'type=image') : `${attrs} type=image`;
        if (cleanAlt) {
            attrs = /\balt\s*=/.test(attrs)
                ? attrs.replace(/\balt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s}]+)/, `alt="${cleanAlt}"`)
                : `${attrs} alt="${cleanAlt}"`;
        }
        return text.slice(0, m.index) + `:::media{${attrs.trim()}}` + text.slice(m.index + m[0].length);
    }
    const md = new RegExp(`!\\[([^\\]]*)\\]\\(asset://${oldId}\\)`);
    const i = md.exec(text);
    if (i) return text.slice(0, i.index) + `![${cleanAlt || i[1]}](asset://${newId})` + text.slice(i.index + i[0].length);
    return null;
}
