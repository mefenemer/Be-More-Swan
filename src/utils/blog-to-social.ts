// src/utils/blog-to-social.ts — the Social Media Assistant reads the ARTICLE, not just its title (FR#12,
// owner 2026-11-14: "a social media assistant can only see blog titles, not article content, when creating
// posts from blogs").
//
// Two ways a post is made from an article:
//   • the automatic hand-off (orchestration.ts, a blog publish → "publishes a post" link → a social draft job):
//     the job's context now carries the article's summary, words and link — blogHandoffContext();
//   • the Social chat: recent published articles ride on its posts snapshot — renderRecentArticlesForChat().
// The pure parts are pinned by tests/blog-to-social.test.ts.

import { and, desc, eq, gte } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Article markdown → plain words: no front matter, media/column directives, pictures, link addresses or code. Pure. */
export function articleText(markdown: string | null | undefined): string {
    return String(markdown || '')
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .replace(/^:::[^\n]*$/gm, '')                 // :::media{…} / :::columns / ::: closers
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Cut at a paragraph (or sentence) break near `limit`, never mid-word. Pure. */
export function clipArticle(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const para = cut.lastIndexOf('\n\n');
    if (para > limit * 0.6) return `${cut.slice(0, para).trim()}\n[…]`;
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    return `${(sentence > limit * 0.6 ? cut.slice(0, sentence + 1) : cut.replace(/\s+\S*$/, '')).trim()} […]`;
}

export interface ArticleForSocial { id?: number; title: string; summary: string | null; body: string | null; url: string | null; publishedAt?: Date | string | null }

/** Words in a hand-off job's context: the article itself, so the post is about what it says. */
export const HANDOFF_ARTICLE_CHARS = 2500;

/**
 * The context a hand-off draft job gets when the source is a blog article. Falls back to the old one-line
 * context ("<action>. Context from <name>'s post: "<title>".") when the article has no words. Pure.
 */
export function blogHandoffContext(action: string, sourceName: string, a: ArticleForSocial): string {
    const words = clipArticle(articleText(a.body), HANDOFF_ARTICLE_CHARS);
    const title = (a.title || '').trim();
    if (!words) return `${action}. Context from ${sourceName}'s post${title ? `: "${title.slice(0, 300)}"` : ''}.`.slice(0, 500);
    return [
        `${action}. Write the post about this article that ${sourceName} has just published on the blog — what it actually says, in the post's own words (never paste the article). Use only facts from the article.`,
        title ? `Title: ${title}` : '',
        a.summary ? `Summary: ${a.summary.trim()}` : '',
        `The article:\n${words}`,
        a.url ? `Link to the article: ${a.url} — point readers to it.` : '',
    ].filter(Boolean).join('\n\n');
}

const CHAT_ARTICLES = 5;
const CHAT_ARTICLE_CHARS = 900;

/** The Social chat's block of recent articles. Pure. */
export function renderRecentArticlesForChat(list: ArticleForSocial[], days: number): string {
    const head = `RECENT ARTICLES ON THEIR BLOG (published in the last ${days} days, newest first — the start of each article's words, so a post "from the blog" or "about my latest article" says what the article says; use only these facts, and say when you can only see the start).`;
    if (!list.length) return `${head}\n(None published in that time. If they ask for a post from an article, ask them to paste the part they want, or point them to the Blog Writing Assistant.)`;
    return `${head}\n${list.slice(0, CHAT_ARTICLES).map((a) => {
        const when = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : '';
        const words = clipArticle(articleText(a.body), CHAT_ARTICLE_CHARS);
        return [`- Article "${a.title}"${when ? ` (published ${when})` : ''}${a.url ? ` — link ${a.url}` : ''}`,
            a.summary ? `  Summary: ${a.summary.trim()}` : '',
            words ? `  Its words: ${words.replace(/\n+/g, ' ')}` : '  (No words could be read.)'].filter(Boolean).join('\n');
    }).join('\n')}`;
}

export const RECENT_ARTICLE_DAYS = 45;

/** This workspace's recently published articles (any Blog Writing Assistant), for the Social chat. */
export async function loadRecentArticles(db: Db, organisationId: number, days = RECENT_ARTICLE_DAYS): Promise<ArticleForSocial[]> {
    const rows = await db.select({
        id: blogPosts.id, title: blogPosts.title, summary: blogPosts.metaDescription, body: blogPosts.bodyMarkdown,
        url: blogPosts.canonicalUrl, publishedAt: blogPosts.publishedAt,
    }).from(blogPosts)
        .where(and(eq(blogPosts.organisationId, organisationId), eq(blogPosts.status, 'published'),
            gte(blogPosts.publishedAt, new Date(Date.now() - days * 86_400_000))))
        .orderBy(desc(blogPosts.publishedAt))
        .limit(CHAT_ARTICLES);
    return rows.map((r) => ({ ...r, title: r.title || 'Untitled' }));
}

/** One article for a hand-off, org-scoped. Null when it is gone. */
export async function loadArticleForHandoff(db: Db, organisationId: number, blogPostId: number): Promise<ArticleForSocial | null> {
    const [r] = await db.select({
        title: blogPosts.title, summary: blogPosts.metaDescription, body: blogPosts.bodyMarkdown, url: blogPosts.canonicalUrl,
    }).from(blogPosts).where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, organisationId))).limit(1);
    return r ? { ...r, title: r.title || '' } : null;
}
