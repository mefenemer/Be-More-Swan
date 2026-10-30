// src/utils/linkedin-page.ts
// LinkedIn Company Page helpers: which app a connection belongs to, and the two Community
// Management reads the connect flow needs (which Pages may this member post as, what are they
// called). Network + env only — no database — so the blog destination and the self-test can import
// it without pulling the vault graph. Binding a chosen Page lives in linkedin-page-bind.ts.
//
// The switch and scopes are in src/config/linkedin-capabilities.ts, which explains the two apps.

import { LINKEDIN_API_VERSION } from './ad-networks/linkedin';

const ORG_URN_PREFIX = 'urn:li:organization:';

/** A Page connection stores its author URN as external_user_id; a member stores their `sub`. */
export function isLinkedInPageUrn(externalUserId: string | null | undefined): boolean {
    return typeof externalUserId === 'string' && externalUserId.startsWith(ORG_URN_PREFIX);
}

/**
 * The OAuth client a LinkedIn connection's token was issued to. Refresh and revoke MUST present the
 * same app the token came from, or LinkedIn rejects them — so this is decided by the connection's
 * own external_user_id, never by the current switch state (a Page connection made while the switch
 * was on must still refresh after it is turned off).
 */
export function linkedInClientFor(externalUserId: string | null | undefined): { clientId: string | undefined; clientSecret: string | undefined } {
    return isLinkedInPageUrn(externalUserId)
        ? { clientId: process.env.LINKEDIN_COMMUNITY_CLIENT_ID, clientSecret: process.env.LINKEDIN_COMMUNITY_CLIENT_SECRET }
        : { clientId: process.env.LINKEDIN_CLIENT_ID, clientSecret: process.env.LINKEDIN_CLIENT_SECRET };
}

export type LinkedInPage = { urn: string; name: string };

function restHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'Linkedin-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
    };
}

/** The Page's display name, or null when LinkedIn will not say. Never throws. */
export async function fetchLinkedInPageName(token: string, urn: string): Promise<string | null> {
    const id = urn.slice(ORG_URN_PREFIX.length);
    if (!/^\d+$/.test(id)) return null;
    try {
        const res = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, {
            headers: restHeaders(token), signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({})) as { localizedName?: string };
        return data.localizedName || null;
    } catch {
        return null;
    }
}

/** Cap on Pages named in the picker. An agency login can administer hundreds. */
const MAX_PAGES = 25;

/**
 * Pages the signed-in member can post as: APPROVED ADMINISTRATOR role assignments. Content
 * administrators can post too, but LinkedIn's role names have shifted between versions and an
 * administrator is the one role every version agrees can post, so that is what we ask for.
 * Throws with LinkedIn's own message when the call is refused, so the callback can log the reason.
 */
export async function listAdministeredPages(token: string): Promise<LinkedInPage[]> {
    const res = await fetch(
        'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100',
        { headers: restHeaders(token), signal: AbortSignal.timeout(8000) },
    );
    const data = await res.json().catch(() => ({})) as { elements?: Array<{ organization?: string }>; message?: string };
    if (!res.ok) throw new Error(data.message || `LinkedIn organizationAcls refused (${res.status})`);

    const urns = [...new Set((data.elements ?? []).map(e => e.organization).filter(isLinkedInPageUrn))] as string[];
    const named = await Promise.all(urns.slice(0, MAX_PAGES).map(async urn => ({
        urn,
        name: (await fetchLinkedInPageName(token, urn)) || `Page ${urn.slice(ORG_URN_PREFIX.length)}`,
    })));
    return named.sort((a, b) => a.name.localeCompare(b.name));
}
