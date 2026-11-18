// src/config/linkedin-capabilities.ts
// What LinkedIn lets us do, and the switch for Company Page posting.
//
// There are THREE LinkedIn apps. LinkedIn only grants Community Management to an app that carries
// no other product, and advertising lives on its own app so spend never shares a client with posting:
//
//   · "Be More Swan" (LINKEDIN_CLIENT_ID) — Sign In with LinkedIn using OpenID Connect + Share on
//     LinkedIn, scopes `openid profile email w_member_social`. MEMBER posting: content goes to the
//     connected person's own feed. Always on.
//
//   · "Be More Swan Community" (LINKEDIN_COMMUNITY_CLIENT_ID, client 77xf9jrywcupr8) — Community
//     Management API only. COMPANY PAGE posting: the author is urn:li:organization:<id>. Access was
//     requested 2026-10-30 (Platform; Page management + Page analytics) and starts at LinkedIn's
//     Development tier, which only reaches Pages the signing-in member administers.
//
//   · "Be More Swan Adverts" (LINKEDIN_ADS_CLIENT_ID, client 77ji7h15dgy32l) — Advertising API
//     only, scopes `rw_ads r_ads_reporting`. Created + Development Tier requested 2026-11-18 (Platform;
//     Campaign Management + Reporting and ROI). Used ONLY by linkedin-ads-oauth-{init,callback};
//     its connection is a separate row (service_name 'linkedin_ads'). Never falls back to the main
//     app's keys: that app holds no ads product, so LinkedIn would refuse the whole authorization.
//
// A workspace holds ONE LinkedIn connection (service_name 'linkedin'). Its external_user_id says
// which app it belongs to: a member `sub` → the main app, a `urn:li:organization:*` → Community.
// See src/utils/linkedin-page.ts.
//
// Company Page posting is OFF until all three are set in the environment:
//   LINKEDIN_COMMUNITY_CLIENT_ID, LINKEDIN_COMMUNITY_CLIENT_SECRET, LINKEDIN_PAGE_POSTING=on
// The flag is separate from the credentials so the keys can sit in Netlify before LinkedIn approves
// the product: requesting Community scopes on an unapproved app fails the whole authorization.

/** True when the Company Page connect option is offered and Page connections may be made. */
export function linkedinPageAccessEnabled(): boolean {
    return !!process.env.LINKEDIN_COMMUNITY_CLIENT_ID
        && !!process.env.LINKEDIN_COMMUNITY_CLIENT_SECRET
        && ['1', 'true', 'yes', 'on'].includes(String(process.env.LINKEDIN_PAGE_POSTING ?? '').trim().toLowerCase());
}

/**
 * Scopes for the Community app. Space-delimited (RFC 6749 §3.3). LinkedIn refuses the WHOLE
 * authorization if any one is not granted to the app, so once Community Management is approved,
 * compare this against the app's Auth tab. LINKEDIN_PAGE_SCOPES overrides it without a deploy.
 *   rw_organization_admin — list the Pages the member administers (organizationAcls), read names
 *   w_organization_social — post, comment and react as the Page
 *   r_organization_social — read the Page's own posts and their engagement (Results tab)
 */
export const LINKEDIN_PAGE_DEFAULT_SCOPES = 'rw_organization_admin w_organization_social r_organization_social';

export function linkedinPageScopes(): string {
    const override = String(process.env.LINKEDIN_PAGE_SCOPES ?? '').trim().replace(/[\s,]+/g, ' ');
    return override || LINKEDIN_PAGE_DEFAULT_SCOPES;
}

/** Shown wherever we have to explain why a Page-level action did not happen. */
export const LINKEDIN_MEMBER_ONLY_REASON =
    'This LinkedIn connection posts to a personal feed. Page-level actions need a Company Page connection — reconnect LinkedIn and choose your Company Page.';

/**
 * The OAuth client for the ADVERTISING flow — the "Be More Swan Adverts" app, never the main app.
 * Both values undefined → the ads connect answers `ads_error=not_configured` rather than borrowing
 * LINKEDIN_CLIENT_ID, which holds no ads product and would fail the whole authorization.
 */
export function linkedInAdsClient(): { clientId: string | undefined; clientSecret: string | undefined } {
    return {
        clientId: process.env.LINKEDIN_ADS_CLIENT_ID || undefined,
        clientSecret: process.env.LINKEDIN_ADS_CLIENT_SECRET || undefined,
    };
}
