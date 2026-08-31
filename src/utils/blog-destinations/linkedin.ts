// src/utils/blog-destinations/linkedin.ts
// LinkedIn adapter — destination #7, and the only SOCIAL one.
//
// ── Why it is a blog destination and not a social platform ─────────────────────────────────────
// LinkedIn already publishes through the social pipeline (approve-post → publish-social-posts),
// but that pipeline belongs to the Social Media Manager: it takes a scheduled_posts row with a
// caption and media, and the Blog Writer creates neither. Adding 'social' to blog_writer in
// connection-map.ts would also have handed a blog role the whole social grid (Instagram, TikTok,
// YouTube…) — the exact regression docs/[[blog-writer-desocialised]] undid.
//
// As an adapter it inherits, from syndicate.ts, everything the author already expects of a blog
// destination: the per-post opt-out in Blog Studio's "Where this post gets published", the EU AI
// Act Art. 50 disclosure, failure isolation, and one status line beside the post.
//
// ── How it differs from the other six ──────────────────────────────────────────────────────────
// 1. `authKind: 'social'`. The token lives in system_connections (the LinkedIn OAuth the workspace
//    may already have connected for its Social Media Manager), so store.ts resolves creds through
//    resolveSocialCredentials rather than the blog vault. Because that connection is SHARED, being
//    connected is not consent to syndicate: the destination carries its own opt-in, and
//    disconnecting it here never touches the workspace's LinkedIn connection. See store.ts.
// 2. It publishes a SHARE, not the article. `w_member_social` posts to the member's own feed with a
//    3,000-character commentary and no title field (see src/config/linkedin-capabilities.ts —
//    Company Pages and the article API both need Community Management access we do not have). So
//    the body is trimmed to a lede and the canonical URL carries the reader to the real post; that
//    is also what keeps LinkedIn from competing with the author's own page in search.
// 3. It cannot update, and never re-posts. LinkedIn's ugcPosts has no edit; a second push would be
//    a second post in the feed, not a correction. A re-publish therefore reports the ORIGINAL share.

import type { BlogDestinationAdapter, BlogDestinationPost, LinkedinCreds } from './types';
import { BLOG_AI_NOTICE } from '../blog-ai-assisted';

/** ugcPosts shareCommentary limit. Mirrors the 3000 default in src/utils/platform-caption.ts. */
export const LINKEDIN_TEXT_LIMIT = 3000;

/** Below this there is no room for a lede worth reading, so the share goes out as title + link. */
const MIN_LEDE_CHARS = 120;

/** Hashtags carried over from the post's tags. Three is the LinkedIn convention; ten reads as spam. */
const MAX_HASHTAGS = 3;

/**
 * Markdown → the plain text a LinkedIn commentary can hold. LinkedIn renders NO markup at all, so
 * an unstripped body arrives with its `##` and `**` visible.
 *
 * Deliberately a small regex pass rather than `marked` + sanitize-html (what excerpt() in
 * markdown-render.ts does): this keeps the builder pure and synchronous so it is unit-testable
 * without a dynamic import, and the input is already media-stripped by projectPost().
 */
export function markdownToPlain(markdown: string): string {
    let text = String(markdown || '');
    text = text.replace(/^---\n[\s\S]*?\n---\n/, '');           // front matter
    text = text.replace(/```[\s\S]*?```/g, '');                 // fenced code
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');           // images
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');        // links → their text
    text = text.replace(/<[^>]+>/g, '');                        // stray inline HTML
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');             // heading hashes
    text = text.replace(/^\s{0,3}>\s?/gm, '');                  // blockquote markers
    text = text.replace(/^\s{0,3}(?:\*[ \t]*){3,}$/gm, '');       // thematic break ***
    text = text.replace(/^\s{0,3}(?:-[ \t]*){3,}$/gm, '');        // thematic break ---
    text = text.replace(/^\s{0,3}(?:_[ \t]*){3,}$/gm, '');        // thematic break ___
    text = text.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '• ');    // list markers → a bullet
    text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');             // bold
    text = text.replace(/(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])/g, '$1'); // italic *…*
    text = text.replace(/(?<![\w_])_(?!\s)([^_]+?)(?<!\s)_(?![\w_])/g, '$1');   // italic _…_
    text = text.replace(/`([^`]+)`/g, '$1');                    // inline code
    text = text.replace(/[ \t]+$/gm, '');
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** `Web Dev` → `#WebDev`. Empty once slugged (e.g. "…") is dropped rather than posted as a bare #. */
export function toHashtag(tag: string): string | null {
    const words = String(tag || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return null;
    // Already-cased words (AI, TypeScript) keep their casing; lowercase ones are title-cased, which
    // is what makes a multi-word tag readable as a hashtag at all.
    const joined = words.map((w) => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
    return /^\d+$/.test(joined) ? null : `#${joined}`;
}

/** Trim to `max` chars on a paragraph, then sentence, then word boundary — never mid-word. */
function trimToBoundary(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const para = cut.lastIndexOf('\n\n');
    if (para > max * 0.5) return cut.slice(0, para).trimEnd() + '…';
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    if (sentence > max * 0.5) return cut.slice(0, sentence + 1).trimEnd() + '…';
    const word = cut.lastIndexOf(' ');
    return (word > max * 0.5 ? cut.slice(0, word) : cut).trimEnd() + '…';
}

export type LinkedInShareBuild =
    | { ok: true; text: string }
    | { ok: false; error: string };

/**
 * Compose the feed post. Pure, and the unit-tested core of this adapter.
 *
 * The budget is spent in one direction only: the title, the link, the AI disclosure and the
 * hashtags are FIXED, and the lede absorbs every trim. That ordering is not cosmetic — the
 * disclosure is a legal requirement (EU AI Act Art. 50) and the link is the whole point of the
 * share, so neither may be the thing that falls off the end of a long post.
 */
export function buildLinkedInShare(
    post: BlogDestinationPost,
    opts: { maxChars?: number } = {},
): LinkedInShareBuild {
    const limit = opts.maxChars ?? LINKEDIN_TEXT_LIMIT;
    const title = String(post.title || '').trim();

    // A share of an article with nowhere to read it is a truncated article. canonicalUrl is stamped
    // by publishBlogPost() for every published post (the org's own site, else our /b/:key/:slug
    // permalink), so this is a real failure worth reporting, not an ordinary state.
    const url = String(post.canonicalUrl || '').trim();
    if (!url) {
        return { ok: false, error: 'This post has no public URL yet, so there is nothing for a LinkedIn post to link to.' };
    }

    // projectPost() appends the disclosure to the markdown; carry it over verbatim rather than
    // letting it be trimmed off the end of the lede with the rest of the body.
    const body = String(post.bodyMarkdown || '');
    const disclose = body.includes(BLOG_AI_NOTICE);
    const lede = markdownToPlain(body.replace(`*${BLOG_AI_NOTICE}*`, '').replace(BLOG_AI_NOTICE, ''));

    const hashtags = (post.tags || [])
        .map(toHashtag)
        .filter((t): t is string => !!t)
        .filter((t, i, all) => all.indexOf(t) === i)
        .slice(0, MAX_HASHTAGS)
        .join(' ');

    const tail = [`Read the full post: ${url}`, disclose ? BLOG_AI_NOTICE : '', hashtags]
        .filter(Boolean)
        .join('\n\n');
    const head = title ? `${title}\n\n` : '';
    const budget = limit - head.length - tail.length - 2; // 2 = the blank line between lede and tail

    const parts = [head.trimEnd()];
    if (lede && budget >= MIN_LEDE_CHARS) parts.push(trimToBoundary(lede, budget));
    parts.push(tail);
    // A pathologically long title alone can still overrun; clamp rather than let LinkedIn 422.
    return { ok: true, text: parts.filter(Boolean).join('\n\n').slice(0, limit) };
}

/**
 * Feed permalink for a ugcPost/share URN — the only URL LinkedIn's create response gives us.
 *
 * publishLinkedIn falls back to the literal id `'posted'` when LinkedIn returns 201 with neither an
 * `x-restli-id` header nor an id in the body. That is still a successful post, but building
 * /feed/update/posted/ from it hands the author a link to a 404 and calls it their article. Send
 * them to their own feed instead — the post is the top item there.
 */
export function shareUrl(urn: string): string {
    return /^urn:li:/.test(urn)
        ? `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`
        : 'https://www.linkedin.com/feed/';
}

export const linkedinAdapter: BlogDestinationAdapter<LinkedinCreds> = {
    id: 'linkedin',
    label: 'LinkedIn',
    authKind: 'social',
    socialPlatform: 'linkedin',
    // Nothing to paste: the connection is the workspace's LinkedIn OAuth.
    credFields: [],
    // A feed post is published or it does not exist — LinkedIn has no draft state to push into.
    supportsDraft: false,

    parseCreds(input) {
        const accessToken = typeof input.accessToken === 'string' ? input.accessToken.trim() : '';
        if (!accessToken) return { ok: false, error: 'Connect LinkedIn from your Connections tab first.' };
        const authorUrn = typeof input.authorUrn === 'string' ? input.authorUrn.trim() : '';
        return { ok: true, creds: { accessToken, authorUrn } };
    },

    /**
     * Confirm the stored LinkedIn grant can still identify its member, and name them for the card.
     *
     * /v2/userinfo is the same call resolveLinkedInAuthor() makes, and the same one the OAuth
     * callback makes to learn the member id — under OpenID Connect it is the only identity endpoint
     * this app's scopes reach (/v2/me needs r_liteprofile, which we are not approved for).
     */
    async validate(creds) {
        try {
            const res = await fetch('https://api.linkedin.com/v2/userinfo', {
                headers: { Authorization: `Bearer ${creds.accessToken}` },
            });
            const data = (await res.json().catch(() => ({}))) as { sub?: string; name?: string; message?: string };
            if (!res.ok || !data.sub) {
                return {
                    ok: false,
                    error: data.message || `LinkedIn could not confirm the connection (${res.status}). Reconnect LinkedIn and try again.`,
                };
            }
            return { ok: true, accountLabel: data.name || 'LinkedIn member' };
        } catch {
            return { ok: false, error: 'Could not reach LinkedIn.' };
        }
    },

    async publish(post, creds, opts = {}) {
        const { externalId, asDraft } = opts;
        if (asDraft) throw new Error('LinkedIn cannot receive drafts — a feed post is published or it does not exist.');

        // Already shared. LinkedIn has no update for a ugcPost, so the only thing a re-publish could
        // do is post the article to the feed a SECOND time — which is what an author re-publishing a
        // corrected post least wants. Report the original share instead.
        if (externalId) {
            return { externalId, url: shareUrl(externalId), status: 'published' };
        }

        const built = buildLinkedInShare(post);
        if (!built.ok) throw new Error(built.error);

        // Lazy: social-publish.ts pulls the media/vault/S3 graph, and this module is reached from
        // index.ts, which save-blog-draft.ts imports for nothing more than isBlogDestinationId().
        const { publishLinkedIn, resolveLinkedInAuthor } = await import('../social-publish');

        let author = creds.authorUrn;
        if (!author) {
            // An older connection row may predate externalUserId being stored; ask LinkedIn rather
            // than failing on a connection that is otherwise perfectly usable.
            const resolved = await resolveLinkedInAuthor(creds.accessToken);
            if (!resolved.ok) throw new Error(resolved.error);
            author = resolved.urn;
        }

        // No media, ever: syndicated copies are text-only (our media URLs are presigned and expire,
        // and Pexels is hotlink-only) — see projectPost() in syndicate.ts. LinkedIn builds its own
        // preview card from the canonical URL, so the share is not bare.
        const result = await publishLinkedIn(built.text, creds.accessToken, author, null);
        if (!result.ok) throw new Error(result.error || 'LinkedIn rejected the post.');

        const urn = String(result.id);
        return { externalId: urn, url: shareUrl(urn), status: 'published' };
    },
};
