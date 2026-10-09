// netlify/functions/dashboard-agenda.ts
// GET → { items: [{ kind, at, label, assistantId, assistantName }] }
// The dashboard's "Next 7 days" widget: everything already booked to go out, across every assistant.
//
// Why: each assistant's Calendar tab shows only that assistant, so nothing answered "what goes out
// this week?" for the whole team. Reads only rows that WILL happen without anyone acting — a
// scheduled post, a scheduled article, a scheduled email. Drafts and items awaiting approval are
// deliberately absent: they are not booked, and the "Needs you" strip already counts them.
// Three bounded queries, no assets or bodies — the full calendar endpoints carry both.

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts, newsletterIssues, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const DAYS = 7;
const PER_KIND = 20;
const MAX_ITEMS = 12;
const PLATFORM_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest' };

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const now = new Date();
    const until = new Date(now.getTime() + DAYS * 24 * 60 * 60 * 1000);

    const team = new Map((await db.select({ id: aiAssistants.id, name: aiAssistants.name })
        .from(aiAssistants).where(eq(aiAssistants.organisationId, orgId))).map((a) => [a.id, a.name]));
    const items: Array<{ kind: 'post' | 'article' | 'email'; at: Date; label: string; assistantId: number | null; assistantName: string | null }> = [];
    const who = (id: number | null) => ({ assistantId: id, assistantName: id != null ? team.get(id) ?? null : null });

    // Each source on its own: one table failing must not empty the agenda.
    try {
        const posts = await db.select({ platform: scheduledPosts.platform, at: scheduledPosts.publishDate, assistantId: scheduledPosts.assistantId })
            .from(scheduledPosts).where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'scheduled'),
                gte(scheduledPosts.publishDate, now), lte(scheduledPosts.publishDate, until)))
            .orderBy(asc(scheduledPosts.publishDate)).limit(PER_KIND);
        for (const p of posts) items.push({ kind: 'post', at: p.at, label: `Post to ${PLATFORM_NAMES[p.platform] ?? p.platform}`, ...who(p.assistantId) });
    } catch (err) { console.error('[dashboard-agenda] posts skipped', err); }
    try {
        const articles = await db.select({ title: blogPosts.title, at: blogPosts.publishDate, assistantId: blogPosts.assistantId })
            .from(blogPosts).where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.status, 'scheduled'),
                gte(blogPosts.publishDate, now), lte(blogPosts.publishDate, until)))
            .orderBy(asc(blogPosts.publishDate)).limit(PER_KIND);
        for (const b of articles) if (b.at) items.push({ kind: 'article', at: b.at, label: `Article: ${b.title}`, ...who(b.assistantId) });
    } catch (err) { console.error('[dashboard-agenda] articles skipped', err); }
    try {
        const emails = await db.select({ subject: newsletterIssues.subject, at: newsletterIssues.scheduledFor, assistantId: newsletterIssues.assistantId })
            .from(newsletterIssues).where(and(eq(newsletterIssues.organisationId, orgId), eq(newsletterIssues.status, 'scheduled'),
                gte(newsletterIssues.scheduledFor, now), lte(newsletterIssues.scheduledFor, until)))
            .orderBy(asc(newsletterIssues.scheduledFor)).limit(PER_KIND);
        for (const e of emails) if (e.at) items.push({ kind: 'email', at: e.at, label: `Email: ${e.subject}`, ...who(e.assistantId) });
    } catch (err) { console.error('[dashboard-agenda] emails skipped', err); }

    items.sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.slice(0, MAX_ITEMS), total: items.length }),
    };
});
