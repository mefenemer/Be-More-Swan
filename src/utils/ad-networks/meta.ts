// src/utils/ad-networks/meta.ts
// The Meta (Facebook / Instagram) Marketing API adapter. DEV-ONLY, like the LinkedIn one: built
// against the documented API and exercised live on staging before it is ever registered for
// production (see registry.ts → metaAdapter()).
//
// ── Meta's hierarchy has one more level than LinkedIn's ─────────────────────────────────────────
//   campaign  (objective, PAUSED)          ← the ONE thing approval flips
//   └ ad set  (daily budget, targeting)    ← created ACTIVE; a paused campaign overrides it
//     └ ad    (points at a creative)       ← created ACTIVE; same reason
//       └ creative (page post: copy, link, image hash)
//
// Same rule as LinkedIn: everything under the campaign is created ACTIVE and the campaign PAUSED.
// Meta applies the most restrictive status down the tree, so nothing serves, and approval stays a
// single status write on a single entity — never N writes that could half-succeed.
//
// ── Lessons carried over from the first live LinkedIn run (2026-11-18) ──────────────────────────
//   · Every refusal carries the platform's own reason (metaErrorDetail). LinkedIn took two PR
//     cycles per refusal until its reason was visible; this starts visible.
//   · The API version and the sign-in scopes are ENV-overridable (META_ADS_GRAPH_VERSION,
//     META_ADS_SCOPES). Meta's Marketing API REFUSES deprecated versions outright (error 2635)
//     rather than upgrading them, and a scope the app lacks fails the whole login — both are fixed
//     by a Netlify variable, not a deploy.
//   · Ids come back in the JSON body here (`{ id }`), not in a header. Read them from there.
//
// ⚠️ Nothing in this file can set or raise a budget after creation. The daily budget is written
// once, at stage time, from the customer's own figure (see campaigns.ts stage_paid).
import type { AdNetworkAdapter, StageCampaignInput, StageCampaignResult, VariantMetrics } from './types';

/** Default Marketing API version. Override with META_ADS_GRAPH_VERSION without a deploy. */
export const META_ADS_DEFAULT_GRAPH_VERSION = 'v24.0';

export function metaAdsGraphVersion(): string {
    const v = String(process.env.META_ADS_GRAPH_VERSION ?? '').trim();
    return /^v\d+\.\d+$/.test(v) ? v : META_ADS_DEFAULT_GRAPH_VERSION;
}

const graph = () => `https://graph.facebook.com/${metaAdsGraphVersion()}`;

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

export class MetaAdsError extends Error {
    constructor(readonly status: number, readonly body: string, message: string) {
        super(message);
        this.name = 'MetaAdsError';
    }
    /** 190 = token expired/invalid; 200/10 = permission. Either way we can no longer act. */
    get controlLost(): boolean {
        try {
            const code = (JSON.parse(this.body) as { error?: { code?: number } }).error?.code;
            return code === 190 || code === 200 || code === 10 || this.status === 401 || this.status === 403;
        } catch {
            return this.status === 401 || this.status === 403;
        }
    }
}

/**
 * Meta's reason for a refusal, short enough to show a person:
 * "400: <message> (code <code>/<subcode>) <user message>". null for anything that is not a Meta API
 * error. Meta error bodies never carry the token (it travels in the Authorization header).
 */
export function metaErrorDetail(err: unknown): string | null {
    if (!(err instanceof MetaAdsError)) return null;
    let msg = '';
    try {
        const e = (JSON.parse(err.body) as {
            error?: { message?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string };
        }).error;
        if (e) {
            const code = e.code !== undefined ? `(code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : '';
            msg = [e.message, code, e.error_user_title, e.error_user_msg].filter(Boolean).join(' ');
        }
    } catch {
        msg = err.body;
    }
    return `${err.status}: ${(msg || err.body || 'no reason given').slice(0, 400)}`;
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

/**
 * One Graph call. The token rides in the Authorization header, never the URL, so it cannot end up
 * in an access log or an error message.
 */
async function call(
    token: string,
    path: string,
    init: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; query?: Record<string, string> } = {},
): Promise<Record<string, any>> {
    const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : '';
    const res = await fetch(`${graph()}/${path.replace(/^\//, '')}${qs}`, {
        method: init.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new MetaAdsError(res.status, text, `Meta ${init.method ?? 'GET'} ${res.status}: ${text.slice(0, 300)}`);
    }
    try { return JSON.parse(text) as Record<string, any>; } catch { return {}; }
}

function createdId(data: Record<string, any>, what: string): string {
    const id = data?.id;
    if (!id) throw new Error(`Meta accepted the ${what} but returned no id, so it cannot be tracked. Anything created is paused and cannot spend.`);
    return String(id);
}

// ── Pure builders, exported so the risky shapes are testable without a token ─────────────────────

/** `act_123` or `123` → `act_123`. Meta addresses ad accounts with the prefix. */
export function actId(account: string): string {
    const m = String(account).match(/(\d+)\s*$/);
    if (!m) throw new Error(`Not a usable Meta ad account: ${account}`);
    return `act_${m[1]}`;
}

/** Pounds → pence, as Meta wants budgets in the account currency's minor unit, as an integer. */
export function toMinorUnits(amountGbp: number): number {
    return Math.round(amountGbp * 100);
}

/**
 * Targeting for an ad set. Countries are ISO-3166 alpha-2 (e.g. GB).
 *
 * ⚠️ `targeting_automation.advantage_audience` is stated explicitly. Meta now requires the flag on
 * ad set creation, and leaving it to default would let Meta widen the audience beyond what the
 * customer chose. 0 = only the people described here.
 */
export function buildMetaTargeting(selected: { countries?: string[] }): Record<string, unknown> {
    const countries = (selected.countries ?? []).map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
    if (countries.length === 0) {
        throw new Error('Choose at least one country — Meta will not run an advert without a location.');
    }
    return {
        geo_locations: { countries },
        age_min: 18,
        targeting_automation: { advantage_audience: 0 },
    };
}

export function metaCampaignBody(name: string): Record<string, unknown> {
    return {
        name,
        // Clicks to a tracked link are what we measure, so traffic is the honest objective.
        objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED',
        // Required, and a declaration on the advertiser's behalf: none of housing, credit,
        // employment, social issues/elections/politics. Same follow-up as LinkedIn's politicalIntent
        // — before customers stage campaigns the stage form must ask (plan §9.10).
        special_ad_categories: [],
        // Required when the budget lives on the ad set rather than the campaign.
        is_adset_budget_sharing_enabled: false,
    };
}

export function metaAdSetBody(input: {
    name: string; campaignId: string; dailyBudgetGbp: number; targeting: Record<string, unknown>; startMs: number;
}): Record<string, unknown> {
    return {
        name: input.name,
        campaign_id: input.campaignId,
        // The customer's own daily figure, in pence. Written once, here, and never raised by us.
        daily_budget: toMinorUnits(input.dailyBudgetGbp),
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        // Auto-bidding: Meta spends the daily budget chasing clicks with no manual bid to get wrong.
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: input.targeting,
        start_time: new Date(input.startMs).toISOString(),
        // ACTIVE under a PAUSED campaign — see the header.
        status: 'ACTIVE',
    };
}

export function metaCreativeBody(input: {
    name: string; pageId: string; headline: string; body: string; link: string; imageHash: string;
}): Record<string, unknown> {
    return {
        name: input.name,
        object_story_spec: {
            page_id: input.pageId,
            link_data: {
                link: input.link,
                message: input.body,
                name: input.headline,
                image_hash: input.imageHash,
                call_to_action: { type: 'LEARN_MORE', value: { link: input.link } },
            },
        },
    };
}

// ── Image upload ────────────────────────────────────────────────────────────────────────────────

export const META_ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'] as const;

/** Upload an image to the ad account's library. Returns the image HASH that a creative cites. */
export async function uploadMetaImage(token: string, account: string, bytes: ArrayBuffer): Promise<string> {
    const data = await call(token, `${actId(account)}/adimages`, {
        method: 'POST',
        body: { bytes: Buffer.from(bytes).toString('base64') },
    });
    // Shape: { images: { "<name>": { hash, url } } } — the key is whatever Meta named the file.
    const first = Object.values((data?.images ?? {}) as Record<string, { hash?: string }>)[0];
    if (!first?.hash) throw new Error('Meta accepted the image but returned no reference to it.');
    return first.hash;
}

// ── Discovery (used by the OAuth callback) ──────────────────────────────────────────────────────

export interface MetaAdAccount { id: string; name: string; currency: string; accountStatus: number | null }
export interface MetaPage { id: string; name: string }

/** Ad accounts this token can reach. null on failure — "could not ask" is not "you have none". */
export async function fetchMetaAdAccounts(token: string): Promise<MetaAdAccount[] | null> {
    try {
        const data = await call(token, 'me/adaccounts', { query: { fields: 'id,name,currency,account_status', limit: '100' } });
        if (!Array.isArray(data.data)) return null;
        return data.data.map((a: any) => ({
            id: String(a.id),
            name: String(a.name ?? a.id),
            currency: String(a.currency ?? ''),
            accountStatus: typeof a.account_status === 'number' ? a.account_status : null,
        }));
    } catch {
        return null;
    }
}

/** Facebook Pages this token can advertise as. null on failure. */
export async function fetchMetaPages(token: string): Promise<MetaPage[] | null> {
    try {
        const data = await call(token, 'me/accounts', { query: { fields: 'id,name', limit: '100' } });
        if (!Array.isArray(data.data)) return null;
        return data.data.map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
    } catch {
        return null;
    }
}

/** The permissions the person actually GRANTED — stored instead of the ones we asked for. */
export async function fetchGrantedPermissions(token: string): Promise<string[] | null> {
    try {
        const data = await call(token, 'me/permissions');
        if (!Array.isArray(data.data)) return null;
        return data.data.filter((p: any) => p.status === 'granted').map((p: any) => String(p.permission));
    } catch {
        return null;
    }
}

// ── The adapter ─────────────────────────────────────────────────────────────────────────────────

export interface MetaAdapterConfig {
    accessToken: string;
    /** `act_<id>` */
    accountId: string;
    /** The Facebook Page the adverts are published as. */
    pageId: string;
}

export function createMetaAdapter(cfg: MetaAdapterConfig): AdNetworkAdapter {
    const act = actId(cfg.accountId);
    const t = cfg.accessToken;

    return {
        key: 'meta',
        label: 'Meta',

        async stageCampaign(input: StageCampaignInput): Promise<StageCampaignResult> {
            const campaign = await call(t, `${act}/campaigns`, { method: 'POST', body: metaCampaignBody(input.name) });
            const externalCampaignId = createdId(campaign, 'campaign');

            const adSet = await call(t, `${act}/adsets`, {
                method: 'POST',
                body: metaAdSetBody({
                    name: `${input.name} — ad set`,
                    campaignId: externalCampaignId,
                    dailyBudgetGbp: input.dailyBudgetGbp,
                    targeting: (input.variants[0]?.targeting ?? {}) as Record<string, unknown>,
                    startMs: Date.now(),
                }),
            });
            const adSetId = createdId(adSet, 'ad set');

            const externalVariantIds: Record<number, string> = {};
            for (const v of input.variants) {
                const creative = await call(t, `${act}/adcreatives`, {
                    method: 'POST',
                    body: metaCreativeBody({
                        name: `${input.name} — variant ${v.variantId + 1}`,
                        pageId: cfg.pageId,
                        headline: v.headline,
                        body: v.body,
                        link: v.destinationUrl,
                        // For Meta, the "media URN" is the image hash meta-ads-media returned.
                        imageHash: v.mediaUrn,
                    }),
                });
                const creativeId = createdId(creative, 'creative');
                const ad = await call(t, `${act}/ads`, {
                    method: 'POST',
                    body: {
                        name: `${input.name} — variant ${v.variantId + 1}`,
                        adset_id: adSetId,
                        creative: { creative_id: creativeId },
                        status: 'ACTIVE',
                    },
                });
                externalVariantIds[v.variantId] = createdId(ad, 'ad');
            }

            return { externalCampaignId, externalVariantIds, status: 'paused' };
        },

        async activateCampaign(externalCampaignId: string): Promise<void> {
            // The only call in this file that can cost money.
            await call(t, externalCampaignId, { method: 'POST', body: { status: 'ACTIVE' } });
        },

        async pauseVariant(externalVariantId: string, _reason: string): Promise<void> {
            await call(t, externalVariantId, { method: 'POST', body: { status: 'PAUSED' } });
        },

        async pauseCampaign(externalCampaignId: string): Promise<void> {
            await call(t, externalCampaignId, { method: 'POST', body: { status: 'PAUSED' } });
        },

        async fetchMetrics(externalVariantIds: string[], days: number): Promise<VariantMetrics[]> {
            if (externalVariantIds.length === 0) return [];
            const until = new Date();
            const since = new Date(until.getTime() - Math.max(1, days) * 86_400_000);
            const day = (d: Date) => d.toISOString().slice(0, 10);
            const data = await call(t, `${act}/insights`, {
                query: {
                    level: 'ad',
                    fields: 'ad_id,impressions,clicks,spend,actions,date_start',
                    time_increment: '1',
                    time_range: JSON.stringify({ since: day(since), until: day(until) }),
                    filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: externalVariantIds }]),
                    limit: '500',
                },
            });
            // ⚠️ An empty list means EITHER no delivery OR no read access. Returned as-is, never
            // padded with zeroes, so the optimiser cannot read silence as a collapse (LinkedIn lesson).
            return (Array.isArray(data.data) ? data.data : []).map((r: any) => ({
                externalVariantId: String(r.ad_id),
                day: String(r.date_start),
                impressions: Number(r.impressions ?? 0),
                clicks: Number(r.clicks ?? 0),
                // In the ACCOUNT's currency; stage_paid only stages GBP accounts.
                spendGbp: Number(r.spend ?? 0),
                reportedConversions: (Array.isArray(r.actions) ? r.actions : [])
                    .filter((a: any) => a.action_type === 'lead' || String(a.action_type).startsWith('offsite_conversion'))
                    .reduce((n: number, a: any) => n + Number(a.value ?? 0), 0),
            }));
        },

        async checkControl(externalCampaignId: string): Promise<{ ok: boolean; detail?: string }> {
            try {
                await call(t, externalCampaignId, { query: { fields: 'id,status,effective_status' } });
                return { ok: true };
            } catch (err) {
                return { ok: false, detail: metaErrorDetail(err) ?? (err instanceof Error ? err.message : 'unreachable') };
            }
        },
    };
}
