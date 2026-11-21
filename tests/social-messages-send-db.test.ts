// tests/social-messages-send-db.test.ts
// Facebook + Instagram messages: sendReply (src/utils/social-messages.ts) on REAL Postgres, with a
// fake Meta. docs/meta-messages-plan.md, Phase 2.
//
// WHY A DATABASE TEST. Send is the one path that reaches a stranger, and its guarantees are SQL: the
// 24-hour window decided by the database clock, a per-conversation advisory lock, the repeat guard,
// and — once Meta has accepted — bookkeeping that may fail without the user ever being told to try
// again (which would send it twice). Reading the source can't prove those; running it can.
//
// HOW. Copies of the two tables in a throwaway schema, on ONE connection with search_path set to it;
// Meta's page credentials and the Send API are injected fakes (sendReply's `deps`).
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/social-messages-send-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { sendReply } from '../src/utils/social-messages';

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

const ORG = 1, ASSISTANT = 7, USER = 42;

async function main() {
    console.log('Meta messages — Send: window, lock, repeat guard, never "try again" after Meta accepted (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    process.env.META_MESSAGING_ENABLED = 'true';

    const schema = `social_send_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    const other = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`CREATE TABLE ${schema}.social_conversations (LIKE public.social_conversations INCLUDING ALL)`);
        await sql.unsafe(`CREATE TABLE ${schema}.social_messages (LIKE public.social_messages INCLUDING ALL)`);
        // Lets one case make the bookkeeping fail AFTER Meta accepted.
        await sql.unsafe(`ALTER TABLE ${schema}.social_messages ADD CONSTRAINT test_fail_record CHECK (body IS DISTINCT FROM 'FAIL-RECORD')`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const conv = async (closesIn: string, lastInboundAgo = '1 hour') => {
            const [r] = await sql.unsafe(
                `INSERT INTO social_conversations (organisation_id, ai_assistant_id, connection_id, platform, account_external_id, participant_id, status, last_inbound_at, window_closes_at)
                 VALUES (${ORG}, ${ASSISTANT}, 1, 'facebook', 'page', 'psid-' || floor(random()*1e9)::text, 'new', now() - $1::interval, now() + $2::interval) RETURNING id`,
                [lastInboundAgo, closesIn]);
            return Number(r.id);
        };
        let calls = 0;
        const meta = (respond: () => Response | Promise<Response>) => ({
            credsFor: async () => ({ pageId: 'PAGE', pageToken: 'TOKEN' }),
            fetchImpl: (async () => { calls++; return respond(); }) as unknown as typeof fetch,
        });
        const okWith = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
        const row = async (id: number) => ((await sql.unsafe(`SELECT status, draft_reply, last_outbound_at FROM social_conversations WHERE id = $1`, [id])) as any[])[0];
        const outs = async (id: number) => (await sql.unsafe(`SELECT mid, body, sent_by FROM social_messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY id`, [id])) as any[];

        await check('a closed window is refused by the database clock, and Meta is never called', async () => {
            const id = await conv('-1 minute', '25 hours');
            calls = 0;
            const r = await sendReply(db, ORG, ASSISTANT, id, 'Hello', USER, meta(okWith({ recipient_id: 'p', message_id: 'm1' })));
            assert.equal(r.ok, false);
            assert.equal((r as { code?: string }).code, 'window_closed');
            assert.equal(calls, 0);
        });

        let sentId = 0;
        await check('an open window sends once, files the reply as sent from here, and marks it replied', async () => {
            sentId = await conv('5 hours');
            await sql.unsafe(`UPDATE social_conversations SET draft_reply = 'draft' WHERE id = $1`, [sentId]);
            calls = 0;
            const r = await sendReply(db, ORG, ASSISTANT, sentId, 'See you Sunday!', USER, meta(okWith({ recipient_id: 'p', message_id: 'm_ok' })));
            assert.equal(r.ok, true);
            assert.equal(calls, 1);
            assert.deepEqual((await outs(sentId)).map((m) => [m.mid, m.body, Number(m.sent_by)]), [['m_ok', 'See you Sunday!', USER]]);
            const c = await row(sentId);
            assert.equal(c.status, 'replied');
            assert.equal(c.draft_reply, null);
        });

        await check('the same text again with nothing new from them is refused before Meta is called', async () => {
            calls = 0;
            const r = await sendReply(db, ORG, ASSISTANT, sentId, 'See you Sunday!', USER, meta(okWith({ recipient_id: 'p', message_id: 'm_dup' })));
            assert.equal((r as { code?: string }).code, 'duplicate');
            assert.equal(calls, 0);
        });

        await check('after they write again, the same answer may be sent', async () => {
            await sql.unsafe(`UPDATE social_conversations SET last_inbound_at = now() + interval '1 second' WHERE id = $1`, [sentId]);
            calls = 0;
            const r = await sendReply(db, ORG, ASSISTANT, sentId, 'See you Sunday!', USER, meta(okWith({ recipient_id: 'p', message_id: 'm_again' })));
            assert.equal(r.ok, true);
            assert.equal(calls, 1);
        });

        await check('while another send holds the conversation lock, a second one is refused', async () => {
            const id = await conv('5 hours');
            await other.unsafe(`SELECT pg_advisory_lock(hashtext($1))`, [`social-send:${id}`]);
            try {
                calls = 0;
                const r = await sendReply(db, ORG, ASSISTANT, id, 'Hi', USER, meta(okWith({ recipient_id: 'p', message_id: 'm_lock' })));
                assert.equal((r as { code?: string }).code, 'busy');
                assert.equal(calls, 0);
            } finally {
                await other.unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [`social-send:${id}`]);
            }
        });

        await check('when recording fails after Meta accepted, the user is still told it was sent (never "try again")', async () => {
            const id = await conv('5 hours');
            calls = 0;
            const r = await sendReply(db, ORG, ASSISTANT, id, 'FAIL-RECORD', USER, meta(okWith({ recipient_id: 'p', message_id: 'm_fail' })));
            assert.equal(r.ok, true);
            assert.equal(calls, 1);
        });

        await check('when the echo got there first, the row ends up marked as sent from here', async () => {
            const id = await conv('5 hours');
            await sql.unsafe(`INSERT INTO social_messages (organisation_id, conversation_id, direction, mid, body, sent_at) VALUES (${ORG}, $1, 'out', 'm_echo', '(echo)', now())`, [id]);
            const r = await sendReply(db, ORG, ASSISTANT, id, 'Thanks!', USER, meta(okWith({ recipient_id: 'p', message_id: 'm_echo' })));
            assert.equal(r.ok, true);
            assert.deepEqual((await outs(id)).map((m) => [m.mid, Number(m.sent_by)]), [['m_echo', USER]]);
        });

        await check('with no message id from Meta, the reply is filed under a placeholder at once — and the repeat guard sees it', async () => {
            const id = await conv('5 hours');
            const r = await sendReply(db, ORG, ASSISTANT, id, 'Noted', USER, meta(okWith({ recipient_id: 'p' })));
            assert.equal(r.ok, true);
            const rows = await outs(id);
            assert.equal(rows.length, 1);
            assert.ok(String(rows[0].mid).startsWith('pending:'));
            assert.equal(Number(rows[0].sent_by), USER);
            assert.equal((await row(id)).status, 'replied');
            calls = 0;
            const again = await sendReply(db, ORG, ASSISTANT, id, 'Noted', USER, meta(okWith({ recipient_id: 'p' })));
            assert.equal((again as { code?: string }).code, 'duplicate', 'no second send before the echo arrives');
            assert.equal(calls, 0);
        });

        await check('with no message id and the echo already filed, the echo row is claimed — the reply shows once', async () => {
            const id = await conv('5 hours');
            await sql.unsafe(`INSERT INTO social_messages (organisation_id, conversation_id, direction, mid, body, sent_at) VALUES (${ORG}, $1, 'out', 'm_early_echo', 'Early bird', now())`, [id]);
            // The early echo would trip the repeat guard, so it is filed with a different text first and renamed after the guard ran.
            await sql.unsafe(`UPDATE social_messages SET body = 'Early bird (before)' WHERE mid = 'm_early_echo'`);
            const r = await sendReply(db, ORG, ASSISTANT, id, 'Early bird', USER, {
                credsFor: async () => ({ pageId: 'PAGE', pageToken: 'TOKEN' }),
                fetchImpl: (async () => {
                    // Meta delivers the echo while the send is still being recorded.
                    await other.unsafe(`UPDATE ${schema}.social_messages SET body = 'Early bird' WHERE mid = 'm_early_echo'`);
                    return new Response(JSON.stringify({ recipient_id: 'p' }), { status: 200 });
                }) as unknown as typeof fetch,
            });
            assert.equal(r.ok, true);
            assert.deepEqual((await outs(id)).map((m) => [m.mid, Number(m.sent_by)]), [['m_early_echo', USER]]);
        });

        await check('a timeout says the reply may have gone — never "try again" — and keeps the draft', async () => {
            const id = await conv('5 hours');
            const r = await sendReply(db, ORG, ASSISTANT, id, 'Maybe sent', USER, {
                credsFor: async () => ({ pageId: 'PAGE', pageToken: 'TOKEN' }),
                fetchImpl: (async () => { throw new Error('The operation was aborted due to timeout'); }) as unknown as typeof fetch,
            });
            assert.equal(r.ok, false);
            assert.equal((r as { code?: string }).code, 'unconfirmed');
            assert.ok(!/try again/i.test((r as { error: string }).error));
            assert.equal((await row(id)).draft_reply, 'Maybe sent');
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
        await other.end();
        await closeDbPools();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
