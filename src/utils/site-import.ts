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

import type { ImportBlock, ImportPage, SiteLink } from './site-extract';
import { normaliseText, readImportPage, statesPrice } from './site-extract';
import {
    cleanHref, LIMITS, normaliseSiteDefinition, RESERVED_SLUGS, sectionAllowed, type SectionType, type SiteDefinition,
} from './site-definition';
import { chunkBodies } from './site-words';

/** Pages read at most (home + menu pages), before the plan's own page cap. */
export const IMPORT_MAX_PAGES = 8;
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
const SKIP_PATH = /\/(cart|basket|checkout|account|my-account|login|log-in|signin|sign-in|register|members?|search|privacy|privacy-policy|cookies?|cookie-policy|terms|terms-and-conditions|legal|accessibility|sitemap|feed|tag|category|author|wp-admin|wp-login)(\/|$)|\/(blog|news|post|posts|product|products|shop|store|events?)\/.+/i;
const FILE_PATH = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$/i;

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
        if (samePath(l.href, home.url) || u.pathname === '/' || FILE_PATH.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
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

export function buildImportPrompt(pages: ReadPage[], blocks: NumberedBlock[], opts: { siteName: string; pictures: PictureChoice; allowed: (t: SectionType) => boolean }): { system: string; user: string } {
    const shown = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s);
    const pageText = pages.map((p, i) => {
        const own = blocks.filter((b) => b.page === i);
        const label = p.menuLabel ? ` menu="${p.menuLabel}"` : '';
        return `<page number="${i + 1}" address="${new URL(p.url).pathname}"${label}>\n${own.map((b) => `[${b.n}] ${shown(describe(b.block))}`).join('\n') || '(nothing readable)'}\n</page>`;
    }).join('\n\n');
    const kinds = [
        '- {"type":"hero","headline":n,"subheadline":n|null,"button":n|null,"image":n|null}   (the opening of a page: its main heading and the line under it)',
        '- {"type":"text","heading":n|null,"body":[n,…],"image":n|null}   (paragraphs, or a short list, under one heading)',
        '- {"type":"features","heading":n|null,"items":[{"title":n,"body":[n]}]}   (a set of short titled points — services, reasons to choose them)',
        '- {"type":"steps","heading":n|null,"items":[{"title":n,"body":[n]}]}   (a numbered process: how it works)',
        opts.allowed('faq') ? '- {"type":"faq","heading":n|null,"items":[{"q":n,"a":[n]}]}   (questions and their answers)' : '',
        '- {"type":"testimonials","heading":n|null,"items":[{"quote":n,"name":n,"detail":n|null}]}   (ONLY quotes from customers that are on their site, with the customer\'s name block)',
        opts.pictures === 'copy' && opts.allowed('gallery') ? '- {"type":"gallery","heading":n|null,"images":[n,…]}   (a set of their pictures)' : '',
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
- "button" in a hero only for a button block.
- If unsure, use a "text" section in their order — never drop a block.
</rules>

<output>
{"pages":[{"page":1,"sections":[{"type":"hero","headline":1,"subheadline":2,"button":3,"image":4},{"type":"text","heading":5,"body":[6,7],"image":null}]}],"skip":[8]}
</output>`;
    return { system, user };
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

export type PlanSection =
    | { type: 'hero'; headline: number | null; subheadline: number | null; button: number | null; image: number | null }
    | { type: 'text'; heading: number | null; body: number[]; image: number | null }
    | { type: 'features' | 'steps'; heading: number | null; items: Array<{ title: number; body: number[] }> }
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
                case 'hero': sections.push({ type: 'hero', headline: num(s.headline), subheadline: num(s.subheadline), button: num(s.button), image: num(s.image) }); break;
                case 'text': sections.push({ type: 'text', heading, body: nums(s.body), image: num(s.image) }); break;
                case 'features': case 'steps':
                    sections.push({ type: s.type, heading, items: list(s.items).map((x) => ({ title: num(x.title) ?? 0, body: nums(x.body) })).filter((x) => x.title > 0) }); break;
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
        if (s.type === 'gallery') s.images.forEach(add);
    }
    return out;
}

// ── Building the draft from the owner's blocks ─────────────────────────────────────────────────

export interface ImportReport {
    sourceUrl: string;
    builder: ImportPage['builder'];
    /** Every page we tried, and how many of its words we read. */
    pages: Array<{ url: string; title: string; words: number; read: boolean; note: string | null }>;
    wordsRead: number;
    /** Menu pages beyond the plan's page cap — not imported. */
    notImported: Array<{ url: string; title: string }>;
    /** `undescribed`: copied pictures their old site gave no description, so we used the nearest heading — to check. */
    pictures: { choice: PictureChoice; found: number; copied: number; failed: number; undescribed: number };
    /** Words stating a price: left off the site, to be added in Business Information. */
    prices: string[];
    /** Blocks the plan called clutter — shown so the owner can see nothing important went. */
    leftOut: string[];
    /** Text that would not fit on its page (over the section limit). */
    notCarried: string[];
    contact: { email: string | null; phone: string | null; address: string | null };
    hadForm: boolean;
    placeholders: number;
}

export interface AssembleInput {
    current: SiteDefinition;
    pages: ReadPage[];
    blocks: NumberedBlock[];
    plan: ImportPlan | null;
    /** Picture block number → the library picture it was copied into. */
    assets: Map<number, number>;
    maxPages: number;
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
        try { if (new URL(href).host.replace(/^www\./, '') === new URL(pages[0].url).host.replace(/^www\./, '')) return null; } catch { return null; }
        return cleanHref(href);
    };

    const onPage = (n: number | null | undefined, page: number): NumberedBlock | null => {
        if (!n || n < 1 || n > blocks.length || used.has(n)) return null;
        const b = blocks[n - 1];
        return b.page === page ? b : null;
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
    /** List items run together as lines of one paragraph; everything else is its own paragraph. */
    const paragraphsOf = (ns: number[]): string[] => {
        const out: string[] = [];
        let prevItem = false;
        for (const n of ns) {
            const b = blocks[n - 1];
            if (!b || b.block.kind === 'image' || b.block.kind === 'button') continue;
            const t = b.block.text;
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
                const btnB = onPage(s.button, i);
                let primaryCta: { label: string; href: string } | null = null;
                if (btnB && btnB.block.kind === 'button') {
                    const href = mapHref(btnB.block.href);
                    if (href && btnB.block.text.length <= LIMITS.ctaLabel) { primaryCta = { label: btnB.block.text, href }; use(btnB.n); }
                }
                const img = image(s.image, i);
                if (headline) sections.push({ type: 'hero', props: { layout: img ? 'split' : 'centered', headline, subheadline: sub, primaryCta, image: img } });
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
                const items = s.items.map((it) => ({ title: text(it.title, i), body: takeParagraphs(it.body, i).join('\n\n') })).filter((x) => x.title) as Array<{ title: string; body: string }>;
                const max = s.type === 'steps' ? LIMITS.steps : LIMITS.features;
                const fits = items.length >= (s.type === 'steps' ? LIMITS.stepsMin : 1) && items.length <= max && (!heading || fitsHeading(heading))
                    && items.every((x) => x.title.length <= LIMITS.itemTitle && x.body.length <= LIMITS.itemBody);
                if (fits) sections.push({ type: s.type, props: { heading, items } });
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
            if (s.type === 'contact') {
                const heading = text(s.heading, i);
                const introB = blocks[(s.intro ?? 0) - 1];
                const intro = introB && introB.page === i && introB.block.kind !== 'image' && introB.block.kind !== 'button' && introB.block.text.length <= LIMITS.intro ? text(s.intro, i) : null;
                sections.push({ type: 'contact', props: { heading: fitsHeading(heading) ? heading : null, intro, askPhone: true, offerUpdates: false } });
                if (heading && !fitsHeading(heading)) sections.push(...textSections(null, [heading], null));
            }
        }

        // Nothing silently lost: every block the plan neither used nor called clutter, in their order,
        // grouped under its own headings.
        const left = blocks.filter((b) => b.page === i && !used.has(b.n) && !skip.has(b.n) && b.block.kind !== 'image' && b.block.kind !== 'button');
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

        // A page holds up to LIMITS.sectionsPerPage sections: what doesn't fit is listed, not dropped quietly.
        if (sections.length > LIMITS.sectionsPerPage) {
            for (const extra of sections.splice(LIMITS.sectionsPerPage)) {
                const words = [extra.props.heading, extra.props.body].filter((x) => typeof x === 'string' && x).join(' — ');
                if (words) notCarried.push(String(words).slice(0, 200));
            }
        }
        const fit = (s: string | null, n: number) => (s && s.length <= n ? s : null);
        return {
            title: pageTitle(p, i), slug: slugs[i],
            seo: { title: fit(p.page.title, LIMITS.seoTitle), description: fit(p.page.description, LIMITS.seoDescription) },
            sections,
        };
    });

    // An enquiry form, where their old site had a contact page — or a page of its own, when there is room.
    if (!outPages.some((p) => p.sections.some((s) => s.type === 'contact'))) {
        const contactPage = outPages.find((p) => CONTACT_PAGE.test(p.slug));
        const form = { type: 'contact', props: { heading: null, intro: null, askPhone: true, offerUpdates: false } };
        if (contactPage && contactPage.sections.length < LIMITS.sectionsPerPage) contactPage.sections.push(form);
        else if (outPages.length < input.maxPages) outPages.push({ title: 'Contact', slug: slugs.includes('contact') ? 'contact-us' : 'contact', seo: { title: null, description: null }, sections: [form] });
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
        },
        nav: [], footer: current.footer, structure: 'pages', pages: outPages,
    }, { maxPages: input.maxPages });

    const leftOut = [...skip].map((n) => blocks[n - 1]).filter((b) => b && b.block.kind !== 'image' && b.block.kind !== 'button').map((b) => (b.block as { text: string }).text.slice(0, 200));
    return { definition, leftOut, notCarried, warnings };
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
        for (const line of s.split(/\n+/)) {
            const t = normaliseText(line);
            if (t && !source.includes(t) && !extraAllowed.some((a) => normaliseText(a) === t) && !/^\[[^\]]+\]$/.test(t)) strays.push(line);
        }
    };
    for (const p of definition.pages) for (const s of p.sections) {
        const pr = s.props as unknown as Record<string, unknown>;
        for (const k of ['headline', 'subheadline', 'heading', 'intro', 'body']) check(pr[k]);
        if (Array.isArray(pr.items)) for (const it of pr.items as Array<Record<string, unknown>>) for (const k of ['title', 'body', 'q', 'a', 'quote', 'name', 'detail']) check(it[k]);
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
    /** The model's reply to the plan prompt, parsed — or null when it failed (the import still runs, unplanned). */
    plan(prompt: { system: string; user: string }): Promise<unknown | null>;
    /** Copy one picture into the workspace's library: its asset id, or null when it couldn't be copied. */
    savePicture(src: string, alt: string): Promise<number | null>;
}

export interface ImportInput { url: string; pictures: PictureChoice; current: SiteDefinition; maxPages: number; }

export type ImportOutcome =
    | { ok: true; definition: SiteDefinition; report: ImportReport; warnings: string[] }
    | { ok: false; message: string; report: ImportReport | null };

/** What we say when there is too little to import — honestly, and with the way round it. */
export function thinMessage(words: number, builder: ImportPage['builder']): string {
    const how = builder === 'square' || builder === 'other'
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
    const toRead = menu.slice(0, pageCap - 1);
    // Their contact page matters more than the last page that fits: it is where the enquiry form goes.
    const contactAt = menu.findIndex((l) => CONTACT_PAGE.test(new URL(l.href).pathname) || CONTACT_PAGE.test(l.text.toLowerCase()));
    if (contactAt >= pageCap - 1 && toRead.length) toRead[toRead.length - 1] = menu[contactAt];
    const homeLabel = homePage.navLinks.find((l) => samePath(l.href, homePage.url))?.text ?? null;

    const reports: ImportReport['pages'] = [{ url: homePage.url, title: homeLabel ?? 'Home', words: homePage.words, read: true, note: null }];
    const read: ReadPage[] = [{ url: homePage.url, menuLabel: homeLabel, page: homePage }];
    const fetched = await inTurns(toRead, 3, async (l) => ({ l, r: await readPage(l.href, deps) }));
    for (const { l, r } of fetched) {
        if (!r.ok) { reports.push({ url: l.href, title: l.text, words: 0, read: false, note: r.message }); continue; }
        const page = r.page;
        if (!page.words && !page.blocks.length) { reports.push({ url: l.href, title: l.text, words: 0, read: false, note: 'We couldn\'t read any words on this page.' }); continue; }
        reports.push({ url: page.url, title: l.text, words: page.words, read: true, note: null });
        read.push({ url: page.url, menuLabel: l.text, page });
    }
    const wordsRead = read.reduce((n, p) => n + p.page.words, 0);
    const baseReport = (): ImportReport => ({
        sourceUrl: input.url, builder: homePage.builder, pages: reports, wordsRead,
        notImported: menu.filter((l) => !toRead.includes(l)).map((l) => ({ url: l.href, title: l.text })),
        pictures: { choice: input.pictures, found: read.reduce((n, p) => n + p.page.blocks.filter((b) => b.kind === 'image').length, 0) + (homePage.logo ? 1 : 0), copied: 0, failed: 0, undescribed: 0 },
        prices: [], leftOut: [], notCarried: [], contact: importedContact(read), hadForm: read.some((p) => p.page.hasForm), placeholders: 0,
    });
    if (wordsRead < IMPORT_THIN_SITE_WORDS || (homePage.words < IMPORT_THIN_WORDS && read.length === 1)) {
        return { ok: false, message: thinMessage(wordsRead, homePage.builder), report: baseReport() };
    }

    const { blocks, prices } = numberBlocks(read);
    const allowed = (t: SectionType) => sectionAllowed(input.current.settings, t);
    let plan: ImportPlan | null = null;
    try { plan = readImportPlan(await deps.plan(buildImportPrompt(read, blocks, { siteName: input.current.settings.siteName, pictures: input.pictures, allowed }))); }
    catch { plan = null; }

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
    const built = assembleImport({ current: input.current, pages: read, blocks, plan, assets, maxPages: input.maxPages });
    let definition = built.definition;
    // Their logo, when the new site has none yet (a picture they chose to copy, like the rest).
    if (input.pictures === 'copy' && !definition.theme.logoUrl && !definition.theme.logoAssetId && homePage.logo) {
        const id = await deps.savePicture(homePage.logo.src, homePage.logo.alt).catch(() => null);
        if (id) {
            report.pictures.copied++;
            definition = normaliseSiteDefinition({ ...definition, theme: { ...definition.theme, logoAssetId: id } }, { maxPages: input.maxPages }).definition;
        }
    }
    report.leftOut = built.leftOut.slice(0, 60);
    report.notCarried = built.notCarried;
    report.placeholders = countPlaceholders(definition);
    return { ok: true, definition, report, warnings: built.warnings };
}

/**
 * One page: the plain read, and — when that found almost no words — the page again with its
 * JavaScript run. The rendered read is kept only when it found more words; the menu still comes from
 * whichever read had it (a JavaScript menu is read from the rendered page).
 */
async function readPage(url: string, deps: ImportDeps): Promise<{ ok: true; page: ImportPage } | { ok: false; message: string }> {
    const r = await deps.fetchHtml(url);
    if (!r.ok) return r;
    const page = readImportPageSafe(r.html, r.finalUrl);
    if (page.words >= IMPORT_THIN_WORDS || !deps.renderHtml) return { ok: true, page };
    const rendered = await deps.renderHtml(r.finalUrl).catch(() => null);
    if (!rendered?.ok) return { ok: true, page };
    const fuller = readImportPageSafe(rendered.html, r.finalUrl);
    if (fuller.words <= page.words) return { ok: true, page };
    return { ok: true, page: { ...fuller, navLinks: fuller.navLinks.length ? fuller.navLinks : page.navLinks } };
}

/** readImportPage, never throwing: a page cheerio can't make sense of reads as empty. */
function readImportPageSafe(html: string, url: string): ImportPage {
    try { return readImportPage(html, url); }
    catch { return { url, title: null, description: null, navLinks: [], blocks: [], words: 0, contact: { emails: [], phones: [], address: null, locality: null }, siteName: null, logo: null, hasForm: false, builder: 'other' }; }
}

function countPlaceholders(def: SiteDefinition): number {
    return (JSON.stringify(def.pages).match(/\[[^\][]{1,60}\]/g) ?? []).length;
}

