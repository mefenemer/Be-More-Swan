// src/utils/site-hosting.ts — where a published Website Assistant site lives, and who may be named
// there. docs/website-assistant-plan.md §5.2, decision D3. PURE: no database, no network.
// tests/site-hosting.test.ts.
//
// Every site is served at https://<slug>.<SITES_DOMAIN>. SITES_DOMAIN is a domain of its OWN
// (bemoreswan.site), never a subdomain of bemoreswan.com: customer content must not share cookies
// or blocklist reputation with the app.
//
// How a request reaches us (sites-host/): a separate Netlify project owns *.bemoreswan.site; its one
// edge function forwards the host and path, with SITE_SERVE_SECRET, to netlify/functions/site-serve.ts
// on the app. Without the secret site-serve answers nothing, so customer HTML is never served from
// bemoreswan.com itself.

import type { SiteDefinition } from './site-definition';
import { newsletterMediaUrl } from './newsletter-media-url';

export const DEFAULT_SITES_DOMAIN = 'bemoreswan.site';

/** The domain sites are served under. SITES_DOMAIN overrides (e.g. a staging domain). */
export function sitesDomain(env: Record<string, string | undefined> = process.env): string {
    const d = (env.SITES_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : DEFAULT_SITES_DOMAIN;
}

export const SITE_SLUG_MIN = 3;
export const SITE_SLUG_MAX = 40;

/** Addresses nobody may take as the WHOLE address: ours, and generic words that would look official. */
export const RESERVED_SITE_SLUGS = new Set([
    'www', 'app', 'api', 'admin', 'administrator', 'mail', 'email', 'smtp', 'imap', 'ftp', 'ns1', 'ns2', 'dns',
    'cdn', 'static', 'assets', 'status', 'help', 'support', 'docs', 'blog', 'news', 'shop', 'store', 'billing',
    'pay', 'payment', 'payments', 'checkout', 'account', 'accounts', 'register', 'secure', 'security', 'auth',
    'oauth', 'sso', 'reset', 'wallet', 'bank', 'banking', 'invoice', 'refund', 'test', 'staging', 'dev',
    'preview', 'demo', 'example', 'root', 'system', 'official', 'abuse', 'postmaster', 'hostmaster',
    'webmaster', 'report', 'legal', 'swan', 'apple', 'stripe', 'outlook', 'meta',
]);

/**
 * Words refused ANYWHERE in an address (each hyphen-part is checked): our own names, the brands a
 * phishing page would pretend to be, and the words such a page needs ("paypal-login",
 * "verify-account"). A business that genuinely needs one asks us.
 */
export const BLOCKED_SITE_SLUG_WORDS = new Set([
    'bemoreswan', 'swanindex', 'theswanindex', 'auraassist',
    'login', 'logon', 'signin', 'password', 'verify', 'verification', 'unlock', 'suspended',
    'paypal', 'icloud', 'google', 'gmail', 'microsoft', 'office365', 'amazon',
    'facebook', 'instagram', 'whatsapp', 'linkedin', 'twitter', 'tiktok', 'netflix', 'hmrc', 'govuk', 'gov',
    'nhs', 'dvla', 'royalmail', 'barclays', 'hsbc', 'lloyds', 'natwest', 'santander', 'monzo', 'revolut',
    'coinbase', 'binance', 'metamask',
]);

/** A business name → a candidate address (not yet checked for being taken). */
export function suggestSiteSlug(name: string): string {
    const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, SITE_SLUG_MAX).replace(/-+$/, '');
    if (s.length >= SITE_SLUG_MIN && !siteSlugProblem(s)) return s;
    const padded = `${s || 'my'}-site`.replace(/^-+/, '').slice(0, SITE_SLUG_MAX);
    return siteSlugProblem(padded) ? 'my-new-site' : padded;
}

/** Lower-cases and trims what was typed; '.bemoreswan.site' typed on the end is dropped. */
export function cleanSiteSlugInput(raw: unknown, domain = sitesDomain()): string {
    let s = String(raw ?? '').trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (s.endsWith(`.${domain}`)) s = s.slice(0, -(domain.length + 1));
    return s;
}

/** Why this address cannot be used, in plain words — or null when it can (if nobody has it). */
export function siteSlugProblem(slug: string): string | null {
    if (slug.length < SITE_SLUG_MIN) return `Use at least ${SITE_SLUG_MIN} letters or numbers.`;
    if (slug.length > SITE_SLUG_MAX) return `Use ${SITE_SLUG_MAX} characters or fewer.`;
    if (!/^[a-z0-9-]+$/.test(slug)) return 'Use only lower-case letters, numbers and hyphens.';
    if (slug.startsWith('-') || slug.endsWith('-')) return 'It can\'t start or end with a hyphen.';
    if (slug.includes('--')) return 'It can\'t have two hyphens in a row.';
    if (/^[0-9-]+$/.test(slug)) return 'Include at least one letter.';
    if (RESERVED_SITE_SLUGS.has(slug) || slug.split('-').some((part) => BLOCKED_SITE_SLUG_WORDS.has(part))) {
        return 'That address is reserved. Try one based on your business name.';
    }
    return null;
}

export function siteOrigin(slug: string, domain = sitesDomain()): string {
    return `https://${slug}.${domain}`;
}

/**
 * The slug a request's Host names, or null when it is not a site address: the bare domain, www,
 * anything deeper than one label, or another domain altogether. A port is ignored.
 */
export function slugFromHost(host: string | null | undefined, domain = sitesDomain()): string | null {
    const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!h.endsWith(`.${domain}`)) return null;
    const label = h.slice(0, -(domain.length + 1));
    if (!label || label.includes('.') || label === 'www') return null;
    return /^[a-z0-9-]{1,63}$/.test(label) ? label : null;
}

/** Stable JSON (sorted keys) — so "has the draft changed since it was published?" is a string compare. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value as Record<string, unknown>).sort()
            .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

export function sameDefinition(a: SiteDefinition | null | undefined, b: SiteDefinition | null | undefined): boolean {
    if (!a || !b) return false;
    return canonicalJson(a) === canonicalJson(b);
}

/** Every word a visitor would read — what the safety check reads before a publish. */
export function siteVisibleText(def: SiteDefinition): string {
    const out: string[] = [];
    const walk = (v: unknown, key = '') => {
        if (typeof v === 'string') {
            // Addresses and ids are not prose; picture addresses are checked as links, not text.
            if (!/^(id|href|url|slug|primaryColor|textColor|backgroundColor|font|radius|layout|type|businessType|logoUrl)$/.test(key)) out.push(v);
        } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk({ settings: def.settings, footer: def.footer, pages: def.pages });
    return out.filter((s) => s.trim()).join('\n');
}

/**
 * The public link for a library picture on a site: the same signed, permanent link sent emails use
 * (newsletter-media-url.ts) — it redirects to a fresh copy each time, so it never expires. Null when
 * links cannot be signed here (no JWT_SECRET), in which case the picture is simply not drawn.
 */
export function siteAssetUrl(appOrigin: string, assetId: number): string | null {
    try { return newsletterMediaUrl(appOrigin, assetId); } catch { return null; }
}

export const REPORT_REASONS = {
    scam: 'A scam or fraud',
    impersonation: 'Pretending to be someone else',
    harmful: 'Harmful, hateful or illegal content',
    copyright: 'Uses my work without permission',
    other: 'Something else',
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;
export const isReportReason = (v: unknown): v is ReportReason => typeof v === 'string' && Object.hasOwn(REPORT_REASONS, v);

/** How many earlier versions are kept per site. */
export const KEEP_VERSIONS = 20;
