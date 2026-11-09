// src/utils/site-builders/types.ts — one adapter per website platform, used by the Website import
// (site-extract.ts readImportPage). Each platform's file is owned on its own (docs/site-import-platforms/):
// improve one platform without touching the others.
import type * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * A product a shop's page shows: its name, the price as the page states it ("£28.00", "From €12"), its
 * page on their shop and its picture. Read for Business Information ▸ Products & Services only — prices
 * never go onto the hosted site.
 */
export interface ImportedProduct {
    name: string;
    price: string | null;
    href: string | null;
    image: string | null;
}

export interface BuilderAdapter {
    /** Short key, also the file name: 'wordpress', 'wix-studio'. */
    key: string;
    /** The platform's name as owners know it. */
    label: string;
    /**
     * Whether this page was made with this platform. `gen` is the lower-cased <meta name="generator">.
     * Cheap tests on the raw HTML; first match wins (index.ts lists the more specific ones first).
     */
    detect(html: string, gen: string, $: cheerio.CheerioAPI): boolean;
    /**
     * Tidy the page before it is read, on the parsed document: remove the platform's own furniture
     * (cookie bars, app widgets, duplicate mobile copies), unwrap content it hides, or expand content
     * it keeps in a script (JSON) into ordinary elements. Never fetches; never adds words of its own.
     */
    prepare?($: cheerio.CheerioAPI, url: URL | null): void;
    /**
     * The products this page shows (product cards, a product page), read from the page as it arrived —
     * before `prepare`. Absolute addresses. Never fetches. The import also reads schema.org Product data
     * on every page, so a platform only needs this for products shown without it.
     */
    products?($: cheerio.CheerioAPI, url: URL | null): ImportedProduct[];
    /**
     * Whether a menu link goes to a catalogue page (a shop category listing) rather than one of the
     * business's own pages. The import reads their own pages first and catalogue pages with what is left
     * of the page cap; the new site keeps their menu's order. `el` is the menu's <a>, after `prepare`.
     */
    catalogueLink?(href: string, el: cheerio.Cheerio<AnyNode>): boolean;
    /** A CSS selector for the page's own content, when the platform has a reliable one (else <main>/<body>). */
    contentRoot?: string;
    /** Lines the platform adds that are not the owner's words ("Powered by …", widget labels). */
    noise?: RegExp;
    /** A resized picture address → the full-size one (null = keep it). */
    fullSizeImage?(src: string): string | null;
    /**
     * True when this platform's pages draw their words with JavaScript, so the import should expect
     * to need the headless browser (site-js-render.ts) — used for the report's wording only.
     */
    rendersWithJs?: boolean;
}
