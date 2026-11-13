// src/utils/issue-fix-proof.ts — Fix pipeline: proof before production (docs/fix-pipeline-proof-plan.md,
// docs/fix-pipeline-interactive.md).
//
// Owner decisions 2026-11-12/13: nothing reaches prod until the owner ships it, and the ticket first shows,
// in plain words, whether the root cause was CONFIRMED (a repro test failed on the old code and passes with
// the fix), GUESSED or NOT FOUND; whether the SQL is additive and applied on staging (and prod); whether
// staging CI passed on the merge commit; and whether the staging deploy contains the fix.
//
// Claude records the root cause and repro result from its session (scripts/fix-tickets.ts). This module:
//   ensureStagingSql runs before "Merge to staging"; syncStagingProof follows staging CI and the deploy;
//   productionChecklist is what the ticket shows; approveForProduction is the owner's click.
//
// The columns come from db/z-issue-fix-proof.sql and are NOT in db/schema.ts (see that file), so
// everything here is raw SQL behind proofColumnsReady().

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { classifySql, sqlHash, runAdditiveSql, pipelineDbUrls, type SqlSafety, type SqlRunResult } from './issue-sql';
import { ghHeaders, readToken, repoOf } from './issue-github';
import { checkFixDeployed, isFullSha, parsePrNumber } from './issue-fix-live';

type Db = ReturnType<typeof getDb>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> }>;

/** The staging site, whose deploy must contain the fix. */
export const STAGING_SITE_URL = process.env.STAGING_SITE_URL || 'https://staging--bemoreswan.netlify.app';
/** main's required checks; the same jobs run on every push to staging. */
export const STAGING_REQUIRED_CHECKS = ['Typecheck + tests', 'RLS tenant-isolation (Postgres)'];
export type RootCauseStatus = 'confirmed' | 'guessed' | 'not_found';
export interface ReproRun { exit: number | null; tail?: string }
/** flags: 'source_scan' / 'missing_code' mark a "repro" that proves nothing. */
export interface Repro { test: string | null; kind: 'node' | 'browser' | null; before: ReproRun | null; after: ReproRun | null; error?: string | null; flags?: string[] }
let readyCache: { ready: boolean; at: number } | null = null;
/** Has db/z-issue-fix-proof.sql reached this database? Cached; a "no" is re-checked every 5 minutes. */
export async function proofColumnsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'issue_reports' AND column_name = 'dev_proof_images_at' LIMIT 1`) as unknown[];
        readyCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}
export function resetProofColumnsCache(): void { readyCache = null; }

// ── SQL on staging (before "Merge to staging") ─────────────────────────────────────────────────

export interface ProofRow {
    id: number;
    devPrUrl: string | null;
    devSql: string | null;
    devSqlStatus: string | null;
    devMergeStatus: string | null;
    devProdStatus: string | null;
    devRootCauseStatus: RootCauseStatus | null;
    devRootCause: string | null;
    devRepro: Repro | null;
    devSqlSafety: SqlSafety | null;
    devSqlHash: string | null;
    devStagingSqlStatus: string | null;
    devStagingSqlResult: string | null;
    devStagingSqlHash: string | null;
    devStagingCiStatus: string | null;
    devStagingCiUrl: string | null;
    devStagingLiveAt: string | null;
    devProdSqlStatus: string | null;
    devProdSqlResult: string | null;
    devProdApprovedAt: string | null;
    devProofRunId: number | null;
    devProofImagesAt: string | null;
}

/** One issue's proof fields (raw), or null before the SQL or for an unknown id. */
export async function loadProofRow(db: Db, id: number): Promise<ProofRow | null> {
    if (!(await proofColumnsReady(db))) return null;
    const rows = await db.execute(sql`
        SELECT id, dev_pr_url, dev_sql, dev_sql_status, dev_merge_status, dev_prod_status,
               dev_root_cause_status, dev_root_cause, dev_repro, dev_sql_safety, dev_sql_hash,
               dev_staging_sql_status, dev_staging_sql_result, dev_staging_sql_hash,
               dev_staging_ci_status, dev_staging_ci_url, dev_staging_live_at::text AS dev_staging_live_at,
               dev_prod_sql_status, dev_prod_sql_result, dev_prod_approved_at::text AS dev_prod_approved_at,
               dev_proof_run_id, dev_proof_images_at::text AS dev_proof_images_at
          FROM issue_reports WHERE id = ${id}`) as Array<Record<string, any>>;
    const r = rows[0];
    if (!r) return null;
    return {
        id: Number(r.id), devPrUrl: r.dev_pr_url, devSql: r.dev_sql, devSqlStatus: r.dev_sql_status,
        devMergeStatus: r.dev_merge_status, devProdStatus: r.dev_prod_status,
        devRootCauseStatus: r.dev_root_cause_status, devRootCause: r.dev_root_cause,
        devRepro: typeof r.dev_repro === 'string' ? JSON.parse(r.dev_repro) : r.dev_repro,
        devSqlSafety: r.dev_sql_safety, devSqlHash: r.dev_sql_hash,
        devStagingSqlStatus: r.dev_staging_sql_status, devStagingSqlResult: r.dev_staging_sql_result, devStagingSqlHash: r.dev_staging_sql_hash,
        devStagingCiStatus: r.dev_staging_ci_status, devStagingCiUrl: r.dev_staging_ci_url, devStagingLiveAt: r.dev_staging_live_at,
        devProdSqlStatus: r.dev_prod_sql_status, devProdSqlResult: r.dev_prod_sql_result, devProdApprovedAt: r.dev_prod_approved_at,
        devProofRunId: r.dev_proof_run_id == null ? null : Number(r.dev_proof_run_id), devProofImagesAt: r.dev_proof_images_at,
    };
}

/**
 * Before a fix merges to staging, its SQL must be on the staging DB. Additive SQL runs here (once per
 * text); manual SQL must already have been run by hand (Run SQL → dev_sql_status 'applied').
 * Returns null to go ahead, or the reason the merge must wait.
 */
export async function ensureStagingSql(db: Db, issueId: number, opts: { run?: typeof runAdditiveSql; urls?: ReturnType<typeof pipelineDbUrls> } = {}): Promise<string | null> {
    const row = await loadProofRow(db, issueId);
    if (!row) return null;                                   // before the SQL file: the old Run SQL gate applies
    const text = (row.devSql || '').trim();
    if (!text) return null;
    const { safety } = classifySql(text);
    const hash = sqlHash(text);
    if (row.devStagingSqlStatus === 'applied' && row.devStagingSqlHash === hash) return null;
    if (safety === 'manual') {
        return row.devSqlStatus === 'applied'
            ? null
            : "This fix's SQL is not additive, so the pipeline won't run it unattended. Review it and press Run SQL (staging) first.";
    }
    const urls = opts.urls || pipelineDbUrls();
    const res: SqlRunResult = await (opts.run || runAdditiveSql)(urls.staging, text, 'staging');
    await db.execute(sql`
        UPDATE issue_reports
           SET dev_staging_sql_status = ${res.ok ? 'applied' : 'failed'}, dev_staging_sql_result = ${res.outcome},
               dev_staging_sql_hash = ${res.ok ? hash : null}, dev_staging_sql_ran_at = now(),
               dev_sql_status = ${res.ok ? 'applied' : 'failed'}, dev_sql_result = ${res.outcome}, dev_sql_ran_at = now(),
               updated_at = now()
         WHERE id = ${issueId}`);
    await db.execute(sql`
        INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
        VALUES (${issueId}, 'admin', NULL, ${`🗄️ ${res.ok ? 'Database update applied on STAGING before the merge.' : 'Database update FAILED on staging, so the fix was not merged.'}\n\n${res.outcome}`}, NULL)`);
    return res.ok ? null : `The SQL failed on staging, so nothing was merged.\n${res.outcome}`;
}

// ── Staging proof: CI on the merge commit, and the staging deploy ─────────────────────────────

/** Required checks on one commit: passed | failed | pending, and a link to look at. */
export async function stagingCiState(opts: { sha: string; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<{ state: 'passed' | 'failed' | 'pending'; url: string | null } | 'error'> {
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/commits/${opts.sha}/check-runs?per_page=100`, { headers: ghHeaders(opts.token) });
        if (!res.ok) return 'error';
        const runs: any[] = (await res.json())?.check_runs || [];
        let url: string | null = null;
        let state: 'passed' | 'failed' | 'pending' = 'passed';
        for (const name of STAGING_REQUIRED_CHECKS) {
            // Newest first: a re-run replaces an earlier failure.
            const run = runs.filter((r) => r.name === name).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
            if (!url && run?.html_url) url = String(run.html_url);
            if (!run || run.status !== 'completed') { if (state === 'passed') state = 'pending'; continue; }
            if (run.conclusion !== 'success') { state = 'failed'; url = String(run.html_url || url || ''); }
        }
        return { state, url };
    } catch {
        return 'error';
    }
}

/** The commit the staging site is running (netlify/functions/build-info.ts), or null. */
export async function fetchStagingCommit(fetchImpl?: FetchLike, base = STAGING_SITE_URL): Promise<string | null> {
    const f = fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`${base}/.netlify/functions/build-info`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const c = (await res.json())?.commit;
        return isFullSha(c) ? c : null;
    } catch {
        return null;
    }
}

/** Follow one merged fix on staging. True when it changed something. Never throws. */
export async function syncStagingProof(db: Db, row: Pick<ProofRow, 'id' | 'devPrUrl' | 'devStagingCiStatus' | 'devStagingLiveAt'>, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; stagingCommit?: string | null } = {}): Promise<boolean> {
    const token = opts.token ?? readToken();
    const prNum = parsePrNumber(row.devPrUrl, repoOf(opts.repo));
    if (!token || !prNum) return false;
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        let changed = false;
        if (row.devStagingCiStatus !== 'passed') {
            const pr = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/pulls/${prNum}`, { headers: ghHeaders(token) });
            if (!pr.ok) return false;
            const sha = (await pr.json())?.merge_commit_sha;
            if (!isFullSha(sha)) return false;
            const ci = await stagingCiState({ sha, token, repo: opts.repo, fetchImpl: opts.fetchImpl });
            if (ci !== 'error' && ci.state !== row.devStagingCiStatus) {
                await db.execute(sql`UPDATE issue_reports SET dev_staging_ci_status = ${ci.state}, dev_staging_ci_url = ${ci.url} WHERE id = ${row.id}`);
                if (ci.state === 'failed') {
                    await db.execute(sql`
                        INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
                        VALUES (${row.id}, 'admin', NULL, ${`⚠️ Tests FAILED on staging after this fix merged, so it can't be approved for production.\n${ci.url || ''}`}, NULL)`);
                }
                changed = true;
            }
        }
        if (!row.devStagingLiveAt) {
            const commit = opts.stagingCommit !== undefined ? opts.stagingCommit : await fetchStagingCommit(opts.fetchImpl);
            if (commit) {
                const live = await checkFixDeployed({ prNumber: prNum, deployedSha: commit, token, repo: opts.repo, fetchImpl: opts.fetchImpl as any });
                if (live === 'live') {
                    await db.execute(sql`UPDATE issue_reports SET dev_staging_live_at = now() WHERE id = ${row.id} AND dev_staging_live_at IS NULL`);
                    changed = true;
                }
            }
        }
        return changed;
    } catch (e) {
        console.error('[issue-fix-proof] staging sync failed:', e instanceof Error ? e.message : e);
        return false;
    }
}

/** Follow every merged fix still waiting for its staging proof (capped). */
export async function syncOpenProofs(db: Db, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; limit?: number } = {}): Promise<number> {
    if (!(await proofColumnsReady(db))) return 0;
    const token = opts.token ?? readToken();
    if (!token) return 0;
    let n = 0;
    try {
        const merged = await db.execute(sql`
            SELECT id, dev_pr_url, dev_staging_ci_status, dev_staging_live_at::text AS dev_staging_live_at FROM issue_reports
             WHERE dev_merge_status = 'merged' AND dev_merged_at > now() - interval '14 days'
               AND dev_prod_approved_at IS NULL
               AND (dev_staging_ci_status IS DISTINCT FROM 'passed' OR dev_staging_live_at IS NULL)
             ORDER BY dev_merged_at DESC LIMIT ${opts.limit ?? 10}`) as Array<Record<string, any>>;
        const stagingCommit = merged.length ? await fetchStagingCommit(opts.fetchImpl) : null;
        for (const r of merged) {
            if (await syncStagingProof(db, { id: Number(r.id), devPrUrl: r.dev_pr_url, devStagingCiStatus: r.dev_staging_ci_status, devStagingLiveAt: r.dev_staging_live_at }, { ...opts, token, stagingCommit })) n++;
        }
    } catch (e) {
        console.error('[issue-fix-proof] syncOpenProofs failed:', e instanceof Error ? e.message : e);
    }
    return n;
}

// ── The checklist the owner reads, and the approval ────────────────────────────────────────────

export type CheckState = 'ok' | 'warn' | 'fail' | 'wait';
export interface CheckItem { key: string; label: string; state: CheckState; detail: string }

/** Pure: the "Ready for production?" rows. `ready` = Approve may run; `warnings` = it asks twice. */
export function productionChecklist(r: ProofRow): { items: CheckItem[]; ready: boolean; warnings: boolean } {
    const items: CheckItem[] = [];
    const rc = r.devRootCauseStatus;
    items.push({
        key: 'root_cause', label: 'Root cause',
        state: rc === 'confirmed' ? 'ok' : 'warn',
        detail: rc === 'confirmed' ? 'Confirmed: reproduced by a test that failed before the fix and passes after it.'
            : rc === 'guessed' ? 'Guessed: a cause is named but no test reproduced it.'
            : 'Not found: the AI developer could not identify the cause.',
    });
    const rp = r.devRepro;
    const before = rp?.before?.exit, after = rp?.after?.exit;
    const flags = rp?.flags || [];
    const flagText = flags.map((f) => (f === 'source_scan' ? 'it reads source files instead of running the code' : f === 'missing_code' ? 'it failed before only because new code was missing' : f)).join('; ');
    items.push({
        key: 'repro', label: 'Repro test',
        state: rp?.test && typeof before === 'number' && before !== 0 && after === 0 && !flags.length ? 'ok' : 'warn',
        detail: !rp?.test ? (rp?.error ? `No result: ${rp.error}` : 'No repro test was written.')
            : `${rp.test}: before the fix ${before === 0 ? 'PASSED (it does not reproduce the fault)' : before == null ? 'did not run' : 'failed ✓'}; after the fix ${after === 0 ? 'passes ✓' : after == null ? 'did not run' : 'FAILS'}.${flagText ? ` Not counted as proof: ${flagText}.` : ''}`,
    });
    const safety = r.devSqlSafety ?? classifySql(r.devSql).safety;
    items.push({
        key: 'sql_safety', label: 'SQL safety',
        state: safety === 'manual' ? 'fail' : 'ok',
        detail: safety === 'none' ? 'No database change.' : safety === 'additive' ? 'Additive only: it adds and never changes or removes.' : 'Not additive: the pipeline will not run it on production. Run it by hand, then ship with a normal release.',
    });
    const hasSql = !!(r.devSql || '').trim();
    const stagingSqlOk = !hasSql || (r.devStagingSqlStatus === 'applied' && r.devStagingSqlHash === sqlHash(r.devSql));
    items.push({
        key: 'sql_staging', label: 'SQL on staging',
        state: stagingSqlOk ? 'ok' : r.devStagingSqlStatus === 'failed' ? 'fail' : 'wait',
        detail: !hasSql ? 'None needed.' : r.devStagingSqlResult || 'Runs automatically when the fix merges to staging.',
    });
    if (hasSql) items.push({
        key: 'sql_prod', label: 'SQL on production',
        state: r.devProdSqlStatus === 'applied' ? 'ok' : r.devProdSqlStatus === 'failed' ? 'fail' : 'wait',
        detail: r.devProdSqlStatus === 'applied' ? (r.devProdSqlResult || 'Applied on production.')
            : r.devProdSqlStatus === 'failed' ? (r.devProdSqlResult || 'FAILED on production.')
            : 'Runs when you press Approve for production (or just before a release merges, on your word).',
    });
    items.push({
        key: 'tests_staging', label: 'Tests on staging',
        state: r.devStagingCiStatus === 'passed' ? 'ok' : r.devStagingCiStatus === 'failed' ? 'fail' : 'wait',
        detail: r.devMergeStatus !== 'merged' ? 'Waiting for the merge to staging.'
            : r.devStagingCiStatus === 'passed' ? `CI passed on the merge commit${r.devRepro?.test ? ' (including the repro test)' : ''}.`
            : r.devStagingCiStatus === 'failed' ? 'CI FAILED on the merge commit.' : 'CI is running on the merge commit.',
    });
    items.push({
        key: 'live_staging', label: 'Live on staging',
        state: r.devStagingLiveAt ? 'ok' : 'wait',
        detail: r.devStagingLiveAt ? `The staging deploy contains the fix (seen ${r.devStagingLiveAt.slice(0, 16)} UTC).` : 'Waiting for the staging deploy.',
    });
    const blocking = items.filter((i) => i.key !== 'root_cause' && i.key !== 'repro' && !(i.key === 'sql_prod' && i.state === 'wait'));
    const ready = r.devMergeStatus === 'merged' && blocking.every((i) => i.state === 'ok');
    return { items, ready, warnings: items.some((i) => i.state === 'warn') };
}

export type DispatchHotfix = (opts: { issueId: number; fixPr: number; autoMerge?: boolean }) => Promise<string | null>;

/**
 * The owner's "Approve for production". Re-checks everything server side, runs the SQL that passed on
 * staging (same hash) on prod, then starts the one-fix hotfix with auto-merge. Nothing merges if any
 * step fails. Returns { ok } or { error, needsConfirm? }.
 */
export async function approveForProduction(db: Db, issueId: number, adminId: number, opts: {
    confirmWarnings?: boolean;
    dispatch: DispatchHotfix;
    run?: typeof runAdditiveSql;
    urls?: ReturnType<typeof pipelineDbUrls>;
    repo?: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string; needsConfirm?: boolean; status?: number }> {
    const urls = opts.urls || pipelineDbUrls();
    if (!urls.onProdSite) return { ok: false, status: 400, error: 'Approve for production only works on the production site (it runs the SQL on the prod database).' };
    const row = await loadProofRow(db, issueId);
    if (!row) return { ok: false, status: 400, error: 'Run db/z-issue-fix-proof.sql on this database first.' };
    const list = productionChecklist(row);
    if (!list.ready) {
        const open = list.items.filter((i) => i.key !== 'root_cause' && i.key !== 'repro' && i.state !== 'ok').map((i) => `${i.label}: ${i.detail}`);
        return { ok: false, status: 409, error: `Not ready for production yet:\n${open.join('\n')}` };
    }
    if (list.warnings && !opts.confirmWarnings) {
        return { ok: false, status: 409, needsConfirm: true, error: list.items.filter((i) => i.state === 'warn').map((i) => `${i.label}: ${i.detail}`).join('\n') };
    }
    const prNum = parsePrNumber(row.devPrUrl, repoOf(opts.repo));
    if (!prNum) return { ok: false, status: 400, error: 'This issue has no fix pull request.' };

    // Claim: one approval at a time, and never twice for a fix that is already on its way.
    const claimed = await db.execute(sql`
        UPDATE issue_reports SET dev_prod_approved_by = ${adminId}, dev_prod_approved_at = now(),
               dev_prod_status = 'hotfix_requested', dev_prod_at = now(), dev_prod_result = 'Approved: running the production SQL…', updated_at = now()
         WHERE id = ${issueId} AND dev_prod_approved_at IS NULL
           AND (dev_prod_status IS NULL OR dev_prod_status = 'failed')
        RETURNING id`) as unknown[];
    if (!claimed.length) return { ok: false, status: 409, error: 'This fix is already approved or on its way to production.' };

    const fail = async (msg: string) => {
        await db.execute(sql`
            UPDATE issue_reports SET dev_prod_status = 'failed', dev_prod_result = ${msg},
                   dev_prod_approved_by = NULL, dev_prod_approved_at = NULL, updated_at = now()
             WHERE id = ${issueId}`);
        await db.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
            VALUES (${issueId}, 'admin', ${adminId}, ${`⚠️ Approve for production stopped. Nothing was merged.\n\n${msg}`}, NULL)`);
        return { ok: false as const, status: 502, error: msg };
    };

    const text = (row.devSql || '').trim();
    let sqlLine = 'No database change.';
    if (text) {
        if (sqlHash(text) !== row.devStagingSqlHash) return fail('The SQL differs from what passed on staging. Merge to staging again so the same SQL runs there first.');
        // Already run on prod (scripts/fix-tickets.ts prod-sql, same text as staging): don't run it twice.
        const res = row.devProdSqlStatus === 'applied'
            ? { ok: true, outcome: row.devProdSqlResult || '✓ Already applied on production.' }
            : await (opts.run || runAdditiveSql)(urls.production, text, 'production');
        await db.execute(sql`
            UPDATE issue_reports SET dev_prod_sql_status = ${res.ok ? 'applied' : 'failed'}, dev_prod_sql_result = ${res.outcome}, dev_prod_sql_ran_at = now()
             WHERE id = ${issueId}`);
        if (!res.ok) return fail(res.outcome);
        sqlLine = res.outcome;
    }

    const err = await opts.dispatch({ issueId, fixPr: prNum, autoMerge: true });
    if (err) return fail(`${err}${text ? '\n\nThe SQL is already on production. It is additive, so that is safe; approve again once the problem above is fixed.' : ''}`);

    const message = `🚀 Approved for production.\n\n${sqlLine}\n\nThe one-fix hotfix PR into main is being opened and will merge itself once main's required checks pass. The reporter is told once the prod deploy contains it.`;
    await db.execute(sql`
        INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
        VALUES (${issueId}, 'admin', ${adminId}, ${message}, NULL)`);
    return { ok: true, message };
}
