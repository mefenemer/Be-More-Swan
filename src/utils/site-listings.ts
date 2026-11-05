// src/utils/site-listings.ts — Listings (docs/website-types-plan.md §4): a workspace's own lists
// shown on its website. One engine for an events calendar or directory ("event": dated) and every
// other list of entries — places, people, jobs, case studies ("entry": no date).
// db/z-site-listings.sql. tests/site-listings.test.ts.
//
// What is saved is what the owner (or, once they approve it, a visitor) wrote: the checks here tidy
// spacing and refuse what can't be shown — never reword. Dates and times are kept exactly as typed
// (DATE + 'HH:MM'), so British Summer Time never moves an event by an hour.

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, siteListings } from '../../db/schema';
import type { SiteDefinition } from './site-definition';

type Db = ReturnType<typeof getDb>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type ListingRow = typeof siteListings.$inferSelect;

export const LISTING_KINDS = ['event', 'entry'] as const;
export type ListingKind = typeof LISTING_KINDS[number];
export const LISTING_STATUSES = ['published', 'hidden', 'pending', 'declined'] as const;
/** Where an entry's own page lives: /listings/<slug>. A page may not take this address. */
export const LISTING_PATH = '/listings';
export const LISTING_LIMITS = {
    title: 120, category: 40, summary: 300, body: 5000, location: 160, alt: 200, url: 500, linkLabel: 40,
    name: 80, email: 200, perWorkspace: 2000, batch: 30, onSite: 500,
} as const;
/** Visitors posting from the site: no faster than a person could fill the form, and a cap per address. */
export const LISTING_MIN_FILL_MS = 4000;
export const LISTING_PER_IP = { maxAttempts: 6, windowSecs: 3600 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const tidyLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const tidyBody = (v: unknown, max: number) => (typeof v === 'string'
    ? v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
    : '');
const has = (raw: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(raw, k);

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function validDate(v: unknown): string | null {
    if (typeof v !== 'string' || !DATE_RE.test(v.trim())) return null;
    const d = v.trim();
    const t = new Date(`${d}T12:00:00Z`);
    return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d ? null : d;
}
/** '7:30' / '07:30' / '19:30' → 'HH:MM'; anything else → null. */
export function validTime(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const t = `${m[1].padStart(2, '0')}:${m[2]}`;
    return TIME_RE.test(t) ? t : null;
}
/** A link a visitor can follow: https (or http), mailto: or tel:. */
export function cleanLink(v: unknown): string | null {
    const s = tidyLine(v, LISTING_LIMITS.url);
    if (!s) return null;
    if (/^(mailto:|tel:)/i.test(s)) return s;
    const withScheme = /^https?:\/\//i.test(s) ? s : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s) ? `https://${s}` : '';
    try { const u = new URL(withScheme); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}
export function listingSlugBase(title: string): string {
    const s = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    return s || 'listing';
}

/** Today's date in the UK, YYYY-MM-DD — "upcoming" means on or after this. */
export function ukToday(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * One listing to save. `partial` = an edit (only the fields sent change). The owner's fields only —
 * status, source and who sent it are set by the caller, never from here.
 */
export function cleanListing(raw: Record<string, unknown>, partial: boolean): Result<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (!partial || has(raw, 'kind')) {
        const k = raw.kind ?? 'event';
        if (!(LISTING_KINDS as readonly unknown[]).includes(k)) return { ok: false, error: 'A listing is an event (with a date) or an entry (no date).' };
        out.kind = k;
    }
    if (!partial || has(raw, 'title')) {
        const t = tidyLine(raw.title, LISTING_LIMITS.title);
        if (!t) return { ok: false, error: 'Give it a name.' };
        out.title = t;
    }
    if (has(raw, 'category')) out.category = tidyLine(raw.category, LISTING_LIMITS.category) || null;
    if (has(raw, 'summary')) out.summary = tidyLine(raw.summary, LISTING_LIMITS.summary) || null;
    if (has(raw, 'body')) out.body = tidyBody(raw.body, LISTING_LIMITS.body) || null;
    if (has(raw, 'location')) out.location = tidyLine(raw.location, LISTING_LIMITS.location) || null;
    for (const [k, col] of [['startsOn', 'startsOn'], ['endsOn', 'endsOn']] as const) {
        if (!has(raw, k)) continue;
        if (raw[k] === null || raw[k] === '') { out[col] = null; continue; }
        const d = validDate(raw[k]);
        if (!d) return { ok: false, error: 'Dates are written like 2026-06-14.' };
        out[col] = d;
    }
    for (const k of ['startTime', 'endTime'] as const) {
        if (!has(raw, k)) continue;
        if (raw[k] === null || raw[k] === '') { out[k] = null; continue; }
        const t = validTime(raw[k]);
        if (!t) return { ok: false, error: 'Times are written like 19:30.' };
        out[k] = t;
    }
    if (has(raw, 'linkUrl')) {
        if (raw.linkUrl === null || raw.linkUrl === '') out.linkUrl = null;
        else {
            const u = cleanLink(raw.linkUrl);
            if (!u) return { ok: false, error: 'The link must be a web address (https://…), an email (mailto:) or a phone number (tel:).' };
            out.linkUrl = u;
        }
    }
    if (has(raw, 'linkLabel')) out.linkLabel = tidyLine(raw.linkLabel, LISTING_LIMITS.linkLabel) || null;
    if (has(raw, 'imageAssetId')) {
        const n = raw.imageAssetId === null || raw.imageAssetId === '' ? null : Number(raw.imageAssetId);
        if (n !== null && (!Number.isInteger(n) || n <= 0)) return { ok: false, error: 'That picture can\'t be used.' };
        out.imageAssetId = n;
    }
    if (has(raw, 'imageAlt')) out.imageAlt = tidyLine(raw.imageAlt, LISTING_LIMITS.alt) || null;
    return { ok: true, value: out };
}

/** The rules that need the whole listing (after an edit is merged): an event has a start date, the end isn't before it. */
export function checkWhole(l: { kind: string; startsOn: string | null; endsOn: string | null; startTime: string | null; endTime: string | null; imageAssetId: number | null; imageAlt: string | null }): string | null {
    if (l.kind === 'event' && !l.startsOn) return 'An event needs the date it starts.';
    if (l.endsOn && l.startsOn && l.endsOn < l.startsOn) return 'It can\'t end before it starts.';
    if (l.endTime && !l.startTime) return 'Add the start time too.';
    if (l.imageAssetId && !l.imageAlt) return 'Say in a few words what the picture shows.';
    return null;
}

/** A slug free in this workspace: "summer-fair", then "summer-fair-2"… (exceptId: the listing being edited). */
export async function freeSlug(db: Db, orgId: number, title: string, exceptId: number | null = null): Promise<string> {
    const base = listingSlugBase(title);
    const rows = await db.select({ slug: siteListings.slug }).from(siteListings)
        .where(and(eq(siteListings.organisationId, orgId), sql`${siteListings.slug} LIKE ${`${base}%`}`, ...(exceptId ? [ne(siteListings.id, exceptId)] : [])));
    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${Date.now()}`;
}

/** The picture is this workspace's own library picture. */
export async function ownsAsset(db: Db, orgId: number, assetId: number): Promise<boolean> {
    const [a] = await db.select({ assetType: contentAssets.assetType, status: contentAssets.status }).from(contentAssets)
        .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId))).limit(1);
    return !!a && a.assetType === 'image' && a.status !== 'rejected';
}

// ── Words for dates ──────────────────────────────────────────────────────────
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DAY[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };
/** "Sat 14 Jun 2026, 19:30–22:00" · "Fri 1 – Sun 3 Aug 2026" · '' for an entry. */
export function whenText(l: { startsOn: string | null; startTime: string | null; endsOn: string | null; endTime: string | null }): string {
    if (!l.startsOn) return '';
    const multi = l.endsOn && l.endsOn !== l.startsOn;
    if (multi) return `${dayText(l.startsOn)}${l.startTime ? `, ${l.startTime}` : ''} – ${dayText(l.endsOn!)}${l.endTime ? `, ${l.endTime}` : ''}`;
    return `${dayText(l.startsOn)}${l.startTime ? `, ${l.startTime}${l.endTime ? `–${l.endTime}` : ''}` : ''}`;
}

// ── What a website draws ─────────────────────────────────────────────────────
export interface SiteRenderListing {
    id: number; kind: ListingKind; slug: string; title: string; category: string | null; summary: string | null; body: string | null;
    startsOn: string | null; startTime: string | null; endsOn: string | null; endTime: string | null; when: string;
    location: string | null; imageAssetId: number | null; imageAlt: string | null; linkUrl: string | null; linkLabel: string | null;
}
export interface SiteRenderListings { all: SiteRenderListing[]; today: string; }

export function toRender(r: ListingRow): SiteRenderListing {
    return {
        id: r.id, kind: (r.kind === 'entry' ? 'entry' : 'event'), slug: r.slug, title: r.title, category: r.category, summary: r.summary, body: r.body,
        startsOn: r.startsOn, startTime: r.startTime, endsOn: r.endsOn, endTime: r.endTime, when: whenText(r),
        location: r.location, imageAssetId: r.imageAssetId, imageAlt: r.imageAlt, linkUrl: r.linkUrl, linkLabel: r.linkLabel,
    };
}
/** Events by date then time; entries by name. */
export function sortListings<T extends { kind: string; startsOn: string | null; startTime: string | null; title: string }>(list: T[]): T[] {
    return [...list].sort((a, b) => (a.kind !== b.kind ? (a.kind === 'event' ? -1 : 1)
        : a.kind === 'event' ? `${a.startsOn}${a.startTime ?? '00:00'}`.localeCompare(`${b.startsOn}${b.startTime ?? '00:00'}`) : a.title.localeCompare(b.title)));
}
/** Still to come (or on now): it ends — or, with no end, starts — today or later. */
export const isUpcoming = (l: { kind: string; startsOn: string | null; endsOn: string | null }, today: string): boolean =>
    l.kind !== 'event' || !!((l.endsOn ?? l.startsOn) && (l.endsOn ?? l.startsOn)! >= today);

/** What a section shows: its kind, its categories (none ticked = all), upcoming or all, a category picked from its filter. */
export function listingsFor(data: SiteRenderListings | null, p: { kind: ListingKind; categories: string[]; show: 'upcoming' | 'all'; count: number }, picked: string | null = null): SiteRenderListing[] {
    if (!data) return [];
    const cats = p.categories.map((c) => c.toLowerCase());
    return sortListings(data.all.filter((l) => l.kind === p.kind
        && (!cats.length || (l.category && cats.includes(l.category.toLowerCase())))
        && (!picked || (l.category || '').toLowerCase() === picked.toLowerCase())
        && (p.show === 'all' || isUpcoming(l, data.today)))).slice(0, p.count);
}

/** Every published listing a site may need — only when one of its pages has a listings section. */
export async function loadSiteListings(db: Db, orgId: number, def: SiteDefinition, now = new Date()): Promise<SiteRenderListings | null> {
    if (!def.pages.some((p) => p.sections.some((s) => s.type === 'listings'))) return null;
    const rows = await db.select().from(siteListings)
        .where(and(eq(siteListings.organisationId, orgId), eq(siteListings.status, 'published')))
        .orderBy(asc(siteListings.startsOn), asc(siteListings.id)).limit(LISTING_LIMITS.onSite);
    return { all: rows.map(toRender), today: ukToday(now) };
}
/** One published listing by its address, for /listings/<slug>. */
export async function loadListingBySlug(db: Db, orgId: number, slug: string): Promise<SiteRenderListing | null> {
    const [r] = await db.select().from(siteListings)
        .where(and(eq(siteListings.organisationId, orgId), eq(siteListings.slug, slug), eq(siteListings.status, 'published'))).limit(1);
    return r ? toRender(r) : null;
}
/** /listings/<slug> or /listings/<slug>.ics → the slug and which. */
export function listingRoute(path: string): { slug: string; ics: boolean } | null {
    const m = /^\/listings\/([^/]+?)(\.ics)?\/?$/.exec((path || '').split(/[?#]/)[0]);
    if (!m) return null;
    let slug: string;
    try { slug = decodeURIComponent(m[1]); } catch { return null; }
    return /^[a-z0-9-]{1,80}$/.test(slug) ? { slug, ics: !!m[2] } : null;
}
/** The sitemap: every published listing's page. */
export async function listingSlugs(db: Db, orgId: number): Promise<Array<{ slug: string; lastmod: string | null }>> {
    const rows = await db.select({ slug: siteListings.slug, updatedAt: siteListings.updatedAt }).from(siteListings)
        .where(and(eq(siteListings.organisationId, orgId), eq(siteListings.status, 'published'))).limit(LISTING_LIMITS.onSite);
    return rows.map((r) => ({ slug: r.slug, lastmod: r.updatedAt ? new Date(r.updatedAt).toISOString() : null }));
}

// ── "Add to calendar" (.ics) ─────────────────────────────────────────────────
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Lines longer than 75 octets are folded (RFC 5545 §3.1). */
const fold = (line: string) => { const out: string[] = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ` ${s.slice(74)}`; } out.push(s); return out.join('\r\n'); };
const plusDay = (d: string) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
export function listingIcs(l: SiteRenderListing, siteName: string, pageUrl: string, now = new Date()): string | null {
    if (l.kind !== 'event' || !l.startsOn) return null;
    const d = (x: string) => x.replace(/-/g, '');
    const t = (x: string) => `${x.replace(':', '')}00`;
    const end = l.endsOn ?? l.startsOn;
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Be More Swan//${icsText(siteName)}//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
        `UID:listing-${l.id}@bemoreswan.site`, `DTSTAMP:${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
        ...(l.startTime
            ? [`DTSTART;TZID=Europe/London:${d(l.startsOn)}T${t(l.startTime)}`, `DTEND;TZID=Europe/London:${d(end)}T${t(l.endTime ?? l.startTime)}`]
            : [`DTSTART;VALUE=DATE:${d(l.startsOn)}`, `DTEND;VALUE=DATE:${d(plusDay(end))}`]),
        `SUMMARY:${icsText(l.title)}`,
        ...(l.location ? [`LOCATION:${icsText(l.location)}`] : []),
        `DESCRIPTION:${icsText([l.summary, pageUrl].filter(Boolean).join('\n\n'))}`,
        `URL:${pageUrl}`, 'END:VEVENT', 'END:VCALENDAR',
    ];
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** schema.org for one listing's page: an Event (search engines show the date), or a Thing. */
export function listingLd(l: SiteRenderListing, siteName: string, pageUrl: string, imageUrl: string | null): Record<string, unknown> {
    if (l.kind !== 'event' || !l.startsOn) return { '@context': 'https://schema.org', '@type': 'Thing', name: l.title, url: pageUrl, ...(l.summary ? { description: l.summary } : {}), ...(imageUrl ? { image: imageUrl } : {}) };
    return {
        '@context': 'https://schema.org', '@type': 'Event', name: l.title, url: pageUrl,
        startDate: l.startTime ? `${l.startsOn}T${l.startTime}` : l.startsOn,
        ...(l.endsOn || l.endTime ? { endDate: l.endTime ? `${l.endsOn ?? l.startsOn}T${l.endTime}` : l.endsOn } : {}),
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        ...(l.location ? { location: { '@type': 'Place', name: l.location, address: l.location } } : {}),
        ...(l.summary ? { description: l.summary } : {}),
        ...(imageUrl ? { image: imageUrl } : {}),
        organizer: { '@type': 'Organization', name: siteName },
    };
}

// ── For the chat ─────────────────────────────────────────────────────────────
export async function listingsForPrompt(db: Db, orgId: number, now = new Date()): Promise<string> {
    const today = ukToday(now);
    const rows = await db.select().from(siteListings)
        .where(and(eq(siteListings.organisationId, orgId), inArray(siteListings.status, ['published', 'hidden', 'pending'])))
        .orderBy(asc(siteListings.startsOn), asc(siteListings.id)).limit(400);
    const pending = rows.filter((r) => r.status === 'pending');
    const live = sortListings(rows.filter((r) => r.status !== 'pending' && isUpcoming(r, today))).slice(0, 25);
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].slice(0, 20);
    const line = (r: ListingRow) => `listingId ${r.id} — ${r.kind === 'event' ? `${whenText(r)}: ` : ''}${r.title}${r.category ? ` [${r.category}]` : ''}${r.location ? `, ${r.location}` : ''}${r.status === 'hidden' ? ' (hidden)' : ''}`;
    if (!rows.length) return 'Listings (the Listings tab): none yet. A listings section shows them — events (with dates) or entries (places, people, jobs). Add them with a listings_add card from what the user tells you.';
    return [
        `Listings (the Listings tab; today is ${today}): ${rows.length} kept.${cats.length ? ` Categories in use: ${cats.join(', ')}.` : ''}`,
        live.length ? `Upcoming / current: ${live.map(line).join('; ')}.` : 'Nothing upcoming.',
        pending.length ? `Waiting for their approval (sent in by visitors; for a listing_decisions card): ${pending.slice(0, 10).map((r) => `${line(r)} — from ${r.submitterName || 'a visitor'}: "${(r.summary || r.body || '').replace(/\s+/g, ' ').slice(0, 140)}"`).join('; ')}.` : '',
    ].filter(Boolean).join(' ');
}
