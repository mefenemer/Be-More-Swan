// sites-host/edge-functions/serve.ts — the whole of the *.bemoreswan.site project.
// See sites-host/netlify.toml for how this project is set up, and netlify/functions/site-serve.ts
// (on the app) for what is served.
//
// Every request — any host, any path — is forwarded to the app's site-serve function with the host
// the visitor asked for and SITE_SERVE_SECRET. Nothing about a site lives here: no database, no
// pages, no secrets beyond the shared key. GET and HEAD are passed on for every path; POST only for
// /_form (the site's contact and sign-up forms, step 3b), with the visitor's IP for rate limits.

declare const Netlify: { env: { get(name: string): string | undefined } };

const FORM_PATH = '/_form';
const MAX_FORM_BYTES = 20_000;

export default async (request: Request, context?: { ip?: string }): Promise<Response> => {
    const url = new URL(request.url);
    const isForm = request.method === 'POST' && url.pathname === FORM_PATH;
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
    const target = `${app}/.netlify/functions/site-serve?path=${encodeURIComponent(url.pathname)}${url.search ? `&q=${encodeURIComponent(url.search.slice(1))}` : ''}`;
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
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
};

export const config = { path: '/*' };
