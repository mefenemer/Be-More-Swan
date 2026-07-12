#!/usr/bin/env node
// CI-only: provision the least-privilege app_user role + apply the RLS policies on a
// throwaway Postgres so tests/rls-enforcement.test.ts can actually verify tenant isolation.
// Assumes the base schema already exists (drizzle-kit push has run). NOT for prod/staging —
// those are provisioned by hand per db/rls/00-app-user-role.sql.
//
// Owner connection from NETLIFY_DATABASE_URL; the app_user name/password are read from
// APP_DATABASE_URL so the test and this script stay in lock-step.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ownerUrl = process.env.NETLIFY_DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
if (!ownerUrl || !appUrl) {
    console.error('NETLIFY_DATABASE_URL and APP_DATABASE_URL must both be set.');
    process.exit(1);
}

const parsed = new URL(appUrl);
const appUser = parsed.username;                       // e.g. app_user
const appPass = decodeURIComponent(parsed.password);   // fixed CI value

// Guard: refuse to run against anything that looks like a managed/remote DB. This script
// CREATEs roles and mutates RLS — it must only ever touch the local CI Postgres.
if (!/(localhost|127\.0\.0\.1)/.test(ownerUrl)) {
    console.error('Refusing to run: NETLIFY_DATABASE_URL is not a local CI database.');
    process.exit(1);
}

const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
(async () => {
    try {
        // A freshly CREATE'd role is NOBYPASSRLS by default → subject to RLS (what we want).
        await sql.unsafe(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appUser}') THEN
                CREATE ROLE ${appUser} LOGIN PASSWORD '${appPass}';
            ELSE
                ALTER ROLE ${appUser} LOGIN PASSWORD '${appPass}';
            END IF;
        END $$;`);
        await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
        await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appUser}`);
        await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appUser}`);

        // Enable RLS + the fail-closed tenant_isolation policy on the crown-jewel tables.
        await sql.unsafe(readFileSync(join(root, 'db', 'rls', 'R1-crown-jewels.sql'), 'utf8'));

        // Sanity: the test is meaningless if app_user can bypass RLS.
        const [{ bypass }] = await sql`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = ${appUser}`;
        if (bypass) throw new Error(`${appUser} can bypass RLS — refusing (the RLS test would pass vacuously).`);

        console.log(`✓ Provisioned ${appUser} + RLS policies on the CI database.`);
    } catch (e) {
        console.error('✗ RLS provisioning failed:', e.message);
        process.exit(1);
    } finally {
        await sql.end({ timeout: 5 });
    }
})();
