// src/utils/blog-destinations/hashnode.ts
// Hashnode adapter. GraphQL endpoint https://gql.hashnode.com; `publishPost` mutation with
// contentMarkdown; auth = Personal Access Token in the RAW `Authorization` header (NOT `Bearer`).
// Markdown-native. Docs: https://apidocs.hashnode.com/  (verified 2026-07-07)

import type { BlogDestinationAdapter, BlogDestinationPost, HashnodeCreds } from './types';
import { slugifyTag } from './types';

const API = 'https://gql.hashnode.com';

/** Hashnode PublishPostTagInput needs slug + name; cap at 5 (platform limit). */
export function buildHashnodeTags(tags: string[]): { slug: string; name: string }[] {
    const seen = new Set<string>();
    const out: { slug: string; name: string }[] = [];
    for (const t of tags || []) {
        const name = String(t || '').trim();
        const slug = slugifyTag(name);
        if (slug && !seen.has(slug)) {
            seen.add(slug);
            out.push({ slug, name });
            if (out.length === 5) break;
        }
    }
    return out;
}

/** Pure input builder for publishPost / updatePost — the unit-tested core. */
export function buildHashnodeInput(post: BlogDestinationPost, publicationId: string, externalId?: string) {
    const input: Record<string, unknown> = {
        title: post.title,
        contentMarkdown: post.bodyMarkdown,
        tags: buildHashnodeTags(post.tags),
    };
    if (externalId) input.id = externalId;
    else input.publicationId = publicationId;
    if (post.canonicalUrl) input.originalArticleURL = post.canonicalUrl;
    if (post.coverImageUrl) input.coverImageOptions = { coverImageURL: post.coverImageUrl };
    if (post.metaDescription) input.metaTags = { description: post.metaDescription };
    return input;
}

const PUBLISH_MUTATION =
    'mutation Publish($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }';
const UPDATE_MUTATION =
    'mutation Update($input: UpdatePostInput!) { updatePost(input: $input) { post { id url } } }';

async function gql<T>(creds: HashnodeCreds, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: creds.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const data = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (data.errors?.length) throw new Error(`Hashnode: ${data.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
    if (!res.ok || !data.data) throw new Error(`Hashnode returned ${res.status}.`);
    return data.data;
}

export const hashnodeAdapter: BlogDestinationAdapter<HashnodeCreds> = {
    id: 'hashnode',
    label: 'Hashnode',
    credFields: [
        { key: 'token', label: 'Personal Access Token', secret: true, help: 'hashnode.com → Settings → Developer.' },
        { key: 'publicationId', label: 'Publication ID', secret: false, help: 'Your blog dashboard URL contains it.' },
    ],

    parseCreds(input) {
        const token = typeof input.token === 'string' ? input.token.trim() : '';
        const publicationId = typeof input.publicationId === 'string' ? input.publicationId.trim() : '';
        if (!token) return { ok: false, error: 'A Hashnode Personal Access Token is required.' };
        if (!publicationId) return { ok: false, error: 'A Hashnode publication ID is required.' };
        return { ok: true, creds: { token, publicationId } };
    },

    async validate(creds) {
        try {
            const data = await gql<{ me?: { username?: string } }>(creds, 'query { me { username } }', {});
            return { ok: true, accountLabel: data.me?.username ?? 'Hashnode' };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Could not reach Hashnode.' };
        }
    },

    async publish(post, creds, externalId) {
        const input = buildHashnodeInput(post, creds.publicationId, externalId);
        const data = externalId
            ? await gql<{ updatePost: { post: { id: string; url: string } } }>(creds, UPDATE_MUTATION, { input })
            : await gql<{ publishPost: { post: { id: string; url: string } } }>(creds, PUBLISH_MUTATION, { input });
        const p = externalId ? (data as any).updatePost.post : (data as any).publishPost.post;
        return { externalId: String(p.id), url: p.url, status: 'published' };
    },
};
