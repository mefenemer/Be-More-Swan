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

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, workspaceIntegrations } from '../../db/schema';
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
type Outcome =
    | 'ok'              // returned a usable number — safe to offer
    | 'not_connected'   // the backing account/integration isn't connected in this workspace
    | 'unauthorised'    // connected, but the token or scopes were rejected (401/403)
    | 'unsupported'     // the API rejected the metric name itself — this metric cannot be measured
    | 'no_data'         // call succeeded but carried no value (new/empty account)
    | 'skipped';        // nothing to probe (internal metrics read our own database)

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
        return { outcome: 'no_data', detail: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    }

    const body = await res.json().catch(() => null) as {
        data?: { values?: { value?: number }[] }[];
        error?: { code?: number; message?: string; error_subcode?: number };
    } | null;

    if (res.status === 401 || res.status === 403) {
        return { outcome: 'unauthorised', detail: body?.error?.message ?? `HTTP ${res.status} — token or scopes rejected.` };
    }
    if (!res.ok) {
        // Graph error 100 on an insights call almost always means "no such metric for this version".
        const msg = body?.error?.message ?? `HTTP ${res.status}`;
        const unsupported = body?.error?.code === 100;
        return {
            outcome: unsupported ? 'unsupported' : 'no_data',
            detail: `${msg}${unsupported ? ` — "${metric}" is not accepted by Graph ${GRAPH_VERSION}.` : ''}`,
        };
    }

    const series = body?.data?.[0]?.values;
    if (!Array.isArray(series) || series.length === 0) {
        return { outcome: 'no_data', detail: `Graph accepted "${metric}" but returned no data points.` };
    }
    const total = series.reduce((s, p) => s + (typeof p?.value === 'number' ? p.value : 0), 0);
    return { outcome: 'ok', value: total, detail: `"${metric}" returned ${series.length} daily points, 30-day total ${total}.` };
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

    // ── Search Console clicks ──────────────────────────────────────────────────
    push('search_clicks', await probeSearchClicks(db, orgId));

    // ── Everything else: state why it wasn't probed ────────────────────────────
    const probed = new Set(['instagram_profile_views', 'search_clicks']);
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

    return json(200, {
        organisationId: orgId,
        graphVersion: GRAPH_VERSION,
        results,
        summary: {
            shouldEnable,
            shouldDisable,
            note: shouldEnable.length || shouldDisable.length
                ? 'Update `available` in src/config/goal-metrics.ts for the metrics listed above.'
                : 'Catalog availability matches what the live APIs return.',
        },
    });
});
