// scripts/feature-requests.ts — Claude builds the feature requests the owner chooses (owner, 2026-11-13).
//
// The owner decides what to build. Claude then moves the request along the Feature requests board from its
// session, keeping notes and its pull request on the request, with a "🛠️ Claude working" pill on the card
// while it is on it (src/utils/claude-work.ts; db/z-claude-drafts-and-features.sql).
// ⚠️ NOTHING HERE NOTIFIES THE SUBMITTER OR VOTERS (the admin board does that when the owner moves a card);
// the owner does all communication.
//
//   npx tsx scripts/feature-requests.ts --env prod list [--status brief_ready]
//   npx tsx scripts/feature-requests.ts --env prod show <id>
//   npx tsx scripts/feature-requests.ts --env prod start <id>                    (→ In progress)
//   npx tsx scripts/feature-requests.ts --env prod note <id> --file <note.md>
//   npx tsx scripts/feature-requests.ts --env prod pr <id> --pr <url> --file <summary.md>
//   npx tsx scripts/feature-requests.ts --env prod status <id> <planned|brief_ready|in_progress|released|declined|duplicate|open> --file <why.md>
//   npx tsx scripts/feature-requests.ts --env prod release <id>                  (clear the pill)

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { dbUrlFor, RUNNER_ID } from './fix-tickets';

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
    const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
    // Append to the request's notes and refresh the "Claude working" heartbeat.
    const note = (text: string, keepWorking = true) => sql`
        UPDATE feature_requests
           SET dev_notes = concat_ws(E'\n\n', dev_notes, ${`[${stamp()} UTC] ${text}`}),
               dev_runner_id = ${keepWorking ? RUNNER_ID : null}, dev_runner_heartbeat = ${keepWorking ? sql`now()` : null},
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
        } else if (cmd === 'start') {
            const r = await sql`UPDATE feature_requests SET status = 'in_progress', updated_at = now() WHERE id = ${id} AND status NOT IN ('released', 'declined', 'duplicate') RETURNING id`;
            if (!r.length) throw new Error(`#${id} is released, declined, a duplicate, or missing.`);
            await note('Started building.');
            console.log(`#${id} → In progress (Claude working).`);
        } else if (cmd === 'note') {
            if (!(await note(readFile('note'))).length) throw new Error(`No request #${id}.`);
            console.log(`Note added to #${id}.`);
        } else if (cmd === 'pr') {
            const pr = arg(rest, '--pr');
            if (!pr || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr)) throw new Error('--pr must be a GitHub pull request URL.');
            await sql`UPDATE feature_requests SET dev_pr_url = ${pr} WHERE id = ${id}`;
            await note(`Pull request: ${pr}\n\n${readFile('summary')}`);
            console.log(`#${id}: PR recorded.`);
        } else if (cmd === 'status') {
            if (!extra || !STATUSES.includes(extra)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
            const why = readFile('reason');
            await sql`UPDATE feature_requests SET status = ${extra}, updated_at = now() WHERE id = ${id}`;
            const done = ['released', 'declined', 'duplicate'].includes(extra);
            await note(`Moved to ${extra.replace('_', ' ')}.\n\n${why}`, !done);
            console.log(`#${id} → ${extra}. (No one was notified.)`);
        } else if (cmd === 'release') {
            await sql`UPDATE feature_requests SET dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now() WHERE id = ${id}`;
            console.log(`#${id}: no longer marked as Claude working.`);
        } else {
            console.error('Commands: list, show, start, note, pr, status, release (see the header).');
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
