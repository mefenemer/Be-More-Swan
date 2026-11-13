// scripts/inbox-drafts.ts — Claude drafts replies to support questions for the owner (owner, 2026-11-13).
//
// Claude reads the question, works out the answer against the real system, and saves a DRAFT on the ticket.
// The owner sees it in Admin ▸ Inbox ▸ the ticket, edits it and presses Send Reply. ⚠️ THIS TOOL NEVER SENDS
// ANYTHING to a customer: it only writes support_tickets.draft_reply / draft_note
// (db/z-claude-drafts-and-features.sql). Sending a public reply clears the draft.
//
//   npx tsx scripts/inbox-drafts.ts --env prod list                      (questions waiting on us)
//   npx tsx scripts/inbox-drafts.ts --env prod show <id>
//   npx tsx scripts/inbox-drafts.ts --env prod draft <id> --file <reply.md> [--note <why.md>]
//   npx tsx scripts/inbox-drafts.ts --env prod discard <id>
//
// --env prod → DATABASE_URL_PROD; --env staging → NETLIFY_DATABASE_URL. No default.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { dbUrlFor } from './fix-tickets';

const arg = (a: string[], n: string) => { const i = a.indexOf(n); return i !== -1 ? a[i + 1] : undefined; };

async function main() {
    const args = process.argv.slice(2);
    const env = arg(args, '--env');
    const url = dbUrlFor(env);
    const rest = args.filter((a, i) => a !== '--env' && args[i - 1] !== '--env');
    const [cmd, idArg] = rest;
    const id = Number(idArg);
    const sql = postgres(url, { max: 1, ssl: 'require', onnotice: () => {} });
    try {
        if (cmd === 'list') {
            const rows = await sql`
                SELECT t.id, t.status, t.created_at::text AS created, t.subject, t.category, (t.draft_reply IS NOT NULL) AS drafted,
                       (SELECT r.author_id = t.user_id FROM ticket_replies r WHERE r.ticket_id = t.id AND NOT r.is_internal ORDER BY r.created_at DESC LIMIT 1) AS last_from_customer
                  FROM support_tickets t
                 WHERE t.status IN ('new', 'open')
                 ORDER BY t.created_at`;
            const waiting = rows.filter((r) => r.last_from_customer !== false);
            for (const r of waiting) console.log(`#${r.id}  ${r.created.slice(0, 16)}  [${r.category}] ${r.subject}${r.drafted ? '  ✍️ drafted' : ''}`);
            console.log(`\n${waiting.length} question(s) waiting on us (${env}).`);
        } else if (cmd === 'show') {
            const [t] = await sql`
                SELECT t.*, t.draft_at::text AS draft_at_text, t.created_at::text AS created_text, u.email, u.first_name, o.name AS org_name
                  FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN organisations o ON o.id = t.organisation_id
                 WHERE t.id = ${id}`;
            if (!t) throw new Error(`No ticket #${id}.`);
            console.log(`#${t.id} [${t.status}] ${t.subject}\nFrom: ${t.first_name || ''} (workspace ${t.organisation_id ?? '-'} ${t.org_name || ''})  Category: ${t.category}  Created: ${String(t.created_text).slice(0, 16)}\n\n${t.description}`);
            const replies = await sql`SELECT created_at::text AS at, author_id, is_internal, body FROM ticket_replies WHERE ticket_id = ${id} ORDER BY created_at`;
            for (const r of replies) console.log(`\n── ${r.at.slice(0, 16)} ${r.is_internal ? 'INTERNAL NOTE' : r.author_id === t.user_id ? 'customer' : 'us'}\n${r.body}`);
            if (t.draft_reply) console.log(`\n── Current draft (${String(t.draft_at_text).slice(0, 16)} UTC):\n${t.draft_reply}${t.draft_note ? `\n[note] ${t.draft_note}` : ''}`);
        } else if (cmd === 'draft') {
            const file = arg(rest, '--file');
            if (!id || !file) throw new Error('draft <id> --file <reply.md> [--note <why.md>]');
            const reply = readFileSync(file, 'utf8').trim();
            const noteFile = arg(rest, '--note');
            const note = noteFile ? readFileSync(noteFile, 'utf8').trim() : null;
            const r = await sql`UPDATE support_tickets SET draft_reply = ${reply}, draft_note = ${note}, draft_at = now() WHERE id = ${id} RETURNING id`;
            if (!r.length) throw new Error(`No ticket #${id}.`);
            console.log(`Draft saved on ticket #${id}. Nothing was sent: the owner reviews and sends it.`);
        } else if (cmd === 'discard') {
            await sql`UPDATE support_tickets SET draft_reply = NULL, draft_note = NULL, draft_at = NULL WHERE id = ${id}`;
            console.log(`Draft removed from ticket #${id}.`);
        } else {
            console.error('Commands: list, show, draft, discard (see the header).');
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
