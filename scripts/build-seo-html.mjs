/**
 * Build-time HTML post-processing for crawlers. Runs from netlify.toml's build command,
 * IN THE DEPLOY CONTAINER, against a fresh checkout — the transformed HTML is published but
 * never committed. Source files keep the runtime-fetch behaviour so local dev is unchanged.
 *
 * Two jobs, both of the same shape: take something that today only exists after JavaScript
 * runs, and make it exist in the served HTML instead.
 *
 *   1. Inline components/footer.html into the indexable marketing pages.
 *   2. Generate FAQPage JSON-LD for faq.html from the questions actually rendered on it.
 *
 * ── Why cheerio only ever READS ────────────────────────────────────────────────
 * cheerio re-serialises whatever it parses. Running eleven hand-written, heavily-commented
 * pages through a parse/serialise round trip rewrites attribute quoting, self-closing tags and
 * whitespace across the whole document — an enormous diff in which a real change is invisible.
 * So faq.html is parsed read-only to extract text, and every WRITE below is a targeted string
 * replacement against an explicit marker. Nothing else in the file is touched.
 *
 * ── Why markers ────────────────────────────────────────────────────────────────
 * Every injection is wrapped in BUILD:x / /BUILD:x comments and re-running replaces the region
 * rather than appending to it. The script is therefore idempotent: safe to run twice locally,
 * and safe if a deploy retries. It also means that if someone DOES run this locally and commit
 * the result, the next run produces a stable diff instead of nesting copies.
 *
 * ── Fail loud ──────────────────────────────────────────────────────────────────
 * Every replacement asserts that it actually matched. A silently-skipped injection would ship a
 * page that looks fine in review and is missing its structured data in production, which is the
 * single worst outcome here — so a miss is a non-zero exit, not a warning.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://bemoreswan.com';

/**
 * Pages that get the footer inlined: the indexable marketing set from netlify.toml, intersected
 * with the pages that actually use the shared footer component.
 *
 * Deliberately NOT every page carrying #footer-placeholder. The onboarding wizards, dashboard,
 * logout and check-email all use it too, but they are noindex — inlining there would grow the
 * published diff for pages no crawler reads. help.html has no footer and licenses.html has its
 * own minimal one; neither uses the component, so neither appears here.
 */
const FOOTER_PAGES = [
    'index.html',
    'about.html',
    'blog.html',
    'pricing.html',
    'assistants.html',
    'faq.html',
    'trust.html',
    'contact.html',
    'register.html',
    'privacy.html',
    'terms_of_service.html',
    'data-deletion.html',
];

let failures = 0;
const log = (msg) => console.log(`[build-seo-html] ${msg}`);
const fail = (msg) => { console.error(`[build-seo-html] ERROR: ${msg}`); failures++; };

// Content baked in by Jobs 3 and 4 is authored in Admin, not by a visitor — but it still lands
// in HTML, so it is escaped rather than trusted. escAttr additionally covers the quote styles
// an attribute value can break out of.
const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Replace the region between `<!-- BUILD:name -->` and `<!-- /BUILD:name -->` if it exists,
 * otherwise insert a fresh marked region using `insert`, which receives the marked block.
 */
function injectMarked(html, name, payload, insert) {
    const open = `<!-- BUILD:${name} -->`;
    const close = `<!-- /BUILD:${name} -->`;
    const block = `${open}\n${payload}\n${close}`;

    const start = html.indexOf(open);
    if (start !== -1) {
        const end = html.indexOf(close, start);
        if (end === -1) return { html, ok: false, reason: `unclosed ${open}` };
        return { html: html.slice(0, start) + block + html.slice(end + close.length), ok: true };
    }
    return insert(html, block);
}

// ── Job 1: inline the shared footer ────────────────────────────────────────────
//
// The footer carries the site's internal-link block. Today it arrives only after a fetch on
// DOMContentLoaded, so anything that does not execute JavaScript — plenty of crawlers and most
// LLM scrapers — sees an empty <div> where the site's link graph should be.
//
// Inlining also fixes a latent bug nobody had noticed: the footer ships a <script> that syncs
// the language selector, and scripts injected via innerHTML DO NOT EXECUTE. That script has
// therefore never run on any page using loadComponent. Parser-inserted, it runs normally.
function inlineFooters() {
    const footerPath = join(ROOT, 'components', 'footer.html');
    if (!existsSync(footerPath)) return fail('components/footer.html not found');
    const footer = readFileSync(footerPath, 'utf8').trim();

    for (const page of FOOTER_PAGES) {
        const path = join(ROOT, page);
        if (!existsSync(path)) { fail(`${page} not found`); continue; }

        let html = readFileSync(path, 'utf8');
        const before = html;

        // 1a. Fill the placeholder.
        const res = injectMarked(html, 'FOOTER', footer, (h, block) => {
            // Match the empty placeholder in whatever attribute order the page happens to use.
            const re = /(<div\b[^>]*\bid=["']footer-placeholder["'][^>]*>)(\s*)(<\/div>)/i;
            if (!re.test(h)) return { html: h, ok: false, reason: 'no #footer-placeholder' };
            return { html: h.replace(re, `$1\n${block}\n$3`), ok: true };
        });
        if (!res.ok) { fail(`${page}: ${res.reason}`); continue; }
        html = res.html;

        // 1b. Stop the runtime fetch from re-fetching and clobbering what we just inlined.
        //     Identical markup, so replacing it is invisible — but it is a wasted request, and
        //     the replacement re-inserts the footer's <script> in the non-executing form,
        //     undoing 1a's incidental fix. Neutralise the call instead of deleting the line,
        //     so the built file still shows a reader what happened.
        const callRe = /(^[ \t]*)loadComponent\((["'])footer-placeholder\2\s*,\s*(["'])\.\/components\/footer\.html\3\s*\);?/m;
        if (callRe.test(html)) {
            html = html.replace(
                callRe,
                `$1/* BUILD:FOOTER-INLINED — footer is injected into the HTML at build time by\n` +
                `$1   scripts/build-seo-html.mjs, so the runtime fetch is skipped here. In an\n` +
                `$1   unbuilt checkout this line is a live loadComponent() call. */`,
            );
        } else if (!html.includes('BUILD:FOOTER-INLINED')) {
            // No live call AND no record of having neutralised one. powered-by.html loads its
            // fragments through a different loop and is not in FOOTER_PAGES, so reaching here
            // means a page's loader changed shape and the runtime fetch would clobber the inline.
            fail(`${page}: footer inlined but the loadComponent call site did not match — ` +
                 `the runtime fetch will overwrite the inlined footer`);
            continue;
        }
        // else: already neutralised by an earlier run. Not an error — see the idempotency note
        // in the header. Byte-identical output on a re-run is the CORRECT result here, so this
        // must not be treated as "nothing happened".

        writeFileSync(path, html);
        log(html === before ? `footer already inlined → ${page}` : `footer inlined → ${page}`);
    }
}

// ── Job 2: FAQPage JSON-LD ─────────────────────────────────────────────────────
//
// Generated, never hand-written. Google requires FAQPage markup to match the content visible
// on the page; a hand-maintained copy of ~50 answers drifts from the rendered copy the first
// time someone edits one and forgets the other, and drift here is a structured-data penalty
// rather than a cosmetic bug. Extracting from the DOM makes that class of mistake impossible.
//
// Answers are emitted as PLAIN TEXT. schema.org permits a subset of HTML in acceptedAnswer,
// but the answers here contain links and <strong> whose only purpose is on-page styling, and
// plain text sidesteps a whole category of escaping problems for no loss of meaning.
function buildFaqJsonLd() {
    const path = join(ROOT, 'faq.html');
    if (!existsSync(path)) return fail('faq.html not found');

    let html = readFileSync(path, 'utf8');
    const $ = cheerio.load(html);            // READ ONLY — see the header note.

    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const entries = [];

    $('details').each((_, el) => {
        const $el = $(el);
        // The chevron <svg> lives inside <summary>; take the <span> that holds the question.
        const q = norm($el.find('summary span').first().text());
        // The answer is the first element sibling of <summary> inside <details>.
        const a = norm($el.children().not('summary').first().text());
        if (q && a) entries.push({ q, a });
    });

    if (entries.length === 0) return fail('faq.html: no <details> Q&A pairs found');

    const seen = new Set();
    const unique = entries.filter(({ q }) => {
        const key = q.toLowerCase();
        if (seen.has(key)) { log(`WARNING duplicate question dropped: "${q}"`); return false; }
        seen.add(key);
        return true;
    });

    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        '@id': `${SITE_ORIGIN}/faq#faq`,
        isPartOf: { '@type': 'WebSite', url: `${SITE_ORIGIN}/` },
        publisher: { '@id': `${SITE_ORIGIN}/#organization` },
        mainEntity: unique.map(({ q, a }) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
        })),
    };

    const payload =
        '    <!-- Generated by scripts/build-seo-html.mjs from the questions rendered on this\n' +
        '         page. Do not edit by hand: edit the <details> blocks below and rebuild, or the\n' +
        '         markup stops matching the visible copy that Google requires it to match. -->\n' +
        '    <script type="application/ld+json">\n' +
        JSON.stringify(jsonLd, null, 2).split('\n').map((l) => '    ' + l).join('\n') +
        '\n    </script>';

    const res = injectMarked(html, 'FAQ-JSONLD', payload, (h, block) => {
        if (!/<\/head>/i.test(h)) return { html: h, ok: false, reason: 'no </head>' };
        return { html: h.replace(/<\/head>/i, `${block}\n</head>`), ok: true };
    });
    if (!res.ok) return fail(`faq.html: ${res.reason}`);

    writeFileSync(path, res.html);
    log(`FAQPage JSON-LD → faq.html (${unique.length} questions)`);
}

// ── Build-time content fetch ───────────────────────────────────────────────────
//
// Jobs 3 and 4 differ from 1 and 2 in one important way: their content lives in the DATABASE,
// not in a file in this checkout. `node` cannot import db/client.ts, so the content comes over
// HTTP from the PUBLIC read endpoints on the currently-live deploy. Both are unauthenticated
// and already serve exactly this data to the browser.
//
// That makes the build depend on prod being reachable. The trade-off is deliberate:
//   · A silently-skipped injection ships a page whose content vanished — the outcome the
//     header calls the worst one here. So the default is to FAIL the build.
//   · But a transient blip must not block a hotfix deploy, so SEO_ALLOW_STALE=1 downgrades a
//     fetch failure to a warning and publishes the page without its baked content.
//
// A branch deploy fetches from prod too. Content is the same marketing/help copy either way,
// and branch deploys are not indexed, so this is not worth plumbing a second origin for.
const ALLOW_STALE = process.env.SEO_ALLOW_STALE === '1';

async function fetchJson(url, { attempts = 3, timeoutMs = 10_000 } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(timeoutMs),
                headers: { accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            lastErr = err;
            if (i < attempts) log(`fetch ${url} failed (${err.message}) — retry ${i}/${attempts - 1}`);
        }
    }
    throw new Error(`${url}: ${lastErr?.message || 'unknown error'}`);
}

// A fetch failure is fatal unless SEO_ALLOW_STALE=1. Returns null when tolerated.
function handleFetchFailure(job, err) {
    if (ALLOW_STALE) {
        log(`WARNING ${job}: ${err.message} — SEO_ALLOW_STALE=1, publishing without baked content`);
        return null;
    }
    fail(`${job}: ${err.message}\n` +
         `          The page would publish with no crawlable content. If this is an outage and\n` +
         `          you need to deploy anyway, re-run with SEO_ALLOW_STALE=1.`);
    return null;
}

// ── Job 3: crawlable blog post list ────────────────────────────────────────────
//
// blog.html mounts widget.js on #bms-blog, and widget.js calls attachShadow() on that element.
// A shadow root REPLACES the light DOM for rendering, so anything we put inside #bms-blog is
// invisible to a visitor with JavaScript and fully visible to one without — which is exactly
// the split we want. No duplicate list, no cleanup script, no flash of unstyled content.
//
// What this fixes: the posts at /blog/:slug are real server-rendered pages (blog-page.ts) and
// have been all along, but the ONLY thing linking to them was a client-rendered widget. To a
// crawler the blog index was a dead end, and the posts were reachable only from the per-blog
// sitemap — a discovery path weak enough to leave them uncrawled.
async function inlineBlogPosts() {
    const path = join(ROOT, 'blog.html');
    if (!existsSync(path)) return fail('blog.html not found');
    let html = readFileSync(path, 'utf8');

    // Single source of truth: the key the page already ships to the widget.
    const keyMatch = html.match(/BMS_BLOG_WIDGET_KEY\s*=\s*['"]([^'"]+)['"]/);
    if (!keyMatch) return fail('blog.html: BMS_BLOG_WIDGET_KEY not found');
    const key = keyMatch[1];

    // Follow nextCursor to the end. The widget pages for READERS — a crawler wants the whole
    // index in one document, and baking only the first page would recreate, for search engines,
    // exactly the invisible-after-N truncation the paging was added to fix.
    let posts = [];
    try {
        let cursor = null;
        // Bounded: 40 pages of 50 is 2,000 posts. A cursor that somehow never terminates costs a
        // hung build otherwise, and a build that hangs is harder to diagnose than one that stops.
        for (let page = 0; page < 40; page++) {
            const qs = `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const data = await fetchJson(`${SITE_ORIGIN}/api/widget/${encodeURIComponent(key)}/posts${qs}`);
            posts = posts.concat(data.posts || []);
            cursor = data.nextCursor || null;
            if (!cursor) break;
        }
    } catch (err) {
        return handleFetchFailure('blog.html', err);
    }

    if (posts.length === 0) {
        // Not a failure: a blog with nothing published is a real state, and blog.html already
        // has a setup panel for it. Injecting an empty list is the honest result.
        log('blog.html: no published posts — nothing to inline');
    }

    const cards = posts.map((p) => {
        const url = `${SITE_ORIGIN}/blog/${encodeURIComponent(p.slug)}`;
        const date = p.publishedAt ? String(p.publishedAt).slice(0, 10) : '';
        return [
            '        <article>',
            `          <h2><a href="${escAttr(url)}">${escHtml(p.title || p.slug)}</a></h2>`,
            p.excerpt ? `          <p>${escHtml(p.excerpt)}</p>` : null,
            // Byline and date in one line, matching what the widget shows readers. Crawlers see
            // only this copy of the list — widget.js hides it behind a shadow root — so anything
            // omitted here is omitted from the index for search engines specifically.
            (p.author || date)
                ? `          <p>${[
                    p.author ? escHtml(p.author) : null,
                    date ? `<time datetime="${escAttr(date)}">${escHtml(date)}</time>` : null,
                ].filter(Boolean).join(' · ')}</p>`
                : null,
            Array.isArray(p.tags) && p.tags.length
                ? `          <ul>${p.tags.slice(0, 3).map((t) => `<li>${escHtml(String(t))}</li>`).join('')}</ul>`
                : null,
            '        </article>',
        ].filter(Boolean).join('\n');
    }).join('\n');

    const payload =
        '      <!-- Crawler-visible index of the server-rendered posts at /blog/:slug.\n' +
        '           Generated by scripts/build-seo-html.mjs from the same public endpoint the\n' +
        '           widget reads. Do not edit by hand.\n' +
        '\n' +
        '           This is INSIDE #bms-blog on purpose: widget.js attaches a shadow root to that\n' +
        '           element, and a shadow root replaces the light DOM for rendering — so visitors\n' +
        '           with JavaScript see the widget and never see this, while crawlers and LLM\n' +
        '           scrapers see real links into the post pages.\n' +
        '\n' +
        '           The id is load-bearing: when the preflight in mountBlogWidget() finds no posts\n' +
        '           the widget never mounts, so no shadow root attaches and this would otherwise\n' +
        '           sit visible next to the "first posts are on their way" panel, contradicting\n' +
        '           it. showSetupPanel() removes this region for exactly that case. -->\n' +
        '      <div id="blog-static">\n' +
        (cards || '        <!-- no published posts at build time -->') +
        '\n      </div>';

    const res = injectMarked(html, 'BLOG-POSTS', payload, (h, block) => {
        const re = /(<div\b[^>]*\bid=["']bms-blog["'][^>]*>)(\s*)(<\/div>)/i;
        if (!re.test(h)) return { html: h, ok: false, reason: 'no empty #bms-blog mount' };
        return { html: h.replace(re, `$1\n${block}\n      $3`), ok: true };
    });
    if (!res.ok) return fail(`blog.html: ${res.reason}`);

    writeFileSync(path, res.html);
    log(`blog post list → blog.html (${posts.length} posts)`);
}

// ── Job 4: crawlable help articles ─────────────────────────────────────────────
//
// help.html fetches its articles from get-help-articles and renders them client-side, so the
// served HTML carried ~380 characters of text for a help centre holding tens of thousands.
// There is no per-article URL to point a crawler at — every article lives behind one
// hash-routed view — so the indexable surface has to be the /help page itself, with the
// answers actually in it. That is the same shape faq.html already uses.
//
// Unlike Job 3 there is no shadow root to hide the static copy, so help.html removes this
// region once the live list has rendered (see #help-static there). The removal is guarded, so
// an unbuilt local checkout is unaffected.
// Article markdown is authored as a standalone document: it opens with an <h1> repeating the
// article title, which is already the <summary>. Left alone that gives /help fourteen <h1>
// elements and says the page is about whatever the last one happened to be. So drop the leading
// duplicate, then demote what remains — the page keeps ONE h1 (Help Center), h2 per category,
// and article headings nest below the <summary> that introduces them.
function articleBodyHtml(md, title) {
    let html = marked.parse(md || '', { async: false, gfm: true, breaks: false }).trim();

    const norm = (t) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const lead = html.match(/^<h1[^>]*>([\s\S]*?)<\/h1>\s*/i);
    if (lead && norm(lead[1]) === norm(title)) html = html.slice(lead[0].length);

    return html.replace(/<(\/?)h([1-6])\b/gi, (_, slash, level) =>
        `<${slash}h${Math.min(Number(level) + 2, 6)}`);
}

// ⚠️ Classes used below must exist in the PREBUILT style.css. Tailwind's typography plugin is
// not in it, so `prose`/`prose-sm` are dead classes here — they are silently no-ops, which is
// why this markup styles itself with plain utilities instead.
async function inlineHelpArticles() {
    const path = join(ROOT, 'help.html');
    if (!existsSync(path)) return fail('help.html not found');
    let html = readFileSync(path, 'utf8');

    let articles;
    try {
        const data = await fetchJson(`${SITE_ORIGIN}/.netlify/functions/get-help-articles`);
        articles = data.articles || [];
    } catch (err) {
        return handleFetchFailure('help.html', err);
    }

    if (articles.length === 0) return fail('help.html: get-help-articles returned no articles');

    // Group in the same order the page's own CATEGORY_ORDER uses, so the static copy and the
    // rendered copy present the articles identically. Read from the page rather than duplicated
    // here — a second copy of that list would drift.
    const orderMatch = html.match(/const CATEGORY_ORDER = \[([\s\S]*?)\];/);
    if (!orderMatch) return fail('help.html: CATEGORY_ORDER not found');
    const order = [...orderMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    const categories = [...order, ...articles.map((a) => a.category).filter((c) => !order.includes(c))];

    const sections = categories.map((cat) => {
        const inCat = articles.filter((a) => a.category === cat);
        if (!inCat.length) return null;
        const items = inCat.map((a) => {
            const body = articleBodyHtml(a.contentMd, a.title);
            return [
                '          <details class="mb-2">',
                `            <summary class="font-semibold text-gray-900 cursor-pointer py-2">${escHtml(a.title)}</summary>`,
                `            <div class="text-sm text-gray-600 leading-relaxed mt-2 space-y-2">${body.trim()}</div>`,
                '          </details>',
            ].join('\n');
        }).join('\n');
        return '        <section>\n' +
            `          <h2 class="text-lg font-bold text-gray-900 mb-3 pb-2 border-b border-gray-200">${escHtml(cat)}</h2>\n` +
            `${items}\n        </section>`;
    }).filter(Boolean).join('\n');

    const payload =
        '      <!-- Crawler-visible copy of the help centre, generated by\n' +
        '           scripts/build-seo-html.mjs from get-help-articles. Do not edit by hand: edit\n' +
        '           the articles in Admin and redeploy.\n' +
        '\n' +
        '           Removed by loadArticles() as soon as the live list renders, so a visitor with\n' +
        '           JavaScript sees the interactive centre and never sees two copies. If the fetch\n' +
        '           fails this stays put, which makes it a genuine offline fallback as well. -->\n' +
        '      <div id="help-static" class="space-y-8">\n' +
        sections +
        '\n      </div>';

    const res = injectMarked(html, 'HELP-ARTICLES', payload, (h, block) => {
        const re = /(<div\b[^>]*\bid=["']help-categories-container["'][^>]*>\s*<\/div>)/i;
        if (!re.test(h)) return { html: h, ok: false, reason: 'no #help-categories-container' };
        return { html: h.replace(re, `$1\n${block}`), ok: true };
    });
    if (!res.ok) return fail(`help.html: ${res.reason}`);

    writeFileSync(path, res.html);
    log(`help articles → help.html (${articles.length} articles, ` +
        `${articles.reduce((n, a) => n + (a.contentMd || '').length, 0)} md chars)`);
}

inlineFooters();
buildFaqJsonLd();
await inlineBlogPosts();
await inlineHelpArticles();

if (failures > 0) {
    console.error(`[build-seo-html] FAILED with ${failures} error(s) — not publishing a page ` +
                  `that silently lost its structured data or its footer.`);
    process.exit(1);
}
log('done');
