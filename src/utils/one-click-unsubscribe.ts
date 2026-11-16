// src/utils/one-click-unsubscribe.ts — unsubscribing from a newsletter on the owner's behalf (plan §2.5, Phase 2b).
//
// RFC 8058 one-click: when an email carries BOTH
//     List-Unsubscribe: <https://…>
//     List-Unsubscribe-Post: List-Unsubscribe=One-Click
// a single POST of "List-Unsubscribe=One-Click" to that https URL unsubscribes. It is what Gmail's and
// Outlook's own "Unsubscribe" buttons do. Only after the owner pressed Unsubscribe and confirmed.
//
// ⚠️ The URL comes from an email — anyone can write it. Before calling it (SSRF):
//   - https only, default port, no user:password in it;
//   - the host must not be an IP literal or "localhost", and EVERY address it resolves to must be public
//     (no 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 0/8, ::1, fc00::/7, fe80::/10 …);
//   - no redirects followed; 8 s timeout; the response body is never read or shown.
// Without one-click we never call anything: the owner gets the sender's own link or mailto to use.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface UnsubscribeOptions {
    /** An https URL that accepts the RFC 8058 POST — present only when List-Unsubscribe-Post says One-Click. */
    oneClickUrl: string | null;
    /** A link to open in the browser (https), or null. */
    webUrl: string | null;
    /** A mailto: address the owner could write to themselves, or null. We never send it. */
    mailto: string | null;
}

/** Read List-Unsubscribe / List-Unsubscribe-Post (lower-cased header names). Pure. */
export function parseListUnsubscribe(headers: Readonly<Record<string, string>>): UnsubscribeOptions {
    const raw = headers['list-unsubscribe'] ?? '';
    const parts = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
    const https = parts.find((p) => /^https:\/\//i.test(p)) ?? null;
    const mailto = parts.find((p) => /^mailto:/i.test(p)) ?? null;
    const oneClick = /list-unsubscribe\s*=\s*one-click/i.test(headers['list-unsubscribe-post'] ?? '');
    return { oneClickUrl: oneClick && https ? https : null, webUrl: https, mailto };
}

/** Is this IP address private, loopback, link-local or otherwise not on the public internet? Pure. */
export function isPrivateAddress(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (v === 6) {
        const x = ip.toLowerCase();
        if (x === '::1' || x === '::') return true;
        if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
        return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
    }
    return true; // not an IP at all: treat as unsafe
}

/** The URL's shape is safe to call (before DNS). Pure. */
export function safeUrlShape(raw: string): URL | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host || isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || !host.includes('.')) return null;
    return u;
}

export type UnsubscribeResult = { ok: true } | { ok: false; reason: 'no_one_click' | 'unsafe_url' | 'refused' | 'timeout' };

/** POST the one-click unsubscribe. Never throws. */
export async function oneClickUnsubscribe(url: string, opts: { resolve?: (host: string) => Promise<string[]>; timeoutMs?: number } = {}): Promise<UnsubscribeResult> {
    const u = safeUrlShape(url);
    if (!u) return { ok: false, reason: 'unsafe_url' };
    const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
    try {
        const addrs = await resolve(u.hostname);
        if (!addrs.length || addrs.some(isPrivateAddress)) return { ok: false, reason: 'unsafe_url' };
    } catch { return { ok: false, reason: 'unsafe_url' }; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    try {
        const res = await fetch(u.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
            redirect: 'manual',
            signal: controller.signal,
        });
        // 2xx is success; a redirect means the sender wanted a page shown — we don't follow it.
        return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, reason: 'refused' };
    } catch (err) {
        return { ok: false, reason: (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'refused' };
    } finally {
        clearTimeout(timer);
    }
}
