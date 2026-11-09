// src/utils/site-builders/carrd.ts — Website import adapter for Carrd.
// Findings, what is covered and what is not: docs/site-import-platforms/carrd.md
// Tests: tests/site-platform-carrd.test.ts (fixtures in tests/fixtures/site-platforms/carrd/).
//
// A Carrd site is ONE server-rendered page. Its "sections" (<section id="about-section">) are all in the
// HTML; Carrd's script hides every one but the current one, and links to "#about" switch between them.
// So a plain read already sees every hidden section — the work here is the furniture around them.
import type { BuilderAdapter } from './types';

/** Carrd's two markups: classic (#wrapper > #main > .inner) and the newer component one (.site-main). */
const ROOT = '#main > .inner, .site-main > .inner';
/** Lists Carrd draws buttons and text links as (a <ul> of <li><a>), classic and component names. */
const BUTTON_LISTS = 'ul.buttons, ul.links, ul[class*="buttons-component"], ul[class*="links-component"]';
const ICON_LISTS = 'ul.icons, ul[class*="icons-component"]';
/** Carrd's own link kinds that mean nothing off Carrd (docs: Building → URL Types). */
const PSEUDO_HREF = /^(section|scrollpoint|browser|clipboard|copy|file):/i;

/** Cloudflare's email obfuscation (every Carrd-hosted site sits behind it): hex, first byte the key. */
function cfDecode(hex: string): string | null {
    if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

export const adapter: BuilderAdapter = {
    key: 'carrd',
    label: 'Carrd',
    detect: (html, gen, $) => {
        if (gen.includes('carrd')) return true;
        // Free sites: the "Made with Carrd" credit; any site on a carrd.co / crd.co address.
        if (/carrd\.com?\/build\?ref=|id="credits"[^>]*>[\s\S]{0,200}carrd\.com?/i.test(html)) return true;
        const own = `${$('meta[property="og:url"]').attr('content') ?? ''} ${$('link[rel="canonical"]').attr('href') ?? ''}`;
        if (/https?:\/\/[^/\s]+\.(carrd\.co|crd\.co)\b/i.test(own)) return true;
        // Pro sites on their own domain, no credit: Carrd's share picture plus its page skeleton.
        const card = /\/assets\/images\/card\.(jpe?g|png)/i.test($('meta[property="og:image"]').attr('content') ?? '');
        const skeleton = $('#wrapper > #main > .inner').length > 0 || $('.site-wrapper > .site-main > .inner').length > 0;
        const sections = $('section[id$="-section"]').length > 0 || /class="[^"]*-component instance-\d+/.test(html);
        return card && skeleton && sections;
    },
    contentRoot: ROOT,
    noise: /^\(?\s*made with carrd\s*\)?$/i,
    prepare($, url) {
        const page = url ? `${url.origin}${url.pathname}` : null;
        // Carrd's credit line.
        $('#credits, a[href*="carrd.co/build"], a[href*="carrd.com/build"]').remove();
        // Email links: Carrd percent-encodes mailto: addresses; Cloudflare swaps them for a hex token.
        $('a[href]').each((_, a) => {
            const $a = $(a);
            const href = ($a.attr('href') ?? '').trim();
            const cf = href.match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i);
            if (cf) { const e = cfDecode(cf[1]); if (e) $a.attr('href', `mailto:${e}`); else $a.removeAttr('href'); return; }
            if (/^mailto:/i.test(href) && /%[0-9a-f]{2}/i.test(href)) { try { $a.attr('href', decodeURI(href).replace(/%40/gi, '@')); } catch { /* keep */ } }
        });
        $('[data-cfemail]').each((_, el) => { const e = cfDecode($(el).attr('data-cfemail') ?? ''); if (e) $(el).replaceWith(e); });
        // Carrd-only link kinds (section:next, scrollpoint:first…) lead nowhere on another site.
        $('a[href]').filter((_, a) => PSEUDO_HREF.test(($(a).attr('href') ?? '').trim())).removeAttr('href');
        // Icon rows: arrows between sections ("Forward", "Rewind", "Home") are furniture; the rest are
        // their social profiles and email — kept for the contact read, then out of the content (a <footer>
        // is dropped from the content after the social links and contact details are read).
        $(ICON_LISTS).each((_, ul) => {
            const $ul = $(ul);
            $ul.find('li').filter((_, li) => { const h = ($(li).find('a').attr('href') ?? '').trim(); return !h || h.startsWith('#') || PSEUDO_HREF.test(h); }).remove();
            if (!$ul.find('a').length) { $ul.remove(); return; }
            $ul.wrap('<footer data-carrd-icons></footer>');
        });
        // Buttons and link rows are <ul><li><a>: read as list items, they lost their links. Each link
        // stands on its own instead, so it is read as a button.
        $(BUTTON_LISTS).each((_, ul) => {
            const $ul = $(ul);
            if ($ul.closest('header').length) return;   // the static header's menu (section links)
            const div = $('<div data-carrd-buttons></div>');
            $ul.find('li > a').each((_, a) => { div.append($(a)); });
            $ul.replaceWith(div);
        });
        // A link to a section ("#contact") is a link to the one page: point it at the page itself, so the
        // import keeps the button (to the new home page) instead of dropping a link it cannot follow.
        if (page) {
            $('a[href^="#"]').each((_, a) => {
                const $a = $(a);
                if ($a.closest('header, nav').length) return;
                const name = ($a.attr('href') ?? '').slice(1);
                if (/^[a-z0-9-]*$/i.test(name)) $a.attr('href', name && name !== 'home' ? `${page}#${name}` : page);
            });
        }
        // Carrd's footer is elements the owner placed (their address, a closing line), inside the page's
        // own column — read it like the rest. The icon <footer>s inside it still go.
        $(`${ROOT.split(',').map((r) => `${r.trim()} > footer#footer`).join(', ')}`).each((_, f) => { (f as { name: string }).name = 'div'; });
    },
};
