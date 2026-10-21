// src/utils/blog-share.ts
// Two things every public blog page gives its readers, server-side: a row of share buttons, and a
// placeholder plate where a post has no feature image.
//
// Used by the hosted permalink (blog-seo.ts renderBlogPage) and The Swan Index article
// (swan-index/render.ts). widget.js carries its own copy of both — it runs on customer sites and
// imports nothing — so keep the three in step (same networks, same order, same plate).
//
// Share links are plain <a href>s to each network's public share URL, so they work with JavaScript
// off. The script only adds "Copy link" and the device's own share sheet (navigator.share), and
// hides the latter where the browser has none.

// Its own escape rather than blog-seo's: blog-seo imports THIS module, and a cycle is one refactor
// away from an undefined import at load time.
function escHtml(v: unknown): string {
    return String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface ShareLink { key: 'linkedin' | 'facebook' | 'x' | 'email'; label: string; href: string }

/** The public share URL for each network. `url` must already be absolute. */
export function shareLinks(url: string, title: string): ShareLink[] {
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(title);
    return [
        { key: 'linkedin', label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
        { key: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
        { key: 'x', label: 'X', href: `https://twitter.com/intent/tweet?url=${u}&text=${t}` },
        { key: 'email', label: 'Email', href: `mailto:?subject=${t}&body=${u}` },
    ];
}

/**
 * The share row. Only http(s) URLs are shared: anything else renders nothing rather than a button
 * that copies a "javascript:" string onto someone's clipboard.
 */
export function shareBarHtml(url: string | null | undefined, title: string): string {
    if (!url || !/^https?:\/\//i.test(url)) return '';
    const links = shareLinks(url, title).map((l) =>
        `<a class="bms-share__btn" href="${escHtml(l.href)}"${l.key === 'email' ? '' : ' target="_blank" rel="noopener noreferrer"'}>${escHtml(l.label)}</a>`,
    ).join('');
    return `<div class="bms-share" data-share-url="${escHtml(url)}" data-share-title="${escHtml(title)}">`
        + `<span class="bms-share__label">Share this post</span>`
        + `<div class="bms-share__row">`
        + `<button type="button" class="bms-share__btn" data-share-native hidden>Share…</button>`
        + links
        + `<button type="button" class="bms-share__btn" data-share-copy>Copy link</button>`
        + `</div></div>`;
}

/** Inline script for the share row: Copy link + the native share sheet. No-op without a row. */
export const SHARE_SCRIPT = `<script>(function(){
  document.querySelectorAll('.bms-share').forEach(function(bar){
    var url = bar.getAttribute('data-share-url'), title = bar.getAttribute('data-share-title') || '';
    var nat = bar.querySelector('[data-share-native]');
    if (nat && navigator.share) {
      nat.hidden = false;
      nat.addEventListener('click', function(){ navigator.share({ title: title, url: url }).catch(function(){}); });
    }
    var copy = bar.querySelector('[data-share-copy]');
    if (copy) copy.addEventListener('click', function(){
      var done = function(){ copy.textContent = 'Link copied'; setTimeout(function(){ copy.textContent = 'Copy link'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function(){ window.prompt('Copy this link', url); });
      else window.prompt('Copy this link', url);
    });
  });
})();</script>`;

/** Base CSS for the share row; each page themes it with its own colours via the custom properties. */
export const SHARE_CSS = `
      .bms-share { margin: 2.5rem 0 0; padding-top: 1.25rem; border-top: 1px solid var(--share-rule, #e5e5e5); }
      .bms-share__label { display: block; font-size: .85rem; color: var(--share-muted, #666); margin: 0 0 .6rem; }
      .bms-share__row { display: flex; flex-wrap: wrap; gap: .5rem; }
      .bms-share__btn { font: inherit; font-size: .875rem; line-height: 1; padding: .55rem .9rem; border-radius: 999px;
        border: 1px solid var(--share-rule, #e5e5e5); background: none; color: inherit; text-decoration: none; cursor: pointer; }
      .bms-share__btn:hover, .bms-share__btn:focus-visible { border-color: currentColor; }`;
// No display rule on .bms-share__btn on purpose: the "Share…" button starts [hidden], and the UA's
// [hidden] rule only holds while nothing here sets display.

/**
 * The first letter or digit of a title, for the placeholder plate. Falls back to "✦" for a title
 * with neither (all emoji, say) — a plate must never be blank, or it reads as a failed image.
 */
export function plateInitial(title: string | null | undefined): string {
    const m = String(title || '').match(/[\p{L}\p{N}]/u);
    return m ? m[0].toUpperCase() : '✦';
}

/**
 * The placeholder where a post has no feature image: a soft tinted panel carrying the title's
 * initial. Decorative (aria-hidden) — the headline right beside it already says what it is.
 */
export function placeholderPlateHtml(title: string | null | undefined, className: string): string {
    return `<div class="${escHtml(className)} bms-plate" aria-hidden="true"><span>${escHtml(plateInitial(title))}</span></div>`;
}

export const PLATE_CSS = `
      .bms-plate { display: flex; align-items: center; justify-content: center; overflow: hidden;
        background: linear-gradient(135deg, var(--plate-a, #f9fafb) 0%, var(--plate-b, #e5e7eb) 100%); }
      .bms-plate span { font-size: clamp(2.5rem, 8vw, 5rem); font-weight: 700; line-height: 1; color: var(--plate-ink, #d6006e); opacity: .35; }`;
