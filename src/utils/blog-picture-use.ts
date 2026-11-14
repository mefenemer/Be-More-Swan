// src/utils/blog-picture-use.ts — which articles use which picture, for the Blog Writing Assistant's chat
// (FR#28, owner 2026-11-14: "has this picture already been used in another article?" had no answer).
//
// A picture is "used" by an article when it is the article's feature picture (feature_asset_id), its card
// picture (card_image_asset_id), one of its linked media (blog_post_assets), or a picture in its text
// (`:::media{… asset=N …}` or `![…](asset://N)`, the forms blog-picture-swap.ts edits). Archived and rejected
// articles are left out. The pure parts are pinned by tests/blog-picture-use.test.ts.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export type PictureRole = 'feature picture' | 'card picture' | 'in the text' | 'attached';
export interface PictureUseArticle {
    id: number;
    title: string;
    status: string;
    featureAssetId: number | null;
    cardImageAssetId: number | null;
    linkedAssetIds: number[];
    body: string | null;
}
export interface PictureUse { assetId: number; name: string | null; uses: Array<{ articleId: number; title: string; status: string; roles: PictureRole[] }> }

/** Every asset id a blog body shows, in order, once each. Pure. */
export function bodyPictureIds(body: string | null | undefined): number[] {
    const text = String(body || '');
    const ids: number[] = [];
    const add = (v: string) => { const n = Number(v); if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n); };
    for (const m of text.matchAll(/:::media\{([^}]*)\}/g)) {
        const a = /\basset\s*=\s*["']?(\d+)/.exec(m[1]);
        if (a) add(a[1]);
    }
    for (const m of text.matchAll(/!\[[^\]]*\]\(asset:\/\/(\d+)\)/g)) add(m[1]);
    return ids;
}

/** Group articles by the pictures they use; most-used first, then newest picture id. Pure. */
export function collectPictureUse(articles: PictureUseArticle[], names: Map<number, string>): PictureUse[] {
    const by = new Map<number, PictureUse>();
    const mark = (assetId: number | null, a: PictureUseArticle, role: PictureRole) => {
        if (!assetId) return;
        let p = by.get(assetId);
        if (!p) { p = { assetId, name: names.get(assetId) ?? null, uses: [] }; by.set(assetId, p); }
        let u = p.uses.find((x) => x.articleId === a.id);
        if (!u) { u = { articleId: a.id, title: a.title, status: a.status, roles: [] }; p.uses.push(u); }
        if (!u.roles.includes(role)) u.roles.push(role);
    };
    for (const a of articles) {
        mark(a.featureAssetId, a, 'feature picture');
        mark(a.cardImageAssetId, a, 'card picture');
        const inText = bodyPictureIds(a.body);
        for (const id of inText) mark(id, a, 'in the text');
        for (const id of a.linkedAssetIds) if (!inText.includes(id) && id !== a.featureAssetId && id !== a.cardImageAssetId) mark(id, a, 'attached');
    }
    return [...by.values()].sort((x, y) => (y.uses.length - x.uses.length) || (y.assetId - x.assetId));
}

const MAX_PICTURES = 80;
const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The chat block. Pure. */
export function renderPictureUseForChat(list: PictureUse[]): string {
    const head = 'PICTURES IN YOUR ARTICLES — which article uses which picture (feature picture, card picture, in the text, or attached). '
        + 'Answer "has this picture been used?" or "where is this picture?" from this list only, by picture number (#id, as in My Content) or name. '
        + 'A picture that is not listed is in none of these articles (archived and rejected articles are not counted).';
    if (!list.length) return `${head}\n(No article uses a picture yet.)`;
    const lines = list.slice(0, MAX_PICTURES).map((p) => {
        const uses = p.uses.map((u) => `#${u.articleId} "${clip(u.title || 'Untitled')}" (${u.status.replace(/_/g, ' ')}; ${u.roles.join(', ')})`).join('; ');
        return `- picture #${p.assetId}${p.name ? ` "${clip(p.name, 50)}"` : ''} — used in ${p.uses.length} article${p.uses.length === 1 ? '' : 's'}: ${uses}`;
    });
    const more = list.length > MAX_PICTURES ? `\n(and ${list.length - MAX_PICTURES} more pictures used once each or in older articles — not listed; say you can only see these.)` : '';
    return `${head}\n${lines.join('\n')}${more}`;
}

/** Read this assistant's articles and their pictures. */
export async function loadBlogPictureUse(db: Db, organisationId: number, aiAssistantId: number): Promise<PictureUse[]> {
    const rows = await db.execute<{ id: number; title: string | null; status: string; feature_asset_id: number | null; card_image_asset_id: number | null; body_markdown: string | null; linked: number[] | null }>(sql`
        SELECT p.id, p.title, p.status, p.feature_asset_id, p.card_image_asset_id, p.body_markdown,
               (SELECT array_agg(a.content_asset_id ORDER BY a.position) FROM blog_post_assets a WHERE a.blog_post_id = p.id) AS linked
          FROM blog_posts p
         WHERE p.organisation_id = ${organisationId} AND p.assistant_id = ${aiAssistantId}
           AND p.status NOT IN ('archived', 'rejected')
         ORDER BY p.id DESC
         LIMIT 400`);
    const articles: PictureUseArticle[] = (rows as unknown as Array<Record<string, any>>).map((r) => ({
        id: Number(r.id), title: String(r.title || ''), status: String(r.status),
        featureAssetId: r.feature_asset_id != null ? Number(r.feature_asset_id) : null,
        cardImageAssetId: r.card_image_asset_id != null ? Number(r.card_image_asset_id) : null,
        linkedAssetIds: (r.linked || []).map(Number), body: r.body_markdown ?? null,
    }));
    const ids = [...new Set(articles.flatMap((a) => [a.featureAssetId, a.cardImageAssetId, ...a.linkedAssetIds, ...bodyPictureIds(a.body)]).filter((x): x is number => !!x))];
    const names = new Map<number, string>();
    if (ids.length) {
        const n = await db.execute<{ id: number; name: string }>(sql`
            SELECT id, name FROM content_assets WHERE organisation_id = ${organisationId} AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
        for (const r of n as unknown as Array<{ id: number; name: string }>) names.set(Number(r.id), r.name);
    }
    return collectPictureUse(articles, names);
}
