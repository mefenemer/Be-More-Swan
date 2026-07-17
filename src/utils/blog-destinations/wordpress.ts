// src/utils/blog-destinations/wordpress.ts
// WordPress (self-hosted) adapter. REST API POST /wp-json/wp/v2/posts with HTML `content`; auth =
// Application Password over HTTP Basic (WP >= 5.6). Docs:
// https://developer.wordpress.org/rest-api/  (verified 2026-07-07)

import type { BlogDestinationAdapter, BlogDestinationPost, WordpressCreds } from './types';

/** Trim trailing slashes so `${base}/wp-json/...` is well-formed. */
export function normaliseSiteUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '');
}

function basicAuth(creds: WordpressCreds): string {
    // App passwords are displayed in space-separated groups; they work with the spaces removed.
    const token = Buffer.from(`${creds.username}:${creds.appPassword.replace(/\s+/g, '')}`).toString('base64');
    return `Basic ${token}`;
}

/** Pure request-body builder (tags pre-resolved to term IDs) — the unit-tested core. */
export function buildWordpressPost(post: BlogDestinationPost, opts: { publish: boolean; tagIds: number[] }) {
    const body: Record<string, unknown> = {
        title: post.title,
        content: post.bodyHtml || post.bodyMarkdown,
        status: opts.publish ? 'publish' : 'draft',
    };
    if (post.metaDescription) body.excerpt = post.metaDescription;
    if (opts.tagIds.length) body.tags = opts.tagIds;
    return body;
}

/** Resolve tag names to term IDs (find-or-create). Best-effort: any failure yields []. */
async function resolveTagIds(base: string, auth: string, names: string[]): Promise<number[]> {
    const ids: number[] = [];
    try {
        for (const name of names.slice(0, 10)) {
            const found = await fetch(`${base}/wp-json/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=100`, {
                headers: { Authorization: auth },
            });
            if (found.ok) {
                const matches = (await found.json()) as { id: number; name: string }[];
                const exact = matches.find((m) => m.name.toLowerCase() === name.toLowerCase());
                if (exact) { ids.push(exact.id); continue; }
            }
            const created = await fetch(`${base}/wp-json/wp/v2/tags`, {
                method: 'POST',
                headers: { Authorization: auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (created.ok) ids.push(((await created.json()) as { id: number }).id);
        }
    } catch {
        return [];
    }
    return ids;
}

export const wordpressAdapter: BlogDestinationAdapter<WordpressCreds> = {
    id: 'wordpress',
    label: 'WordPress',
    supportsDraft: true,
    credFields: [
        { key: 'siteUrl', label: 'Site URL', secret: false, help: 'e.g. https://blog.example.com' },
        { key: 'username', label: 'Username', secret: false },
        { key: 'appPassword', label: 'Application Password', secret: true, help: 'Users → Profile → Application Passwords.' },
    ],

    parseCreds(input) {
        const siteUrl = normaliseSiteUrl(typeof input.siteUrl === 'string' ? input.siteUrl : '');
        const username = typeof input.username === 'string' ? input.username.trim() : '';
        const appPassword = typeof input.appPassword === 'string' ? input.appPassword : '';
        if (!/^https?:\/\//.test(siteUrl)) return { ok: false, error: 'A site URL starting with http(s):// is required.' };
        if (!username) return { ok: false, error: 'A WordPress username is required.' };
        if (!appPassword.trim()) return { ok: false, error: 'A WordPress Application Password is required.' };
        return { ok: true, creds: { siteUrl, username, appPassword } };
    },

    async validate(creds) {
        try {
            const res = await fetch(`${creds.siteUrl}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: basicAuth(creds) } });
            if (res.status === 401 || res.status === 403) return { ok: false, error: 'WordPress rejected the username / application password.' };
            if (!res.ok) return { ok: false, error: `WordPress returned ${res.status}. Check the site URL.` };
            const me = (await res.json()) as { name?: string };
            const host = creds.siteUrl.replace(/^https?:\/\//, '');
            return { ok: true, accountLabel: me.name ? `${me.name} · ${host}` : host };
        } catch {
            return { ok: false, error: 'Could not reach the WordPress site.' };
        }
    },

    async publish(post, creds, opts = {}) {
        const { externalId, asDraft } = opts;
        const auth = basicAuth(creds);
        const tagIds = await resolveTagIds(creds.siteUrl, auth, post.tags);
        const body = JSON.stringify(buildWordpressPost(post, { publish: !asDraft, tagIds }));
        const url = externalId
            ? `${creds.siteUrl}/wp-json/wp/v2/posts/${externalId}`
            : `${creds.siteUrl}/wp-json/wp/v2/posts`;
        const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`WordPress publish failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = (await res.json()) as { id?: number; link?: string; status?: string };
        return { externalId: String(data.id ?? externalId ?? ''), url: data.link ?? '', status: data.status === 'publish' ? 'published' : 'draft' };
    },
};
