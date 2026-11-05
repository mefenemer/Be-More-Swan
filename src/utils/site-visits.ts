// src/utils/site-visits.ts — visitor counts for websites published by the Website Assistant.
// db/z-site-visits.sql. Counted by sites-host/edge-functions/serve.ts (every page view passes through
// it, before any cache) → netlify/functions/site-visit.ts → recordVisit. Read by sites.ts `visits`
// (the Results tab) and by the chat snapshot. tests/site-visits.test.ts.
//
// No cookie, no script, no IP address or browser string is ever stored. The edge sends a one-way hash
// of (day, site, IP, browser) made with a secret; it is kept for the day only, to count each visitor
// once, and deleted after two days. Beyond that only daily totals exist.

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { siteVisitDays, siteVisitPages, siteVisitRefs, siteVisitSeen } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Crawlers, link previews, monitors and scripts — not people. Matched on the browser string at the edge. */
export const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|monitor|uptime|pingdom|headless|lighthouse|curl\/|wget\/|python-|go-http|java\/|okhttp|axios|node-fetch|httpclient|scrapy|semrush|ahrefs|mj12|dataforseo|bytespider|gptbot|claudebot|perplexity|petalbot|yandex|baiduspider|duckduckbot|bingpreview|applebot/i;
export const isBot = (ua: string | null | undefined): boolean => !ua || ua.length < 12 || BOT_RE.test(ua);

/** A page a person reads — not a form post, a calendar file, the sitemap, a font or a check. */
export function countablePath(path: string): boolean {
    const p = (path || '').split(/[?#]/)[0];
    if (!p.startsWith('/') || p.length > 300) return false;
    if (p.startsWith('/_') || p.startsWith('/.well-known') || p.startsWith('/site-fonts')) return false;
    return !/\.(ics|xml|txt|ico|png|jpe?g|gif|webp|svg|css|js|json|map|woff2?)$/i.test(p);
}
/** "/About/" → "/about"; the query string is dropped (a ?category= filter is the same page). */
export function normalisePath(path: string): string {
    const p = (path || '/').split(/[?#]/)[0].toLowerCase().replace(/\/{2,}/g, '/');
    const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
    return (trimmed || '/').slice(0, 200);
}
/** Where a visitor came from: the referring site's host (no path, no query), never this site itself. */
export function refHostOf(referer: string | null | undefined, ownHost: string): string | null {
    if (!referer) return null;
    try {
        const h = new URL(referer).hostname.toLowerCase().replace(/^www\./, '');
        const own = ownHost.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
        if (!h || h === own) return null;
        return h.slice(0, 100);
    } catch { return null; }
}
/** UK calendar date, YYYY-MM-DD. */
export function ukDay(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const addDays = (day: string, n: number) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/** One page view. `visitor` is the edge's hash (hex). Never throws for a caller that ignores it. */
export async function recordVisit(db: Db, v: { siteId: number; path: string; refHost: string | null; visitor: string; now?: Date }): Promise<{ newVisitor: boolean }> {
    const day = ukDay(v.now);
    const path = normalisePath(v.path);
    const visitor = /^[a-f0-9]{16,64}$/.test(v.visitor) ? v.visitor : '';
    let newVisitor = false;
    if (visitor) {
        const ins = await db.insert(siteVisitSeen).values({ siteId: v.siteId, day, visitor }).onConflictDoNothing().returning({ visitor: siteVisitSeen.visitor });
        newVisitor = ins.length > 0;
    }
    await db.insert(siteVisitDays).values({ siteId: v.siteId, day, views: 1, visitors: newVisitor ? 1 : 0 })
        .onConflictDoUpdate({ target: [siteVisitDays.siteId, siteVisitDays.day], set: { views: sql`${siteVisitDays.views} + 1`, visitors: sql`${siteVisitDays.visitors} + ${newVisitor ? 1 : 0}` } });
    await db.insert(siteVisitPages).values({ siteId: v.siteId, day, path, views: 1 })
        .onConflictDoUpdate({ target: [siteVisitPages.siteId, siteVisitPages.day, siteVisitPages.path], set: { views: sql`${siteVisitPages.views} + 1` } });
    // A referrer is counted once per visitor per day — the visit it started, not every page after.
    if (v.refHost && (newVisitor || !visitor)) {
        await db.insert(siteVisitRefs).values({ siteId: v.siteId, day, refHost: v.refHost.slice(0, 100), visits: 1 })
            .onConflictDoUpdate({ target: [siteVisitRefs.siteId, siteVisitRefs.day, siteVisitRefs.refHost], set: { visits: sql`${siteVisitRefs.visits} + 1` } });
    }
    // The day's hashes are only for counting each visitor once: anything older than yesterday goes.
    if (newVisitor && Math.random() < 0.05) await purgeSeen(db, v.now);
    return { newVisitor };
}
export async function purgeSeen(db: Db, now = new Date()): Promise<void> {
    await db.delete(siteVisitSeen).where(lt(siteVisitSeen.day, addDays(ukDay(now), -1)));
}

export interface VisitStats {
    days: number; from: string; to: string;
    views: number; visitors: number; prevViews: number; prevVisitors: number;
    /** Oldest first, one per day of the window, zeros filled in. */
    series: Array<{ day: string; views: number; visitors: number }>;
    topPages: Array<{ path: string; views: number }>;
    topRefs: Array<{ host: string; visits: number }>;
}

/** The last `days` days (today included), the period before for comparison, the busiest pages and referrers. */
export async function visitStats(db: Db, siteId: number, now = new Date(), days = 30): Promise<VisitStats> {
    const to = ukDay(now);
    const from = addDays(to, -(days - 1));
    const prevFrom = addDays(from, -days);
    const rows = await db.select({ day: siteVisitDays.day, views: siteVisitDays.views, visitors: siteVisitDays.visitors }).from(siteVisitDays)
        .where(and(eq(siteVisitDays.siteId, siteId), gte(siteVisitDays.day, prevFrom)));
    const byDay = new Map(rows.map((r) => [String(r.day), r]));
    const series = Array.from({ length: days }, (_, i) => {
        const day = addDays(from, i);
        const r = byDay.get(day);
        return { day, views: r?.views ?? 0, visitors: r?.visitors ?? 0 };
    });
    const sum = (list: typeof rows, k: 'views' | 'visitors') => list.reduce((n, r) => n + Number(r[k] || 0), 0);
    const cur = rows.filter((r) => String(r.day) >= from);
    const prev = rows.filter((r) => String(r.day) < from);
    const topPages = await db.select({ path: siteVisitPages.path, views: sql<number>`sum(${siteVisitPages.views})::int` }).from(siteVisitPages)
        .where(and(eq(siteVisitPages.siteId, siteId), gte(siteVisitPages.day, from)))
        .groupBy(siteVisitPages.path).orderBy(desc(sql`sum(${siteVisitPages.views})`)).limit(8);
    const topRefs = await db.select({ host: siteVisitRefs.refHost, visits: sql<number>`sum(${siteVisitRefs.visits})::int` }).from(siteVisitRefs)
        .where(and(eq(siteVisitRefs.siteId, siteId), gte(siteVisitRefs.day, from)))
        .groupBy(siteVisitRefs.refHost).orderBy(desc(sql`sum(${siteVisitRefs.visits})`)).limit(8);
    return {
        days, from, to,
        views: sum(cur, 'views'), visitors: sum(cur, 'visitors'), prevViews: sum(prev, 'views'), prevVisitors: sum(prev, 'visitors'),
        series, topPages: topPages.map((r) => ({ path: r.path, views: Number(r.views) })), topRefs: topRefs.map((r) => ({ host: r.host, visits: Number(r.visits) })),
    };
}

/** One line for the chat: "how is my site doing?" */
export function visitsLine(s: VisitStats, live: boolean): string {
    if (!live) return 'Visitors: none counted yet — visitors are counted once the site is published.';
    if (!s.views) return `Visitors: none counted in the last ${s.days} days (counting began when the site went live).`;
    const pages = s.topPages.slice(0, 5).map((p) => `${p.path} ${p.views}`).join(', ');
    const refs = s.topRefs.slice(0, 5).map((r) => `${r.host} ${r.visits}`).join(', ');
    return `Visitors in the last ${s.days} days (counted on the live site, no cookies): ${s.visitors} visitors, ${s.views} page views (the ${s.days} days before: ${s.prevVisitors} visitors, ${s.prevViews} views). Most-read pages: ${pages || 'none'}.${refs ? ` Came from: ${refs} (everyone else typed the address, used a bookmark or an app that hides where they came from).` : ''} These are the only visitor figures — never invent others (no bounce rate, time on page or conversions beyond these).`;
}
