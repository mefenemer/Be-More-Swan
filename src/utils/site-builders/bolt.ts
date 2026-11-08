// src/utils/site-builders/bolt.ts — Website import adapter for Bolt.new (StackBlitz's AI app builder).
// Findings, what is covered and what is not: docs/site-import-platforms/bolt.md
// Tests: tests/site-platform-bolt.test.ts (fixtures in tests/fixtures/site-platforms/bolt/).
//
// A Bolt site is (almost always) a Vite + React + Tailwind single-page app: a plain fetch sees an empty
// <div id="root">, so its words come only from the headless browser (site-js-render.ts). Everything below
// works on that rendered page. Bolt Cloud (*.bolt.host, and Pro custom domains) adds two traces we can
// see in the HTML: its "Made in Bolt" badge script and its /__bolt/og-image route. A Bolt project
// published to Netlify or exported elsewhere carries neither, and is then just "a React app".
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Bolt Cloud's own markup: the badge script (free plan) and the share-picture route (every plan). */
const BOLT_CLOUD = /bolt\.new\/badge\.js|\/__bolt\/og-image/i;
/** The owner left a "Built with Bolt" link in, on a page that is a single-page app shell. */
const BOLT_LINK = /href=["']https?:\/\/(?:www\.)?bolt\.new\/?["']/i;
const SPA_ROOT = /<div id=["']root["']/i;

/** Tailwind's "only on small screens" classes: md:hidden etc. — the phone copy of something. */
const PHONE_ONLY = /(?:^|\s)(?:sm|md|lg|xl):hidden(?:\s|$)/;
/** Buttons that only work with the app's JavaScript (a basket, a wishlist, a menu). */
const APP_BUTTON = /^(add to (basket|cart|bag|wishlist|favourites|favorites)|remove from (basket|cart|bag|wishlist)|quick ?view|(add to )?wishlist|(open|close|toggle) (the )?menu|buy now|view (basket|cart|bag)|(dark|light) mode|toggle (theme|dark mode))$/i;

function isOutsideForm($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): boolean {
    return $(el).closest('form').length === 0;
}

export const adapter: BuilderAdapter = {
    key: 'bolt',
    label: 'Bolt.new',
    // Not "stackblitz": a developer's page that embeds a StackBlitz demo is not a Bolt site.
    detect: (html) => BOLT_CLOUD.test(html) || (BOLT_LINK.test(html) && SPA_ROOT.test(html)),
    rendersWithJs: true,
    prepare($) {
        // 1. The phone menu drawer. Bolt draws it as a fixed overlay beside (not inside) the <header>, so
        //    it survives the header's removal and its links, site name and "Close menu" read as content.
        //    Only phone-only boxes that are an overlay, or nothing but links and buttons, go: a phone-only
        //    paragraph of the owner's stays.
        $('[class]').filter((_, el) => PHONE_ONLY.test($(el).attr('class') ?? '')).each((_, el) => {
            const $el = $(el);
            if (!$el.parent().length) return;   // already gone with an ancestor
            const overlay = /(?:^|\s)fixed(?:\s|$)/.test($el.attr('class') ?? '');
            const prose = $el.find('h1, h2, h3, h4, h5, h6, p, li, blockquote').filter((_, x) => $(x).closest('a, button').length === 0).length > 0;
            if (overlay || !prose) $el.remove();
        });
        // 2. Buttons that only do something inside the app: icon-only buttons (a heart, a carousel arrow —
        //    their aria-label would read as a button) and basket / wishlist / menu buttons. A form's
        //    submit button is the form's and stays.
        $('button').each((_, el) => {
            if (!isOutsideForm($, el)) return;
            const $b = $(el);
            const text = $b.text().replace(/\s+/g, ' ').trim();
            if (!text || APP_BUTTON.test(text) || APP_BUTTON.test(($b.attr('aria-label') ?? '').trim())) $b.remove();
        });
        // 3. Decorative numbers laid over a card ("01", "02") — Tailwind absolute-positioned labels.
        $('span, div').filter((_, el) => /(?:^|\s)absolute(?:\s|$)/.test($(el).attr('class') ?? '') && /^\d{1,3}\.?$/.test($(el).text().trim())).remove();
        // 4. A call to action that jumps down the page (href="#contact") reads as plain text today
        //    (site-extract absolutise drops "#…"). Read it as the button it is, with no link of its own:
        //    the plan can place it, and it never lands on the page as a stray line.
        $('a[href^="#"]').each((_, el) => {
            const $a = $(el);
            if ($a.closest('nav, header, footer, [role="navigation"]').length) return;
            const text = $a.text().replace(/\s+/g, ' ').trim();
            if (!text || text.length > 40 || $a.find('h1, h2, h3, h4, h5, h6, p, img').length) return;
            // Inside a sentence it is an inline link: leave it to its paragraph.
            const parentText = $a.parent().text().replace(/\s+/g, ' ').trim();
            if (parentText.length > text.length + 2 && $a.parent().is('p, li, span')) return;
            const cls = $a.attr('class');
            $a.replaceWith($('<button type="button"></button>').attr(cls ? { class: cls } : {}).text(text));
        });
    },
    // The badge draws "Made in Bolt" inside a shadow root (never serialised by page.content()), but a
    // renderer that serialises shadow roots would show it.
    noise: /^(made in bolt|built with bolt(\.new)?|hide the made in bolt badge)$/i,
    // Bolt's prompts fill pictures with Pexels (and sometimes Unsplash) stock at a small ?w=. Ask the
    // same picture at a size worth putting on a page; the address stays the photo library's own.
    fullSizeImage(src) {
        let u: URL;
        try { u = new URL(src); } catch { return null; }
        const host = u.hostname.toLowerCase();
        if (host !== 'images.pexels.com' && host !== 'images.unsplash.com') return null;
        const w = Number(u.searchParams.get('w') ?? 0);
        for (const k of ['h', 'dpr']) u.searchParams.delete(k);
        if (host === 'images.pexels.com') u.searchParams.delete('fit');
        if (!w || w < 1600) u.searchParams.set('w', '1600');
        return u.toString();
    },
};
