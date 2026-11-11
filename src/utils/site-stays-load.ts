// src/utils/site-stays-load.ts — reading holiday lets and B&B rooms for a hosted site (site-serve.ts,
// site-preview.ts). The pure parts and types are in site-stays.ts. docs/holiday-lets-plan.md §4.

import type { getDb } from '../../db/client';
import type { SiteDefinition } from './site-definition';
import { addDays, utcToZoned } from './booking-time';
import { freeByNight } from './stay-availability';
import { fromPrice } from './stay-quote';
import { businessTimezone, loadHolds, loadStays, publicStay } from './stays';
import { addMonths, calendarMonths, monthStart, MONTH_RE, siteHasStays, type SiteRenderStays, type StayPageView } from './site-stays';

type Db = ReturnType<typeof getDb>;

/** For a page with a stays section — every active stay, never with arrival details. */
export async function loadSiteStays(db: Db, orgId: number, def: SiteDefinition): Promise<SiteRenderStays | null> {
    if (!siteHasStays(def)) return null;
    try {
        const all = await loadStays(db, orgId, { activeOnly: true });
        return { stays: all.map((s) => { const p = publicStay(s); return { ...p, fromPrice: fromPrice(p.pricing) }; }) };
    } catch (err) {
        // A database without db/z-stays.sql yet: the section simply shows nothing.
        console.error('[site-stays] could not read stays', err instanceof Error ? err.message : err);
        return { stays: [] };
    }
}

/** /stays/<slug>: the stay, two months of its calendar from `month` (this month when missing or past). */
export async function loadStayPage(db: Db, orgId: number, slug: string, monthRaw: string | null, now: Date): Promise<StayPageView | null> {
    const all = await loadStays(db, orgId, { activeOnly: true });
    const found = all.find((s) => s.row.slug === slug);
    if (!found) return null;
    const tz = await businessTimezone(db, orgId);
    const today = utcToZoned(now, tz).date;
    const thisMonth = today.slice(0, 7);
    const lastBookable = addDays(today, found.row.maxAdvanceDays);
    let first = monthRaw && MONTH_RE.test(monthRaw) ? monthRaw : thisMonth;
    if (first < thisMonth) first = thisMonth;
    if (first > lastBookable.slice(0, 7)) first = lastBookable.slice(0, 7);
    const from = monthStart(first);
    const to = monthStart(addMonths(first, 2));
    const holds = await loadHolds(db, orgId, found.units.map((u) => u.id), from, to, 1);
    const nights = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    const free = freeByNight(found.units, holds, from, nights);
    const p = publicStay(found);
    return {
        stay: { ...p, fromPrice: fromPrice(p.pricing) },
        months: calendarMonths(first, 2, free, today, lastBookable),
        today,
        prevMonth: first > thisMonth ? addMonths(first, -1) : null,
        nextMonth: addMonths(first, 2) <= lastBookable.slice(0, 7) ? addMonths(first, 1) : null,
    };
}

/** For the sitemap: every active stay's page. */
export async function staySlugs(db: Db, orgId: number): Promise<string[]> {
    try { return (await loadStays(db, orgId, { activeOnly: true })).map((s) => s.row.slug); }
    catch { return []; }
}
