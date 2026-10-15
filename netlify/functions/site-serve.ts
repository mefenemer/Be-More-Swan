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
import { renderRobots, renderSitemap, renderSiteNotice, renderSitePage, esc, BOOK_PATH, BUY_ACTION, FORM_ACTION, FORM_SENT_PATH } from '../../src/utils/site-render';
import { bookStep, bookSubmit } from '../../src/utils/site-booking';
import { bookingSummary, businessSummary } from '../../src/utils/bookings';
import { canSell, loadSiteProducts, startCheckout } from '../../src/utils/site-shop';
import { safeBackPath } from '../../src/utils/site-forms';
import { handleSiteForm, loadSiteForms, sentMessage } from '../../src/utils/site-forms';
import audiencePublic from './audience-public';
import { siteAssetUrl, siteOrigin, sitesDomain, slugFromHost } from '../../src/utils/site-hosting';
import { maxPagesFor, publishedDefinition } from '../../src/utils/site-store';

// form-action: the site's own forms post to its own /_form and /_buy (steps 3b, 3c), and nowhere
// else — a script-free page cannot be made to post a visitor's details to another site. Stripe
// Checkout is listed because /_buy answers with a redirect there, and browsers apply form-action to
// the redirect too.
const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com";

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

export default withLambda(async (event) => {
    const h = event.headers as Record<string, string | undefined>;
    if (!keyMatches(h['x-site-serve-key'], process.env.SITE_SERVE_SECRET)) return { statusCode: 404, body: 'Not found' };
    const isPost = event.httpMethod === 'POST';
    if (!isPost && event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return { statusCode: 405, body: 'Method Not Allowed' };

    const app = appOrigin();
    const slug = slugFromHost(h['x-site-host']);
    // The bare domain and www: there is no site there — send people to what builds them.
    if (!slug) return { statusCode: 301, headers: { Location: `${app}/assistant.html?role=website_assistant`, 'Cache-Control': 'public, max-age=3600' }, body: '' };

    const rawPath = String(event.queryStringParameters?.path || '/');
    const path = rawPath.startsWith('/') ? rawPath.slice(0, 300) : '/';
    // Only a form or a Buy button may be posted, and only to their own addresses.
    if (isPost && path !== FORM_ACTION && path !== BUY_ACTION && path !== BOOK_PATH) return { statusCode: 405, headers: { Allow: 'GET, HEAD' } as Record<string, string>, body: 'Method Not Allowed' };
    if (path === '/favicon.ico') return { statusCode: 404, headers: headers('text/plain', 'public, max-age=3600'), body: '' };

    const db = getDb();
    const [site] = await db.select().from(sites).where(eq(sites.slug, slug)).limit(1);
    if (site?.status === 'suspended') {
        return notice(410, 'This site is unavailable', 'This website has been taken offline.', app);
    }
    const definition = site?.status === 'published' ? await publishedDefinition(db, site, await maxPagesFor(db, site.organisationId)) : null;
    if (!site || !definition) {
        if (path === '/robots.txt') return { statusCode: 200, headers: headers('text/plain; charset=utf-8', 'public, max-age=300'), body: renderRobots('', true) };
        return notice(404, 'There\'s no website here yet', `Nothing has been published at ${esc(`${slug}.${sitesDomain()}`)} yet. <a href="${esc(app)}/assistant.html?role=website_assistant">Build your own website with Be More Swan</a>.`, app);
    }

    const origin = siteOrigin(slug);
    const ctx = {
        origin, preview: false,
        reportUrl: `${app}/report-site.html?site=${encodeURIComponent(slug)}`,
        creditUrl: site.credit ? `${app}/assistant.html?role=website_assistant` : null,
        assetUrl: (id: number) => siteAssetUrl(app, id),
    };

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
    if (path === FORM_SENT_PATH) {
        const q = new URLSearchParams(String(event.queryStringParameters?.q || ''));
        const m = await sentMessage(db, site, definition, q);
        return { statusCode: 200, headers: headers('text/html; charset=utf-8', 'no-store'), body: renderSiteNotice(definition, ctx, m.title, m.message, { label: 'Back to the site', path: m.back }) };
    }

    if (path === '/robots.txt') return { statusCode: 200, headers: headers('text/plain; charset=utf-8', 'public, max-age=300'), body: renderRobots(origin, false) };
    if (path === '/sitemap.xml') return { statusCode: 200, headers: headers('application/xml; charset=utf-8', 'public, max-age=300'), body: renderSitemap(definition, origin) };

    const hasShop = definition.pages.some((p) => p.sections.some((s) => s.type === 'products'));
    const hasBooking = definition.pages.some((p) => p.sections.some((s) => s.type === 'booking'));
    const page = renderSitePage(definition, path, {
        ...ctx, forms: await loadSiteForms(db, site.organisationId, definition), renderedAt: Date.now(),
        canSell: hasShop ? await canSell(db, site.organisationId) : false,
        products: hasShop ? await loadSiteProducts(db, site.organisationId, definition) : {},
        booking: hasBooking ? await bookingSummary(db, site.organisationId) : null,
        business: await businessSummary(db, site.organisationId),
    });
    return { statusCode: page.status, headers: headers('text/html; charset=utf-8', 'public, max-age=60'), body: event.httpMethod === 'HEAD' ? '' : page.html };
});
