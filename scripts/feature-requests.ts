// scripts/feature-requests.ts — Claude builds the feature requests the owner chooses (owner, 2026-11-13).
//
// The owner decides what to build. Claude then moves the request along the Feature requests board from its
// session, keeping notes and its pull request on the request, with a "🛠️ Claude working" pill on the card
// while it is on it (src/utils/claude-work.ts; db/z-claude-drafts-and-features.sql).
// ⚠️ NOTHING HERE NOTIFIES THE SUBMITTER OR VOTERS (the admin board does that when the owner moves a card);
// the owner does all communication.
//
// Same checks as the Fix pipeline (owner, 2026-11-13; src/utils/feature-proof.ts): proof test, SQL recorded,
// classified and run on staging, prod SQL only on the owner's word, Approve refuses a merge until the SQL is
// on that PR's database, staging CI + deploy followed, and Released only once the prod deploy contains it.
//
//   npx tsx scripts/feature-requests.ts --env prod list [--status brief_ready]
//   npx tsx scripts/feature-requests.ts --env prod show <id>
//   npx tsx scripts/feature-requests.ts --env prod start <id>                    (→ In progress)
//   npx tsx scripts/feature-requests.ts --env prod note <id> --file <note.md>
//   npx tsx scripts/feature-requests.ts --env prod proof <id> --test <path> --before <exit> --after <exit> --file <evidence.md>
//                                         (a test of the new behaviour: fails on the old code, passes with the feature)
//   npx tsx scripts/feature-requests.ts --env prod pr <id> --pr <url> --file <summary.md> [--sql <file.sql>]
//   npx tsx scripts/feature-requests.ts --env prod staging-sql <id>              (additive SQL → staging DB, checked)
//   npx tsx scripts/feature-requests.ts --env prod merged <id>                   (after the PR merged into staging)
//   npx tsx scripts/feature-requests.ts --env prod sync <id>                     (staging CI + staging deploy → checklist)
//   npx tsx scripts/feature-requests.ts --env prod prod-sql <id>                 (ONLY on the owner's word, before the merge into main)
//   npx tsx scripts/feature-requests.ts --env prod sql-done <id> staging|production   (owner ran not-additive SQL by hand and said so)
//   npx tsx scripts/feature-requests.ts --env prod inspect --file <query.sql>    (READ-ONLY: one SELECT)
//   npx tsx scripts/feature-requests.ts --env prod status <id> <planned|brief_ready|in_progress|released|declined|duplicate|open> --file <why.md>
//   npx tsx scripts/feature-requests.ts --env prod release <id>                  (clear the pill)
//   npx tsx scripts/feature-requests.ts --env prod prod-pr <id> --pr <url>       (record the PR into main: "Prod PR" pill)
//   npx tsx scripts/feature-requests.ts --env prod ask-approval <id> --pr <url> [--file <why.md>]
//                                         (shows the owner an "Approve PR #N" button; their click merges it; into main → Released, no one notified)
//   npx tsx scripts/feature-requests.ts --env prod withdraw-approval <id>

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { dbUrlFor, RUNNER_ID } from './fix-tickets';
import { classifySql, sqlHash } from '../src/utils/issue-sql';
import { ensureFeatureStagingSql, featureChecklist, loadFeatureProof, recordManualFeatureSql, resetFeatureProofCache, runFeatureProdSql, syncFeatureStaging } from '../src/utils/feature-proof';

const arg = (a: string[], n: string) => { const i = a.indexOf(n); return i !== -1 ? a[i + 1] : undefined; };
const STATUSES = ['open', 'planned', 'brief_ready', 'in_progress', 'released', 'declined', 'duplicate'];
const DEFAULT_LIST = ['open', 'planned', 'brief_ready', 'in_progress'];

async function main() {
    const args = process.argv.slice(2);
    const env = arg(args, '--env');
    const url = dbUrlFor(env);
    const rest = args.filter((a, i) => a !== '--env' && args[i - 1] !== '--env');
    const [cmd, idArg, extra] = rest;
    const id = Number(idArg);
    const sql = postgres(url, { max: 1, ssl: 'require', onnotice: () => {} });
    const db = drizzle({ client: sql }) as any;
    resetFeatureProofCache();
    const ghToken = () => { try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    const printChecklist = async () => {
        const row = await loadFeatureProof(db, id);
        if (!row) { console.log('\n(proof columns missing: run db/z-feature-pipeline-proof.sql on this DB)'); return; }
        const c = featureChecklist(row);
        const icon: Record<string, string> = { ok: '✅', warn: '⚠️ ', fail: '❌', wait: '⏳' };
        console.log(`\nReady for production? ${c.ready ? (c.warnings ? 'READY (with warnings)' : 'READY') : 'not yet'}`);
        for (const i of c.items) console.log(`  ${icon[i.state]} ${i.label}: ${i.detail}`);
    };
    const needProof = async () => { const r = await loadFeatureProof(db, id); if (!r) throw new Error(`No request #${id}, or db/z-feature-pipeline-proof.sql has not run on this DB.`); return r; };
    const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
    // Append to the request's notes and refresh the "Claude working" heartbeat.
    const note = (text: string, keepWorking = true) => sql`
        UPDATE feature_requests
           SET dev_notes = concat_ws(E'\n\n', dev_notes, ${`[${stamp()} UTC] ${text}`}::text),
               dev_runner_id = ${keepWorking ? RUNNER_ID : null}::text,
               dev_runner_heartbeat = CASE WHEN ${keepWorking}::boolean THEN now() ELSE NULL END,
               updated_at = now()
         WHERE id = ${id} RETURNING id`;
    const readFile = (what: string) => { const f = arg(rest, '--file'); if (!f) throw new Error(`--file <path> with the ${what} is required.`); return readFileSync(f, 'utf8').trim(); };
    try {
        if (cmd === 'list') {
            const st = arg(rest, '--status');
            const statuses = st ? [st] : DEFAULT_LIST;
            const rows = await sql`
                SELECT id, status, priority, vote_count, title, (dev_runner_id IS NOT NULL) AS working, dev_pr_url
                  FROM feature_requests WHERE status IN ${sql(statuses)} ORDER BY sort_order, created_at DESC`;
            for (const r of rows) console.log(`#${r.id}  [${r.status}] ${r.priority}  ${r.vote_count} vote(s)  ${r.title}${r.working ? '  🛠️' : ''}${r.dev_pr_url ? '  PR' : ''}`);
            console.log(`\n${rows.length} at ${statuses.join(' / ')} (${env}).`);
        } else if (cmd === 'show') {
            const [r] = await sql`SELECT * FROM feature_requests WHERE id = ${id}`;
            if (!r) throw new Error(`No request #${id}.`);
            console.log(`#${r.id} [${r.status}] ${r.title}  (${r.category}${r.assistant_ref ? ` · ${r.assistant_ref}` : ''}, ${r.priority}, ${r.vote_count} votes)\n\n${r.description || ''}`);
            if (r.submitter_description && r.submitter_description !== r.description) console.log(`\n── Submitter's words:\n${r.submitter_description}`);
            if (r.brief) console.log(`\n── Brief:\n${r.brief}`);
            if (r.dev_pr_url) console.log(`\n── PR: ${r.dev_pr_url}`);
            if (r.dev_notes) console.log(`\n── Claude's notes:\n${r.dev_notes}`);
            await printChecklist();
        } else if (cmd === 'start') {
            const r = await sql`UPDATE feature_requests SET status = 'in_progress', updated_at = now() WHERE id = ${id} AND status NOT IN ('released', 'declined', 'duplicate') RETURNING id`;
            if (!r.length) throw new Error(`#${id} is released, declined, a duplicate, or missing.`);
            await note('Started building.');
            console.log(`#${id} → In progress (Claude working).`);
        } else if (cmd === 'note') {
            if (!(await note(readFile('note'))).length) throw new Error(`No request #${id}.`);
            console.log(`Note added to #${id}.`);
        } else if (cmd === 'proof') {
            await needProof();
            const test = arg(rest, '--test'), before = arg(rest, '--before'), after = arg(rest, '--after');
            if (!test || before == null || after == null) throw new Error('proof needs --test <path> --before <exit> --after <exit> --file <evidence>.');
            const evidence = readFile('evidence');
            const repro = { test, kind: /\.spec\.ts$/.test(test) ? 'browser' : 'node', before: { exit: Number(before) }, after: { exit: Number(after) }, flags: [] };
            await sql`UPDATE feature_requests SET dev_repro = ${sql.json(repro)}, updated_at = now() WHERE id = ${id}`;
            const good = Number(before) !== 0 && Number(after) === 0;
            await note(`Proof test ${test}: on the old code exit ${before}, with the feature exit ${after}${good ? ' ✓' : ' (does NOT prove the feature)'}.\n\n${evidence}`);
            console.log(`#${id}: proof recorded${good ? '' : ' (warning: it does not fail before and pass after)'}.`);
            await printChecklist();
        } else if (cmd === 'pr') {
            const pr = arg(rest, '--pr');
            if (!pr || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr)) throw new Error('--pr must be a GitHub pull request URL.');
            const summary = readFile('summary');
            const sqlFile = arg(rest, '--sql');
            const sqlText = sqlFile ? readFileSync(sqlFile, 'utf8').trim() : null;
            const { safety } = classifySql(sqlText);
            const proofReady = !!(await loadFeatureProof(db, id));
            if (sqlText && !proofReady) throw new Error('This feature has SQL: run db/z-feature-pipeline-proof.sql on this DB first, so the SQL can be tracked and gated.');
            await sql`UPDATE feature_requests SET dev_pr_url = ${pr} WHERE id = ${id}`;
            if (proofReady) {
                // A new PR starts its checks again: its SQL, staging merge, CI and deploys are re-proved.
                await sql`
                    UPDATE feature_requests SET dev_sql = ${sqlText}, dev_sql_safety = ${safety}, dev_sql_hash = ${sqlText ? sqlHash(sqlText) : null},
                           dev_staging_sql_status = NULL, dev_staging_sql_result = NULL, dev_staging_sql_hash = NULL, dev_staging_sql_ran_at = NULL,
                           dev_merged_at = NULL, dev_staging_ci_status = NULL, dev_staging_ci_url = NULL, dev_staging_live_at = NULL,
                           dev_prod_sql_status = NULL, dev_prod_sql_result = NULL, dev_prod_sql_ran_at = NULL, dev_prod_merged_at = NULL, live_at = NULL,
                           updated_at = now()
                     WHERE id = ${id}`;
            }
            await note(`Pull request: ${pr}.${sqlText ? ` Needs SQL (${safety}).` : ' No database change.'}\n\n${summary}`);
            console.log(`#${id}: PR recorded${sqlText ? `, SQL ${safety}` : ''}.`);
            await printChecklist();
        } else if (cmd === 'staging-sql') {
            await needProof();
            const stagingUrl = process.env.NETLIFY_DATABASE_URL;
            if (!stagingUrl) throw new Error('NETLIFY_DATABASE_URL (staging) is not set in .env.');
            const wait = await ensureFeatureStagingSql(db, id, stagingUrl);
            const row = await needProof();
            if (!wait && row.devSql) await note(`🗄️ Database change applied on STAGING and checked.\n\n${row.devStagingSqlResult || ''}`);
            console.log(wait ? `Not done: ${wait}` : `#${id}: SQL is on staging (or none was needed).`);
            if (wait) process.exitCode = 1;
            await printChecklist();
        } else if (cmd === 'merged') {
            const row = await needProof();
            if (!row.devPrUrl) throw new Error(`#${id} has no PR recorded (run pr first).`);
            const prNum = row.devPrUrl.split('/').pop()!;
            const state = execFileSync('gh', ['pr', 'view', prNum, '--json', 'state,baseRefName', '-q', '"\\(.state) \\(.baseRefName)"'], { encoding: 'utf8' }).trim();
            if (state !== 'MERGED staging') throw new Error(`PR #${prNum} is "${state}", not merged into staging.`);
            if (row.devSql && !(row.devStagingSqlStatus === 'applied' && row.devStagingSqlHash === sqlHash(row.devSql))) throw new Error('The SQL is not on staging yet: run staging-sql first.');
            await sql`UPDATE feature_requests SET dev_merged_at = coalesce(dev_merged_at, now()), updated_at = now() WHERE id = ${id}`;
            await note(`Merged into staging: ${row.devPrUrl}. Waiting for staging CI and the staging deploy.`, false);
            await syncFeatureStaging(db, { id, devPrUrl: row.devPrUrl, devStagingCiStatus: null, devStagingLiveAt: null }, { token: ghToken() });
            console.log(`#${id}: merged into staging.`);
            await printChecklist();
        } else if (cmd === 'sync') {
            const row = await needProof();
            const changed = await syncFeatureStaging(db, row, { token: ghToken() });
            console.log(changed ? 'Updated from GitHub / staging.' : 'No change.');
            await printChecklist();
        } else if (cmd === 'prod-sql') {
            // ONLY when the owner says to ship, just before the merge into main. Additive, same text as staging.
            if (env !== 'prod') throw new Error('prod-sql is for a prod request: --env prod.');
            await needProof();
            const res = await runFeatureProdSql(db, id, url);
            await note(`${res.ok ? 'Database change applied on PRODUCTION.' : 'Database change FAILED on production.'}\n\n${res.outcome}`);
            console.log(res.outcome);
            if (!res.ok) process.exitCode = 1;
            await printChecklist();
        } else if (cmd === 'sql-done') {
            // The owner ran not-additive SQL by hand and told Claude so. Never on anyone else's word.
            if (extra !== 'staging' && extra !== 'production') throw new Error('sql-done <id> staging|production');
            const err = await recordManualFeatureSql(db, id, extra);
            if (err) throw new Error(err);
            await note(`🗄️ The owner ran this feature's SQL by hand on ${extra.toUpperCase()}.`);
            console.log(`#${id}: SQL recorded as run on ${extra}.`);
            await printChecklist();
        } else if (cmd === 'inspect') {
            // Investigation only: one statement in a READ ONLY transaction, 20 s cap, 200 rows shown.
            const q = readFile('SELECT');
            if (!/^\s*(select|with)\b/i.test(q) || /;\s*\S/.test(q.replace(/;\s*$/, ''))) throw new Error('inspect runs ONE SELECT (or WITH … SELECT).');
            const rows = await sql.begin('READ ONLY', async (tx: any) => {
                await tx.unsafe("SET LOCAL statement_timeout = '20s'");
                return tx.unsafe(q.replace(/;\s*$/, ''));
            }) as any[];
            for (const r of rows.slice(0, 200)) console.log(JSON.stringify(r, (_k, v) => (typeof v === 'string' && v.length > 1500 ? `${v.slice(0, 1500)}…` : v)));
            console.log(`(${rows.length} row(s)${rows.length > 200 ? ', first 200 shown' : ''})`);
        } else if (cmd === 'prod-pr' || cmd === 'ask-approval') {
            // PR pills + the owner's Approve button (src/utils/pr-approval.ts; db/z-pr-approval.sql).
            const pr = arg(rest, '--pr');
            const m = pr ? /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/.exec(pr) : null;
            if (!pr || !m) throw new Error('--pr must be a GitHub pull request URL.');
            const base = execFileSync('gh', ['pr', 'view', m[1], '--json', 'baseRefName', '-q', '.baseRefName'], { encoding: 'utf8' }).trim();
            if (cmd === 'prod-pr' && base !== 'main') throw new Error(`PR #${m[1]} goes into "${base}", not main.`);
            const ask = cmd === 'ask-approval';
            const why = ask && arg(rest, '--file') ? readFile('note') : null;
            const r = await sql`
                UPDATE feature_requests SET
                       prod_pr_url = CASE WHEN ${base}::text = 'main' THEN ${pr}::text ELSE prod_pr_url END,
                       dev_pr_url = CASE WHEN ${base}::text <> 'main' AND dev_pr_url IS NULL THEN ${pr}::text ELSE dev_pr_url END,
                       approval_pr_url = CASE WHEN ${ask}::boolean THEN ${pr}::text ELSE approval_pr_url END,
                       approval_note = CASE WHEN ${ask}::boolean THEN ${why}::text ELSE approval_note END,
                       approval_requested_at = CASE WHEN ${ask}::boolean THEN now() ELSE approval_requested_at END,
                       updated_at = now()
                 WHERE id = ${id} RETURNING id`;
            if (!r.length) throw new Error(`No request #${id}.`);
            if (ask) {
                await note(`Waiting for the owner to approve PR #${m[1]} (into ${base}): ${pr}${why ? `\n\n${why}` : ''}`);
                console.log(`#${id}: "Approve PR #${m[1]}" (into ${base}) is now showing for the owner.`);
            } else {
                console.log(`#${id}: prod PR #${m[1]} recorded.`);
            }
        } else if (cmd === 'withdraw-approval') {
            await sql`UPDATE feature_requests SET approval_pr_url = NULL, approval_note = NULL, approval_requested_at = NULL, updated_at = now() WHERE id = ${id}`;
            console.log(`#${id}: no longer asking for approval.`);
        } else if (cmd === 'status') {
            if (!extra || !STATUSES.includes(extra)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
            // Like a fix: Released is the go-live check's call (the prod deploy contains it), never Claude's.
            if (extra === 'released' && (await loadFeatureProof(db, id))) throw new Error('Released is set by the live check once the production deploy contains the feature (or by the owner on the board).');
            const why = readFile('reason');
            await sql`UPDATE feature_requests SET status = ${extra}, updated_at = now() WHERE id = ${id}`;
            const done = ['released', 'declined', 'duplicate'].includes(extra);
            await note(`Moved to ${extra.replace('_', ' ')}.\n\n${why}`, !done);
            console.log(`#${id} → ${extra}. (No one was notified.)`);
        } else if (cmd === 'release') {
            await sql`UPDATE feature_requests SET dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now() WHERE id = ${id}`;
            console.log(`#${id}: no longer marked as Claude working.`);
        } else {
            console.error('Commands: list, show, start, note, proof, pr, staging-sql, merged, sync, prod-sql, sql-done, inspect, prod-pr, ask-approval, withdraw-approval, status, release (see the header).');
            process.exitCode = 2;
        }
    } catch (e) {
        console.error(`✗ ${(e as Error).message}`);
        process.exitCode = 1;
    } finally {
        await sql.end({ timeout: 2 });
    }
}
main();
