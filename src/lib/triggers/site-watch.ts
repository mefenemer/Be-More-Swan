// src/lib/triggers/site-watch.ts
// Buying triggers Phase 4 (docs/buying-triggers-plan.md §5): "website changed" for companies on the Watch list.
//
// Pure: no network, no database. Two signals, both fixed wording:
//   1. A watched website ADDS a tool: ad tracking (Meta Pixel, Google Ads, TikTok Pixel), a booking tool, an
//      online shop, or moves to a different website builder. Read from the homepage's HTML with narrow,
//      literal markers (a loose marker would label half the web, as lead-intel.ts PLATFORM_MARKERS warns).
//      The first read is the silent baseline; a tool that disappears is never reported (a page that half
//      loaded would look like a removal).
//   2. A watched company with NO website gets one: the first public security certificate (crt.sh) for a
//      domain that is exactly the company's name. Worded "may be theirs": a name match is not proof.

import type { WatchSignal } from './ch-watch';

export type SiteMarkerGroup = 'ads' | 'booking' | 'shop' | 'builder';

export interface SiteMarker { key: string; label: string; group: SiteMarkerGroup; re: RegExp }

export const SITE_MARKERS: SiteMarker[] = [
    // Ad tracking: the business is (or is about to start) paying for ads.
    { key: 'meta_pixel', label: 'the Meta (Facebook) Pixel', group: 'ads', re: /connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(\s*['"]init['"]/i },
    { key: 'google_ads', label: 'Google Ads conversion tracking', group: 'ads', re: /googleadservices\.com\/pagead\/conversion|gtag\(\s*['"]config['"]\s*,\s*['"]AW-\d+|[?&]id=AW-\d+/i },
    { key: 'tiktok_pixel', label: 'the TikTok Pixel', group: 'ads', re: /analytics\.tiktok\.com\/i18n\/pixel|ttq\.load\(/i },
    // Booking: it now takes appointments or tables online.
    { key: 'calendly', label: 'Calendly bookings', group: 'booking', re: /assets\.calendly\.com|calendly\.com\/[a-z0-9_-]+/i },
    { key: 'acuity', label: 'Acuity Scheduling bookings', group: 'booking', re: /acuityscheduling\.com/i },
    { key: 'fresha', label: 'Fresha bookings', group: 'booking', re: /fresha\.com\/(?:a|book|providers|lvp)\//i },
    { key: 'treatwell', label: 'Treatwell bookings', group: 'booking', re: /widget\.treatwell\.|treatwell\.co\.uk\/place\//i },
    { key: 'simplybook', label: 'SimplyBook.me bookings', group: 'booking', re: /\.simplybook\.(me|it|cc)/i },
    { key: 'opentable', label: 'OpenTable reservations', group: 'booking', re: /opentable\.(co\.uk|com)\/(restref|widget|r\/)/i },
    { key: 'resdiary', label: 'ResDiary reservations', group: 'booking', re: /resdiary\.com/i },
    // Shop: it now sells online.
    { key: 'shopify', label: 'a Shopify shop', group: 'shop', re: /cdn\.shopify\.com|Shopify\.theme/i },
    { key: 'woocommerce', label: 'a WooCommerce shop', group: 'shop', re: /\/plugins\/woocommerce\/|woocommerce-(page|cart|checkout)/i },
    { key: 'square_online', label: 'a Square Online shop', group: 'shop', re: /square\.site|squareup\.com\/(online-store|appointments)/i },
    { key: 'ecwid', label: 'an Ecwid shop', group: 'shop', re: /app\.ecwid\.com/i },
    { key: 'stripe', label: 'Stripe payments', group: 'shop', re: /js\.stripe\.com/i },
    // Builder: a new website (a rebuild is a project that just finished, or one about to need help).
    { key: 'wordpress', label: 'WordPress', group: 'builder', re: /\/wp-content\/|\/wp-includes\//i },
    { key: 'wix', label: 'Wix', group: 'builder', re: /static\.wixstatic\.com|wix-code-sdk|_wixCIDX/i },
    { key: 'squarespace', label: 'Squarespace', group: 'builder', re: /static1\.squarespace\.com|squarespace-cdn\.com/i },
    { key: 'webflow', label: 'Webflow', group: 'builder', re: /data-wf-site=|assets\.website-files\.com/i },
    { key: 'godaddy', label: 'GoDaddy Website Builder', group: 'builder', re: /img1\.wsimg\.com\/isteam/i },
];

const BY_KEY = new Map(SITE_MARKERS.map((m) => [m.key, m]));

/** A homepage this short is a parked page, a JS shell or an error page: never a baseline or a diff. */
export const MIN_HOMEPAGE_CHARS = 1500;

/** Marker keys found in one homepage, sorted. */
export function detectSiteMarkers(html: string): string[] {
    return SITE_MARKERS.filter((m) => m.re.test(html)).map((m) => m.key).sort();
}

function friendly(iso: string): string {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The tools a site ADDED since the last read → signals. `prev` null = first read (baseline, nothing).
 * A change of builder is one signal ("rebuilt its website on X"), not one per marker.
 */
export function siteChangesToSignals(prev: string[] | null, next: string[], domain: string, seenOn: string): WatchSignal[] {
    if (prev === null) return [];
    const before = new Set(prev);
    const added = next.filter((k) => !before.has(k)).map((k) => BY_KEY.get(k)).filter((m): m is SiteMarker => !!m);
    const url = `https://${domain}`;
    const out: WatchSignal[] = [];
    for (const m of added) {
        if (m.group === 'builder') continue;
        const kind = m.group === 'ads' ? 'ad_tracking_added' : m.group === 'booking' ? 'booking_added' : 'shop_added';
        const text = m.group === 'ads' ? `Added ${m.label} to its website: it may be starting to advertise`
            : m.group === 'booking' ? `Started taking ${m.label} on its website`
            : `Added ${m.label} to its website`;
        out.push({ kind, direction: 'positive', text, occurredOn: seenOn, ref: `site:${m.key}`, url });
    }
    const newBuilder = added.find((m) => m.group === 'builder');
    const oldBuilders = prev.map((k) => BY_KEY.get(k)).filter((m) => m && m.group === 'builder') as SiteMarker[];
    if (newBuilder && oldBuilders.length && !next.includes(oldBuilders[0].key)) {
        out.push({
            kind: 'website_rebuilt', direction: 'neutral', occurredOn: seenOn, url,
            text: `Rebuilt its website on ${newBuilder.label} (it was ${oldBuilders[0].label}), seen ${friendly(seenOn)}`,
            ref: `site:rebuilt:${newBuilder.key}`,
        });
    }
    return out;
}

// ── A first website (crt.sh) ─────────────────────────────────────────────────────────────────────

/** Domain endings a UK company's own site would use. A .net or a foreign ending is too likely someone else. */
export const LAUNCH_TLDS = ['co.uk', 'uk', 'com'];

/** "Acme Signs Ltd" → "acmesigns". Company-form words dropped. Null when too short to be distinctive. */
export function nameSlug(companyName: string | null | undefined): string | null {
    const s = String(companyName || '').toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\b(limited|ltd|plc|llp|lp|cic|company|co|the|uk)\b\.?/g, ' ')
        .replace(/[^a-z0-9]+/g, '');
    return s.length >= 6 ? s : null;
}

export interface CrtEntry { name_value?: string; not_before?: string }

/**
 * The earliest certificate for a domain that IS the company's name (slug + an allowed ending, with or
 * without www), or null. Pure. Subdomains of other sites and near-misses never count.
 */
export function firstCertForName(entries: CrtEntry[], slug: string): { domain: string; firstSeen: string } | null {
    const allowed = new Set(LAUNCH_TLDS.map((t) => `${slug}.${t}`));
    const best = new Map<string, string>();
    for (const e of entries) {
        const day = String(e.not_before || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        for (const raw of String(e.name_value || '').split(/\s+/)) {
            const d = raw.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
            if (!allowed.has(d)) continue;
            const had = best.get(d);
            if (!had || day < had) best.set(d, day);
        }
    }
    let pick: { domain: string; firstSeen: string } | null = null;
    for (const [domain, firstSeen] of best) if (!pick || firstSeen < pick.firstSeen) pick = { domain, firstSeen };
    return pick;
}

/**
 * A launch signal, only when the first certificate came AFTER we started watching (so a site that already
 * existed is never "news"). `watchedSince` is YYYY-MM-DD.
 */
export function launchSignal(found: { domain: string; firstSeen: string } | null, watchedSince: string): WatchSignal | null {
    if (!found || found.firstSeen < watchedSince) return null;
    return {
        kind: 'website_launched',
        direction: 'positive',
        text: `A website named ${found.domain} went live on ${friendly(found.firstSeen)} (its first security certificate). It may be theirs: check before you mention it`,
        occurredOn: found.firstSeen,
        ref: `launch:${found.domain}`,
        url: `https://${found.domain}`,
    };
}

/** "https://www.Acme.co.uk/shop" → "acme.co.uk". Null when it is not a usable public domain. */
export function normaliseDomain(raw: unknown): string | null {
    let s = String(raw ?? '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && !/\.(local|internal|test|invalid|localhost)$/.test(s) ? s : null;
}
