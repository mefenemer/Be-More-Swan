/**
 * Pure builders for the AI-readability jobs in scripts/build-seo-html.mjs (Jobs 5–8).
 *
 * Every function here takes data the build has already fetched and returns a string. Nothing reads
 * the network or the filesystem, so tests/ai-readability.test.ts can drive each one with fixtures —
 * the build script owns the I/O, the fail-loud checks and the writes.
 *
 * The problem all four jobs solve is the one Jobs 3 and 4 solved for the blog and the help centre:
 * the content a buyer (or an AI assistant answering for one) most wants — what each assistant does,
 * what it costs — reached the page only after JavaScript ran. ChatGPT's, Claude's and Perplexity's
 * crawlers mostly do not run it, so to them the pricing page had no prices and every assistant page
 * was the same 97-word shell titled "Digital Assistant".
 */

export const SITE_ORIGIN = 'https://bemoreswan.com';

export const escHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// JSON inside <script type="application/ld+json">: a "</script>" in admin-authored copy would end
// the element early, so every "<" is written as its JSON escape. The parsed value is identical.
const ldJson = (obj, indent = '  ') =>
    `${indent}<script type="application/ld+json">\n` +
    JSON.stringify(obj, null, 2).replace(/</g, '\\u003c').split('\n').map((l) => indent + l).join('\n') +
    `\n${indent}</script>`;

// Same rule as pricing.html's fmtGbp: whole pounds stay whole (£69), pence show both digits.
export function formatGbp(amount) {
    const n = Number(amount);
    return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

// ── Plans ─────────────────────────────────────────────────────────────────────

/**
 * Fill every `<span data-plan-price="tier"></span>` with its monthly price and drop `hidden` from
 * each `data-plan-prices-ready` wrapper whose prices are all known — the same thing plan-prices.js
 * does in the browser, done once at build so the sentence exists for a reader without JavaScript.
 * plan-prices.js still runs and rewrites the same values, so the live page is unchanged.
 */
export function bakePlanPriceSlots(html, plans) {
    const byTier = Object.fromEntries((plans || []).map((p) => [p.tierKey, p]));
    const known = (tier) => Number(byTier[tier]?.monthlyPriceGbp) > 0;
    let filled = 0;
    const missing = [];

    // A slot is either empty or holds a price from an earlier run — replace whatever is there.
    let out = html.replace(/(<span\b[^>]*\bdata-plan-price=["']([a-z_]+)["'][^>]*>)[^<]*(<\/span>)/g,
        (m, open, tier, close) => {
            if (!known(tier)) { missing.push(tier); return m; }
            filled++;
            return open + escHtml(formatGbp(byTier[tier].monthlyPriceGbp)) + close;
        });

    // Unhide the wrappers only when every slot on the page was filled, so a sentence never reads
    // "Plans start at /month". (Wrappers nest spans, so matching each one to its own close tag is
    // fragile; one blank slot anywhere keeps them all hidden, which is the safe direction.)
    out = out.replace(/<span\b([^>]*\bdata-plan-prices-ready)(\s+hidden)?([^>]*)>/g, (m, a, _hidden, b) =>
        (missing.length ? m : `<span${a}${b}>`));
    return { html: out, filled, missing: [...new Set(missing)] };
}

/** pricing.html's renderPlanCards()/updatePriceDisplay() targets, as id → text, monthly cycle. */
export function pricingCardTexts(plans, enterprisePlan) {
    const SLOT = { saver: 't1', buster: 't2', enterprise: 't4' };
    const stripTierPrefix = (v) => String(v ?? '').replace(/^\s*tier\s*\d+\s*[·|:—-]\s*/i, '');
    const fmtCount = (n) => (n < 1000 ? String(n) : (Math.round(n / 10) / 100) + 'k');
    const texts = {};
    const set = (id, v) => { if (v != null && String(v).trim() !== '') texts[id] = String(v); };

    for (const plan of [...(plans || []), ...(enterprisePlan ? [enterprisePlan] : [])]) {
        const slot = SLOT[plan.tierKey];
        if (!slot) continue;
        set(`card-tier-${slot}`, stripTierPrefix(plan.tierDescription));
        set(`card-name-${slot}`, plan.name);
        set(`card-desc-${slot}`, plan.description);
        if (plan.tierKey === 'buster') {
            set('anchor-plan-name', plan.name);
            set('final-cta-name', plan.name);
        }
        if (plan.isContactSales) continue;
        const monthly = Number(plan.monthlyPriceGbp);
        if (monthly > 0) {
            set(`card-price-${slot}`, formatGbp(monthly));
            set(`tbl-price-${slot}`, formatGbp(monthly));
            if (plan.tierKey === 'buster') {
                set('anchor-price', formatGbp(monthly));
                set('final-cta-price', formatGbp(monthly));
            }
        }
        // A null limit means unlimited — same reading as setStatBox().
        const asst = plan.assistantLimit == null ? null : Number(plan.assistantLimit);
        set(`stat-asst-${slot}`, asst == null ? 'All' : String(asst));
        set(`stat-asst-lbl-${slot}`, asst === 1 ? 'Assistant' : 'Assistants');
        const tasks = plan.monthlyTaskLimit == null ? null : Number(plan.monthlyTaskLimit);
        set(`stat-task-${slot}`, tasks == null ? '∞' : fmtCount(tasks));
    }
    return texts;
}

/**
 * Replace the text of each element with a given id. Only text-only elements are touched: an element
 * with child tags (tbl-name-t1 holds a <br>) is reported as skipped rather than flattened.
 */
export function applyTextById(html, texts) {
    const applied = [];
    const skipped = [];
    let out = html;
    for (const [id, text] of Object.entries(texts)) {
        const re = new RegExp(`(<([a-z0-9]+)\\b[^>]*\\bid=["']${id.replace(/[-]/g, '\\-')}["'][^>]*>)([^<]*)(</\\2>)`, 'i');
        if (!re.test(out)) { skipped.push(id); continue; }
        out = out.replace(re, (m, open, _tag, _old, close) => open + escHtml(text) + close);
        applied.push(id);
    }
    return { html: out, applied, skipped };
}

/** Offer markup for the pricing page: one Offer per purchasable plan, monthly, in GBP. */
export function pricingJsonLd(plans) {
    const offers = (plans || [])
        .filter((p) => !p.isContactSales && Number(p.monthlyPriceGbp) > 0)
        .map((p) => ({
            '@type': 'Offer',
            name: p.name,
            description: [String(p.tierDescription || '').replace(/^\s*tier\s*\d+\s*[·|:—-]\s*/i, ''), p.description]
                .filter(Boolean).join('. '),
            url: `${SITE_ORIGIN}/pricing`,
            price: Number(p.monthlyPriceGbp).toFixed(2),
            priceCurrency: 'GBP',
            priceSpecification: {
                '@type': 'UnitPriceSpecification',
                price: Number(p.monthlyPriceGbp).toFixed(2),
                priceCurrency: 'GBP',
                billingDuration: 'P1M',
                unitCode: 'MON',
            },
            availability: 'https://schema.org/InStock',
        }));
    return ldJson({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        // Same node as the home page's SoftwareApplication, so the offers attach to it rather than
        // describing a second product.
        '@id': `${SITE_ORIGIN}/#software`,
        name: 'Be More Swan',
        url: `${SITE_ORIGIN}/`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web browser',
        offers,
    }, '    ');
}

// ── Assistant pages ───────────────────────────────────────────────────────────

/**
 * roleKey → URL slug for the generated assistant pages. Fixed here, NOT derived from the display
 * name, because the name is editable in Admin and a rename must not move a URL that search engines
 * and AI answers already point at.
 *
 * ⚠️ Every slug starts with "ai-". netlify.toml sends `X-Robots-Tag: noindex` for `/assistant-*`
 * (the in-app assistant pages), so an "assistant-…" slug would publish a page nobody can index.
 * A live role missing from this map still gets a page, at a slug derived from its name, and the
 * build logs a warning so it can be pinned here.
 */
export const ASSISTANT_PAGE_SLUGS = {
    social_media_manager: 'ai-social-media-assistant',
    lead_qualifier: 'ai-lead-generation-assistant',
    blog_writer: 'ai-blog-writing-assistant',
    newsletter_editor: 'ai-email-marketing-assistant',
    campaign_orchestrator: 'ai-marketing-campaign-orchestrator',
    brand_designer: 'ai-brand-designer',
    mystery_shopper: 'ai-mystery-shopper',
    website_assistant: 'ai-website-assistant',
};

export function slugForRole(roleKey, name) {
    if (ASSISTANT_PAGE_SLUGS[roleKey]) return { slug: ASSISTANT_PAGE_SLUGS[roleKey], pinned: true };
    const base = String(name || roleKey).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return { slug: base.startsWith('ai-') ? base : `ai-${base}`, pinned: false };
}

/** Only roles a visitor can actually hire get a page: not coming soon, not in early access. */
export const isLiveRole = (a) => !!a && !a.comingSoon && !a.beta;

const pageTitle = (c) => `${c.name} for small businesses | Be More Swan`;
const pageDescription = (c, sc) => String((sc && sc.headline) || c.tagline || c.description || '').trim();

/**
 * The crawler-visible copy of one assistant page. Uses the same classes render() uses in
 * assistant.html, so the brief moment before the live render replaces it looks like the page.
 * Every class here already appears in assistant.html's template and so exists in style.css.
 */
/** The plan line under "Get started" — the same map as assistant.html PLAN_NOTES. */
export const PLAN_NOTES = { video_producer: 'On the Busywork Buster plan' };

export function assistantStaticHtml(c, sc, pages, roleKey = c && c.roleKey) {
    const s = sc || {};
    const overview = Array.isArray(s.overview) ? s.overview : (c.description ? [c.description] : []);
    const highlights = Array.isArray(s.highlights) && s.highlights.length ? s.highlights : (c.keyFeatures || []);
    const steps = Array.isArray(s.steps) ? s.steps : [];
    const features = Array.isArray(s.features) ? s.features : [];
    const faqs = Array.isArray(s.faqs) ? s.faqs : [];
    const peers = (Array.isArray(c.worksWith) ? c.worksWith : [])
        .map((k) => (typeof k === 'string' ? k : k && k.roleKey))
        .filter((k) => k && pages[k]);
    const L = [];
    L.push('  <div id="sc-static">');
    L.push('    <section class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-16">');
    L.push(`      <p class="text-xs font-bold uppercase tracking-wider text-gray-500">${escHtml(c.category || 'Digital assistant')}</p>`);
    L.push(`      <h1 class="text-4xl sm:text-5xl font-extrabold text-gray-900 leading-tight mb-4">${escHtml(c.name)}</h1>`);
    const lead = s.headline || c.tagline;
    if (lead) L.push(`      <p class="text-xl font-bold text-emerald-700 mb-6">${escHtml(lead)}</p>`);
    if (highlights.length) L.push(`      <ul class="space-y-2.5 mb-8">${highlights.map((h) => `<li class="text-gray-700 font-medium">${escHtml(h)}</li>`).join('')}</ul>`);
    L.push('      <a href="/pricing" class="btn-golive inline-block font-bold px-6 py-3 text-base rounded-xl">Get started</a>');
    L.push(`      <p class="text-xs text-gray-400 mt-4">${escHtml(PLAN_NOTES[roleKey] || 'Included in every plan')} · You approve its work before anything goes out</p>`);
    L.push('    </section>');
    if (overview.length) {
        L.push('    <section class="bg-white border-y border-gray-100"><div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14">');
        L.push('      <h2 class="text-3xl font-extrabold text-gray-900 mb-6">What it does for you</h2>');
        L.push(`      <div class="space-y-4 text-lg text-gray-600 leading-relaxed">${overview.map((p) => `<p>${escHtml(p)}</p>`).join('')}</div>`);
        L.push('    </div></section>');
    }
    if (steps.length) {
        L.push('    <section class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-14">');
        L.push('      <h2 class="text-3xl font-extrabold text-gray-900 mb-8 text-center">How it works</h2>');
        L.push(`      <ol class="sc-steps">${steps.map((st) => `<li class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6"><p class="font-bold text-gray-900 mb-1.5">${escHtml(st.title)}</p><p class="text-sm text-gray-600 leading-relaxed">${escHtml(st.body)}</p></li>`).join('')}</ol>`);
        L.push('    </section>');
    }
    if (features.length) {
        L.push('    <section class="bg-white border-y border-gray-100"><div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-16">');
        L.push('      <h2 class="text-3xl font-extrabold text-gray-900 text-center">Key features</h2>');
        for (const f of features) {
            L.push(`      <div class="max-w-3xl mx-auto text-center"><h3 class="text-2xl font-extrabold text-gray-900 mb-3">${escHtml(f.title)}</h3><p class="text-gray-600 leading-relaxed">${escHtml(f.body)}</p></div>`);
        }
        L.push('    </div></section>');
    }
    if (peers.length) {
        L.push('    <section class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-14">');
        L.push('      <h2 class="text-lg font-extrabold text-gray-900 mb-3">Works with</h2>');
        L.push(`      <ul class="flex flex-wrap gap-1.5">${peers.map((k) => `<li><a href="/${escAttr(pages[k].slug)}" class="text-emerald-700 font-semibold">${escHtml(pages[k].name)}</a></li>`).join('')}</ul>`);
        L.push('    </section>');
    }
    if (faqs.length) {
        L.push('    <section class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">');
        L.push('      <h2 class="text-3xl font-extrabold text-gray-900 mb-6">Questions</h2>');
        L.push(`      <div class="space-y-3">${faqs.map((f) => `<details class="bg-white border border-gray-200 rounded-xl shadow-sm"><summary class="font-semibold cursor-pointer px-6 py-5 text-gray-900">${escHtml(f.q)}</summary><div class="px-6 pb-5 text-gray-600 text-sm leading-relaxed">${escHtml(f.a)}</div></details>`).join('')}</div>`);
        L.push('    </section>');
    }
    L.push('  </div>');
    return L.join('\n');
}

export function assistantJsonLd(c, sc, slug) {
    const url = `${SITE_ORIGIN}/${slug}`;
    const faqs = Array.isArray(sc?.faqs) ? sc.faqs.filter((f) => f && f.q && f.a) : [];
    const graph = [
        {
            '@type': 'WebPage',
            '@id': `${url}#webpage`,
            url,
            name: pageTitle(c),
            description: pageDescription(c, sc),
            isPartOf: { '@type': 'WebSite', url: `${SITE_ORIGIN}/` },
            about: { '@id': `${url}#service` },
            breadcrumb: {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_ORIGIN}/` },
                    { '@type': 'ListItem', position: 2, name: 'Assistants', item: `${SITE_ORIGIN}/assistants` },
                    { '@type': 'ListItem', position: 3, name: c.name, item: url },
                ],
            },
        },
        {
            '@type': 'Service',
            '@id': `${url}#service`,
            name: c.name,
            description: pageDescription(c, sc),
            serviceType: c.category || 'AI assistant',
            provider: { '@id': `${SITE_ORIGIN}/#organization` },
            isRelatedTo: { '@id': `${SITE_ORIGIN}/#software` },
            url,
        },
    ];
    if (faqs.length) {
        graph.push({
            '@type': 'FAQPage',
            '@id': `${url}#faq`,
            mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        });
    }
    return ldJson({ '@context': 'https://schema.org', '@graph': graph });
}

/**
 * Turn assistant.html into one role's page. Returns { html, errors } — every edit asserts that its
 * anchor matched, so a template change that moves an anchor fails the build instead of shipping a
 * page that silently lost its title, its canonical or its copy.
 */
export function buildAssistantPage(template, { roleKey, slug, c, sc, pages, ogImage }) {
    const errors = [];
    let html = template;
    const swap = (label, re, fn) => {
        if (!re.test(html)) { errors.push(label); return; }
        html = html.replace(re, fn);
    };
    const url = `${SITE_ORIGIN}/${slug}`;
    const title = pageTitle(c);
    const desc = pageDescription(c, sc);

    swap('<title>', /<title>[^<]*<\/title>/, () => `<title>${escHtml(title)}</title>`);
    swap('meta description', /<meta name="description" content="[^"]*">/, () =>
        `<meta name="description" content="${escAttr(desc)}">\n` +
        `  <link rel="canonical" href="${escAttr(url)}">\n` +
        `  <meta property="og:title" content="${escAttr(title)}">\n` +
        `  <meta property="og:description" content="${escAttr(desc)}">\n` +
        `  <meta property="og:url" content="${escAttr(url)}">\n` +
        // Read by the page script in place of ?role= — see assistant.html.
        `  <meta name="bms-role" content="${escAttr(roleKey)}">`);
    if (ogImage) swap('og:image', /<meta property="og:image" content="[^"]*">/, () => `<meta property="og:image" content="${escAttr(ogImage)}">`);
    // The query-string page is noindex (its thin shell is the same for every role); this one is the
    // page that SHOULD be indexed.
    swap('robots noindex', /\s*<meta name="robots" content="noindex, follow">/, () => '');
    swap('</head>', /<\/head>/, () => `${assistantJsonLd(c, sc, slug)}\n</head>`);
    swap('#sc-loading', /<div id="sc-loading" class="/, () => '<div id="sc-loading" class="hidden ');
    swap('#sc-root', /(<div id="sc-root" class="hidden"><\/div>)/, (m) => `${m}\n\n${assistantStaticHtml(c, sc, pages, roleKey)}`);
    return { html, errors };
}

/** The runtime map the library and assistant.html use to link to (and forward to) the pages. */
export function assistantPagesJs(pages) {
    const map = Object.fromEntries(Object.entries(pages).map(([k, p]) => [k, p.slug]));
    return '// Generated by scripts/build-seo-html.mjs (Job 6) — do not edit by hand.\n' +
        '// roleKey → the slug of that assistant\'s own page, for every role that has one in this deploy.\n' +
        '// The committed copy is empty, so an unbuilt checkout keeps using assistant.html?role=<key>.\n' +
        `window.BmsAssistantPages = ${JSON.stringify(map, null, 2)};\n`;
}

/** Crawler-visible cards for the library (assistants.html). renderGrid() replaces them. */
export function libraryStaticCards(assistants, pages) {
    return (assistants || []).filter(isLiveRole).map((a) => {
        const href = pages[a.roleKey] ? `/${pages[a.roleKey].slug}` : `/assistant.html?role=${encodeURIComponent(a.roleKey)}`;
        return '      <article class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">\n' +
            `        <h3 class="text-lg font-bold text-gray-900 mb-1"><a href="${escAttr(href)}">${escHtml(a.name)}</a></h3>\n` +
            (a.tagline ? `        <p class="text-sm text-gray-600">${escHtml(a.tagline)}</p>\n` : '') +
            '      </article>';
    }).join('\n');
}

export function sitemapEntries(pages) {
    return Object.values(pages).map((p) =>
        `  <url>\n    <loc>${escHtml(`${SITE_ORIGIN}/${p.slug}`)}</loc>\n  </url>`).join('\n');
}

// ── llms.txt ──────────────────────────────────────────────────────────────────

// Same slug rule as help.html's slugify(), so a /help#<slug> link opens that article.
const helpSlug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** The generated half of llms.txt: assistants, plans and help articles, all from live data. */
export function llmsGeneratedSections({ assistants, showcases, pages, plans, enterprisePlan, articles }) {
    const L = [];
    const live = (assistants || []).filter(isLiveRole);
    const soon = (assistants || []).filter((a) => a && a.comingSoon);

    L.push('## Assistants available now', '');
    for (const a of live) {
        const sc = showcases[a.roleKey];
        const href = pages[a.roleKey] ? `${SITE_ORIGIN}/${pages[a.roleKey].slug}` : `${SITE_ORIGIN}/assistants`;
        const line = String((sc && sc.headline) || a.tagline || '').trim();
        L.push(`- [${a.name}](${href})${line ? `: ${line}` : ''}`);
    }
    if (soon.length) {
        L.push('', '## Coming soon (not yet available to hire)', '');
        L.push(soon.map((a) => a.name).join(', '));
    }

    L.push('', '## Plans and prices', '');
    L.push('Prices are monthly, in pounds sterling. Full details: ' + `${SITE_ORIGIN}/pricing`, '');
    for (const p of (plans || []).filter((x) => Number(x.monthlyPriceGbp) > 0)) {
        const who = String(p.tierDescription || '').replace(/^\s*tier\s*\d+\s*[·|:—-]\s*/i, '');
        const asst = p.assistantLimit == null ? 'every assistant' : `${p.assistantLimit} assistant${Number(p.assistantLimit) === 1 ? '' : 's'}`;
        const tasks = p.monthlyTaskLimit == null ? 'unlimited tasks' : `${Number(p.monthlyTaskLimit).toLocaleString('en-GB')} tasks a month`;
        L.push(`- ${p.name}: ${formatGbp(p.monthlyPriceGbp)} a month${who ? `. ${who}` : ''}. Includes ${asst} and ${tasks}.${p.description ? ` ${p.description}` : ''}`);
    }
    if (enterprisePlan) {
        L.push(`- ${enterprisePlan.name}: priced on request.${enterprisePlan.description ? ` ${enterprisePlan.description}` : ''}`);
    }

    if ((articles || []).length) {
        L.push('', '## Help Centre articles', '');
        for (const a of articles) L.push(`- [${a.title}](${SITE_ORIGIN}/help#${helpSlug(a.title)})`);
    }
    return L.join('\n');
}
