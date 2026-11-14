// src/utils/blog-keywords.ts
// A blog article's KEYWORDS — blog_posts.tags. One field, two public jobs:
//   - the categories readers browse by on the widget and the hosted blog (listBlogFacets), and
//   - the search keywords in the article's page (<meta name="keywords"> + JSON-LD, blog-seo.ts).
//
// Until 2026-11-14 only the AI SEO step wrote them and nobody could change them: no box in Blog
// Studio, nothing blog-wide, nothing in chat. A customer whose blog moved from employee wellness to
// women approaching retirement was left with the old keywords on every article, and every new
// article was told to reuse them. This file holds the rules every writer shares — Blog Studio's
// keyword box, the blog-wide list in Blog setup, the chat cards and the SEO step — so a keyword
// typed by hand and one the AI chose look and behave the same.
//
// The customer-facing word is "keywords" (what customers call them). Code keeps `tags`.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

/** Keywords per article. The SEO step writes 1–3; more and the blog's category menu sprawls. */
export const MAX_KEYWORDS = 3;
/** Longest keyword. Categories are browse labels ("retirement planning"), not sentences. */
export const KEYWORD_MAX_LENGTH = 40;

/** One keyword as stored: trimmed, lowercase, single-spaced, no stray punctuation at the ends. */
export function cleanKeyword(v: unknown): string {
    return String(v ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[#,;.\s]+|[,;.\s]+$/g, '')
        .toLowerCase()
        .slice(0, KEYWORD_MAX_LENGTH)
        .trim();
}

/**
 * An article's keyword list as stored: cleaned, blanks dropped, duplicates removed (first one
 * wins), at most MAX_KEYWORDS. Accepts an array or a comma-separated string. Pure.
 */
export function normalizeKeywords(input: unknown): string[] {
    const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
    const out: string[] = [];
    for (const raw of list) {
        const k = cleanKeyword(raw);
        if (k && !out.includes(k)) out.push(k);
        if (out.length >= MAX_KEYWORDS) break;
    }
    return out;
}

export interface BlogKeywordRow {
    keyword: string;
    /** Articles that carry it, archived ones left out. */
    articles: number;
    /** Of those, live on the blog — the ones readers see it on. */
    published: number;
}

/** Every keyword this workspace's blog uses, most-used first. Archived articles don't count. */
export async function listBlogKeywords(db: Db, organisationId: number): Promise<BlogKeywordRow[]> {
    const r: any = await db.execute(sql`
        SELECT lower(btrim(t.tag)) AS keyword,
               count(DISTINCT p.id)::int AS articles,
               count(DISTINCT p.id) FILTER (WHERE p.status = 'published')::int AS published
          FROM blog_posts p,
               jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.tags) = 'array' THEN p.tags ELSE '[]'::jsonb END) AS t(tag)
         WHERE p.organisation_id = ${organisationId} AND p.status <> 'archived' AND btrim(t.tag) <> ''
         GROUP BY 1
         ORDER BY published DESC, articles DESC, keyword`);
    const rows: any[] = Array.isArray(r) ? r : r?.rows || [];
    return rows.map((x) => ({ keyword: String(x.keyword), articles: Number(x.articles) || 0, published: Number(x.published) || 0 }));
}

export type KeywordChange =
    | { ok: true; articles: number }
    | { ok: false; error: string };

/**
 * Rename a keyword on every article in the workspace (archived ones too, so a restored article
 * doesn't bring the old word back). Renaming to a keyword that already exists MERGES them: an
 * article carrying both keeps one. Matching ignores case. Order is kept.
 */
export async function renameBlogKeyword(db: Db, organisationId: number, from: unknown, to: unknown): Promise<KeywordChange> {
    const f = cleanKeyword(from);
    const t = cleanKeyword(to);
    if (!f) return { ok: false, error: 'Say which keyword to change.' };
    if (!t) return { ok: false, error: 'Type the new keyword.' };
    if (f === t) return { ok: true, articles: 0 };
    const r: any = await db.execute(sql`
        UPDATE blog_posts p
           SET tags = (
                 SELECT coalesce(jsonb_agg(s.k ORDER BY s.first), '[]'::jsonb)
                   FROM (SELECT CASE WHEN lower(btrim(e)) = ${f} THEN ${t} ELSE e END AS k, min(ord) AS first
                           FROM jsonb_array_elements_text(p.tags) WITH ORDINALITY AS a(e, ord)
                          GROUP BY 1) s),
               updated_at = now()
         WHERE p.organisation_id = ${organisationId}
           AND jsonb_typeof(p.tags) = 'array'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.tags) e WHERE lower(btrim(e)) = ${f})
        RETURNING p.id`);
    const rows: any[] = Array.isArray(r) ? r : r?.rows || [];
    return { ok: true, articles: rows.length };
}

/** Take a keyword off every article in the workspace. Matching ignores case. */
export async function removeBlogKeyword(db: Db, organisationId: number, keyword: unknown): Promise<KeywordChange> {
    const k = cleanKeyword(keyword);
    if (!k) return { ok: false, error: 'Say which keyword to remove.' };
    const r: any = await db.execute(sql`
        UPDATE blog_posts p
           SET tags = (SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb)
                         FROM jsonb_array_elements_text(p.tags) WITH ORDINALITY AS a(e, ord)
                        WHERE lower(btrim(e)) <> ${k}),
               updated_at = now()
         WHERE p.organisation_id = ${organisationId}
           AND jsonb_typeof(p.tags) = 'array'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.tags) e WHERE lower(btrim(e)) = ${k})
        RETURNING p.id`);
    const rows: any[] = Array.isArray(r) ? r : r?.rows || [];
    return { ok: true, articles: rows.length };
}
