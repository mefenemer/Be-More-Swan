// src/utils/site-builders/lovable.ts — Website import adapter for Lovable (the AI app builder).
// Findings, what is covered and what is not: docs/site-import-platforms/lovable.md
// Tests: tests/site-platform-lovable.test.ts (fixtures in tests/fixtures/site-platforms/lovable/).
//
// Two shapes of Lovable site:
//   · the classic Vite + React + Tailwind + shadcn single-page app: the plain fetch is an empty
//     <div id="root"> (the import then renders it in headless Chrome, site-js-render.ts), every route
//     answers with the same shell, and the <head> keeps Lovable's defaults ("Lovable Generated
//     Project", author Lovable, lovable.dev's share picture, cdn.gpteng.co/gptengineer.js);
//   · newer TanStack Start projects, rendered on the server: the words are in the plain fetch, and
//     Lovable's hosting adds /~flock.js (analytics) and /__l5e/ ("l-ovabl-e") scripts — on custom
//     domains too.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/**
 * Markup only Lovable leaves: its hosting's scripts, its editor's script and tagger attributes, its
 * upload folder, its badge, and the defaults its starter template puts in <head>. Not the bare words
 * "lovable.dev" in text — a page that only mentions Lovable is not one.
 */
const LOVABLE_MARKUP = new RegExp([
    String.raw`["']/~flock\.js`,
    String.raw`["']/__l5e/`,
    String.raw`cdn\.gpteng\.co`,
    String.raw`gptengineer\.js`,
    String.raw`\bdata-lov-id=`,
    String.raw`/lovable-uploads/`,
    String.raw`id=["']lovable-badge`,
    String.raw`lovable\.dev/opengraph-image`,
    String.raw`content=["']@lovable_dev["']`,
    String.raw`content=["']Lovable Generated Project["']`,
    String.raw`<meta[^>]+name=["']author["'][^>]+content=["']Lovable["']`,
    String.raw`(?:href|src|content)=["']https?://[\w-]+\.lovable\.app\b`,
].join('|'), 'i');

/** What Lovable's starter puts in <head> until the owner changes it: not their words. */
const DEFAULT_DESCRIPTION = /^lovable generated project$/i;
/** The starter's titles: "Lovable App", the project's slug ("kiln-clover-pottery"), Vite's template name. */
const DEFAULT_TITLE = /^(?:lovable(?: app| project)?|vite[_ +-]react[\w +-]*)$/i;
const SLUG_TITLE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** Lovable's site bar: <nav class="fixed top-0 …"> (or sticky). */
const isTopBar = (cls: string) => /\b(fixed|sticky)\b/.test(cls) && /\btop-0\b/.test(cls);

/**
 * Inputs shadcn's <Input>/<Textarea> drew without a <form> around them (the page posts them with an
 * onClick): the smallest box holding two or more fields and a button. Wrapping it in a <form> lets the
 * import list the questions and keeps "Your name" / "Email" out of the page's words.
 */
function wrapLooseForms($: cheerio.CheerioAPI): void {
    const fields = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select';
    $('textarea, input[type="email"], input[type="tel"]').each((_, el) => {
        if ($(el).closest('form').length) return;
        let box = $(el).parent();
        for (let depth = 0; box.length && depth < 6; depth++, box = box.parent()) {
            const tag = box.get(0)?.type === 'tag' ? (box.get(0) as { name: string }).name : '';
            if (!tag || ['body', 'html', 'main', 'section', 'article'].includes(tag) || box.attr('id') === 'root') return;
            if (box.find('h1, h2').length || box.find(fields).length > 12) return;
            if (box.find(fields).length >= 2 && box.find('button, input[type="submit"]').length) {
                box.wrap('<form data-bms-loose-form=""></form>');
                return;
            }
        }
    });
}

export const adapter: BuilderAdapter = {
    key: 'lovable',
    label: 'Lovable',
    detect: (html) => LOVABLE_MARKUP.test(html),
    prepare($) {
        // Lovable's own furniture: the "Edit with Lovable" badge, and the two toast regions every
        // shadcn starter mounts (empty, but labelled "Notifications (F8)").
        $('#lovable-badge, [id^="lovable-badge"], a[href*="lovable.dev/projects/"], a[href*="utm_source=lovable-badge"]').remove();
        $('[role="region"][aria-label^="Notifications" i], section[aria-label^="Notifications" i], [data-sonner-toaster]').remove();
        // The starter's <head> defaults are not the owner's title or description.
        $('meta[name="description"], meta[property="og:description"]').each((_, m) => {
            if (DEFAULT_DESCRIPTION.test(($(m).attr('content') ?? '').trim())) $(m).remove();
        });
        $('title, meta[property="og:title"]').each((_, t) => {
            const v = (t.type === 'tag' && t.name === 'title' ? $(t).text() : $(t).attr('content') ?? '').trim();
            if (DEFAULT_TITLE.test(v) || SLUG_TITLE.test(v)) $(t).remove();
        });
        // The site's top bar is usually <nav class="fixed top-0 …"> with the logo inside, and no
        // <header>: wrapped in one, the import finds the logo the way it does on any other site.
        if (!$('header').length) {
            const bar = $('nav').filter((_, n) => !$(n).closest('footer').length && (isTopBar($(n).attr('class') ?? '') || $(n).closest('#root').length > 0)).first();
            if (bar.length && bar.find('img').length) bar.wrap('<header></header>');
        }
        wrapLooseForms($);
        // Testimonials are drawn as <p class="italic">"…"</p>: a quote, not a paragraph.
        $('p').each((_, p) => {
            const t = $(p).text().trim();
            if (t.length >= 30 && /^["“]/.test(t) && /["”]$/.test(t) && !$(p).children('a, button').length) {
                (p as { name: string }).name = 'blockquote';
            }
        });
    },
    // No contentRoot: the starter's pages are <div class="min-h-screen"> with no <main>, so the
    // shared fallback (body, minus nav/header/footer) is the right one.
    noise: /^(edit with( lovable)?×?|built (in|with) lovable\.?|made (in|with) lovable\.?|notifications \(f8\))$/i,
    fullSizeImage(src) {
        // Lovable's stock pictures come from Unsplash at ?w=800: ask for a size fit for a hero.
        try {
            const u = new URL(src);
            if (u.hostname === 'images.unsplash.com' && u.searchParams.has('w')) {
                const w = Number(u.searchParams.get('w'));
                if (w && w < 1600) {
                    u.searchParams.set('w', '1600');
                    u.searchParams.delete('h');
                }
                return u.toString();
            }
        } catch { /* not a URL */ }
        return null;
    },
    rendersWithJs: true,
};
