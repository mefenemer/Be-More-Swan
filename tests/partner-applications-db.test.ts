// tests/partner-applications-db.test.ts
// Applying to be a partner, approval, and the private account link — on REAL Postgres
// (src/utils/partner-applications.ts, src/utils/referral-code.ts).
//
// WHY A DATABASE TEST. One application per email rests on a unique index over lower(email); a link
// working exactly once rests on a conditional UPDATE; the token lookup filters on hash, status,
// account and expiry together. None of that is provable with mocks.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`, no foreign keys) in a throwaway
// schema, one connection. Emails are not sent (no RESEND_API_KEY in tests — email.ts logs instead).
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/partner-applications-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
    claimPartnerInvite, findPartnerByInviteToken, recordApplication, sendApprovalEmail, type ApplicationInput,
} from '../src/utils/partner-applications';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

const TABLES = ['users', 'partners', 'email_templates'];
const app = (over: Partial<ApplicationInput> = {}): ApplicationInput => ({
    name: 'Jo Example', email: 'jo@example.com', channels: ['newsletter'], audience: '', links: '', message: '', ...over,
});

async function main() {
    console.log('Partner applications and the account link (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `partner_apply_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        await sql.unsafe(`INSERT INTO users (id, email, first_name, role) VALUES (50, 'customer@example.com', 'Cass', 'user')`);

        let jo = 0;
        await check('an application without an account creates no user and is stored for review', async () => {
            const r = await recordApplication(db, app(), null);
            assert.strictEqual(r.outcome, 'created');
            jo = r.partnerId!;
            const [row] = await sql.unsafe(`SELECT status, user_id, applicant_email, application FROM partners WHERE id = ${jo}`);
            assert.deepStrictEqual([row.status, row.user_id, row.applicant_email], ['applied', null, 'jo@example.com']);
            assert.strictEqual(row.application['How they will promote'], 'Email newsletter');
            assert.strictEqual(Number((await sql.unsafe(`SELECT count(*) FROM users`))[0].count), 1);
        });

        await check('one application per email, whatever the capitals', async () => {
            const r = await recordApplication(db, app({ email: 'JO@example.com'.toLowerCase(), name: 'Jo Again' }), null);
            assert.strictEqual(r.outcome, 'duplicate');
            await sql.unsafe(`INSERT INTO partners (status, applicant_email) VALUES ('applied', 'Mixed@Example.com')`);
            await assert.rejects(sql.unsafe(`INSERT INTO partners (status, applicant_email) VALUES ('applied', 'mixed@example.com')`), /partners_applicant_email_uq|duplicate key/);
        });

        await check("an applicant who already has an account is linked to it straight away", async () => {
            const r = await recordApplication(db, app({ email: 'customer@example.com', name: 'Cass' }), null);
            const [row] = await sql.unsafe(`SELECT user_id FROM partners WHERE id = ${r.partnerId}`);
            assert.strictEqual(row.user_id, 50);
            assert.strictEqual((await recordApplication(db, app({ email: 'other@example.com' }), 50)).outcome, 'duplicate', 'a signed-in partner cannot apply twice');
        });

        let token = '';
        await check('approval of an applicant with no account stores a HASHED one-time link', async () => {
            await sql.unsafe(`UPDATE partners SET status = 'approved' WHERE id = ${jo}`);
            const r = recorder();
            const result = await sendApprovalEmail(db, jo, r.send);
            assert.deepStrictEqual(result, { sent: 'account_link', to: 'jo@example.com' });
            assert.strictEqual(r.sent[0].triggerKey, 'partner_approved_create_account');
            token = new URL(r.sent[0].vars.link.action_url).searchParams.get('partner')!;
            assert.ok(token.length >= 40);
            const [row] = await sql.unsafe(`SELECT invite_token_hash, invite_expires_at FROM partners WHERE id = ${jo}`);
            assert.ok(row.invite_token_hash && row.invite_token_hash !== token, 'only the hash is stored');
            assert.ok(new Date(row.invite_expires_at).getTime() > Date.now() + 13 * 86_400_000);
        });

        await check('the link finds the partner; a wrong, expired or rejected-status link finds nothing', async () => {
            assert.strictEqual((await findPartnerByInviteToken(db, token))?.applicantEmail, 'jo@example.com');
            assert.strictEqual(await findPartnerByInviteToken(db, token.slice(0, -2) + 'xx'), null);
            assert.strictEqual(await findPartnerByInviteToken(db, token, new Date(Date.now() + 15 * 86_400_000)), null, 'expired after 14 days');
            await sql.unsafe(`UPDATE partners SET status = 'suspended' WHERE id = ${jo}`);
            assert.strictEqual(await findPartnerByInviteToken(db, token), null);
            await sql.unsafe(`UPDATE partners SET status = 'approved' WHERE id = ${jo}`);
        });

        await check('claiming links the new account once, spends the link, and gives them a referral code', async () => {
            await sql.unsafe(`INSERT INTO users (id, email, first_name, role) VALUES (60, 'jo@example.com', 'Jo', 'user')`);
            assert.strictEqual(await claimPartnerInvite(db, jo, 60), true);
            assert.strictEqual(await claimPartnerInvite(db, jo, 61), false, 'a second claim does nothing');
            assert.strictEqual(await findPartnerByInviteToken(db, token), null, 'the link is spent');
            const [p] = await sql.unsafe(`SELECT user_id, invite_token_hash FROM partners WHERE id = ${jo}`);
            assert.deepStrictEqual([p.user_id, p.invite_token_hash], [60, null]);
            const [u] = await sql.unsafe(`SELECT referral_code FROM users WHERE id = 60`);
            assert.match(u.referral_code, /^[A-HJ-NP-Z2-9]{8}$/);
        });

        await check('approving someone who already has an account sends a welcome, not a link', async () => {
            const [cass] = await sql.unsafe(`SELECT id FROM partners WHERE user_id = 50`);
            await sql.unsafe(`UPDATE partners SET status = 'approved' WHERE id = ${cass.id}`);
            const r = recorder();
            assert.deepStrictEqual(await sendApprovalEmail(db, cass.id, r.send), { sent: 'welcome', to: 'customer@example.com' });
            assert.strictEqual(r.sent[0].triggerKey, 'partner_approved');
            const [p] = await sql.unsafe(`SELECT invite_token_hash FROM partners WHERE id = ${cass.id}`);
            assert.strictEqual(p.invite_token_hash, null);
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}

/** A stand-in for sendTemplatedEmail that records what would have been sent. */
function recorder() {
    const sent: Array<{ triggerKey: string; to: string; vars?: any }> = [];
    const send = (async (p: { triggerKey: string; to: string; vars?: any }) => { sent.push(p); return null; }) as any;
    return { sent, send };
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
