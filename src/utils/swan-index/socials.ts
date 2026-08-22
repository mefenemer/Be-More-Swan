// src/utils/swan-index/socials.ts
// The Swan Index — a contributor's social profiles: what we accept, and how they render.
//
// ── Why the platform list is the product's, not a new one ──────────────────────────────────────
// SOCIAL_PLATFORMS in src/config/platform-formats.ts is already THE list of networks this product
// understands, and it exists because two hand-written copies of it drifted. A magazine profile is
// no reason for a third. Keyed by that type, so adding a platform there is a type error here until
// this file answers for it too.
//
// ── Why the host allowlist is not optional ─────────────────────────────────────────────────────
// These links sit on a masthead WE run, under an author's byline, on pages we ask search engines to
// index. A free-text URL field on that surface is a link farm with extra steps — the exact shape of
// the site-reputation abuse the whole publication is designed to stay clear of (see the noindex
// reasoning in db/swan-index.sql). So a value is stored only if it resolves to the platform it
// claims to be, and every link is emitted rel="nofollow me".

import type { SocialPlatform } from '../../config/platform-formats';

export interface SwanSocialSpec {
    label: string;
    /** Registrable hosts this platform's profiles live on. Subdomains are accepted (uk.linkedin.com). */
    hosts: string[];
    /** Build the canonical profile URL from a bare handle. */
    fromHandle: (handle: string) => string;
    /** 24×24 inline SVG children, drawn in currentColor. No external requests — see design.ts. */
    icon: string;
}

/**
 * Display order — professional first.
 *
 * Deliberately not SOCIAL_PLATFORMS' order (which is the composer's). A reader who has just
 * finished a piece about pricing follows the author on LinkedIn, not TikTok; putting the networks
 * business readers actually use first is the whole reason the row is on an article page.
 */
export const SWAN_SOCIAL_ORDER: SocialPlatform[] = ['linkedin', 'x', 'instagram', 'facebook', 'threads', 'youtube'];

export const SWAN_SOCIALS: Record<SocialPlatform, SwanSocialSpec> = {
    linkedin: {
        label: 'LinkedIn',
        hosts: ['linkedin.com'],
        fromHandle: (h) => `https://www.linkedin.com/in/${h}`,
        icon: '<rect x="3" y="3" width="18" height="18" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/>'
            + '<circle cx="7.9" cy="8" r="1.25" fill="currentColor"/>'
            + '<rect x="7" y="10.4" width="1.85" height="6.7" fill="currentColor"/>'
            + '<path d="M11.4 17.1v-6.7h1.85v.95c.5-.72 1.3-1.12 2.2-1.12 1.72 0 2.8 1.1 2.8 3.02v3.85h-1.9v-3.5c0-1.1-.5-1.72-1.42-1.72-.95 0-1.63.68-1.63 1.8v3.42Z" fill="currentColor"/>',
    },
    x: {
        label: 'X',
        hosts: ['x.com', 'twitter.com'],
        fromHandle: (h) => `https://x.com/${h}`,
        icon: '<path d="M5 4.6 19 19.4M19 4.6 5 19.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
    },
    instagram: {
        label: 'Instagram',
        hosts: ['instagram.com'],
        fromHandle: (h) => `https://www.instagram.com/${h}`,
        icon: '<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/>'
            + '<circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.7"/>'
            + '<circle cx="17.2" cy="6.8" r="1.15" fill="currentColor"/>',
    },
    facebook: {
        label: 'Facebook',
        hosts: ['facebook.com', 'fb.com'],
        fromHandle: (h) => `https://www.facebook.com/${h}`,
        icon: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/>'
            + '<path d="M13.35 20.9v-7.05h2.02l.36-2.42h-2.38v-1.4c0-.7.22-1.18 1.2-1.18h1.28V6.68a17 17 0 0 0-1.87-.1c-1.9 0-3.2 1.14-3.2 3.24v1.61H8.73v2.42h2.03v7.05Z" fill="currentColor"/>',
    },
    threads: {
        label: 'Threads',
        // Meta moved the product to threads.com during 2025; threads.net still resolves and is
        // what most people have copied into a bio, so both are accepted.
        hosts: ['threads.net', 'threads.com'],
        fromHandle: (h) => `https://www.threads.com/@${h}`,
        icon: '<path d="M12.15 20.4c-4.6 0-7.05-2.85-7.05-8.4S7.55 3.6 12.15 3.6c4.05 0 6.4 2.2 6.95 5.4"'
            + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
            + '<path d="M12.15 20.4c3.1 0 5.1-1.55 5.1-3.85 0-2.6-2.4-3.95-5.2-3.95-1.75 0-3 .8-3 2.05 0 1.15 1 1.9 2.3 1.9 1.75 0 2.9-1.35 2.9-3.6 0-2.4-1.2-3.85-3.15-3.9-1.3-.03-2.3.5-2.9 1.45"'
            + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    },
    youtube: {
        label: 'YouTube',
        hosts: ['youtube.com', 'youtu.be'],
        fromHandle: (h) => `https://www.youtube.com/@${h}`,
        icon: '<rect x="2.6" y="5.6" width="18.8" height="12.8" rx="4" fill="none" stroke="currentColor" stroke-width="1.7"/>'
            + '<path d="M10.3 9.35 16 12l-5.7 2.65Z" fill="currentColor"/>',
    },
};

/** A bare handle: what someone types when they don't paste a URL. '@' is tolerated and stripped. */
const HANDLE_RE = /^@?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function hostMatches(host: string, base: string): boolean {
    return host === base || host.endsWith(`.${base}`);
}

export type SocialParse = { ok: true; url: string } | { ok: false; error: string };

/**
 * Normalise one field into a stored URL, or say why it can't be.
 *
 * Accepts a pasted profile URL (with or without a scheme) or a bare handle, because both are what
 * people actually have to hand — and rejecting "@janesmith" with a lecture about URLs is how a
 * profile ends up empty.
 */
export function normaliseSocial(platform: SocialPlatform, raw: string): SocialParse {
    const spec = SWAN_SOCIALS[platform];
    const value = String(raw || '').trim();
    if (!value) return { ok: true, url: '' };
    if (value.length > 300) return { ok: false, error: `That ${spec.label} link is too long.` };

    // A handle, not a URL: no dot, no slash, no scheme. Built into the canonical profile URL so the
    // stored value is always something a reader can click.
    if (!/[./\\:]/.test(value)) {
        if (!HANDLE_RE.test(value)) return { ok: false, error: `That doesn't look like a ${spec.label} username.` };
        return { ok: true, url: spec.fromHandle(value.replace(/^@/, '')) };
    }

    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
        return { ok: false, error: `That ${spec.label} link isn't a valid web address.` };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, error: `${spec.label} links must start with https://.` };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!spec.hosts.some((h) => hostMatches(host, h))) {
        return { ok: false, error: `That isn't a ${spec.label} address — it points at ${url.hostname}.` };
    }
    // Rebuilt rather than echoed: drops credentials, ports and the tracking query strings that
    // come attached to a copied profile link.
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    url.port = '';
    url.search = '';
    url.hash = '';
    return { ok: true, url: url.toString().replace(/\/$/, '') };
}

export type SocialsMap = Partial<Record<SocialPlatform, string>>;

/** Read a stored jsonb blob back as a map, dropping anything that no longer validates. */
export function readSocials(stored: unknown): SocialsMap {
    const out: SocialsMap = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
    for (const platform of SWAN_SOCIAL_ORDER) {
        const raw = (stored as Record<string, unknown>)[platform];
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const parsed = normaliseSocial(platform, raw);
        if (parsed.ok && parsed.url) out[platform] = parsed.url;
    }
    return out;
}

/**
 * Validate a whole submitted map. Every bad field is reported, not just the first — a form that
 * surfaces one error per save is a form people abandon.
 */
export function parseSocials(input: unknown): { ok: true; socials: SocialsMap } | { ok: false; errors: string[] } {
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {};
    const socials: SocialsMap = {};
    const errors: string[] = [];
    for (const platform of SWAN_SOCIAL_ORDER) {
        const raw = src[platform];
        if (raw === undefined || raw === null) continue;
        if (typeof raw !== 'string') { errors.push(`${SWAN_SOCIALS[platform].label} must be a link or username.`); continue; }
        const parsed = normaliseSocial(platform, raw);
        if (!parsed.ok) { errors.push(parsed.error); continue; }
        if (parsed.url) socials[platform] = parsed.url;
    }
    return errors.length ? { ok: false, errors } : { ok: true, socials };
}

export interface SocialEntry { platform: SocialPlatform; label: string; url: string; icon: string }

/** The links a page should draw, in display order. */
export function socialEntries(socials: SocialsMap | null | undefined): SocialEntry[] {
    if (!socials) return [];
    return SWAN_SOCIAL_ORDER
        .filter((p) => !!socials[p])
        .map((p) => ({ platform: p, label: SWAN_SOCIALS[p].label, url: socials[p]!, icon: SWAN_SOCIALS[p].icon }));
}
