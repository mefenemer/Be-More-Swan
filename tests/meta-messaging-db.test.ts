// tests/meta-messaging-db.test.ts
// Facebook Page + Instagram messages: storeMessagingEvent (src/utils/meta-messaging.ts) on REAL
// Postgres. docs/meta-messages-plan.md, Phase 1.
//
// WHY A DATABASE TEST. Meta retries deliveries and can deliver them out of order. Filing a message
// is three statements — conversation upsert, message insert ON CONFLICT (mid) DO NOTHING, then the
// clocks moved with GREATEST and the status with CASE — and the reply window the Messages tab will
// enforce comes straight out of them. A retried message must change nothing, an older message must
// not pull the window back, and the Page's own reply must mark the conversation replied only when
// it came after the person's last message. Only Postgres can prove that SQL.
//
// HOW. Copies of system_connections (`LIKE … INCLUDING DEFAULTS`) and the two new tables (`INCLUDING
// ALL`, so their unique indexes are part of what is tested) in a throwaway schema, on ONE connection
// with search_path set to it.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/meta-messaging-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { storeMessagingEvent, type ParsedMessage } from '../src/utils/meta-messaging';

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

const PAGE = 'page-1';
const IG = 'ig-1';
const PERSON = 'psid-1';
const T0 = new Date('2026-11-19T10:00:00Z');
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);
const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({
    platform: 'facebook', accountId: PAGE, participantId: PERSON, direction: 'in',
    mid: 'm1', text: 'hello', attachmentType: null, sentAt: T0, deleted: false, ...over,
});

async function main() {
    console.log('Meta messages — filing a message is idempotent and the window only moves forward (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `meta_messaging_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`CREATE TABLE ${schema}.system_connections (LIKE public.system_connections INCLUDING DEFAULTS)`);
        await sql.unsafe(`CREATE TABLE ${schema}.social_conversations (LIKE public.social_conversations INCLUDING ALL)`);
        await sql.unsafe(`CREATE TABLE ${schema}.social_messages (LIKE public.social_messages INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const conn = async (org: number, service: string, ext: string, active = true) => {
            const [r] = await sql.unsafe(
                `INSERT INTO system_connections (organisation_id, assistant_id, service_name, external_user_id, is_active)
                 VALUES ($1, 7, $2, $3, $4) RETURNING id`, [org, service, ext, active]);
            return Number(r.id);
        };
        const conv = async () => (await sql.unsafe(
            `SELECT id, organisation_id, ai_assistant_id, status, last_inbound_at::text li, last_outbound_at::text lo,
                    window_closes_at::text wc FROM social_conversations`)) as any[];
        const msgs = async () => (await sql.unsafe(`SELECT direction, mid, body, attachment_type FROM social_messages ORDER BY id`)) as any[];

        const fbConn = await conn(1, 'facebook', PAGE);
        await conn(1, 'facebook', 'old-page', false);

        await check('a first message creates the conversation, files the message, opens a 24h window', async () => {
            const res = await storeMessagingEvent(db, msg({}));
            assert.equal(res.stored, true);
            const [c] = await conv();
            assert.equal(c.organisation_id, 1);
            assert.equal(c.ai_assistant_id, 7, "filed under the connection's assistant");
            assert.equal(c.status, 'new');
            assert.equal(c.li, '2026-11-19 10:00:00');
            assert.equal(c.wc, '2026-11-20 10:00:00');
            assert.deepEqual((await msgs()).map(m => [m.direction, m.mid, m.body]), [['in', 'm1', 'hello']]);
        });

        await check('the same delivery again changes nothing', async () => {
            const res = await storeMessagingEvent(db, msg({}));
            assert.deepEqual(res, { stored: false, reason: 'duplicate' });
            assert.equal((await msgs()).length, 1);
            assert.equal((await conv()).length, 1);
        });

        await check("the Page's reply after it → 'replied'; the window does not move", async () => {
            await storeMessagingEvent(db, msg({ mid: 'm2', direction: 'out', text: 'hi!', sentAt: at(30) }));
            const [c] = await conv();
            assert.equal(c.status, 'replied');
            assert.equal(c.lo, '2026-11-19 10:30:00');
            assert.equal(c.wc, '2026-11-20 10:00:00', 'our own reply never extends the window');
        });

        await check("a new message from the person → 'new' again and the window restarts from it", async () => {
            await storeMessagingEvent(db, msg({ mid: 'm3', text: 'and Monday?', sentAt: at(60) }));
            const [c] = await conv();
            assert.equal(c.status, 'new');
            assert.equal(c.wc, '2026-11-20 11:00:00');
        });

        await check('a late-arriving OLDER message is filed but pulls neither the window back nor the status', async () => {
            await storeMessagingEvent(db, msg({ mid: 'm2b', direction: 'out', text: 'late echo', sentAt: at(45) }));
            let [c] = await conv();
            assert.equal(c.status, 'new', 'a reply older than the last message does not mark it replied');
            await storeMessagingEvent(db, msg({ mid: 'm0', text: 'earlier', sentAt: at(-10) }));
            [c] = await conv();
            assert.equal(c.li, '2026-11-19 11:00:00');
            assert.equal(c.wc, '2026-11-20 11:00:00');
            assert.equal((await msgs()).length, 5);
        });

        await check('an older inbound after a newer reply leaves it replied', async () => {
            await storeMessagingEvent(db, msg({ mid: 'm4', direction: 'out', text: 'Monday too', sentAt: at(70) }));
            await storeMessagingEvent(db, msg({ mid: 'm3b', text: 'delayed', sentAt: at(65) }));
            const [c] = await conv();
            assert.equal(c.status, 'replied');
        });

        await check('an unsend blanks the text and attachment of that message only', async () => {
            const res = await storeMessagingEvent(db, msg({ mid: 'm3', deleted: true, text: null }));
            assert.deepEqual(res, { stored: false, reason: 'deleted_applied' });
            const m3 = (await msgs()).find(m => m.mid === 'm3');
            assert.equal(m3.body, null);
            assert.equal((await msgs()).find(m => m.mid === 'm1').body, 'hello');
        });

        await check('an account with no active connection (or only an inactive one) is not filed', async () => {
            assert.deepEqual(await storeMessagingEvent(db, msg({ accountId: 'nobody', mid: 'x1' })), { stored: false, reason: 'unknown_account' });
            assert.deepEqual(await storeMessagingEvent(db, msg({ accountId: 'old-page', mid: 'x2' })), { stored: false, reason: 'unknown_account' });
        });

        await check('two active connections for one account → refused, not guessed', async () => {
            await conn(1, 'instagram', IG);
            await conn(2, 'instagram', IG);
            assert.deepEqual(await storeMessagingEvent(db, msg({ platform: 'instagram', accountId: IG, mid: 'x3' })), { stored: false, reason: 'ambiguous_account' });
        });

        await check('Instagram is looked up on the instagram row, not on a facebook row with the same id', async () => {
            await conn(3, 'instagram', 'ig-3');
            await conn(4, 'facebook', 'ig-3');
            const res = await storeMessagingEvent(db, msg({ platform: 'instagram', accountId: 'ig-3', mid: 'x4' }));
            assert.equal(res.stored, true);
            const rows = await sql.unsafe(`SELECT organisation_id, platform FROM social_conversations WHERE account_external_id = 'ig-3'`) as any[];
            assert.deepEqual(rows.map(r => [r.organisation_id, r.platform]), [[3, 'instagram']]);
        });

        await check('the same person on a different connection is a separate conversation', async () => {
            await conn(1, 'facebook', 'page-2');
            await storeMessagingEvent(db, msg({ accountId: 'page-2', mid: 'x5' }));
            const rows = await sql.unsafe(`SELECT connection_id FROM social_conversations WHERE participant_id = $1 AND organisation_id = 1 AND platform = 'facebook' ORDER BY id`, [PERSON]) as any[];
            assert.equal(rows.length, 2);
            assert.equal(Number(rows[0].connection_id), fbConn);
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
        await closeDbPools();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
