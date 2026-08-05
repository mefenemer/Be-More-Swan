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
        '@id': `${SITE_ORIGIN}/faq.html#faq`,
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

inlineFooters();
buildFaqJsonLd();

if (failures > 0) {
    console.error(`[build-seo-html] FAILED with ${failures} error(s) — not publishing a page ` +
                  `that silently lost its structured data or its footer.`);
    process.exit(1);
}
log('done');
