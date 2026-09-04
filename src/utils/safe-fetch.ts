// src/utils/safe-fetch.ts
// SSRF-hardened fetcher for user-supplied URLs.
//
// Any time a user can hand us a URL that the SERVER then fetches, they get to point our
// Lambda's network position at things they can't reach themselves: cloud instance metadata
// (169.254.169.254 — the classic credential-stealer), localhost admin ports, and anything
// on the VPC's private ranges. `fetch(userUrl)` with no checks hands that over.
//
// What this guards against, and how:
//
//  1. Scheme            — http/https only. Blocks file://, gopher://, data:, etc.
//  2. Embedded creds    — rejected; they're a redirect-laundering trick and never legitimate.
//  3. Private targets   — every DNS-resolved address is checked against the reserved/private
//                         IPv4 + IPv6 ranges, INCLUDING IPv4-mapped and NAT64-embedded v6
//                         (::ffff:169.254.169.254 must not sneak past a v6-shaped check).
//  4. DNS rebinding     — the load-bearing bit. Validating DNS and THEN calling fetch() leaves
//                         a TOCTOU window: an attacker's resolver answers public on our check
//                         and private on the real connection. So we resolve once, validate,
//                         and then PIN the connection to those exact addresses via the
//                         `lookup` hook on http.request — the socket can only ever reach an
//                         address we already approved. This is why this is built on
//                         node:http/node:https rather than global fetch(), which exposes no
//                         such hook (and why we don't need an undici dependency for it).
//  5. Redirects         — followed manually, capped, and EVERY hop re-runs the full check.
//                         A public URL 302-ing to 169.254.169.254 is the standard bypass.
//  6. Response size     — streamed with a hard byte cap, aborted mid-flight when exceeded, so
//                         a hostile endpoint can't stream us to OOM.
//  7. Timeout           — wall-clock cap across the whole redirect chain, not per hop.
//
// Returns text only — callers are ingesting documents, and never needing to hand back a
// binary body keeps the size cap simple.
//
// Used by the Inspo tab's URL ingestion (docs/inspo-tab-plan.md). NOTE:
// netlify/functions/process-asset-background.ts has an unguarded `fetch(asset.externalUrl)`
// predating this and should be moved onto safeFetchText().

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import type { LookupFunction } from 'node:net';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB of HTML/PDF is a generous article
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 5;

/** Thrown for every rejection so callers can surface one honest message to the user. */
export class SafeFetchError extends Error {
    constructor(message: string, readonly reason: string) {
        super(message);
        this.name = 'SafeFetchError';
    }
}

// ── IP classification ───────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(ip: string, cidr: string): boolean {
    const [range, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    // A /0 mask would shift by 32, which JS treats as a no-op shift — special-cased.
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// Everything that isn't a routable public v4 address.
const BLOCKED_V4 = [
    '0.0.0.0/8',          // "this network"
    '10.0.0.0/8',         // RFC1918 private
    '100.64.0.0/10',      // CGNAT
    '127.0.0.0/8',        // loopback
    '169.254.0.0/16',     // link-local — cloud metadata lives at 169.254.169.254
    '172.16.0.0/12',      // RFC1918 private
    '192.0.0.0/24',       // IETF protocol assignments
    '192.0.2.0/24',       // TEST-NET-1
    '192.88.99.0/24',     // 6to4 relay anycast
    '192.168.0.0/16',     // RFC1918 private
    '198.18.0.0/15',      // benchmarking
    '198.51.100.0/24',    // TEST-NET-2
    '203.0.113.0/24',     // TEST-NET-3
    '224.0.0.0/4',        // multicast
    '240.0.0.0/4',        // reserved (covers 255.255.255.255)
];

/**
 * True only for addresses safe to let the server dial.
 * IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) v6 addresses are unwrapped and
 * re-checked as IPv4 — otherwise ::ffff:169.254.169.254 walks straight through a v6 check.
 */
export function isPublicIp(ip: string): boolean {
    const type = net.isIP(ip);
    if (type === 4) return !BLOCKED_V4.some((c) => inCidr4(ip, c));
    if (type !== 6) return false;

    const lower = ip.toLowerCase().split('%')[0];   // strip any zone index

    // Unwrap v4-in-v6 forms, both dotted (::ffff:1.2.3.4) and hex (::ffff:102:304).
    const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(.+)$/);
    if (embedded) {
        const tail = embedded[1];
        if (net.isIP(tail) === 4) return isPublicIp(tail);
        const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (hex) {
            const a = parseInt(hex[1], 16);
            const b = parseInt(hex[2], 16);
            return isPublicIp(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
        }
    }

    if (lower === '::' || lower === '::1') return false;         // unspecified / loopback
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false;          // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;          // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(lower)) return false;             // ff00::/8 multicast
    if (lower.startsWith('2001:db8:')) return false;             // documentation
    return true;
}

// ── URL + host validation ───────────────────────────────────────────────────

function parseAndValidateUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new SafeFetchError("That doesn't look like a valid link.", 'invalid_url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new SafeFetchError('Only http and https links can be added.', 'bad_scheme');
    }
    if (url.username || url.password) {
        throw new SafeFetchError('Links with embedded credentials are not supported.', 'embedded_credentials');
    }
    return url;
}

/**
 * URL.hostname keeps the brackets on IPv6 literals ('[::1]'), which net.isIP() does not
 * recognise. Without stripping them the IPv6-literal branch below never fires and such URLs
 * fall through to DNS, where they happen to fail — rejected by accident rather than by the
 * check that's supposed to reject them. Fail-closed, but only until a resolver surprises us.
 */
function normaliseHostname(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Resolve a hostname to the addresses we're willing to dial.
 * Rejects unless EVERY resolved address is public: a hostname answering with one public and
 * one private address is either misconfigured or an attack, and picking the "good" one would
 * be us choosing to ignore the bad one.
 */
async function resolveToPublicAddresses(rawHostname: string): Promise<Array<{ address: string; family: number }>> {
    const hostname = normaliseHostname(rawHostname);

    // A bare IP literal skips DNS entirely — validate it directly.
    const literal = net.isIP(hostname);
    if (literal) {
        if (!isPublicIp(hostname)) {
            throw new SafeFetchError('That link points to a private address.', 'private_address');
        }
        return [{ address: hostname, family: literal }];
    }

    let records: Array<{ address: string; family: number }>;
    try {
        records = await dns.lookup(hostname, { all: true });
    } catch {
        throw new SafeFetchError("We couldn't reach that link.", 'dns_failure');
    }
    if (records.length === 0) {
        throw new SafeFetchError("We couldn't reach that link.", 'dns_failure');
    }
    for (const r of records) {
        if (!isPublicIp(r.address)) {
            throw new SafeFetchError('That link points to a private address.', 'private_address');
        }
    }
    return records;
}

// ── The request itself ──────────────────────────────────────────────────────

interface HopResult {
    status: number;
    location?: string;
    contentType: string;
    body: string;
    /**
     * The undecoded bytes.
     *
     * ⚠️ Carried alongside `body` because a binary caller CANNOT use the decoded string:
     * `Buffer.toString('utf-8')` replaces every invalid sequence with U+FFFD, which silently and
     * irreversibly corrupts a JPEG. An image fetched through the text path would upload as a
     * broken file with no error anywhere.
     */
    bytes: Buffer;
}

/**
 * One HTTP hop, pinned to `addresses`. The `lookup` hook is what makes the pin real: node
 * calls it instead of the system resolver, so the socket connects to an address we validated
 * moments ago and a rebinding resolver never gets a second answer.
 */
function requestOnce(
    url: URL,
    addresses: Array<{ address: string; family: number }>,
    opts: { maxBytes: number; deadline: number; userAgent: string },
): Promise<HopResult> {
    return new Promise((resolve, reject) => {
        const lookup: LookupFunction = (_hostname, _options, callback) => {
            // Hand back only pre-validated addresses, preserving node's two callback shapes.
            const all = addresses.map((a) => ({ address: a.address, family: a.family }));
            if ((_options as { all?: boolean })?.all) (callback as (...a: unknown[]) => void)(null, all);
            else (callback as (...a: unknown[]) => void)(null, all[0].address, all[0].family);
        };

        const remaining = opts.deadline - Date.now();
        if (remaining <= 0) {
            reject(new SafeFetchError('That link took too long to respond.', 'timeout'));
            return;
        }

        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                protocol: url.protocol,
                // Unbracketed — node re-brackets IPv6 for the Host header itself.
                hostname: normaliseHostname(url.hostname),
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method: 'GET',
                lookup,
                timeout: remaining,
                headers: {
                    // Honest identification — a scraper that lies about who it is is one we
                    // shouldn't be running on a customer's behalf.
                    //
                    // ⚠️ Per-caller, because "honest" also means SPECIFIC. Every caller of this helper
                    // used to introduce itself as the Inspo Bot, including lead enrichment reading a
                    // prospect's contact page — so a site owner who looked us up in their logs was
                    // told the wrong thing about why we were there, and had no way to distinguish the
                    // two behaviours if they wanted to allow one and block the other.
                    'User-Agent': opts.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
                    // Identity encoding keeps the byte cap meaningful: a compressed body could
                    // sit under the cap on the wire and explode into a zip bomb once decoded.
                    'Accept-Encoding': 'identity',
                },
            },
            (res) => {
                const status = res.statusCode || 0;
                const contentType = String(res.headers['content-type'] || '');

                // Redirect: don't read the body, the caller re-validates the new target.
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.destroy();
                    resolve({ status, location: String(res.headers.location), contentType, body: '', bytes: Buffer.alloc(0) });
                    return;
                }

                // Trust-but-verify the advertised length; the streaming cap below is the real
                // enforcement since Content-Length can lie or be absent.
                const declared = Number(res.headers['content-length'] || 0);
                if (declared && declared > opts.maxBytes) {
                    res.destroy();
                    reject(new SafeFetchError('That page is too large to read.', 'too_large'));
                    return;
                }

                const chunks: Buffer[] = [];
                let total = 0;
                res.on('data', (chunk: Buffer) => {
                    total += chunk.length;
                    if (total > opts.maxBytes) {
                        res.destroy();
                        reject(new SafeFetchError('That page is too large to read.', 'too_large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const bytes = Buffer.concat(chunks);
                    resolve({ status, contentType, body: bytes.toString('utf-8'), bytes });
                });
                res.on('error', () => reject(new SafeFetchError("We couldn't read that link.", 'read_error')));
            },
        );

        req.on('timeout', () => {
            req.destroy();
            reject(new SafeFetchError('That link took too long to respond.', 'timeout'));
        });
        req.on('error', (err) => {
            if (err instanceof SafeFetchError) reject(err);
            else reject(new SafeFetchError("We couldn't reach that link.", 'network_error'));
        });
        req.end();
    });
}

/**
 * The identities this crawler may present, one per behaviour.
 *
 * Each names what we are doing and points at a page a site owner can read, which is the whole
 * contract a well-behaved crawler offers: you can tell who we are, why we came, and how to stop us.
 */
export const USER_AGENTS = {
    /** Reading a URL a USER pasted into the product (Inspo, brand kit, blog import). */
    inspo: 'Be More Swan Inspo Bot (+https://bemoreswan.com)',
    /** Lead enrichment: reading a prospect's own site for a published contact address. */
    leadDiscovery: 'BeMoreSwan-LeadDiscovery/1.0 (+https://bemoreswan.com)',
} as const;

export interface SafeFetchResult {
    finalUrl: string;
    contentType: string;
    body: string;
}

export interface SafeFetchBinaryResult {
    finalUrl: string;
    contentType: string;
    bytes: Buffer;
}

/**
 * Fetch a user-supplied URL as text, refusing anything that could reach private
 * infrastructure. Throws SafeFetchError (with a user-safe `message`) on any rejection.
 */
export async function safeFetchText(
    rawUrl: string,
    opts: {
        maxBytes?: number; timeoutMs?: number; maxRedirects?: number;
        /**
         * How this fetch introduces itself. Defaults to the Inspo Bot for the callers that were
         * here first; every new caller should pass its own from USER_AGENTS below rather than
         * inheriting a name that describes someone else's job.
         */
        userAgent?: string;
    } = {},
): Promise<SafeFetchResult> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const userAgent = opts.userAgent ?? USER_AGENTS.inspo;

    let url = parseAndValidateUrl(rawUrl);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        // Re-validated on EVERY hop — a public URL redirecting to 169.254.169.254 is the
        // textbook bypass, and only checking hop 0 would walk straight into it.
        const addresses = await resolveToPublicAddresses(url.hostname);
        const res = await requestOnce(url, addresses, { maxBytes, deadline, userAgent });

        if (res.location) {
            let next: URL;
            try {
                next = new URL(res.location, url);   // relative Location headers are legal
            } catch {
                throw new SafeFetchError('That link redirected somewhere invalid.', 'bad_redirect');
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                throw new SafeFetchError('That link redirected to an unsupported address.', 'bad_redirect');
            }
            url = parseAndValidateUrl(next.toString());
            continue;
        }

        if (res.status < 200 || res.status >= 300) {
            throw new SafeFetchError(`That link returned an error (${res.status}).`, 'http_error');
        }
        return { finalUrl: url.toString(), contentType: res.contentType, body: res.body };
    }

    throw new SafeFetchError('That link redirected too many times.', 'too_many_redirects');
}

/**
 * The same fenced fetch, returning UNDECODED bytes.
 *
 * ⚠️ Use this for anything that is not text. `safeFetchText` decodes as UTF-8, which replaces every
 * invalid byte sequence with U+FFFD — a JPEG round-tripped through it is silently destroyed, with
 * no error at any layer. The corruption only surfaces as "the advert has a broken image".
 *
 * Everything that makes safeFetchText safe applies unchanged: DNS resolved once and PINNED to the
 * socket, every redirect hop re-validated, private ranges refused, and a streaming byte cap that
 * does not trust Content-Length.
 */
export async function safeFetchBinary(
    rawUrl: string,
    opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; userAgent?: string } = {},
): Promise<SafeFetchBinaryResult> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const userAgent = opts.userAgent ?? USER_AGENTS.inspo;

    let url = parseAndValidateUrl(rawUrl);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        // Re-validated on EVERY hop, exactly as in safeFetchText — a public URL redirecting to
        // 169.254.169.254 is the textbook bypass.
        const addresses = await resolveToPublicAddresses(url.hostname);
        const res = await requestOnce(url, addresses, { maxBytes, deadline, userAgent });

        if (res.location) {
            let next: URL;
            try {
                next = new URL(res.location, url);
            } catch {
                throw new SafeFetchError('That link redirected somewhere invalid.', 'bad_redirect');
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                throw new SafeFetchError('That link redirected to an unsupported address.', 'bad_redirect');
            }
            url = parseAndValidateUrl(next.toString());
            continue;
        }

        if (res.status < 200 || res.status >= 300) {
            throw new SafeFetchError(`That link returned an error (${res.status}).`, 'http_error');
        }
        return { finalUrl: url.toString(), contentType: res.contentType, bytes: res.bytes };
    }

    throw new SafeFetchError('That link redirected too many times.', 'too_many_redirects');
}
