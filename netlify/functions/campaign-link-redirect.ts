// netlify/functions/campaign-link-redirect.ts
// Campaign Assistant, Phase A — the public click recorder.
//
// Behind a netlify.toml rewrite:  /go/*  →  /.netlify/functions/campaign-link-redirect
//   GET  /go/:token   → record a click, 302 to the link's destination with ?bmsc=<clickRef>
//   HEAD /go/:token   → 302, recording NOTHING
//
// Pure functions live in src/utils/campaign-attribution.ts; tables in db/campaign-attribution.sql.
//
// ── This endpoint is PUBLIC and unauthenticated ─────────────────────────────────────────────────
// It has no session to scope by, so the token IS the capability. The safety property, stated so it
// can be checked: this function never reads an organisation id, campaign id or destination from
// the request. All three come from the single campaign_links row the token resolves to. Nothing
// the caller sends can redirect the click to another org's campaign or to a URL of their choosing.
// If a future change starts trusting a query parameter for any of those, that is the invariant it
// broke.
//
// ── Three ways this quietly breaks, all guarded below ───────────────────────────────────────────
//
// 1. A CACHED REDIRECT RECORDS NO CLICK. A 302 is cacheable by default, and Netlify's CDN, every
//    corporate proxy and the browser itself will happily serve the second click from cache without
//    ever reaching this function. The click counter would then plateau after roughly one hit per
//    edge node and look like an ad that stopped working. `Cache-Control: no-store` is not
//    hygiene here, it is the feature.
//
// 2. HEAD MUST NOT COUNT. Mail scanners, link-preview bots, antivirus proxies and Slack unfurls
//    fetch every URL in a message. audience-public.ts has the same rule in the other direction
//    (a GET must not confirm a subscription) for exactly this reason. Requests we know are not a
//    person get a redirect and no ledger row.
//
// 3. A LEDGER FAILURE MUST NOT EAT THE CLICK. The person clicked an ad; they are entitled to
//    arrive. revenue-ledger.ts settled this contract already — the ledger is an OBSERVER of the
//    journey, never a participant. So the write is wrapped, failures are logged and swallowed, and
//    the redirect happens regardless. The corollary is the thing to remember when clicks go
//    missing: a silent no-op is a real outcome here, so look for the console.error below before
//    concluding the link was never clicked.

import { HandlerEvent, HandlerResponse } from '@netlify/functions';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { campaignLinks, campaignClickEvents } from '../../db/schema';
import {
    appendClickRef, buildVisitorCookie, extractNetworkClick, extractUtm, isLinkToken,
    isProbableBot, mintClickRef, mintVisitorId, readVisitorCookie, refererHost,
} from '../../src/utils/campaign-attribution';
import { pseudonymiseIp } from '../../src/utils/ip-pseudonymise';
import { getClientIp } from '../../src/utils/rate-limit';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * Where an unknown, malformed or archived token goes.
 *
 * Deliberately a redirect to our own homepage rather than a 404. Someone reaching here clicked a
 * link in an advert; a 404 is a dead end that reflects on the tenant who paid for the click. It
 * also declines to confirm whether a token exists, which is the same reasoning as
 * audience-public.ts returning one identical body for every failure.
 */
function fallback(headers: Record<string, string | undefined>): HandlerResponse {
    const base = resolveBaseUrl(headers) || 'https://bemoreswan.com';
    return {
        statusCode: 302,
        headers: { Location: base, 'Cache-Control': 'no-store' },
        body: '',
    };
}

export default withLambda(async (event: HandlerEvent): Promise<HandlerResponse> => {
    const headers = (event.headers || {}) as Record<string, string | undefined>;

    if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
        return { statusCode: 405, headers: { 'Cache-Control': 'no-store' }, body: '' };
    }

    // Parse /go/:token from the ORIGINAL, pre-rewrite path. `event.path` is the rewritten
    // function path and would never contain the token — the same rawUrl dependency widget-api.ts
    // and the OAuth callbacks rely on.
    const rawUrl = event.rawUrl || '';
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return fallback(headers);
    }
    const match = url.pathname.match(/\/go\/([^/?#]+)/);
    const token = match?.[1];
    if (!isLinkToken(token)) return fallback(headers);

    const db = getDb();
    const [link] = await db
        .select({
            id: campaignLinks.id,
            organisationId: campaignLinks.organisationId,
            campaignId: campaignLinks.campaignId,
            destinationUrl: campaignLinks.destinationUrl,
        })
        .from(campaignLinks)
        .where(and(eq(campaignLinks.token, token), isNull(campaignLinks.archivedAt)))
        .limit(1);

    if (!link) return fallback(headers);

    const clickRef = mintClickRef();
    const destination = (() => {
        try {
            return appendClickRef(link.destinationUrl, clickRef);
        } catch {
            // A destination that no longer parses is a data problem, not the clicker's problem.
            // Send them to the raw stored value rather than to a 500.
            return link.destinationUrl;
        }
    })();

    // Reuse the browser's existing visitor id where it has one, so a person who clicks three of a
    // tenant's links is one visitor across all three rather than three strangers.
    const existingVisitor = readVisitorCookie(headers.cookie || headers.Cookie);
    const visitorId = existingVisitor || mintVisitorId();

    // Guard 2: a HEAD is a machine. Redirect, record nothing, set no cookie.
    if (event.httpMethod === 'HEAD') {
        return { statusCode: 302, headers: { Location: destination, 'Cache-Control': 'no-store' }, body: '' };
    }

    // Guard 3: the ledger observes; it never blocks the journey.
    try {
        const networkClick = extractNetworkClick(url.searchParams);
        await db.insert(campaignClickEvents).values({
            organisationId: link.organisationId,
            campaignId: link.campaignId,
            linkId: link.id,
            visitorId,
            clickRef,
            networkClickId: networkClick?.id ?? null,
            networkClickKind: networkClick?.kind ?? null,
            utm: extractUtm(url.searchParams),
            ipPrefix: pseudonymiseIp(getClientIp(headers)),
            refererHost: refererHost(headers.referer || headers.Referer),
            isProbableBot: isProbableBot(headers['user-agent']),
        });
    } catch (err) {
        console.error('[campaign-link-redirect] click not recorded', err);
    }

    // `secure` follows the resolved base URL so local http development can still set a cookie.
    // Everywhere real this is https, so SameSite=None; Secure — which is what makes the cookie
    // survive the cross-site POST back from a tenant's own capture form.
    const secure = !(resolveBaseUrl(headers) || '').startsWith('http://');

    return {
        statusCode: 302,
        headers: {
            Location: destination,
            // Guard 1. Without this the CDN answers later clicks itself and they are never counted.
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Set-Cookie': buildVisitorCookie(visitorId, secure),
            // A tracked link is not a page; keep it out of the index and out of referrers.
            'X-Robots-Tag': 'noindex, nofollow',
            'Referrer-Policy': 'no-referrer',
        },
        body: '',
    };
});
