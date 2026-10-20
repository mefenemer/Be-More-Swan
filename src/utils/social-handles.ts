// src/utils/social-handles.ts — the business's social profile addresses (organisations.social_handles).
//
// Business Information is where they live (assets.html, organisation-profile.ts). The Social Media
// Assistant's set-up asks for the same handles (onboarding-social-media.html), and writes what it
// collects back here through onboarding.ts — so the two pages can never disagree. Values are full
// profile URLs built in the browser by src/components/social-profile-url.js.

// Future-proof set of social platforms whose handles/URLs are captured on Business Information. Only
// a subset are connectable today (see integrations.js catalogue); the rest are accepted now so the
// handle is ready the moment a connector ships.
export const SOCIAL_HANDLE_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok', 'youtube', 'pinterest', 'threads'] as const;

/**
 * Sanitise a per-platform handles object: keep only known slugs, trim, cap length, drop blanks.
 * Returns null when nothing usable was supplied.
 */
export function cleanSocialHandles(v: unknown): Record<string, string> | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const src = v as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const p of SOCIAL_HANDLE_PLATFORMS) {
        const raw = src[p];
        const s = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
        if (s) out[p] = s;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Handles collected somewhere other than Business Information, laid over what is stored: a platform
 * the new set names takes the new address, every other platform keeps its own. Never removes one.
 */
export function mergeSocialHandles(stored: unknown, incoming: unknown): Record<string, string> | null {
    const add = cleanSocialHandles(incoming);
    if (!add) return null;
    return { ...(cleanSocialHandles(stored) ?? {}), ...add };
}
