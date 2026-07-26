// src/utils/post-link.ts
// The link a social post carries, and how it reaches the platforms.
//
// scheduled_posts has held link_url / cta_text since the table was created, the PATCH endpoint has
// always accepted them and the composer preview has always drawn them — but nothing ever put them
// into the text a publisher sends, and no input existed to type one. This module is the missing
// half: ONE place that decides what a link looks like in a published post, shared by every
// publisher so the answer cannot quietly differ per platform.
//
// Deliberately not a shortener and not a tracker: what the user typed is what goes out. (The
// utm_params column is still unwired — see scheduled-posts.ts's editable-field list.)

export interface PostLinkFields {
    caption?: string | null;
    hashtags?: string | null;
    linkUrl?: string | null;
    ctaText?: string | null;
}

/**
 * A link we are willing to publish, or null.
 *
 * http(s) only. The composer renders this value into an `<a href>` in the mock-up, so a
 * `javascript:` or `data:` "URL" reaching the preview is a script-injection vector, not just a
 * broken link — and a publisher appending one to a caption puts it in front of every follower.
 */
export function normalisePostLink(raw: unknown): string | null {
    const s = String(raw ?? '').trim();
    if (!s || /\s/.test(s)) return null;
    // "example.com/offer" is what people actually type. Assume https when there is NO scheme at
    // all — but never rewrite one that is present, so a bad scheme is rejected rather than repaired.
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
    let url: URL;
    try { url = new URL(candidate); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // A bare host with no dot ("https://localhost", "https://x") is not something to put in a post.
    if (!url.hostname.includes('.')) return null;
    return candidate;
}

/**
 * The link as one line of post text — "Read the full story https://…", or the bare URL when there
 * is no call to action.
 *
 * Returns null when the caption already contains the link, which is the common case for a caption
 * the assistant wrote around a URL: appending it again would publish the address twice. Both the
 * raw and the normalised forms are checked, so typing `example.com` in the link field does not
 * duplicate an `https://example.com` already in the words.
 */
export function postLinkLine(post: PostLinkFields): string | null {
    const url = normalisePostLink(post.linkUrl);
    if (!url) return null;
    const caption = String(post.caption ?? '');
    const raw = String(post.linkUrl ?? '').trim();
    if (caption.includes(url) || (raw && caption.includes(raw))) return null;
    // A CTA is a label, not a paragraph: newlines in it would split the link off its own line.
    const cta = String(post.ctaText ?? '').replace(/\s+/g, ' ').trim();
    return cta ? `${cta} ${url}` : url;
}

/**
 * The exact text a platform receives: caption, hashtags, link — each its own paragraph.
 *
 * Every publisher composes through here so the link is not a per-driver afterthought. It also keeps
 * the X credit hold honest: xPostCost/xPostHasLink are computed from this string, and a post billed
 * before the link was appended would be charged at the text rate and published at the link rate.
 */
export function composePostText(post: PostLinkFields): string {
    const caption = String(post.caption ?? '').trim();
    const hashtags = String(post.hashtags ?? '').trim();
    return [caption, hashtags, postLinkLine(post)].filter(Boolean).join('\n\n').trim();
}
