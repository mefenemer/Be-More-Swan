// src/utils/mentor-blog-pillars.ts — the Business Mentor's Monday review lists last week's blog articles, each
// matched to one of the Social Media Assistant's content pillars (FR#21, owner 2026-11-14: "so I can see which
// articles to turn into posts without having to ask in chat each week").
//
// Last week = the previous Monday–Sunday in UK time. The match is worked out in code first (shared words between
// the title and each pillar's name and description), so a thin week's code-written review can show it too; the
// model's review gets the same list and may move an article to a better pillar, never to one that isn't listed.
// The pure parts are pinned by tests/mentor-blog-pillars.test.ts.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { weekStartUk } from './mentor-commitments';
import { listPillars } from './content-pillars-store';

type Db = ReturnType<typeof getDb>;

export interface WeekArticle { id: number; title: string; publishedOn: string }
export interface PillarLite { name: string; description: string | null }
export interface ArticleMatch { article: WeekArticle; pillar: string | null }
export interface BlogPillarWeek { from: string; to: string; articles: WeekArticle[]; pillars: PillarLite[] | null; matches: ArticleMatch[] }

/** The previous Monday–Sunday (UK) before the week `now` is in, as YYYY-MM-DD. Pure. */
export function lastUkWeek(now = new Date()): { from: string; to: string } {
    const monday = new Date(`${weekStartUk(now)}T12:00:00Z`);
    const from = new Date(monday.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(monday.getTime() - 86_400_000).toISOString().slice(0, 10);
    return { from, to };
}

const STOP = new Set('a an and are as at be but by for from has have how in into is it its of on or our so that the their this to was we what when where which who why will with you your yours'.split(' '));
/** Lower-case word stems worth matching on (plural/-ing/-ed trimmed). Pure. */
export function words(s: string | null | undefined): Set<string> {
    const out = new Set<string>();
    for (const w of String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
        if (w.length < 3 || STOP.has(w)) continue;
        out.add(w.replace(/(ing|ed|es|s)$/, '') || w);
    }
    return out;
}

/**
 * Each article's closest pillar: most shared words with the pillar's name (counted twice) and description.
 * No shared word → null ("no clear pillar"). Ties go to the earlier pillar (the user's own order). Pure.
 */
export function matchArticlesToPillars(articles: WeekArticle[], pillars: PillarLite[]): ArticleMatch[] {
    const pw = pillars.map((p) => ({ name: p.name, n: words(p.name), d: words(p.description) }));
    return articles.map((article) => {
        const t = words(article.title);
        let best: string | null = null; let bestScore = 0;
        for (const p of pw) {
            let score = 0;
            for (const w of t) score += (p.n.has(w) ? 2 : 0) + (p.d.has(w) ? 1 : 0);
            if (score > bestScore) { bestScore = score; best = p.name; }
        }
        return { article, pillar: best };
    });
}

const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The plain-words list (a thin week's section, and the model's starting point). Pure. Null when nothing to say. */
export function blogPillarText(w: BlogPillarWeek | null): string | null {
    if (!w) return null;
    if (!w.articles.length) return `No articles were published on your blog last week (${fmt(w.from)}–${fmt(w.to)}).`;
    const lines = w.matches.map((m) => `• “${m.article.title}” (${fmt(m.article.publishedOn)}) → ${w.pillars === null ? 'no Social Media Assistant pillars to match' : m.pillar ? m.pillar : 'no clear pillar'}`);
    const tail = w.pillars === null
        ? 'Hire a Social Media Assistant (or give it content pillars) and I’ll match each article to one.'
        : 'Ask your Social Media Assistant to turn any of them into a post.';
    return `Published last week (${fmt(w.from)}–${fmt(w.to)}):\n${lines.join('\n')}\n${tail}`;
}

/** The block in the review's system prompt. Pure. */
export function renderBlogPillarsForMentor(w: BlogPillarWeek | null): string[] {
    if (!w) return ['LAST WEEK\'S ARTICLES: could not be read this time — leave the "Last week’s articles" section out; never guess.'];
    if (!w.articles.length) return [`LAST WEEK'S ARTICLES (${w.from} to ${w.to}): none published. In the "Last week’s articles" section say so in one sentence.`];
    const pillars = w.pillars === null ? 'none (no active Social Media Assistant with pillars)'
        : w.pillars.map((p) => `"${p.name}"${p.description ? ` — ${p.description}` : ''}`).join('; ');
    return [
        `LAST WEEK'S ARTICLES (published ${w.from} to ${w.to}, UK) and the Social Media Assistant's content pillars: ${pillars}.`,
        ...w.matches.map((m) => `- "${m.article.title}" (${m.article.publishedOn}) — closest pillar by shared words: ${m.pillar ?? 'none'}`),
        'Write a "Last week’s articles" section listing EVERY article above by its exact title, each with ONE pillar from that list (keep the closest pillar unless another listed pillar clearly fits better; "no clear pillar" when none fits; never invent a pillar), as one line per article. If there are no pillars, list the titles and say pillars come from the Social Media Assistant.',
    ];
}

/** Read last week's articles and the active Social Media Assistant's pillars. */
export async function loadBlogPillarWeek(db: Db, orgId: number, team: Array<{ id: number; roleKey?: string | null; state: string }>, now = new Date()): Promise<BlogPillarWeek> {
    const { from, to } = lastUkWeek(now);
    const rows = await db.execute<{ id: number; title: string | null; day: string }>(sql`
        SELECT id, title, ((published_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date::text AS day
          FROM blog_posts
         WHERE organisation_id = ${orgId} AND status = 'published' AND published_at IS NOT NULL
           AND ((published_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date BETWEEN ${from}::date AND ${to}::date
         ORDER BY published_at ASC
         LIMIT 20`);
    const articles: WeekArticle[] = (rows as unknown as Array<Record<string, any>>).map((r) => ({ id: Number(r.id), title: String(r.title || 'Untitled'), publishedOn: String(r.day) }));
    const social = team.find((t) => t.roleKey === 'social_media_manager' && t.state === 'active');
    const all = social ? await listPillars(db, orgId, social.id).catch(() => null) : null;
    const active = all ? all.filter((p) => p.isActive).map((p) => ({ name: p.name, description: p.description })) : [];
    const pillars = active.length ? active : null;
    return { from, to, articles, pillars, matches: pillars ? matchArticlesToPillars(articles, pillars) : articles.map((article) => ({ article, pillar: null })) };
}
