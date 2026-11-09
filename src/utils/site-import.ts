// src/utils/site-import.ts — "Import my current site": the owner's existing website (Wix, Squarespace,
// WordPress or bespoke) turned into a DRAFT of their Be More Swan site. docs/website-assistant-plan.md
// §5.3 step 1. PURE: no database, no network — tests/site-import.test.ts runs it on saved pages.
//
// ── The model never writes a word ───────────────────────────────────────────────────────────────
// The same rule as "Add your own words" (site-words.ts). Each page read (site-extract.ts
// readImportPage) becomes numbered BLOCKS — a heading, a paragraph, a list item, a quote, a button, a
// picture. The model sees the numbered blocks and answers only with a PLAN: which block numbers make
// which of OUR sections. assembleImport() then builds the sections from the owner's blocks, so every
// word on the draft is a word from their own site, by construction. Their HTML and CSS never travel:
// only text and (if they say so) pictures, through the one gate (normaliseSiteDefinition).
//
// Honesty rules, enforced here rather than asked of the model:
//   · A block that states a price is never put on the site — prices live in Business Information
//     (memory: prices are mastered there). The review lists them so the owner can add them there.
//   · Nothing is invented. What a page needs and the old site did not say stays a [placeholder].
//   · Nothing is silently lost: a block the plan neither places nor marks as clutter is added as text
//     at the end of its page; what the model calls clutter is listed in the review for the owner.
//   · A contact section never offers "send me news" — enquiries never go to the Audience.

import type { ImportBlock, ImportedProduct, ImportPage, SiteLink } from './site-extract';
import { IMPORT_LIMITS, normaliseText, readImportPage, statesPrice } from './site-extract';
import { priceDisplay, priceFromText, type PriceCurrency, type PriceType } from './product-price';
import {
    cleanHref, LIMITS, normaliseSiteDefinition, RESERVED_SLUGS, sectionAllowed, type SectionType, type SiteDefinition,
    BLOG_PATH, redirectKey,
} from './site-definition';
import { chunkBodies } from './site-words';
import { inlineEmbeds, type EmbedFetchers } from './site-embeds';
import { linkFirst, PLACEHOLDER, plainOf } from './site-rich-text';
import { fontKeyFor, lookFound, readImportedLook, readsOn, themeWithLook, type ImportedLook } from './site-import-theme';
import { ADAPTERS } from './site-builders';
import * as cheerio from 'cheerio';
import { harvestBrandSignals } from './brand-extract';
import { findBlogIndex, readImportedBlog, type BlogIndexSignal, type ImportedBlog } from './site-import-blog';

/**
 * Pages read at most (home + menu pages), before the site's own page cap. Was 8 until 2026-11-08:
 * Restorative Futures has 13 menu pages and 5 were left out. No plan limits pages any more
 * (site-published.ts), so this only bounds one background run and the size of the model's plan.
 */
export const IMPORT_MAX_PAGES = 20;
/** Below this many words on the home page — and IMPORT_THIN_SITE_WORDS across the site — there is nothing honest to import. */
export const IMPORT_THIN_WORDS = 40;
export const IMPORT_THIN_SITE_WORDS = 80;
/** Pictures copied into the library at most, per import. */
export const IMPORT_MAX_PICTURES = 24;

export type PictureChoice = 'copy' | 'skip';

/** The address the owner typed, as a URL we may read — or null with nothing to say but "check it". */
export function cleanImportUrl(raw: unknown): string | null {
    let s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s.length > 500 || /\s/.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try {
        const u = new URL(s);
        if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !u.hostname.includes('.')) return null;
        u.hash = '';
        return u.toString();
    } catch { return null; }
}

// ── Which pages ─────────────────────────────────────────────────────────────────────────────────

/** Pages that are never the business's content: shop machinery, accounts, legal small print, posts. */
/** Shop machinery and legal pages are never pages to copy (Magento's own: catalogsearch, sales/guest, search/term, product_compare). */
export const SKIP_PATH = /\/(cart|basket|checkout|account|my-account|customer|wishlist|compare|catalogsearch|gift-certificates?|login|log-in|signin|sign-in|register|members?|search|privacy|privacy-policy|privacy-policy-cookie-restriction-mode|cookies?|cookie-policy|terms|terms-and-conditions|legal|accessibility|sitemap|feed|tag|category|author|wp-admin|wp-login)(\/|$)|\/sales\/guest\/|\/search\/term\/|\/catalog\/product_compare\/|\/(blog|news|post|posts|product|products|shop|store|events?)\/.+/i;
export const FILE_PATH = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$/i;
/** Shop machinery written as scripts (BigCommerce's cart.php, login.php…): never a page of theirs. */
const SHOP_SCRIPT = /\/(cart|login|account|checkout|wishlist|compare|search|giftcertificates?)\.php$/i;
/** A shop's catalogue listing (a category or collection of products), read after their own pages. */
export const CATALOGUE_PATH = /\/(collections?|product-category|product-categories|categories|category|shop|store|catalog|catalogue|departments?)(\/|$)/i;

/**
 * The menu pages to read, at most `n`: their own pages first, then catalogue listings with what is
 * left — in menu order, so the new site's menu still follows theirs. (A shop's menu is mostly
 * categories; the about, contact and story pages matter more to a website.)
 */
export function choosePages(menu: SiteLink[], n: number): SiteLink[] {
    // The platform adapter's mark (catalogueLink, e.g. Magento's category menu), else the address.
    const isCatalogue = (l: SiteLink) => { if (l.catalogue) return true; try { return CATALOGUE_PATH.test(new URL(l.href).pathname); } catch { return false; } };
    const chosen = new Set<SiteLink>();
    for (const l of menu) if (chosen.size < n && !isCatalogue(l)) chosen.add(l);
    for (const l of menu) if (chosen.size < n && isCatalogue(l)) chosen.add(l);
    return menu.filter((l) => chosen.has(l));
}

const CONTACT_PAGE = /contact|get-in-touch|get in touch|enquir|find-us|find us/;

const samePath = (a: string, b: string) => {
    try {
        const x = new URL(a), y = new URL(b);
        return x.host.replace(/^www\./, '') === y.host.replace(/^www\./, '') && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
    } catch { return a === b; }
};

/** The menu pages worth reading after the home page, in menu order, at most `limit`. */
export function pickImportPages(home: ImportPage, limit: number): SiteLink[] {
    const out: SiteLink[] = [];
    for (const l of home.navLinks) {
        if (out.length >= limit) break;
        let u: URL;
        try { u = new URL(l.href); } catch { continue; }
        if (samePath(l.href, home.url) || u.pathname === '/' || FILE_PATH.test(u.pathname) || SKIP_PATH.test(u.pathname) || SHOP_SCRIPT.test(u.pathname)) continue;
        if (out.some((o) => samePath(o.href, l.href))) continue;
        out.push(l);
    }
    return out;
}


// ── Numbered blocks ─────────────────────────────────────────────────────────────────────────────

export interface ReadPage { url: string; menuLabel: string | null; page: ImportPage; }
export interface NumberedBlock { n: number; page: number; block: ImportBlock; }

/** Every block of every page, numbered from 1 — except words stating a price, which go to `prices`. */
export function numberBlocks(pages: ReadPage[]): { blocks: NumberedBlock[]; prices: string[] } {
    const blocks: NumberedBlock[] = [];
    const prices: string[] = [];
    pages.forEach((p, page) => {
        for (const block of p.page.blocks) {
            if (block.kind !== 'image' && block.kind !== 'button' && statesPrice(block.text)) {
                if (!prices.includes(block.text)) prices.push(block.text);
                continue;
            }
            blocks.push({ n: blocks.length + 1, page, block });
        }
    });
    return { blocks, prices };
}

const describe = (b: ImportBlock): string => {
    switch (b.kind) {
        case 'heading': return `heading (h${b.level}): ${b.text}`;
        case 'image': return `picture: ${b.alt}`;
        case 'button': return `button: ${b.text}`;
        case 'item': return `list item: ${b.text}`;
        case 'quote': return `quote: ${b.text}`;
        default: return `text: ${b.text}`;
    }
};

export function buildImportPrompt(pages: ReadPage[], blocks: NumberedBlock[], opts: { siteName: string; pictures: PictureChoice; allowed: (t: SectionType) => boolean; only?: number[] }): { system: string; user: string } {
    const shown = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s);
    // `only`: the pages (0-based) this request covers, keeping their numbers and block numbers — a large
    // site is planned in batches (planInBatches).
    const pageText = pages.map((p, i) => ({ p, i })).filter(({ i }) => !opts.only || opts.only.includes(i)).map(({ p, i }) => {
        const own = blocks.filter((b) => b.page === i);
        const label = p.menuLabel ? ` menu="${p.menuLabel}"` : '';
        return `<page number="${i + 1}" address="${new URL(p.url).pathname}"${label}>\n${own.map((b) => `[${b.n}] ${shown(describe(b.block))}`).join('\n') || '(nothing readable)'}\n</page>`;
    }).join('\n\n');
    const kinds = [
        '- {"type":"hero","headline":n,"subheadline":n|null,"button":n|null,"button2":n|null,"image":n|null}   (the opening of a page: its main heading, the line under it, and up to two buttons)',
        '- {"type":"text","heading":n|null,"body":[n,…],"image":n|null}   (paragraphs, or a short list, under one heading)',
        '- {"type":"features","heading":n|null,"items":[{"title":n,"body":[n],"button":n|null,"image":n|null}]}   (a set of short titled points or cards — services, courses, reasons to choose them; "button" is the card\'s own link, e.g. "Read more"; "image" its own picture)',
        '- {"type":"steps","heading":n|null,"items":[{"title":n,"body":[n],"button":n|null}]}   (a numbered process: how it works)',
        opts.allowed('faq') ? '- {"type":"faq","heading":n|null,"items":[{"q":n,"a":[n]}]}   (questions and their answers)' : '',
        '- {"type":"testimonials","heading":n|null,"items":[{"quote":n,"name":n,"detail":n|null}]}   (ONLY quotes from customers that are on their site, with the customer\'s name block)',
        opts.pictures === 'copy' && opts.allowed('gallery') ? '- {"type":"gallery","heading":n|null,"images":[n,…]}   (a set of their pictures)' : '',
        '- {"type":"cta","heading":n,"body":[n],"button":n}   (a call to action: a heading, a short line or none, and ONE button — e.g. "Ready to book?" with "Book now")',
        '- {"type":"contact","heading":n|null,"intro":n|null}   (an enquiry form — where their old site asked people to get in touch)',
    ].filter(Boolean).join('\n');
    const system = [
        'You turn a small business\'s EXISTING website into the sections of their new one.',
        'You never write, change, shorten or add any words. You only decide which numbered block goes where, in which kind of section.',
        'Reply with the JSON object only.',
    ].join('\n');
    const user = `<business>${opts.siteName}</business>

${pageText}

<section_kinds>
${kinds}
</section_kinds>

<rules>
- One entry in "pages" for every page above, by its number, keeping their order of content.
- Page 1 is the home page: start it with a hero. Other pages may start with a hero too.
- Use each block at most once. Use every block that is the business's own content.
- Put in "skip" ONLY blocks that are not content: leftover menu links, cookie or legal notices, "follow us", social share labels, copyright lines, a form's field labels, the same sentence repeated.
- A heading block names the section under it. A picture goes beside the words it belongs with (a hero's or a text section's "image").${opts.pictures === 'copy' ? '' : ' Pictures will not be copied: never use picture blocks.'}
- "button" and "button2" only for a button block. Their links matter: give every button block that is the business's own a place — a hero's buttons, a card's "button" (its "Read more" or "Course details"), or a "cta" section with the heading and line just before it.
- If unsure, use a "text" section in their order — never drop a block.
</rules>

<output>
{"pages":[{"page":1,"sections":[{"type":"hero","headline":1,"subheadline":2,"button":3,"image":4},{"type":"text","heading":5,"body":[6,7],"image":null}]}],"skip":[8]}
</output>`;
    return { system, user };
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

export type PlanSection =
    | { type: 'hero'; headline: number | null; subheadline: number | null; button: number | null; button2?: number | null; image: number | null }
    | { type: 'text'; heading: number | null; body: number[]; image: number | null }
    | { type: 'features' | 'steps'; heading: number | null; items: Array<{ title: number; body: number[]; button?: number | null; image?: number | null }> }
    | { type: 'cta'; heading: number | null; body: number[]; button: number | null }
    | { type: 'faq'; heading: number | null; items: Array<{ q: number; a: number[] }> }
    | { type: 'testimonials'; heading: number | null; items: Array<{ quote: number; name: number | null; detail: number | null }> }
    | { type: 'gallery'; heading: number | null; images: number[] }
    | { type: 'contact'; heading: number | null; intro: number | null };

export interface ImportPlan { pages: Array<{ page: number; sections: PlanSection[] }>; skip: number[]; }

/** The model's reply, read defensively: unknown shapes are dropped, not trusted. */
export function readImportPlan(raw: unknown): ImportPlan | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { pages?: unknown; skip?: unknown };
    if (!Array.isArray(r.pages)) return null;
    const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 && v !== null && v !== '' ? Number(v) : null);
    const nums = (v: unknown) => (Array.isArray(v) ? v.map(num).filter((x): x is number => x !== null) : []);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>> : []);
    const pages: ImportPlan['pages'] = [];
    for (const pg of list(r.pages)) {
        const page = num(pg.page);
        if (!page) continue;
        const sections: PlanSection[] = [];
        for (const s of list(pg.sections)) {
            const heading = num(s.heading);
            switch (s.type) {
                case 'hero': sections.push({ type: 'hero', headline: num(s.headline), subheadline: num(s.subheadline), button: num(s.button), button2: num(s.button2), image: num(s.image) }); break;
                case 'text': sections.push({ type: 'text', heading, body: nums(s.body), image: num(s.image) }); break;
                case 'features': case 'steps':
                    sections.push({ type: s.type, heading, items: list(s.items).map((x) => ({ title: num(x.title) ?? 0, body: nums(x.body), button: num(x.button), image: num(x.image) })).filter((x) => x.title > 0) }); break;
                case 'cta': sections.push({ type: 'cta', heading, body: nums(s.body), button: num(s.button) }); break;
                case 'faq': sections.push({ type: 'faq', heading, items: list(s.items).map((x) => ({ q: num(x.q) ?? 0, a: nums(x.a) })).filter((x) => x.q > 0 && x.a.length) }); break;
                case 'testimonials': sections.push({ type: 'testimonials', heading, items: list(s.items).map((x) => ({ quote: num(x.quote) ?? 0, name: num(x.name), detail: num(x.detail) })).filter((x) => x.quote > 0) }); break;
                case 'gallery': sections.push({ type: 'gallery', heading, images: nums(s.images) }); break;
                case 'contact': sections.push({ type: 'contact', heading, intro: num(s.intro) }); break;
                default: break;
            }
        }
        pages.push({ page, sections });
    }
    return { pages, skip: nums(r.skip) };
}

/** Block numbers of the pictures the plan puts on the site — the only ones worth copying. */
export function picturesInPlan(plan: ImportPlan | null, blocks: NumberedBlock[]): number[] {
    if (!plan) return [];
    const isImage = (n: number | null) => n !== null && blocks[n - 1]?.block.kind === 'image';
    const out: number[] = [];
    const add = (n: number | null) => { if (n !== null && isImage(n) && !out.includes(n) && out.length < IMPORT_MAX_PICTURES) out.push(n); };
    for (const pg of plan.pages) for (const s of pg.sections) {
        if (s.type === 'hero' || s.type === 'text') add(s.image);
        if (s.type === 'features' || s.type === 'steps') s.items.forEach((it) => add(it.image ?? null));
        if (s.type === 'gallery') s.images.forEach(add);
    }
    return out;
}

// ── Building the draft from the owner's blocks ─────────────────────────────────────────────────

export interface ImportReport {
    sourceUrl: string;
    builder: ImportPage['builder'];
    /** The platform adapter that read their home page (site-builders/ key). */
    platform?: string | null;
    /** Every page we tried, and how many of its words we read. */
    pages: Array<{ url: string; title: string; words: number; read: boolean; note: string | null }>;
    wordsRead: number;
    /** Menu pages beyond the plan's page cap — not imported. */
    notImported: Array<{ url: string; title: string }>;
    /** `undescribed`: copied pictures their old site gave no description, so we used the nearest heading — to check. */
    pictures: { choice: PictureChoice; found: number; copied: number; failed: number; undescribed: number };
    /** Words stating a price: left off the site, to be added in Business Information. */
    prices: string[];
    /**
     * Products their shop showed (name, price as stated, page, picture), one per name across pages — offered
     * to Business Information ▸ Products & Services (sites.ts import_products), never put on the site.
     * `imageAssetId`: their picture, when the import already copied it into the library.
     */
    products?: Array<ImportedProduct & { imageAssetId?: number | null }>;
    /** Blocks the plan called clutter — shown so the owner can see nothing important went. */
    leftOut: string[];
    /** Text that would not fit on its page (over the section limit). */
    notCarried: string[];
    contact: { email: string | null; phone: string | null; address: string | null };
    hadForm: boolean;
    /** Their old form's questions (field labels) — our contact form asks name, email, (phone) and message. */
    formFields?: string[];
    placeholders: number;
    /** Their colours, lettering and corners as we read them (null = none read: their current design is kept). */
    look?: ImportedLook | null;
    /**
     * Posts from a blog on their old site (not the Blog Assistant's widget) — held here, bodies and
     * all, until "Use this as my draft" makes them Blog Assistant drafts (site-import-store.ts
     * acceptImport). The Website tab and the chat see only blogSummary() of it.
     */
    blog?: ImportedBlog | null;
}

export interface AssembleInput {
    current: SiteDefinition;
    pages: ReadPage[];
    blocks: NumberedBlock[];
    plan: ImportPlan | null;
    /** Picture block number → the library picture it was copied into. */
    assets: Map<number, number>;
    maxPages: number;
    /** Their old blog page(s) holding the Blog Assistant widget: links to them go to the new site's /blog. */
    blogUrls?: string[];
}

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.slug).replace(/-+$/, '');

/** A page's name on the new site: their menu's word for it, else its main heading, else its <title>. */
function pageTitle(p: ReadPage, i: number): string {
    if (i === 0) return p.menuLabel && p.menuLabel.length <= 30 ? p.menuLabel : 'Home';
    const h = p.page.blocks.find((b) => b.kind === 'heading');
    const fromTitle = p.page.title ? p.page.title.split(/\s[|–—·-]\s/)[0].trim() : '';
    for (const c of [p.menuLabel, h && h.kind === 'heading' ? h.text : null, fromTitle]) if (c && c.length <= LIMITS.pageTitle) return c;
    return `Page ${i + 1}`;
}

export function assembleImport(input: AssembleInput): { definition: SiteDefinition; leftOut: string[]; notCarried: string[]; warnings: string[] } {
    const { current, pages, blocks, assets } = input;
    const cap = Math.max(1, Math.min(input.maxPages, pages.length));
    const used = new Set<number>();
    const order: number[] = [];   // block numbers in the order they were placed
    const use = (n: number) => { if (!used.has(n)) { used.add(n); order.push(n); } };
    const skip = new Set(input.plan?.skip ?? []);
    const notCarried: string[] = [];

    // Addresses: one per page, unique, never one we serve ourselves.
    const slugs: string[] = [];
    pages.slice(0, cap).forEach((p, i) => {
        if (i === 0) { slugs.push(''); return; }
        const last = new URL(p.url).pathname.split('/').filter(Boolean).pop() ?? '';
        let s = slugify(decodeURIComponent(last)) || slugify(pageTitle(p, i)) || `page-${i + 1}`;
        if (RESERVED_SLUGS.has(s)) s = `${s}-page`;
        let k = 2;
        const base = s;
        while (slugs.includes(s)) s = `${base}-${k++}`;
        slugs.push(s);
    });
    // Their links between their own pages follow onto the new ones; tel:, mailto: and other sites stay.
    const mapHref = (href: string | null): string | null => {
        if (!href) return null;
        if (/^(mailto|tel):/i.test(href)) return cleanHref(href.replace(/\s+/g, ''));
        const i = pages.slice(0, cap).findIndex((p) => samePath(p.url, href));
        if (i >= 0) return i === 0 ? '/' : `/${slugs[i]}`;
        if (input.blogUrls?.some((u) => samePath(u, href))) return BLOG_PATH;
        try { if (new URL(href).host.replace(/^www\./, '') === new URL(pages[0].url).host.replace(/^www\./, '')) return null; } catch { return null; }
        return cleanHref(href);
    };

    /** A block's words with its inline links put back, each pointing at the new site (or dropped). */
    const withLinks = (block: ImportBlock): string => {
        if (block.kind === 'image') return '';
        let t = block.text;
        for (const l of ('links' in block && block.links) || []) {
            const to = mapHref(l.href);
            if (to) t = linkFirst(t, l.text, to);
        }
        return t;
    };
    const onPage = (n: number | null | undefined, page: number): NumberedBlock | null => {
        if (!n || n < 1 || n > blocks.length || used.has(n)) return null;
        const b = blocks[n - 1];
        return b.page === page ? b : null;
    };
    /** A button block on this page that leads somewhere on the new site (not yet marked used). */
    const buttonAt = (n: number | null | undefined, page: number): { n: number; link: { label: string; href: string } } | null => {
        const b = onPage(n, page);
        if (!b || b.block.kind !== 'button' || b.block.text.length > LIMITS.ctaLabel) return null;
        const href = mapHref(b.block.href);
        return href ? { n: b.n, link: { label: b.block.text, href } } : null;
    };
    const text = (n: number | null | undefined, page: number): string | null => {
        const b = onPage(n, page);
        if (!b || b.block.kind === 'image' || b.block.kind === 'button') return null;
        use(b.n);
        return b.block.text;
    };
    const texts = (ns: number[] | undefined, page: number): string[] => (ns ?? []).map((n) => text(n, page)).filter((x): x is string => !!x);
    const image = (n: number | null | undefined, page: number): { assetId: number; alt: string } | null => {
        const b = onPage(n, page);
        if (!b || b.block.kind !== 'image') return null;
        use(b.n);
        const assetId = assets.get(b.n);
        return assetId ? { assetId, alt: b.block.alt.slice(0, LIMITS.alt) } : null;
    };
    /**
     * List items run together as lines of one paragraph; everything else is its own paragraph. Callers
     * pass no buttons, except a leftover one that is really words (an email address) — kept as words.
     */
    const paragraphsOf = (ns: number[]): string[] => {
        const out: string[] = [];
        let prevItem = false;
        for (const n of ns) {
            const b = blocks[n - 1];
            if (!b || b.block.kind === 'image') continue;
            const t = withLinks(b.block);
            if (b.block.kind === 'item' && prevItem && out.length) out[out.length - 1] += `\n${t}`;
            else out.push(t);
            prevItem = b.block.kind === 'item';
        }
        return out;
    };
    const takeParagraphs = (ns: number[] | undefined, page: number): string[] => {
        const ok = (ns ?? []).filter((n) => !!onPage(n, page) && blocks[n - 1].block.kind !== 'image' && blocks[n - 1].block.kind !== 'button');
        const out = paragraphsOf(ok);
        ok.forEach((n) => use(n));
        return out;
    };
    const fitsHeading = (s: string | null) => !!s && s.length <= LIMITS.headline;
    const allowed = (t: SectionType) => sectionAllowed(current.settings, t);

    type Raw = { type: string; props: Record<string, unknown> };
    /** Text sections, split if long; the heading on the first. A heading too long to be one leads the words. */
    const textSections = (heading: string | null, body: string[], img: { assetId: number; alt: string } | null): Raw[] => {
        const titled = fitsHeading(heading) ? heading : null;
        const parts = chunkBodies(titled || !heading ? body : [heading!, ...body]);
        if (!parts.length && titled) parts.push(titled);
        return parts.map((part, k) => ({ type: 'text', props: { heading: k === 0 && part !== titled ? titled : null, body: part, image: k === 0 ? img : null, imageSide: 'right' } }));
    };

    // Their drop-downs (readImportPage SiteLink.group): a page that sat in "About Us ▾" goes under the
    // page of that name in the new menu, so 13 pages still fit a 7-entry menu (Restorative Futures,
    // 2026-11-08: Contact and Booking had fallen out of it). Ids are fixed here so menuParent can name them.
    const homeNav = pages[0]?.page.navLinks ?? [];
    const linkOf = (k: number) => homeNav.find((l) => samePath(l.href, pages[k].url));
    const parentOf = pages.slice(0, cap).map((_, i) => {
        const group = i > 0 ? linkOf(i)?.group : undefined;
        if (!group) return null;
        const own = (k: number) => k > 0 && k !== i && !linkOf(k)?.group;
        let j = pages.slice(0, cap).findIndex((_, k) => own(k) && linkOf(k)?.text.toLowerCase() === group.toLowerCase());
        if (j < 0) j = pages.slice(0, cap).findIndex((_, k) => own(k) && slugs[k] === slugify(group));
        return j >= 0 ? `p${j + 1}` : null;
    });

    // The new contact form asks for a phone number when their old form did (or when we saw no form).
    const oldForm = importedFormFields(pages);
    const askPhone = !oldForm.length || oldForm.some((f) => /phone|tel\b|mobile|number/i.test(f));
    const outPages = pages.slice(0, cap).map((p, i) => {
        // Each group of sections remembers the first of their blocks it holds, so blocks the plan
        // forgot go back where they were read — not all at the end of the page.
        const groups: Array<{ at: number; planned: boolean; secs: Raw[] }> = [];
        let sections: Raw[] = [];
        const planned = input.plan?.pages.find((x) => x.page === i + 1)?.sections ?? [];
        const closeGroup = (mark: number, wasPlanned: boolean) => {
            const taken = order.slice(mark);
            const prev = groups.length ? groups[groups.length - 1].at : 0;
            if (sections.length) groups.push({ at: taken.length ? Math.min(...taken) : prev, planned: wasPlanned, secs: sections });
            sections = [];
        };
        for (const s of planned) {
            const mark = order.length;
            planOne(s);
            closeGroup(mark, true);
        }
        function planOne(s: PlanSection): void {
            if (s.type === 'hero') {
                const head = blocks[(s.headline ?? 0) - 1];
                const headline = head && head.page === i && fitsHeading(head.block.kind === 'image' || head.block.kind === 'button' ? null : head.block.text) ? text(s.headline, i) : null;
                const subB = blocks[(s.subheadline ?? 0) - 1];
                const sub = subB && subB.page === i && subB.block.kind !== 'image' && subB.block.kind !== 'button' && subB.block.text.length <= LIMITS.subheadline ? text(s.subheadline, i) : null;
                // Buttons are taken only when the hero is made — a hero that falls back to text leaves them for the report.
                const btn1 = headline ? buttonAt(s.button, i) : null;
                if (btn1) use(btn1.n);
                const btn2 = headline ? buttonAt(s.button2, i) : null;
                if (btn2) use(btn2.n);
                const [primary, secondary] = [btn1, btn2].filter((x): x is NonNullable<typeof x> => !!x);
                const img = image(s.image, i);
                if (headline) sections.push({ type: 'hero', props: { layout: img ? 'split' : 'centered', headline, subheadline: sub, primaryCta: primary?.link ?? null, secondaryCta: secondary?.link ?? null, image: img } });
                else sections.push(...textSections(null, sub ? [sub] : [], img));
                return;
            }
            if (s.type === 'text') {
                const img = image(s.image, i);
                const heading = text(s.heading, i);
                sections.push(...textSections(heading, takeParagraphs(s.body, i), img));
                return;
            }
            if (s.type === 'features' || s.type === 'steps') {
                const heading = text(s.heading, i);
                const taken = new Set<number>();
                const items = s.items.map((it) => {
                    const title = text(it.title, i);
                    const body = takeParagraphs(it.body, i).join('\n\n');
                    const btn = title ? buttonAt(it.button, i) : null;
                    // Its own picture, when the plan gave one and it was copied.
                    const img = title ? image(it.image, i) : null;
                    const base = img ? { title, body, image: img } : { title, body };
                    if (!btn || taken.has(btn.n)) return base;
                    taken.add(btn.n);
                    return { ...base, link: btn.link, btnN: btn.n };
                }).filter((x) => x.title) as Array<{ title: string; body: string; image?: { assetId: number; alt: string }; link?: { label: string; href: string }; btnN?: number }>;
                const max = s.type === 'steps' ? LIMITS.steps : LIMITS.features;
                const fits = items.length >= (s.type === 'steps' ? LIMITS.stepsMin : 1) && items.length <= max && (!heading || fitsHeading(heading))
                    && items.every((x) => x.title.length <= LIMITS.itemTitle && x.body.length <= LIMITS.itemBody);
                // Each card keeps its own link ("Read more" → the page about it); a fallback to text leaves the links for the report.
                if (fits) {
                    items.forEach((x) => { if (x.btnN) use(x.btnN); });
                    sections.push({ type: s.type, props: { heading, items: items.map(({ btnN: _n, ...x }) => x) } });
                }
                else sections.push(...textSections(heading, items.flatMap((x) => [x.title, x.body].filter(Boolean)), null));
                return;
            }
            if (s.type === 'faq') {
                const heading = text(s.heading, i);
                const items = s.items.map((it) => ({ q: text(it.q, i), a: takeParagraphs(it.a, i).join('\n\n') })).filter((x) => x.q && x.a) as Array<{ q: string; a: string }>;
                const fits = allowed('faq') && items.length && items.length <= LIMITS.faqItems && (!heading || fitsHeading(heading)) && items.every((x) => x.q.length <= LIMITS.q && x.a.length <= LIMITS.a);
                if (fits) sections.push({ type: 'faq', props: { heading, items } });
                else sections.push(...textSections(heading, items.flatMap((x) => [x.q, x.a]), null));
                return;
            }
            if (s.type === 'testimonials') {
                const heading = text(s.heading, i);
                const items = s.items.map((it) => {
                    const quote = text(it.quote, i);
                    const nameB = blocks[(it.name ?? 0) - 1];
                    const name = nameB && nameB.page === i && nameB.block.kind !== 'image' && nameB.block.kind !== 'button' && nameB.block.text.length <= LIMITS.personName ? text(it.name, i) : null;
                    const detB = blocks[(it.detail ?? 0) - 1];
                    const detail = detB && detB.page === i && detB.block.kind !== 'image' && detB.block.kind !== 'button' && detB.block.text.length <= LIMITS.personDetail ? text(it.detail, i) : null;
                    // A quote with no name on the old site keeps a placeholder: the owner adds who said it.
                    return quote ? { quote, name: name ?? '[Customer name]', detail } : null;
                }).filter((x): x is { quote: string; name: string; detail: string | null } => !!x);
                const fits = items.length && items.length <= LIMITS.testimonials && (!heading || fitsHeading(heading)) && items.every((x) => x.quote.length <= LIMITS.quote);
                if (fits) sections.push({ type: 'testimonials', props: { heading, items } });
                else sections.push(...textSections(heading, items.flatMap((x) => [x.quote, x.name.startsWith('[') ? '' : x.name].filter(Boolean)), null));
                return;
            }
            if (s.type === 'gallery') {
                const heading = text(s.heading, i);
                const imgs = s.images.map((n) => image(n, i)).filter((x): x is { assetId: number; alt: string } => !!x).slice(0, LIMITS.galleryImages);
                if (allowed('gallery') && imgs.length) sections.push({ type: 'gallery', props: { heading: fitsHeading(heading) ? heading : null, layout: 'square', images: imgs.map((x) => ({ ...x, caption: null })) } });
                else if (heading) sections.push(...textSections(heading, [], null));
                return;
            }
            if (s.type === 'cta') {
                const btn = buttonAt(s.button, i);
                const headB = onPage(s.heading, i);
                const head = headB && headB.block.kind !== 'image' && headB.block.kind !== 'button' && fitsHeading(headB.block.text) ? headB : null;
                const bodyNs = (s.body ?? []).filter((n) => !!onPage(n, i) && blocks[n - 1].block.kind !== 'image' && blocks[n - 1].block.kind !== 'button');
                const body = paragraphsOf(bodyNs).join('\n\n');
                if (btn && head && allowed('cta') && body.length <= LIMITS.subheadline) {
                    use(head.n); bodyNs.forEach((n) => use(n)); use(btn.n);
                    sections.push({ type: 'cta', props: { heading: (head.block as { text: string }).text, body: body || null, button: btn.link } });
                } else {
                    // No button that leads anywhere (or words too long for the band): the words stay, as text.
                    sections.push(...textSections(text(s.heading, i), takeParagraphs(s.body, i), null));
                }
                return;
            }
            if (s.type === 'contact') {
                const heading = text(s.heading, i);
                const introB = blocks[(s.intro ?? 0) - 1];
                const intro = introB && introB.page === i && introB.block.kind !== 'image' && introB.block.kind !== 'button' && introB.block.text.length <= LIMITS.intro ? text(s.intro, i) : null;
                sections.push({ type: 'contact', props: { heading: fitsHeading(heading) ? heading : null, intro, askPhone, offerUpdates: false } });
                if (heading && !fitsHeading(heading)) sections.push(...textSections(null, [heading], null));
            }
        }

        // Nothing silently lost: every block the plan neither used nor called clutter, in their order,
        // grouped under its own headings.
        // A leftover "button" that is really words (an email address, a sentence) stays as words; a
        // real button the plan found no place for is listed, never dropped quietly.
        const wordy = (b: NumberedBlock) => b.block.kind === 'button' && (/@|\d{5,}/.test(b.block.text) || b.block.text.split(/\s+/).length >= 6);
        for (const b of blocks) {
            if (b.page !== i || used.has(b.n) || skip.has(b.n) || b.block.kind !== 'button' || wordy(b) || !b.block.href) continue;
            let to = b.block.href;
            try { const u = new URL(b.block.href); to = u.host.replace(/^www\./, '') === new URL(pages[0].url).host.replace(/^www\./, '') ? u.pathname : b.block.href; } catch { /* keep as read */ }
            notCarried.push(`Button "${b.block.text}" (linked to ${to}) on ${pageTitle(p, i)}`.slice(0, 200));
        }
        const left = blocks.filter((b) => b.page === i && !used.has(b.n) && !skip.has(b.n) && b.block.kind !== 'image' && (b.block.kind !== 'button' || wordy(b)));
        let heading: string | null = null;
        let run: number[] = [];
        let groupAt = 0;
        const flush = () => {
            if (heading || run.length) groups.push({ at: groupAt, planned: false, secs: textSections(heading, paragraphsOf(run), null) });
            heading = null; run = [];
        };
        // A short line with no closing punctuation, followed by more words, reads as a title even when
        // the builder drew it as a paragraph (Squarespace and Wix often do).
        const titleLike = (k: number) => {
            const b = left[k].block;
            return b.kind === 'text' && b.text.length <= 80 && !/[.,;:!?]$/.test(b.text) && !!left[k + 1] && left[k + 1].block.kind !== 'heading';
        };
        left.forEach((b, k) => {
            use(b.n);
            if (b.block.kind === 'heading' || titleLike(k)) { flush(); groupAt = b.n; heading = (b.block as { text: string }).text; } else { if (!heading && !run.length) groupAt = b.n; run.push(b.n); }
        });
        flush();
        // Planned groups keep the plan's order; each leftover group goes before the first planned group
        // that starts later on the page (never in front of the home page's opening hero).
        const merged: typeof groups = groups.filter((g) => g.planned);
        for (const g of groups.filter((x) => !x.planned)) {
            let at = merged.findIndex((m) => m.planned && m.at > g.at);
            if (at < 0) at = merged.length;
            if (at === 0 && i === 0 && merged[0]?.secs[0]?.type === 'hero') at = 1;
            merged.splice(at, 0, g);
        }
        sections = merged.flatMap((g) => g.secs);

        // Every page opens with something; the home page with a hero (their name, at least).
        if (i === 0 && sections[0]?.type !== 'hero') {
            const first = sections.findIndex((x) => x.type === 'text' && typeof x.props.heading === 'string');
            const headline = first >= 0 ? String(sections[first].props.heading) : current.settings.siteName;
            if (first >= 0) sections[first] = { ...sections[first], props: { ...sections[first].props, heading: null } };
            sections.unshift({ type: 'hero', props: { layout: 'centered', headline, subheadline: null, primaryCta: null, image: null } });
        }
        if (!sections.length) sections.push({ type: 'text', props: { heading: pageTitle(p, i), body: '[What this page should say]' } });

        // A page holds up to LIMITS.sectionsPerPage sections. A long page (Restorative Futures' "Why
        // this training matters": 29) folds neighbouring text sections together — the second heading
        // becomes a "### " subheading inside the first — shortest pairs first, while the words fit.
        while (sections.length > LIMITS.sectionsPerPage) {
            let best = -1;
            let bestLen = Infinity;
            for (let k = 0; k + 1 < sections.length; k++) {
                const [a, b] = [sections[k], sections[k + 1]];
                if (a.type !== 'text' || b.type !== 'text' || b.props.image) continue;
                const len = String(a.props.body ?? '').length + String(b.props.body ?? '').length + String(b.props.heading ?? '').length + 8;
                if (len <= LIMITS.textBody && len < bestLen) { best = k; bestLen = len; }
            }
            if (best < 0) break;
            const [a, b] = [sections[best], sections[best + 1]];
            const body = [a.props.body, b.props.heading ? `### ${b.props.heading}` : null, b.props.body].filter((x) => typeof x === 'string' && x).join('\n\n');
            sections.splice(best, 2, { type: 'text', props: { ...a.props, body } });
        }
        // What still doesn't fit is listed, not dropped quietly.
        if (sections.length > LIMITS.sectionsPerPage) {
            for (const extra of sections.splice(LIMITS.sectionsPerPage)) {
                const words = [extra.props.heading, extra.props.body].filter((x) => typeof x === 'string' && x).join(' — ');
                if (words) notCarried.push(String(words).slice(0, 200));
            }
        }
        const fit = (s: string | null, n: number) => (s && s.length <= n ? s : null);
        return {
            id: `p${i + 1}`, menuParent: parentOf[i],
            title: pageTitle(p, i), slug: slugs[i],
            seo: { title: fit(p.page.title, LIMITS.seoTitle), description: fit(p.page.description, LIMITS.seoDescription) },
            sections,
        };
    });

    // An enquiry form, where their old site had a contact page — or a page of its own, when there is room.
    if (!outPages.some((p) => p.sections.some((s) => s.type === 'contact'))) {
        const contactPage = outPages.find((p) => CONTACT_PAGE.test(p.slug));
        const form = { type: 'contact', props: { heading: null, intro: null, askPhone, offerUpdates: false } };
        if (contactPage && contactPage.sections.length < LIMITS.sectionsPerPage) contactPage.sections.push(form);
        else if (outPages.length < input.maxPages) outPages.push({ id: '', menuParent: null, title: 'Contact', slug: slugs.includes('contact') ? 'contact-us' : 'contact', seo: { title: null, description: null }, sections: [form] });
        else if (outPages[0].sections.length < LIMITS.sectionsPerPage) outPages[0].sections.push(form);
    }

    const home = pages[0].page;
    const contact = importedContact(pages);
    const { definition, warnings } = normaliseSiteDefinition({
        theme: current.theme,
        settings: {
            ...current.settings,
            description: home.description && home.description.length <= LIMITS.description ? home.description : current.settings.description,
            locality: current.settings.locality ?? pages.map((p) => p.page.contact.locality).find(Boolean) ?? null,
            // The public email and phone on their own site — the server read them, no model typed them.
            email: contact.email ?? current.settings.email,
            phone: contact.phone ?? current.settings.phone,
            // Their profiles on social sites (footer links), when the new site has none yet.
            socialLinks: current.settings.socialLinks?.length ? current.settings.socialLinks : importedSocialLinks(pages),
        },
        nav: [], footer: current.footer, structure: 'pages', pages: outPages,
        // Their old addresses that changed (/services/coaching → /coaching) keep working on the new site.
        redirects: pages.slice(0, cap).flatMap((p, i) => {
            const from = redirectKey(new URL(p.url).pathname);
            const to = i === 0 ? '/' : `/${slugs[i]}`;
            return from !== to ? [{ from, to }] : [];
        }),
    }, { maxPages: input.maxPages });

    const leftOut = [...skip].map((n) => blocks[n - 1]).filter((b) => b && b.block.kind !== 'image' && b.block.kind !== 'button').map((b) => (b.block as { text: string }).text.slice(0, 200));
    return { definition, leftOut, notCarried, warnings };
}

/** Their social profile links across the pages read, home first, each once. */
/** Every page's products, one per name, with the library picture when the import copied that one. */
export function importedProducts(pages: ReadPage[], blocks: NumberedBlock[], assets: Map<number, number>): NonNullable<ImportReport['products']> {
    const copied = new Map<string, number>();
    for (const [n, id] of assets) { const b = blocks[n - 1]?.block; if (b?.kind === 'image') copied.set(b.src, id); }
    const out: NonNullable<ImportReport['products']> = [];
    const seen = new Set<string>();
    for (const p of pages) for (const x of p.page.products ?? []) {
        const k = x.name.toLowerCase();
        if (seen.has(k) || out.length >= IMPORT_LIMITS.products) continue;
        seen.add(k);
        out.push({ ...x, imageAssetId: x.image ? copied.get(x.image) ?? null : null });
    }
    return out;
}

/**
 * One imported product as a Business Information row's fields: its price read into the structured form
 * when it is a plain amount ("£28.00", "From €12"), else kept in their own words; nothing invented.
 */
export function productFieldsFromImport(p: ImportedProduct): { name: string; url: string | null; priceType: PriceType | null; priceAmount: number | null; priceCurrency: PriceCurrency; price: string | null } {
    const name = p.name.trim().slice(0, 120);
    const url = p.href && /^https?:\/\//.test(p.href) ? p.href.slice(0, 500) : null;
    const said = (p.price ?? '').trim();
    const s = priceFromText(said.replace(/,/g, ''));
    const priceCurrency: PriceCurrency = (s as { priceCurrency?: PriceCurrency }).priceCurrency ?? 'GBP';
    if (s.priceType && s.priceAmount != null && s.priceAmount > 0) {
        return { name, url, priceType: s.priceType, priceAmount: s.priceAmount, priceCurrency, price: priceDisplay({ ...s, priceCurrency }) };
    }
    return { name, url, priceType: said ? 'text' : null, priceAmount: null, priceCurrency: 'GBP', price: said ? said.slice(0, 60) : null };
}

export function importedSocialLinks(pages: ReadPage[]): string[] {
    return [...new Set(pages.flatMap((p) => p.page.socialLinks ?? []))].slice(0, 8);
}
/** The questions their form asked — the contact page's form first, else the first form found. */
export function importedFormFields(pages: ReadPage[]): string[] {
    const withForm = pages.filter((p) => p.page.formFields?.length);
    const best = withForm.find((p) => CONTACT_PAGE.test(new URL(p.url).pathname)) ?? withForm[0];
    return best?.page.formFields ?? [];
}

/** The first email, phone and address found across the pages read (home first). */
export function importedContact(pages: ReadPage[]): { email: string | null; phone: string | null; address: string | null } {
    const first = <T>(f: (p: ImportPage) => T | null | undefined) => pages.map((p) => f(p.page)).find((x) => x) ?? null;
    const phone = first((p) => p.contact.phones[0]);
    return {
        email: first((p) => p.contact.emails[0]),
        phone: phone && phone.length <= LIMITS.phone ? phone : null,
        address: first((p) => p.contact.address),
    };
}

/** Every word placed on the draft comes from the pages read — the property the design guarantees (tests). */
export function draftWordsAllFromSource(definition: SiteDefinition, pages: ReadPage[], extraAllowed: string[] = []): string[] {
    const source = normaliseText(pages.flatMap((p) => p.page.blocks.map((b) => (b.kind === 'image' ? b.alt : b.text))).join(' \n '));
    const strays: string[] = [];
    const check = (s: unknown) => {
        if (typeof s !== 'string' || !s.trim()) return;
        for (const line of plainOf(s).split(/\n+/)) {
            const t = normaliseText(line);
            if (t && !source.includes(t) && !extraAllowed.some((a) => normaliseText(a) === t) && !/^\[[^\]]+\]$/.test(t)) strays.push(line);
        }
    };
    for (const p of definition.pages) for (const s of p.sections) {
        const pr = s.props as unknown as Record<string, unknown>;
        for (const k of ['headline', 'subheadline', 'heading', 'intro', 'body']) check(pr[k]);
        for (const k of ['primaryCta', 'secondaryCta', 'button']) check((pr[k] as { label?: unknown } | null | undefined)?.label);
        if (Array.isArray(pr.items)) for (const it of pr.items as Array<Record<string, unknown>>) {
            for (const k of ['title', 'body', 'q', 'a', 'quote', 'name', 'detail']) check(it[k]);
            check((it.link as { label?: unknown } | null | undefined)?.label);
        }
    }
    return strays;
}

// ── The whole import, with its outside world passed in ──────────────────────────────────────────
// site-import-store.ts passes the real fetcher, model and picture library; the tests pass saved pages.

export interface ImportDeps {
    /** One page, through robots.txt and the SSRF fence (site-fetch.ts). */
    fetchHtml(url: string): Promise<{ ok: true; html: string; finalUrl: string } | { ok: false; message: string }>;
    /**
     * The same page with its JavaScript run (site-js-render.ts) — asked for only when the plain read
     * found under IMPORT_THIN_WORDS, i.e. a site that draws its words after the page loads.
     */
    renderHtml?(url: string): Promise<{ ok: true; html: string; finalUrl: string } | { ok: false; message: string }>;
    /** A builder's own data file (Wix page JSON) — where an embedded HTML box lives (site-embeds.ts). */
    fetchJson?(url: string): Promise<{ ok: true; html: string; finalUrl: string } | { ok: false; message: string }>;
    /** The model's reply to the plan prompt, parsed — or null when it failed (the import still runs, unplanned). */
    plan(prompt: { system: string; user: string }): Promise<unknown | null>;
    /** Copy one picture into the workspace's library: its asset id, or null when it couldn't be copied. */
    savePicture(src: string, alt: string): Promise<number | null>;
    /**
     * One of their stylesheets, through the SSRF fence — for their colours and fonts
     * (site-import-theme.ts). Optional: without it the look is read from the page alone.
     */
    fetchCss?(url: string): Promise<string | null>;
}

export interface ImportInput { url: string; pictures: PictureChoice; current: SiteDefinition; maxPages: number; }

export type ImportOutcome =
    | { ok: true; definition: SiteDefinition; report: ImportReport; warnings: string[] }
    | { ok: false; message: string; report: ImportReport | null };

/** What we say when there is too little to import — honestly, and with the way round it. */
export function thinMessage(words: number, builder: ImportPage['builder'], embedsUnread = 0): string {
    const how = embedsUnread
        ? 'Most of your home page sits inside an embedded HTML box that we couldn\'t open.'
        : builder === 'square' || builder === 'other'
        ? 'It looks like your site draws its words with JavaScript after the page loads, which we can\'t read yet.'
        : 'Your site may be mostly pictures, or draw its words with JavaScript after the page loads, which we can\'t read yet.';
    return `We could only read a little of your site (${words} word${words === 1 ? '' : 's'}), so we haven't made a draft from it — it would be nearly empty. ${how} Paste your text in instead with "Add your own words" on each page, or let your assistant write your site from your business details. Nothing was charged.`;
}

async function inTurns<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
        while (next < list.length) { const i = next++; out[i] = await fn(list[i]); }
    }));
    return out;
}

export async function runImport(input: ImportInput, deps: ImportDeps): Promise<ImportOutcome> {
    const home = await readPage(input.url, deps);
    if (!home.ok) return { ok: false, message: `We couldn't read ${input.url}: ${home.message}`, report: null };
    const homePage = home.page;
    const pageCap = Math.max(1, Math.min(IMPORT_MAX_PAGES, input.maxPages));
    const menu = pickImportPages(homePage, IMPORT_MAX_PAGES * 2);
    const toRead = choosePages(menu, pageCap - 1);
    // Their contact page matters more than the last page that fits: it is where the enquiry form goes.
    const contactAt = menu.findIndex((l) => CONTACT_PAGE.test(new URL(l.href).pathname) || CONTACT_PAGE.test(l.text.toLowerCase()));
    if (contactAt >= 0 && !toRead.includes(menu[contactAt]) && toRead.length) toRead[toRead.length - 1] = menu[contactAt];
    const homeLabel = homePage.navLinks.find((l) => samePath(l.href, homePage.url))?.text ?? null;

    const reports: ImportReport['pages'] = [{ url: homePage.url, title: homeLabel ?? 'Home', words: homePage.words, read: true, note: null }];
    const read: ReadPage[] = [{ url: homePage.url, menuLabel: homeLabel, page: homePage }];
    const fetched = await inTurns(toRead, 3, async (l) => ({ l, r: await readPage(l.href, deps) }));
    // A page that is only the Blog Assistant's widget (Restorative Futures' "Blogs") is not a page to
    // copy: its posts are already ours, and the new site shows them at /blog. The blog is switched on
    // under their menu's word for it, and links to the old page go to /blog.
    let blog: { label: string; urls: string[] } | null = null;
    // A blog on another platform (WordPress, Squarespace, Wix, Ghost): its index page isn't copied as
    // a page either — its posts are read (site-import-blog.ts) and become Blog Assistant DRAFTS when
    // the owner uses the import. The first index found is the one read.
    const menuUrls = [homePage.url, ...menu.map((l) => l.href)];
    let otherBlog: { l: SiteLink; signal: BlogIndexSignal; page: ImportPage | null; at: number; finalUrl: string } | null = null;
    for (const { l, r } of fetched) {
        if (!r.ok) { reports.push({ url: l.href, title: l.text, words: 0, read: false, note: r.message }); continue; }
        if (BLOG_WIDGET.test(r.html)) {
            const prev = blog as { label: string; urls: string[] } | null;
            blog = { label: prev?.label ?? l.text, urls: [...(prev?.urls ?? []), l.href, r.finalUrl] };
            reports.push({ url: r.finalUrl, title: l.text, words: 0, read: true, note: 'Your Blog Assistant posts — shown on the new site\'s blog page, not copied as a page.' });
            continue;
        }
        const page = r.page;
        const signal: BlogIndexSignal | null = otherBlog ? null : findBlogIndexSafe(r.html, r.finalUrl, menuUrls);
        if (signal) { otherBlog = { l, signal, page, at: read.length, finalUrl: r.finalUrl }; continue; }
        if (!page.words && !page.blocks.length) { reports.push({ url: l.href, title: l.text, words: 0, read: false, note: 'We couldn\'t read any words on this page.' }); continue; }
        reports.push({ url: page.url, title: l.text, words: page.words, read: true, note: null });
        read.push({ url: page.url, menuLabel: l.text, page });
    }
    // Their home page may be the blog itself (WordPress's "home blog"): its posts come, the page stays.
    if (!otherBlog && !blog) {
        const signal = findBlogIndexSafe(home.html, home.finalUrl, menuUrls);
        if (signal) otherBlog = { l: { text: homeLabel ?? 'Blog', href: homePage.url } as SiteLink, signal, page: null, at: -1, finalUrl: home.finalUrl };
    }
    let importedBlog: ImportedBlog | null = null;
    if (otherBlog) {
        const label = otherBlog.at < 0 ? 'Blog' : otherBlog.l.text.slice(0, 30) || 'Blog';
        importedBlog = await readImportedBlog(otherBlog.signal, label, {
            fetchHtml: (u) => deps.fetchHtml(u),
            fetchJson: deps.fetchJson ? (u) => deps.fetchJson!(u) : undefined,
            savePicture: input.pictures === 'copy' ? (src, alt) => deps.savePicture(src, alt) : undefined,
        }).catch(() => null);
        const found = importedBlog?.posts.length ?? 0;
        if (otherBlog.at >= 0 && found) {
            blog = { label, urls: [otherBlog.l.href, otherBlog.finalUrl] };
            reports.push({ url: otherBlog.finalUrl, title: otherBlog.l.text, words: 0, read: true, note: `Your blog — ${found} post${found === 1 ? '' : 's'} come${found === 1 ? 's' : ''} across as drafts for your Blog Assistant, not copied as a page.` });
        } else if (otherBlog.at >= 0 && otherBlog.page) {
            // No posts could be read: the page is imported like any other, where it was in the menu.
            const page = otherBlog.page;
            if (page.words || page.blocks.length) {
                reports.push({ url: page.url, title: otherBlog.l.text, words: page.words, read: true, note: null });
                read.splice(Math.min(otherBlog.at, read.length), 0, { url: page.url, menuLabel: otherBlog.l.text, page });
            }
        }
        if (!found) importedBlog = null;
    }
    const wordsRead = read.reduce((n, p) => n + p.page.words, 0);
    const baseReport = (): ImportReport => ({
        sourceUrl: input.url, builder: homePage.builder, platform: homePage.platform ?? null, pages: reports, wordsRead,
        notImported: menu.filter((l) => !toRead.includes(l)).map((l) => ({ url: l.href, title: l.text })),
        pictures: { choice: input.pictures, found: read.reduce((n, p) => n + p.page.blocks.filter((b) => b.kind === 'image').length, 0) + (homePage.logo ? 1 : 0), copied: 0, failed: 0, undescribed: 0 },
        prices: [], leftOut: [], notCarried: [], contact: importedContact(read), hadForm: read.some((p) => p.page.hasForm), formFields: importedFormFields(read), placeholders: 0,
        blog: importedBlog,
    });
    if (wordsRead < IMPORT_THIN_SITE_WORDS || (homePage.words < IMPORT_THIN_WORDS && read.length === 1)) {
        return { ok: false, message: thinMessage(wordsRead, homePage.builder, home.embedsUnread), report: baseReport() };
    }

    const { blocks, prices } = numberBlocks(read);
    const allowed = (t: SectionType) => sectionAllowed(input.current.settings, t);
    let plan: ImportPlan | null = null;
    plan = await planInBatches(read, blocks, { siteName: input.current.settings.siteName, pictures: input.pictures, allowed }, deps);

    const report = baseReport();
    report.prices = prices.slice(0, 40);
    const assets = new Map<number, number>();
    if (input.pictures === 'copy') {
        for (const n of picturesInPlan(plan, blocks)) {
            const b = blocks[n - 1].block;
            if (b.kind !== 'image') continue;
            const id = await deps.savePicture(b.src, b.alt).catch(() => null);
            if (id) { assets.set(n, id); report.pictures.copied++; if (!b.altFromSite) report.pictures.undescribed++; } else report.pictures.failed++;
        }
    }
    report.products = importedProducts(read, blocks, assets);
    if (!report.products.length) delete report.products;
    const built = assembleImport({ current: input.current, pages: read, blocks, plan, assets, maxPages: input.maxPages, blogUrls: blog?.urls });
    let definition = built.definition;
    if (blog) {
        const fromBlog = [...new Set(blog.urls.map((u) => redirectKey(new URL(u).pathname)))].map((from) => ({ from, to: BLOG_PATH }));
        definition = normaliseSiteDefinition({ ...definition, settings: { ...definition.settings, blog: { enabled: true, menuLabel: blog.label } }, redirects: [...(definition.redirects ?? []), ...fromBlog] }, { maxPages: input.maxPages }).definition;
    }
    // Their logo, when the new site has none yet (a picture they chose to copy, like the rest).
    if (input.pictures === 'copy' && !definition.theme.logoUrl && !definition.theme.logoAssetId && homePage.logo) {
        const id = await deps.savePicture(homePage.logo.src, homePage.logo.alt).catch(() => null);
        if (id) {
            report.pictures.copied++;
            definition = normaliseSiteDefinition({ ...definition, theme: { ...definition.theme, logoAssetId: id } }, { maxPages: input.maxPages }).definition;
        }
    }
    // Their look: colours, lettering and corners read from the home page and its stylesheets.
    const look = await readLook(home.html, home.finalUrl, deps, homePage.platform ?? null);
    report.look = lookFound(look) ? look : null;
    if (report.look) definition = normaliseSiteDefinition({ ...definition, theme: themeWithLook(definition.theme, report.look) }, { maxPages: input.maxPages }).definition;
    report.leftOut = built.leftOut.slice(0, 60);
    report.notCarried = built.notCarried;
    report.placeholders = countPlaceholders(definition);
    return { ok: true, definition, report, warnings: built.warnings };
}

function findBlogIndexSafe(html: string, url: string, menuUrls: string[]): BlogIndexSignal | null {
    try { return findBlogIndex(html, url, menuUrls); } catch { return null; }
}

/** The Blog Assistant's widget on their page (blog-widget embed): its posts are already in Be More Swan. */
const BLOG_WIDGET = /bemoreswan\.com\/widget\.js|data-bms-blog\b/i;

/**
 * The site's layout plan, in batches of pages when the site is large. One request for a whole large
 * site failed outright (a 17-page, 17,000-word site, live check 2026-11-09) and every page fell back to
 * plain text. Each batch keeps the pages' own numbers and block numbers, so the plans join up; a batch
 * that fails leaves only its own pages as text.
 */
export const PLAN_BATCH_BLOCKS = 260;
export const PLAN_BATCH_PAGES = 6;
export async function planInBatches(pages: ReadPage[], blocks: NumberedBlock[], opts: { siteName: string; pictures: PictureChoice; allowed: (t: SectionType) => boolean }, deps: Pick<ImportDeps, 'plan'>): Promise<ImportPlan | null> {
    const batches: number[][] = [];
    let cur: number[] = [];
    let size = 0;
    pages.forEach((_, i) => {
        const n = blocks.filter((b) => b.page === i).length;
        if (cur.length && (size + n > PLAN_BATCH_BLOCKS || cur.length >= PLAN_BATCH_PAGES)) { batches.push(cur); cur = []; size = 0; }
        cur.push(i); size += n;
    });
    if (cur.length) batches.push(cur);
    const one = async (only?: number[]) => {
        try { return readImportPlan(await deps.plan(buildImportPrompt(pages, blocks, { ...opts, only }))); } catch { return null; }
    };
    if (batches.length <= 1) return one();
    const plans = await inTurns(batches, 2, (b) => one(b));
    const ok = plans.filter((x): x is ImportPlan => !!x);
    if (!ok.length) return null;
    return { pages: ok.flatMap((x) => x.pages), skip: ok.flatMap((x) => x.skip) };
}

/** Stylesheets read for the look: their own first; a site with thirty is a build artefact. */
const LOOK_MAX_STYLESHEETS = 4;
async function readLook(html: string, finalUrl: string, deps: ImportDeps, platform: string | null = null): Promise<ImportedLook | null> {
    try {
        // The platform adapter that read the page has its say (site-builders/types.ts lookStylesheets, lookCss, look).
        const adapter = platform ? ADAPTERS.find((a) => a.key === platform) ?? null : null;
        let css = '';
        if (deps.fetchCss) {
            let own: string[] = [];
            try { own = adapter?.lookStylesheets?.(html, finalUrl) ?? []; } catch { own = []; }
            const sheets = [...new Set([...own, ...harvestBrandSignals(html, finalUrl).stylesheets])].slice(0, LOOK_MAX_STYLESHEETS + own.length);
            css = (await Promise.all(sheets.map((u) => deps.fetchCss!(u).catch(() => null)))).filter(Boolean).join('\n');
        }
        let shared = { html, css };
        try { shared = adapter?.lookCss?.(shared) ?? shared; } catch { shared = { html, css }; }
        const look = readImportedLook(shared.html, finalUrl, shared.css);
        let ownLook: Partial<ImportedLook> | null = null;
        try { ownLook = adapter?.look?.({ html, css, $: cheerio.load(html), url: safeUrlOf(finalUrl) }) ?? null; } catch { ownLook = null; }
        return ownLook ? withOwnLook(look, ownLook) : look;
    } catch { return null; }
}

/** The adapter's own reading over the shared one: each field it found wins; a named font finds its pairing. */
export function withOwnLook(look: ImportedLook, own: Partial<ImportedLook>): ImportedLook {
    const out: ImportedLook = { ...look };
    for (const [k, v] of Object.entries(own) as Array<[keyof ImportedLook, unknown]>) if (v !== null && v !== undefined && v !== '') (out as unknown as Record<string, unknown>)[k] = v;
    if (own.headingFont && !own.font) out.font = fontKeyFor(own.headingFont) ?? look.font;
    // The adapter's main colour must read on the page too, or the shared reading stands.
    if (out.primaryColor && !readsOn(out.primaryColor, out.backgroundColor ?? '#ffffff')) out.primaryColor = look.primaryColor;
    return out;
}
const safeUrlOf = (u: string): URL | null => { try { return new URL(u); } catch { return null; } };

/**
 * One page: the plain read, and — when that found almost no words — the page again with its
 * JavaScript run. The rendered read is kept only when it found more words; the menu still comes from
 * whichever read had it (a JavaScript menu is read from the rendered page).
 */
async function readPage(url: string, deps: ImportDeps): Promise<{ ok: true; page: ImportPage; embedsUnread: number; html: string; finalUrl: string } | { ok: false; message: string }> {
    const r = await deps.fetchHtml(url);
    if (!r.ok) return r;
    let page = readImportPageSafe(r.html, r.finalUrl);
    if (page.words >= IMPORT_THIN_WORDS) return { ok: true, page, embedsUnread: 0, html: r.html, finalUrl: r.finalUrl };
    // Words inside an embedded HTML box (Wix "Embed HTML", site-embeds.ts) — cheaper than a browser,
    // and a browser wouldn't see them anyway (page.content() is the top document only).
    const embeds = await inlineEmbeds(r.html, r.finalUrl, embedFetchers(deps));
    const withEmbeds = embeds.read ? readImportPageSafe(embeds.html, r.finalUrl) : page;
    if (withEmbeds.words > page.words) page = { ...withEmbeds, navLinks: withEmbeds.navLinks.length ? withEmbeds.navLinks : page.navLinks };
    const embedsUnread = embeds.found - embeds.read;
    if (page.words >= IMPORT_THIN_WORDS || !deps.renderHtml) return { ok: true, page, embedsUnread, html: r.html, finalUrl: r.finalUrl };
    const rendered = await deps.renderHtml(r.finalUrl).catch(() => null);
    if (!rendered?.ok) return { ok: true, page, embedsUnread, html: r.html, finalUrl: r.finalUrl };
    const renderedEmbeds = await inlineEmbeds(rendered.html, r.finalUrl, embedFetchers(deps));
    const fuller = readImportPageSafe(renderedEmbeds.html, r.finalUrl);
    if (fuller.words <= page.words) return { ok: true, page, embedsUnread, html: r.html, finalUrl: r.finalUrl };
    // The look is read from the page as the browser drew it, too: a JavaScript site's colours arrive with it.
    return { ok: true, page: { ...fuller, navLinks: fuller.navLinks.length ? fuller.navLinks : page.navLinks }, embedsUnread: renderedEmbeds.found - renderedEmbeds.read, html: rendered.html, finalUrl: r.finalUrl };
}

function embedFetchers(deps: ImportDeps): EmbedFetchers {
    return { html: (u) => deps.fetchHtml(u), json: (u) => (deps.fetchJson ? deps.fetchJson(u) : Promise.resolve({ ok: false as const, message: 'not read' })) };
}

/** readImportPage, never throwing: a page cheerio can't make sense of reads as empty. */
function readImportPageSafe(html: string, url: string): ImportPage {
    try { return readImportPage(html, url); }
    catch { return { url, title: null, description: null, navLinks: [], blocks: [], words: 0, contact: { emails: [], phones: [], address: null, locality: null }, siteName: null, logo: null, hasForm: false, builder: 'other' }; }
}

function countPlaceholders(def: SiteDefinition): number {
    return (JSON.stringify(def.pages).match(PLACEHOLDER) ?? []).length;
}

