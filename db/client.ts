// src/db/client.ts
import { config } from 'dotenv';
import * as path from 'path';
import { sql as sqlExpr } from 'drizzle-orm';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { currentEnv, type AppEnv } from '../src/utils/env-context';

// Ensure environment variables are loaded relative to runtime workspace execution
config({ path: path.resolve(process.cwd(), '.env') });

// Connection pool options shared by both roles. postgres-js keeps a single cached
// connection per serverless instance (max: 1); timeouts prevent silent hangs.
const POOL_OPTS = {
    max: 1,
    connect_timeout: 5,   // seconds — abort if DB unreachable within 5s
    idle_timeout: 20,     // seconds — release idle connections between invocations
    max_lifetime: 60 * 5, // seconds — rotate connections every 5 minutes
} as const;

type DrizzleDb = PostgresJsDatabase<Record<string, never>>;

// Epic: Superadmin Environment Management — US3.1 (Database Separation).
// Connections are cached PER ENVIRONMENT so a single warm serverless instance can
// safely serve both live and sandbox requests without cross-contamination. The
// active environment is read from the AsyncLocalStorage context (env-context.ts);
// when no context is set the default is 'live' (AC 3.3).

// Owner connections (neondb_owner) — BYPASS RLS. Used for auth/membership resolution,
// cross-org cron/admin/webhook jobs, and any function not yet routed through withTenant.
const ownerSql: Partial<Record<AppEnv, postgres.Sql>> = {};
const ownerDb: Partial<Record<AppEnv, DrizzleDb>> = {};

// Least-privilege application connections (app_user) — SUBJECT to RLS. Used by withTenant().
const appSql: Partial<Record<AppEnv, postgres.Sql>> = {};
const appDb: Partial<Record<AppEnv, DrizzleDb>> = {};

export const withUpdatedAt = <T extends Record<string, unknown>>(set: T): T & { updatedAt: Date } =>
    ({ ...set, updatedAt: new Date() });

/** Owner (RLS-bypassing) connection string for the given environment. */
function ownerUrl(env: AppEnv): string {
    if (env === 'sandbox') {
        const url = process.env.SANDBOX_DATABASE_URL;
        if (!url) {
            throw new Error('SANDBOX_DATABASE_URL is missing but a sandbox request reached the DB layer.');
        }
        return url;
    }
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) {
        throw new Error('CRITICAL: NETLIFY_DATABASE_URL is missing from environment variables.');
    }
    return url;
}

/** The owner connection string for the active environment — used by purge guards. */
export function currentOwnerUrl(): string {
    return ownerUrl(currentEnv());
}

export function getDb(): DrizzleDb {
    const env = currentEnv();
    if (!ownerDb[env]) {
        // Cache connections globally across serverless function invocations.
        ownerSql[env] = postgres(ownerUrl(env), POOL_OPTS);
        ownerDb[env] = drizzle({ client: ownerSql[env]! });
    }
    return ownerDb[env]!;
}

/**
 * US-DB-1.4.1: the RLS-subject application connection (role `app_user`).
 *
 * Returns a drizzle client bound to the per-environment app connection string. If
 * none is set, it FALLS BACK to the owner connection (getDb()) — so this code is
 * safe to deploy before the app_user role is provisioned: withTenant() simply
 * bypasses RLS (exactly today's behaviour) until the app URL exists, at which point
 * enforcement activates with no code change.
 *   - live    → APP_DATABASE_URL          (fallback: NETLIFY_DATABASE_URL via getDb)
 *   - sandbox → SANDBOX_APP_DATABASE_URL  (fallback: SANDBOX_DATABASE_URL via getDb)
 */
export function getAppDb(): DrizzleDb {
    const env = currentEnv();
    const connectionString = env === 'sandbox'
        ? process.env.SANDBOX_APP_DATABASE_URL
        : process.env.APP_DATABASE_URL;
    if (!connectionString) return getDb(); // not provisioned → owner (bypass)
    if (!appDb[env]) {
        appSql[env] = postgres(connectionString, POOL_OPTS);
        appDb[env] = drizzle({ client: appSql[env]! });
    }
    return appDb[env]!;
}

/**
 * US-DB-1.4.1: run tenant-scoped DB work under Row-Level Security.
 *
 * Executes `fn` on the app_user connection (getAppDb()) inside a transaction that
 * sets the per-request tenant GUC `app.current_org` (transaction-scoped via
 * set_config(..., is_local=true)). Transaction-local is the only concurrency-safe
 * option here because postgres-js keeps a single cached connection (max: 1) — a
 * session-level SET would leak across requests sharing the connection.
 *
 * Once RLS policies are enabled (db/rls/R1-crown-jewels.sql) and APP_DATABASE_URL
 * points at the non-owner app_user role, queries inside `fn` are constrained to
 * `orgId` by the database itself — a defence-in-depth backstop beneath the
 * application-layer guard in src/utils/tenant.ts.
 *
 * Resolve the org with requireTenant()/resolveActiveOrg() on getDb() (owner) FIRST,
 * then wrap the tenant-data queries here. Auth/membership lookups can't run under
 * RLS because they execute before an org is known.
 */
export async function withTenant<T>(orgId: number, fn: (tx: PostgresJsDatabase<Record<string, never>>) => Promise<T>): Promise<T> {
    if (!Number.isInteger(orgId) || orgId <= 0) {
        throw new Error('withTenant requires a valid positive organisation id.');
    }
    return getAppDb().transaction(async (tx) => {
        await tx.execute(sqlExpr`SELECT set_config('app.current_org', ${String(orgId)}, true)`);
        return fn(tx);
    });
}