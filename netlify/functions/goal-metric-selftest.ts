// netlify/functions/goal-metric-selftest.ts
// Read-only probe that answers ONE question: which goal metrics can this workspace actually measure?
//
// WHY THIS EXISTS. `GoalMetric.available` is a claim about the outside world — "a poller can really
// fetch this" — and it was previously set from assumption. `linkedin_followers` shipped
// `available: true` because a poller had been written for it; the poller called organisation-scoped
// LinkedIn endpoints we hold no scopes for, so every call 403'd and any goal set against it sat at
// 'pending' until it rotted to 'data_disconnected'. The user was never told. A metric that cannot
// move is worse than a metric that isn't offered.
//
// So availability is now evidence-based. This endpoint calls the REAL third-party APIs with the
// workspace's REAL credentials and reports, per metric, whether a number came back. It writes
// nothing — no goals, no telemetry, no tokens — so it is safe to run against production.
//
// GET  /.netlify/functions/goal-metric-selftest
//   → { results: [ { metricKey, label, offered, outcome, value?, detail } ] }
//
// `offered` is the catalog's current `available` flag; `outcome` is what the API just did. A metric
// where offered=false and outcome='ok' is one you can safely switch on in src/config/goal-metrics.ts.
// A metric where offered=true and outcome='unsupported' is a linkedin_followers-shaped bug.
//
// Tenant-scoped: only ever touches the caller's own organisation.

import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, workspaceIntegrations, scheduledPosts } from '../../db/schema';
import { linkClicksFrom } from './ingest-facebook-insights';
import { getSecret } from '../../src/utils/vault';
import { requireTenant } from '../../src/utils/tenant';
import { getFreshAccessToken } from '../../src/utils/workspace-integrations';
import { gscDateRange } from '../../src/utils/gsc-decay';
import { GOAL_METRICS, getGoalMetric } from '../../src/config/goal-metrics';
import { withLambda } from '@netlify/aws-lambda-compat';

const GRAPH_VERSION = 'v19.0';

const json = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload, null, 2),
});

/** What the live API did when we asked it for this metric. */
export type Outcome =
    | 'ok'              // returned a usable number — safe to offer
    | 'not_connected'   // the backing account/integration isn't connected in this workspace
    | 'unauthorised'    // connected, but the token/scopes/app-permissions were refused
    | 'unsupported'     // the API rejected the metric name itself — this metric cannot be measured
    | 'no_data'         // call succeeded but carried no value (new/empty account)
    | 'error'           // the call failed for a reason that is neither an answer nor a verdict
    | 'skipped';        // nothing to probe (internal metrics read our own database)

// ── Graph error → Outcome ───────────────────────────────────────────────────────
//
// WHY THIS EXISTS AS ITS OWN FUNCTION. The Instagram probe used to treat every Graph failure except
// code 100 as `no_data`, and a live run on prod showed what that costs: all three
// instagram_profile_views candidates came back `(#10) Application does not have permission for this
// action`, and were reported as "no data". A permission wall is a definite refusal, not an empty
// account — and because `shouldDisable` keys off `unsupported`/`unauthorised`, a metric that was
// OFFERED and permission-blocked would never have been flagged. That is precisely the
// linkedin_followers class of bug this whole endpoint exists to catch, living inside the endpoint.
//
// The opposite mistake is just as bad and less obvious: classifying a RATE LIMIT or a transient
// Graph blip as a refusal would put a perfectly good metric into `shouldDisable`, and someone would
// switch off a working metric on the strength of one unlucky run. Anything we cannot confidently
// call a verdict is therefore `error` — reported, excluded from both summary lists, and re-runnable.
const GRAPH_BAD_METRIC = new Set([100]);                    // unknown/invalid metric name for this version
const GRAPH_PERMISSION = new Set([10, 200, 299, 3]);        // the APP lacks the permission (needs app review)
const GRAPH_TOKEN      = new Set([190, 102, 463, 467]);     // the token expired/was revoked (user reconnects)
const GRAPH_TRANSIENT  = new Set([1, 2, 4, 17, 32, 341, 613]); // unknown-transient, downtime, rate limits

/**
 * Classify a Graph error body. Returns null when there was no error at all.
 *
 * Unrecognised codes deliberately fall to `error`, not to a verdict: being wrong in the cautious
 * direction costs one re-run, being wrong in the confident direction disables a working metric.
 */
export function classifyGraphError(
    err: { code?: number; message?: string } | null | undefined,
    metric?: string,
): { outcome: Outcome; detail: string } | null {
    if (!err) return null;
    const code = err.code;
    const msg = err.message ?? `Graph error ${code ?? '(no code)'}`;
    const tag = `(#${code ?? '?'})`;

    if (code != null && GRAPH_BAD_METRIC.has(code)) {
        return {
            outcome: 'unsupported',
            detail: `${msg} — ${metric ? `"${metric}" is` : 'the requested metric is'} not accepted by Graph ${GRAPH_VERSION}.`,
        };
    }
    if (code != null && GRAPH_PERMISSION.has(code)) {
        // Distinct from a token problem in the ONE way that matters to whoever reads this: no amount
        // of reconnecting fixes it. The app itself needs the permission granted.
        return {
            outcome: 'unauthorised',
            detail: `${msg} ${tag} — the APP lacks this permission. Reconnecting the account will not help; this needs the permission granted to the app itself.`,
        };
    }
    if (code != null && GRAPH_TOKEN.has(code)) {
        return { outcome: 'unauthorised', detail: `${msg} ${tag} — the stored token is expired or revoked; the account needs reconnecting.` };
    }
    if (code != null && GRAPH_TRANSIENT.has(code)) {
        return { outcome: 'error', detail: `${msg} ${tag} — transient or rate-limited. Re-run before drawing any conclusion.` };
    }
    return { outcome: 'error', detail: `${msg} ${tag} — unrecognised Graph error; treated as inconclusive rather than as a verdict.` };
}

interface Result {
    metricKey: string;
    label: string;
    offered: boolean;
    outcome: Outcome;
    value?: number;
    detail: string;
}

/** Instagram account-level insights — the probe that decides `instagram_profile_views`. */
async function probeIgAccountMetric(
    igUserId: string, token: string, metric: string,
): Promise<{ outcome: Outcome; value?: number; detail: string }> {
    const range = gscDateRange(30, 1);
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/insights`
        + `?metric=${metric}&period=day&since=${range.startDate}&until=${range.endDate}`
        + `&access_token=${encodeURIComponent(token)}`;

    let res: Response;
    try { res = await fetch(url); } catch (e) {
        // A network failure is not "this account has no data" — it is no answer at all.
        return { outcome: 'error', detail: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    }

    const body = await res.json().catch(() => null) as {
        data?: { values?: { value?: number }[] }[];
        error?: { code?: number; message?: string; error_subcode?: number };
    } | null;

    // Graph reports failures in the body, and not always with a matching HTTP status — so classify
    // the error FIRST, whatever the status line said.
    const classified = classifyGraphError(body?.error, metric);
    if (classified) return classified;
    if (res.status === 401 || res.status === 403) {
        return { outcome: 'unauthorised', detail: `HTTP ${res.status} — token or scopes rejected.` };
    }
    if (!res.ok) return { outcome: 'error', detail: `HTTP ${res.status} with no Graph error body — inconclusive.` };

    const series = body?.data?.[0]?.values;
    if (!Array.isArray(series) || series.length === 0) {
        return { outcome: 'no_data', detail: `Graph accepted "${metric}" but returned no data points.` };
    }
    const total = series.reduce((s, p) => s + (typeof p?.value === 'number' ? p.value : 0), 0);
    return { outcome: 'ok', value: total, detail: `"${metric}" returned ${series.length} daily points, 30-day total ${total}.` };
}

/**
 * Facebook Page followers — the probe behind `facebook_followers`.
 *
 * Also the closest available proxy for "does this workspace's Page token work at all", which is what
 * the three post-insight metrics (reach / engagement rate / link clicks) ultimately depend on: they
 * read post_insights, and post_insights is only filled if ingest-facebook-insights.ts can call Graph
 * with this same token.
 */
async function probeFacebookFollowers(pageId: string, token: string): Promise<{ outcome: Outcome; value?: number; detail: string }> {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(token)}`);
    const body = await res.json().catch(() => null) as
        { followers_count?: number; fan_count?: number; error?: { code?: number; message?: string } } | null;
    const classified = classifyGraphError(body?.error);
    if (classified) return classified;
    if (res.status === 401 || res.status === 403) {
        return { outcome: 'unauthorised', detail: `Graph rejected the Page token (HTTP ${res.status}).` };
    }
    if (!res.ok) return { outcome: 'error', detail: `HTTP ${res.status} with no Graph error body — inconclusive.` };
    const n = body?.followers_count ?? body?.fan_count;
    if (typeof n !== 'number') return { outcome: 'no_data', detail: 'Page returned neither followers_count nor fan_count.' };
    return { outcome: 'ok', value: n, detail: `Page ${pageId} reports ${n} followers.` };
}

/** Facebook post-level insights — proves the columns the three derived metrics are summed from. */
async function probeFacebookPostInsights(db: any, orgId: number, token: string): Promise<{ outcome: Outcome; value?: number; detail: string }> {
    // Any published Facebook post with a platform id will do; we only need to know whether Graph
    // answers for it, not what the number is.
    const [post] = await db
        .select({ platformPostId: scheduledPosts.platformPostId })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.organisationId, orgId),
            eq(scheduledPosts.platform, 'facebook'),
            eq(scheduledPosts.status, 'published'),
            isNotNull(scheduledPosts.platformPostId),
        ))
        .limit(1);
    if (!post?.platformPostId) {
        return { outcome: 'no_data', detail: 'Facebook is connected but this workspace has published no Facebook posts yet — nothing to measure.' };
    }

    const metrics = 'post_impressions_unique,post_impressions,post_clicks_by_type';
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${post.platformPostId}/insights?metric=${metrics}&access_token=${encodeURIComponent(token)}`);
    const body = await res.json().catch(() => null) as
        { data?: { name: string; values?: { value: unknown }[] }[]; error?: { code?: number; message?: string } } | null;
    // Error 100 — "one bad metric name kills the whole call" — is the case this probe exists to
    // catch, and classifyGraphError is what tells it apart from a permission wall or a rate limit.
    const classified = classifyGraphError(body?.error, metrics);
    if (classified) return classified;
    if (res.status === 401 || res.status === 403) {
        return { outcome: 'unauthorised', detail: `Graph rejected the token for post insights (HTTP ${res.status}).` };
    }
    const names = (body?.data ?? []).map(d => d.name);
    if (!names.length) return { outcome: 'no_data', detail: 'Graph returned no insight rows for the sampled post.' };

    const byType = body!.data!.find(d => d.name === 'post_clicks_by_type')?.values?.[0]?.value;
    const clicks = linkClicksFrom(byType);
    return {
        outcome: 'ok',
        value: clicks ?? undefined,
        detail: `Returned ${names.join(', ')}. Link clicks on the sampled post: ${clicks ?? 'not broken out'}.`,
    };
}

/** YouTube subscribers — note that a hidden count is a real answer, not a failure. */
async function probeYouTubeSubscribers(db: any, orgId: number): Promise<{ outcome: Outcome; value?: number; detail: string }> {
    let token: string;
    try {
        ({ accessToken: token } = await getFreshAccessToken(db, orgId, 'youtube'));
    } catch {
        return { outcome: 'not_connected', detail: 'No usable YouTube integration in this workspace.' };
    }
    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return { outcome: 'unauthorised', detail: `YouTube rejected the token (HTTP ${res.status}).` };
    if (!res.ok) return { outcome: 'no_data', detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null) as
        { items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }> } | null;
    const stats = body?.items?.[0]?.statistics;
    if (stats?.hiddenSubscriberCount) {
        // NOT unsupported — the API works; this channel has chosen to hide the number. Nothing in
        // the catalog should change, but a goal on it will never move for THIS workspace.
        return { outcome: 'no_data', detail: 'This channel hides its subscriber count, so no figure is available for it.' };
    }
    const n = Number(stats?.subscriberCount);
    if (!Number.isFinite(n)) return { outcome: 'no_data', detail: 'Channel returned no subscriberCount.' };
    return { outcome: 'ok', value: n, detail: `Channel reports ${n} subscribers.` };
}

/**
 * X followers — the probe that decides `x_followers`.
 *
 * A 403 here is the API TIER, not a revoked grant, and telling those apart is the entire reason this
 * metric ships available:false. Reported as 'unsupported' rather than 'unauthorised' so the summary
 * reads as "our plan doesn't include this" rather than "the user needs to reconnect".
 */
async function probeXFollowers(db: any, orgId: number): Promise<{ outcome: Outcome; value?: number; detail: string }> {
    const [conn] = await db
        .select({ vaultRefKey: systemConnections.vaultRefKey })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.serviceName, 'x'),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);
    if (!conn?.vaultRefKey) return { outcome: 'not_connected', detail: 'No active X connection in this workspace.' };
    const secret = await getSecret(db, conn.vaultRefKey).catch(() => null);
    const token = (secret?.token as string | undefined) ?? null;
    if (!token) return { outcome: 'unauthorised', detail: 'X connection has no usable token in the vault.' };

    const res = await fetch('https://api.twitter.com/2/users/me?user.fields=public_metrics', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) {
        return { outcome: 'unsupported', detail: 'X returned 403 — /2/users/me is not included in this app\'s API tier. Leave available:false.' };
    }
    if (res.status === 401) return { outcome: 'unauthorised', detail: 'X rejected the token (401) — the connection needs re-authorising.' };
    if (!res.ok) return { outcome: 'no_data', detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null) as { data?: { public_metrics?: { followers_count?: number } } } | null;
    const n = body?.data?.public_metrics?.followers_count;
    if (typeof n !== 'number') return { outcome: 'no_data', detail: 'X returned no public_metrics.followers_count.' };
    return { outcome: 'ok', value: n, detail: `Account reports ${n} followers — this tier DOES allow it, so x_followers can be enabled.` };
}

/** Search Console — the probe behind `search_clicks`. */
async function probeSearchClicks(db: any, orgId: number): Promise<{ outcome: Outcome; value?: number; detail: string }> {
    let token: string;
    try {
        ({ accessToken: token } = await getFreshAccessToken(db, orgId, 'searchconsole'));
    } catch (e) {
        return { outcome: 'not_connected', detail: e instanceof Error ? e.message : 'Search Console is not connected.' };
    }

    const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (sites.status === 401 || sites.status === 403) {
        return { outcome: 'unauthorised', detail: `HTTP ${sites.status} listing properties — token or scopes rejected.` };
    }
    if (!sites.ok) return { outcome: 'no_data', detail: `HTTP ${sites.status} listing Search Console properties.` };

    const siteData = (await sites.json().catch(() => ({}))) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
    const properties = (siteData.siteEntry ?? [])
        .filter(s => s.siteUrl && s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser')
        .map(s => s.siteUrl!);
    if (properties.length === 0) {
        return { outcome: 'no_data', detail: 'Connected, but no verified Search Console property is available to this account.' };
    }

    const range = gscDateRange(28, 3);
    let total = 0;
    let ok = false;
    const notes: string[] = [];
    for (const property of properties) {
        const res = await fetch(
            `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ startDate: range.startDate, endDate: range.endDate, rowLimit: 1 }),
            },
        );
        if (!res.ok) { notes.push(`${property}: HTTP ${res.status}`); continue; }
        const data = (await res.json().catch(() => ({}))) as { rows?: { clicks?: number }[] };
        const clicks = Math.round(data.rows?.[0]?.clicks ?? 0);
        total += clicks;
        ok = true;
        notes.push(`${property}: ${clicks} clicks`);
    }

    if (!ok) return { outcome: 'no_data', detail: `Every property query failed — ${notes.join('; ')}` };
    return {
        outcome: 'ok',
        value: total,
        detail: `${range.startDate}→${range.endDate} across ${properties.length} propert${properties.length === 1 ? 'y' : 'ies'} — ${notes.join('; ')}`,
    };
}

export default withLambda(async (event) => {
    if ((event.httpMethod || 'GET') !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const results: Result[] = [];
    const push = (metricKey: string, r: { outcome: Outcome; value?: number; detail: string }) => {
        const m = getGoalMetric(metricKey);
        results.push({ metricKey, label: m?.label ?? metricKey, offered: !!m?.available, ...r });
    };

    // ── Instagram account-level insights ───────────────────────────────────────
    const [ig] = await db
        .select({ externalUserId: systemConnections.externalUserId, vaultRefKey: systemConnections.vaultRefKey })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.serviceName, 'instagram'),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);

    if (!ig?.externalUserId || !ig.vaultRefKey) {
        push('instagram_profile_views', { outcome: 'not_connected', detail: 'No active Instagram connection in this workspace.' });
    } else {
        const secret = await getSecret(db, ig.vaultRefKey).catch(() => null);
        const token = (secret?.token as string | undefined) ?? null;
        if (!token) {
            push('instagram_profile_views', { outcome: 'unauthorised', detail: 'Instagram connection has no usable token in the vault.' });
        } else {
            // Probe the candidate names in turn. The FIRST that works is the one the poller should
            // use — report every attempt so a rename is visible rather than silently absorbed.
            const candidates = ['profile_views', 'profile_links_taps', 'website_clicks'];
            let settled = false;
            for (const metric of candidates) {
                const r = await probeIgAccountMetric(ig.externalUserId, token, metric);
                if (r.outcome === 'ok') { push('instagram_profile_views', r); settled = true; break; }
                // A rejected token won't improve on the next name — stop and report it.
                if (r.outcome === 'unauthorised') { push('instagram_profile_views', r); settled = true; break; }
                results.push({
                    metricKey: 'instagram_profile_views',
                    label: `Instagram Profile Visits — candidate "${metric}"`,
                    offered: !!getGoalMetric('instagram_profile_views')?.available,
                    outcome: r.outcome,
                    detail: r.detail,
                });
            }
            if (!settled) {
                push('instagram_profile_views', {
                    outcome: 'unsupported',
                    detail: `None of ${candidates.join(', ')} returned data on Graph ${GRAPH_VERSION}. Leave available:false.`,
                });
            }
        }
    }

    // ── Facebook: Page followers + post insights ───────────────────────────────
    // The three derived metrics (reach / engagement rate / link clicks) are summed out of
    // post_insights, so they cannot be probed directly — what CAN be probed is whether the Graph
    // calls that fill that table succeed. One probe result is therefore reported against all three.
    const [fb] = await db
        .select({ externalUserId: systemConnections.externalUserId, vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.serviceName, 'facebook'),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);

    const FB_INSIGHT_METRICS = ['facebook_reach', 'facebook_engagement_rate', 'facebook_link_clicks'];
    const fbPageId = ((fb?.metadata as any)?.fbPageId as string | undefined) || fb?.externalUserId;
    if (!fb || !fbPageId) {
        const miss = { outcome: 'not_connected' as Outcome, detail: 'No active Facebook Page connection in this workspace.' };
        push('facebook_followers', miss);
        for (const k of FB_INSIGHT_METRICS) push(k, miss);
    } else {
        const fbSecret = await getSecret(db, fb.vaultRefKey!).catch(() => null);
        const fbToken = (fbSecret?.token as string | undefined) ?? null;
        if (!fbToken) {
            const miss = { outcome: 'unauthorised' as Outcome, detail: 'Facebook connection has no usable token in the vault.' };
            push('facebook_followers', miss);
            for (const k of FB_INSIGHT_METRICS) push(k, miss);
        } else {
            push('facebook_followers', await probeFacebookFollowers(fbPageId, fbToken));
            const insights = await probeFacebookPostInsights(db, orgId, fbToken);
            for (const k of FB_INSIGHT_METRICS) push(k, insights);
        }
    }

    // ── YouTube subscribers / X followers ──────────────────────────────────────
    push('youtube_subscribers', await probeYouTubeSubscribers(db, orgId));
    push('x_followers', await probeXFollowers(db, orgId));

    // ── Search Console clicks ──────────────────────────────────────────────────
    push('search_clicks', await probeSearchClicks(db, orgId));

    // ── Everything else: state why it wasn't probed ────────────────────────────
    const probed = new Set([
        'instagram_profile_views', 'search_clicks',
        'facebook_followers', ...FB_INSIGHT_METRICS,
        'youtube_subscribers', 'x_followers',
    ]);
    for (const m of GOAL_METRICS) {
        if (probed.has(m.key)) continue;
        if (m.source === 'internal') {
            push(m.key, { outcome: 'skipped', detail: 'Internal metric — counted from our own database, no third-party call to verify.' });
        } else if (m.key === 'linkedin_followers') {
            push(m.key, {
                outcome: 'unsupported',
                detail: 'Needs LinkedIn ORGANISATION scopes; the app holds member-only (w_member_social). Permanently unmeasurable until those scopes are approved.',
            });
        } else {
            const connected = await db
                .select({ id: systemConnections.id })
                .from(systemConnections)
                .where(and(
                    eq(systemConnections.organisationId, orgId),
                    eq(systemConnections.serviceName, m.connectionService ?? ''),
                    eq(systemConnections.status, 'active'),
                    eq(systemConnections.isActive, true),
                ))
                .limit(1);
            push(m.key, connected.length
                ? { outcome: 'skipped', detail: `${m.connectionService} is connected; this metric is read from post_insights rather than a live call.` }
                : { outcome: 'not_connected', detail: `${m.connectionService} is not connected in this workspace.` });
        }
    }

    // Actionable summary: the two states that mean the catalog and reality disagree.
    const shouldEnable = results.filter(r => !r.offered && r.outcome === 'ok').map(r => r.metricKey);
    const shouldDisable = results.filter(r => r.offered && (r.outcome === 'unsupported' || r.outcome === 'unauthorised')).map(r => r.metricKey);
    // Reported separately so two empty action lists can't be misread as "everything checks out".
    // An `error` is the absence of a verdict — a rate limit, a blip, an unrecognised Graph code —
    // and the honest response to one is to re-run, not to conclude anything.
    const inconclusive = results.filter(r => r.outcome === 'error').map(r => r.metricKey);

    return json(200, {
        organisationId: orgId,
        graphVersion: GRAPH_VERSION,
        results,
        summary: {
            shouldEnable,
            shouldDisable,
            inconclusive,
            note: shouldEnable.length || shouldDisable.length
                ? 'Update `available` in src/config/goal-metrics.ts for the metrics listed above.'
                : inconclusive.length
                    ? 'No catalog change indicated, but some probes were inconclusive — re-run before concluding anything about those.'
                    : 'Catalog availability matches what the live APIs return.',
        },
    });
});
