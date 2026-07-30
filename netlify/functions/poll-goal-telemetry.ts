// netlify/functions/poll-goal-telemetry.ts
// SMART Goals — Feature 4 / US4.1 + US1.2. Scheduled worker (hourly cron) that, for each
// active goal due a refresh, fetches the current metric value, appends a goal_telemetry row,
// and recomputes the goal's status via the run-rate engine.
//
//   AC4.1.1 tier-based cadence  — each goal polled at most once per its tier's cadence.
//   AC4.1.2 secure auth         — third-party tokens decrypted from the vault per request.
//   AC4.3.1 rate-limit backoff  — 429s retried with exponential backoff before giving up.
//   AC4.3.2 stale-data flag     — no fresh data for >48h flips the goal to data_disconnected.
//   AC4.3.3 alerting            — a critical_action notification fires when that happens.
//
// User-reported goals (source: 'manual') pass through here too, but on a separate branch — there is
// nothing to fetch, so all this cron does for them is notice when the figure is overdue. See
// handleManualGoal, and the comment there for why they must never take the disconnected path.
//
// Owner-path (getDb) + manual org filter, like ingest-instagram-insights.

import { Handler } from '@netlify/functions';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    goals, goalTelemetry, aiAssistants, systemConnections,
    scheduledPosts, leads, plans, masterPlans, assistantRecords, blogPosts,
} from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { getSecret } from '../../src/utils/vault';
import {
    connectionDisplayName, getGoalMetric, pollCadenceHours, RUN_RATE_THRESHOLDS,
    isManualMetric, staleWindowHoursFor, staleStatusFor,
} from '../../src/config/goal-metrics';
import { computeGoalProgress } from '../../src/utils/goal-progress';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { getFreshAccessToken } from '../../src/utils/workspace-integrations';
import { gscDateRange } from '../../src/utils/gsc-decay';
import { withLambda } from '@netlify/aws-lambda-compat';

const GRAPH_VERSION = 'v19.0';
const BATCH = 200;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Recompile the assistant's blueprint after a goal STATUS transition, so section 12's directive
 * (and its escalated "this goal is NOT on track" wording) reaches the next drafted post.
 *
 * Best-effort: this runs inside a cron that must finish inside the function timeout, and the
 * telemetry write is already committed. A recompile failure is logged and skipped — the status is
 * still correct in the database and the next user edit or transition will recompile.
 */
async function recompileForGoalStatus(assistantId: number, from: string, to: string): Promise<void> {
    try {
        await assembleBlueprint(assistantId, 'system', `goal_status_${to}`);
    } catch (e) {
        console.warn(`[poll-goal-telemetry] recompile after ${from}→${to} for assistant ${assistantId} failed:`,
            e instanceof Error ? e.message : e);
    }
}

type FetchResult = { value: number | null; disconnected: boolean };

// ── Instagram account follower count (the one live third-party call) ────────────
async function fetchIgFollowers(igUserId: string, token: string): Promise<FetchResult> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}?fields=followers_count&access_token=${token}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url);
        if (res.status === 429) {                       // AC4.3.1 — exponential backoff before retry
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) return { value: null, disconnected: false };
        const body = await res.json().catch(() => null) as { followers_count?: number } | null;
        return { value: typeof body?.followers_count === 'number' ? body.followers_count : null, disconnected: false };
    }
    return { value: null, disconnected: false };         // exhausted retries — treat as transient, not disconnected
}

// ── Facebook Page follower count ───────────────────────────────────────────────
// The same call get-follower-counts.ts already makes for the workspace Audience block, on the same
// Page token Instagram uses. `followers_count` is the modern field; `fan_count` is the legacy
// "likes" number some Pages still report instead, so we accept either.
async function fetchFacebookFollowers(pageId: string, token: string): Promise<FetchResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(token)}`);
        if (res.status === 429) { await sleep(1000 * 2 ** attempt); continue; }   // AC4.3.1 backoff
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) return { value: null, disconnected: false };
        const body = await res.json().catch(() => null) as { followers_count?: number; fan_count?: number } | null;
        const n = body?.followers_count ?? body?.fan_count;
        return { value: typeof n === 'number' ? n : null, disconnected: false };
    }
    return { value: null, disconnected: false };
}

// ── YouTube subscriber count ───────────────────────────────────────────────────
// ⚠️ A channel can HIDE its subscriber count. That comes back as `hiddenSubscriberCount: true` with
// no number, and it is NOT a disconnection — the token is fine and reconnecting would change
// nothing. Reported as a plain miss so the goal stays unmeasured rather than nagging the user to
// re-authenticate something that isn't broken.
async function fetchYouTubeSubscribers(token: string): Promise<FetchResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) return { value: null, disconnected: false };
        const body = await res.json().catch(() => null) as
            { items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }> } | null;
        const stats = body?.items?.[0]?.statistics;
        if (stats?.hiddenSubscriberCount) return { value: null, disconnected: false };
        const n = Number(stats?.subscriberCount);
        return { value: Number.isFinite(n) ? n : null, disconnected: false };
    }
    return { value: null, disconnected: false };
}

// ── X follower count ───────────────────────────────────────────────────────────
// ⚠️ A 403 here usually means the app's API TIER doesn't include /users/me, not that the user
// revoked access — which is why `x_followers` ships available:false until goal-metric-selftest.ts
// confirms otherwise. Treated as disconnected anyway: from this function's position the two are
// indistinguishable, and the metric isn't offered, so nobody can be alarmed by the classification.
async function fetchXFollowers(token: string): Promise<FetchResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('https://api.twitter.com/2/users/me?user.fields=public_metrics', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) return { value: null, disconnected: false };
        const body = await res.json().catch(() => null) as
            { data?: { public_metrics?: { followers_count?: number } } } | null;
        const n = body?.data?.public_metrics?.followers_count;
        return { value: typeof n === 'number' ? n : null, disconnected: false };
    }
    return { value: null, disconnected: false };
}

type LiConn = { id: number; vaultRefKey: string | null; metadata: any };

// ── LinkedIn GET with the same 429-backoff + auth handling as the IG path ───────
async function liFetch(url: string, token: string): Promise<{ ok: boolean; disconnected: boolean; body: any }> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' } });
        if (res.status === 429) {                        // AC4.3.1 — exponential backoff before retry
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.status === 401 || res.status === 403) return { ok: false, disconnected: true, body: null };
        if (!res.ok) return { ok: false, disconnected: false, body: null };
        return { ok: true, disconnected: false, body: await res.json().catch(() => null) };
    }
    return { ok: false, disconnected: false, body: null };   // exhausted retries — transient
}

// ── LinkedIn organisation follower count (org URN resolved once, then cached on the connection) ──
async function fetchLinkedInFollowers(db: any, conn: LiConn): Promise<FetchResult> {
    if (!conn.vaultRefKey) return { value: null, disconnected: true };
    const secret = await getSecret(db, conn.vaultRefKey);
    const token = (secret?.token as string | undefined) ?? null;
    if (!token) return { value: null, disconnected: true };

    // Resolve the administered organisation URN, caching it so we skip the ACL call next time.
    const meta = (conn.metadata as Record<string, any>) ?? {};
    let orgUrn: string | null = typeof meta.organizationUrn === 'string' ? meta.organizationUrn : null;
    if (!orgUrn) {
        const acl = await liFetch('https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization))', token);
        if (acl.disconnected) return { value: null, disconnected: true };
        if (!acl.ok) return { value: null, disconnected: false };
        orgUrn = (acl.body?.elements?.[0]?.organization as string | undefined) ?? null;
        if (!orgUrn) return { value: null, disconnected: false };   // no administered org yet — transient, token is fine
        await db.update(systemConnections)
            .set({ metadata: { ...meta, organizationUrn: orgUrn }, updatedAt: new Date() })
            .where(eq(systemConnections.id, conn.id))
            .catch(() => {});
    }

    // firstDegreeSize = the org's follower count. Requires r_organization_social.
    const orgId = orgUrn.split(':').pop();
    const net = await liFetch(`https://api.linkedin.com/v2/networkSizes/urn:li:organization:${orgId}?edgeType=CompanyFollowedByMember`, token);
    if (net.disconnected) return { value: null, disconnected: true };
    if (!net.ok) return { value: null, disconnected: false };
    return { value: typeof net.body?.firstDegreeSize === 'number' ? net.body.firstDegreeSize : null, disconnected: false };
}

// ── Search Console clicks (the 'action' / traffic metric) ───────────────────────
// Deliberately mirrors ingest-gsc-metrics.ts: same endpoint, same auth helper, same date window.
// That function runs daily in production and reads `impressions` out of this response; `clicks` is
// returned by the very same call for every row, so this adds no new API surface, scope or version
// risk. Site-wide (no page filter) because a traffic GOAL is about the whole property, whereas the
// decay detector asks about one post at a time.
const GSC_LOOKBACK_DAYS = Number(process.env.GSC_LOOKBACK_DAYS || 28);
const GSC_LAG_DAYS = Number(process.env.GSC_LAG_DAYS || 3);   // GSC data trails ~2-3 days
// Cap the properties queried per goal. This poller is an hourly cron with NO overall time budget
// (pre-existing — instagram_followers and linkedin_followers already make live calls), and search
// clicks cost 1 + N requests rather than 1. Most workspaces verify one or two properties, so a cap
// bounds the worst case without changing normal behaviour. Properties are sorted for determinism so
// the same subset is measured on every poll — a goal whose baseline came from a different set of
// properties each hour would produce meaningless run-rate arithmetic.
const GSC_MAX_PROPERTIES = Number(process.env.GSC_MAX_PROPERTIES || 5);

async function fetchSearchClicks(db: any, goal: any): Promise<FetchResult> {
    let token: string;
    try {
        ({ accessToken: token } = await getFreshAccessToken(db, goal.organisationId, 'searchconsole'));
    } catch {
        // No connection, or the token could not be refreshed → treat as disconnected so a stale goal
        // eventually flips to data_disconnected and tells the user to reconnect.
        return { value: null, disconnected: true };
    }

    const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (sites.status === 401 || sites.status === 403) return { value: null, disconnected: true };
    if (!sites.ok) return { value: null, disconnected: false };

    const siteData = (await sites.json().catch(() => ({}))) as {
        siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
    };
    const properties = (siteData.siteEntry ?? [])
        .filter(s => s.siteUrl && s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser')
        .map(s => s.siteUrl!)
        .sort()                              // deterministic — see GSC_MAX_PROPERTIES
        .slice(0, GSC_MAX_PROPERTIES);
    // Verified access but no usable property is a real answer (0), not a failure — otherwise the goal
    // would sit 'pending' forever with no explanation.
    if (properties.length === 0) return { value: 0, disconnected: false };

    const range = gscDateRange(GSC_LOOKBACK_DAYS, GSC_LAG_DAYS);
    let total = 0;
    let anySucceeded = false;

    for (const property of properties) {
        const res = await fetch(
            `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                // No dimensions → one summary row for the whole property in the window.
                body: JSON.stringify({ startDate: range.startDate, endDate: range.endDate, rowLimit: 1 }),
            },
        );
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) continue;                    // one bad property must not void the others
        const data = (await res.json().catch(() => ({}))) as { rows?: { clicks?: number }[] };
        total += Math.round(data.rows?.[0]?.clicks ?? 0);
        anySucceeded = true;
    }

    // Every property errored → report nothing rather than a misleading 0.
    return anySucceeded ? { value: total, disconnected: false } : { value: null, disconnected: false };
}

// ── Instagram account-level insights (profile visits) ───────────────────────────
// Candidate metric names, tried in order until one returns data. Meta renames these: `impressions`
// became `views`, and `website_clicks` appears to have given way to `profile_links_taps`. Requesting
// several names in ONE call is not an option — Graph rejects the whole request (error 100) if any
// single metric name is invalid — so each is attempted separately.
//
// This is why `instagram_profile_views` ships `available: false`. The chain below degrades safely,
// but "degrades safely" is exactly how linkedin_followers looked before it turned out to be
// permanently unmeasurable. Verify with goal-metric-selftest.ts before flipping the flag.
const IG_PROFILE_VIEW_METRICS = ['profile_views'] as const;

async function fetchIgProfileViews(igUserId: string, token: string): Promise<FetchResult> {
    const range = gscDateRange(30, 1);   // same day-window helper; GSC-agnostic date arithmetic
    for (const metric of IG_PROFILE_VIEW_METRICS) {
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/insights`
            + `?metric=${metric}&period=day&since=${range.startDate}&until=${range.endDate}`
            + `&access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url);
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) continue;                    // invalid/deprecated metric name → try the next
        const body = await res.json().catch(() => null) as
            { data?: { name?: string; values?: { value?: number }[] }[] } | null;
        const series = body?.data?.[0]?.values;
        if (!Array.isArray(series)) continue;
        // period=day returns one point per day; a 30-day total is the comparable figure.
        const total = series.reduce((sum, p) => sum + (typeof p?.value === 'number' ? p.value : 0), 0);
        return { value: total, disconnected: false };
    }
    return { value: null, disconnected: false };
}

/**
 * Count of this assistant's records of a given type (optionally status-filtered) — the measurement
 * behind the non-social role outcome metrics (Leads Scored, Tickets Resolved, …). Always org- AND
 * assistant-scoped so one assistant's goal never counts another's records.
 */
async function countRecords(db: any, goal: any, recordType: string, statusFilter?: any): Promise<FetchResult> {
    const where = [
        eq(assistantRecords.aiAssistantId, goal.assistantId),
        eq(assistantRecords.organisationId, goal.organisationId),
        eq(assistantRecords.recordType, recordType),
    ];
    if (statusFilter) where.push(statusFilter);
    const [row] = await db
        .select({ v: sql<number>`count(*)::int` })
        .from(assistantRecords)
        .where(and(...where));
    return { value: Number(row?.v ?? 0), disconnected: false };
}

/**
 * SUM of one post_insights column over the trailing 30 days, for ONE platform.
 *
 * ⚠️ THE `platform` FILTER IS LOAD-BEARING. These aggregates used to omit it, which was harmless
 * only for as long as ingest-instagram-insights.ts was the table's sole writer. The moment
 * ingest-facebook-insights.ts started filling the same table, an unfiltered SUM(reach) would have
 * quietly begun counting Facebook reach toward an INSTAGRAM goal — a goal silently measuring
 * something other than what it says, with no error anywhere to notice.
 */
async function sumInsight(db: any, goal: any, platform: string, column: 'reach' | 'link_clicks'): Promise<FetchResult> {
    const [row] = await db.execute(sql`
        SELECT COALESCE(SUM(${sql.raw(column)}), 0)::int AS v FROM post_insights
        WHERE assistant_id = ${goal.assistantId} AND organisation_id = ${goal.organisationId}
          AND platform = ${platform}
          AND published_at >= now() - interval '30 days'`);
    return { value: Number((row as any)?.v ?? 0), disconnected: false };
}

/** Interactions ÷ reach over the trailing 30 days, as a percentage, for ONE platform. */
async function engagementRate(db: any, goal: any, platform: string): Promise<FetchResult> {
    const [row] = await db.execute(sql`
        SELECT COALESCE(SUM(total_interactions),0)::float AS inter, COALESCE(SUM(reach),0)::float AS reach
        FROM post_insights
        WHERE assistant_id = ${goal.assistantId} AND organisation_id = ${goal.organisationId}
          AND platform = ${platform}
          AND published_at >= now() - interval '30 days'`);
    const r = row as any;
    const rate = r && r.reach > 0 ? (r.inter / r.reach) * 100 : 0;
    return { value: Math.round(rate * 100) / 100, disconnected: false };
}

/** The vault token for one of an org's social connections, or null when it isn't usable. */
async function tokenForConn(db: any, conn: { vaultRefKey: string | null } | null | undefined): Promise<string | null> {
    if (!conn?.vaultRefKey) return null;
    const secret = await getSecret(db, conn.vaultRefKey).catch(() => null);
    return (secret?.token as string | undefined) ?? null;
}

type SocialConn = { id: number; externalUserId: string | null; vaultRefKey: string | null; metadata: any };

async function fetchMetric(
    db: any,
    goal: any,
    conns: { byService: Map<string, SocialConn>; li: LiConn | null },
): Promise<FetchResult> {
    const metric = getGoalMetric(goal.metricKey);
    if (!metric) return { value: null, disconnected: false };
    const igConn = conns.byService.get('instagram') ?? null;

    switch (goal.metricKey) {
        case 'instagram_followers': {
            if (!igConn?.externalUserId) return { value: null, disconnected: true };
            const token = await tokenForConn(db, igConn);
            if (!token) return { value: null, disconnected: true };
            return fetchIgFollowers(igConn.externalUserId, token);
        }
        case 'instagram_reach':
            return sumInsight(db, goal, 'instagram', 'reach');
        case 'instagram_engagement_rate':
            return engagementRate(db, goal, 'instagram');

        // ── Facebook ────────────────────────────────────────────────────────────
        case 'facebook_followers': {
            const fb = conns.byService.get('facebook');
            // The Page id is stashed on the connection metadata at OAuth time; externalUserId is the
            // fallback for connections made before that was recorded (same order get-follower-counts
            // uses, so the two agree about which Page a workspace means).
            const pageId = (fb?.metadata?.fbPageId as string | undefined) || fb?.externalUserId;
            if (!fb || !pageId) return { value: null, disconnected: true };
            const token = await tokenForConn(db, fb);
            if (!token) return { value: null, disconnected: true };
            return fetchFacebookFollowers(pageId, token);
        }
        case 'facebook_reach':
            return sumInsight(db, goal, 'facebook', 'reach');
        case 'facebook_engagement_rate':
            return engagementRate(db, goal, 'facebook');
        case 'facebook_link_clicks':
            // The Social Media Manager's first real 'action' metric. Filled by
            // ingest-facebook-insights.ts — Instagram hardcodes this column to null.
            return sumInsight(db, goal, 'facebook', 'link_clicks');

        // ── Other connected platforms ───────────────────────────────────────────
        case 'youtube_subscribers': {
            // YouTube lives in workspace_integrations, so its token comes from the integrations
            // helper (which also refreshes it) rather than from a system_connections vault ref.
            let token: string;
            try {
                ({ accessToken: token } = await getFreshAccessToken(db, goal.organisationId, 'youtube'));
            } catch {
                return { value: null, disconnected: true };
            }
            return fetchYouTubeSubscribers(token);
        }
        case 'x_followers': {
            const x = conns.byService.get('x');
            const token = await tokenForConn(db, x);
            if (!token) return { value: null, disconnected: true };
            return fetchXFollowers(token);
        }

        case 'linkedin_followers': {
            if (!conns.li) return { value: null, disconnected: true };
            return fetchLinkedInFollowers(db, conns.li);
        }
        case 'search_clicks': {
            return fetchSearchClicks(db, goal);
        }
        case 'instagram_profile_views': {
            if (!igConn?.externalUserId) return { value: null, disconnected: true };
            const token = await tokenForConn(db, igConn);
            if (!token) return { value: null, disconnected: true };
            return fetchIgProfileViews(igConn.externalUserId, token);
        }
        case 'qualified_leads': {
            // "Qualified" = leads that progressed to a won/converted state for this workspace.
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(leads)
                .where(and(eq(leads.organisationId, goal.organisationId), eq(leads.status, 'converted')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }
        case 'content_published': {
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.assistantId, goal.assistantId), eq(scheduledPosts.status, 'published')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }
        case 'posts_published': {
            // Blog Writer outcome — published long-form posts (blog_posts), mirroring 'content_published'.
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(blogPosts)
                .where(and(eq(blogPosts.assistantId, goal.assistantId), eq(blogPosts.status, 'published')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }

        // ── Non-social role outcomes — counted from assistant_records (the Data Hub database). ──
        // recordType is CHECK-constrained to lead|enrichment|meeting|invoice|ticket; status is a
        // freeform lifecycle label, so status-filtered metrics match loosely (ILIKE), never enum.
        case 'leads_scored':
            return countRecords(db, goal, 'lead');
        case 'records_enriched':
            return countRecords(db, goal, 'enrichment');
        case 'meetings_summarized':
            return countRecords(db, goal, 'meeting');
        case 'invoices_chased':
            return countRecords(db, goal, 'invoice');
        case 'tickets_resolved':
            return countRecords(db, goal, 'ticket', sql`status ILIKE '%resolv%'`);
        case 'cash_recovered': {
            // Sum the numeric amount stashed in data (invoices.0.amount or a top-level amount) for
            // invoices that have reached a settled/paid/recovered stage. Coerced defensively so a
            // missing or non-numeric amount contributes 0 rather than erroring the whole poll.
            const [row] = await db.execute(sql`
                SELECT COALESCE(SUM(
                    COALESCE(
                        NULLIF(regexp_replace(COALESCE(data #>> '{invoices,0,amount}', data ->> 'amount', '0'), '[^0-9.]', '', 'g'), '')::numeric,
                        0
                    )
                ), 0)::float AS v
                FROM assistant_records
                WHERE ai_assistant_id = ${goal.assistantId}
                  AND organisation_id = ${goal.organisationId}
                  AND record_type = 'invoice'
                  AND status ILIKE ANY (ARRAY['%paid%', '%settled%', '%recover%'])`);
            return { value: Number((row as any)?.v ?? 0), disconnected: false };
        }
        default:
            return { value: null, disconnected: false };
    }
}

/**
 * A user-reported goal has nothing to fetch — its value arrives via record-goal-value.ts. All this
 * cron owes it is the nudge: once the figure is overdue, flip to `awaiting_update` and tell the
 * person who set the goal.
 *
 * It must NOT take the disconnected path below. That path is written for a broken integration:
 * it fires `goal_data_disconnected`, which notification-actions.ts classes as `critical_action` —
 * an undismissible red "we lost connection to X, re-authenticate" alert. For a manual metric there
 * is no X, nothing is broken, and the fix is for the user to type a number. On the 48h connection
 * window a monthly revenue figure would raise that alarm on day three of every month.
 *
 * Returns true when a transition was made (for the run counters).
 */
async function handleManualGoal(db: any, goal: any, lastTelemetryAt: Date | null, now: Date): Promise<boolean> {
    // No entry at all yet — the goal is legitimately 'pending' and the builder just told the user
    // they'd be entering this themselves. Nagging on day one would be noise.
    if (!lastTelemetryAt) return false;

    const overdue = now.getTime() - lastTelemetryAt.getTime() > staleWindowHoursFor(goal.metricKey) * 3600_000;
    if (!overdue || goal.status === 'awaiting_update') return false;

    const nextStatus = staleStatusFor(goal.metricKey);   // 'awaiting_update' for every manual metric
    await db.update(goals)
        .set({ status: nextStatus, statusUpdatedAt: now, updatedAt: now })
        .where(eq(goals.id, goal.id));
    await recompileForGoalStatus(goal.assistantId, goal.status, nextStatus);

    if (goal.createdByUserId) {
        const metric = getGoalMetric(goal.metricKey);
        await createNotification(db, 'goal_metric_update_due', {
            userId: goal.createdByUserId,
            context: {
                goal: { label: goal.title || metric?.label || goal.metricKey },
                metric: { label: metric?.label ?? goal.metricKey },
            },
        });
    }
    return true;
}

export async function pollGoalTelemetry(): Promise<{ goals: number; polled: number; skipped: number; disconnected: number; awaitingUpdate: number }> {
    const db = getDb();
    const now = new Date();

    const activeGoals = await db
        .select()
        .from(goals)
        .where(eq(goals.isActive, true))
        .limit(BATCH);

    if (!activeGoals.length) return { goals: 0, polled: 0, skipped: 0, disconnected: 0, awaitingUpdate: 0 };

    // Per-org polling cadence (AC4.1.1) — one tier lookup per org.
    const orgIds = [...new Set(activeGoals.map(g => g.organisationId))];
    const tierRows = await db
        .select({ orgId: plans.organisationId, tierKey: masterPlans.tierKey })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(inArray(plans.organisationId, orgIds), eq(plans.status, 'active')));
    const tierByOrg = new Map<number, string | null>(tierRows.map(r => [r.orgId as number, r.tierKey]));

    // Every active social connection for every org in this batch, in ONE query.
    //
    // This used to be two `.limit(1)` lookups per org inside a loop — 2N queries to find Instagram
    // and LinkedIn. Adding Facebook and X would have made it 4N, inside an hourly cron that has no
    // overall time budget. One query and a map instead: the row count is bounded by connections per
    // workspace (a handful), and adding a further platform is now free.
    const connByOrg = new Map<number, Map<string, SocialConn>>();
    const allConns = await db
        .select({
            id: systemConnections.id,
            organisationId: systemConnections.organisationId,
            serviceName: systemConnections.serviceName,
            externalUserId: systemConnections.externalUserId,
            vaultRefKey: systemConnections.vaultRefKey,
            metadata: systemConnections.metadata,
        })
        .from(systemConnections)
        .where(and(
            inArray(systemConnections.organisationId, orgIds),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ));
    for (const c of allConns) {
        const service = String(c.serviceName).toLowerCase();
        const forOrg = connByOrg.get(c.organisationId) ?? new Map<string, SocialConn>();
        // First wins, matching the old `.limit(1)` behaviour for a workspace with two accounts on
        // one platform. Which one that is stays arbitrary — unchanged from before, and out of scope
        // here, but worth knowing if multi-account support ever lands.
        if (!forOrg.has(service)) forOrg.set(service, c as SocialConn);
        connByOrg.set(c.organisationId, forOrg);
    }

    let polled = 0, disconnectedCount = 0, skipped = 0, awaitingUpdate = 0;

    await Promise.allSettled(activeGoals.map(async (goal) => {
        const cadenceMs = pollCadenceHours(tierByOrg.get(goal.organisationId)) * 3600_000;
        const lastAt = await db
            .select({ recordedAt: goalTelemetry.recordedAt })
            .from(goalTelemetry)
            .where(eq(goalTelemetry.goalId, goal.id))
            .orderBy(desc(goalTelemetry.recordedAt))
            .limit(1);
        const lastTelemetryAt: Date | null = lastAt[0]?.recordedAt ?? null;

        // User-reported metric: nothing to fetch, and neither the tier cadence nor the disconnected
        // path below applies. Handled entirely by its own branch.
        if (isManualMetric(goal.metricKey)) {
            if (await handleManualGoal(db, goal, lastTelemetryAt, now)) awaitingUpdate++;
            else skipped++;
            return;
        }

        // Throttle by tier cadence.
        if (lastTelemetryAt && now.getTime() - lastTelemetryAt.getTime() < cadenceMs) { skipped++; return; }

        const byService = connByOrg.get(goal.organisationId) ?? new Map<string, SocialConn>();
        const { value, disconnected } = await fetchMetric(db, goal, {
            byService,
            li: (byService.get('linkedin') as LiConn | undefined) ?? null,
        });

        if (value != null) {
            const startValue = goal.startValue == null ? value : Number(goal.startValue);
            await db.insert(goalTelemetry).values({
                goalId: goal.id, organisationId: goal.organisationId, metricValue: String(value), source: 'poll',
            });
            const progress = computeGoalProgress({
                startValue,
                latestValue: value,
                targetValue: Number(goal.targetValue),
                createdAt: goal.createdAt,
                targetDate: goal.targetDate,
                direction: getGoalMetric(goal.metricKey)?.direction ?? 'increase',
                lastTelemetryAt: now,           // we just recorded a fresh point
                now,
            });
            await db.update(goals).set({
                latestValue: String(value),
                startValue: String(startValue),
                status: progress.status,
                statusUpdatedAt: now,
                updatedAt: now,
            }).where(eq(goals.id, goal.id));
            // A STATUS CHANGE has to reach the drafting prompt: blueprint section 12 escalates its
            // directive when a goal is at_risk/off_track, and generation reads the PERSISTED
            // blueprint (job.blueprint_id), not the live goals table. Recompile only on a genuine
            // transition — recompiling on every poll would churn a blueprint row per goal per hour.
            if (progress.status !== goal.status) {
                await recompileForGoalStatus(goal.assistantId, goal.status, progress.status);
            }
            polled++;
            return;
        }

        // Couldn't fetch. If the connection is gone AND data is already stale, flag + alert (AC4.3.2/3).
        const staleCutoff = RUN_RATE_THRESHOLDS.staleDataHours * 3600_000;
        const isStale = !lastTelemetryAt || (now.getTime() - lastTelemetryAt.getTime() > staleCutoff);
        if (disconnected && isStale && goal.status !== 'data_disconnected') {
            await db.update(goals).set({ status: 'data_disconnected', statusUpdatedAt: now, updatedAt: now }).where(eq(goals.id, goal.id));
            await recompileForGoalStatus(goal.assistantId, goal.status, 'data_disconnected');
            disconnectedCount++;
            const metric = getGoalMetric(goal.metricKey);
            const integration = connectionDisplayName(metric?.connectionService) ?? 'your data source';
            if (goal.createdByUserId) {
                await createNotification(db, 'goal_data_disconnected', {
                    userId: goal.createdByUserId,
                    context: { integration: { name: integration } },
                });
            }
        }
    }));

    return { goals: activeGoals.length, polled, skipped, disconnected: disconnectedCount, awaitingUpdate };
}

export default withLambda(async () => {
    const result = await pollGoalTelemetry();
    return { statusCode: 200, body: JSON.stringify(result) };
});
