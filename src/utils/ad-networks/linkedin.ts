// src/utils/ad-networks/linkedin.ts
// The real LinkedIn Advertising API adapter. DEVELOPMENT TIER — see registry.ts for the gate.
//
// Written against the versioned Marketing API docs (li-lms-2026-08), not from memory:
//   campaigns  https://learn.microsoft.com/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns
//   creatives  https://learn.microsoft.com/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives
//   reporting  https://learn.microsoft.com/linkedin/marketing/integrations/ads-reporting/ads-reporting
//
// ⚠️ NOT YET EXERCISED AGAINST THE LIVE API. Every path here is doc-accurate and unit-tested for
// URL and body shape, but no call has ever been made with a real token — there is no ads-scoped
// token to make one with yet (see "The missing prerequisite" below). Treat a first live run as a
// smoke test, not a regression.
//
// ── Development Tier is a 5-account edit cap, not a sandbox ─────────────────────────────────────
// Read-only on unlimited ad accounts, EDIT on up to five. So a pilot with up to five real customer
// ad accounts is possible today; Standard Tier is only needed to manage campaigns across many. The
// cap is LinkedIn's, enforced on their side, and we cannot detect it in advance — a sixth account
// fails at write time, which is why activateCampaign surfaces the API's own error text.
//
// ── The missing prerequisite ────────────────────────────────────────────────────────────────────
// This adapter needs a token carrying `rw_ads` (write) and `r_ads_reporting` (read). The workspace
// LinkedIn connection carries `openid profile email w_member_social` and NOTHING ELSE. Those ads
// scopes must NOT simply be appended to that connector's scope string: LinkedIn refuses the ENTIRE
// authorization when an app requests a scope it does not hold, which is what took production down
// on 2026-07-20 — and even once granted, it would ask every user connecting LinkedIn merely to post
// for permission to spend money. Ads authorisation belongs in its own flow.
//
// ── The invariant this file must never break ────────────────────────────────────────────────────
// `stageCampaign` creates the campaign with status PAUSED. Creatives are created ACTIVE, which is
// safe and deliberate: LinkedIn documents that the parent campaign's status OVERRIDES a creative's
// intended status, so nothing serves while the campaign is paused, and approval becomes a single
// atomic flip of one field rather than N creative updates that could half-succeed.

import type {
    AdNetworkAdapter, StageCampaignInput, StageCampaignResult, VariantMetrics,
} from './types';

/**
 * ⚠️ Versioned API. This header is REQUIRED on every call and LinkedIn sunsets versions on a
 * schedule — 202508 was retired on 2026-08-17. Bump deliberately after reading the migration notes;
 * an unsupported value fails every request at once.
 */
export const LINKEDIN_API_VERSION = '202608';
const BASE = 'https://api.linkedin.com/rest';

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'Linkedin-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        ...extra,
    };
}

// ── Pure builders, exported so the risky shapes are testable without a token ─────────────────────

/** `urn:li:sponsoredAccount:123` → `123`. Accepts either form so callers need not care. */
export function accountId(account: string): string {
    const m = String(account).match(/(\d+)\s*$/);
    if (!m) throw new Error(`Not a usable LinkedIn ad account: ${account}`);
    return m[1];
}

/**
 * The campaign creation body.
 *
 * ⚠️ `status: 'PAUSED'` is the human-in-the-loop rule made concrete. The API accepts 'ACTIVE' here
 * and the docs' own example uses it — creating an ACTIVE campaign is one word away, and it would
 * begin spending immediately with nobody having approved anything.
 *
 * `DRAFT` was considered and rejected: LinkedIn postpones validation on drafts, so errors would
 * surface at approval time — in front of the user, after they clicked — instead of at staging.
 * PAUSED means "meets all requirements to be served, but temporarily shouldn't be", which is
 * exactly what a staged campaign is.
 */
export function campaignCreateBody(input: {
    accountUrn: string;
    campaignGroupUrn: string;
    name: string;
    dailyBudgetAmount: string;
    currencyCode: string;
    targeting: Record<string, unknown>;
    startMs: number;
    endMs?: number | null;
}): Record<string, unknown> {
    return {
        account: input.accountUrn,
        campaignGroup: input.campaignGroupUrn,
        name: input.name,
        type: 'SPONSORED_UPDATES',
        creativeSelection: 'OPTIMIZED',
        audienceExpansionEnabled: false,
        offsiteDeliveryEnabled: false,

        // ── Bidding: AUTO, and this trio must move together ──────────────────
        // ⚠️ THE FIRST DRAFT WOULD HAVE CREATED A CAMPAIGN THAT NEVER DELIVERED. It sent
        // `costType: 'CPC'` with no `optimizationTargetType` and no `unitCost`. Absent
        // optimizationTargetType defaults to NONE, which is MANUAL bidding; unitCost then defaults
        // to 0; and LinkedIn documents that under manual bidding "if unitCost is 0, the campaign
        // does not deliver". No error — just an ad that never runs, which is the worst failure
        // shape available: it looks launched.
        //
        // MAX_CLICK is auto-bidding: LinkedIn spends the daily budget chasing clicks without an
        // advertiser specifying a bid. That is the right model for this product twice over — the
        // destination is a tracked link, so clicks are the outcome we actually measure; and the
        // whole premise is that a founder should never have to know what a CPC bid is.
        //
        // ⚠️ costType is CPM for every auto-bidding target type, NOT CPC. Auto-bidding charges by
        // impression regardless of what it optimises for.
        optimizationTargetType: 'MAX_CLICK',
        costType: 'CPM',
        // Required field. 0 is the documented default under auto-bidding and means "no manual
        // bid" — it is only dangerous under MANUAL bidding, where it means "never deliver".
        unitCost: { amount: '0', currencyCode: input.currencyCode },

        // Amount is a STRING in this API, and currency travels with it. Never a bare number.
        dailyBudget: { amount: input.dailyBudgetAmount, currencyCode: input.currencyCode },
        locale: { country: 'GB', language: 'en' },
        runSchedule: input.endMs ? { start: input.startMs, end: input.endMs } : { start: input.startMs },
        targetingCriteria: input.targeting,
        status: 'PAUSED',
    };
}

/**
 * A Rest.li partial update. Used for every status change.
 *
 * ⚠️ Requires the `X-RestLi-Method: PARTIAL_UPDATE` header as well as this body — the endpoint is a
 * POST to the entity URL either way, so without the header LinkedIn interprets it as something
 * else entirely rather than returning a helpful error.
 */
export function statusPatchBody(status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'): Record<string, unknown> {
    return { patch: { $set: { status } } };
}

/** Creatives use `intendedStatus`, not `status`. Different field, same idea. */
export function creativeStatusPatchBody(intendedStatus: 'ACTIVE' | 'PAUSED'): Record<string, unknown> {
    return { patch: { $set: { intendedStatus } } };
}

/** `(year:2026,month:9,day:1)` — LinkedIn's date object, unpadded integers. */
export function dateParam(d: Date): string {
    return `(year:${d.getUTCFullYear()},month:${d.getUTCMonth() + 1},day:${d.getUTCDate()})`;
}

/**
 * The daily analytics URL for a set of creatives.
 *
 * ⚠️ `fields` is NOT optional in practice. Omit it and LinkedIn returns impressions and clicks
 * only — so spend and conversions would silently arrive as undefined, and an optimiser reading
 * them as zero would see every variant as free and converting nothing.
 */
export function analyticsUrl(creativeUrns: string[], start: Date, end: Date): string {
    const fields = [
        'dateRange', 'pivotValues', 'impressions', 'clicks',
        'landingPageClicks', 'costInLocalCurrency', 'externalWebsiteConversions',
    ].join(',');
    const list = creativeUrns.map((u) => encodeURIComponent(u)).join(',');
    return `${BASE}/adAnalytics?q=analytics&pivot=CREATIVE&timeGranularity=DAILY`
        + `&dateRange=(start:${dateParam(start)},end:${dateParam(end)})`
        + `&creatives=List(${list})&fields=${fields}`;
}

export interface AnalyticsRow {
    externalVariantId: string;
    day: string;
    impressions: number;
    clicks: number;
    spendLocal: number;
    reportedConversions: number;
}

/**
 * Parse an adAnalytics response.
 *
 * ⚠️ `costInLocalCurrency` arrives as a STRING ("19.91833") and is in the AD ACCOUNT'S currency,
 * which is not necessarily GBP. It is returned here as `spendLocal` — deliberately not named
 * `spendGbp` — so a caller cannot casually treat a euro as a pound. Converting is the caller's
 * problem and needs a rate we do not have.
 */
export function parseAnalytics(payload: unknown): AnalyticsRow[] {
    const elements = (payload as { elements?: unknown[] })?.elements;
    if (!Array.isArray(elements)) return [];
    const out: AnalyticsRow[] = [];
    for (const el of elements as Record<string, any>[]) {
        const urn = Array.isArray(el.pivotValues) ? String(el.pivotValues[0] ?? '') : '';
        const s = el.dateRange?.start;
        if (!urn || !s) continue;
        out.push({
            externalVariantId: urn,
            day: `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`,
            impressions: Number(el.impressions) || 0,
            clicks: Number(el.clicks) || 0,
            spendLocal: Number(el.costInLocalCurrency) || 0,
            reportedConversions: Number(el.externalWebsiteConversions) || 0,
        });
    }
    return out;
}

/** The created entity's id, which comes back in a HEADER rather than the body. */
export function parseRestliId(res: { headers: { get(name: string): string | null } }): string {
    const id = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
    if (!id) throw new Error('LinkedIn accepted the write but returned no x-restli-id, so the entity cannot be tracked.');
    return id;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

export class LinkedInAdsError extends Error {
    constructor(readonly status: number, readonly body: string, message: string) {
        super(message);
        this.name = 'LinkedInAdsError';
    }
    /** 429 is the documented throttle: 45M metric values per 5-minute window. */
    get throttled(): boolean { return this.status === 429; }
    /** 401/403 mean the token is gone or the account is not ours to touch — i.e. control lost. */
    get controlLost(): boolean { return this.status === 401 || this.status === 403; }
}

async function call(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LinkedInAdsError(res.status, body, `LinkedIn ${init.method ?? 'GET'} ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
}

// ── The adapter ─────────────────────────────────────────────────────────────────────────────────

export interface LinkedInAdapterConfig {
    /** Token carrying rw_ads + r_ads_reporting. NOT the workspace's w_member_social token. */
    accessToken: string;
    accountUrn: string;          // urn:li:sponsoredAccount:N
    currencyCode: string;        // the AD ACCOUNT's currency, read from LinkedIn — never assumed
    /**
     * Optional override. Normally left unset and resolved per campaign by ensureCampaignGroup —
     * ⚠️ this used to be a required field that every caller passed as an empty string, which would
     * have failed every campaign creation, since LinkedIn requires a real group.
     */
    campaignGroupUrn?: string;
}

export function createLinkedInAdapter(cfg: LinkedInAdapterConfig): AdNetworkAdapter {
    const acct = accountId(cfg.accountUrn);

    return {
        key: 'linkedin',
        label: 'LinkedIn Ads',

        async stageCampaign(input: StageCampaignInput): Promise<StageCampaignResult> {
            // Resolved per campaign, and idempotent — see ensureCampaignGroup.
            const groupUrn = cfg.campaignGroupUrn
                || await ensureCampaignGroup(cfg.accessToken, cfg.accountUrn, input.campaignId);

            const res = await call(`${BASE}/adAccounts/${acct}/adCampaigns`, {
                method: 'POST',
                headers: headers(cfg.accessToken),
                body: JSON.stringify(campaignCreateBody({
                    accountUrn: cfg.accountUrn,
                    campaignGroupUrn: groupUrn,
                    name: input.name,
                    dailyBudgetAmount: String(input.dailyBudgetGbp),
                    currencyCode: cfg.currencyCode,
                    targeting: (input.variants[0]?.targeting ?? {}) as Record<string, unknown>,
                    startMs: Date.now(),
                })),
            });
            const externalCampaignId = parseRestliId(res);

            // Creatives are created ACTIVE on purpose: the parent campaign is PAUSED and LinkedIn
            // documents that the parent's status overrides the creative's. So nothing serves, and
            // approval later is ONE field on ONE entity rather than N updates that could half-
            // succeed and leave a campaign live with only some of its ads.
            // ⚠️ SPONSORED CONTENT IS AUTHORED BY A COMPANY PAGE, not a person. The author is the
            // organisation the AD ACCOUNT references — read live, because we have no other source
            // for it and guessing an organisation URN would post under the wrong company.
            const author = await fetchAccountOrganization(cfg.accessToken, cfg.accountUrn);

            const externalVariantIds: Record<number, string> = {};
            for (const v of input.variants) {
                // ⚠️ `?action=createInline`, NOT the plain create. The first draft posted
                // `content: { reference: url }` to the plain endpoint — `content` there is a URN of
                // ALREADY-EXISTING content, and that object shape does not exist in the API at all.
                // We have no pre-existing post, so createInline is the only path: it creates the
                // Direct Sponsored Content post and the creative in one call.
                const cres = await call(`${BASE}/adAccounts/${acct}/creatives?action=createInline`, {
                    method: 'POST',
                    headers: headers(cfg.accessToken),
                    body: JSON.stringify({
                        creative: {
                            campaign: externalCampaignId,
                            intendedStatus: 'ACTIVE',
                            inlineContent: {
                                post: {
                                    // Marks this as Direct Sponsored Content: an ad-only post that
                                    // does NOT appear on the company's own page feed.
                                    adContext: { dscAdAccount: cfg.accountUrn, dscStatus: 'ACTIVE' },
                                    author,
                                    commentary: v.body,
                                    visibility: 'PUBLIC',
                                    lifecycleState: 'PUBLISHED',
                                    isReshareDisabledByAuthor: false,
                                    contentCallToActionLabel: 'LEARN_MORE',
                                    // Where the click goes — normally one of our own /go/ tracked
                                    // links, so the click lands in the attribution ledger.
                                    contentLandingPage: v.destinationUrl,
                                    content: { media: { title: v.headline, id: v.mediaUrn } },
                                },
                            },
                        },
                    }),
                });
                externalVariantIds[v.variantId] = parseRestliId(cres);
            }

            return { externalCampaignId, externalVariantIds, status: 'paused' };
        },

        async activateCampaign(externalCampaignId: string): Promise<void> {
            // The only call in this file that can cost money.
            await call(`${BASE}/adAccounts/${acct}/adCampaigns/${accountId(externalCampaignId)}`, {
                method: 'POST',
                headers: headers(cfg.accessToken, { 'X-RestLi-Method': 'PARTIAL_UPDATE' }),
                body: JSON.stringify(statusPatchBody('ACTIVE')),
            });
        },

        async pauseVariant(externalVariantId: string, _reason: string): Promise<void> {
            await call(`${BASE}/adAccounts/${acct}/creatives/${encodeURIComponent(externalVariantId)}`, {
                method: 'POST',
                headers: headers(cfg.accessToken, { 'X-RestLi-Method': 'PARTIAL_UPDATE' }),
                body: JSON.stringify(creativeStatusPatchBody('PAUSED')),
            });
        },

        async pauseCampaign(externalCampaignId: string): Promise<void> {
            await call(`${BASE}/adAccounts/${acct}/adCampaigns/${accountId(externalCampaignId)}`, {
                method: 'POST',
                headers: headers(cfg.accessToken, { 'X-RestLi-Method': 'PARTIAL_UPDATE' }),
                body: JSON.stringify(statusPatchBody('PAUSED')),
            });
        },

        async fetchMetrics(externalVariantIds: string[], days: number): Promise<VariantMetrics[]> {
            if (externalVariantIds.length === 0) return [];
            const end = new Date();
            const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
            const res = await call(analyticsUrl(externalVariantIds, start, end), {
                method: 'GET', headers: headers(cfg.accessToken),
            });
            const rows = parseAnalytics(await res.json());

            // ⚠️ AN EMPTY RESPONSE IS AMBIGUOUS AND MUST NOT BE FLATTENED TO ZEROES. LinkedIn
            // returns `elements: []` both when there was no activity AND when the token lacks read
            // access to that account — the docs say so explicitly, and the two are indistinguishable
            // from the response alone. Zeroes would look to the optimiser like a total collapse in
            // performance and could pause every variant in a campaign that is running perfectly
            // well. Returning nothing means "no data", which the optimiser already treats as
            // "not enough evidence to judge".
            return rows.map((r) => ({
                externalVariantId: r.externalVariantId,
                day: r.day,
                impressions: r.impressions,
                clicks: r.clicks,
                // Named for what it is. The caller converts, or refuses to.
                spendGbp: cfg.currencyCode === 'GBP' ? r.spendLocal : NaN,
                reportedConversions: r.reportedConversions,
            }));
        },

        async checkControl(externalCampaignId: string): Promise<{ ok: boolean; detail?: string }> {
            try {
                await call(`${BASE}/adAccounts/${acct}/adCampaigns/${accountId(externalCampaignId)}`, {
                    method: 'GET', headers: headers(cfg.accessToken),
                });
                return { ok: true };
            } catch (err) {
                if (err instanceof LinkedInAdsError && err.controlLost) {
                    return { ok: false, detail: 'The LinkedIn ad account is no longer reachable with this connection.' };
                }
                // ⚠️ A throttle or a 500 is NOT loss of control, and must not be reported as one:
                // "we can no longer stop this campaign" triggers a halt, and halting a healthy
                // campaign because LinkedIn was briefly busy is its own kind of damage.
                return { ok: true, detail: err instanceof Error ? err.message : String(err) };
            }
        },
    };
}

// ── Targeting search ────────────────────────────────────────────────────────────────────────────

/**
 * Facets we let a user target on.
 *
 * ⚠️ Deliberately a SHORT list. LinkedIn exposes dozens, and every one added here is another field
 * on a form that a founder has to understand before they can spend money. These three are the ones
 * the brief's AC 1.2 named, and they are the ones that change who sees an ad most.
 */
export interface TargetingEntity { urn: string; name: string }

export const TARGETING_FACETS = {
    locations: 'urn:li:adTargetingFacet:locations',
    // ⚠️ `jobFunctions`, NOT `titles`. This said `titles` in its first draft, which is a DIFFERENT
    // facet taking urn:li:title:N — it would have worked, silently targeting job titles while the
    // form said "job function". A wrong facet does not error; it spends the money on the wrong
    // audience. Values here are urn:li:function:N.
    jobFunctions: 'urn:li:adTargetingFacet:jobFunctions',
    seniorities: 'urn:li:adTargetingFacet:seniorities',
    // Fixed enum rather than a typeahead — LinkedIn documents the exact ranges, so there is
    // nothing to look up. AC 1.2 of the brief asked for company size.
    companySizes: 'urn:li:adTargetingFacet:staffCountRanges',
} as const;
export type TargetingFacet = keyof typeof TARGETING_FACETS;

/**
 * ⚠️ FACETS WE MUST NEVER OFFER ALONGSIDE THE ABOVE.
 *
 * LinkedIn documents that job functions and seniorities "may not be AND'ed with any include
 * clauses targeting Job Titles". Since buildTargetingCriteria AND-s every facet group together,
 * adding a titles picker would make every combination that also used a function or a seniority
 * invalid — and the rejection would arrive from LinkedIn, at staging time, as an opaque 400.
 *
 * This constant exists so that constraint is written down where someone adding a picker will see
 * it, rather than rediscovered from an error code.
 */
export const INCOMPATIBLE_WITH_FUNCTION_OR_SENIORITY = [
    'urn:li:adTargetingFacet:titles',
    'urn:li:adTargetingFacet:titlesAll',
    'urn:li:adTargetingFacet:titlesPast',
] as const;

/**
 * Company sizes, exactly as LinkedIn enumerates them.
 *
 * Hardcoded deliberately, unlike locations: these are a closed, documented set of range URNs with
 * no lookup endpoint behind them, and the format (`(51,200)`, with INT_MAX for "no upper limit")
 * is not something a user could be expected to type.
 */
export const COMPANY_SIZES: TargetingEntity[] = [
    { urn: 'urn:li:staffCountRange:(1,1)', name: 'Self-employed' },
    { urn: 'urn:li:staffCountRange:(2,10)', name: '2–10 employees' },
    { urn: 'urn:li:staffCountRange:(11,50)', name: '11–50 employees' },
    { urn: 'urn:li:staffCountRange:(51,200)', name: '51–200 employees' },
    { urn: 'urn:li:staffCountRange:(201,500)', name: '201–500 employees' },
    { urn: 'urn:li:staffCountRange:(501,1000)', name: '501–1,000 employees' },
    { urn: 'urn:li:staffCountRange:(1001,5000)', name: '1,001–5,000 employees' },
    { urn: 'urn:li:staffCountRange:(5001,10000)', name: '5,001–10,000 employees' },
    { urn: 'urn:li:staffCountRange:(10001,2147483647)', name: '10,001+ employees' },
];

/**
 * Typeahead against LinkedIn's own targeting vocabulary.
 *
 * ⚠️ WHY THIS IS A LIVE LOOKUP AND NOT A HARDCODED LIST. Targeting values are opaque URNs
 * (`urn:li:geo:101165590` is the United Kingdom) that only LinkedIn can map to a name. A baked-in
 * list would be wrong the moment they revise it, and a WRONG geo URN does not error — it silently
 * targets somewhere else and spends the customer's money there. The only two URNs anywhere in this
 * codebase are the fallbacks below, and both are documented.
 */
export async function searchTargeting(
    accessToken: string,
    accountUrn: string,
    facet: TargetingFacet,
    query: string,
): Promise<TargetingEntity[]> {
    const params = new URLSearchParams({
        q: 'typeahead',
        query,
        facet: TARGETING_FACETS[facet],
        queryVersion: 'QUERY_USES_URNS',
        'locale.language': 'en',
        'locale.country': 'GB',
        lixEntity: accountUrn,
    });
    const res = await call(`${BASE}/adTargetingEntities?${params.toString()}`, {
        method: 'GET', headers: headers(accessToken),
    });
    const data = await res.json() as { elements?: { urn?: string; name?: string }[] };
    if (!Array.isArray(data.elements)) return [];
    return data.elements
        .filter((e) => e.urn && e.name)
        .map((e) => ({ urn: String(e.urn), name: String(e.name) }))
        .slice(0, 20);
}

/**
 * The two geo URNs this codebase knows by heart, used only as a starting suggestion when the
 * typeahead is unavailable. Verified against LinkedIn's own documentation rather than guessed —
 * a wrong geo spends real money in the wrong country without erroring.
 */
export const FALLBACK_GEOS: TargetingEntity[] = [
    { urn: 'urn:li:geo:101165590', name: 'United Kingdom' },
    { urn: 'urn:li:geo:103644278', name: 'United States' },
];

/**
 * Turn chosen entities into the `targetingCriteria` LinkedIn expects.
 *
 * ⚠️ A LOCATION IS MANDATORY. LinkedIn rejects a campaign with no location facet, and until now
 * this codebase sent `targetingCriteria: {}` — so every staging attempt would have failed at the
 * API with an opaque error. Refusing here, with a sentence, is the difference between "you need to
 * choose where these ads run" and a 400 from a third party.
 *
 * The shape is `include.and[]` of `or` groups: every group must match (AND), any value within a
 * group will do (OR). So locations AND seniorities narrows; two locations widens.
 */
export function buildTargetingCriteria(selected: Partial<Record<TargetingFacet, string[]>>): Record<string, unknown> {
    const locations = selected.locations ?? [];
    if (locations.length === 0) {
        throw new Error('Choose at least one location — LinkedIn will not run an advert without one.');
    }
    const and: unknown[] = [{ or: { [TARGETING_FACETS.locations]: locations } }];
    for (const facet of ['jobFunctions', 'seniorities', 'companySizes'] as const) {
        const values = selected[facet] ?? [];
        if (values.length > 0) and.push({ or: { [TARGETING_FACETS[facet]]: values } });
    }
    return { include: { and } };
}

// ── Campaign groups ─────────────────────────────────────────────────────────────────────────────

/**
 * The name we give the group for one Be More Swan campaign.
 *
 * ⚠️ DETERMINISTIC, and that is the whole point. `stage_paid` can fail after creating a group (the
 * creative call is the next thing that can go wrong), and a retry that minted a second group would
 * silently litter the customer's Campaign Manager with empty duplicates. Searching for this exact
 * name first makes the operation idempotent without needing a column to remember it in.
 */
export const campaignGroupName = (campaignId: number) => `Be More Swan — campaign ${campaignId}`;

/**
 * Find or create the campaign group for one of our campaigns.
 *
 * ⚠️ `campaignGroup` is REQUIRED on campaign creation — LinkedIn has mandated it since 30 October
 * 2020 — and this codebase was sending an empty string. Every `stage_paid` would have failed at the
 * very first API call, before it ever reached a creative.
 *
 * Created ACTIVE, deliberately, while the campaign under it is created PAUSED. LinkedIn applies the
 * MOST RESTRICTIVE status across levels, so nothing serves — and approval then stays a single flip
 * of the campaign, rather than two writes that could half-succeed and leave a group live with a
 * paused campaign or vice versa.
 *
 * No `totalBudget` is set. We only ever ask the customer for a DAILY figure, and inventing a
 * lifetime cap would be us deciding something they did not tell us.
 */
export async function ensureCampaignGroup(
    accessToken: string,
    accountUrn: string,
    campaignId: number,
): Promise<string> {
    const acct = accountId(accountUrn);
    const wanted = campaignGroupName(campaignId);

    // Search first. Filtered client-side on an EXACT name match: LinkedIn's name search is a
    // contains-match, and "campaign 1" would happily return "campaign 12".
    try {
        const res = await call(
            `${BASE}/adAccounts/${acct}/adCampaignGroups?q=search&search=(status:(values:List(ACTIVE,DRAFT)))&pageSize=100`,
            { method: 'GET', headers: headers(accessToken) },
        );
        const data = await res.json() as { elements?: { id?: number; name?: string }[] };
        const hit = (data.elements ?? []).find((g) => g.name === wanted && g.id);
        if (hit) return `urn:li:sponsoredCampaignGroup:${hit.id}`;
    } catch (err) {
        // A failed search is not a failed stage — fall through and create. The worst case is a
        // duplicate group, which is untidy; refusing here would block the campaign entirely.
        console.warn('[linkedin] campaign group search failed, creating a new one', err);
    }

    const created = await call(`${BASE}/adAccounts/${acct}/adCampaignGroups`, {
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({
            account: accountUrn,
            name: wanted,
            // Required. Open-ended: the campaign's own schedule governs when ads actually run.
            runSchedule: { start: Date.now() },
            status: 'ACTIVE',
        }),
    });
    return parseRestliId(created);
}

/**
 * The organisation a sponsored post is authored by.
 *
 * ⚠️ An ad account references a Company Page, and Direct Sponsored Content must be authored by it —
 * a person URN is not valid here. There is no other source for this value, so it is read live
 * rather than stored: an organisation URN guessed or gone stale would publish an advert under the
 * wrong company's name.
 */
export async function fetchAccountOrganization(accessToken: string, accountUrn: string): Promise<string> {
    const res = await call(`${BASE}/adAccounts/${accountId(accountUrn)}`, {
        method: 'GET', headers: headers(accessToken),
    });
    const data = await res.json() as { reference?: string };
    const ref = data.reference;
    if (!ref || !/^urn:li:organization:\d+$/.test(ref)) {
        throw new Error(
            'This LinkedIn ad account is not linked to a Company Page, so we cannot create adverts on it. '
            + 'Adverts are published by a Page, not by a person.',
        );
    }
    return ref;
}
