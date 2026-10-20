// src/utils/blog-filters.ts
// Reader-facing filters on a public blog list: by category and by month.
//
// "Category" is the post's own tags (blog_posts.tags) on a customer's blog, and the editor-assigned
// section on The Swan Index. "Date" is a calendar month, 'YYYY-MM', of the date the list sorts on.
//
// Every filter value arrives in a query string from the public internet, so it is parsed here and
// nowhere else: an unparseable value becomes "no filter", never a 400 and never SQL.

export interface BlogListFilter {
    /** Exact tag text, as stored. */
    tag: string | null;
    /** 'YYYY-MM'. */
    month: string | null;
}

export const NO_FILTER: BlogListFilter = { tag: null, month: null };

/** 'YYYY-MM' between 2000 and 2099 with a real month, or null. */
export function parseMonth(v: unknown): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    const m = s.match(/^(20\d\d)-(0[1-9]|1[0-2])$/);
    return m ? s : null;
}

/** A tag as a reader could have picked it from the list: non-empty, bounded, one line. */
export function parseTag(v: unknown): string | null {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return s && s.length <= 80 ? s : null;
}

export function parseBlogFilter(qs: Record<string, string | undefined> | null | undefined): BlogListFilter {
    return { tag: parseTag(qs?.tag), month: parseMonth(qs?.month) };
}

export function isFiltered(f: BlogListFilter): boolean {
    return !!(f.tag || f.month);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-10' → 'October 2026'. Returns the input unchanged if it is not a month key. */
export function monthLabel(key: string): string {
    const m = parseMonth(key);
    if (!m) return key;
    return `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

/** The query string for a filter (plus any extra params), '' when there is nothing to carry. */
export function filterQuery(f: BlogListFilter, extra: Record<string, string | null | undefined> = {}): string {
    const p = new URLSearchParams();
    if (f.tag) p.set('tag', f.tag);
    if (f.month) p.set('month', f.month);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
}

export interface Facet { value: string; label: string; count: number }
export interface BlogFacets { categories: Facet[]; months: Facet[] }
