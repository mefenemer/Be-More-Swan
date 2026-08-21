// src/utils/swan-index/base-url.ts
// The publication's own origin.
//
// Deliberately NOT src/utils/base-url.ts. That one resolves the APP's origin (bemoreswan.com) and
// falls back to the request host — correct for the app, wrong here in a way that would be silent:
// while the two sites share a deployment, a request arriving on the app domain would make every
// canonical, og:url and syndication URL claim the article lives on bemoreswan.com. Those strings
// are written into blog_posts.destinations and shared by authors, so a wrong one outlives the
// request that produced it.
//
// SWAN_INDEX_BASE_URL is therefore the ONLY source, with a hardcoded production fallback so the
// value is right before anyone remembers to set the variable.

export const SWAN_INDEX_DEFAULT_ORIGIN = 'https://theswanindex.com';

/** The publication origin, without a trailing slash. */
export function swanIndexBaseUrl(): string {
    const raw = process.env.SWAN_INDEX_BASE_URL?.trim();
    if (raw) return raw.replace(/\/+$/, '');
    return SWAN_INDEX_DEFAULT_ORIGIN;
}
