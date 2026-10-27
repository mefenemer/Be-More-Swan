// src/utils/site-plan-prices.ts — let the Mystery Shopper read a page's plan prices the way a visitor does.
//
// WHY THIS EXISTS. Our own pages type no plan price (owner, 2026-10-19, tests/no-hardcoded-plan-prices.test.ts):
// they mark the spot — <span data-plan-price="buster"></span> inside <span data-plan-prices-ready hidden> —
// and plan-prices.js fills it from get-plans in the browser. The Mystery Shopper reads the raw HTML and
// runs no scripts, so it saw "Plans start at /month" and suggested typing "£29" back in (2026-10-27).
//
// So before the page is extracted, the markers are filled from the SAME site's get-plans, exactly as
// plan-prices.js would: every price known → the sentence shows; any missing → it stays out of the text,
// as it stays hidden on screen. A page without the markers is returned untouched and costs no request.

import * as cheerio from 'cheerio';
import { robotsAllows, type Crawler } from '../lib/robots';
import { formatGbp } from './plan-price-tokens';
import { safeFetchText } from './safe-fetch';

export type SitePlanPrice = { tierKey?: string; monthlyPriceGbp?: number | string | null };

const MARKER = 'data-plan-price';

/** Fill plan-price markers the way plan-prices.js does. Pure. */
export function fillPlanPriceMarkers(html: string, plans: SitePlanPrice[]): string {
    if (!html.includes(MARKER)) return html;
    const byTier = new Map<string, string>();
    for (const p of plans) {
        const price = p?.tierKey ? formatGbp(p.monthlyPriceGbp ?? 0) : '';
        if (price) byTier.set(p.tierKey!, price);
    }
    const $ = cheerio.load(html);
    $('[data-plan-price]').each((_, el) => {
        const price = byTier.get($(el).attr('data-plan-price') ?? '');
        if (price) $(el).text(price);
    });
    $('[data-plan-prices-ready]').each((_, el) => {
        const inner = $(el).find('[data-plan-price]').toArray();
        // A visitor never sees this sentence with a gap in it, so the audit doesn't read one either.
        if (inner.every((x) => byTier.has($(x).attr('data-plan-price') ?? ''))) $(el).removeAttr('hidden');
        else $(el).remove();
    });
    return $.html();
}

/** The page's own prices, from its site's get-plans. [] on any failure — the markers then stay unfilled. */
async function loadSitePlans(pageUrl: string, crawler: Crawler, timeoutMs: number): Promise<SitePlanPrice[]> {
    try {
        const u = new URL('/.netlify/functions/get-plans', pageUrl);
        if (!(await robotsAllows(u.host, u.pathname, crawler))) return [];
        const res = await safeFetchText(u.toString(), { userAgent: crawler.userAgent, timeoutMs, maxBytes: 256 * 1024 });
        const data = JSON.parse(res.body);
        return Array.isArray(data?.plans) ? data.plans : [];
    } catch {
        return [];
    }
}

/** Fill the markers on a fetched page, if it has any. Never throws. */
export async function fillSitePlanPrices(html: string, pageUrl: string, crawler: Crawler, timeoutMs: number): Promise<string> {
    if (!html.includes(MARKER)) return html;
    return fillPlanPriceMarkers(html, await loadSitePlans(pageUrl, crawler, timeoutMs));
}
