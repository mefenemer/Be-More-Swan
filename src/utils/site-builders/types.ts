// src/utils/site-builders/types.ts — one adapter per website platform, used by the Website import
// (site-extract.ts readImportPage). Each platform's file is owned on its own (docs/site-import-platforms/):
// improve one platform without touching the others.
import type * as cheerio from 'cheerio';

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
