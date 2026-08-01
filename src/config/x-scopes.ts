// src/config/x-scopes.ts
// The single definition of the OAuth 2.0 scopes we request from X.
//
// This existed as three hand-synced string literals — social-oauth-init (the authorize URL),
// social-oauth-callback (what we persist onto the connection row) and integrations.ts
// (the scope-creep allow-list). Two of them carried a "keep in step with" comment, which is
// the comment you write when the compiler can't hold the invariant for you.
//
// They drifted in the way that costs you posts rather than the way that throws: every copy
// omitted `media.write`. `tweet.write` alone is enough to publish TEXT, so text-only posts
// went out fine and nothing looked broken — but the v2 media endpoints
// (POST /2/media/upload and the chunked initialize/append/finalize path in social-publish.ts)
// require `media.write` in their own right. The v1.1 upload.twitter.com host we used to call
// did not, so the endpoint migration silently invalidated the scope set.
//
// The failure surfaced as a bare 403 with no `detail` body — X returns only `Forbidden` for a
// scope the token does not hold — which publishX turns into a permanent "media could not be
// uploaded" and the post is never attempted. Every X post carrying an image or video failed.
//
// ⚠️ Changing this string does NOT change tokens already issued. A grant is minted with the
// scopes present at authorize time and keeps them for its whole refresh lifetime, so existing
// connections keep failing until the user disconnects and reconnects X. Widening this list
// means a reconnect campaign, not just a deploy.
export const X_OAUTH_SCOPE_LIST = [
    'tweet.read',
    'tweet.write',
    'users.read',
    'media.write',    // required by the v2 media upload endpoints; NOT implied by tweet.write
    'offline.access', // yields the refresh token refresh-social-tokens.ts depends on
] as const;

/** Space-delimited form, as X's authorize URL and our `scopes` column both want it. */
export const X_OAUTH_SCOPES = X_OAUTH_SCOPE_LIST.join(' ');

/**
 * Scopes a connection must hold to publish media. Used by the preflight audit to tell a user
 * their token is under-scoped BEFORE a scheduled post burns an attempt discovering it.
 */
export const X_MEDIA_SCOPES = ['media.write'] as const;
