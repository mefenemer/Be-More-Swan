// src/utils/blog-destinations/devto.ts
// Dev.to (Forem) adapter. Markdown-native: POST /api/articles with body_markdown, `api-key` header.
// Docs: https://developers.forem.com/api/v1  (verified 2026-07-07)

import type { BlogDestinationAdapter, BlogDestinationPost, DevtoCreds } from './types';
import { slugifyTag } from './types';

const API = 'https://dev.to/api';
const ACCEPT = 'application/vnd.forem.api-v1+json';

/** Dev.to tags: max 4, lowercase alphanumeric only (hyphens stripped — Forem rejects them). */
export function normaliseDevtoTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tags || []) {
        const clean = slugifyTag(t).replace(/-/g, '');
        if (clean && !seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
            if (out.length === 4) break;
        }
    }
    return out;
}

/** Pure request-body builder — the unit-tested core of the adapter. */
export function buildDevtoArticle(post: BlogDestinationPost, opts: { publish: boolean }) {
    const article: Record<string, unknown> = {
        title: post.title,
        body_markdown: post.bodyMarkdown,
        published: opts.publish,
        tags: normaliseDevtoTags(post.tags),
    };
    if (post.canonicalUrl) article.canonical_url = post.canonicalUrl;
    if (post.coverImageUrl) article.main_image = post.coverImageUrl;
    if (post.metaDescription) article.description = post.metaDescription;
    return { article };
}

function headers(creds: DevtoCreds): Record<string, string> {
    return { 'api-key': creds.apiKey, 'Content-Type': 'application/json', Accept: ACCEPT };
}

export const devtoAdapter: BlogDestinationAdapter<DevtoCreds> = {
    id: 'devto',
    label: 'Dev.to',
    credFields: [{ key: 'apiKey', label: 'API key', secret: true, help: 'dev.to → Settings → Extensions → API keys.' }],

    parseCreds(input) {
        const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
        if (!apiKey) return { ok: false, error: 'A Dev.to API key is required.' };
        return { ok: true, creds: { apiKey } };
    },

    async validate(creds) {
        try {
            const res = await fetch(`${API}/users/me`, { headers: headers(creds) });
            if (res.status === 401) return { ok: false, error: 'Dev.to rejected the API key.' };
            if (!res.ok) return { ok: false, error: `Dev.to returned ${res.status}.` };
            const me = (await res.json()) as { username?: string };
            return { ok: true, accountLabel: me.username ? `@${me.username}` : 'Dev.to' };
        } catch {
            return { ok: false, error: 'Could not reach Dev.to.' };
        }
    },

    async publish(post, creds, externalId) {
        const body = JSON.stringify(buildDevtoArticle(post, { publish: true }));
        const url = externalId ? `${API}/articles/${externalId}` : `${API}/articles`;
        const res = await fetch(url, { method: externalId ? 'PUT' : 'POST', headers: headers(creds), body });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Dev.to publish failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = (await res.json()) as { id?: number; url?: string; published?: boolean };
        return {
            externalId: String(data.id ?? externalId ?? ''),
            url: data.url ?? '',
            status: data.published ? 'published' : 'draft',
        };
    },
};
