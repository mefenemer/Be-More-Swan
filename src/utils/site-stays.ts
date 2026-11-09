// src/utils/site-stays.ts — what a hosted site needs to show holiday lets and B&B rooms: the cards of a
// `stays` section, each stay's own page at /stays/<slug> and its calendar. docs/holiday-lets-plan.md §4.
// The HTML is drawn in site-render.ts (renderSiteStay, the 'stays' section).
// tests/site-stays.test.ts.
//
// Names, facts and prices come from Business Information ▸ Stays when the page is drawn — the site
// definition holds only which stays a section shows. Arrival details never leave stays.ts publicStay().

// PURE (no database) so site-render.ts can import it; the loaders are in site-stays-load.ts.

import type { SiteDefinition } from './site-definition';
import { addDays } from './booking-time';
import type { PublicStay } from './stays';

export const STAY_PATH = '/stays';

export interface SiteRenderStay extends PublicStay { fromPrice: string | null; }
/** Every active stay of the workspace, by id. Null = the site has no stays section. */
export interface SiteRenderStays { stays: SiteRenderStay[]; }

/** /stays/<slug> → the slug; anything else → null. */
export function stayRoute(path: string): { slug: string } | null {
    const m = /^\/stays\/([a-z0-9-]{1,80})\/?$/.exec((path || '').split(/[?#]/)[0]);
    return m ? { slug: m[1] } : null;
}

export const stayPagePath = (slug: string) => `${STAY_PATH}/${slug}`;

export function siteHasStays(def: Pick<SiteDefinition, 'pages'>): boolean {
    return def.pages.some((p) => p.sections.some((s) => s.type === 'stays'));
}

/** The stays a section shows, in the section's order ([] = every active stay, in the owner's order). */
export function staysFor(data: SiteRenderStays | null | undefined, ids: number[]): SiteRenderStay[] {
    if (!data) return [];
    if (!ids.length) return data.stays;
    return ids.map((id) => data.stays.find((s) => s.id === id)).filter((s): s is SiteRenderStay => !!s);
}

/** One month of a calendar: its dates (Monday-first, with blanks), and how many units are free each night. */
export interface CalendarMonth { month: string; label: string; days: Array<{ date: string; free: number; past: boolean; open: boolean } | null>; }
export interface StayPageView {
    stay: SiteRenderStay;
    months: CalendarMonth[];
    today: string;
    /** The month before / after the first shown, when they can be booked. */
    prevMonth: string | null;
    nextMonth: string | null;
}

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const monthStart = (m: string) => `${m}-01`;
export function addMonths(month: string, n: number): string {
    const [y, mo] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1 + n, 1));
    return d.toISOString().slice(0, 7);
}
const daysIn = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/** Pure: lay out `count` months from `first` using a night → free-units map. Exported for tests. */
export function calendarMonths(first: string, count: number, free: Map<string, number>, today: string, lastBookable: string): CalendarMonth[] {
    const out: CalendarMonth[] = [];
    for (let i = 0; i < count; i++) {
        const month = addMonths(first, i);
        const start = monthStart(month);
        const [y, m] = month.split('-').map(Number);
        const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
        const days: CalendarMonth['days'] = Array.from({ length: lead }, () => null);
        for (let d = 0; d < daysIn(month); d++) {
            const date = addDays(start, d);
            const past = date < today;
            days.push({ date, free: free.get(date) ?? 0, past, open: !past && date <= lastBookable });
        }
        out.push({ month, label: new Date(`${start}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), days });
    }
    return out;
}

