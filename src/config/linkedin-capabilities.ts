// src/config/linkedin-capabilities.ts
// What the LinkedIn app is actually allowed to do, as one switch.
//
// The app's approved products are "Sign In with LinkedIn using OpenID Connect" and
// "Share on LinkedIn", which grant `openid profile email w_member_social`. That is
// MEMBER posting only: content goes to the connected person's own feed.
//
// Company-Page posting and reading/writing organisation data need the Community
// Management API product — a written application to LinkedIn with a review, not a
// self-serve toggle. Until that is granted, any call to /v2/organizationAcls,
// /v2/organizations/* or an author URN of urn:li:organization:* will 403.
//
// When Community Management IS approved: flip this to true, add
// `r_organization_admin w_organization_social` to the scope strings in
// social-oauth-init.ts + social-oauth-callback.ts, update the assertion in
// tests/social-oauth-request.test.ts, and have every connected user re-authorise
// (existing tokens do not gain scopes retroactively).
export const LINKEDIN_ORGANISATION_ACCESS = false;

/** Shown wherever we have to explain why a Page-level action did not happen. */
export const LINKEDIN_MEMBER_ONLY_REASON =
    'This app can post to your personal LinkedIn feed only. Posting to a Company Page needs LinkedIn’s Community Management access, which we have not been granted yet.';
