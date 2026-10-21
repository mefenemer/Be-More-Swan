// src/utils/site-audit-covered.ts — what the Mystery Shopper's "Ideas for your other assistants"
// must not suggest again.
//
// ── The bug this fixes (owner, 2026-10-21) ───────────────────────────────────────────────────────
// Every check wrote two fresh ideas — one for the Social Media Assistant, one for the Blog Writer —
// with no memory of the last ones. The wording changed each time, the substance didn't ("outcome-led
// posts", "a proof-led article", "trust while the site is updated"), so the card refilled with what
// the user had already briefed, or what those assistants had already written.
//
// Before writing ideas, the summary call is now told what is already covered, from three places:
//   • ideas earlier checks suggested (site_audit_runs.report.handoffs);
//   • briefs the user actually sent (site_audit_briefs);
//   • what the receiving assistants have already drafted, scheduled or published — their own work,
//     read from scheduled_posts, blog_posts and campaigns, so an idea is "done" when the work exists,
//     whether or not it came from a brief.
// sanitiseSummary (site-audit-prompts.ts) then drops any idea whose title is a near-copy of a covered
// one for the same assistant, in case the model repeats one anyway.
//
// ⚠️ Never throws: a lookup that fails leaves that source out, and the check still runs.

import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts, campaigns, scheduledPosts, siteAuditBriefs, siteAuditRuns } from '../../db/schema';
import type { HandoffTarget } from './site-audit-prompts';

type Db = ReturnType<typeof getDb>;

export interface CoveredItem {
    target: HandoffTarget;
    /** What it is called — the idea's title, the brief's title, the post's opening, the article's title. */
    text: string;
    how: 'suggested before' | 'briefed' | 'already written';
}

const DAYS = 90;
const PER_SOURCE = 12;
const since = () => new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const gist = (s: unknown, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function safe<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
    try { return await fn(); } catch (err) {
        console.error(`[site-audit-covered] ${label} lookup failed (left out)`, err instanceof Error ? err.message : err);
        return [];
    }
}

export async function loadAlreadyCovered(db: Db, organisationId: number, auditId: number): Promise<CoveredItem[]> {
    const [runs, briefs, posts, articles, camps] = await Promise.all([
        safe('ideas', () => db.select({ report: siteAuditRuns.report })
            .from(siteAuditRuns)
            .where(and(eq(siteAuditRuns.auditId, auditId), eq(siteAuditRuns.status, 'done'), gte(siteAuditRuns.createdAt, since())))
            .orderBy(desc(siteAuditRuns.id)).limit(PER_SOURCE)),
        safe('briefs', () => db.select({ target: siteAuditBriefs.targetRole, title: siteAuditBriefs.title, brief: siteAuditBriefs.brief })
            .from(siteAuditBriefs)
            .where(and(eq(siteAuditBriefs.auditId, auditId), eq(siteAuditBriefs.organisationId, organisationId)))
            .orderBy(desc(siteAuditBriefs.id)).limit(PER_SOURCE)),
        safe('posts', () => db.select({ caption: scheduledPosts.caption })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, organisationId),
                notInArray(scheduledPosts.status, ['cancelled', 'rejected', 'admin_test']),
                gte(scheduledPosts.createdAt, since()),
                sql`btrim(coalesce(${scheduledPosts.caption}, '')) <> ''`,
            ))
            .orderBy(desc(scheduledPosts.createdAt)).limit(PER_SOURCE)),
        safe('articles', () => db.select({ title: blogPosts.title })
            .from(blogPosts)
            .where(and(eq(blogPosts.organisationId, organisationId), notInArray(blogPosts.status, ['archived']), gte(blogPosts.createdAt, since())))
            .orderBy(desc(blogPosts.createdAt)).limit(PER_SOURCE)),
        safe('campaigns', () => db.select({ objective: campaigns.objective })
            .from(campaigns)
            .where(and(eq(campaigns.organisationId, organisationId), inArray(campaigns.status, ['draft', 'active', 'throttled', 'paused', 'finished']), gte(campaigns.createdAt, since())))
            .orderBy(desc(campaigns.createdAt)).limit(PER_SOURCE)),
    ]);

    const out: CoveredItem[] = [];
    for (const r of runs) {
        const handoffs = ((r.report ?? {}) as { handoffs?: Array<{ target: HandoffTarget; title: string }> }).handoffs ?? [];
        for (const h of handoffs) if (h?.target && h.title) out.push({ target: h.target, text: gist(h.title), how: 'suggested before' });
    }
    for (const b of briefs) out.push({ target: b.target as HandoffTarget, text: gist(b.title || b.brief), how: 'briefed' });
    for (const p of posts) out.push({ target: 'social_media_manager', text: gist(p.caption), how: 'already written' });
    for (const a of articles) out.push({ target: 'blog_writer', text: gist(a.title), how: 'already written' });
    for (const c of camps) out.push({ target: 'campaign_orchestrator', text: gist(c.objective), how: 'already written' });
    // One line per distinct thing: the same idea suggested on four checks is one line, not four.
    const seen = new Set<string>();
    return out.filter((c) => {
        const k = `${c.target}|${normaliseIdea(c.text)}`;
        if (!c.text || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** Lower-case words, no punctuation or filler — the form two titles are compared in. */
const FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'on', 'in', 'with', 'your', 'our', 'how', 'is', 'are', 'it', 'that', 'this', 'write', 'post', 'posts', 'article', 'blog', 'social']);
export function normaliseIdea(s: string): string {
    return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w)).join(' ');
}

/** True when two idea titles say the same thing: most of the meaningful words are shared. */
export function sameIdea(a: string, b: string): boolean {
    const x = new Set(normaliseIdea(a).split(' ').filter(Boolean));
    const y = new Set(normaliseIdea(b).split(' ').filter(Boolean));
    if (!x.size || !y.size) return false;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared++;
    return shared / Math.min(x.size, y.size) >= 0.6;
}

/** The prompt block. Empty when there is nothing covered yet. */
export function coveredBlock(items: CoveredItem[]): string {
    if (!items.length) return '';
    const label: Record<HandoffTarget, string> = {
        social_media_manager: 'Social Media Assistant', blog_writer: 'Blog Writer', campaign_orchestrator: 'Campaign Assistant',
    };
    const lines = items.slice(0, 40).map((c) => `- [${label[c.target] ?? c.target}] (${c.how}) ${c.text}`);
    return `<already_covered>\nThese are already suggested, briefed or written by the other assistants. Do NOT suggest any of them again, or anything that overlaps them in substance (the same message, angle, offer or audience said in other words):\n${lines.join('\n')}\n</already_covered>`;
}
