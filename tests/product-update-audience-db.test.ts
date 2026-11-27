// tests/product-update-audience-db.test.ts
// "Send to" on the What's New email, on REAL Postgres (src/utils/product-update-recipients.ts): the plan groups pick
// owners AND teammates by any workspace's CURRENT plan; all four groups = the old list exactly; unsubscribed, staff,
// unverified, mid-deletion and excluded addresses never get it in any group; the choice is saved before approve and
// read back by the worker; a database without the column still works for "everyone".
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`, no foreign keys) in a throwaway schema, search_path set
// to it. product_update_digests.audience is a raw-SQL column (db/z-product-update-audience.sql), added here.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/product-update-audience-db.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
    countRecipients, countByGroup, recipientPage, readAudience, writeAudience, AudienceError,
} from '../src/utils/product-update-recipients';

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

async function main() {
    console.log("What's New: Send to plan groups (real Postgres)");
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `pu_audience_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['users', 'user_profiles', 'user_organisations', 'plans', 'product_update_digests']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const user = async (email: string, extra: { status?: string; role?: string; pending?: boolean } = {}) =>
            Number((await sql.unsafe(`INSERT INTO users (email, first_name, status, role, pending_deletion) VALUES ($1, 'X', $2, $3, $4) RETURNING id`,
                [email, extra.status ?? 'active', extra.role ?? 'user', extra.pending ?? false]))[0].id);
        const member = (userId: number, orgId: number, role = 'owner') =>
            sql.unsafe(`INSERT INTO user_organisations (user_id, organisation_id, role) VALUES ($1, $2, $3)`, [userId, orgId, role]);
        const plan = (orgId: number, type: string, status = 'active') =>
            sql.unsafe(`INSERT INTO plans (organisation_id, plan_name, plan_type, status) VALUES ($1, 'P', $2, $3)`, [orgId, type, status]);

        // Workspaces: 1 paying, 2 trial, 3 beta, 4 cancelled (no current plan), 5 paying but past_due.
        await plan(1, 'subscription'); await plan(2, 'trial'); await plan(3, 'beta');
        await plan(4, 'subscription', 'cancelled'); await plan(5, 'subscription', 'past_due');
        const payOwner = await user('pay@x.test'); await member(payOwner, 1);
        const payMate = await user('mate@x.test'); await member(payMate, 1, 'member');
        const trialOwner = await user('trial@x.test'); await member(trialOwner, 2);
        const betaOwner = await user('beta@x.test'); await member(betaOwner, 3);
        const cancelled = await user('cancelled@x.test'); await member(cancelled, 4);
        const noWorkspace = await user('nows@x.test');
        const pastDue = await user('pastdue@x.test'); await member(pastDue, 5);
        const twoHats = await user('both@x.test'); await member(twoHats, 2); await member(twoHats, 3, 'member');
        // Never in any group:
        const unsub = await user('unsub@x.test'); await member(unsub, 1);
        await sql.unsafe(`INSERT INTO user_profiles (user_id, email_preferences) VALUES ($1, '{"whats_new": false}'::jsonb)`, [unsub]);
        await member(await user('staff@x.test', { role: 'admin' }), 1);
        await member(await user('unverified@x.test', { status: 'pending_verification' }), 1);
        await member(await user('leaving@x.test', { pending: true }), 1);
        await member(await user('MeFenemer@GoogleMail.com'), 1);

        const ids = async (audience: string[] | null) => (await recipientPage(db, 0, 100, audience)).map(r => r.id).sort((a, b) => a - b);
        const sorted = (...a: number[]) => a.sort((x, y) => x - y);

        await check('Paying = active or past_due subscription workspaces, owners AND teammates', async () => {
            assert.deepEqual(await ids(['paying']), sorted(payOwner, payMate, pastDue));
        });
        await check('Free trial and Beta testers by plan type; one person in both counts in both', async () => {
            assert.deepEqual(await ids(['trial']), sorted(trialOwner, twoHats));
            assert.deepEqual(await ids(['beta']), sorted(betaOwner, twoHats));
            assert.equal(await countRecipients(db, ['trial', 'beta']), 3, 'counted once when ticked twice');
        });
        await check('No plan = cancelled workspaces and people with no workspace at all', async () => {
            assert.deepEqual(await ids(['no_plan']), sorted(cancelled, noWorkspace));
        });
        await check('all four groups = everyone = the list before groups existed', async () => {
            const everyone = sorted(payOwner, payMate, trialOwner, betaOwner, cancelled, noWorkspace, pastDue, twoHats);
            assert.deepEqual(await ids(['paying', 'trial', 'beta', 'no_plan']), everyone);
            assert.deepEqual(await ids(null), everyone);
            assert.equal(await countRecipients(db), everyone.length);
        });
        await check('unsubscribed, staff, unverified, mid-deletion and excluded addresses are in no group', async () => {
            assert.deepEqual(await countByGroup(db), { paying: 3, trial: 2, beta: 2, no_plan: 2 });
        });

        const digest = Number((await sql.unsafe(`INSERT INTO product_update_digests (subject) VALUES ('S') RETURNING id`))[0].id);
        await check('without the audience column: everyone still approves; a narrower choice is refused, not ignored', async () => {
            await writeAudience(db, digest, ['paying', 'trial', 'beta', 'no_plan']);
            assert.equal(await readAudience(db, digest), null);
            await assert.rejects(writeAudience(db, digest, ['beta']), AudienceError);
        });

        // Apply the real migration file (twice — it is idempotent).
        const migration = readFileSync('db/z-product-update-audience.sql', 'utf8');
        await sql.unsafe(migration); await sql.unsafe(migration);
        await check('with the column: the choice is saved, read back in display order, and "everyone" clears it', async () => {
            await writeAudience(db, digest, ['beta', 'trial']);
            assert.deepEqual(await readAudience(db, digest), ['trial', 'beta']);
            await writeAudience(db, digest, ['paying', 'trial', 'beta', 'no_plan']);
            assert.equal(await readAudience(db, digest), null);
        });
        await check('the choice is only written while the email is waiting for review', async () => {
            await sql.unsafe(`UPDATE product_update_digests SET status = 'sending' WHERE id = ${digest}`);
            await writeAudience(db, digest, ['beta']);
            assert.equal(await readAudience(db, digest), null);
        });
        await check('the database refuses unknown or empty groups', async () => {
            await assert.rejects(sql.unsafe(`UPDATE product_update_digests SET audience = ARRAY['vip']::text[] WHERE id = ${digest}`));
            await assert.rejects(sql.unsafe(`UPDATE product_update_digests SET audience = ARRAY[]::text[] WHERE id = ${digest}`));
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} checks passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
