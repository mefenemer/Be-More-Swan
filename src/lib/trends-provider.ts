/**
 * src/lib/trends-provider.ts — where Google Trends data comes from (docs/google-trends-plan.md §5 Phase 1).
 *
 * One interface, DataForSEO first. Google's official Trends API (alpha applied for 2026-11-15) can
 * replace it later without touching callers: they only ever see TrendsProvider and RawTrendsTask.
 *
 * DataForSEO's Standard queue (task_post → tasks_ready → task_get) costs ≈ $0.0027 a task and answers
 * in 1–4 minutes (Phase 0, docs/google-trends-phase0-results.md); Live costs $0.011 and is kept for a
 * future on-demand chat look-up. Auth is Basic with DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD. An
 * account must be email-verified first, or every call answers 40104.
 *
 * Every call has a timeout and returns a result object instead of throwing on a provider error, so
 * one bad week is a stale week, never a crashed worker.
 */

const API = 'https://api.dataforseo.com/v3/keywords_data/google_trends';
const CALL_TIMEOUT_MS = 20_000;

/** One term's reply, as the provider gave it — parsed by src/utils/search-trends.ts parseTrendsTask. */
export interface RawTrendsTask {
    statusCode: number;
    statusMessage: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[];
}

export interface PostedTask { tag: string; taskId: string | null; costUsd: number; error: string | null }

export interface TrendsProvider {
    readonly name: string;
    /** Queue one Standard task per term (≤ 100 a call). `tag` comes back with the task. */
    post(tasks: Array<{ tag: string; term: string; locationCode: number }>): Promise<{ ok: true; posted: PostedTask[] } | { ok: false; error: string }>;
    /** Ids of queued tasks that have an answer waiting. Free. */
    ready(): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>;
    /** Fetch one answer. `pending` = not ready yet (try again later). Free once posted. */
    get(taskId: string): Promise<{ ok: true; task: RawTrendsTask } | { ok: false; pending: boolean; error: string }>;
    /** One term answered now (≈ $0.011). For the on-demand chat look-up, under a daily fair-use cap. */
    live(term: string, locationCode: number): Promise<{ ok: true; task: RawTrendsTask; costUsd: number } | { ok: false; error: string }>;
}

/** The usage-log model key for a Live look-up. */
export const DATAFORSEO_TRENDS_LIVE_USAGE_MODEL = 'dataforseo-trends-live';

/** The usage-log model key for a DataForSEO Trends charge (src/utils/system-map.ts maps `dataforseo-`). */
export const DATAFORSEO_TRENDS_USAGE_MODEL = 'dataforseo-trends-standard';

/** DataForSEO task statuses that mean "still in the queue". */
const IN_QUEUE = new Set([40601, 40602]);

/** The request body for one term: 12 months of weekly interest plus related searches. */
export function dataForSeoTaskBody(term: string, locationCode: number, tag: string) {
    return {
        keywords: [term],
        location_code: locationCode,
        language_code: 'en',
        type: 'web',
        time_range: 'past_12_months',
        item_types: ['google_trends_graph', 'google_trends_queries_list'],
        tag,
    };
}

/** The DataForSEO provider, or null when its credentials are not set (the engine then does nothing). */
export function dataForSeoProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): TrendsProvider | null {
    const login = env.DATAFORSEO_LOGIN;
    const password = env.DATAFORSEO_PASSWORD;
    if (!login || !password) return null;
    const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
        try {
            const res = await fetchImpl(`${API}${path}`, {
                method,
                headers: { Authorization: auth, 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
                signal: ctrl.signal,
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const json: any = await res.json().catch(() => null);
            // DataForSEO puts the reason in the body even on a 4xx (40104 "Please verify your account").
            if (!res.ok || !json) return { ok: false, error: `HTTP ${res.status}${json?.status_message ? ` ${json.status_code} ${json.status_message}` : ''}` };
            if (json.status_code !== 20000) return { ok: false, error: `${json.status_code} ${json.status_message}` };
            return { ok: true, json };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        name: 'dataforseo',
        async post(tasks) {
            if (!tasks.length) return { ok: true, posted: [] };
            if (tasks.length > 100) return { ok: false, error: 'At most 100 tasks per post.' };
            const r = await call('POST', '/explore/task_post', tasks.map((t) => dataForSeoTaskBody(t.term, t.locationCode, t.tag)));
            if (!r.ok) return r;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const posted: PostedTask[] = (r.json.tasks ?? []).map((t: any) => ({
                tag: String(t?.data?.tag ?? ''),
                taskId: t?.status_code === 20100 ? String(t.id) : null,
                costUsd: Number(t?.cost ?? 0) || 0,
                error: t?.status_code === 20100 ? null : `${t?.status_code} ${t?.status_message}`,
            }));
            return { ok: true, posted };
        },
        async ready() {
            const r = await call('GET', '/explore/tasks_ready');
            if (!r.ok) return r;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = (r.json.tasks?.[0]?.result ?? []).map((x: any) => String(x?.id ?? '')).filter(Boolean);
            return { ok: true, ids };
        },
        async get(taskId) {
            const r = await call('GET', `/explore/task_get/${encodeURIComponent(taskId)}`);
            if (!r.ok) return { ok: false, pending: false, error: r.error };
            const t = r.json.tasks?.[0];
            const code = Number(t?.status_code ?? 0);
            if (IN_QUEUE.has(code)) return { ok: false, pending: true, error: `${code} ${t?.status_message}` };
            return { ok: true, task: { statusCode: code, statusMessage: String(t?.status_message ?? ''), items: t?.result?.[0]?.items ?? [] } };
        },
        async live(term, locationCode) {
            const r = await call('POST', '/explore/live', [dataForSeoTaskBody(term, locationCode, 'live')]);
            if (!r.ok) return r;
            const t = r.json.tasks?.[0];
            return {
                ok: true,
                costUsd: Number(t?.cost ?? r.json.cost ?? 0) || 0,
                task: { statusCode: Number(t?.status_code ?? 0), statusMessage: String(t?.status_message ?? ''), items: t?.result?.[0]?.items ?? [] },
            };
        },
    };
}

// ── Is the login accepted? (Admin ▸ Search trends) ──────────────────────────────────────────────
// Prod 2026-11-16: the Provider tile said "Connected" for hours while DataForSEO refused every call
// (401 40100), because it only checked that the env vars were set. This asks the provider for real,
// with the FREE tasks_ready call.

export type ProviderStatus = 'ok' | 'refused' | 'unverified' | 'unreachable' | 'error' | 'not_set';
export interface ProviderCheck { status: ProviderStatus; detail: string | null }

export const PROVIDER_CHECK_TIMEOUT_MS = 5_000;

/** Pure: what a failed call's error says about the login. */
export function classifyProviderError(error: string): ProviderCheck {
    const e = error.trim();
    if (/^HTTP 401\b|\b4010[0-9]\b/.test(e)) {
        // 40104 = the account has not verified its email yet; 40100 = wrong login / API password.
        return { status: /\b40104\b/.test(e) ? 'unverified' : 'refused', detail: e.slice(0, 200) };
    }
    if (/abort|timed? ?out|ENOTFOUND|ECONNRE|fetch failed|network/i.test(e)) return { status: 'unreachable', detail: e.slice(0, 200) };
    return { status: 'error', detail: e.slice(0, 200) };
}

/** Ask the provider whether it accepts our login. Never throws; bounded by PROVIDER_CHECK_TIMEOUT_MS. */
export async function checkProvider(provider: TrendsProvider | null, timeoutMs = PROVIDER_CHECK_TIMEOUT_MS): Promise<ProviderCheck> {
    if (!provider) return { status: 'not_set', detail: null };
    const timeout = new Promise<{ ok: false; error: string }>((resolve) => setTimeout(() => resolve({ ok: false, error: 'timed out' }), timeoutMs));
    try {
        const r = await Promise.race([provider.ready(), timeout]);
        return r.ok ? { status: 'ok', detail: null } : classifyProviderError(r.error);
    } catch (err) {
        return classifyProviderError(err instanceof Error ? err.message : String(err));
    }
}

/**
 * Google Trends location codes (Google Ads geo targets) for the countries a workspace can be in.
 * Country is the default region (plan §10 condition 1); a nation or state is added per term only
 * where its data holds up, resolved by name through DataForSEO's free locations endpoint.
 */
export const COUNTRY_LOCATION: Record<string, { code: number; name: string }> = {
    GB: { code: 2826, name: 'United Kingdom' },
    US: { code: 2840, name: 'United States' },
    IE: { code: 2372, name: 'Ireland' },
    AU: { code: 2036, name: 'Australia' },
    CA: { code: 2124, name: 'Canada' },
    NZ: { code: 2554, name: 'New Zealand' },
};

/** The location for a workspace's country (ISO 3166-1 alpha-2; UK accepted for GB), UK when unknown. */
export function countryLocation(iso: string | null | undefined): { code: number; name: string } {
    const k = String(iso ?? '').trim().toUpperCase();
    return COUNTRY_LOCATION[k === 'UK' ? 'GB' : k] ?? COUNTRY_LOCATION.GB;
}
