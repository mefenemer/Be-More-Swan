/**
 * Build-time HTML post-processing for crawlers. Runs from netlify.toml's build command,
 * IN THE DEPLOY CONTAINER, against a fresh checkout — the transformed HTML is published but
 * never committed. Source files keep the runtime-fetch behaviour so local dev is unchanged.
 *
 * Every job has the same shape: take something that today only exists after JavaScript runs,
 * and make it exist in the served HTML instead.
 *
 *   1. Inline components/footer.html into the indexable marketing pages.
 *   2. Generate FAQPage JSON-LD for faq.html from the questions actually rendered on it.
 *   3. Bake the blog post list into blog.html.            (3–8 fetch live data — see below)
 *   4. Bake the help articles into help.html.
 *   5. Bake plan prices into pricing.html and the home page, plus Offer JSON-LD.
 *   6. Generate one page per live assistant (/ai-…), the library's card list and
 *      assistant-pages.js, the map that links and forwards to them.
 *   7. Add those pages to sitemap.xml.
 *   8. Fill the generated half of llms.txt.
 *
 * Jobs 5–8 build their markup in scripts/seo/ai-readability.mjs (pure, tested in
 * tests/ai-readability.test.ts); this file does the fetching, the checks and the writes.
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
import {
    bakePlanPriceSlots, pricingCardTexts, applyTextById, pricingJsonLd,
    slugForRole, isLiveRole, buildAssistantPage, assistantPagesJs, libraryStaticCards,
    sitemapEntries, llmsGeneratedSections,
} from './seo/ai-readability.mjs';

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
    'connections.html',
    'how-it-works.html',
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
// Job 6 runs this on the generated assistant pages too, so the footer is read once.
function readFooter() {
    const footerPath = join(ROOT, 'components', 'footer.html');
    return existsSync(footerPath) ? readFileSync(footerPath, 'utf8').trim() : null;
}

function inlineFooterInto(html, footer) {
    // 1a. Fill the placeholder.
    const res = injectMarked(html, 'FOOTER', footer, (h, block) => {
        // Match the empty placeholder in whatever attribute order the page happens to use.
        const re = /(<div\b[^>]*\bid=["']footer-placeholder["'][^>]*>)(\s*)(<\/div>)/i;
        if (!re.test(h)) return { html: h, ok: false, reason: 'no #footer-placeholder' };
        return { html: h.replace(re, `$1\n${block}\n$3`), ok: true };
    });
    if (!res.ok) return res;

    // 1b. Stop the runtime fetch from re-fetching and clobbering what we just inlined.
    //     Identical markup, so replacing it is invisible — but it is a wasted request, and
    //     the replacement re-inserts the footer's <script> in the non-executing form,
    //     undoing 1a's incidental fix. Neutralise the call instead of deleting the line,
    //     so the built file still shows a reader what happened.
    const callRe = /(^[ \t]*)loadComponent\((["'])footer-placeholder\2\s*,\s*(["'])\.\/components\/footer\.html\3\s*\);?/m;
    if (callRe.test(res.html)) {
        return {
            ok: true,
            html: res.html.replace(
                callRe,
                `$1/* BUILD:FOOTER-INLINED — footer is injected into the HTML at build time by\n` +
                `$1   scripts/build-seo-html.mjs, so the runtime fetch is skipped here. In an\n` +
                `$1   unbuilt checkout this line is a live loadComponent() call. */`,
            ),
        };
    }
    if (!res.html.includes('BUILD:FOOTER-INLINED')) {
        // No live call AND no record of having neutralised one. powered-by.html loads its
        // fragments through a different loop and is not in FOOTER_PAGES, so reaching here
        // means a page's loader changed shape and the runtime fetch would clobber the inline.
        return { html: res.html, ok: false, reason: 'footer inlined but the loadComponent call site did not match — ' +
            'the runtime fetch will overwrite the inlined footer' };
    }
    // else: already neutralised by an earlier run. Not an error — see the idempotency note
    // in the header. Byte-identical output on a re-run is the CORRECT result here, so this
    // must not be treated as "nothing happened".
    return res;
}

function inlineFooters() {
    const footer = readFooter();
    if (!footer) return fail('components/footer.html not found');

    for (const page of FOOTER_PAGES) {
        const path = join(ROOT, page);
        if (!existsSync(path)) { fail(`${page} not found`); continue; }

        const before = readFileSync(path, 'utf8');
        const res = inlineFooterInto(before, footer);
        if (!res.ok) { fail(`${page}: ${res.reason}`); continue; }

        writeFileSync(path, res.html);
        log(res.html === before ? `footer already inlined → ${page}` : `footer inlined → ${page}`);
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

// Several jobs read the same endpoint (help articles feed Job 4 and llms.txt; plans feed Job 5 and
// llms.txt), so a successful response is reused for the rest of the build.
const fetchCache = new Map();

async function fetchJson(url, opts) {
    if (!fetchCache.has(url)) fetchCache.set(url, fetchJsonUncached(url, opts));
    try {
        return await fetchCache.get(url);
    } catch (err) {
        fetchCache.delete(url);
        throw err;
    }
}

async function fetchJsonUncached(url, { attempts = 3, timeoutMs = 10_000 } = {}) {
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

// ── Job 5: plan prices ─────────────────────────────────────────────────────────
//
// No page writes a price into its markup (owner, 2026-10-19 — a hardcoded £79 outlived the move to
// £69), so every price arrives from get-plans after load. That rule stays: the price is still read
// from master_plans, just once more at build time. To keep the baked copy from going stale, saving
// a plan in Admin fires SITE_REBUILD_HOOK (src/utils/trigger-site-rebuild.ts), so the published
// page is a rebuild behind the database, not a release behind it.
const PRICE_SLOT_PAGES = ['index.html', 'pricing.html'];

async function bakePlanPrices() {
    let data;
    try {
        data = await fetchJson(`${SITE_ORIGIN}/.netlify/functions/get-plans`);
    } catch (err) {
        return handleFetchFailure('plan prices', err);
    }
    const plans = Array.isArray(data.plans) ? data.plans : [];
    if (!plans.some((p) => Number(p.monthlyPriceGbp) > 0)) return fail('get-plans returned no priced plans');

    // 5a. The data-plan-price sentences (home page hero and pricing summary).
    for (const page of PRICE_SLOT_PAGES) {
        const path = join(ROOT, page);
        if (!existsSync(path)) { fail(`${page} not found`); continue; }
        const res = bakePlanPriceSlots(readFileSync(path, 'utf8'), plans);
        if (res.missing.length) log(`WARNING ${page}: no price for ${res.missing.join(', ')} — sentences left hidden`);
        writeFileSync(path, res.html);
        if (res.filled) log(`plan prices → ${page} (${res.filled} slots)`);
    }

    // 5b. The pricing cards, and the Offer markup.
    const path = join(ROOT, 'pricing.html');
    let html = readFileSync(path, 'utf8');
    const texts = pricingCardTexts(plans, data.enterprisePlan);
    const res = applyTextById(html, texts);
    // The two card prices are the reason this job exists: missing either is a failure.
    for (const id of ['card-price-t1', 'card-price-t2']) {
        if (!res.applied.includes(id)) fail(`pricing.html: #${id} was not filled`);
    }
    if (res.skipped.length) log(`pricing.html: left as-is (not text-only or absent): ${res.skipped.join(', ')}`);
    html = res.html;

    const ld = injectMarked(html, 'PRICING-JSONLD', pricingJsonLd(plans), (h, block) => {
        if (!/<\/head>/i.test(h)) return { html: h, ok: false, reason: 'no </head>' };
        return { html: h.replace(/<\/head>/i, `${block}\n</head>`), ok: true };
    });
    if (!ld.ok) return fail(`pricing.html: ${ld.reason}`);
    writeFileSync(path, ld.html);
    log(`pricing cards + Offer JSON-LD → pricing.html (${res.applied.length} fields)`);
}

// ── Job 6: a page per live assistant ───────────────────────────────────────────
//
// assistant.html is one shell for every role (?role=<key>), filled after load — so to a crawler
// all eight were the same 97-word page titled "Digital Assistant", and none was in the sitemap.
// This writes one real page per hireable role at a fixed keyword URL (ASSISTANT_PAGE_SLUGS), with
// its own title, canonical, copy and JSON-LD. The page script still runs and re-renders from live
// data, so the visitor's page is unchanged; assistant.html?role=<key> forwards to the new URL.
//
// Pages sit at the site root, not under /assistants/, because assistant.html links its styles,
// components and library with relative paths that a subdirectory would break.
//
// Coming-soon and early-access roles get no page: the library already says what they are, and a
// standalone page for something nobody can hire claims more than the product does.
async function buildAssistantPages() {
    let assistants;
    try {
        assistants = (await fetchJson(`${SITE_ORIGIN}/.netlify/functions/master-assistants`)).assistants || [];
    } catch (err) {
        handleFetchFailure('assistant pages', err);
        return { assistants: [], pages: {}, showcases: {} };
    }
    const live = assistants.filter(isLiveRole);
    if (!live.length) fail('master-assistants returned no live roles');

    const templatePath = join(ROOT, 'assistant.html');
    if (!existsSync(templatePath)) { fail('assistant.html not found'); return { assistants, pages: {}, showcases: {} }; }
    const template = readFileSync(templatePath, 'utf8');
    const footer = readFooter();

    // Slugs first: a page's "Works with" links need every other page's URL.
    const pages = {};
    for (const a of live) {
        const { slug, pinned } = slugForRole(a.roleKey, a.name);
        if (!pinned) log(`WARNING ${a.roleKey} has no pinned slug — using /${slug}; add it to ASSISTANT_PAGE_SLUGS`);
        if (existsSync(join(ROOT, `${slug}.html`)) && !readFileSync(join(ROOT, `${slug}.html`), 'utf8').includes('name="bms-role"')) {
            fail(`${slug}.html already exists and is not a generated assistant page`);
            continue;
        }
        pages[a.roleKey] = { slug, name: a.name };
    }

    const showcases = {};
    for (const a of live) {
        if (!pages[a.roleKey]) continue;
        try {
            const d = await fetchJson(`${SITE_ORIGIN}/.netlify/functions/assistant-showcase?roleKey=${encodeURIComponent(a.roleKey)}`);
            showcases[a.roleKey] = d.showcase || null;
        } catch (err) {
            handleFetchFailure(`assistant page ${a.roleKey}`, err);
            showcases[a.roleKey] = null;
        }
        const { slug } = pages[a.roleKey];
        const swan = join(ROOT, 'images', 'assistants', a.roleKey, 'swan.jpg');
        const built = buildAssistantPage(template, {
            roleKey: a.roleKey, slug, c: a, sc: showcases[a.roleKey], pages,
            ogImage: existsSync(swan) ? `${SITE_ORIGIN}/images/assistants/${a.roleKey}/swan.jpg` : null,
        });
        if (built.errors.length) { fail(`${slug}.html: template anchor(s) not found: ${built.errors.join(', ')}`); continue; }
        let html = built.html;
        if (footer) {
            const f = inlineFooterInto(html, footer);
            if (f.ok) html = f.html; else fail(`${slug}.html: ${f.reason}`);
        }
        writeFileSync(join(ROOT, `${slug}.html`), html);
        log(`assistant page → /${slug} (${a.roleKey}${showcases[a.roleKey] ? '' : ', short version: no showcase'})`);
    }

    writeFileSync(join(ROOT, 'assistant-pages.js'), assistantPagesJs(pages));
    log(`assistant-pages.js → ${Object.keys(pages).length} roles`);

    // 6b. The library's card list, for a reader that never runs renderGrid().
    const libPath = join(ROOT, 'assistants.html');
    let lib = readFileSync(libPath, 'utf8');
    const cards = injectMarked(lib, 'ASSISTANT-CARDS', libraryStaticCards(assistants, pages), (h, block) => {
        const anchor = '<!-- Loading skeleton -->';
        if (!h.includes(anchor)) return { html: h, ok: false, reason: 'no "Loading skeleton" anchor in #assistants-grid' };
        return { html: h.replace(anchor, `${block}\n      ${anchor}`), ok: true };
    });
    if (!cards.ok) fail(`assistants.html: ${cards.reason}`);
    else {
        // The spinner would sit under real cards in the static copy; renderGrid() hides it anyway.
        lib = cards.html.replace(/(<div\b[^>]*\bid="grid-loading")(?![^>]*display:none)/, '$1 style="display:none"');
        writeFileSync(libPath, lib);
        log(`library cards → assistants.html (${live.length} live roles)`);
    }
    return { assistants, pages, showcases };
}

// ── Job 7: sitemap ─────────────────────────────────────────────────────────────
function extendSitemap(pages) {
    const path = join(ROOT, 'sitemap.xml');
    if (!existsSync(path)) return fail('sitemap.xml not found');
    const entries = sitemapEntries(pages);
    if (!entries) return log('sitemap.xml: no assistant pages to add');
    const res = injectMarked(readFileSync(path, 'utf8'), 'ASSISTANT-PAGES', entries, (h, block) => {
        if (!h.includes('</urlset>')) return { html: h, ok: false, reason: 'no </urlset>' };
        return { html: h.replace('</urlset>', `  ${block}\n</urlset>`), ok: true };
    });
    if (!res.ok) return fail(`sitemap.xml: ${res.reason}`);
    writeFileSync(path, res.html);
    log(`sitemap.xml + ${Object.keys(pages).length} assistant pages`);
}

// ── Job 8: llms.txt ────────────────────────────────────────────────────────────
//
// The hand-written introduction lives in llms.txt itself; everything that changes — which
// assistants are live, what the plans cost, which help articles exist — is generated here so the
// file can never quote a price or a role the site no longer has.
async function buildLlmsTxt({ assistants, pages, showcases }) {
    const path = join(ROOT, 'llms.txt');
    if (!existsSync(path)) return fail('llms.txt not found');
    let plans = [], enterprisePlan = null, articles = [];
    try {
        const d = await fetchJson(`${SITE_ORIGIN}/.netlify/functions/get-plans`);
        plans = d.plans || [];
        enterprisePlan = d.enterprisePlan || null;
        articles = (await fetchJson(`${SITE_ORIGIN}/.netlify/functions/get-help-articles`)).articles || [];
    } catch (err) {
        return handleFetchFailure('llms.txt', err);
    }
    const body = llmsGeneratedSections({ assistants, showcases, pages, plans, enterprisePlan, articles });
    const res = injectMarked(readFileSync(path, 'utf8'), 'LLMS-GENERATED', body, (h) =>
        ({ html: h, ok: false, reason: 'no <!-- BUILD:LLMS-GENERATED --> region' }));
    if (!res.ok) return fail(`llms.txt: ${res.reason}`);
    writeFileSync(path, res.html);
    log(`llms.txt (${body.split('\n').length} generated lines)`);
}

inlineFooters();
buildFaqJsonLd();
await inlineBlogPosts();
await inlineHelpArticles();
await bakePlanPrices();
const assistantData = await buildAssistantPages();
extendSitemap(assistantData.pages);
await buildLlmsTxt(assistantData);

if (failures > 0) {
    console.error(`[build-seo-html] FAILED with ${failures} error(s) — not publishing a page ` +
                  `that silently lost its structured data or its footer.`);
    process.exit(1);
}
log('done');
