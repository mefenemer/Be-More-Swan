// src/utils/blog-destinations/wordpresscom.ts
// WordPress.com adapter (Tier 2 — OAuth). Unlike self-hosted WordPress, creds come from the shared
// OAuth integration (access token + authorised blog id), not a paste form. Publishes via the WP.com
// REST v1.1 API, which takes HTML content and comma-separated tag names (no term-ID resolution).
// Docs: https://developer.wordpress.com/docs/api/  (verified 2026-07-07)

import type { BlogDestinationAdapter, BlogDestinationPost, WordpresscomCreds } from './types';

const API = 'https://public-api.wordpress.com/rest/v1.1';

/** Pure request-body builder — the unit-tested core. */
export function buildWordpresscomPost(post: BlogDestinationPost, opts: { publish: boolean }) {
    const body: Record<string, unknown> = {
        title: post.title,
        content: post.bodyHtml || post.bodyMarkdown,
        status: opts.publish ? 'publish' : 'draft',
    };
    if (post.tags.length) body.tags = post.tags.join(',');
    if (post.metaDescription) body.excerpt = post.metaDescription;
    return body;
}

export const wordpresscomAdapter: BlogDestinationAdapter<WordpresscomCreds> = {
    id: 'wordpresscom',
    label: 'WordPress.com',
    authKind: 'oauth',
    oauthProvider: 'wordpresscom',
    supportsDraft: true,
    credFields: [], // OAuth — connected via the /api/oauth flow, no paste form.

    // parseCreds/validate are only used by the paste-connect endpoint; OAuth connects elsewhere.
    parseCreds() {
        return { ok: false, error: 'WordPress.com connects via OAuth, not a credential form.' };
    },
    async validate() {
        return { ok: false, error: 'WordPress.com connects via OAuth.' };
    },

    async publish(post, creds, opts = {}) {
        const { externalId, asDraft } = opts;
        const url = externalId
            ? `${API}/sites/${encodeURIComponent(creds.siteId)}/posts/${externalId}`
            : `${API}/sites/${encodeURIComponent(creds.siteId)}/posts/new`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildWordpresscomPost(post, { publish: !asDraft })),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`WordPress.com publish failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = (await res.json()) as { ID?: number; URL?: string; status?: string };
        return { externalId: String(data.ID ?? externalId ?? ''), url: data.URL ?? '', status: data.status === 'publish' ? 'published' : 'draft' };
    },
};
