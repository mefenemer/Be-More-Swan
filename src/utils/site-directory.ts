// src/utils/site-directory.ts — the site page directory: a MAP of the customer's website (each page's
// address, title, one-line summary and the main things it offers) that every live assistant reads.
// docs/site-directory-plan.md. PURE: no database, no network — tests/site-directory.test.ts runs it on
// saved pages. The database, the fetcher and the loader are site-directory-store.ts.
//
// ── Two sources ─────────────────────────────────────────────────────────────────────────────────
//   · A PUBLISHED Be More Swan site: read from its frozen definition (entriesFromDefinition) — no
//     fetch, no robots, no cost. Product sections name Business Information products, never prices.
//   · Any other site (organisations.website_url): sitemap.xml, else the home page's menu
//     (pickDirectoryUrls), each page read through the one fetcher (site-fetch.ts: robots.txt, then
//     the SSRF fence) and turned into an entry by RULES (entryFromImportPage).
//
// ── The model never writes a word (owner, 2026-10-31, plan D1) ──────────────────────────────────
// Summaries and offers are the site's own words: its meta description or first paragraph, its
// headings. Nothing is invented, so nothing costs a task (plan D6). Any line that states a price is
// dropped — prices live only in Business Information, which stays authoritative over the website.
//
// ── The prompt block is CAPPED ──────────────────────────────────────────────────────────────────
// SITE_DIRECTORY_CHAR_CAP (2,500, plan D3): the chat pays it every turn inside a 26 s request. Change
// the cap here only.

import type { ImportPage, SiteLink } from './site-extract';
import { readImportPage, statesPrice } from './site-extract';
import type { HtmlFetch } from './site-fetch';
import type { SiteDefinition, SitePageDef } from './site-definition';
import { FILE_PATH, SKIP_PATH } from './site-import';

/** Pages kept per site, home first (plan D5). */
export const DIRECTORY_MAX_PAGES = 30;
/** Pages re-read in headless Chrome per refresh, when the plain read was too thin (plan D4). */
export const DIRECTORY_MAX_RENDERS = 5;
/** Below this many words a page is re-read with its JavaScript run (same threshold as the import). */
export const DIRECTORY_THIN_WORDS = 40;
/** The whole prompt block, every surface (plan D3). */
export const SITE_DIRECTORY_CHAR_CAP = 2500;
export const SUMMARY_MAX = 140;
export const OFFERS_MAX = 4;
export const OFFER_MAX = 60;
export const TITLE_MAX = 80;
/** A weekly refresh; "Re-read my site" at most once an hour. */
export const REFRESH_INTERVAL_MS = 7 * 86_400_000;
export const MANUAL_COOLDOWN_MS = 60 * 60_000;
/** Sitemap files read at most (an index plus its children). */
export const SITEMAP_MAX_FILES = 4;

export type PageKind = 'home' | 'service' | 'about' | 'contact' | 'booking' | 'shop' | 'other';

export interface DirectoryPage {
    url: string;
    /** '/' for home, else '/workshops' — no trailing slash, no query. */
    path: string;
    title: string;
    summary: string | null;
    offers: string[];
    kind: PageKind;
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');
/** Whitespace collapsed, case kept (site-extract's normaliseText lowercases — it is for comparing). */
const tidy = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A page's path as the directory keys it: '/', '/about', never a trailing slash. */
export function directoryPath(url: string): string {
    try {
        const p = new URL(url).pathname.replace(/\/+$/, '');
        return p || '/';
    } catch { return '/'; }
}

/** An excluded path the owner (or the chat) sent, cleaned — or null. */
export function cleanDirectoryPath(raw: unknown): string | null {
    let s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s.length > 300) return null;
    if (/^https?:\/\//i.test(s)) s = directoryPath(s);
    if (!s.startsWith('/')) s = `/${s}`;
    s = s.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
    return /^\/[\w\-./~%]*$/.test(s) ? s : null;
}

/** Trim to `max` at a word boundary, with an ellipsis when cut. */
function clip(s: string, max: number): string {
    const t = tidy(s);
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** The first sentence, if it is a sensible length; else the text. */
function firstSentence(s: string): string {
    const t = tidy(s);
    const m = t.match(/^(.{30,}?[.!?])(\s|$)/);
    return m ? m[1] : t;
}

/** Words a summary or offer may never carry: a price, a draft's [placeholder], or nothing at all. */
function usable(s: string | null | undefined): s is string {
    if (!s) return false;
    const t = tidy(s);
    return t.length >= 3 && !statesPrice(t) && !/\[[^\]]+\]/.test(t);
}

/** Headings every site has that say nothing about what the page offers. */
const GENERIC_HEADING = /^(home|welcome.*|hello.*|hi there.*|about( us| me)?|contact( us| me)?|get in touch|say hello|find us|follow us.*|faqs?|(common )?questions|frequently asked questions|what we (do|offer)|our services|services|testimonials|reviews|what (our )?(customers|clients|people) say.*|our story|meet the team|the team|gallery|blog|latest (news|posts)|news(letter)?|sign up.*|subscribe.*|join (us|our).*|menu|book now|shop now|learn more|read more|more|why (choose )?us\??|how it works|opening (hours|times)|hours|location|address|social|instagram|facebook|copyright.*|privacy.*|terms.*|cookies?.*)$/i;

function offerOk(s: string): boolean {
    const t = tidy(s);
    // A question heading ("How long does it take?") is an FAQ, not something the page offers.
    return usable(t) && t.length <= OFFER_MAX && !t.endsWith('?') && !GENERIC_HEADING.test(t.replace(/[.!:]+$/, ''));
}

/** Up to OFFERS_MAX distinct offers, in order. */
function pickOffers(candidates: Array<string | null | undefined>): string[] {
    const out: string[] = [];
    for (const c of candidates) {
        if (out.length >= OFFERS_MAX) break;
        if (!c || !offerOk(c)) continue;
        const t = tidy(c).replace(/[.:]+$/, '');
        if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out;
}

function pickSummary(candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
        if (!usable(c)) continue;
        const t = clip(firstSentence(c), SUMMARY_MAX);
        if (t.length >= 12) return t;
    }
    return null;
}

/** Title tags often carry " | Business Name" — keep the page's own part. */
function cleanTitle(raw: string | null | undefined, siteName: string | null): string | null {
    if (!raw) return null;
    let t = tidy(raw);
    const parts = t.split(/\s+[|–—·•-]\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
        const own = parts.filter((p) => !siteName || p.toLowerCase() !== siteName.toLowerCase());
        t = own[0] ?? parts[0];
    }
    return t ? clip(t, TITLE_MAX) : null;
}

// ── What kind of page ───────────────────────────────────────────────────────────────────────────

/** Rule-based, from the address and the title. Home is the root. */
export function pageKind(path: string, title: string): PageKind {
    if (path === '/' || path === '') return 'home';
    const s = `${path} ${title}`.toLowerCase();
    if (/contact|get-in-touch|get in touch|enquir|find-us|find us|visit-us|visit us/.test(s)) return 'contact';
    if (/\bbook|appointment|reserv|timetable|schedule|classes\b/.test(s)) return 'booking';
    if (/\bshop\b|\bstore\b|\bbuy\b|products?\b|gift[- ]?cards?|vouchers?/.test(s)) return 'shop';
    if (/about|our-story|our story|\bteam\b|who-we-are|who we are|meet\b/.test(s)) return 'about';
    if (/service|treatment|what-we-do|what we do|offer|package|pricing|price|menu|course|workshop|class|therap|consult|design|repair|clean|install|lesson|session|program/.test(s)) return 'service';
    return 'other';
}

// ── Which pages (external sites) ────────────────────────────────────────────────────────────────

/** `<loc>` addresses in a sitemap, and whether it is an index of sitemaps. Never throws. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
    const urls: string[] = [];
    const sitemaps: string[] = [];
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) && urls.length + sitemaps.length < 5000) {
        const u = m[1].replace(/&amp;/g, '&');
        (isIndex ? sitemaps : urls).push(u);
    }
    return { urls, sitemaps };
}

/** `Sitemap:` lines in a robots.txt. */
export function sitemapsFromRobots(text: string): string[] {
    return text.split(/\r?\n/).map((l) => l.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1]).filter((u): u is string => !!u && /^https?:\/\//i.test(u));
}

/**
 * In a sitemap index, the children worth reading first: page sitemaps before post/product/tag ones
 * (WordPress, Yoast, Squarespace and Wix all split them like this).
 */
export function orderChildSitemaps(urls: string[]): string[] {
    const score = (u: string) => (/page/i.test(u) ? 0 : /(post|blog|product|tag|categor|author|event|news)/i.test(u) ? 2 : 1);
    return [...urls].sort((a, b) => score(a) - score(b));
}

/** A page address worth listing: same site, a web page, not shop machinery or legal small print. */
function worthListing(href: string, homeHost: string): URL | null {
    let u: URL;
    try { u = new URL(href); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (bareHost(u.hostname) !== homeHost) return null;
    if (FILE_PATH.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
    return u;
}

/**
 * The pages to read: home first, then menu pages in menu order, then sitemap pages (shallowest
 * first), de-duplicated by path, at most `limit`.
 */
export function pickDirectoryUrls(input: { home: string; navLinks: SiteLink[]; sitemapUrls: string[]; limit?: number }): string[] {
    const limit = input.limit ?? DIRECTORY_MAX_PAGES;
    let homeUrl: URL;
    try { homeUrl = new URL(input.home); } catch { return []; }
    const homeHost = bareHost(homeUrl.hostname);
    const out: string[] = [`${homeUrl.origin}/`];
    const seen = new Set<string>(['/']);
    const add = (href: string) => {
        if (out.length >= limit) return;
        const u = worthListing(href, homeHost);
        if (!u) return;
        const path = directoryPath(u.toString());
        if (seen.has(path)) return;
        seen.add(path);
        out.push(`${u.origin}${path === '/' ? '/' : path}`);
    };
    for (const l of input.navLinks) add(l.href);
    const depth = (u: string) => directoryPath(u).split('/').filter(Boolean).length;
    const sitemap = input.sitemapUrls.map((u, i) => ({ u, i })).sort((a, b) => depth(a.u) - depth(b.u) || a.i - b.i);
    for (const { u } of sitemap) add(u);
    return out;
}

// ── An entry from a page read (external sites) ──────────────────────────────────────────────────

/** One directory entry from a page read through readImportPage. Never invents: title, summary and offers are the page's own words. */
export function entryFromImportPage(page: ImportPage, url: string): DirectoryPage {
    const path = directoryPath(url);
    const headings = page.blocks.filter((b): b is Extract<typeof b, { kind: 'heading' }> => b.kind === 'heading');
    const h1 = headings.find((h) => h.level === 1)?.text ?? null;
    const title = cleanTitle(page.title, page.siteName) ?? (h1 ? clip(h1, TITLE_MAX) : null) ?? (path === '/' ? (page.siteName ?? 'Home') : path.split('/').pop()!.replace(/[-_]+/g, ' '));
    const paragraphs = page.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).filter((t) => t.length >= 40);
    const summary = pickSummary([page.description, ...paragraphs.slice(0, 3)]);
    const offers = pickOffers([
        ...headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text),
        ...page.blocks.filter((b) => b.kind === 'item').map((b) => (b as { text: string }).text),
    ]);
    return { url, path, title, summary, offers, kind: pageKind(path, title) };
}

// ── Entries from a published Be More Swan site ──────────────────────────────────────────────────

function pageOffers(p: SitePageDef, productNames: Map<number, string>): string[] {
    const cands: Array<string | null> = [];
    for (const s of p.sections) {
        switch (s.type) {
            case 'features': case 'steps': cands.push(...s.props.items.map((i) => i.title)); break;
            case 'products': cands.push(...s.props.productIds.map((id) => productNames.get(id) ?? null)); break;
            case 'menu': cands.push(...s.props.groups.flatMap((g) => g.productIds.map((id) => productNames.get(id) ?? null))); break;
            case 'booking': cands.push(...s.props.serviceIds.map((id) => productNames.get(id) ?? null)); break;
            default: break;
        }
    }
    return pickOffers(cands);
}

function pageSummary(p: SitePageDef, def: SiteDefinition): string | null {
    const cands: Array<string | null> = [p.seo?.description ?? null];
    for (const s of p.sections) {
        if (s.type === 'hero') cands.push(s.props.subheadline, s.props.headline);
        else if (s.type === 'text') cands.push(s.props.body);
        else if (s.type === 'features' || s.type === 'steps') cands.push(s.props.intro);
    }
    if (!p.slug) cands.push(def.settings?.description ?? null);
    return pickSummary(cands);
}

/** The directory of a published site, from its frozen definition. `origin` has no trailing slash. */
export function entriesFromDefinition(def: SiteDefinition, origin: string, productNames: Map<number, string>): DirectoryPage[] {
    const base = origin.replace(/\/+$/, '');
    const pages = Array.isArray(def?.pages) ? def.pages : [];
    // Home first, then menu order, then the rest — the order a visitor meets them.
    const navOrder = new Map((def.nav ?? []).map((n, i) => [n.pageId, i]));
    const ordered = [...pages].sort((a, b) => (a.slug ? 1 : 0) - (b.slug ? 1 : 0)
        || (navOrder.get(a.id) ?? 999) - (navOrder.get(b.id) ?? 999));
    return ordered.slice(0, DIRECTORY_MAX_PAGES).map((p) => {
        const path = p.slug ? `/${p.slug}` : '/';
        const title = clip(p.title || (p.slug ? p.slug.replace(/[-_]+/g, ' ') : def.settings?.siteName || 'Home'), TITLE_MAX);
        return { url: `${base}${path === '/' ? '/' : path}`, path, title, summary: pageSummary(p, def), offers: pageOffers(p, productNames), kind: pageKind(path, title) };
    });
}

// ── Reading a stored directory back safely ──────────────────────────────────────────────────────

/** Stored JSON → pages, dropping anything malformed. */
export function readPages(raw: unknown): DirectoryPage[] {
    if (!Array.isArray(raw)) return [];
    const kinds: PageKind[] = ['home', 'service', 'about', 'contact', 'booking', 'shop', 'other'];
    return raw.flatMap((p) => {
        if (!p || typeof p !== 'object') return [];
        const o = p as Record<string, unknown>;
        if (typeof o.url !== 'string' || typeof o.path !== 'string' || typeof o.title !== 'string') return [];
        return [{
            url: o.url, path: o.path, title: o.title,
            summary: typeof o.summary === 'string' ? o.summary : null,
            offers: Array.isArray(o.offers) ? o.offers.filter((x): x is string => typeof x === 'string').slice(0, OFFERS_MAX) : [],
            kind: kinds.includes(o.kind as PageKind) ? o.kind as PageKind : 'other',
        }];
    });
}

export function readExcluded(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.map(cleanDirectoryPath).filter((p): p is string => !!p) : [];
}

// ── The prompt block ────────────────────────────────────────────────────────────────────────────

export const SITE_DIRECTORY_DIRECTIVE = 'Use these to link to the most relevant page instead of the homepage, and only ever link to pages listed here. ' +
    'Business Information is authoritative: if a page disagrees with it, follow Business Information. ' +
    'Never quote prices from the website; prices come only from Products & Services.';

/** Which pages win the cap: home and contact always, then what the business sells, then the rest. */
const KIND_RANK: Record<PageKind, number> = { home: 0, contact: 1, service: 2, booking: 3, shop: 4, about: 5, other: 6 };

/**
 * One line per page, with the FULL address: link grounding (layout-ir.ts groundLinks) keeps only a
 * link that appears verbatim in what the model was given, so a bare path would be stripped.
 */
function pageLine(p: DirectoryPage): string {
    const offers = p.offers.length ? ` (${p.offers.join('; ')})` : '';
    return `- ${p.url} — ${p.title}${p.summary ? `: ${p.summary}` : ''}${offers}`;
}

/**
 * The block every assistant reads, or null when there is no directory. Excluded pages never appear;
 * lines are dropped whole (lowest rank first) to stay under SITE_DIRECTORY_CHAR_CAP, keeping the
 * original order among those kept.
 */
export function siteDirectoryPromptBlock(d: { pages: DirectoryPage[]; excluded?: string[] } | null | undefined): string | null {
    const excluded = new Set(d?.excluded ?? []);
    const pages = (d?.pages ?? []).filter((p) => !excluded.has(p.path));
    if (!pages.length) return null;
    const head = `YOUR WEBSITE'S PAGES — ${SITE_DIRECTORY_DIRECTIVE}`;
    const ranked = pages.map((p, i) => ({ p, i, line: pageLine(p) }))
        .sort((a, b) => KIND_RANK[a.p.kind] - KIND_RANK[b.p.kind] || a.i - b.i);
    const keep: typeof ranked = [];
    let used = head.length + 40;   // room for the "(+N more pages)" line
    for (const r of ranked) {
        const line = r.line.length > 400 ? `${r.line.slice(0, 399)}…` : r.line;
        if (used + line.length + 1 > SITE_DIRECTORY_CHAR_CAP) continue;
        keep.push({ ...r, line });
        used += line.length + 1;
    }
    keep.sort((a, b) => a.i - b.i);
    const more = pages.length - keep.length;
    return [head, ...keep.map((k) => k.line), more > 0 ? `(+${more} more pages not shown)` : ''].filter(Boolean).join('\n');
}

// ── What the site lacks (the Business Mentor) ───────────────────────────────────────────────────

const words = (s: string) => tidy(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);

/**
 * Gaps a coach would point out: Business Information products/services with no page that names
 * them, and no contact or about page. Deterministic; empty when there is no directory.
 */
export function directoryGaps(pages: DirectoryPage[], productNames: string[]): string[] {
    if (!pages.length) return [];
    const gaps: string[] = [];
    if (!pages.some((p) => p.kind === 'contact')) gaps.push('No contact page — buyers look for one before they get in touch.');
    if (!pages.some((p) => p.kind === 'about')) gaps.push('No about page — nothing tells a buyer who is behind the business.');
    const haystack = pages.map((p) => `${p.path} ${p.title} ${p.summary ?? ''} ${p.offers.join(' ')}`.toLowerCase()).join(' \n ');
    const missing = productNames.filter((n) => {
        const w = words(n);
        return w.length > 0 && !w.some((x) => haystack.includes(x));
    });
    if (missing.length) gaps.push(`Sold in Business Information but not named on any page: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}.`);
    return gaps;
}

// ── Reading an external site ────────────────────────────────────────────────────────────────────


export interface CrawlDeps {
    /** robots.txt, then the SSRF-fenced fetch (site-fetch.ts). Also used for sitemap XML. */
    fetchHtml(url: string): Promise<HtmlFetch>;
    /** A plain-text file (robots.txt), or null. */
    fetchText(url: string): Promise<string | null>;
    /** Headless Chrome, only after fetchHtml read the same page; absent = never render. */
    renderHtml?(url: string): Promise<HtmlFetch>;
}

export type CrawlResult =
    | { ok: true; pages: DirectoryPage[]; skipped: number; homeUrl: string }
    | { ok: false; message: string };

async function sitemapPageUrls(origin: string, deps: CrawlDeps): Promise<string[]> {
    const robots = await deps.fetchText(`${origin}/robots.txt`).catch(() => null);
    const queue = [...(robots ? sitemapsFromRobots(robots) : []), `${origin}/sitemap.xml`];
    const seen = new Set<string>();
    const urls: string[] = [];
    let files = 0;
    while (queue.length && files < SITEMAP_MAX_FILES && urls.length < 2000) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        files++;
        const res = await deps.fetchHtml(next);
        if (!res.ok) continue;
        const parsed = parseSitemap(res.html);
        urls.push(...parsed.urls);
        queue.unshift(...orderChildSitemaps(parsed.sitemaps).filter((s) => !seen.has(s)));
    }
    return urls;
}

/**
 * Read the site: the home page (its menu), the sitemap, then each chosen page. A page we couldn't
 * read is skipped, not fatal; only an unreadable home page fails the refresh (with the owner-readable
 * message from the fetcher). Never throws.
 */
export async function crawlSite(startUrl: string, deps: CrawlDeps): Promise<CrawlResult> {
    let renders = 0;
    const read = async (url: string): Promise<{ page: ImportPage; url: string } | null> => {
        const res = await deps.fetchHtml(url);
        if (!res.ok) return null;
        let page = readImportPage(res.html, res.finalUrl);
        if (page.words < DIRECTORY_THIN_WORDS && deps.renderHtml && renders < DIRECTORY_MAX_RENDERS) {
            renders++;
            const r = await deps.renderHtml(res.finalUrl).catch(() => null);
            if (r?.ok) {
                const rendered = readImportPage(r.html, r.finalUrl);
                if (rendered.words > page.words) page = rendered;
            }
        }
        return { page, url: res.finalUrl };
    };
    try {
        const first = await deps.fetchHtml(startUrl);
        if (!first.ok) return { ok: false, message: first.message };
        const homeUrl = first.finalUrl;
        const origin = new URL(homeUrl).origin;
        const home = await read(homeUrl);
        if (!home) return { ok: false, message: 'We couldn\'t read your home page just now.' };
        const sitemapUrls = await sitemapPageUrls(origin, deps);
        const urls = pickDirectoryUrls({ home: homeUrl, navLinks: home.page.navLinks, sitemapUrls });
        const pages: DirectoryPage[] = [{ ...entryFromImportPage(home.page, `${origin}/`), path: '/', kind: 'home' }];
        let skipped = 0;
        for (const url of urls.slice(1)) {
            const got = await read(url);
            // Redirected off the site, or to a page we already have (a moved page pointing home).
            if (!got || bareHost(new URL(got.url).hostname) !== bareHost(new URL(origin).hostname) || pages.some((p) => p.path === directoryPath(got.url))) { skipped++; continue; }
            pages.push(entryFromImportPage(got.page, `${origin}${directoryPath(got.url)}`));
        }
        return { ok: true, pages, skipped, homeUrl };
    } catch (err) {
        console.error('[site-directory] crawl failed', { startUrl, message: err instanceof Error ? err.message : String(err) });
        return { ok: false, message: 'We couldn\'t read your website just now.' };
    }
}

/** The Blog Writer's extra line under the block: internal links, to listed pages only. */
export const BLOG_INTERNAL_LINKS_HINT = 'In the article, add 2–3 internal links to the most relevant of these pages, written into the sentence (never a bare list of links). Only link pages listed above.';
