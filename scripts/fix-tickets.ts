// scripts/fix-tickets.ts — Claude works the Fix pipeline from an interactive session (owner, 2026-11-13).
//
// The owner's process (docs/fix-pipeline-interactive.md): issues land in the Fix pipeline as Reported;
// the owner tells Claude to work them; Claude investigates against the real system, fixes, proves the
// fix, and moves the ticket through the pipeline, recording the evidence. The owner does the last step
// (Approve for production) and all communication with the reporter.
//
// ⚠️ NOTHING HERE CONTACTS THE REPORTER. Notes are written with author_id NULL, which the reporter's
// Issues page never shows (netlify/functions/issue-reports.ts reads author_id IS NOT NULL only), and
// notifyIssueUser is never called. The reporter sees the ticket's STATUS only.
//
// Usage (always name the database; there is no default, so prod is never hit by accident):
//   npx tsx scripts/fix-tickets.ts --env prod list [--status reported]
//   npx tsx scripts/fix-tickets.ts --env prod show <id> [--screenshot <file.png>]
//   npx tsx scripts/fix-tickets.ts --env prod start <id>              (→ Investigation In Progress)
//   npx tsx scripts/fix-tickets.ts --env prod fixing <id> --file <found.md>  (cause found → Fix In Progress)
//   npx tsx scripts/fix-tickets.ts --env prod note <id> --file <note.md>
//   npx tsx scripts/fix-tickets.ts --env prod proof <id> --root-cause confirmed|guessed|not_found --file <evidence.md>
//                                         [--test <path> --before <exit> --after <exit>]
//   npx tsx scripts/fix-tickets.ts --env prod pr <id> --pr <url> --file <summary.md> [--sql <file.sql>]
//   npx tsx scripts/fix-tickets.ts --env prod staging-sql <id>     (additive SQL → staging DB, checked)
//   npx tsx scripts/fix-tickets.ts --env prod merged <id>          (after Claude merges the PR to staging)
//   npx tsx scripts/fix-tickets.ts --env prod sync <id>            (staging CI + staging deploy → checklist)
//   npx tsx scripts/fix-tickets.ts --env prod prod-sql <id>        (only on the owner's word, before a release merges)
//   npx tsx scripts/fix-tickets.ts --env prod release <id>         (clear the "Claude working" pill)
//   npx tsx scripts/fix-tickets.ts --env prod status <id> <more_info_required|on_hold|closed>  (on_hold = Waiting on Others) --file <why.md>
//
// DB: --env prod → DATABASE_URL_PROD; --env staging → NETLIFY_DATABASE_URL (staging). The staging DB for
// SQL is always NETLIFY_DATABASE_URL. GitHub: `gh auth token`.

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { classifySql, sqlHash, runAdditiveSql } from '../src/utils/issue-sql';
import { ensureStagingSql, loadProofRow, productionChecklist, syncStagingProof, resetProofColumnsCache, type RootCauseStatus } from '../src/utils/issue-fix-proof';

export const RUNNER_ID = 'Claude (interactive)';
const ALLOWED_STATUSES = ['more_info_required', 'on_hold', 'closed'] as const;

function arg(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
}
function need<T>(v: T | undefined | null, msg: string): T {
    if (v === undefined || v === null || v === '') { console.error(msg); process.exit(2); }
    return v as T;
}
const readText = (file: string | undefined, what: string) => readFileSync(need(file, `--file <path> with the ${what} is required.`), 'utf8').trim();

export function dbUrlFor(env: string | undefined, e: Record<string, string | undefined> = process.env): string {
    if (env === 'prod') return need(e.DATABASE_URL_PROD, 'DATABASE_URL_PROD is not set in .env.');
    if (env === 'staging') return need(e.NETLIFY_DATABASE_URL, 'NETLIFY_DATABASE_URL (staging) is not set in .env.');
    console.error('Say which database: --env prod or --env staging.');
    process.exit(2);
}

async function main() {
    const args = process.argv.slice(2);
    const env = arg(args, '--env');
    const url = dbUrlFor(env);
    const rest = args.filter((a, i) => a !== '--env' && args[i - 1] !== '--env');
    const [cmd, idArg, extra] = rest;
    const id = Number(idArg);
    const client = postgres(url, { max: 1, ssl: 'require', onnotice: () => {} });
    const db = drizzle({ client }) as any;
    resetProofColumnsCache();

    // Every note also bumps updated_at, so the admin board's auto-refresh picks it up.
    const note = async (issueId: number, body: string) => {
        await db.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
            VALUES (${issueId}, 'admin', NULL, ${`🛠️ Claude (developer): ${body}`}, NULL)`);
        await db.execute(sql`UPDATE issue_reports SET updated_at = now() WHERE id = ${issueId}`);
    };
    // "Claude working" pill: hold the ticket and refresh the heartbeat (unless the cloud fixer holds it).
    const touch = (issueId: number) => db.execute(sql`
        UPDATE issue_reports SET dev_runner_id = ${RUNNER_ID}, dev_runner_heartbeat = now()
         WHERE id = ${issueId} AND (dev_runner_id IS NULL OR dev_runner_id = ${RUNNER_ID})`);
    const release = (issueId: number) => db.execute(sql`
        UPDATE issue_reports SET dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
         WHERE id = ${issueId} AND dev_runner_id = ${RUNNER_ID}`);
    const ghToken = () => { try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    const printChecklist = async (issueId: number) => {
        const row = await loadProofRow(db, issueId);
        if (!row) { console.log('(proof columns missing: run db/z-issue-fix-proof.sql)'); return; }
        const c = productionChecklist(row);
        const icon: Record<string, string> = { ok: '✅', warn: '⚠️ ', fail: '❌', wait: '⏳' };
        console.log(`\nReady for production? ${c.ready ? (c.warnings ? 'READY (with warnings)' : 'READY') : 'not yet'}`);
        for (const i of c.items) console.log(`  ${icon[i.state]} ${i.label}: ${i.detail}`);
    };

    try {
        if (cmd === 'list') {
            const status = arg(rest, '--status') || 'reported';
            const rows = await client`
                SELECT id, status, created_at::text AS created, organisation_id AS org, source_location,
                       left(regexp_replace(coalesce(description, ''), '[[:space:]]+', ' ', 'g'), 140) AS what
                  FROM issue_reports WHERE status = ${status} ORDER BY created_at`;
            for (const r of rows) console.log(`#${r.id}  ${r.created.slice(0, 16)}  org ${r.org ?? '-'}  ${r.source_location ?? ''}\n      ${r.what}`);
            console.log(`\n${rows.length} at '${status}' (${env}).`);
        } else if (cmd === 'show') {
            need(id, 'show <id>');
            const [r] = await client`SELECT * FROM issue_reports WHERE id = ${id}`;
            if (!r) throw new Error(`No issue #${id}.`);
            const { image_data, ...fields } = r;
            console.log(JSON.stringify(fields, (_k, v) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…` : v), 2));
            const msgs = await client`SELECT created_at::text AS at, author_type, author_id, status, body FROM issue_report_messages WHERE issue_id = ${id} ORDER BY created_at`;
            console.log('\n── Thread (oldest first; ✉ = visible to the reporter) ──');
            for (const m of msgs) console.log(`${m.author_id != null || m.author_type === 'user' ? '✉' : ' '} ${m.at.slice(0, 16)} ${m.author_type}${m.status ? ` → ${m.status}` : ''}\n   ${String(m.body).slice(0, 1500).replace(/\n/g, '\n   ')}`);
            const out = arg(rest, '--screenshot');
            if (out && typeof image_data === 'string') {
                const m = /^data:image\/[a-z]+;base64,(.+)$/i.exec(image_data);
                if (m) { writeFileSync(out, Buffer.from(m[1], 'base64')); console.log(`\nScreenshot saved: ${out}`); }
            } else if (image_data) console.log('\n(Has a screenshot: pass --screenshot <file.png> to save it.)');
            await printChecklist(id);
        } else if (cmd === 'start') {
            need(id, 'start <id>');
            // Investigation In Progress; before db/z-issue-investigating.sql the status rule refuses it
            // (23514), so it falls back to Fix In Progress and says so.
            const claim = (status: string) => db.execute(sql`
                UPDATE issue_reports SET status = ${status}, dev_handoff_status = 'in_progress', dev_handoff_at = now(),
                       dev_runner_id = ${RUNNER_ID}, dev_runner_heartbeat = now(), updated_at = now()
                 WHERE id = ${id} AND status NOT IN ('closed', 'roadmap')
                   AND (dev_handoff_status IS DISTINCT FROM 'in_progress' OR dev_runner_id = ${RUNNER_ID})
                RETURNING id`) as Promise<unknown[]>;
            let status = 'investigating';
            let r: unknown[];
            try { r = await claim(status); }
            catch (e: any) {
                if ((e?.code ?? e?.cause?.code) !== '23514') throw e;
                status = 'fix_in_progress';
                console.log('(db/z-issue-investigating.sql has not run on this DB: using Fix In Progress.)');
                r = await claim(status);
            }
            if (!r.length) throw new Error(`#${id} is closed, on the roadmap, or held by another runner.`);
            await note(id, 'Started investigating.');
            console.log(`#${id} → ${status === 'investigating' ? 'Investigation In Progress' : 'Fix In Progress'} (held by ${RUNNER_ID}).`);
        } else if (cmd === 'fixing') {
            need(id, 'fixing <id> --file <what was found>');
            const found = readText(arg(rest, '--file'), 'finding');
            await db.execute(sql`
                UPDATE issue_reports SET status = 'fix_in_progress', dev_runner_id = ${RUNNER_ID}, dev_runner_heartbeat = now(), updated_at = now()
                 WHERE id = ${id} AND status IN ('reported', 'investigating', 'on_hold', 'more_info_required', 'fix_in_progress')`);
            await note(id, `Cause found, writing the fix.\n\n${found}`);
            console.log(`#${id} → Fix In Progress.`);
        } else if (cmd === 'note') {
            need(id, 'note <id> --file <path>');
            await touch(id);
            await note(id, readText(arg(rest, '--file'), 'note'));
            console.log(`Internal note added to #${id}.`);
        } else if (cmd === 'proof') {
            need(id, 'proof <id> ...');
            await touch(id);
            const rc = need(arg(rest, '--root-cause'), '--root-cause confirmed|guessed|not_found') as RootCauseStatus;
            if (!['confirmed', 'guessed', 'not_found'].includes(rc)) throw new Error('--root-cause must be confirmed, guessed or not_found.');
            const evidence = readText(arg(rest, '--file'), 'root-cause evidence');
            const test = arg(rest, '--test') || null;
            const before = arg(rest, '--before'), after = arg(rest, '--after');
            const repro = test ? { test, kind: /\.spec\.ts$/.test(test) ? 'browser' : 'node', before: before == null ? null : { exit: Number(before) }, after: after == null ? null : { exit: Number(after) }, flags: [] } : { test: null, kind: null, before: null, after: null, error: 'No repro test.' };
            if (rc === 'confirmed' && !(test && Number(before) !== 0 && Number(after) === 0)) {
                throw new Error('confirmed needs a repro test that failed before the fix (--before non-zero) and passes after (--after 0).');
            }
            await db.execute(sql`
                UPDATE issue_reports SET dev_root_cause_status = ${rc}, dev_root_cause = ${evidence},
                       dev_repro = ${JSON.stringify(repro)}::jsonb, dev_runner_heartbeat = now(), updated_at = now()
                 WHERE id = ${id}`);
            await note(id, `Root cause ${rc.toUpperCase().replace('_', ' ')}.\n\n${evidence}${test ? `\n\nRepro test ${test}: before the fix exit ${before}, after exit ${after}.` : ''}`);
            console.log(`#${id}: root cause ${rc} recorded.`);
            await printChecklist(id);
        } else if (cmd === 'pr') {
            need(id, 'pr <id> --pr <url> --file <summary>');
            const prUrl = need(arg(rest, '--pr'), '--pr <url>');
            const m = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/.exec(prUrl);
            if (!m) throw new Error('--pr must be a GitHub pull request URL.');
            const summary = readText(arg(rest, '--file'), 'fix summary');
            const sqlFile = arg(rest, '--sql');
            const sqlText = sqlFile ? readFileSync(sqlFile, 'utf8').trim() : null;
            const branch = (() => { try { return execFileSync('gh', ['pr', 'view', m[1], '--json', 'headRefName', '-q', '.headRefName'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
            const { safety } = classifySql(sqlText);
            await db.execute(sql`
                UPDATE issue_reports SET status = 'merge', dev_handoff_status = 'completed', dev_pr_url = ${prUrl}, dev_branch = ${branch},
                       dev_result = ${summary}, dev_sql = ${sqlText}, dev_sql_status = ${sqlText ? 'pending' : null},
                       dev_sql_result = NULL, dev_sql_ran_at = NULL, dev_sql_safety = ${safety}, dev_sql_hash = ${sqlText ? sqlHash(sqlText) : null},
                       dev_merge_status = 'ready', dev_merged_at = NULL, dev_merge_result = NULL,
                       dev_staging_sql_status = NULL, dev_staging_sql_result = NULL, dev_staging_sql_hash = NULL, dev_staging_sql_ran_at = NULL,
                       dev_staging_ci_status = NULL, dev_staging_ci_url = NULL, dev_staging_live_at = NULL,
                       dev_runner_id = ${RUNNER_ID}, dev_runner_heartbeat = now(), updated_at = now()
                 WHERE id = ${id}`);
            await note(id, `Fix ready: ${prUrl}${branch ? ` (branch ${branch})` : ''}.${sqlText ? ` Needs SQL (${safety}).` : ' No database change.'}\n\n${summary}`);
            console.log(`#${id} → Merge (PR recorded${sqlText ? `, SQL ${safety}` : ''}).`);
            await printChecklist(id);
        } else if (cmd === 'staging-sql') {
            need(id, 'staging-sql <id>');
            const stagingUrl = need(process.env.NETLIFY_DATABASE_URL, 'NETLIFY_DATABASE_URL (staging) is not set in .env.');
            await touch(id);
            const wait = await ensureStagingSql(db, id, { urls: { staging: stagingUrl, production: undefined, onProdSite: true } });
            console.log(wait ? `Not done: ${wait}` : `#${id}: SQL is on staging (or none was needed).`);
            await printChecklist(id);
        } else if (cmd === 'merged') {
            need(id, 'merged <id>');
            const row = await loadProofRow(db, id);
            if (!row?.devPrUrl) throw new Error(`#${id} has no PR recorded (run pr first).`);
            const prNum = row.devPrUrl.split('/').pop()!;
            const state = execFileSync('gh', ['pr', 'view', prNum, '--json', 'state,baseRefName', '-q', '"\\(.state) \\(.baseRefName)"'], { encoding: 'utf8' }).trim();
            if (state !== 'MERGED staging') throw new Error(`PR #${prNum} is "${state}", not merged into staging.`);
            if (row.devSql && !(row.devStagingSqlStatus === 'applied' && row.devStagingSqlHash === sqlHash(row.devSql))) {
                throw new Error('The SQL is not on staging yet: run staging-sql first.');
            }
            await db.execute(sql`
                UPDATE issue_reports SET dev_merge_status = 'merged', dev_merged_at = now(),
                       dev_merge_result = ${`Merged into staging by Claude: ${row.devPrUrl}`}, updated_at = now()
                 WHERE id = ${id}`);
            await note(id, `Merged into staging: ${row.devPrUrl}. Waiting for staging CI and the staging deploy.`);
            console.log(`#${id}: merged into staging.`);
            await syncStagingProof(db, { id, devPrUrl: row.devPrUrl, devStagingCiStatus: null, devStagingLiveAt: null }, { token: ghToken() });
            await release(id);   // Claude's part is done; the checklist waits on staging CI / deploy, then the owner
            await printChecklist(id);
        } else if (cmd === 'release') {
            need(id, 'release <id>');
            await release(id);
            console.log(`#${id}: no longer marked as Claude working.`);
        } else if (cmd === 'prod-sql') {
            // Only when the owner says to ship (just before a staging → main release merges). Approve for
            // production runs it itself, so this is for the release-PR route. Additive only, same text as staging.
            need(id, 'prod-sql <id>');
            if (env !== 'prod') throw new Error('prod-sql is for a prod ticket: --env prod.');
            const row = await loadProofRow(db, id);
            const text = (row?.devSql || '').trim();
            if (!row || !text) { console.log(`#${id} has no SQL.`); return; }
            if (row.devStagingSqlStatus !== 'applied' || row.devStagingSqlHash !== sqlHash(text)) throw new Error('This SQL has not passed on staging yet (run staging-sql first).');
            if (row.devProdSqlStatus === 'applied') { console.log(`#${id}: SQL already applied on production.`); return; }
            const res = await runAdditiveSql(url, text, 'production');
            await db.execute(sql`
                UPDATE issue_reports SET dev_prod_sql_status = ${res.ok ? 'applied' : 'failed'}, dev_prod_sql_result = ${res.outcome},
                       dev_prod_sql_ran_at = now(), updated_at = now()
                 WHERE id = ${id}`);
            await note(id, `${res.ok ? 'Database change applied on PRODUCTION.' : 'Database change FAILED on production.'}\n\n${res.outcome}`);
            console.log(res.outcome);
            if (!res.ok) process.exitCode = 1;
            await printChecklist(id);
        } else if (cmd === 'sync') {
            need(id, 'sync <id>');
            const row = await loadProofRow(db, id);
            if (!row) throw new Error(`No proof row for #${id}.`);
            const changed = await syncStagingProof(db, row, { token: ghToken() });
            console.log(changed ? 'Updated from GitHub / staging.' : 'No change.');
            await printChecklist(id);
        } else if (cmd === 'status') {
            need(id, 'status <id> <status> --file <why>');
            const s = need(extra, `status must be one of: ${ALLOWED_STATUSES.join(', ')}`) as (typeof ALLOWED_STATUSES)[number];
            if (!(ALLOWED_STATUSES as readonly string[]).includes(s)) throw new Error(`status must be one of: ${ALLOWED_STATUSES.join(', ')} (the pipeline sets the others).`);
            const why = readText(arg(rest, '--file'), 'reason');
            await db.execute(sql`
                UPDATE issue_reports SET status = ${s},
                       dev_handoff_status = CASE WHEN dev_runner_id = ${RUNNER_ID} THEN NULL ELSE dev_handoff_status END,
                       dev_runner_id = CASE WHEN dev_runner_id = ${RUNNER_ID} THEN NULL ELSE dev_runner_id END,
                       updated_at = now()
                 WHERE id = ${id}`);
            await note(id, `Moved to ${s.replace(/_/g, ' ')}.\n\n${why}`);
            console.log(`#${id} → ${s}.`);
        } else {
            console.error('Commands: list, show, start, fixing, note, proof, pr, staging-sql, merged, sync, prod-sql, release, status (see the header).');
            process.exitCode = 2;
        }
    } catch (e) {
        console.error(`✗ ${(e as Error).message}`);
        process.exitCode = 1;
    } finally {
        await client.end({ timeout: 2 });
    }
}

if (process.argv[1] && /fix-tickets\.ts$/.test(process.argv[1])) main();
