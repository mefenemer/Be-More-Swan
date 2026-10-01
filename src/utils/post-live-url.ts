// src/utils/post-live-url.ts
// The public address of a post once it has gone out, built from the id the platform handed back.
//
// ⚠️ Why this exists: "Post published to LinkedIn" notifications offered nothing to click. The
// scheduled_posts.platform_post_url column existed for exactly this, but only the YouTube publisher
// ever filled it. For the platforms whose post URL is a pure function of the id, it is built here;
// Instagram and Threads need a permalink lookup (their ids are opaque) — see publish-instagram.ts.
//
// Returns null when the URL cannot be derived. The caller then offers the post in the app instead.
export function livePostUrl(platform: string | null | undefined, platformPostId: string | null | undefined): string | null {
    const id = String(platformPostId || '').trim();
    if (!id) return null;
    switch (String(platform || '').toLowerCase()) {
        // urn:li:share:… / urn:li:ugcPost:… — the feed update URL takes the URN verbatim.
        case 'linkedin': return id.startsWith('urn:li:') ? `https://www.linkedin.com/feed/update/${id}/` : null;
        // A Page post id is "<pageId>_<postId>"; facebook.com resolves it directly.
        case 'facebook': return /^[\d_]+$/.test(id) ? `https://www.facebook.com/${id}` : null;
        case 'x':
        case 'twitter': return /^\d+$/.test(id) ? `https://x.com/i/web/status/${id}` : null;
        case 'youtube': return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
        default: return null;
    }
}
