// src/utils/site-definition.ts — what a Website Assistant site IS. docs/website-assistant-plan.md §4.2, §5.1.
//
// A site is a JSON definition — theme, navigation, pages, sections, footer, business details — that
// our own renderer (site-render.ts) turns into HTML. The model NEVER writes HTML: it proposes typed
// operations (add a section, change a headline, reorder, set the theme), and every one of them, and
// every save from the editor, passes through ONE gate: `normaliseSiteDefinition`. That is the Form
// Builder pattern (memory: form-builder-definition), and it is what makes these promises hold:
//   · every page renders, on every screen size, because only known sections with known props exist;
//   · nothing a user or a model types can become markup, script or a dangerous link — text is text,
//     links are https / mailto / tel / one of the site's own pages, images are https with alt text;
//   · the plan's page cap, one home page, unique page addresses and readable colours always hold.
//
// PURE: no database, no network. tests/site-definition.test.ts.

import { contrastRatio, normalizeHex, readableInkOn } from './brand-kit';

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────

export type FontKey = 'sans' | 'serif' | 'rounded' | 'system';
export type RadiusKey = 'none' | 'small' | 'medium' | 'large';
export type BusinessType = 'Organization' | 'LocalBusiness' | 'ProfessionalService' | 'Store';

export interface SiteTheme {
    primaryColor: string;
    textColor: string;
    backgroundColor: string;
    font: FontKey;
    radius: RadiusKey;
    /** https URL of the logo; null = the site name in text. */
    logoUrl: string | null;
    /**
     * A logo from the workspace's own media library (content_assets id) — what "Choose picture"
     * sets. Wins over logoUrl. Ownership is checked when it is saved (site-store.ts verifySiteAssets).
     */
    logoAssetId?: number | null;
}

export interface SiteSettings {
    siteName: string;
    /** The search description of the home page when it has none of its own. */
    description: string | null;
    businessType: BusinessType;
    /** Town or city — what a buyer (or an AI assistant) needs to know where you work. */
    locality: string | null;
    email: string | null;
    phone: string | null;
}

export interface Link { label: string; href: string; }
/**
 * A picture: either a web address (url) or one of the workspace's own library pictures (assetId —
 * what "Choose picture" and chat attachments set; url is then ''). A library picture is drawn
 * through a signed, permanent link (newsletter-media-url.ts), and is checked to belong to the
 * workspace whenever it is saved (site-store.ts verifySiteAssets).
 */
export interface Image { url: string; alt: string; assetId?: number | null; }

export interface HeroProps {
    layout: 'centered' | 'split' | 'banner';
    eyebrow: string | null;
    headline: string;
    subheadline: string | null;
    primaryCta: Link | null;
    secondaryCta: Link | null;
    image: Image | null;
}
export interface ItemsProps { heading: string | null; intro: string | null; items: Array<{ title: string; body: string }>; }
/** Text, optionally with a picture beside it (left or right — on a phone it sits above the words). */
export interface TextProps { heading: string | null; body: string; image: Image | null; imageSide: 'left' | 'right'; }
export interface FaqProps { heading: string | null; items: Array<{ q: string; a: string }>; }
export interface CtaProps { heading: string; body: string | null; button: Link; }
/** What customers say — the proof a buyer looks for (and the Mystery Shopper checks for). */
export interface TestimonialsProps { heading: string | null; items: Array<{ quote: string; name: string; detail: string | null }>; }
/**
 * An enquiry form (step 3b). Name, email, message (and phone when asked). Messages are kept for the
 * site's owner (site_enquiries) — they are NOT a sign-up: nobody joins the Audience by asking a question.
 */
export interface ContactProps { heading: string | null; intro: string | null; askPhone: boolean; buttonLabel: string; }
/**
 * One of the workspace's Form Builder sign-up forms, drawn on the site (step 3b). `formId` is an
 * audience_forms id; whether it belongs to this workspace and is active is checked when the page is
 * drawn and again when someone signs up — a form that is not usable draws nothing on the live site.
 */
/** `image`: optional — a cover beside the form, e.g. the free guide's front page (a lead magnet). */
export interface SignupProps { heading: string | null; intro: string | null; formId: number | null; image: Image | null; }
/**
 * Things the business sells. `productIds` are Business Information ▸ Products & Services rows
 * (org_products) — the ONE place names, prices and pictures live: the page and checkout read them
 * from there (site-shop.ts loadSiteProducts), so a price changed once changes everywhere. Only a
 * product with a FIXED price gets a Buy button (product-price.ts buyablePence).
 *
 * `items` is the older shape (owner-typed copies inside the site), kept only so a site made before
 * products moved can still be drawn and its items moved into Business Information (sites.ts
 * products_import). New sections never get items; legacy items are shown but never sold.
 */
/**
 * Bookings (docs/booking-plan.md). The section is only the doorway: services come from Business
 * Information products with a duration, opening hours and rules from Business Information ▸ Opening
 * hours & bookings, and every step after the first is a page of its own (/_book — booking-render.ts).
 * `serviceIds` empty = every bookable service. `askStaff` offers a choice of who (or "anyone").
 */
/**
 * Opening hours & contact: the "Open now · closes 6pm" badge, the week's hours, closed days coming
 * up, and one-tap Call / WhatsApp / Email / Directions — all read from Business Information (hours,
 * where to find you) and the site's business details (phone, email). Holds no facts of its own.
 */
/**
 * A menu or price list: Business Information products and services, in groups the owner names
 * ("Starters", "Cuts & colour"), as name · price lines. Like `products`, it holds only WHICH products
 * and in what order — names, prices, descriptions and lengths are read from Business Information when
 * the page is drawn, so a price changed there changes here. Nothing on it is bought; see `products`.
 */
export interface MenuGroup { title: string | null; productIds: number[]; }
export interface MenuProps { heading: string | null; intro: string | null; groups: MenuGroup[]; showDescriptions: boolean; showDurations: boolean; note: string | null; }
/**
 * A gallery: the owner's own pictures (library assets, or an https address) — each with a description
 * of what it shows (alt, required) and an optional caption. `layout` square = an even grid of cropped
 * tiles; natural = each picture at its own shape. Every picture links to itself at full size (no
 * script on customer sites, so no lightbox).
 */
export interface GalleryImage extends Image { caption: string | null; }
export interface GalleryProps { heading: string | null; intro: string | null; layout: 'square' | 'natural'; images: GalleryImage[]; }
/**
 * Reviews from Business Information ▸ Reviews (org_reviews) — the customers' words, never typed into
 * the site. `reviewIds` chooses which to quote, in order; empty = the newest. The summary ("4.8 ★
 * from 23 reviews") is always the honest average of every review recorded, hidden ones included.
 */
export interface ReviewsProps { heading: string | null; intro: string | null; reviewIds: number[]; limit: number; showSummary: boolean; }
export interface HoursProps { heading: string | null; intro: string | null; showHours: boolean; showContact: boolean; showAddress: boolean; }
/** 'class': classes and events — dated sessions with places (class-sessions.ts), not times from opening hours. */
export type BookingSectionKind = 'appointment' | 'consultation' | 'table' | 'class';
export interface BookingProps { heading: string | null; intro: string | null; kind: BookingSectionKind; serviceIds: number[]; askStaff: boolean; buttonLabel: string; }
export interface ProductItem { name: string; description: string | null; price: number | null; image: Image | null; }
export interface ProductsProps { heading: string | null; intro: string | null; productIds: number[]; items: ProductItem[]; collectAddress: boolean; buyLabel: string; }

/**
 * How a section looks, on top of what it says — the same for every section type. Closed set of
 * choices (never CSS): `background` auto = the alternating tint the page has always had; `columns`
 * applies to grid sections (features, steps, testimonials, products); `menuLabel` makes the section
 * a menu entry on a one-page site (the menu links down the page to it).
 */
export interface SectionLook { background: 'auto' | 'plain' | 'soft' | 'brand'; columns: 'auto' | 2 | 3; menuLabel: string | null; }
export const DEFAULT_LOOK: SectionLook = { background: 'auto', columns: 'auto', menuLabel: null };

export type Section = SectionBody & { look?: SectionLook };
export type SectionBody =
    | { id: string; type: 'hero'; props: HeroProps }
    | { id: string; type: 'features'; props: ItemsProps }
    | { id: string; type: 'steps'; props: ItemsProps }
    | { id: string; type: 'text'; props: TextProps }
    | { id: string; type: 'faq'; props: FaqProps }
    | { id: string; type: 'cta'; props: CtaProps }
    | { id: string; type: 'testimonials'; props: TestimonialsProps }
    | { id: string; type: 'contact'; props: ContactProps }
    | { id: string; type: 'signup'; props: SignupProps }
    | { id: string; type: 'products'; props: ProductsProps }
    | { id: string; type: 'booking'; props: BookingProps }
    | { id: string; type: 'hours'; props: HoursProps }
    | { id: string; type: 'menu'; props: MenuProps }
    | { id: string; type: 'gallery'; props: GalleryProps }
    | { id: string; type: 'reviews'; props: ReviewsProps };
export type SectionType = SectionBody['type'];
export const SECTION_TYPES: readonly SectionType[] = ['hero', 'features', 'steps', 'text', 'faq', 'testimonials', 'cta', 'contact', 'signup', 'products', 'booking', 'hours', 'menu', 'gallery', 'reviews'];

export interface SitePageDef {
    id: string;
    /** '' is the home page; otherwise the page's address, e.g. 'services'. */
    slug: string;
    title: string;
    seo: { title: string | null; description: string | null };
    sections: Section[];
    /** Left out of the menu, still reachable by its address — a landing page for an ad or a post. */
    hideFromMenu: boolean;
}

export interface SiteDefinition {
    version: 1;
    theme: SiteTheme;
    settings: SiteSettings;
    /** Page ids, in menu order. Empty = every page, in page order. */
    nav: Array<{ label: string; pageId: string }>;
    pages: SitePageDef[];
    footer: { text: string | null };
    /**
     * 'pages' — the menu lists pages. 'one_page' — everything that matters is on the home page and
     * the menu links down it to the sections that have a menu label (other pages may still exist,
     * e.g. landing pages, and are listed after those unless hidden).
     */
    structure: 'pages' | 'one_page';
}

// ── Limits ──────────────────────────────────────────────────────────────────────────────────

export const LIMITS = {
    siteName: 80, description: 170, locality: 80, email: 254, phone: 30,
    pageTitle: 80, seoTitle: 65, seoDescription: 170, slug: 40,
    sectionsPerPage: 20, navItems: 7, navLabel: 30, footer: 300,
    headline: 120, subheadline: 300, eyebrow: 40, ctaLabel: 40, href: 500, alt: 150,
    itemTitle: 80, itemBody: 400, intro: 300, textBody: 3000, faqItems: 15, q: 200, a: 1000,
    features: 9, stepsMin: 2, steps: 6, testimonials: 9, quote: 500, personName: 80, personDetail: 80,
    buttonLabel: 40, products: 12, productName: 80, productDescription: 400,
    menuGroups: 12, menuItems: 100, menuNote: 300, galleryImages: 24, caption: 150, reviewsShown: 12,
    /** Pence. Stripe's GBP minimum is 30p; the ceiling is a sanity bound for a small-business shop. */
    minPrice: 30, maxPrice: 1_000_000,
} as const;

/** Pages a site may have when the plan sets no number (decision D1: 5 on £29). */
export const DEFAULT_MAX_PAGES = 5;
/** Below this, body text on the background is hard to read (WCAG AA for body text). */
export const MIN_TEXT_CONTRAST = 4.5;
/** Page addresses we serve ourselves, which a page may never take. */
export const RESERVED_SLUGS = new Set(['sitemap.xml', 'robots.txt', 'api', 'preview', 'assets', 'favicon.ico', '_bms', 'report']);

export const DEFAULT_THEME: SiteTheme = {
    primaryColor: '#1f2937', textColor: '#1f2937', backgroundColor: '#ffffff', font: 'sans', radius: 'medium', logoUrl: null,
};

// ── Text and link cleaning ──────────────────────────────────────────────────────────────────

/** Plain text: control characters out, whitespace collapsed (newlines kept where `multiline`), clamped. */
export function cleanText(v: unknown, max: number, multiline = false): string {
    if (typeof v !== 'string') return '';
    let s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = multiline
        ? s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').split('\n').map((l) => l.trim()).join('\n').trim()
        : s.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trimEnd() : s;
}
const textOrNull = (v: unknown, max: number, multiline = false) => cleanText(v, max, multiline) || null;

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_RE = /^[a-z0-9_-]{1,24}$/;

/** A page address from anything a person or model typed: 'Our Services!' → 'our-services'. */
export function slugify(v: unknown): string {
    return cleanText(v, 200).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.slug).replace(/-+$/, '');
}

/**
 * A link a visitor can safely follow: https, mailto, tel, an in-page anchor, or one of this site's
 * own pages ('/' or '/<slug>' — checked against the real pages in a second pass). Everything else —
 * javascript:, data:, plain http, protocol-relative — is refused (null).
 */
export function cleanHref(v: unknown): string | null {
    const s = cleanText(v, LIMITS.href);
    if (!s) return null;
    if (s === '/' || /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) return s;
    if (/^#[a-z0-9_-]{1,40}$/i.test(s)) return s;
    if (/^mailto:[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/i.test(s)) return s;
    if (/^tel:\+?[0-9 ()-]{5,20}$/i.test(s)) return s.replace(/\s+/g, '');
    try {
        const u = new URL(s);
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return u.toString();
    } catch { return null; }
}

function cleanLink(v: unknown): Link | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const label = cleanText(o.label, LIMITS.ctaLabel);
    const href = cleanHref(o.href);
    return label && href ? { label, href } : null;
}

/** An image must be https AND described — an image without alt text is dropped, not shipped. */
function cleanImage(v: unknown, warn: (m: string) => void): Image | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const alt = cleanText(o.alt, LIMITS.alt);
    const assetId = Number(o.assetId);
    if (Number.isInteger(assetId) && assetId > 0) {
        if (!alt) { warn('A picture was left out: every picture needs a short description of what it shows.'); return null; }
        return { url: '', alt, assetId };
    }
    const url = cleanHref(o.url);
    if (!url || !url.startsWith('https://')) { if (o.url) warn('An image was left out: it needs an https address.'); return null; }
    if (!alt) { warn('An image was left out: every image needs a short description (alt text).'); return null; }
    return { url, alt };
}

// ── Sections ────────────────────────────────────────────────────────────────────────────────

function items(v: unknown, max: number, warn: (m: string) => void): Array<{ title: string; body: string }> {
    const list = Array.isArray(v) ? v : [];
    const out = list.map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return { title: cleanText(o.title, LIMITS.itemTitle), body: cleanText(o.body, LIMITS.itemBody, true) };
    }).filter((x) => x.title);
    if (out.length > max) warn(`Only the first ${max} items were kept.`);
    return out.slice(0, max);
}

/** One section's props, cleaned. Null = not a usable section (dropped, with a warning). */
export function cleanSection(type: unknown, rawProps: unknown, warn: (m: string) => void): Omit<Section, 'id'> | null {
    const p = (rawProps && typeof rawProps === 'object' ? rawProps : {}) as Record<string, unknown>;
    switch (type) {
        case 'hero': {
            const headline = cleanText(p.headline, LIMITS.headline);
            if (!headline) { warn('A hero section was left out: it needs a headline.'); return null; }
            const layout = p.layout === 'split' || p.layout === 'banner' ? p.layout : 'centered';
            return { type: 'hero', props: {
                layout, headline,
                eyebrow: textOrNull(p.eyebrow, LIMITS.eyebrow),
                subheadline: textOrNull(p.subheadline, LIMITS.subheadline),
                primaryCta: cleanLink(p.primaryCta), secondaryCta: cleanLink(p.secondaryCta),
                image: cleanImage(p.image, warn),
            } };
        }
        case 'features':
        case 'steps': {
            const max = type === 'features' ? LIMITS.features : LIMITS.steps;
            const list = items(p.items, max, warn);
            if (!list.length) { warn(`A ${type} section was left out: it has no items.`); return null; }
            if (type === 'steps' && list.length < LIMITS.stepsMin) { warn('A steps section was left out: it needs at least two steps.'); return null; }
            return { type, props: { heading: textOrNull(p.heading, LIMITS.headline), intro: textOrNull(p.intro, LIMITS.intro, true), items: list } };
        }
        case 'text': {
            const body = cleanText(p.body, LIMITS.textBody, true);
            if (!body) { warn('A text section was left out: it is empty.'); return null; }
            return { type: 'text', props: { heading: textOrNull(p.heading, LIMITS.headline), body, image: cleanImage(p.image, warn), imageSide: p.imageSide === 'left' ? 'left' : 'right' } };
        }
        case 'faq': {
            const list = (Array.isArray(p.items) ? p.items : []).map((x) => {
                const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
                return { q: cleanText(o.q, LIMITS.q), a: cleanText(o.a, LIMITS.a, true) };
            }).filter((x) => x.q && x.a);
            if (!list.length) { warn('A questions section was left out: it has no questions with answers.'); return null; }
            if (list.length > LIMITS.faqItems) warn(`Only the first ${LIMITS.faqItems} questions were kept.`);
            return { type: 'faq', props: { heading: textOrNull(p.heading, LIMITS.headline), items: list.slice(0, LIMITS.faqItems) } };
        }
        case 'testimonials': {
            const list = (Array.isArray(p.items) ? p.items : []).map((x) => {
                const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
                return { quote: cleanText(o.quote, LIMITS.quote, true), name: cleanText(o.name, LIMITS.personName), detail: textOrNull(o.detail, LIMITS.personDetail) };
            }).filter((x) => x.quote && x.name);
            // A quote with nobody's name on it is the kind of proof buyers distrust — it needs one.
            if (!list.length) { warn('A testimonials section was left out: each quote needs the customer\'s name.'); return null; }
            if (list.length > LIMITS.testimonials) warn(`Only the first ${LIMITS.testimonials} testimonials were kept.`);
            return { type: 'testimonials', props: { heading: textOrNull(p.heading, LIMITS.headline), items: list.slice(0, LIMITS.testimonials) } };
        }
        case 'cta': {
            const heading = cleanText(p.heading, LIMITS.headline);
            const button = cleanLink(p.button);
            if (!heading || !button) { warn('A call-to-action section was left out: it needs a heading and a button.'); return null; }
            return { type: 'cta', props: { heading, body: textOrNull(p.body, LIMITS.subheadline, true), button } };
        }
        case 'contact': {
            return { type: 'contact', props: {
                heading: textOrNull(p.heading, LIMITS.headline),
                intro: textOrNull(p.intro, LIMITS.intro, true),
                askPhone: p.askPhone === true,
                buttonLabel: cleanText(p.buttonLabel, LIMITS.buttonLabel) || 'Send message',
            } };
        }
        case 'products': {
            const ids = [...new Set((Array.isArray(p.productIds) ? p.productIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
            if (ids.length > LIMITS.products) warn(`Only the first ${LIMITS.products} products were kept.`);
            const list = (Array.isArray(p.items) ? p.items : []).map((x) => {
                const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
                const raw = o.price;
                const pence = raw === null || raw === undefined || raw === '' ? null : Math.round(Number(raw));
                let price: number | null = null;
                if (pence !== null) {
                    if (Number.isFinite(pence) && pence >= LIMITS.minPrice && pence <= LIMITS.maxPrice) price = pence;
                    else warn(`A price was left out: it must be between £${(LIMITS.minPrice / 100).toFixed(2)} and £${(LIMITS.maxPrice / 100).toLocaleString('en-GB')}.`);
                }
                return { name: cleanText(o.name, LIMITS.productName), description: textOrNull(o.description, LIMITS.productDescription, true), price, image: cleanImage(o.image, warn) };
            }).filter((x) => x.name);
            if (!ids.length && !list.length) { warn('A products section was left out: choose at least one of your products.'); return null; }
            if (list.length > LIMITS.products) warn(`Only the first ${LIMITS.products} items were kept.`);
            return { type: 'products', props: {
                heading: textOrNull(p.heading, LIMITS.headline), intro: textOrNull(p.intro, LIMITS.intro, true),
                productIds: ids.slice(0, LIMITS.products),
                items: list.slice(0, LIMITS.products), collectAddress: p.collectAddress === true,
                buyLabel: cleanText(p.buyLabel, LIMITS.buttonLabel) || 'Buy now',
            } };
        }
        case 'reviews': {
            const ids = [...new Set((Array.isArray(p.reviewIds) ? p.reviewIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
            if (ids.length > LIMITS.reviewsShown) warn(`A reviews section quotes up to ${LIMITS.reviewsShown} reviews; the rest were left out.`);
            const limit = Number(p.limit);
            return { type: 'reviews', props: {
                heading: textOrNull(p.heading, LIMITS.headline) ?? 'What our customers say', intro: textOrNull(p.intro, LIMITS.intro, true),
                reviewIds: ids.slice(0, LIMITS.reviewsShown),
                limit: Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.reviewsShown ? limit : 6,
                showSummary: p.showSummary !== false,
            } };
        }
        case 'gallery': {
            const raw = Array.isArray(p.images) ? p.images : [];
            const images = raw.map((x) => {
                const img = cleanImage(x, warn);
                if (!img) return null;
                const o = x as Record<string, unknown>;
                return { ...img, caption: textOrNull(o.caption, LIMITS.caption) };
            }).filter((x): x is GalleryImage => !!x);
            if (!images.length) { warn('A gallery was left out: add at least one picture, each with a short description of what it shows.'); return null; }
            if (images.length > LIMITS.galleryImages) warn(`A gallery shows up to ${LIMITS.galleryImages} pictures; the rest were left out.`);
            return { type: 'gallery', props: {
                heading: textOrNull(p.heading, LIMITS.headline), intro: textOrNull(p.intro, LIMITS.intro, true),
                layout: p.layout === 'natural' ? 'natural' : 'square', images: images.slice(0, LIMITS.galleryImages),
            } };
        }
        case 'menu': {
            // Each product once across the whole menu; empty groups dropped; the item cap counts all groups.
            const seen = new Set<number>();
            let left: number = LIMITS.menuItems;
            const rawGroups = Array.isArray(p.groups) ? p.groups : [];
            if (rawGroups.length > LIMITS.menuGroups) warn(`Only the first ${LIMITS.menuGroups} menu groups were kept.`);
            const groups = rawGroups.slice(0, LIMITS.menuGroups).map((g) => {
                const o = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
                const ids = (Array.isArray(o.productIds) ? o.productIds : []).map(Number)
                    .filter((n) => Number.isInteger(n) && n > 0 && !seen.has(n) && (seen.add(n), true));
                const kept = ids.slice(0, Math.max(0, left));
                if (kept.length < ids.length) warn(`A menu shows up to ${LIMITS.menuItems} items; the rest were left out.`);
                left -= kept.length;
                return { title: textOrNull(o.title, LIMITS.itemTitle), productIds: kept };
            }).filter((g) => g.productIds.length);
            if (!groups.length) { warn('A menu was left out: choose at least one of your products or services.'); return null; }
            return { type: 'menu', props: {
                heading: textOrNull(p.heading, LIMITS.headline), intro: textOrNull(p.intro, LIMITS.intro, true), groups,
                showDescriptions: p.showDescriptions !== false, showDurations: p.showDurations === true,
                note: textOrNull(p.note, LIMITS.menuNote, true),
            } };
        }
        case 'hours': {
            const flag = (k: string) => p[k] !== false;   // on unless turned off
            return { type: 'hours', props: {
                heading: textOrNull(p.heading, LIMITS.headline) ?? 'Opening hours', intro: textOrNull(p.intro, LIMITS.intro, true),
                showHours: flag('showHours'), showContact: flag('showContact'), showAddress: flag('showAddress'),
            } };
        }
        case 'booking': {
            const kind = p.kind === 'table' || p.kind === 'consultation' || p.kind === 'class' ? p.kind : 'appointment';
            return { type: 'booking', props: {
                heading: textOrNull(p.heading, LIMITS.headline), intro: textOrNull(p.intro, LIMITS.intro, true), kind,
                serviceIds: [...new Set((Array.isArray(p.serviceIds) ? p.serviceIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50),
                askStaff: kind !== 'table' && kind !== 'class' && p.askStaff === true,
                buttonLabel: cleanText(p.buttonLabel, LIMITS.buttonLabel) || (kind === 'table' ? 'Find a table' : kind === 'class' ? 'See all dates' : 'Choose a time'),
            } };
        }
        case 'signup': {
            const id = Number(p.formId);
            return { type: 'signup', props: {
                heading: textOrNull(p.heading, LIMITS.headline),
                intro: textOrNull(p.intro, LIMITS.intro, true),
                formId: Number.isInteger(id) && id > 0 ? id : null,
                image: cleanImage(p.image, warn),
            } };
        }
        default:
            warn(`A section of an unknown kind was left out.`);
            return null;
    }
}

/** A section's look: a closed set of choices, so nothing here can become CSS. */
export const GRID_TYPES: readonly SectionType[] = ['features', 'steps', 'testimonials', 'products', 'menu', 'gallery', 'reviews'];
export function cleanLook(raw: unknown, type: SectionType): SectionLook {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const background = o.background === 'plain' || o.background === 'soft' || o.background === 'brand' ? o.background : 'auto';
    const cols = Number(o.columns);
    return {
        // The opening section already has its own layouts (centred / beside a picture / banner).
        background: type === 'hero' ? 'auto' : background,
        columns: GRID_TYPES.includes(type) && (cols === 2 || cols === 3) ? cols : 'auto',
        menuLabel: textOrNull(o.menuLabel, LIMITS.navLabel),
    };
}

// ── Theme and settings ──────────────────────────────────────────────────────────────────────

const FONTS: readonly FontKey[] = ['sans', 'serif', 'rounded', 'system'];
const RADII: readonly RadiusKey[] = ['none', 'small', 'medium', 'large'];
const BUSINESS_TYPES: readonly BusinessType[] = ['Organization', 'LocalBusiness', 'ProfessionalService', 'Store'];

export function cleanTheme(raw: unknown, warn: (m: string) => void, base: SiteTheme = DEFAULT_THEME): SiteTheme {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const colour = (v: unknown, fallback: string) => normalizeHex(typeof v === 'string' ? v : '') ?? fallback;
    let textColor = colour(t.textColor, base.textColor);
    let backgroundColor = colour(t.backgroundColor, base.backgroundColor);
    // Readable or nothing: an unreadable pair falls back to the defaults rather than shipping.
    if (contrastRatio(textColor, backgroundColor) < MIN_TEXT_CONTRAST) {
        warn('Those text and background colours are too hard to read together, so the defaults were kept.');
        textColor = DEFAULT_THEME.textColor;
        backgroundColor = DEFAULT_THEME.backgroundColor;
    }
    const logo = cleanHref(t.logoUrl);
    return {
        primaryColor: colour(t.primaryColor, base.primaryColor),
        textColor, backgroundColor,
        font: FONTS.includes(t.font as FontKey) ? (t.font as FontKey) : base.font,
        radius: RADII.includes(t.radius as RadiusKey) ? (t.radius as RadiusKey) : base.radius,
        logoUrl: logo && logo.startsWith('https://') ? logo : (t.logoUrl === null ? null : base.logoUrl),
        logoAssetId: t.logoAssetId === null ? null
            : Number.isInteger(Number(t.logoAssetId)) && Number(t.logoAssetId) > 0 ? Number(t.logoAssetId) : (base.logoAssetId ?? null),
    };
}

/** Every library picture the site uses (logo, hero pictures, product pictures). */
export function assetIdsIn(def: SiteDefinition): number[] {
    const ids = new Set<number>();
    if (def.theme.logoAssetId) ids.add(def.theme.logoAssetId);
    for (const p of def.pages) {
        for (const s of p.sections) {
            if ((s.type === 'hero' || s.type === 'text' || s.type === 'signup') && s.props.image?.assetId) ids.add(s.props.image.assetId);
            if (s.type === 'products') for (const it of s.props.items) if (it.image?.assetId) ids.add(it.image.assetId);
            if (s.type === 'gallery') for (const im of s.props.images) if (im.assetId) ids.add(im.assetId);
        }
    }
    return [...ids];
}

/** The same site with these library pictures taken out (they are not this workspace's to use). */
export function withoutAssets(def: SiteDefinition, drop: Set<number>): SiteDefinition {
    if (!drop.size) return def;
    const keep = <T extends { assetId?: number | null } | null>(img: T): T | null => (img && img.assetId && drop.has(img.assetId) ? null : img);
    return {
        ...def,
        theme: { ...def.theme, logoAssetId: def.theme.logoAssetId && drop.has(def.theme.logoAssetId) ? null : def.theme.logoAssetId ?? null },
        pages: def.pages.map((p) => ({ ...p, sections: p.sections.map((s) => {
            if (s.type === 'hero') return { ...s, props: { ...s.props, image: keep(s.props.image) } };
            if (s.type === 'text') return { ...s, props: { ...s.props, image: keep(s.props.image) } };
            if (s.type === 'signup') return { ...s, props: { ...s.props, image: keep(s.props.image) } };
            if (s.type === 'products') return { ...s, props: { ...s.props, items: s.props.items.map((it) => ({ ...it, image: keep(it.image) })) } };
            if (s.type === 'gallery') return { ...s, props: { ...s.props, images: s.props.images.filter((im) => keep(im)) } };
            return s;
        }) }))
            // A gallery left with no pictures is no gallery.
            .map((p) => ({ ...p, sections: p.sections.filter((s) => s.type !== 'gallery' || s.props.images.length) })),
    };
}

/** The colour a button's label must be on the primary colour — dark or light, whichever reads. */
export function buttonInk(theme: SiteTheme): string {
    return readableInkOn(theme.primaryColor);
}

function cleanSettings(raw: unknown, base?: SiteSettings): SiteSettings {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(s, k);
    const email = cleanText(s.email, LIMITS.email);
    const phone = cleanText(s.phone, LIMITS.phone);
    return {
        siteName: cleanText(s.siteName, LIMITS.siteName) || base?.siteName || 'My business',
        description: has('description') ? textOrNull(s.description, LIMITS.description) : base?.description ?? null,
        businessType: BUSINESS_TYPES.includes(s.businessType as BusinessType) ? (s.businessType as BusinessType) : base?.businessType ?? 'Organization',
        locality: has('locality') ? textOrNull(s.locality, LIMITS.locality) : base?.locality ?? null,
        email: has('email') ? (/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : null) : base?.email ?? null,
        phone: has('phone') ? (/^\+?[0-9 ()-]{5,30}$/.test(phone) ? phone : null) : base?.phone ?? null,
    };
}

// ── The gate ────────────────────────────────────────────────────────────────────────────────

export interface NormaliseOptions { maxPages?: number; }
export interface NormaliseResult { definition: SiteDefinition; warnings: string[]; }

/**
 * The ONE way a definition becomes trusted. Never throws, and always returns a site that renders:
 * an empty or broken input becomes a one-page starter. What it dropped or changed is in `warnings`,
 * in words a business owner can read.
 */
export function normaliseSiteDefinition(raw: unknown, opts: NormaliseOptions = {}): NormaliseResult {
    const warnings: string[] = [];
    const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
    const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const settings = cleanSettings(r.settings);
    const theme = cleanTheme(r.theme, warn);

    // Pages: ids unique and well-formed, slugs unique and not reserved, exactly one home.
    const usedPageIds = new Set<string>();
    const usedSlugs = new Set<string>();
    const pages: SitePageDef[] = [];
    let sectionCounter = 0;
    const usedSectionIds = new Set<string>();
    const nextSectionId = (want: unknown) => {
        if (typeof want === 'string' && ID_RE.test(want) && !usedSectionIds.has(want)) { usedSectionIds.add(want); return want; }
        let id: string;
        do { id = `s${++sectionCounter}`; } while (usedSectionIds.has(id));
        usedSectionIds.add(id);
        return id;
    };

    const rawPages = Array.isArray(r.pages) ? r.pages : [];
    for (const rp of rawPages) {
        const p = (rp && typeof rp === 'object' ? rp : {}) as Record<string, unknown>;
        const title = cleanText(p.title, LIMITS.pageTitle);
        if (!title) { warn('A page without a title was left out.'); continue; }
        let slug = p.slug === '' || p.slug === '/' ? '' : slugify(p.slug ?? title);
        if (slug && RESERVED_SLUGS.has(slug)) slug = `${slug}-page`;
        if (slug === '' && usedSlugs.has('')) slug = slugify(title) || 'page';   // a second "home" becomes a normal page
        let unique = slug; let n = 2;
        while (usedSlugs.has(unique)) unique = `${slug}-${n++}`;
        if (pages.length >= maxPages) { warn(`Your plan includes ${maxPages} page${maxPages === 1 ? '' : 's'}, so "${title}" was left out.`); continue; }
        let id = typeof p.id === 'string' && ID_RE.test(p.id) && !usedPageIds.has(p.id) ? p.id : '';
        if (!id) { let k = pages.length + 1; do { id = `p${k++}`; } while (usedPageIds.has(id)); }
        usedPageIds.add(id); usedSlugs.add(unique);

        const rawSections = Array.isArray(p.sections) ? p.sections : [];
        if (rawSections.length > LIMITS.sectionsPerPage) warn(`A page can have up to ${LIMITS.sectionsPerPage} sections; the rest were left out.`);
        const sections: Section[] = [];
        for (const rs of rawSections.slice(0, LIMITS.sectionsPerPage)) {
            const s = (rs && typeof rs === 'object' ? rs : {}) as Record<string, unknown>;
            const cleaned = cleanSection(s.type, s.props, warn);
            if (cleaned) sections.push({ id: nextSectionId(s.id), ...cleaned, look: cleanLook(s.look, cleaned.type) } as Section);
        }
        const seo = (p.seo && typeof p.seo === 'object' ? p.seo : {}) as Record<string, unknown>;
        pages.push({
            id, slug: unique, title,
            seo: { title: textOrNull(seo.title, LIMITS.seoTitle), description: textOrNull(seo.description, LIMITS.seoDescription) },
            sections,
            hideFromMenu: p.hideFromMenu === true,
        });
    }

    // Exactly one home page: the first page becomes home when none is.
    if (!pages.length) {
        pages.push({ id: 'p1', slug: '', title: 'Home', seo: { title: null, description: null }, hideFromMenu: false, sections: [
            { id: nextSectionId(null), type: 'hero', props: { layout: 'centered', eyebrow: null, headline: settings.siteName, subheadline: null, primaryCta: null, secondaryCta: null, image: null }, look: { ...DEFAULT_LOOK } },
        ] });
    } else if (!pages.some((p) => p.slug === '')) {
        usedSlugs.delete(pages[0].slug);
        pages[0].slug = '';
    }
    // Home first, so the menu and the sitemap start where a visitor does. The home page is always in the menu.
    pages.sort((a, b) => (a.slug === '' ? -1 : b.slug === '' ? 1 : 0));
    pages[0].hideFromMenu = false;

    // Internal links must point at a page that exists.
    const pagePaths = new Set(pages.map((p) => (p.slug ? `/${p.slug}` : '/')));
    const checkLink = (l: Link | null): Link | null => {
        if (!l || !l.href.startsWith('/')) return l;
        if (pagePaths.has(l.href)) return l;
        warn(`A button pointed at a page that doesn't exist (${l.href}), so it was removed.`);
        return null;
    };
    for (const page of pages) {
        page.sections = page.sections.flatMap((s): Section[] => {
            if (s.type === 'hero') return [{ ...s, props: { ...s.props, primaryCta: checkLink(s.props.primaryCta), secondaryCta: checkLink(s.props.secondaryCta) } }];
            if (s.type === 'cta') {
                const button = checkLink(s.props.button);
                if (!button) { warn('A call-to-action section was left out: its button pointed nowhere.'); return []; }
                return [{ ...s, props: { ...s.props, button } }];
            }
            return [s];
        });
    }

    // Navigation: only pages that exist, each once, at most LIMITS.navItems.
    const navSeen = new Set<string>();
    const nav = (Array.isArray(r.nav) ? r.nav : []).flatMap((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const pageId = typeof o.pageId === 'string' ? o.pageId : '';
        const page = pages.find((p) => p.id === pageId);
        if (!page || navSeen.has(pageId)) return [];
        navSeen.add(pageId);
        return [{ label: cleanText(o.label, LIMITS.navLabel) || page.title.slice(0, LIMITS.navLabel), pageId }];
    }).slice(0, LIMITS.navItems);

    const footer = { text: textOrNull((r.footer as Record<string, unknown> | undefined)?.text, LIMITS.footer, true) };

    const structure = r.structure === 'one_page' ? 'one_page' : 'pages';
    return { definition: { version: 1, theme, settings, nav, pages, footer, structure }, warnings };
}

/**
 * The menu a visitor sees. Several pages: the nav as set, or every page not hidden, in order.
 * One page: the home page's sections that have a menu label (links down the page), then any other
 * page not hidden. `pageId` is the page the entry belongs to; `sectionId` when it is a jump.
 */
export function menuOf(def: SiteDefinition): Array<{ label: string; path: string; pageId: string; sectionId?: string }> {
    const toPage = (p: SitePageDef, label?: string) => ({ label: (label || p.title).slice(0, LIMITS.navLabel), path: p.slug ? `/${p.slug}` : '/', pageId: p.id });
    if (def.structure === 'one_page') {
        const home = def.pages[0];
        const jumps = home ? home.sections.filter((s) => s.look?.menuLabel).map((s) => ({ label: s.look!.menuLabel!, path: `#${s.id}`, pageId: home.id, sectionId: s.id })) : [];
        const others = def.pages.slice(1).filter((p) => !p.hideFromMenu).map((p) => toPage(p));
        return [...jumps, ...others].slice(0, LIMITS.navItems);
    }
    const entries = def.nav.length ? def.nav : def.pages.filter((p) => !p.hideFromMenu).slice(0, LIMITS.navItems).map((p) => ({ label: p.title.slice(0, LIMITS.navLabel), pageId: p.id }));
    return entries.flatMap((n) => {
        const page = def.pages.find((p) => p.id === n.pageId);
        return page ? [toPage(page, n.label)] : [];
    });
}

// ── Operations (what the editor and the chat cards both send) ──────────────────────────────

export type SiteOperation =
    | { op: 'add_page'; title: string; slug?: string }
    | { op: 'update_page'; pageId: string; title?: string; slug?: string; seo?: { title?: string | null; description?: string | null }; hideFromMenu?: boolean }
    | { op: 'remove_page'; pageId: string }
    | { op: 'add_section'; pageId: string; section: { type: SectionType; props: unknown; look?: Partial<SectionLook> }; index?: number }
    | { op: 'update_section'; pageId: string; sectionId: string; props?: Record<string, unknown>; look?: Partial<SectionLook> }
    | { op: 'set_structure'; structure: 'pages' | 'one_page' }
    /** Every page's sections onto the home page, in page order; links to those pages become jumps. */
    | { op: 'combine_pages' }
    /** The reverse: the home page splits at each later section with a menu label, each part its own page. */
    | { op: 'split_pages' }
    | { op: 'remove_section'; pageId: string; sectionId: string }
    | { op: 'move_section'; pageId: string; sectionId: string; toIndex: number }
    | { op: 'set_nav'; items: Array<{ label?: string; pageId: string }> }
    | { op: 'set_theme'; theme: Partial<Record<keyof SiteTheme, unknown>> }
    | { op: 'set_settings'; settings: Partial<Record<keyof SiteSettings, unknown>> }
    | { op: 'set_footer'; text: string | null };

export type OperationResult = { ok: true; definition: SiteDefinition; warnings: string[] } | { ok: false; error: string };

/**
 * The gate's notes are written for a draft it tidied ("…was left out", "…the defaults were kept").
 * When the user's OWN change is refused, nothing changed — so say that instead.
 */
export function refusalFrom(note: string | undefined, fallback: string): string {
    if (!note) return fallback;
    if (/too hard to read/.test(note)) return 'Those text and background colours are too hard to read together, so nothing was changed. Try a darker text colour or a lighter background.';
    const m = /^An? [^:]*? was left out: (.*)$/.exec(note);
    return m ? `Not saved — ${m[1]}` : note;
}

/**
 * Apply one change, then re-run the gate. Refuses (with a sentence a person can act on) anything
 * that would silently do nothing or break a rule: removing the home page, a page over the plan's
 * cap, an id that doesn't exist, a section that would be dropped as invalid.
 */
export function applySiteOperation(def: SiteDefinition, op: SiteOperation, opts: NormaliseOptions = {}): OperationResult {
    const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
    const next: SiteDefinition = JSON.parse(JSON.stringify(def));
    const page = 'pageId' in op ? next.pages.find((p) => p.id === op.pageId) : undefined;
    if ('pageId' in op && !page) return { ok: false, error: 'That page no longer exists.' };
    const sectionIndex = page && 'sectionId' in op ? page.sections.findIndex((s) => s.id === op.sectionId) : -1;
    if ('sectionId' in op && sectionIndex < 0) return { ok: false, error: 'That section no longer exists.' };

    switch (op.op) {
        case 'add_page': {
            if (next.pages.length >= maxPages) return { ok: false, error: `Your plan includes ${maxPages} page${maxPages === 1 ? '' : 's'}, and this site has them all. Remove one, or move to a plan with more.` };
            const title = cleanText(op.title, LIMITS.pageTitle);
            if (!title) return { ok: false, error: 'A new page needs a title.' };
            next.pages.push({ id: '', slug: slugify(op.slug || title) || 'page', title, seo: { title: null, description: null }, sections: [], hideFromMenu: false });
            break;
        }
        case 'update_page': {
            if (op.title !== undefined) { const t = cleanText(op.title, LIMITS.pageTitle); if (!t) return { ok: false, error: 'A page needs a title.' }; page!.title = t; }
            if (op.slug !== undefined && page!.slug !== '') {
                const s = slugify(op.slug);
                if (!s) return { ok: false, error: 'That page address has no letters or numbers in it.' };
                if (next.pages.some((p) => p !== page && p.slug === s)) return { ok: false, error: `Another page already uses /${s}.` };
                page!.slug = s;
            }
            if (op.seo) page!.seo = { ...page!.seo, ...op.seo } as SitePageDef['seo'];
            if (op.hideFromMenu !== undefined) {
                if (page!.slug === '' && op.hideFromMenu) return { ok: false, error: 'The home page is always in the menu.' };
                page!.hideFromMenu = op.hideFromMenu === true;
            }
            break;
        }
        case 'remove_page': {
            if (page!.slug === '') return { ok: false, error: 'The home page can\'t be removed — every site needs one.' };
            next.pages = next.pages.filter((p) => p !== page);
            next.nav = next.nav.filter((n) => n.pageId !== op.pageId);
            break;
        }
        case 'add_section': {
            if (page!.sections.length >= LIMITS.sectionsPerPage) return { ok: false, error: `A page can have up to ${LIMITS.sectionsPerPage} sections.` };
            const why: string[] = [];
            const cleaned = cleanSection(op.section?.type, op.section?.props, (m) => why.push(m));
            if (!cleaned) return { ok: false, error: refusalFrom(why[0], 'That section isn\'t complete yet.') };
            const at = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index!, page!.sections.length)) : page!.sections.length;
            page!.sections.splice(at, 0, { id: '', ...cleaned, look: cleanLook(op.section?.look, cleaned.type) } as Section);
            break;
        }
        case 'update_section': {
            const current = page!.sections[sectionIndex];
            const why: string[] = [];
            const cleaned = cleanSection(current.type, { ...current.props, ...(op.props ?? {}) }, (m) => why.push(m));
            if (!cleaned) return { ok: false, error: refusalFrom(why[0], 'That change would leave the section incomplete.') };
            page!.sections[sectionIndex] = { id: current.id, ...cleaned, look: cleanLook({ ...(current.look ?? DEFAULT_LOOK), ...(op.look ?? {}) }, current.type) } as Section;
            break;
        }
        case 'remove_section': {
            page!.sections.splice(sectionIndex, 1);
            break;
        }
        case 'move_section': {
            const [s] = page!.sections.splice(sectionIndex, 1);
            const to = Math.max(0, Math.min(Number.isInteger(op.toIndex) ? op.toIndex : 0, page!.sections.length));
            page!.sections.splice(to, 0, s);
            break;
        }
        case 'set_nav': {
            next.nav = (Array.isArray(op.items) ? op.items : []).map((i) => ({ label: cleanText(i.label, LIMITS.navLabel), pageId: i.pageId }));
            break;
        }
        case 'set_theme': {
            const why: string[] = [];
            next.theme = cleanTheme({ ...next.theme, ...op.theme }, (m) => why.push(m), next.theme);
            if (why.length) return { ok: false, error: refusalFrom(why[0], 'That design change was not saved.') };
            break;
        }
        case 'set_settings': {
            next.settings = cleanSettings({ ...next.settings, ...op.settings }, next.settings);
            break;
        }
        case 'set_footer': {
            next.footer = { text: op.text };
            break;
        }
        case 'set_structure': {
            next.structure = op.structure === 'one_page' ? 'one_page' : 'pages';
            break;
        }
        case 'combine_pages': {
            const [home, ...rest] = next.pages;
            if (!rest.length) return { ok: false, error: 'Your site already has just one page.' };
            const total = next.pages.reduce((n, p) => n + p.sections.length, 0);
            if (total > LIMITS.sectionsPerPage) return { ok: false, error: `One page can hold up to ${LIMITS.sectionsPerPage} sections, and your pages have ${total} between them. Remove ${total - LIMITS.sectionsPerPage} first.` };
            // Each page's first section becomes its menu entry; links to a page become jumps to that section.
            const jumpTo = new Map<string, string>();
            for (const p of rest) {
                if (!p.sections.length) continue;
                const first = p.sections[0];
                first.look = { ...(first.look ?? DEFAULT_LOOK), menuLabel: first.look?.menuLabel || p.title.slice(0, LIMITS.navLabel) };
                jumpTo.set(`/${p.slug}`, `#${first.id}`);
                home.sections.push(...p.sections);
            }
            const fix = (l: Link | null): Link | null => (l && jumpTo.has(l.href) ? { ...l, href: jumpTo.get(l.href)! } : l);
            for (const sec of home.sections) {
                if (sec.type === 'hero') { sec.props.primaryCta = fix(sec.props.primaryCta); sec.props.secondaryCta = fix(sec.props.secondaryCta); }
                if (sec.type === 'cta') sec.props.button = fix(sec.props.button) ?? sec.props.button;
            }
            next.pages = [home];
            next.nav = [];
            next.structure = 'one_page';
            break;
        }
        case 'split_pages': {
            const [home, ...rest] = next.pages;
            // Home keeps everything up to the first LATER section with a menu label; each labelled
            // section then starts a page named by its label (what combine_pages gave it).
            const parts: Array<{ title: string; sections: Section[] }> = [];
            const keep: Section[] = [];
            home.sections.forEach((sec, i) => {
                const label = i > 0 ? sec.look?.menuLabel : null;
                if (label) parts.push({ title: label, sections: [sec] });
                else (parts.length ? parts[parts.length - 1].sections : keep).push(sec);
            });
            if (!parts.length) return { ok: false, error: 'There is nothing to split: no section further down your home page has a menu label. Add pages from the Pages list instead.' };
            if (1 + rest.length + parts.length > maxPages) return { ok: false, error: `That would make ${1 + rest.length + parts.length} pages, and your plan includes ${maxPages}. Remove a menu label from a section to keep it on the home page, or move to a plan with more pages.` };
            const taken = new Set(next.pages.map((p) => p.slug));
            const made = parts.map((part) => {
                const base = slugify(part.title) || 'page';
                let slug = RESERVED_SLUGS.has(base) ? `${base}-page` : base; let n = 2;
                while (taken.has(slug)) slug = `${base}-${n++}`;
                taken.add(slug);
                const first = part.sections[0];
                if (first.look?.menuLabel === part.title) first.look = { ...first.look, menuLabel: null };
                return { id: '', slug, title: part.title.slice(0, LIMITS.pageTitle), seo: { title: null, description: null }, sections: part.sections, hideFromMenu: false } as SitePageDef;
            });
            // Jumps down the page to a section that now lives on another page go to that page instead.
            const pageOf = new Map<string, string>();
            for (const pg of made) for (const sec of pg.sections) pageOf.set(`#${sec.id}`, `/${pg.slug}`);
            const fix = (l: Link | null): Link | null => (l && pageOf.has(l.href) ? { ...l, href: pageOf.get(l.href)! } : l);
            home.sections = keep;
            for (const pg of [home, ...made]) for (const sec of pg.sections) {
                if (sec.type === 'hero') { sec.props.primaryCta = fix(sec.props.primaryCta); sec.props.secondaryCta = fix(sec.props.secondaryCta); }
                if (sec.type === 'cta') sec.props.button = fix(sec.props.button) ?? sec.props.button;
            }
            next.pages = [home, ...made, ...rest];
            next.nav = [];
            next.structure = 'pages';
            break;
        }
        default:
            return { ok: false, error: 'Unknown change.' };
    }
    // New pages and sections get their ids from the gate; everything else is re-checked there.
    for (const p of next.pages) for (const s of p.sections) if (!s.id) (s as { id: unknown }).id = undefined;
    const { definition, warnings } = normaliseSiteDefinition(next, opts);
    return { ok: true, definition, warnings };
}
