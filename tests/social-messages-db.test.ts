// tests/social-messages-db.test.ts
// Facebook + Instagram messages, Phase 2: runMessagesTick (src/utils/social-messages.ts) on REAL
// Postgres. docs/meta-messages-plan.md.
//
// WHY A DATABASE TEST. The "4 hours left" reminder must go out once per reply window — never twice
// when two ticks overlap, and again when the person writes and a new window starts. That is a
// compare-and-swap on reminded_for_window IS DISTINCT FROM window_closes_at, and the 90-day purge is
// interval arithmetic on naive timestamps. Only Postgres can prove those statements.
//
// HOW. Copies of the tables the tick touches in a throwaway schema, on ONE connection with
// search_path set to it. createNotification reads its template from the public schema (none there →
// the catalog default) and writes to the copied notifications table.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/social-messages-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { runMessagesTick } from '../src/utils/social-messages';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('Meta messages — one reminder per window, and the 90-day purge (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `social_messages_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['ai_assistants', 'notifications']) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS)`);
        await sql.unsafe(`CREATE TABLE ${schema}.social_conversations (LIKE public.social_conversations INCLUDING ALL)`);
        await sql.unsafe(`CREATE TABLE ${schema}.social_messages (LIKE public.social_messages INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const [a] = await sql.unsafe(`INSERT INTO ai_assistants (organisation_id, user_id, name, model) VALUES (1, 42, 'Felix', 'x') RETURNING id`) as any[];
        const [archived] = await sql.unsafe(`INSERT INTO ai_assistants (organisation_id, user_id, name, model, lifecycle_status) VALUES (1, 42, 'Old', 'x', 'archived') RETURNING id`) as any[];
        const conv = async (opts: { assistant: number; participant: string; closesIn: string; status?: string; lastInboundAgo?: string; draft?: string | null }) => {
            const [r] = await sql.unsafe(
                `INSERT INTO social_conversations (organisation_id, ai_assistant_id, connection_id, platform, account_external_id, participant_id, status,
                    last_inbound_at, window_closes_at, draft_reply)
                 VALUES (1, $1, 1, 'instagram', 'ig', $2, $3, now() - $4::interval, now() + $5::interval, $6) RETURNING id`,
                [opts.assistant, opts.participant, opts.status ?? 'new', opts.lastInboundAgo ?? '20 hours', opts.closesIn, opts.draft ?? null]);
            return Number(r.id);
        };
        const reminders = async () => (await sql.unsafe(`SELECT user_id, metadata FROM notifications WHERE type = 'social_message_window_closing' ORDER BY id`)) as any[];

        const due = await conv({ assistant: Number(a.id), participant: 'due', closesIn: '3 hours' });
        await conv({ assistant: Number(a.id), participant: 'later', closesIn: '10 hours' });
        await conv({ assistant: Number(a.id), participant: 'closed', closesIn: '-1 hour' });
        await conv({ assistant: Number(a.id), participant: 'replied', closesIn: '2 hours', status: 'replied' });
        await conv({ assistant: Number(archived.id), participant: 'archived', closesIn: '2 hours' });

        await check('a waiting conversation with under 4 hours left gets one reminder; the others none', async () => {
            const r = await runMessagesTick(db);
            assert.equal(r.reminded, 1);
            const rows = await reminders();
            assert.equal(rows.length, 1);
            assert.equal(Number(rows[0].user_id), 42, "the assistant's owner");
            assert.equal(Number(rows[0].metadata.conversationId), due);
        });

        await check('the next tick does not remind again for the same window', async () => {
            const r = await runMessagesTick(db);
            assert.equal(r.reminded, 0);
            assert.equal((await reminders()).length, 1);
        });

        await check('a new message moves the window — and that window gets its own reminder when it is due', async () => {
            await sql.unsafe(`UPDATE social_conversations SET window_closes_at = now() + interval '2 hours' WHERE id = $1`, [due]);
            const r = await runMessagesTick(db);
            assert.equal(r.reminded, 1);
            assert.equal((await reminders()).length, 2);
        });

        await check('message text older than 90 days is blanked; newer text and the rows stay', async () => {
            const old = await conv({ assistant: Number(a.id), participant: 'old', closesIn: '-100 days', lastInboundAgo: '100 days', draft: 'old draft' });
            await sql.unsafe(`INSERT INTO social_messages (organisation_id, conversation_id, direction, mid, body, sent_at) VALUES
                (1, $1, 'in', 'old-1', 'old words', now() - interval '91 days'),
                (1, $1, 'in', 'new-1', 'new words', now() - interval '89 days')`, [old]);
            const r = await runMessagesTick(db);
            assert.equal(r.purged, 1);
            const rows = await sql.unsafe(`SELECT mid, body FROM social_messages WHERE conversation_id = $1 ORDER BY mid`, [old]) as any[];
            assert.deepEqual(rows.map((x) => [x.mid, x.body]), [['new-1', 'new words'], ['old-1', null]]);
            const [c] = await sql.unsafe(`SELECT draft_reply FROM social_conversations WHERE id = $1`, [old]) as any[];
            assert.equal(c.draft_reply, null, 'an old draft goes too');
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
        await closeDbPools();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
