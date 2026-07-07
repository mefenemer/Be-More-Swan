// src/utils/blog-destinations/ghost.ts
// Ghost adapter. Admin API POST /ghost/api/admin/posts/?source=html; auth = a short-lived JWT signed
// from the Admin API key (`id:secret`, secret is hex), sent as `Authorization: Ghost <jwt>`.
// Docs: https://ghost.org/docs/admin-api/  (verified 2026-07-07)

import jwt from 'jsonwebtoken';
import type { BlogDestinationAdapter, BlogDestinationPost, GhostCreds } from './types';

/** Ghost admin base, trailing slashes trimmed. */
export function ghostAdminBase(apiUrl: string): string {
    return `${String(apiUrl || '').trim().replace(/\/+$/, '')}/ghost/api/admin`;
}

/** Sign the 5-minute Admin API JWT from an `id:secret` key (secret is hex). */
export function signGhostToken(adminApiKey: string): string {
    const [id, secret] = adminApiKey.split(':');
    return jwt.sign({}, Buffer.from(secret, 'hex'), {
        keyid: id,
        algorithm: 'HS256',
        expiresIn: '5m',
        audience: '/admin/',
    });
}

/** Pure post-body builder — the unit-tested core. */
export function buildGhostPost(post: BlogDestinationPost, opts: { publish: boolean }) {
    const p: Record<string, unknown> = {
        title: post.title,
        html: post.bodyHtml || post.bodyMarkdown,
        status: opts.publish ? 'published' : 'draft',
        tags: post.tags.map((name) => ({ name })),
    };
    if (post.canonicalUrl) p.canonical_url = post.canonicalUrl;
    if (post.metaDescription) p.custom_excerpt = post.metaDescription.slice(0, 300); // Ghost caps at 300
    return { posts: [p] };
}

async function ghostFetch(base: string, token: string, path: string, init?: RequestInit) {
    return fetch(`${base}${path}`, {
        ...init,
        headers: { Authorization: `Ghost ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
}

export const ghostAdapter: BlogDestinationAdapter<GhostCreds> = {
    id: 'ghost',
    label: 'Ghost',
    credFields: [
        { key: 'apiUrl', label: 'Site URL', secret: false, help: 'e.g. https://blog.example.com' },
        { key: 'adminApiKey', label: 'Admin API Key', secret: true, help: 'Ghost → Settings → Integrations → Custom.' },
    ],

    parseCreds(input) {
        const apiUrl = String(typeof input.apiUrl === 'string' ? input.apiUrl : '').trim().replace(/\/+$/, '');
        const adminApiKey = typeof input.adminApiKey === 'string' ? input.adminApiKey.trim() : '';
        if (!/^https?:\/\//.test(apiUrl)) return { ok: false, error: 'A site URL starting with http(s):// is required.' };
        if (!/^[a-f0-9]+:[a-f0-9]+$/i.test(adminApiKey)) return { ok: false, error: 'The Admin API Key must be in id:secret form.' };
        return { ok: true, creds: { apiUrl, adminApiKey } };
    },

    async validate(creds) {
        try {
            const base = ghostAdminBase(creds.apiUrl);
            const res = await ghostFetch(base, signGhostToken(creds.adminApiKey), '/users/me/?limit=1');
            if (res.status === 401 || res.status === 403) return { ok: false, error: 'Ghost rejected the Admin API Key.' };
            if (!res.ok) return { ok: false, error: `Ghost returned ${res.status}. Check the site URL.` };
            const data = (await res.json()) as { users?: { name?: string }[] };
            const host = creds.apiUrl.replace(/^https?:\/\//, '');
            return { ok: true, accountLabel: data.users?.[0]?.name ? `${data.users[0].name} · ${host}` : host };
        } catch {
            return { ok: false, error: 'Could not reach the Ghost site.' };
        }
    },

    async publish(post, creds, externalId) {
        const base = ghostAdminBase(creds.apiUrl);
        const token = signGhostToken(creds.adminApiKey);
        const payload = buildGhostPost(post, { publish: true });

        if (externalId) {
            // Ghost requires the current updated_at on edit (collision detection).
            const cur = await ghostFetch(base, token, `/posts/${externalId}/`);
            if (cur.ok) {
                const existing = (await cur.json()) as { posts?: { updated_at?: string }[] };
                const updatedAt = existing.posts?.[0]?.updated_at;
                if (updatedAt) (payload.posts[0] as Record<string, unknown>).updated_at = updatedAt;
            }
            const res = await ghostFetch(base, token, `/posts/${externalId}/?source=html`, { method: 'PUT', body: JSON.stringify(payload) });
            if (!res.ok) throw new Error(`Ghost update failed (${res.status})`);
            const data = (await res.json()) as { posts?: { id?: string; url?: string }[] };
            const p = data.posts?.[0];
            return { externalId: String(p?.id ?? externalId), url: p?.url ?? '', status: 'published' };
        }

        const res = await ghostFetch(base, token, '/posts/?source=html', { method: 'POST', body: JSON.stringify(payload) });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Ghost publish failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = (await res.json()) as { posts?: { id?: string; url?: string }[] };
        const p = data.posts?.[0];
        return { externalId: String(p?.id ?? ''), url: p?.url ?? '', status: 'published' };
    },
};
