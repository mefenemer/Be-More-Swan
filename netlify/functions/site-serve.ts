// netlify/functions/site-serve.ts
// Serves PUBLISHED Website Assistant sites — https://<slug>.bemoreswan.site. docs/website-assistant-plan.md §5.2.
//
// ── How a request gets here ─────────────────────────────────────────────────────────────────────
// *.bemoreswan.site belongs to a separate Netlify project (sites-host/). Its one edge function
// forwards every request here with two headers:
//   x-site-host       the Host the visitor asked for (willowbrook.bemoreswan.site)
//   x-site-serve-key  SITE_SERVE_SECRET, shared by the two projects
// and the path in ?path=. Without the right key this answers a bare 404: customer pages must never
// be servable from bemoreswan.com itself (a phishing page under our own domain is the thing the
// separate domain exists to prevent — decision D3).
//
// ── What it serves ──────────────────────────────────────────────────────────────────────────────
// Only the PUBLISHED version (site_versions), never the draft. The renderer (site-render.ts) emits
// no JavaScript; the CSP below forbids scripts anyway and lets no one frame the page. Every page
// carries "Report this site" (→ /report-site.html on the app). A suspended site answers 410 with a
// plain notice; a draft or unknown address answers 404.

import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { sites } from '../../db/schema';
import { renderRobots, renderSiteBlogIndex, renderSiteBlogPost, renderSitemap, renderSiteNotice, renderSitePage, esc, BOOK_PATH, BOOKING_PAGE_PATH, BUY_ACTION, FORM_ACTION, FORM_SENT_PATH, REVIEW_PATH, LISTING_POST_PATH, renderSiteListing } from '../../src/utils/site-render';
import { reviewPage, reviewSubmit } from '../../src/utils/site-review';
import { bookStep, bookSubmit } from '../../src/utils/site-booking';
import { loadSiteReviews } from '../../src/utils/reviews';
import { loadSiteSocialFeed } from '../../src/utils/site-social-feed';
import { loadSiteBlogIndex, loadSiteBlogLatest, loadSiteBlogPost, siteBlogRoute, siteBlogSlugs } from '../../src/utils/site-blog';
import { BLOG_PATH, blogOn, redirectFor } from '../../src/utils/site-definition';
import { listingIcs, listingRoute, listingSlugs, loadListingBySlug, loadSiteListings } from '../../src/utils/site-listings';
import { listingPostPage, listingPostSubmit } from '../../src/utils/site-listing-post';
import { bookableSessions } from '../../src/utils/class-sessions';
import { bookingSummary, businessSummary } from '../../src/utils/bookings';
import { canSell, loadSiteProducts, startCheckout } from '../../src/utils/site-shop';
import { safeBackPath } from '../../src/utils/site-forms';
import { handleSiteForm, loadSiteForms, sentMessage } from '../../src/utils/site-forms';
import audiencePublic from './audience-public';
import { siteAssetUrl, siteOrigin, sitesDomain, slugFromHost, siteCacheTag } from '../../src/utils/site-hosting';
import { DOMAIN_CHECK_PATH, domainCheckBody, resolveSiteHost } from '../../src/utils/site-domains';
import { maxPagesFor, publishedDefinition } from '../../src/utils/site-store';
import { bookingOnlySite, bookingPage } from '../../src/utils/site-booking-page';

// form-action: the site's own forms post to its own /_form and /_buy (steps 3b, 3c), and nowhere
// else — a script-free page cannot be made to post a visitor's details to another site. Stripe
// Checkout is listed because /_buy answers with a redirect there, and browsers apply form-action to
// the redirect too.
const CSP = "default-src 'none'; img-src https: data:; media-src https:; font-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com";

/** The app's own address — where "Report this site" and "Made with Be More Swan" lead. */
export function appOrigin(env: Record<string, string | undefined> = process.env): string {
    const u = (env.URL || '').replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+$/i.test(u) ? u : 'https://bemoreswan.com';
}

export function keyMatches(given: string | undefined, secret: string | undefined): boolean {
    if (!secret || secret.length < 16 || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
}

const headers = (type: string, cache: string) => ({
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000',
    'Cache-Control': cache,
});

function notice(status: number, title: string, body: string, app: string) {
    const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937;background:#faf7f2;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}main{max-width:520px;text-align:center}h1{font-size:1.6rem;margin:0 0 .5em}p{line-height:1.6;color:#4b5563}a{color:#be185d}</style></head>
<body><main><h1>${esc(title)}</h1><p>${body}</p><p><a href="${esc(app)}">Be More Swan</a></p></main></body></html>`;
    return { statusCode: status, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: html };
}

/**
 * A sign-up from a hosted site goes through audience-public's subscribe — the one path that records
 * consent, sends the confirmation and enrols the welcome sequence — called in-process with the
 * site as the Origin (allowed there only for the workspace's own published site).
 */
async function subscribeInProcess(payload: Record<string, unknown>, meta: { origin: string; ip: string; userAgent: string | null }, app: string): Promise<{ status: number; body: { error?: string } }> {
    const host = new URL(app).host;
    const res = await (audiencePublic as unknown as (r: Request, c: unknown) => Promise<Response>)(new Request(`${app}/api/audience/subscribe`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json', origin: meta.origin, 'user-agent': meta.userAgent || '',
            'x-nf-client-connection-ip': meta.ip, 'x-forwarded-for': meta.ip,
            'x-forwarded-host': host, 'x-forwarded-proto': 'https',
        },
        body: JSON.stringify(payload),
    }), {});
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * ⚠️ EVERY response varies by the site's address AND by the query string. The sites host asks for
 * site-serve?host=…&path=/…&q=… with the site also in the X-Site-Host header. Netlify's cache key
 * IGNORES the query string unless told otherwise, so without `query` every page of every site shared
 * one cache entry: a browser's /favicon.ico (an empty 404 kept an hour) became the home page — found
 * on the first published site, 2026-10-16. And without the header one site's page showed at another's
 * address. Netlify-Vary splits on both; plain Vary covers any other cache on the way.
 */
/** What a booking-only address (bookings set up, site not published) answers; everything else is "no website here yet". */
const BOOKING_ONLY_PATHS = new Set(['/', BOOKING_PAGE_PATH, BOOK_PATH, FORM_SENT_PATH, '/robots.txt']);

export const SITE_VARY = { 'Netlify-Vary': 'query, header=X-Site-Host', Vary: 'X-Site-Host' } as const;

type ServeResult = { statusCode: number; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean };

type Resolved = Awaited<ReturnType<typeof resolveSiteHost>>;

export default withLambda(async (event) => {
    const h = event.headers as Record<string, string | undefined>;
    if (!keyMatches(h['x-site-serve-key'], process.env.SITE_SERVE_SECRET)) return { statusCode: 404, body: 'Not found' };
    // The site this address names — a *.bemoreswan.site address, or a business's own domain
    // (site-domains.ts) — and where it should really be seen.
    const resolved = await resolveSiteHost(getDb(), h['x-site-host']);
    const res = (await serve(event, resolved)) as ServeResult;
    // Tagged per SITE (not per address), so publishing clears every address's cached pages at once.
    const slug = resolved?.slug ?? null;
    return { ...res, headers: { ...(res.headers || {}), ...SITE_VARY, ...(slug ? { 'Netlify-Cache-Tag': siteCacheTag(slug) } : {}) } };
});

async function serve(event: Parameters<Parameters<typeof withLambda>[0]>[0], resolved: Resolved) {
    const h = event.headers as Record<string, string | undefined>;
    const isPost = event.httpMethod === 'POST';
    if (!isPost && event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return { statusCode: 405, body: 'Method Not Allowed' };

    const app = appOrigin();
    const rawPath = String(event.queryStringParameters?.path || '/');
    const path = rawPath.startsWith('/') ? rawPath.slice(0, 300) : '/';
    const slug = resolved?.slug ?? null;
    if (!slug) {
        // The bare domain and www of bemoreswan.site: there is no site there — send people to what builds them.
        const host = String(h['x-site-host'] || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
        if (host === sitesDomain() || host === `www.${sitesDomain()}`) {
            return { statusCode: 301, headers: { Location: `${app}/assistant.html?role=website_assistant`, 'Cache-Control': 'public, max-age=3600' }, body: '' };
        }
        return notice(404, 'There\'s no website here', 'This domain isn\'t connected to a website. If it\'s yours, connect it from your Website Assistant.', app);
    }
    // One address per site: the other form of its domain, or its bemoreswan.site address once its own
    // domain is live, sends people to the main one (a page view only — forms and checks answer in place).
    if (resolved?.redirectTo && !isPost && path !== DOMAIN_CHECK_PATH) {
        const q = String(event.queryStringParameters?.q || '');
        return { statusCode: 301, headers: { Location: `${resolved.redirectTo}${path}${q ? `?${q}` : ''}`, 'Cache-Control': 'public, max-age=300' }, body: '' };
    }
    // Only a form or a Buy button may be posted, and only to their own addresses.
    if (isPost && path !== FORM_ACTION && path !== BUY_ACTION && path !== BOOK_PATH) return { statusCode: 405, headers: { Allow: 'GET, HEAD' } as Record<string, string>, body: 'Method Not Allowed' };
    if (path === '/favicon.ico') return { statusCode: 404, headers: headers('text/plain', 'public, max-age=300'), body: '' };

    const db = getDb();
    const [site] = await db.select().from(sites).where(eq(sites.slug, slug)).limit(1);
    // "Is https://<their domain> really this site?" (site-domains.ts checkDomain) — answered for any status.
    if (path === DOMAIN_CHECK_PATH) return { statusCode: site ? 200 : 404, headers: headers('text/plain; charset=utf-8', 'no-store'), body: site ? domainCheckBody(site.id) : '' };
    if (site?.status === 'suspended') {
        return notice(410, 'This site is unavailable', 'This website has been taken offline.', app);
    }
    const published = site?.status === 'published' ? await publishedDefinition(db, site, await maxPagesFor(db, site.organisationId)) : null;
    // Not published yet, but bookings are set up: the address still takes bookings — the booking
    // pages only, in the site's look (site-booking-page.ts; docs/booking-calendly-gaps-plan.md A).
    const bookingDef = !published && site && site.status === 'draft' && BOOKING_ONLY_PATHS.has(path) ? await bookingOnlySite(db, site, new Date()) : null;
    const bookingOnly = !!bookingDef;
    const definition = published ?? bookingDef;
    if (!site || !definition) {
        if (path === '/robots.txt') return { statusCode: 200, headers: headers('text/plain; charset=utf-8', 'public, max-age=300'), body: renderRobots('', true) };
        return notice(404, 'There\'s no website here yet', `Nothing has been published at ${esc(`${slug}.${sitesDomain()}`)} yet. <a href="${esc(app)}/assistant.html?role=website_assistant">Build your own website with Be More Swan</a>.`, app);
    }

    const origin = resolved?.origin ?? siteOrigin(slug);
    const ctx = {
        origin, preview: false,
        reportUrl: `${app}/report-site.html?site=${encodeURIComponent(slug)}`,
        // The booking-only pages always carry the credit, on every plan (owner, 2026-11-08).
        creditUrl: site.credit || bookingOnly ? `${app}/assistant.html?role=website_assistant` : null,
        assetUrl: (id: number) => siteAssetUrl(app, id),
    };

    if (bookingOnly) {
        // The home page of a booking-only address is the booking link; nothing else of the draft is served.
        if (path === '/') return { statusCode: 302, headers: { Location: BOOKING_PAGE_PATH, 'Cache-Control': 'no-store' } as Record<string, string>, body: '' };
        if (path === '/robots.txt') return { statusCode: 200, headers: headers('text/plain; charset=utf-8', 'public, max-age=300'), body: renderRobots('', true) };
        if (isPost && path !== BOOK_PATH) return { statusCode: 405, headers: { Allow: 'GET, HEAD' } as Record<string, string>, body: 'Method Not Allowed' };
    }
    // The booking link (site-booking-page.ts) — unless the site has a page of its own at /book.
    if (path === BOOKING_PAGE_PATH && !isPost && !definition.pages.some((p) => p.slug === 'book')) {
        const r = await bookingPage({ db, site, def: definition, ctx, now: new Date() }, new URLSearchParams(String(event.queryStringParameters?.q || '')), !!published);
        const noIndex = bookingOnly ? { 'X-Robots-Tag': 'noindex' } : {};
        if ('location' in r) return { statusCode: 303, headers: { Location: r.location, 'Cache-Control': 'no-store', ...noIndex } as Record<string, string>, body: '' };
        return { statusCode: r.status, headers: { ...headers('text/html; charset=utf-8', 'no-store'), ...noIndex }, body: r.html };
    }

    // ── Forms (step 3b) and Buy buttons (step 3c) ──
    if (isPost) {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
        // The visitor's IP: sent by the sites-host edge function, trusted only because the key matched.
        const ip = (h['x-site-client-ip'] || '').slice(0, 64) || 'unknown';
        if (path === BOOK_PATH) {
            const result = await bookSubmit({ db, site, def: definition, ctx, now: new Date() }, new URLSearchParams(raw.slice(0, 8000)), ip);
            if ('location' in result) return { statusCode: 303, headers: { Location: result.location, 'Cache-Control': 'no-store' } as Record<string, string>, body: '' };
            return { statusCode: result.status, headers: headers('text/html; charset=utf-8', 'no-store'), body: result.html };
        }
        if (path === BUY_ACTION) {
            const form = new URLSearchParams(raw.slice(0, 4000));
            const bought = await startCheckout(db, { site, definition, origin, ip, body: form, backPath: safeBackPath(definition, form.get('_p')), assetUrl: ctx.assetUrl });
            if (bought.kind === 'redirect') return { statusCode: 303, headers: { Location: bought.location, 'Cache-Control': 'no-store' } as Record<string, string>, body: '' };
            return { statusCode: bought.status, headers: headers('text/html; charset=utf-8', 'no-store'), body: renderSiteNotice(definition, ctx, bought.title, bought.message, { label: 'Go back', path: bought.backPath }) };
        }
        // A review from the link in a review request email (site-review.ts) — it posts to /_form too.
        const posted = new URLSearchParams(raw.slice(0, 8000));
        // "Post your event" from a listings section (site-listing-post.ts) — saved pending, for the owner to approve.
        if (posted.get('_k') === 'listing') {
            const r = await listingPostSubmit({ db, site, def: definition, ctx, now: new Date() }, posted, ip);
            if ('location' in r) return { statusCode: 303, headers: { Location: r.location, 'Cache-Control': 'no-store' } as Record<string, string>, body: '' };
            return { statusCode: r.status, headers: headers('text/html; charset=utf-8', 'no-store'), body: r.html };
        }
        if (posted.get('_k') === 'review' || posted.get('_k') === 'review_stop') {
            const r = await reviewSubmit({ db, site, def: definition, ctx, now: new Date() }, posted, ip);
            if ('location' in r) return { statusCode: 303, headers: { Location: r.location, 'Cache-Control': 'no-store' } as Record<string, string>, body: '' };
            return { statusCode: r.status, headers: headers('text/html; charset=utf-8', 'no-store'), body: r.html };
        }
        const outcome = await handleSiteForm(db, {
            site, definition, origin, ip, userAgent: h['user-agent'] ?? null,
            body: new URLSearchParams(raw.slice(0, 20000)),
            subscribe: (payload, meta) => subscribeInProcess(payload, meta, app),
        });
        if (outcome.kind === 'sent') return { statusCode: 303, headers: { Location: outcome.location, 'Cache-Control': 'no-store' } as Record<string, string>, body: '' };
        return { statusCode: outcome.status, headers: headers('text/html; charset=utf-8', 'no-store'), body: renderSiteNotice(definition, ctx, outcome.title, outcome.message, { label: 'Go back', path: outcome.backPath }) };
    }
    // Booking steps (site-booking.ts): every step a page, every choice a link — no script.
    if (path === BOOK_PATH) {
        const step = await bookStep({ db, site, def: definition, ctx, now: new Date() }, new URLSearchParams(String(event.queryStringParameters?.q || '')));
        if ('location' in step) return { statusCode: 303, headers: { Location: step.location } as Record<string, string>, body: '' };
        return { statusCode: step.status, headers: headers('text/html; charset=utf-8', 'no-store'), body: step.html };
    }
    if (path === REVIEW_PATH) {
        const r = await reviewPage({ db, site, def: definition, ctx, now: new Date() }, new URLSearchParams(String(event.queryStringParameters?.q || '')));
        if ('location' in r) return { statusCode: 303, headers: { Location: r.location } as Record<string, string>, body: '' };
        return { statusCode: r.status, headers: { ...headers('text/html; charset=utf-8', 'no-store'), 'X-Robots-Tag': 'noindex' }, body: r.html };
    }
    if (path === LISTING_POST_PATH) {
        const r = listingPostPage({ db, site, def: definition, ctx, now: new Date() }, new URLSearchParams(String(event.queryStringParameters?.q || '')));
        if ('location' in r) return { statusCode: 303, headers: { Location: r.location } as Record<string, string>, body: '' };
        return { statusCode: r.status, headers: { ...headers('text/html; charset=utf-8', 'no-store'), 'X-Robots-Tag': 'noindex' }, body: r.html };
    }
    if (path === FORM_SENT_PATH) {
        const q = new URLSearchParams(String(event.queryStringParameters?.q || ''));
        const m = await sentMessage(db, site, definition, q);
        return { statusCode: 200, headers: headers('text/html; charset=utf-8', 'no-store'), body: renderSiteNotice(definition, ctx, m.title, m.message, { label: 'Back to the site', path: m.back }) };
    }

    if (path === '/robots.txt') return { statusCode: 200, headers: headers('text/plain; charset=utf-8', 'public, max-age=300'), body: renderRobots(origin, false) };
    // Every address this site answers at — a post canonical at any of them is this site's.
    const origins = [origin, siteOrigin(slug), ...(resolved?.redirectTo ? [resolved.redirectTo] : [])];
    if (path === '/sitemap.xml') {
        const blog = blogOn(definition) ? await siteBlogSlugs(db, site.organisationId, origin, origins) : [];
        const hasListings = definition.pages.some((p) => p.sections.some((x) => x.type === 'listings'));
        return { statusCode: 200, headers: headers('application/xml; charset=utf-8', 'public, max-age=300'), body: renderSitemap(definition, origin, blog, hasListings ? await listingSlugs(db, site.organisationId) : []) };
    }

    // ── The Blog Assistant's posts (site-blog.ts): /blog and /blog/<slug>, while the blog is on ──
    const blogRoute = blogOn(definition) ? siteBlogRoute(path) : null;
    // The address a Blog Studio embed page usually had (/blogs) — kept working after a move here.
    if (blogOn(definition) && (path === '/blogs' || path === '/blogs/') && !definition.pages.some((p) => p.slug === 'blogs')) {
        return { statusCode: 301, headers: { Location: BLOG_PATH, 'Cache-Control': 'public, max-age=3600' } as Record<string, string>, body: '' };
    }
    if (blogRoute) {
        const blogCtx = { ...ctx, business: await businessSummary(db, site.organisationId) };
        // Under the 600 s life of the picture links inside (blog-media-resolve), like blog-page.ts.
        const cache = 'public, max-age=120';
        if (blogRoute.kind === 'index') {
            const q = new URLSearchParams(String(event.queryStringParameters?.q || ''));
            const data = await loadSiteBlogIndex(db, site.organisationId, q.get('cursor'));
            if (data.cursor && !data.posts.length) return { statusCode: 404, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: renderSitePage(definition, '/__none', ctx).html };
            return { statusCode: 200, headers: headers('text/html; charset=utf-8', cache), body: event.httpMethod === 'HEAD' ? '' : renderSiteBlogIndex(definition, blogCtx, data) };
        }
        const post = await loadSiteBlogPost(db, site.organisationId, blogRoute.slug, origin, origins);
        if (!post) return { statusCode: 404, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: renderSitePage(definition, '/__none', ctx).html };
        return { statusCode: 200, headers: headers('text/html; charset=utf-8', cache), body: event.httpMethod === 'HEAD' ? '' : renderSiteBlogPost(definition, blogCtx, post) };
    }

    // ── A listing's own page, and its "Add to calendar" file: /listings/<slug>(.ics) ──
    const lr = listingRoute(path);
    if (lr && definition.pages.some((p) => p.sections.some((x) => x.type === 'listings'))) {
        const l = await loadListingBySlug(db, site.organisationId, lr.slug);
        if (!l) return { statusCode: 404, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: renderSitePage(definition, '/__none', ctx).html };
        const pageUrl = `${origin}/listings/${encodeURIComponent(l.slug)}`;
        if (lr.ics) {
            const ics = listingIcs(l, definition.settings.siteName, pageUrl);
            if (!ics) return { statusCode: 404, headers: headers('text/plain; charset=utf-8', 'public, max-age=60'), body: '' };
            return { statusCode: 200, headers: { ...headers('text/calendar; charset=utf-8', 'public, max-age=300'), 'Content-Disposition': `attachment; filename="${l.slug}.ics"` }, body: event.httpMethod === 'HEAD' ? '' : ics };
        }
        return { statusCode: 200, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: event.httpMethod === 'HEAD' ? '' : renderSiteListing(definition, ctx, l) };
    }

    // An old address that moved (an imported page's former path — site-definition.ts redirects).
    const moved = redirectFor(definition, path);
    if (moved) return { statusCode: 301, headers: { Location: moved, 'Cache-Control': 'public, max-age=3600' } as Record<string, string>, body: '' };

    const hasShop = definition.pages.some((p) => p.sections.some((s) => s.type === 'products'));
    const hasBooking = definition.pages.some((p) => p.sections.some((s) => s.type === 'booking'));
    const hasClasses = definition.pages.some((p) => p.sections.some((s) => s.type === 'booking' && s.props.kind === 'class'));
    const page = renderSitePage(definition, path, {
        ...ctx, forms: await loadSiteForms(db, site.organisationId, definition), renderedAt: Date.now(),
        canSell: hasShop ? await canSell(db, site.organisationId) : false,
        products: hasShop || definition.pages.some((p) => p.sections.some((s) => s.type === 'menu')) ? await loadSiteProducts(db, site.organisationId, definition) : {},
        booking: hasBooking ? { ...await bookingSummary(db, site.organisationId), ...(hasClasses ? { sessions: await bookableSessions(db, site.organisationId, new Date(), [], 60) } : {}) } : null,
        business: await businessSummary(db, site.organisationId),
        reviews: await loadSiteReviews(db, site.organisationId, definition),
        socialFeed: await loadSiteSocialFeed(db, site.organisationId, definition),
        blog: await loadSiteBlogLatest(db, site.organisationId, definition),
        listings: await loadSiteListings(db, site.organisationId, definition),
        query: String(event.queryStringParameters?.q || ''),
    });
    return { statusCode: page.status, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: event.httpMethod === 'HEAD' ? '' : page.html };
}
