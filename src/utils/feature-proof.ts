// src/utils/feature-proof.ts — Feature requests get the Fix pipeline's checks (owner, 2026-11-13).
//
// The owner: "it must do the same thing [as the Fix pipeline] before I start using it". So a feature Claude
// builds (scripts/feature-requests.ts) now carries the same evidence, gates and go-live check as a fix
// (src/utils/issue-fix-proof.ts, src/utils/issue-fix-live.ts):
//   • proof test: a test of the new behaviour that failed on the old code and passes with the feature;
//   • SQL: recorded with the PR, classified (only ADDITIVE SQL runs unattended), run on staging and checked,
//     run on prod only on the owner's word, just before the merge into main;
//   • the Approve button refuses to merge until the SQL is on that PR's database (featureMergeBlocker);
//   • after the merge to staging: staging CI on the merge commit and the staging deploy are followed;
//   • "Ready for production?" checklist on the request (featureChecklist);
//   • go-live: a request moves to Released only once the PRODUCTION deploy contains it (runFeatureLiveCheck,
//     every 30 minutes with the Issues live check), never just because a PR merged into main;
//   • hold (db/z-feature-go-live-hold.sql): a feature that ships SWITCHED OFF (waiting on LinkedIn / Google
//     approval, or in beta) carries go_live_hold; the live check leaves it at In Progress until the owner
//     switches it on and Claude clears the hold.
// ⚠️ Nothing here notifies the submitter or voters; the owner does all communication.
//
// Columns from db/z-feature-pipeline-proof.sql, read raw behind featureProofColumnsReady() (not in
// db/schema.ts, so a database without the SQL keeps working and simply shows no checklist).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { classifySql, sqlHash, runAdditiveSql, type SqlSafety, type SqlRunResult } from './issue-sql';
import { readToken, repoOf } from './issue-github';
import { checkFixDeployed, isFullSha, parsePrNumber } from './issue-fix-live';
import { stagingCiState, fetchStagingCommit, type Repro, type CheckItem } from './issue-fix-proof';

type Db = ReturnType<typeof getDb>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export const FEATURE_RUNNER_ID = 'Claude (interactive)';
/** Most merged features checked against the prod deploy per run (two GitHub calls each). */
export const MAX_FEATURE_LIVE_CHECKS = 15;

let readyCache: { ready: boolean; at: number } | null = null;
/** Has db/z-feature-pipeline-proof.sql reached this database? Cached; a "no" is re-checked every 5 minutes. */
export async function featureProofColumnsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'feature_requests' AND column_name = 'dev_prod_merged_at' LIMIT 1`) as unknown[];
        readyCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}
let holdCache: { ready: boolean; at: number } | null = null;
/** Has db/z-feature-go-live-hold.sql reached this database? Same caching as above. */
export async function featureHoldColumnReady(db: Db): Promise<boolean> {
    if (holdCache && (holdCache.ready || Date.now() - holdCache.at < 5 * 60_000)) return holdCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'feature_requests' AND column_name = 'go_live_hold' LIMIT 1`) as unknown[];
        holdCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        holdCache = { ready: false, at: Date.now() };
    }
    return holdCache.ready;
}
export function resetFeatureProofCache(): void { readyCache = null; holdCache = null; }

export interface FeatureProofRow {
    id: number;
    status: string;
    devPrUrl: string | null;
    prodPrUrl: string | null;
    devRepro: Repro | null;
    devSql: string | null;
    devSqlSafety: SqlSafety | null;
    devStagingSqlStatus: string | null;
    devStagingSqlResult: string | null;
    devStagingSqlHash: string | null;
    devMergedAt: string | null;
    devStagingCiStatus: string | null;
    devStagingCiUrl: string | null;
    devStagingLiveAt: string | null;
    devProdSqlStatus: string | null;
    devProdSqlResult: string | null;
    devProdMergedAt: string | null;
    liveAt: string | null;
    /** Why the feature is held at In Progress though it may be deployed (switched off). null = not held. */
    goLiveHold?: string | null;
}

const BASE_COLS = sql`
    id, status, dev_pr_url, prod_pr_url, dev_repro, dev_sql, dev_sql_safety,
    dev_staging_sql_status, dev_staging_sql_result, dev_staging_sql_hash, dev_merged_at::text AS dev_merged_at,
    dev_staging_ci_status, dev_staging_ci_url, dev_staging_live_at::text AS dev_staging_live_at,
    dev_prod_sql_status, dev_prod_sql_result, dev_prod_merged_at::text AS dev_prod_merged_at, live_at::text AS live_at`;
const selectCols = async (db: Db) => (await featureHoldColumnReady(db))
    ? sql`${BASE_COLS}, go_live_hold`
    : sql`${BASE_COLS}, NULL::text AS go_live_hold`;

function toRow(r: Record<string, any>): FeatureProofRow {
    return {
        id: Number(r.id), status: String(r.status), devPrUrl: r.dev_pr_url ?? null, prodPrUrl: r.prod_pr_url ?? null,
        devRepro: typeof r.dev_repro === 'string' ? JSON.parse(r.dev_repro) : (r.dev_repro ?? null),
        devSql: r.dev_sql ?? null, devSqlSafety: r.dev_sql_safety ?? null,
        devStagingSqlStatus: r.dev_staging_sql_status ?? null, devStagingSqlResult: r.dev_staging_sql_result ?? null, devStagingSqlHash: r.dev_staging_sql_hash ?? null,
        devMergedAt: r.dev_merged_at ?? null, devStagingCiStatus: r.dev_staging_ci_status ?? null, devStagingCiUrl: r.dev_staging_ci_url ?? null,
        devStagingLiveAt: r.dev_staging_live_at ?? null, devProdSqlStatus: r.dev_prod_sql_status ?? null, devProdSqlResult: r.dev_prod_sql_result ?? null,
        devProdMergedAt: r.dev_prod_merged_at ?? null, liveAt: r.live_at ?? null, goLiveHold: r.go_live_hold ?? null,
    };
}

/** One request's proof fields, or null before the SQL or for an unknown id. */
export async function loadFeatureProof(db: Db, id: number): Promise<FeatureProofRow | null> {
    if (!(await featureProofColumnsReady(db))) return null;
    const rows = await db.execute(sql`SELECT ${await selectCols(db)} FROM feature_requests WHERE id = ${id}`) as Array<Record<string, any>>;
    return rows[0] ? toRow(rows[0]) : null;
}

/** Proof rows for the board: only requests Claude has started on (a PR, a proof, or SQL). */
export async function loadFeatureProofs(db: Db, ids: number[]): Promise<Map<number, FeatureProofRow>> {
    const out = new Map<number, FeatureProofRow>();
    const list = ids.map(Number).filter(Number.isFinite);
    if (!list.length) return out;
    try {
        if (!(await featureProofColumnsReady(db))) return out;
        const rows = await db.execute(sql`
            SELECT ${await selectCols(db)} FROM feature_requests
             WHERE id IN ${sql.raw(`(${list.join(',')})`)}
               AND (dev_pr_url IS NOT NULL OR prod_pr_url IS NOT NULL OR dev_repro IS NOT NULL OR dev_sql IS NOT NULL)`) as Array<Record<string, any>>;
        for (const r of rows) out.set(Number(r.id), toRow(r));
    } catch (e) {
        console.error('[feature-proof] loadFeatureProofs failed:', e instanceof Error ? e.message : e);
    }
    return out;
}

const stagingSqlOk = (r: Pick<FeatureProofRow, 'devSql' | 'devStagingSqlStatus' | 'devStagingSqlHash'>) =>
    !(r.devSql || '').trim() || (r.devStagingSqlStatus === 'applied' && r.devStagingSqlHash === sqlHash(r.devSql));

/** Pure: the "Ready for production?" rows for a feature. `ready` = it may be approved into main. */
export function featureChecklist(r: FeatureProofRow): { items: CheckItem[]; ready: boolean; warnings: boolean } {
    const items: CheckItem[] = [];
    const rp = r.devRepro;
    const before = rp?.before?.exit, after = rp?.after?.exit;
    items.push({
        key: 'proof', label: 'Proof test',
        state: rp?.test && typeof before === 'number' && before !== 0 && after === 0 ? 'ok' : 'warn',
        detail: !rp?.test ? 'No proof test was written.'
            : `${rp.test}: on the old code ${before === 0 ? 'PASSED (it does not test the new behaviour)' : before == null ? 'did not run' : 'failed ✓'}; with the feature ${after === 0 ? 'passes ✓' : after == null ? 'did not run' : 'FAILS'}.`,
    });
    const safety = r.devSqlSafety ?? classifySql(r.devSql).safety;
    items.push({
        key: 'sql_safety', label: 'SQL safety',
        state: safety === 'manual' ? 'fail' : 'ok',
        detail: safety === 'none' ? 'No database change.' : safety === 'additive' ? 'Additive only: it adds and never changes or removes.' : 'Not additive: the pipeline will not run it. Run it by hand on both databases first.',
    });
    const hasSql = !!(r.devSql || '').trim();
    items.push({
        key: 'sql_staging', label: 'SQL on staging',
        state: stagingSqlOk(r) ? 'ok' : r.devStagingSqlStatus === 'failed' ? 'fail' : 'wait',
        detail: !hasSql ? 'None needed.' : r.devStagingSqlResult || 'Claude runs it on staging before the merge to staging.',
    });
    if (hasSql) items.push({
        key: 'sql_prod', label: 'SQL on production',
        state: r.devProdSqlStatus === 'applied' ? 'ok' : r.devProdSqlStatus === 'failed' ? 'fail' : 'wait',
        detail: r.devProdSqlStatus === 'applied' ? (r.devProdSqlResult || 'Applied on production.')
            : r.devProdSqlStatus === 'failed' ? (r.devProdSqlResult || 'FAILED on production.')
            : 'Claude runs it on production when you say to ship, just before the merge into main. Approve refuses the merge until then.',
    });
    items.push({
        key: 'tests_staging', label: 'Tests on staging',
        state: r.devStagingCiStatus === 'passed' ? 'ok' : r.devStagingCiStatus === 'failed' ? 'fail' : 'wait',
        detail: !r.devMergedAt ? 'Waiting for the merge to staging.'
            : r.devStagingCiStatus === 'passed' ? `CI passed on the merge commit${r.devRepro?.test ? ' (including the proof test)' : ''}.`
            : r.devStagingCiStatus === 'failed' ? 'CI FAILED on the merge commit.' : 'CI is running on the merge commit.',
    });
    items.push({
        key: 'live_staging', label: 'Live on staging',
        state: r.devStagingLiveAt ? 'ok' : 'wait',
        detail: r.devStagingLiveAt ? `The staging deploy contains it (seen ${r.devStagingLiveAt.slice(0, 16)} UTC).` : 'Waiting for the staging deploy.',
    });
    items.push({
        key: 'live_prod', label: 'Live on production',
        state: r.liveAt ? 'ok' : 'wait',
        detail: r.liveAt ? `The production deploy contains it (seen ${r.liveAt.slice(0, 16)} UTC). Moved to Released; no one was notified.`
            : r.goLiveHold ? `Held at In Progress (switched off): ${r.goLiveHold} It moves to Released only after it is switched on and the hold is cleared.`
            : r.devProdMergedAt ? 'Merged into main. Moves to Released once the production deploy contains it.'
            : 'Not in main yet.',
    });
    const blocking = items.filter((i) => !['proof', 'sql_prod', 'live_prod'].includes(i.key));
    const ready = !!r.devMergedAt && blocking.every((i) => i.state === 'ok');
    return { items, ready, warnings: items.some((i) => i.state === 'warn') };
}

/** What a feature needs before its PR may merge into this base. null = fine. */
export async function featureMergeBlocker(db: Db, id: number, base: string): Promise<string | null> {
    const row = await loadFeatureProof(db, id);
    const text = (row?.devSql || '').trim();
    if (!row || !text) return null;
    // Not-additive SQL counts once the owner has run it by hand and said so (scripts/feature-requests.ts sql-done).
    if (base === 'staging' && !stagingSqlOk(row)) return 'This feature\'s SQL is not on the staging database yet. Ask Claude to run it on staging first.';
    if (base === 'main' && row.devProdSqlStatus !== 'applied') return 'This feature\'s SQL is not on the production database yet. Ask Claude to run the prod SQL first (it does that only when you say to ship).';
    return null;
}

/** Run the feature's additive SQL on the staging DB once (same text = no re-run). null = done. */
export async function ensureFeatureStagingSql(db: Db, id: number, stagingUrl: string | undefined, opts: { run?: typeof runAdditiveSql } = {}): Promise<string | null> {
    const row = await loadFeatureProof(db, id);
    if (!row) return 'Run db/z-feature-pipeline-proof.sql on this database first.';
    const text = (row.devSql || '').trim();
    if (!text) return null;
    const hash = sqlHash(text);
    if (row.devStagingSqlStatus === 'applied' && row.devStagingSqlHash === hash) return null;
    if (classifySql(text).safety === 'manual') return 'This SQL is not additive, so the pipeline will not run it. The owner runs it by hand.';
    const res: SqlRunResult = await (opts.run || runAdditiveSql)(stagingUrl, text, 'staging');
    await db.execute(sql`
        UPDATE feature_requests SET dev_staging_sql_status = ${res.ok ? 'applied' : 'failed'}, dev_staging_sql_result = ${res.outcome},
               dev_staging_sql_hash = ${res.ok ? hash : null}, dev_staging_sql_ran_at = now(), updated_at = now()
         WHERE id = ${id}`);
    return res.ok ? null : `The SQL failed on staging.\n${res.outcome}`;
}

/** Run the SQL that passed on staging (same hash) on the prod DB. Only on the owner's word. */
export async function runFeatureProdSql(db: Db, id: number, prodUrl: string | undefined, opts: { run?: typeof runAdditiveSql } = {}): Promise<SqlRunResult> {
    const row = await loadFeatureProof(db, id);
    const text = (row?.devSql || '').trim();
    if (!row || !text) return { ok: true, outcome: 'No SQL on this request.' };
    if (!stagingSqlOk(row)) return { ok: false, outcome: 'This SQL has not passed on staging yet (run staging-sql first).' };
    if (row.devProdSqlStatus === 'applied') return { ok: true, outcome: row.devProdSqlResult || '✓ Already applied on production.' };
    const res = await (opts.run || runAdditiveSql)(prodUrl, text, 'production');
    await db.execute(sql`
        UPDATE feature_requests SET dev_prod_sql_status = ${res.ok ? 'applied' : 'failed'}, dev_prod_sql_result = ${res.outcome},
               dev_prod_sql_ran_at = now(), updated_at = now()
         WHERE id = ${id}`);
    return res;
}

const appendNote = (db: Db, id: number, text: string) => {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return db.execute(sql`
        UPDATE feature_requests SET dev_notes = concat_ws(E'\n\n', dev_notes, ${`[${stamp} UTC] ${text}`}::text), updated_at = now()
         WHERE id = ${id}`);
};

/** The owner ran not-additive SQL by hand and said so: record it as applied on that database (same hash). */
export async function recordManualFeatureSql(db: Db, id: number, where: 'staging' | 'production'): Promise<string | null> {
    const row = await loadFeatureProof(db, id);
    const text = (row?.devSql || '').trim();
    if (!row || !text) return `#${id} has no SQL.`;
    const outcome = `✓ Run by hand by the owner on ${where} (recorded ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC).`;
    if (where === 'staging') {
        await db.execute(sql`
            UPDATE feature_requests SET dev_staging_sql_status = 'applied', dev_staging_sql_result = ${outcome},
                   dev_staging_sql_hash = ${sqlHash(text)}, dev_staging_sql_ran_at = now(), updated_at = now() WHERE id = ${id}`);
    } else {
        if (!stagingSqlOk(row)) return 'Record it on staging first: the same SQL must have run there.';
        await db.execute(sql`
            UPDATE feature_requests SET dev_prod_sql_status = 'applied', dev_prod_sql_result = ${outcome},
                   dev_prod_sql_ran_at = now(), updated_at = now() WHERE id = ${id}`);
    }
    return null;
}

/** Follow one feature merged to staging: CI on its merge commit, and the staging deploy. Never throws. */
export async function syncFeatureStaging(db: Db, row: Pick<FeatureProofRow, 'id' | 'devPrUrl' | 'devStagingCiStatus' | 'devStagingLiveAt'>, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; stagingCommit?: string | null } = {}): Promise<boolean> {
    const token = opts.token ?? readToken();
    const prNum = parsePrNumber(row.devPrUrl, repoOf(opts.repo));
    if (!token || !prNum) return false;
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        let changed = false;
        if (row.devStagingCiStatus !== 'passed') {
            const pr = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/pulls/${prNum}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'feature-proof' } });
            if (!pr.ok) return false;
            const sha = (await pr.json())?.merge_commit_sha;
            if (!isFullSha(sha)) return false;
            const ci = await stagingCiState({ sha, token, repo: opts.repo, fetchImpl: opts.fetchImpl as any });
            if (ci !== 'error' && ci.state !== row.devStagingCiStatus) {
                await db.execute(sql`UPDATE feature_requests SET dev_staging_ci_status = ${ci.state}, dev_staging_ci_url = ${ci.url}, updated_at = now() WHERE id = ${row.id}`);
                if (ci.state === 'failed') await appendNote(db, row.id, `⚠️ Tests FAILED on staging after this feature merged, so it is not ready for production.\n${ci.url || ''}`);
                changed = true;
            }
        }
        if (!row.devStagingLiveAt) {
            const commit = opts.stagingCommit !== undefined ? opts.stagingCommit : await fetchStagingCommit(opts.fetchImpl as any);
            if (commit) {
                const live = await checkFixDeployed({ prNumber: prNum, deployedSha: commit, token, repo: opts.repo, fetchImpl: opts.fetchImpl as any });
                if (live === 'live') {
                    await db.execute(sql`UPDATE feature_requests SET dev_staging_live_at = now(), updated_at = now() WHERE id = ${row.id} AND dev_staging_live_at IS NULL`);
                    changed = true;
                }
            }
        }
        return changed;
    } catch (e) {
        console.error('[feature-proof] staging sync failed:', e instanceof Error ? e.message : e);
        return false;
    }
}

export interface FeatureLiveResult { skipped?: 'sql' | 'no_token' | 'no_commit'; stagingSynced: number; checked: number; released: number; errors: number }

/**
 * One pass, on the Issues live-check tick: follow features merged to staging, then move to Released every
 * merged feature that THIS deploy contains (prod deploy on prod, staging deploy on staging). Silent: no one
 * is notified. Compare-and-swap, so two overlapping runs cannot release twice. Never throws.
 */
export async function runFeatureLiveCheck(db: Db, opts: { deployedSha: string; token?: string; repo?: string; fetchImpl?: FetchLike }): Promise<FeatureLiveResult> {
    const result: FeatureLiveResult = { stagingSynced: 0, checked: 0, released: 0, errors: 0 };
    try {
        if (!(await featureProofColumnsReady(db))) return { ...result, skipped: 'sql' };
        const token = opts.token ?? readToken();
        if (!token) return { ...result, skipped: 'no_token' };

        const merged = await db.execute(sql`
            SELECT id, dev_pr_url, dev_staging_ci_status, dev_staging_live_at::text AS dev_staging_live_at FROM feature_requests
             WHERE dev_merged_at > now() - interval '14 days' AND live_at IS NULL
               AND (dev_staging_ci_status IS DISTINCT FROM 'passed' OR dev_staging_live_at IS NULL)
             ORDER BY dev_merged_at DESC LIMIT 10`) as Array<Record<string, any>>;
        const stagingCommit = merged.length ? await fetchStagingCommit(opts.fetchImpl as any) : null;
        for (const r of merged) {
            if (await syncFeatureStaging(db, { id: Number(r.id), devPrUrl: r.dev_pr_url, devStagingCiStatus: r.dev_staging_ci_status, devStagingLiveAt: r.dev_staging_live_at }, { ...opts, token, stagingCommit })) result.stagingSynced++;
        }

        if (!isFullSha(opts.deployedSha)) return { ...result, skipped: 'no_commit' };
        // Held (switched off until approval / in beta) features are never released by the deploy.
        const notHeld = (await featureHoldColumnReady(db)) ? sql`AND go_live_hold IS NULL` : sql``;
        const rows = await db.execute(sql`
            SELECT id, dev_pr_url, prod_pr_url FROM feature_requests
             WHERE live_at IS NULL AND status NOT IN ('released', 'declined', 'duplicate') ${notHeld}
               AND (dev_merged_at IS NOT NULL OR dev_prod_merged_at IS NOT NULL)
             ORDER BY coalesce(dev_prod_merged_at, dev_merged_at) ASC
             LIMIT ${MAX_FEATURE_LIVE_CHECKS}`) as Array<{ id: number; dev_pr_url: string | null; prod_pr_url: string | null }>;
        for (const row of rows) {
            // The prod PR (a release or a direct PR into main) first, then the staging PR: a staging → main
            // merge carries the staging merge commit, so either proves it.
            const prs = [row.prod_pr_url, row.dev_pr_url].map((u) => parsePrNumber(u, repoOf(opts.repo))).filter((n): n is number => !!n);
            if (!prs.length) continue;
            result.checked++;
            let state: string = 'not_yet';
            for (const prNumber of prs) {
                const s = await checkFixDeployed({ prNumber, deployedSha: opts.deployedSha, token, repo: opts.repo, fetchImpl: opts.fetchImpl as any });
                if (s === 'live') { state = 'live'; break; }
                if (s === 'error') state = 'error';
            }
            if (state === 'error') { result.errors++; continue; }
            if (state !== 'live') continue;
            const claimed = await db.execute(sql`
                UPDATE feature_requests SET status = 'released', released_at = coalesce(released_at, now()), live_at = now(),
                       dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
                 WHERE id = ${row.id} AND live_at IS NULL AND status NOT IN ('released', 'declined', 'duplicate') ${notHeld}
                RETURNING id`) as unknown[];
            if (!claimed.length) continue;
            result.released++;
            await appendNote(db, row.id, '🚀 Live: this deploy contains the feature, so it moved to Released. No one was notified (the owner tells submitters and voters).');
        }
    } catch (e) {
        console.error('[feature-proof] live check failed:', e instanceof Error ? e.message : e);
    }
    return result;
}
