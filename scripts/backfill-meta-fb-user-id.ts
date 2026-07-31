// scripts/backfill-meta-fb-user-id.ts
//
// Populates metadata.fbUserId on system_connections rows for 'facebook' and 'instagram',
// matching what meta-oauth.ts has written at connect time since 2026-07-31.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// Meta's data-deletion and deauthorize callbacks identify a person by their APP-SCOPED USER ID and
// send nothing else. system_connections.external_user_id holds a Facebook PAGE id (facebook) or an
// Instagram BUSINESS ACCOUNT id (instagram) — Meta never sends either, so there is no way to join a
// callback to a row without the person's own id stored alongside.
//
// meta-callbacks.ts therefore joins on metadata->>'fbUserId'. Rows connected before 2026-07-31 do
// not have it, so a verified deletion callback for those users matches ZERO rows and returns 200
// having deleted nothing — the failure mode is silent, which is exactly why it needs fixing rather
// than waiting to be noticed. (meta-callbacks.ts logs a warning when revoked === 0.)
//
// ── TIME-SENSITIVE ──────────────────────────────────────────────────────────────────────────────
// The only way to learn a row's fbUserId is to ask Graph /me with that row's stored token. Tokens
// are long-lived but capped at 60 days (TOKEN_TTL_DAYS in meta-oauth.ts). Once a row's token has
// expired the mapping is UNRECOVERABLE by any means — the row can never be matched by a deletion
// callback again, and the user would have to reconnect. Run this while the tokens are still alive.
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// DRY RUN BY DEFAULT — resolves every id and prints what it would write, but writes no metadata.
// Pass --apply to commit. Prints the target host and database first: .env in this repo has pointed
// at a stale database before, and "which database am I on" is not a question to answer by assumption.
//
// Idempotent: rows that already carry an fbUserId are skipped, so a re-run after a partial failure
// or a rate-limit stop is safe and cheap.
//
// ⚠️ ONE CAVEAT ON "DRY RUN": reading a token goes through vault.getSecret(), which lazily
// re-encrypts the secret with the current KEK version when the row is on an older one
// (US-DB-1.6.1). That is a write to vault_secrets even in dry-run mode. It changes no plaintext
// and no connection data — it is the same rotation any normal read would have triggered — but it
// is not literally zero-write, and you should know that before pointing this at production.
//
// Usage:
//   npx tsx scripts/backfill-meta-fb-user-id.ts                 # dry run, all rows
//   npx tsx scripts/backfill-meta-fb-user-id.ts --limit=5       # dry run, first 5 (safe first look)
//   npx tsx scripts/backfill-meta-fb-user-id.ts --org=12        # dry run, one organisation
//   npx tsx scripts/backfill-meta-fb-user-id.ts --apply         # write
//   npx tsx scripts/backfill-meta-fb-user-id.ts --apply --include-inactive

import { config } from 'dotenv';
import * as path from 'path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { systemConnections, organisations } from '../db/schema';
import { getSecret } from '../src/utils/vault';

config({ path: path.resolve(process.cwd(), '.env') });

const GRAPH_VERSION = 'v19.0';
/** Meta tolerates bursts, but a backfill has no deadline. Space the calls out. */
const CALL_SPACING_MS = 250;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeInactive = args.includes('--include-inactive');
const onlyOrg = Number(args.find(a => a.startsWith('--org='))?.split('=')[1]) || null;
const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || null;

/** Host + database name of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env.NETLIFY_DATABASE_URL;
    if (!raw) return 'NETLIFY_DATABASE_URL is not set — the script will fail to connect';
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}`;
    } catch {
        return 'unparseable NETLIFY_DATABASE_URL';
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Outcome =
    | { kind: 'resolved'; fbUserId: string }
    | { kind: 'no_vault_ref' }
    | { kind: 'no_secret' }
    | { kind: 'no_token_field'; keys: string[] }
    | { kind: 'token_dead'; message: string; code?: number }
    | { kind: 'graph_error'; message: string }
    | { kind: 'network_error'; message: string };

/**
 * Ask Graph who this token belongs to.
 *
 * The distinction that matters here is dead-token vs everything-else: a dead token means the row is
 * permanently unrecoverable and should be reported as such, while a transient network or rate-limit
 * failure just means "run it again". Conflating them would have the operator writing off rows that
 * were only briefly unreachable.
 */
async function resolveFbUserId(token: string): Promise<Outcome> {
    let res: Response;
    try {
        res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id&access_token=${encodeURIComponent(token)}`);
    } catch (e) {
        return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
    }

    let body: { id?: string; error?: { message?: string; code?: number; type?: string } };
    try {
        body = await res.json() as typeof body;
    } catch {
        return { kind: 'graph_error', message: `non-JSON response (HTTP ${res.status})` };
    }

    if (body.id) return { kind: 'resolved', fbUserId: body.id };

    const err = body.error;
    // 190 = OAuthException "token expired / invalidated / user removed the app". 102 is the
    // session-expiry variant. Either way the grant is gone and no further call will succeed.
    if (err?.code === 190 || err?.code === 102) {
        return { kind: 'token_dead', message: err.message ?? 'token invalid', code: err.code };
    }
    return { kind: 'graph_error', message: err?.message ?? `HTTP ${res.status} with no id and no error` };
}

async function main() {
    console.log('\nMeta connection backfill → metadata.fbUserId');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (writes metadata)' : 'DRY RUN (resolves ids, writes no metadata)'}`);
    console.log(`  scope  : ${onlyOrg ? `organisation ${onlyOrg}` : 'all organisations'}`
        + `${includeInactive ? ', including inactive/revoked rows' : ', active rows only'}`
        + `${limit ? `, first ${limit}` : ''}`);
    if (!apply) console.log('  note   : reading a token may lazily rotate its vault encryption — see the header.');
    console.log('');

    const db = getDb();

    // Only rows genuinely missing the key. `metadata->>'fbUserId' IS NULL` covers a null metadata,
    // a metadata object without the key, and an explicit JSON null alike — all three are "missing".
    const conditions = [
        inArray(systemConnections.serviceName, ['facebook', 'instagram']),
        sql`${systemConnections.metadata}->>'fbUserId' IS NULL`,
    ];
    // A revoked row holds no usable token and, having been revoked, has nothing left to delete.
    // Available behind a flag because a merely 'expired' row may still be worth a try.
    if (!includeInactive) conditions.push(eq(systemConnections.isActive, true));
    if (onlyOrg) conditions.push(eq(systemConnections.organisationId, onlyOrg));

    const rows = await db
        .select({
            id: systemConnections.id,
            organisationId: systemConnections.organisationId,
            serviceName: systemConnections.serviceName,
            externalUserId: systemConnections.externalUserId,
            vaultRefKey: systemConnections.vaultRefKey,
            tokenExpiresAt: systemConnections.tokenExpiresAt,
            status: systemConnections.status,
            metadata: systemConnections.metadata,
            orgName: organisations.name,
        })
        .from(systemConnections)
        .innerJoin(organisations, eq(organisations.id, systemConnections.organisationId))
        .where(and(...conditions))
        .orderBy(systemConnections.id);

    const targets = limit ? rows.slice(0, limit) : rows;

    if (targets.length === 0) {
        console.log('  Nothing to backfill — every matching connection already carries an fbUserId.\n');
        return;
    }

    console.log(`  ${targets.length} connection(s) missing fbUserId\n`);

    let resolved = 0;
    let written = 0;
    // Three buckets, deliberately separate: a dead token is a missed deadline, a row with no token
    // on file never had one to miss, and a retryable failure is not a loss at all. Merging them
    // would either invent urgency or hide it.
    const unrecoverable: string[] = [];
    const noToken: string[] = [];
    const retryable: string[] = [];

    for (const row of targets) {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const label = `#${row.id} ${row.orgName} — ${row.serviceName}`
            + (meta.pageName ? ` (${meta.pageName})` : '')
            + (row.tokenExpiresAt ? ` — token expires ${new Date(row.tokenExpiresAt).toISOString().slice(0, 10)}` : ' — no recorded expiry');

        if (!row.vaultRefKey) {
            // Do NOT report this as "the token expired". A null vault_ref_key means the row never
            // had a token or has already been revoked (revoke-connections.ts nulls the column) —
            // seeded demo tenants look exactly like this. Calling it an expiry would send someone
            // chasing a deadline that does not apply.
            noToken.push(`${label}: no vault_ref_key — revoked already, or seeded without a token`);
            console.log(`  ✗ ${label}\n      no vault_ref_key, nothing to ask Graph with`);
            continue;
        }

        let secret: Record<string, unknown> | null;
        try {
            secret = await getSecret(db, row.vaultRefKey);
        } catch (e) {
            retryable.push(`${label}: vault read failed — ${e instanceof Error ? e.message : e}`);
            console.log(`  ! ${label}\n      vault read failed: ${e instanceof Error ? e.message : e}`);
            continue;
        }

        if (!secret) {
            noToken.push(`${label}: vault ref ${row.vaultRefKey} points at no stored secret`);
            console.log(`  ✗ ${label}\n      vault ref points at nothing`);
            continue;
        }

        // meta-oauth.ts stores { token }, but older writers used { access_token } — accept both
        // rather than silently reporting a live connection as unrecoverable.
        const token = (secret.token ?? secret.access_token) as string | undefined;
        if (typeof token !== 'string' || !token) {
            noToken.push(`${label}: vault payload has no token field (keys: ${Object.keys(secret).join(', ') || 'none'})`);
            console.log(`  ✗ ${label}\n      vault payload carries no token (keys: ${Object.keys(secret).join(', ') || 'none'})`);
            continue;
        }

        const outcome = await resolveFbUserId(token);
        await sleep(CALL_SPACING_MS);

        if (outcome.kind !== 'resolved') {
            const detail =
                outcome.kind === 'token_dead' ? `token dead (code ${outcome.code}): ${outcome.message}`
                : outcome.kind === 'network_error' ? `network error: ${outcome.message}`
                : outcome.kind === 'graph_error' ? `graph error: ${outcome.message}`
                : outcome.kind;
            if (outcome.kind === 'token_dead') {
                unrecoverable.push(`${label}: ${detail}`);
                console.log(`  ✗ ${label}\n      ${detail}`);
            } else {
                retryable.push(`${label}: ${detail}`);
                console.log(`  ! ${label}\n      ${detail} — retryable, re-run the script`);
            }
            continue;
        }

        resolved++;
        console.log(`  ${apply ? '+' : '·'} ${label}\n      fbUserId ${outcome.fbUserId}${apply ? '' : ' (dry run — not written)'}`);

        if (apply) {
            // Merge in SQL rather than writing back the object we read: `||` is atomic and strictly
            // additive, so accountType / fbPageId / igUsername / pageName cannot be clobbered by
            // this write, nor by anything that touched the row since we selected it.
            await db
                .update(systemConnections)
                .set({
                    metadata: sql`coalesce(${systemConnections.metadata}, '{}'::jsonb) || jsonb_build_object('fbUserId', ${outcome.fbUserId}::text)`,
                    updatedAt: new Date(),
                })
                .where(eq(systemConnections.id, row.id));
            written++;
        }
    }

    console.log('\n  ── Summary ────────────────────────────────');
    console.log(`  connections scanned : ${targets.length}`);
    console.log(`  ids resolved        : ${resolved}`);
    console.log(`  ${apply ? 'rows written        ' : 'rows that would write'} : ${apply ? written : resolved}`);
    console.log(`  token dead          : ${unrecoverable.length}`);
    console.log(`  no token on file    : ${noToken.length}`);
    console.log(`  retryable           : ${retryable.length}`);

    if (unrecoverable.length > 0) {
        console.log('\n  ── Token already dead — the deadline was missed for these ──');
        unrecoverable.forEach(u => console.log(`    · ${u}`));
        console.log('\n    These rows can never be matched by a Meta deletion callback. The only fix is');
        console.log('    for the customer to reconnect the account, which writes fbUserId fresh.');
    }
    if (noToken.length > 0) {
        console.log('\n  ── No token on file (nothing was lost here) ──');
        noToken.forEach(u => console.log(`    · ${u}`));
        console.log('\n    Already revoked, or seeded without a token. A revoked connection holds no');
        console.log('    Meta data to delete, so having no fbUserId costs nothing.');
    }
    if (retryable.length > 0) {
        console.log('\n  ── Retryable (transient — just run the script again) ──');
        retryable.forEach(r => console.log(`    · ${r}`));
    }

    if (!apply && resolved > 0) {
        console.log('\n  Dry run — no metadata was written. Re-run with --apply to commit.');
    }
    console.log('');
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nBackfill failed:', err);
        process.exit(1);
    });
