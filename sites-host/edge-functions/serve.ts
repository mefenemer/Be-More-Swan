// sites-host/edge-functions/serve.ts — the whole of the *.bemoreswan.site project.
// See sites-host/netlify.toml for how this project is set up, and netlify/functions/site-serve.ts
// (on the app) for what is served.
//
// Every request — any host, any path — is forwarded to the app's site-serve function with the host
// the visitor asked for and SITE_SERVE_SECRET. Nothing about a site lives here: no database, no
// pages, no secrets beyond the shared key. Only GET and HEAD are passed on (published sites have
// no forms yet).

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    const app = (Netlify.env.get('APP_ORIGIN') || 'https://bemoreswan.com').replace(/\/+$/, '');
    const key = Netlify.env.get('SITE_SERVE_SECRET') || '';
    if (!key) return new Response('This site is not available right now.', { status: 503 });

    const target = `${app}/.netlify/functions/site-serve?path=${encodeURIComponent(url.pathname)}`;
    const upstream = await fetch(target, {
        method: request.method,
        headers: { 'x-site-host': url.host, 'x-site-serve-key': key, 'user-agent': request.headers.get('user-agent') || '' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!upstream) return new Response('This site is not available right now. Please try again in a minute.', { status: 503, headers: { 'Retry-After': '60' } });

    // Pass the page and its headers through; drop anything that would tie it to the app's origin.
    const headers = new Headers(upstream.headers);
    headers.delete('set-cookie');
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
};

export const config = { path: '/*' };
