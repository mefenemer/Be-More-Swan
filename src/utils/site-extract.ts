// src/utils/site-extract.ts — read a web page into the structured summary the Mystery Shopper judges.
//
// docs/mystery-shopper-plan.md §4.3. The model never sees raw HTML: it sees this payload, and every
// "current text" it quotes back is checked against it (site-score.ts `isGrounded`). So this module
// decides what the assistant is ALLOWED to know about a page — keep it honest and keep it small.
//
// PURE: HTML string in, payload out. Fetching (safe-fetch.ts) and robots.txt (src/lib/robots.ts,
// CRAWLERS.mysteryShopper) live with the caller, so every rule here is testable against saved pages with no network
// (tests/site-extract.test.ts, fixtures in tests/fixtures/site-pages/).
//
// Three things this file is deliberately strict about:
//  1. The content hash covers what a BUYER sees first (title, H1, H2, CTAs, pricing, proof) — not
//     the whole body. A footer year, a cookie banner or a rotating blog teaser must not read as
//     "your site changed", because an unchanged hash is what lets a weekly run cost nothing.
//  2. A JavaScript-only page (an empty <div id="root">) is reported as `thin`, never scored as if it
//     were a real but bad page. What we saw is also what many AI crawlers see — that is the finding.
//  3. Lists are capped. A 400-item mega-menu must not crowd the hero out of the prompt.

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

export interface SiteCta {
    text: string;
    href: string | null;
}

export interface SiteLink {
    text: string;
    href: string;
}

export interface SitePage {
    url: string;
    https: boolean;
    wordCount: number;
    /** Too little server-rendered text to judge — usually a JavaScript-only site. */
    thin: boolean;
    seo: {
        title: string | null;
        description: string | null;
        ogTitle: string | null;
        ogImage: string | null;
        canonical: string | null;
        hasViewport: boolean;
        lang: string | null;
        noindex: boolean;
        /** Every schema.org @type found in JSON-LD (and microdata), de-duplicated. */
        schemaTypes: string[];
    };
    hero: {
        h1: string[];
        subheadline: string | null;
        /** Calls to action before the first H2 — what a visitor sees without scrolling far. */
        primaryCtas: SiteCta[];
    };
    structure: {
        h2: string[];
        h3: string[];
        ctas: SiteCta[];
        pricingSignals: string[];
        proofSnippets: string[];
        faqQuestions: string[];
        formCount: number;
        imageCount: number;
        imagesMissingAlt: number;
        internalLinks: SiteLink[];
    };
    /** Readable text in page order, capped — what the lenses read beyond the headings. */
    bodyExcerpt: string;
}

export const EXTRACT_LIMITS = {
    headings: 20,
    ctas: 20,
    primaryCtas: 6,
    pricing: 10,
    proof: 8,
    faq: 15,
    internalLinks: 60,
    snippet: 200,
    excerpt: 3500,
} as const;

/** Below this many words of server-rendered text there is nothing honest to score. */
export const THIN_WORDS = 60;

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
// Shortened at a word, never mid-word: the model reads "eating u…" as the SITE cutting a quote off,
// and the Mystery Shopper once told a customer their (complete) testimonials were truncated.
const cap = (s: string, n: number): string => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n - 1);
    const atWord = cut.replace(/\s+\S*$/, '');
    return `${(atWord.length >= n * 0.6 ? atWord : cut).trimEnd()}…`;
};
const orNull = (s: string): string | null => (s ? s : null);
// A pricing block shortened to the sentences that carry the price, not its first 120 characters: a
// paragraph that opens with a pitch and names the price later read as "The Workflow Saver…" with
// the price cut off (home page, 2026-10-27).
const pricingSignal = (b: string): string => {
    const sentences = b.split(/(?<=[.!?])\s+/);
    const priced = sentences.filter((x) => PRICE.test(x) || PRICING_PHRASES.test(x));
    return cap((priced.length ? priced : sentences).join(' '), 240);
};

/** Lower-cased, whitespace-collapsed, curly quotes straightened — the form two strings are compared in. */
export function normaliseText(s: string): string {
    return clean(s)
        .toLowerCase()
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...');
}

function dedupe(list: string[], limit: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
        const s = clean(raw);
        if (!s) continue;
        const k = normaliseText(s);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
        if (out.length >= limit) break;
    }
    return out;
}

// ── CTAs ──────────────────────────────────────────────────────────────────────────────────────

/** Calls to action that ask for nothing and promise nothing. Checked BEFORE the action verbs. */
const PASSIVE_CTA = /^(learn more|read more|find out more|more info(rmation)?|more|contact( us)?|get in touch|submit|send|click here|discover( more)?|explore( more)?|see more|view more|enquire( now)?|details|go)\b[\s!.→›»>-]*$/i;

/** Verbs that commit a visitor to a next step with an outcome. */
const ACTION_CTA = /\b(start|book|get|try|claim|join|buy|shop|order|download|request|schedule|call|see (your|how|pricing|plans)|calculate|sign ?up|subscribe|apply|reserve|register|grab|unlock|build|create|compare|check)\b/i;

export type CtaKind = 'outcome' | 'passive' | 'other';

/** How a call to action reads to a buyer. Pure, exported for the score and its tests. */
export function classifyCta(text: string): CtaKind {
    const t = clean(text);
    if (PASSIVE_CTA.test(t)) return 'passive';
    if (ACTION_CTA.test(t)) return 'outcome';
    return 'other';
}

const BUTTONISH = /(^|[\s_-])(btn|button|cta)([\s_-]|$)|w-button|sqs-block-button|elementor-button|wixui-button/i;

// ── Pricing, proof, FAQ ─────────────────────────────────────────────────────────────────────

const PRICE = /(?:£|\$|€)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|\+))?(?:\s?(?:\/|per|a)\s?(?:mo(?:nth)?|month|yr|year|annum|hr|hour|week|wk|day|session|person|user|seat))?/i;
const PRICING_PHRASES = /\b(free trial|cancel any ?time|no (setup|set-up) fee|money[- ]back|guarantee[d]?|no contract|pay as you go|from only|fixed price|no obligation|no hidden (?:fees?|costs?|charges?|tiers?))\b/i;
const PROOF_PHRASES = /(\b\d(\.\d)?\s?\/\s?5\b|★|\b\d[\d,]*\+?\s+(reviews|ratings|clients|customers|businesses|companies|users|projects|five-star)\b|\btrusted by\b|\bcase stud(y|ies)\b|\bas (seen|featured) (in|on)\b|\baward)/i;
const PROOF_CLASS = /testimonial|review|quote|rating|trust|case-stud/i;

/** Elements whose own text is a readable unit. Nested matches are skipped so text is not doubled. */
const TEXT_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,dt,dd,summary,figcaption';

// ── Main entry ───────────────────────────────────────────────────────────────────────────────

/** Read a page's HTML into the payload. `url` is the FINAL url after redirects. */
export function extractSitePage(html: string, url: string): SitePage {
    const $ = cheerio.load(html);
    const base = safeUrl(url);

    // Structured data is read before scripts are stripped — JSON-LD lives in a <script>.
    const schemaTypes = readSchemaTypes($);
    const faqFromSchema = readSchemaFaq($);

    $('script, style, noscript, template, svg, iframe').remove();

    const meta = (sel: string): string | null => orNull(clean($(sel).attr('content')));
    const robots = (meta('meta[name="robots"]') ?? '').toLowerCase();

    const root = $('main').length ? $('main').first() : $('body');
    // cheerio.load always builds a <body>, even for a fragment.
    const bodyEl = $('body').get(0);
    const bodyText = bodyEl ? blockText(bodyEl) : '';
    const wordCount = bodyText ? bodyText.split(' ').filter((w) => /[a-z0-9]/i.test(w)).length : 0;

    const headingTexts = (sel: string) => dedupe($(sel).map((_, el) => $(el).text()).get(), EXTRACT_LIMITS.headings);
    const h1 = headingTexts('h1').slice(0, 5);
    const h2 = headingTexts('h2');
    const h3 = headingTexts('h3');

    // Document order, so "before the first H2" and "after the H1" mean what a reader sees.
    const ordered = $('body *').toArray();
    const indexOf = new Map<AnyNode, number>();
    ordered.forEach((el, i) => indexOf.set(el, i));
    const firstH2 = $('h2').first().get(0);
    const heroEnd = firstH2 ? (indexOf.get(firstH2) ?? Infinity) : Infinity;

    // CTAs
    const ctas: Array<SiteCta & { at: number; inNav: boolean }> = [];
    $('a, button, input[type="submit"], input[type="button"]').each((_, el) => {
        const $el = $(el);
        const text = clean($el.text()) || clean($el.attr('aria-label')) || clean($el.attr('value'));
        if (text.length < 2 || text.length > 60) return;
        const cls = `${$el.attr('class') ?? ''} ${$el.attr('id') ?? ''}`;
        const buttonish = el.type === 'tag' && (el.name === 'button' || el.name === 'input') ||
            $el.attr('role') === 'button' || BUTTONISH.test(cls);
        const kind = classifyCta(text);
        if (!buttonish && kind !== 'outcome') return;
        const href = $el.attr('href');
        ctas.push({
            text,
            href: href ? absolutise(href, base) : null,
            at: indexOf.get(el) ?? Infinity,
            inNav: $el.closest('nav, footer').length > 0,
        });
    });
    const uniqueCtas = (list: typeof ctas, limit: number): SiteCta[] => {
        const seen = new Set<string>();
        const out: SiteCta[] = [];
        for (const c of list) {
            const k = normaliseText(c.text);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ text: c.text, href: c.href });
            if (out.length >= limit) break;
        }
        return out;
    };
    // A footer "Contact" button is not above the fold; a header "Book a call" button is.
    const primaryCtas = uniqueCtas(
        ctas.filter((c) => c.at < heroEnd && !($(ordered[c.at]).closest('footer').length)),
        EXTRACT_LIMITS.primaryCtas,
    );

    // Readable blocks in order — the excerpt, plus the pool pricing and proof are found in. A block
    // is an outermost text element (p, li, h2…) OR any other element carrying text of its own:
    // Webflow and Wix put prices and guarantees in bare <div>s, and missing those scored a page
    // with "£19/month · Cancel anytime" in its hero as having no risk reversal. Menus are skipped —
    // they are noise in the excerpt and never pricing or proof.
    const blocks: string[] = [];
    const taken = new Set<AnyNode>();
    const underTaken = (el: AnyNode): boolean => {
        for (let p = el.parent; p; p = p.parent) if (taken.has(p)) return true;
        return false;
    };
    const textBlockSet = new Set(TEXT_BLOCKS.split(','));
    root.find('*').each((_, el) => {
        if (el.type !== 'tag' || el.name === 'nav' || $(el).closest('nav').length) return;
        const ownText = el.children.some((c) => c.type === 'text' && /\S{2,}/.test((c as unknown as { data: string }).data));
        if (!textBlockSet.has(el.name) && !ownText) return;
        if (underTaken(el)) return;
        const t = blockText(el);
        if (!t) return;
        taken.add(el);
        blocks.push(t);
    });

    const pricing = dedupe(
        // A quoted testimonial that mentions "£4,200 saved" is proof, not a price.
        blocks.filter((b) => !/^["'\u201C\u2018]/.test(b) && (PRICE.test(b) || PRICING_PHRASES.test(b))).map(pricingSignal),
        EXTRACT_LIMITS.pricing,
    );

    // Proof containers: the TOPMOST element with a proof-ish class that is one testimonial — so a
    // quote and its attribution stay one snippet — descending only when it holds several (a slider
    // of testimonials, or a whole "reviews" section).
    const isProofEl = (el: AnyNode) => el.type === 'tag' && PROOF_CLASS.test($(el).attr('class') ?? '');
    const proofCandidates: string[] = [];
    const nextLevel = (el: AnyNode): AnyNode[] => {
        const out: AnyNode[] = [];
        const walk = (n: AnyNode) => {
            if (n.type !== 'tag') return;
            for (const c of n.children) {
                if (isProofEl(c)) out.push(c); else walk(c);
            }
        };
        walk(el);
        return out;
    };
    const takeProof = (el: AnyNode) => {
        const text = blockText(el);
        const inner = nextLevel(el).filter((c) => blockText(c).length >= 40);
        if (text.length > 320 || inner.length >= 2) {
            for (const c of nextLevel(el)) takeProof(c);
            return;
        }
        proofCandidates.push(text);
    };
    $('[class]').each((_, el) => {
        if (!isProofEl(el) || $(el).parents().toArray().some(isProofEl)) return;
        takeProof(el);
    });
    $('blockquote').each((_, el) => { proofCandidates.push(blockText(el)); });
    for (const b of blocks) if (PROOF_PHRASES.test(b)) proofCandidates.push(b);
    const proofSnippets = dropContained(
        dedupe(proofCandidates.map((p) => cap(p, EXTRACT_LIMITS.snippet)).filter((p) => p.length >= 8), 50),
    ).slice(0, EXTRACT_LIMITS.proof);

    const faqQuestions = dedupe(
        [
            ...faqFromSchema,
            ...$('h2, h3, h4, h5, summary, dt, button, strong')
                .map((_, el) => clean($(el).text()))
                .get()
                .filter((t) => t.endsWith('?') && t.length >= 8 && t.length <= 200),
        ],
        EXTRACT_LIMITS.faq,
    );

    // Subheadline: the first short paragraph or H2 after the H1.
    let subheadline: string | null = null;
    const firstH1 = $('h1').first().get(0);
    if (firstH1) {
        const from = indexOf.get(firstH1) ?? 0;
        for (let i = from + 1; i < Math.min(ordered.length, from + 60); i++) {
            const el = ordered[i];
            if (el.type !== 'tag' || !['p', 'h2', 'h3'].includes(el.name)) continue;
            const t = clean($(el).text());
            if (t.length >= 15 && t.length <= 300) { subheadline = t; break; }
        }
    }

    const internalLinks: SiteLink[] = [];
    const seenLinks = new Set<string>();
    $('a[href]').each((_, el) => {
        if (internalLinks.length >= EXTRACT_LIMITS.internalLinks) return;
        const href = absolutise($(el).attr('href') ?? '', base);
        if (!href || !base) return;
        let u: URL;
        try { u = new URL(href); } catch { return; }
        if (u.host !== base.host) return;
        u.hash = '';
        const key = u.toString();
        if (seenLinks.has(key) || key === base.toString()) return;
        seenLinks.add(key);
        internalLinks.push({ text: cap(clean($(el).text()) || clean($(el).attr('aria-label')), 80), href: key });
    });

    const images = $('img');
    const imagesMissingAlt = images.filter((_, el) => $(el).attr('alt') === undefined).length;

    return {
        url,
        https: base?.protocol === 'https:',
        wordCount,
        thin: wordCount < THIN_WORDS || (h1.length === 0 && wordCount < 150),
        seo: {
            title: orNull(clean($('title').first().text())),
            description: meta('meta[name="description"]'),
            ogTitle: meta('meta[property="og:title"]'),
            ogImage: meta('meta[property="og:image"]'),
            canonical: orNull(clean($('link[rel="canonical"]').attr('href'))),
            hasViewport: $('meta[name="viewport"]').length > 0,
            lang: orNull(clean($('html').attr('lang'))),
            noindex: /\bnoindex\b/.test(robots),
            schemaTypes: [...schemaTypes, ...readMicrodataTypes($)].filter((t, i, a) => a.indexOf(t) === i),
        },
        hero: { h1, subheadline, primaryCtas },
        structure: {
            h2,
            h3,
            ctas: uniqueCtas(ctas, EXTRACT_LIMITS.ctas),
            pricingSignals: pricing,
            proofSnippets,
            faqQuestions,
            formCount: $('form').length,
            imageCount: images.length,
            imagesMissingAlt,
            internalLinks,
        },
        bodyExcerpt: cap(blocks.join('\n'), EXTRACT_LIMITS.excerpt),
    };
}

/** Elements that start a new line when rendered — text either side of them must not run together. */
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'ol', 'p', 'section', 'summary', 'table',
    'td', 'th', 'tr', 'ul']);

/**
 * An element's text with a space wherever a block boundary was. cheerio's `.text()` concatenates
 * raw text nodes, which turned `<blockquote>"Great team!"</blockquote><figcaption>J. Smith` into
 * `"Great team!"J. Smith` — a quote the page never shows, which grounding would then reject.
 */
function blockText(node: AnyNode): string {
    const parts: string[] = [];
    const walk = (n: AnyNode) => {
        if (n.type === 'text') { parts.push((n as unknown as { data: string }).data); return; }
        if (n.type !== 'tag') return;
        const block = BLOCK_TAGS.has(n.name);
        if (block) parts.push(' ');
        for (const c of n.children) walk(c);
        if (block) parts.push(' ');
    };
    walk(node);
    return clean(parts.join(''));
}

/** Drop any snippet whose text sits wholly inside a longer one — the same testimonial found twice. */
function dropContained(list: string[]): string[] {
    const norm = list.map(normaliseText);
    return list.filter((_, i) => !norm.some((other, j) => j !== i && other.length > norm[i].length && other.includes(norm[i])));
}

// ── Structured data ─────────────────────────────────────────────────────────────────────────

function readJsonLd($: cheerio.CheerioAPI): unknown[] {
    const out: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try { out.push(JSON.parse($(el).text())); } catch { /* malformed JSON-LD is common; skip it */ }
    });
    return out;
}

function walkLd(node: unknown, visit: (obj: Record<string, unknown>) => void, depth = 0): void {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walkLd(n, visit, depth + 1)); return; }
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const v of Object.values(obj)) walkLd(v, visit, depth + 1);
}

function readSchemaTypes($: cheerio.CheerioAPI): string[] {
    const types: string[] = [];
    walkLd(readJsonLd($), (obj) => {
        const t = obj['@type'];
        for (const one of Array.isArray(t) ? t : [t]) {
            if (typeof one === 'string' && one && !types.includes(one)) types.push(one);
        }
    });
    return types;
}

function readSchemaFaq($: cheerio.CheerioAPI): string[] {
    const qs: string[] = [];
    walkLd(readJsonLd($), (obj) => {
        if (obj['@type'] === 'Question' && typeof obj.name === 'string') qs.push(obj.name);
    });
    return qs;
}

function readMicrodataTypes($: cheerio.CheerioAPI): string[] {
    return $('[itemtype]')
        .map((_, el) => ($(el).attr('itemtype') ?? '').split(/[\s/]+/).filter(Boolean).pop() ?? '')
        .get()
        .filter(Boolean);
}

// ── URLs ────────────────────────────────────────────────────────────────────────────────────

function safeUrl(u: string): URL | null {
    try { return new URL(u); } catch { return null; }
}

function absolutise(href: string, base: URL | null): string | null {
    const h = href.trim();
    if (!h || h.startsWith('#') || /^(javascript|data):/i.test(h)) return null;
    if (/^(mailto|tel):/i.test(h)) return h;   // a "Call us" button is a real CTA with no page behind it
    try { return base ? new URL(h, base).toString() : new URL(h).toString(); } catch { return null; }
}

/**
 * Up to two more pages worth reading on a competitor's site: pricing first, then about/services.
 * Same host only — a competitor's link to a review site is never followed (plan §3.6).
 */
export function pickSecondaryPages(page: SitePage, limit = 2): string[] {
    const want = [/\b(pricing|prices|plans|packages|rates|fees)\b/i, /\b(services|how[- ]it[- ]works|about|what[- ]we[- ]do)\b/i];
    const out: string[] = [];
    for (const re of want) {
        const hit = page.structure.internalLinks.find((l) => !out.includes(l.href) && (re.test(l.text) || re.test(new URL(l.href).pathname.replace(/[-_/]/g, ' '))));
        if (hit) out.push(hit.href);
        if (out.length >= limit) break;
    }
    return out;
}

// ── Change detection ────────────────────────────────────────────────────────────────────────

/**
 * What counts as "the page changed". Buyer-facing fields only (see the header, point 1), each
 * normalised, sets sorted — so reordering two testimonials is not a change.
 */
export function siteContentHash(page: SitePage): string {
    const norm = (xs: string[]) => xs.map(normaliseText).sort();
    const basis = {
        title: normaliseText(page.seo.title ?? ''),
        description: normaliseText(page.seo.description ?? ''),
        h1: norm(page.hero.h1),
        sub: normaliseText(page.hero.subheadline ?? ''),
        ctas: norm(page.hero.primaryCtas.map((c) => c.text)),
        h2: norm(page.structure.h2),
        pricing: norm(page.structure.pricingSignals),
        proof: norm(page.structure.proofSnippets),
        schema: [...page.seo.schemaTypes].sort(),
    };
    return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

export interface SiteChange {
    field: 'title' | 'description' | 'h1' | 'subheadline' | 'primary_cta' | 'h2' | 'pricing' | 'proof' | 'schema';
    kind: 'changed' | 'added' | 'removed';
    before?: string;
    after?: string;
}

const FIELD_LABEL: Record<SiteChange['field'], string> = {
    title: 'Page title', description: 'Search description', h1: 'Headline', subheadline: 'Subheadline',
    primary_cta: 'Main button', h2: 'Section heading', pricing: 'Pricing', proof: 'Proof', schema: 'Structured data',
};

/** Field-level differences between two reads of the same page. Computed in code — no model. */
export function diffSitePages(prev: SitePage, next: SitePage): SiteChange[] {
    const out: SiteChange[] = [];
    const single = (field: SiteChange['field'], a: string | null, b: string | null) => {
        const na = normaliseText(a ?? ''), nb = normaliseText(b ?? '');
        if (na === nb) return;
        if (!na) out.push({ field, kind: 'added', after: b ?? '' });
        else if (!nb) out.push({ field, kind: 'removed', before: a ?? '' });
        else out.push({ field, kind: 'changed', before: a ?? '', after: b ?? '' });
    };
    const set = (field: SiteChange['field'], a: string[], b: string[]) => {
        const na = new Map(a.map((x) => [normaliseText(x), x]));
        const nb = new Map(b.map((x) => [normaliseText(x), x]));
        // A single swap reads better as "changed from X to Y" than as one removal plus one addition.
        const removed = [...na.keys()].filter((k) => !nb.has(k));
        const added = [...nb.keys()].filter((k) => !na.has(k));
        if (removed.length === 1 && added.length === 1) {
            out.push({ field, kind: 'changed', before: na.get(removed[0]), after: nb.get(added[0]) });
            return;
        }
        for (const k of removed) out.push({ field, kind: 'removed', before: na.get(k) });
        for (const k of added) out.push({ field, kind: 'added', after: nb.get(k) });
    };
    single('title', prev.seo.title, next.seo.title);
    single('description', prev.seo.description, next.seo.description);
    set('h1', prev.hero.h1, next.hero.h1);
    single('subheadline', prev.hero.subheadline, next.hero.subheadline);
    set('primary_cta', prev.hero.primaryCtas.map((c) => c.text), next.hero.primaryCtas.map((c) => c.text));
    set('h2', prev.structure.h2, next.structure.h2);
    set('pricing', prev.structure.pricingSignals, next.structure.pricingSignals);
    set('proof', prev.structure.proofSnippets, next.structure.proofSnippets);
    set('schema', prev.seo.schemaTypes, next.seo.schemaTypes);
    return out;
}

/** One line per change, for notifications and the competitor radar. */
export function describeChanges(changes: SiteChange[]): string[] {
    return changes.map((c) => {
        const label = FIELD_LABEL[c.field];
        if (c.kind === 'changed') return `${label} changed from "${c.before}" to "${c.after}"`;
        if (c.kind === 'added') return `${label} added: "${c.after}"`;
        return `${label} removed: "${c.before}"`;
    });
}

// ── Import my current site (site-import.ts) ───────────────────────────────────────────────────
// A second reading of the same HTML, for a different job: not "what would a buyer judge" but "what
// is on this page, in order, so it can become sections of the owner's new site". Still PURE, still
// fed by the one fetcher (site-fetch.ts). It returns the page's own words and pictures as BLOCKS —
// never HTML or styles: nothing of the old site's markup can reach the new one.

export type ImportBlock =
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'item'; text: string }
    | { kind: 'quote'; text: string }
    | { kind: 'button'; text: string; href: string | null }
    | { kind: 'image'; src: string; alt: string; altFromSite: boolean };

export interface ImportPage {
    url: string;
    /** <title>, og:title — for the page's search title. */
    title: string | null;
    description: string | null;
    /** The site's menu, same host only, in menu order. */
    navLinks: SiteLink[];
    blocks: ImportBlock[];
    /** Words in the blocks (what was actually read). */
    words: number;
    contact: { emails: string[]; phones: string[]; address: string | null; locality: string | null };
    siteName: string | null;
    logo: { src: string; alt: string } | null;
    hasForm: boolean;
    /** Which builder made the page, from its generator tag or tell-tale markup. */
    builder: 'wix' | 'squarespace' | 'wordpress' | 'webflow' | 'square' | 'other';
}

export const IMPORT_LIMITS = { blocks: 160, images: 40, navLinks: 20 } as const;

/** Lines every builder adds that are not the owner's content (Wix's "top of page", cookie buttons…). */
const IMPORT_NOISE = /^(top of page|bottom of page|skip to (main )?content|use tab to navigate.*|powered by .*|created with .*|proudly created with .*|©.*|copyright\b.*|all rights reserved\.?|back to top|scroll( down)?|menu|close|open menu|search|log ?in|sign ?in|cart|basket|(view )?cart \(\d+\)|\d+ items?|accept( all)?( cookies)?|decline|reject( all)?|cookie (settings|policy|preferences)|manage (cookies|preferences)|share|tweet|pin it|previous|next|play video|0)$/i;

const PRICE_TEST = new RegExp(PRICE.source, 'i');
/** Whether a piece of text states a price. Prices live in Business Information, never on the site's text. */
export function statesPrice(text: string): boolean { return PRICE_TEST.test(text); }

/** A builder's resized picture → the original (Wix's /v1/fill/…, Squarespace's ?format=300w). */
export function fullSizeImageUrl(src: string): string {
    try {
        const u = new URL(src);
        if (/(^|\.)wixstatic\.com$/.test(u.hostname)) {
            // Wix serves any size of the original from one address; ask for a sensible one, not the camera's.
            const m = u.pathname.match(/^(\/media\/[^/]+)\/v1\/[a-z]+\/[^/]+\/(.+)$/);
            if (m) return `${u.origin}${m[1]}/v1/fit/w_1600,h_1600,q_85/${m[2]}`;
        }
        if (/squarespace-cdn\.com$/.test(u.hostname)) { u.searchParams.set('format', '1500w'); return u.toString(); }
        return u.toString();
    } catch { return src; }
}

function largestFromSrcset(srcset: string | undefined): string | null {
    if (!srcset) return null;
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(',')) {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) continue;
        const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
        if (!best || w > best.w) best = { url, w };
    }
    return best?.url ?? null;
}

/** A file name or "image" is not a description. */
function realAlt(alt: string | undefined): string {
    const a = clean(alt);
    if (!a || a.length < 3) return '';
    if (/\.(jpe?g|png|webp|gif|svg|heic)$/i.test(a) || /^(img|image|dsc|photo|pic|untitled|screenshot)[\s_-]?\d*$/i.test(a) || /^[\w-]{16,}$/.test(a)) return '';
    return a;
}

function detectBuilder(html: string, $: cheerio.CheerioAPI): ImportPage['builder'] {
    const gen = ($('meta[name="generator"]').attr('content') ?? '').toLowerCase();
    if (gen.includes('wix') || /static\.wixstatic\.com|wix-thunderbolt/.test(html)) return 'wix';
    if (gen.includes('squarespace') || /squarespace-cdn\.com|static1\.squarespace\.com/.test(html)) return 'squarespace';
    if (gen.includes('square online') || /editmysite\.com|square-online/.test(html)) return 'square';
    if (gen.includes('wordpress') || /\/wp-content\//.test(html)) return 'wordpress';
    if (gen.includes('webflow') || /webflow\.(js|css)|data-wf-page/.test(html)) return 'webflow';
    return 'other';
}

/** The owner's page as ordered blocks of their own words and pictures. `url` is the FINAL url. */
export function readImportPage(html: string, url: string): ImportPage {
    const $ = cheerio.load(html);
    const base = safeUrl(url);
    const builder = detectBuilder(html, $);

    // Facts from structured data, before scripts go.
    let siteName: string | null = null;
    let ldPhone: string | null = null;
    let ldEmail: string | null = null;
    let address: string | null = null;
    let locality: string | null = null;
    walkLd(readJsonLd($), (o) => {
        const t = String(Array.isArray(o['@type']) ? o['@type'][0] : o['@type'] ?? '');
        if (!siteName && typeof o.name === 'string' && t && !/^(WebPage|WebSite|BreadcrumbList|ListItem|Question|Answer|ImageObject|PostalAddress|Offer|Product|Review|Rating|AggregateRating|Person)$/.test(t)) siteName = clean(o.name);
        if (!ldPhone && typeof o.telephone === 'string') ldPhone = clean(o.telephone);
        if (!ldEmail && typeof o.email === 'string') ldEmail = clean(o.email).replace(/^mailto:/i, '');
        if (t === 'PostalAddress' && !address) {
            const parts = [o.streetAddress, o.addressLocality, o.addressRegion, o.postalCode].map((x) => (typeof x === 'string' ? clean(x) : '')).filter(Boolean);
            if (parts.length >= 2) address = parts.join(', ');
            if (typeof o.addressLocality === 'string') locality = clean(o.addressLocality) || null;
        }
    });
    siteName = siteName || orNull(clean($('meta[property="og:site_name"]').attr('content')));

    $('script, style, noscript, template, svg, iframe, link').remove();
    // Cookie and consent banners are the builder's, not the owner's.
    $('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]').remove();

    const emails = new Set<string>();
    const phones = new Set<string>();
    if (ldEmail) emails.add(ldEmail);
    if (ldPhone) phones.add(ldPhone);
    $('a[href^="mailto:" i]').each((_, el) => { const e = clean(($(el).attr('href') ?? '').slice(7).split('?')[0]); if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) emails.add(decodeURIComponent(e).toLowerCase()); });
    $('a[href^="tel:" i]').each((_, el) => {
        const p = clean(decodeURIComponent(($(el).attr('href') ?? '').slice(4)));
        // "01423 000000" and "01423000000" are one number.
        if (/\d{6,}/.test(p.replace(/\D/g, '')) && ![...phones].some((x) => x.replace(/\D/g, '') === p.replace(/\D/g, ''))) phones.add(p);
    });
    if (!address) {
        const a = clean($('address').first().text());
        if (a.length >= 8 && a.length <= 200) address = a;
    }

    // The menu: links in <nav> or the header, same host, in order.
    const navLinks: SiteLink[] = [];
    const seenNav = new Set<string>();
    $('nav a[href], header a[href], [role="navigation"] a[href]').each((_, el) => {
        if (navLinks.length >= IMPORT_LIMITS.navLinks) return;
        const href = absolutise($(el).attr('href') ?? '', base);
        if (!href || !base) return;
        let u: URL;
        try { u = new URL(href); } catch { return; }
        if (u.host.replace(/^www\./, '') !== base.host.replace(/^www\./, '')) return;
        u.hash = '';
        const key = u.toString();
        const text = clean($(el).text()) || clean($(el).attr('aria-label'));
        if (seenNav.has(key) || !text || text.length > 40) return;
        seenNav.add(key);
        navLinks.push({ text, href: key });
    });

    // The logo: the header's picture that says it is one, else the header's first picture.
    let logo: ImportPage['logo'] = null;
    const headerImgs = $('header img, [id*="header" i] img').toArray();
    const logoEl = headerImgs.find((el) => /logo/i.test(`${$(el).attr('class') ?? ''} ${$(el).attr('id') ?? ''} ${$(el).attr('alt') ?? ''} ${$(el).attr('src') ?? ''}`)) ?? headerImgs[0];
    if (logoEl) {
        const src = absolutise(largestFromSrcset($(logoEl).attr('srcset')) ?? $(logoEl).attr('src') ?? $(logoEl).attr('data-src') ?? '', base);
        if (src && /^https?:/.test(src)) logo = { src: fullSizeImageUrl(src), alt: realAlt($(logoEl).attr('alt')) || `${siteName ?? 'Business'} logo` };
    }

    const hasForm = $('form').length > 0;
    // The page's own content: no menus, header, footer or forms (a form's labels are not content).
    // A <header> inside the main content or an article is that page's own title area (WordPress puts
    // the H1 there), so only the SITE's header and footer go.
    $('header, footer').filter((_, el) => $(el).closest('main, article').length === 0).remove();
    $('nav, form, [role="navigation"], [role="banner"], [role="contentinfo"], #SITE_HEADER, #SITE_FOOTER').remove();
    const root = $('main').length ? $('main').first() : $('body');

    const blocks: ImportBlock[] = [];
    const seenText = new Set<string>();
    const seenImg = new Set<string>();
    let lastHeading: string | null = null;
    const addText = (kind: 'text' | 'item' | 'quote', raw: string) => {
        const text = clean(raw);
        if (!text || text.length < 2 || IMPORT_NOISE.test(text) || !/[a-z0-9]/i.test(text)) return;
        const k = normaliseText(text);
        if (seenText.has(k)) return;   // builders draw a block twice (desktop and phone layouts)
        seenText.add(k);
        blocks.push({ kind, text });
    };
    const addImage = (el: AnyNode) => {
        const $el = $(el);
        const w = Number($el.attr('width')), h = Number($el.attr('height'));
        if ((w && w < 80) || (h && h < 80)) return;   // icons and tracking pixels
        const raw = largestFromSrcset($el.attr('srcset') ?? $el.attr('data-srcset')) ?? $el.attr('data-src') ?? $el.attr('data-image') ?? $el.attr('src') ?? '';
        const abs = absolutise(raw, base);
        if (!abs || !/^https?:/.test(abs) || /\.svg(\?|$)/i.test(abs)) return;
        const src = fullSizeImageUrl(abs);
        if (seenImg.has(src) || seenImg.size >= IMPORT_LIMITS.images) return;
        seenImg.add(src);
        const alt = realAlt($el.attr('alt'));
        blocks.push({ kind: 'image', src, alt: alt || lastHeading || siteName || 'A picture from our website', altFromSite: !!alt });
    };
    const walk = (node: AnyNode) => {
        if (blocks.length >= IMPORT_LIMITS.blocks || node.type !== 'tag') return;
        const name = node.name;
        if (/^h[1-6]$/.test(name)) {
            const t = blockText(node);
            if (t && !IMPORT_NOISE.test(t) && /[a-z0-9]/i.test(t)) {
                const k = normaliseText(t);
                if (!seenText.has(k)) { seenText.add(k); blocks.push({ kind: 'heading', level: Number(name[1]), text: t }); }
                lastHeading = t.slice(0, LIMITS_ALT);
            }
            $(node).find('img').each((_, im) => addImage(im));
            return;
        }
        if (name === 'img') { addImage(node); return; }
        if (name === 'blockquote') { addText('quote', blockText(node)); return; }
        if (name === 'li') { addText('item', blockText(node)); $(node).find('img').each((_, im) => addImage(im)); return; }
        if (name === 'a' || name === 'button') {
            const $el = $(node);
            const text = clean($el.text()) || clean($el.attr('aria-label'));
            const cls = `${$el.attr('class') ?? ''} ${$el.attr('id') ?? ''}`;
            if (text && text.length <= 40 && (name === 'button' || $el.attr('role') === 'button' || BUTTONISH.test(cls))) {
                const href = absolutise($el.attr('href') ?? '', base);
                if (!IMPORT_NOISE.test(text)) blocks.push({ kind: 'button', text, href });
                $el.find('img').each((_, im) => addImage(im));
                return;
            }
        }
        const ownText = node.children.some((c) => c.type === 'text' && /\S{2,}/.test((c as unknown as { data: string }).data));
        const hasBlockChild = node.children.some((c) => c.type === 'tag' && (BLOCK_TAGS.has(c.name) || c.name === 'img'));
        if (['p', 'figcaption', 'dd', 'dt', 'td', 'th', 'summary'].includes(name) || (ownText && !hasBlockChild)) {
            addText('text', blockText(node));
            $(node).find('img').each((_, im) => addImage(im));
            return;
        }
        for (const c of node.children) walk(c);
    };
    for (const c of root.get(0)?.children ?? []) walk(c);

    const words = blocks.reduce((n, b) => n + (b.kind === 'image' ? 0 : b.text.split(' ').filter((w) => /[a-z0-9]/i.test(w)).length), 0);
    return {
        url,
        title: orNull(clean($('title').first().text())) ?? orNull(clean($('meta[property="og:title"]').attr('content'))),
        description: orNull(clean($('meta[name="description"]').attr('content'))),
        navLinks, blocks, words,
        contact: { emails: [...emails].slice(0, 3), phones: [...phones].slice(0, 3), address, locality },
        siteName, logo, hasForm, builder,
    };
}
const LIMITS_ALT = 150;
