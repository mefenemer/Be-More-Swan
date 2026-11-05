// sites-host/edge-functions/serve.ts — the whole of the *.bemoreswan.site project.
// See sites-host/netlify.toml for how this project is set up, and netlify/functions/site-serve.ts
// (on the app) for what is served.
//
// Every request — any host, any path — is forwarded to the app's site-serve function with the host
// the visitor asked for and SITE_SERVE_SECRET. Nothing about a site lives here: no database, no
// pages, no secrets beyond the shared key. GET and HEAD are passed on for every path; POST only for
// /_form (contact and sign-up forms, step 3b), /_buy (Buy buttons, step 3c) and /_book (the last
// booking step), with the visitor's IP for rate limits.

declare const Netlify: { env: { get(name: string): string | undefined } };

const FORM_PATHS = new Set(['/_form', '/_buy', '/_book']);
const MAX_FORM_BYTES = 20_000;

// ── Visitor counts (src/utils/site-visits.ts; db/z-site-visits.sql) ──────────────────────────────
// Counted HERE because every page view passes through this function, before any cache — the app's
// pages are cached, so most views never reach it. A person's page view (GET, 200, HTML, not a bot,
// not a prefetch, not a form/calendar/sitemap address) is sent to the app's site-visit function after
// the page has been answered. No cookie, no script; the IP and browser string never leave here: the
// app gets a one-way hash of (UK day, host, IP, browser) made with SITE_SERVE_SECRET, which it keeps
// for that day only to count each visitor once.
// ⚠️ BOT_RE and countablePath are copies of the ones in src/utils/site-visits.ts (this project cannot
// import the app's code) — tests/site-visits.test.ts fails if they drift apart.
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|monitor|uptime|pingdom|headless|lighthouse|curl\/|wget\/|python-|go-http|java\/|okhttp|axios|node-fetch|httpclient|scrapy|semrush|ahrefs|mj12|dataforseo|bytespider|gptbot|claudebot|perplexity|petalbot|yandex|baiduspider|duckduckbot|bingpreview|applebot/i;
function countablePath(path: string): boolean {
    const p = (path || '').split(/[?#]/)[0];
    if (!p.startsWith('/') || p.length > 300) return false;
    if (p.startsWith('/_') || p.startsWith('/.well-known') || p.startsWith('/site-fonts')) return false;
    return !/\.(ics|xml|txt|ico|png|jpe?g|gif|webp|svg|css|js|json|map|woff2?)$/i.test(p);
}
async function visitorHash(key: string, parts: string[]): Promise<string> {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(parts.join('|'))));
    return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function countVisit(app: string, key: string, request: Request, url: URL, ip: string): Promise<void> {
    const ua = request.headers.get('user-agent') || '';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    let ref = '';
    try {
        const r = request.headers.get('referer');
        const h = r ? new URL(r).hostname.toLowerCase().replace(/^www\./, '') : '';
        if (h && h !== url.hostname.toLowerCase().replace(/^www\./, '')) ref = h;
    } catch { /* no referrer */ }
    const visitor = await visitorHash(key, [day, url.host.toLowerCase(), ip, ua]);
    await fetch(`${app}/.netlify/functions/site-visit`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-site-serve-key': key },
        body: JSON.stringify({ host: url.host, path: url.pathname, ref, visitor }),
        signal: AbortSignal.timeout(8_000),
    }).catch(() => {});
}

export default async (request: Request, context?: { ip?: string; waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> => {
    const url = new URL(request.url);
    const isForm = request.method === 'POST' && FORM_PATHS.has(url.pathname);
    if (!isForm && request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const app = (Netlify.env.get('APP_ORIGIN') || 'https://bemoreswan.com').replace(/\/+$/, '');
    const key = Netlify.env.get('SITE_SERVE_SECRET') || '';
    if (!key) return new Response('This site is not available right now.', { status: 503 });

    let body: string | undefined;
    if (isForm) {
        body = await request.text();
        if (body.length > MAX_FORM_BYTES) return new Response('That form was too large to send.', { status: 413 });
    }
    // ⚠️ The host is in the URL as well as the header, so no cache between here and the app can ever
    // hand one site's page to another site's address (site-serve also sends Netlify-Vary on X-Site-Host).
    const target = `${app}/.netlify/functions/site-serve?host=${encodeURIComponent(url.host)}&path=${encodeURIComponent(url.pathname)}${url.search ? `&q=${encodeURIComponent(url.search.slice(1))}` : ''}`;
    const upstream = await fetch(target, {
        method: request.method,
        headers: {
            'x-site-host': url.host, 'x-site-serve-key': key, 'user-agent': request.headers.get('user-agent') || '',
            ...(isForm ? { 'content-type': 'application/x-www-form-urlencoded', 'x-site-client-ip': context?.ip || '' } : {}),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(isForm ? 20_000 : 10_000),
    }).catch(() => null);
    if (!upstream) return new Response('This site is not available right now. Please try again in a minute.', { status: 503, headers: { 'Retry-After': '60' } });

    // Pass the page and its headers through; drop anything that would tie it to the app's origin.
    const headers = new Headers(upstream.headers);
    headers.delete('set-cookie');
    // A person read a page: count it after answering (waitUntil keeps it alive past the response).
    const purpose = `${request.headers.get('sec-purpose') || ''} ${request.headers.get('purpose') || ''}`;
    if (request.method === 'GET' && upstream.status === 200 && (headers.get('content-type') || '').startsWith('text/html')
        && countablePath(url.pathname) && !BOT_RE.test(request.headers.get('user-agent') || 'bot') && (request.headers.get('user-agent') || '').length >= 12 && !/prefetch|prerender/i.test(purpose)) {
        const counting = countVisit(app, key, request, url, context?.ip || '').catch(() => {});
        if (context?.waitUntil) context.waitUntil(counting);
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
};

// Fonts are served as plain files from public/site-fonts (site-render.ts), not forwarded.
export const config = { path: '/*', excludedPath: ['/site-fonts/*'] };
