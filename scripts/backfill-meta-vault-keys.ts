// scripts/backfill-meta-vault-keys.ts
//
// Moves Meta (Facebook / Instagram) connections off the LEGACY org+service vault key and onto the
// account-scoped key buildSocialRefKey() has written since 2026-09-01 (commit f9dcbef).
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The vault ref used to be `aura/org-<id>/<service>-token` — keyed on the organisation and the
// service, but NOT on the account. Every Instagram row in one workspace therefore shared ONE
// secret, and storeSecret() overwrites: connecting a second Instagram account silently destroyed
// the first one's token while leaving its row (and its external_user_id) in place. Publishing then
// paired account A's id with account B's token and Meta answered
// "(#10) Application does not have permission for this action" — which reads as an App Review /
// business-verification problem and sends you to the Meta dashboard rather than to the vault.
//
// The writer is fixed, but readers take the key from system_connections.vault_ref_key, so rows
// written before the fix keep using their old shared key and only move to the new format when the
// customer reconnects. An org still holding two rows on one legacy key stays exposed until then.
// This script does that move for them.
//
// ── What it does, and what it deliberately does not ─────────────────────────────────────────────
// ADDITIVE AND REVERSIBLE. For each row it writes the secret to the NEW key first and only then
// repoints the column, so a crash in between leaves the row on its old, still-valid key. The legacy
// secret is left in place unless you pass --prune, which means every applied change can be undone
// by restoring vault_ref_key alone (the --apply run writes a report file with the exact old values).
//
// ⚠️ A SHARED LEGACY KEY CANNOT BE SPLIT BY COPYING. Where two or more rows point at one legacy
// key, the single stored token belongs to whichever account connected last. Handing that same token
// to both rows would not fix the pairing — it would bless it. So the script ASKS META which
// accounts the token actually reaches (a direct node read of each row's external_user_id) and
// migrates only the rows it genuinely serves. The rest are reported as needing a reconnect, and are
// left completely untouched: no key change, no status change, nothing paused.
//   --no-verify falls back to "newest updated_at wins", for a run with no network to Meta. It is
//   the weaker rule — it assumes the last write to the row was also the last write to the secret.
//
// It does NOT touch status, is_active, scopes or metadata, and never deletes a connection.
//
// ── Read the damage first ───────────────────────────────────────────────────────────────────────
// This is the inventory query. Any (organisation_id, service_name) with count > 1 is an org whose
// rows are sharing one secret right now:
//
//   SELECT organisation_id, service_name, vault_ref_key, count(*) AS rows,
//          array_agg(id ORDER BY updated_at DESC)              AS connection_ids,
//          array_agg(external_user_id ORDER BY updated_at DESC) AS accounts
//   FROM system_connections
//   WHERE service_name IN ('instagram','facebook')
//     AND is_active = true
//     AND vault_ref_key = 'aura/org-' || organisation_id || '/' || service_name || '-token'
//   GROUP BY 1, 2, 3
//   ORDER BY rows DESC, organisation_id;
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// DRY RUN BY DEFAULT — builds the whole plan, verifies against Meta, prints it, writes nothing.
// Pass --apply to commit. Prints the target host and database first: .env in this repo points at
// STAGING, and "which database am I on" is not a question to answer by assumption. Production needs
// an explicit --url-var=<NAME OF THE VARIABLE> (the name, never the URL itself).
//
// Idempotent: a row already on its account-scoped key is skipped, so a re-run after a partial
// failure or a rate-limit stop is safe and cheap.
//
// ⚠️ ONE CAVEAT ON "DRY RUN": reading a secret goes through vault.getSecret(), which lazily
// re-encrypts it under the current KEK version when the row is on an older one (US-DB-1.6.1). That
// is a write to vault_secrets even in dry-run mode. It changes no plaintext and no connection data
// — it is the same rotation any normal read would have triggered — but it is not literally
// zero-write, and you should know that before pointing this at production.
//
// Usage:
//   npx tsx scripts/backfill-meta-vault-keys.ts                           # dry run, staging
//   npx tsx scripts/backfill-meta-vault-keys.ts --org=37                  # dry run, one org
//   npx tsx scripts/backfill-meta-vault-keys.ts --apply                   # write, staging
//   npx tsx scripts/backfill-meta-vault-keys.ts --url-var=DATABASE_URL_PROD
//   npx tsx scripts/backfill-meta-vault-keys.ts --apply --url-var=DATABASE_URL_PROD
//   npx tsx scripts/backfill-meta-vault-keys.ts --apply --prune           # also delete the old secrets
//
// ⚠️ The production variable in THIS repo is `DATABASE_URL_PROD`. Both spellings appear across the
// scripts (see tests/seed-connection.test.ts) and only this one is actually set — an earlier draft
// of these lines said PROD_DATABASE_URL, which is unset and fails at the `--url-var` check.
//
// ⚠️ Reading or writing a secret needs the KEK, which lives in the deploy environment and NOT in
// .env:  export VAULT_KEK_1=$(npx netlify env:get VAULT_KEK_1 --context production)

import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import * as path from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { systemConnections, organisations } from '../db/schema';
import { getSecret, storeSecret, deleteSecret, buildSocialRefKey } from '../src/utils/vault';

config({ path: path.resolve(process.cwd(), '.env') });

const GRAPH_VERSION = 'v19.0';
/** Meta tolerates bursts, but a backfill has no deadline. Space the calls out. */
const CALL_SPACING_MS = 250;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const prune = args.includes('--prune');
const noVerify = args.includes('--no-verify');
const includeInactive = args.includes('--include-inactive');
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const onlyOrg = Number(flag('org')) || null;
const limit = Number(flag('limit')) || null;
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const reportPath = flag('report-out') ?? path.resolve(process.cwd(), 'meta-vault-backfill-report.json');

/** Host + database of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set — the script will fail to connect`;
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}  [${urlVar}]`;
    } catch {
        return `unparseable ${urlVar}`;
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── The plan (pure — unit-tested in tests/meta-vault-backfill.test.ts) ──────────────────────────

export type ConnRow = {
    id: number;
    organisationId: number;
    serviceName: string;
    externalUserId: string | null;
    vaultRefKey: string | null;
    updatedAt: Date | string | null;
};

/** The key the writer used before 2026-09-01: org + service, no account. */
export function legacyKeyFor(organisationId: number, serviceName: string): string {
    return `aura/org-${organisationId}/${serviceName}-token`;
}

export type PlanAction =
    /** Sole owner of its legacy key — the secret is unambiguously this row's. */
    | 'migrate'
    /** Shares its legacy key with another row; which account the secret belongs to must be proven. */
    | 'contested'
    /** Already on the account-scoped key. */
    | 'current'
    /** No vault_ref_key (revoked, or seeded without a token) — nothing to move. */
    | 'no_key'
    /** No external_user_id, so no account-scoped key can be built for it. */
    | 'no_account'
    /** A key in neither the legacy nor the current shape — left alone, reported for a human. */
    | 'unrecognised';

export type PlanEntry = {
    row: ConnRow;
    action: PlanAction;
    fromKey: string | null;
    toKey: string | null;
    /** How many rows share this legacy key. 1 for everything that is not contested. */
    sharedWith: number;
    /** Contested only: this row is the most recently updated of the group. */
    newestOfGroup: boolean;
};

/**
 * Classify every row, and work out which of them are fighting over one secret.
 *
 * Grouping is on the STORED key, not on (org, service): a group is by definition the set of rows
 * that would read the same secret, which is exactly the thing that has to be resolved before a
 * token can be copied anywhere.
 */
export function planBackfill(rows: ConnRow[]): PlanEntry[] {
    const sharers = new Map<string, ConnRow[]>();
    for (const row of rows) {
        if (!row.vaultRefKey) continue;
        if (row.vaultRefKey !== legacyKeyFor(row.organisationId, row.serviceName)) continue;
        const group = sharers.get(row.vaultRefKey) ?? [];
        group.push(row);
        sharers.set(row.vaultRefKey, group);
    }

    const time = (r: ConnRow) => (r.updatedAt ? new Date(r.updatedAt).getTime() : 0);
    const newestId = new Map<string, number>();
    for (const [key, group] of sharers) {
        // Ties broken by id so the choice is deterministic — two rows CAN carry the same
        // updated_at, and a plan that changes between a dry run and the apply is worse than useless.
        const newest = [...group].sort((a, b) => time(b) - time(a) || b.id - a.id)[0];
        newestId.set(key, newest.id);
    }

    return rows.map((row): PlanEntry => {
        const base = { row, sharedWith: 1, newestOfGroup: false };
        if (!row.vaultRefKey) return { ...base, action: 'no_key', fromKey: null, toKey: null };
        if (!row.externalUserId) return { ...base, action: 'no_account', fromKey: row.vaultRefKey, toKey: null };

        const current = buildSocialRefKey(row.organisationId, row.serviceName, row.externalUserId);
        if (row.vaultRefKey === current) return { ...base, action: 'current', fromKey: row.vaultRefKey, toKey: current };

        const group = sharers.get(row.vaultRefKey);
        if (!group) return { ...base, action: 'unrecognised', fromKey: row.vaultRefKey, toKey: current };

        return {
            row,
            action: group.length > 1 ? 'contested' : 'migrate',
            fromKey: row.vaultRefKey,
            toKey: current,
            sharedWith: group.length,
            newestOfGroup: newestId.get(row.vaultRefKey) === row.id,
        };
    });
}

// ── Vault key material ──────────────────────────────────────────────────────────────────────────
// The KEKs live in the deploy's environment, not in .env, so running this script against prod from
// a laptop needs VAULT_KEK_<version> exported alongside the database URL. Getting that wrong is a
// CONFIGURATION fault, not a transient one: every row fails identically and re-running changes
// nothing, so it must stop the run rather than fill a "retryable" list with the same line.

/** True when a vault failure is missing/blank key material rather than a per-row problem. */
export function isVaultConfigError(message: string): boolean {
    return /VAULT_KEK|VAULT_KEY/.test(message) && /(missing|not 64 hex)/i.test(message);
}

/** The KEK version vault.ts will encrypt with, and read most rows under. */
function currentKekVersion(): number {
    return parseInt(process.env.VAULT_KEK_VERSION || '1', 10);
}

/** Is key material present for a version? Mirrors vault.ts getKekByVersion, without importing it. */
function hasKek(version: number): boolean {
    const hex = process.env[`VAULT_KEK_${version}`] ?? (version === 1 ? process.env.VAULT_KEK : undefined);
    return typeof hex === 'string' && hex.length === 64;
}

/**
 * The variable a vault failure is actually complaining about. Rows written before the KEK/DEK
 * migration carry no encryptedDek and fall back to VAULT_KEY, so naming VAULT_KEK_<n> at someone
 * exporting the wrong secret would be a second wasted round trip.
 */
export function missingVaultVar(message: string): string | null {
    return message.match(/VAULT_KEK_\d+|VAULT_KEK|VAULT_KEY/)?.[0] ?? null;
}

/** What to tell an operator whose environment cannot decrypt anything. Never prints key material. */
function kekAdvice(varName: string): string {
    return [
        `  The vault cannot be read: ${varName} is not set in this shell (or is not 64 hex chars).`,
        '  Nothing was read and nothing was written.',
        '',
        '  The KEKs live in the deploy environment, not in .env. Export the one this database was',
        '  encrypted with — via command substitution, so the value never lands in your scrollback:',
        '',
        `    export ${varName}=$(npx netlify env:get ${varName} --context production)`,
        '',
        '  Then re-run the same command. VAULT_KEK_VERSION selects the version used for new writes',
        '  (unset means 1); a row written under an older KEK needs that version exported too, and a',
        '  row predating the KEK/DEK migration needs the legacy VAULT_KEY.',
    ].join('\n');
}

// ── Proving which account a contested token actually serves ─────────────────────────────────────
//
// ⚠️ A Graph error is NOT evidence of ownership until you have read its code. The whole incident
// this script exists for began with `(#10) Application does not have permission for this action`
// being read as an App Review problem when it was a token/account mismatch — and the first prod
// dry run made the mirror-image mistake, reporting `API access blocked.` as "this token does not
// reach this account" when that message says nothing about ownership at all.
//
// Exactly ONE Graph verdict means "this token cannot see this object": code 100 with subcode 33
// (and its alias-flavoured cousin 803). Everything else — app-level blocks, permission gaps,
// rate limits, transient failures — is INCONCLUSIVE, and an inconclusive probe must never be
// reported as "the customer must reconnect".

export type GraphErrorVerdict = 'token_dead' | 'out_of_reach' | 'rate_limited' | 'inconclusive';

/** What a Graph error actually tells us about this token's relationship to this object. */
export function classifyGraphError(err: { code?: number; error_subcode?: number; message?: string } | undefined): GraphErrorVerdict {
    if (!err) return 'inconclusive';
    // 190 / 102: the grant itself is gone. Not "belongs to another account" — the token is dead.
    if (err.code === 190 || err.code === 102) return 'token_dead';
    // 100/33: "object does not exist, cannot be loaded due to missing permissions, or does not
    // support this operation" — the one answer that distinguishes accounts. 803 is the same idea
    // for an alias. A bare 100 is a malformed request, which says nothing about access.
    if (err.code === 803) return 'out_of_reach';
    if (err.code === 100 && err.error_subcode === 33) return 'out_of_reach';
    // 4 / 17 / 32 / 613: throttling. 1 / 2: transient Graph faults. Try again later.
    if ([4, 17, 32, 613, 1, 2].includes(err.code ?? -1)) return 'rate_limited';
    return 'inconclusive';
}

export function describeGraphError(err: { code?: number; error_subcode?: number; type?: string; message?: string } | undefined, status: number): string {
    if (!err) return `HTTP ${status} with no id and no error`;
    const bits = [err.code !== undefined ? `code ${err.code}` : null, err.error_subcode !== undefined ? `subcode ${err.error_subcode}` : null, err.type ?? null]
        .filter(Boolean).join(', ');
    return `${err.message ?? 'no message'}${bits ? ` (${bits})` : ''}`;
}

type Reach =
    | { kind: 'reaches'; via: string }
    /** PROVEN to belong elsewhere: Graph says the object is invisible to this token. */
    | { kind: 'out_of_reach'; message: string }
    /** Graph refused for a reason unrelated to ownership. Proves nothing either way. */
    | { kind: 'inconclusive'; message: string }
    | { kind: 'token_dead'; message: string }
    | { kind: 'network_error'; message: string };

type GraphBody = {
    id?: string;
    data?: Array<{ id?: string; instagram_business_account?: { id?: string } }>;
    error?: { message?: string; code?: number; error_subcode?: number; type?: string };
};

async function graphGet(pathAndQuery: string, token: string): Promise<{ body: GraphBody; status: number } | { networkError: string }> {
    try {
        const sep = pathAndQuery.includes('?') ? '&' : '?';
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`);
        try {
            return { body: await res.json() as GraphBody, status: res.status };
        } catch {
            return { networkError: `non-JSON response (HTTP ${res.status})` };
        }
    } catch (e) {
        return { networkError: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Can this token read this account?
 *
 * Two questions, cheapest and most authoritative first:
 *   1. /me/accounts — the same list meta-oauth.ts connects from. A hit here is positive proof.
 *   2. a direct node read — a Page owned by a Business portfolio never appears in /me/accounts (the
 *      reason meta-oauth.ts needs its business fallback), so its absence above is not an answer.
 * Only if BOTH come back with a genuine 100/33 is the account proven to be someone else's.
 */
async function tokenReaches(externalUserId: string, token: string): Promise<Reach> {
    const listed = await graphGet('me/accounts?fields=id,instagram_business_account{id}&limit=100', token);
    if ('networkError' in listed) return { kind: 'network_error', message: listed.networkError };
    if (listed.body.data?.some(p => p.id === externalUserId || p.instagram_business_account?.id === externalUserId)) {
        return { kind: 'reaches', via: '/me/accounts' };
    }
    // A failed listing is not a negative answer — fall through to the direct read and let that
    // decide, but keep the reason so an inconclusive verdict can explain itself.
    const listError = listed.body.error ? describeGraphError(listed.body.error, listed.status) : null;
    const listVerdict = listed.body.error ? classifyGraphError(listed.body.error) : null;
    if (listVerdict === 'token_dead') return { kind: 'token_dead', message: listError! };
    if (listVerdict === 'rate_limited') return { kind: 'network_error', message: `${listError} — throttled` };

    const node = await graphGet(`${encodeURIComponent(externalUserId)}?fields=id`, token);
    if ('networkError' in node) return { kind: 'network_error', message: node.networkError };
    if (node.body.id === externalUserId) return { kind: 'reaches', via: 'direct node read' };

    const detail = describeGraphError(node.body.error, node.status) + (listError ? `; /me/accounts said: ${listError}` : '');
    switch (classifyGraphError(node.body.error)) {
        case 'token_dead':    return { kind: 'token_dead', message: detail };
        case 'rate_limited':  return { kind: 'network_error', message: `${detail} — throttled` };
        case 'out_of_reach':  return { kind: 'out_of_reach', message: detail };
        default:              return { kind: 'inconclusive', message: detail };
    }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

type Applied = { connectionId: number; organisationId: number; serviceName: string; account: string; fromKey: string; toKey: string };

async function main() {
    // getDb() reads NETLIFY_DATABASE_URL. Pointing it elsewhere is what makes --url-var work at all;
    // done before the first call so no connection is ever opened against the default.
    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) {
            console.error(`\n${urlVar} is not set. Export it, or drop --url-var to use NETLIFY_DATABASE_URL.\n`);
            process.exit(1);
        }
        process.env.NETLIFY_DATABASE_URL = override;
    }

    console.log('\nMeta vault keys → account-scoped (buildSocialRefKey)');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (writes vault secrets + vault_ref_key)' : 'DRY RUN (plans only, writes no key)'}`);
    console.log(`  scope  : ${onlyOrg ? `organisation ${onlyOrg}` : 'all organisations'}`
        + `${includeInactive ? ', including inactive rows' : ', active rows only'}`
        + `${limit ? `, first ${limit}` : ''}`);
    console.log(`  shared : ${noVerify ? 'newest updated_at wins (NO Meta verification)' : 'verified against Meta before any copy'}`);
    console.log(`  legacy : ${prune ? 'DELETED once every row on it has moved' : 'left in place (orphaned but harmless)'}`);
    if (!apply) console.log('  note   : reading a secret may lazily rotate its vault encryption — see the header.');
    console.log('');

    // Before touching a row: without key material every read fails identically, and the run would
    // otherwise report five copies of one configuration problem as five retryable row failures.
    if (!hasKek(currentKekVersion())) {
        console.error(kekAdvice(`VAULT_KEK_${currentKekVersion()}`));
        console.error('');
        process.exit(1);
    }

    const db = getDb();

    const conditions = [inArray(systemConnections.serviceName, ['facebook', 'instagram'])];
    if (!includeInactive) conditions.push(eq(systemConnections.isActive, true));
    if (onlyOrg) conditions.push(eq(systemConnections.organisationId, onlyOrg));

    const rows = await db
        .select({
            id: systemConnections.id,
            organisationId: systemConnections.organisationId,
            serviceName: systemConnections.serviceName,
            externalUserId: systemConnections.externalUserId,
            vaultRefKey: systemConnections.vaultRefKey,
            updatedAt: systemConnections.updatedAt,
            status: systemConnections.status,
            metadata: systemConnections.metadata,
            orgName: organisations.name,
        })
        .from(systemConnections)
        .innerJoin(organisations, eq(organisations.id, systemConnections.organisationId))
        .where(and(...conditions))
        .orderBy(systemConnections.organisationId, systemConnections.id);

    // The plan is built over ALL rows so a group is never split by --limit: knowing a key is shared
    // depends on seeing every row that points at it.
    const plan = planBackfill(rows);
    const byId = new Map(rows.map(r => [r.id, r]));
    const label = (id: number) => {
        const r = byId.get(id)!;
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const who = meta.igUsername ? `@${meta.igUsername}` : meta.pageName ? String(meta.pageName) : (r.externalUserId ?? 'no account id');
        return `#${r.id} ${r.orgName} — ${r.serviceName} ${who}`;
    };

    const movable = plan.filter(p => p.action === 'migrate');
    const contested = plan.filter(p => p.action === 'contested');
    const targets = limit ? [...movable, ...contested].slice(0, limit) : [...movable, ...contested];

    for (const kind of ['current', 'no_key', 'no_account', 'unrecognised'] as const) {
        const found = plan.filter(p => p.action === kind);
        if (!found.length) continue;
        const note = kind === 'current' ? 'already account-scoped — nothing to do'
            : kind === 'no_key' ? 'no vault_ref_key (revoked, or seeded without a token)'
            : kind === 'no_account' ? 'no external_user_id — cannot build an account-scoped key'
            : 'vault_ref_key is in neither the legacy nor the current shape — left alone';
        console.log(`  ${found.length} row(s): ${note}`);
        if (kind === 'unrecognised' || kind === 'no_account') found.forEach(p => console.log(`      · ${label(p.row.id)} → ${p.fromKey}`));
    }
    console.log('');

    if (targets.length === 0) {
        console.log('  Nothing on a legacy key. Every Meta connection in scope is already account-scoped.\n');
        return;
    }

    console.log(`  ${movable.length} row(s) sole-owner of a legacy key, ${contested.length} row(s) sharing one\n`);

    // ── Attribution without Graph ───────────────────────────────────────────────────────────────
    // Printed BEFORE any write: it is the evidence for what the run is about to do, and under
    // --no-verify it is the ONLY evidence there is. When Graph will not answer, the rows can still
    // testify: meta-oauth.ts vaults the token and upserts the row in the SAME request, so the most
    // recently updated row of a contested group is
    // the one whose connect last overwrote the shared secret. If that row's metadata.fbUserId
    // differs from a sibling's, the sibling's own token is definitively gone — no Graph needed.
    //
    // ⚠️ This is STRONGER than the Graph probe when the API refuses to answer, which on prod
    // 2026-09-02 it did (`API access blocked. code 200`) for every token tried.
    if (contested.length > 0) {
        const contestedRows = contested;
        const groups = new Map<string, typeof contestedRows>();
        for (const p of contestedRows) groups.set(p.fromKey!, [...(groups.get(p.fromKey!) ?? []), p]);
        const fbUserOf = (id: number) => ((byId.get(id)!.metadata ?? {}) as Record<string, unknown>).fbUserId as string | undefined ?? null;

        for (const [key, group] of groups) {
            const owner = group.find(p => p.newestOfGroup);
            if (!owner) continue;
            const ownerUser = fbUserOf(owner.row.id);
            const displaced = group.filter(p => !p.newestOfGroup && fbUserOf(p.row.id) && fbUserOf(p.row.id) !== ownerUser);
            if (!ownerUser || displaced.length === 0) continue;

            console.log('\n  ── Attribution from the rows themselves (no Graph needed) ──');
            console.log(`  ${key}`);
            console.log(`  Last written by ${label(owner.row.id)} (${new Date(owner.row.updatedAt!).toISOString().slice(0, 10)}, Meta user ${ownerUser}).`);
            for (const d of displaced) {
                console.log(`  ${label(d.row.id)} was connected by a DIFFERENT Meta user (${fbUserOf(d.row.id)}), so the`);
                console.log('  stored token cannot be its own: its token was destroyed by the later connect.');
            }
            console.log('  This rests on the writer\'s ordering (token then row, one request), not on Graph, so it');
            console.log('  holds while the API is blocked. --no-verify applies exactly this rule.');
        }
    }

    const applied: Applied[] = [];
    const needReconnect: string[] = [];
    /** Contested rows Graph would neither confirm nor deny. NOT a customer action — see the control probe. */
    const unproven: string[] = [];
    /**
     * Sole-owner rows whose pairing is unambiguous by construction — the pool the control probe is
     * drawn from. Kept as a list rather than the first hit so the control can be chosen to VARY the
     * thing under suspicion: a control in the same org (and so probably the same Facebook user) as
     * the failing rows cannot tell an app-wide block apart from one person's restricted grant.
     */
    const controls: Array<{ name: string; externalUserId: string; token: string; organisationId: number; fbUserId: string | null }> = [];
    /** Who the unanswered rows belong to, so the control can be picked from somewhere else. */
    const unansweredOwners: Array<{ organisationId: number; fbUserId: string | null }> = [];
    const retryable: string[] = [];
    const skipped: string[] = [];
    /** Legacy keys where every sharing row has moved — the only ones --prune may delete. */
    const groupsMoved = new Map<string, { total: number; moved: number }>();
    for (const p of [...movable, ...contested]) {
        const g = groupsMoved.get(p.fromKey!) ?? { total: 0, moved: 0 };
        g.total++;
        groupsMoved.set(p.fromKey!, g);
    }

    for (const entry of targets) {
        const row = byId.get(entry.row.id)!;
        const name = label(row.id);

        let secret: Record<string, unknown> | null;
        try {
            secret = await getSecret(db, entry.fromKey!);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // A key-material failure is not this row's problem and will not fix itself on a re-run.
            // Stop on the first one: the rest of the loop can only repeat it.
            if (isVaultConfigError(message)) {
                console.error(`\n  ✗ ${name}\n      ${message}\n`);
                console.error(kekAdvice(missingVaultVar(message) ?? `VAULT_KEK_${currentKekVersion()}`));
                console.error('');
                process.exit(1);
            }
            retryable.push(`${name}: vault read failed — ${message}`);
            console.log(`  ! ${name}\n      vault read failed: ${message}`);
            continue;
        }
        if (!secret) {
            skipped.push(`${name}: ${entry.fromKey} points at no stored secret`);
            console.log(`  ✗ ${name}\n      legacy key points at nothing — reconnect is the only fix`);
            continue;
        }

        // meta-oauth.ts stores { token }; older writers used { access_token }. Accept both.
        const token = (secret.token ?? secret.access_token) as string | undefined;
        if (typeof token !== 'string' || !token) {
            skipped.push(`${name}: vault payload has no token field (keys: ${Object.keys(secret).join(', ') || 'none'})`);
            console.log(`  ✗ ${name}\n      vault payload carries no token`);
            continue;
        }

        // Verified before the copy — `migrate` INCLUDED.
        //
        // ⚠️ "Sole owner of its legacy key" does NOT establish that the secret is this row's. The
        // legacy writer OVERWROTE, so a key can be shared ACROSS TIME by an account that never got
        // a row of its own: a reconnect under a different account replaces the secret and leaves
        // this row's external_user_id pointing at the old one. Copying that unverified BLESSES the
        // wrong token onto a correct-looking account-scoped key.
        //
        // That is exactly what this script did to org 37 on 2026-09-02: both rows came out active,
        // account-scoped, all 9 scopes granted — and holding a token that reached neither account.
        // The failure surfaced days later as "(#200) publish_actions" and "Object … does not
        // exist", and every later dry run reported "already account-scoped — nothing to do".
        if (entry.action === 'contested' || entry.action === 'migrate') {
            if (noVerify) {
                if (!entry.newestOfGroup) {
                    needReconnect.push(`${name}: shares ${entry.fromKey} with ${entry.sharedWith - 1} other row(s) and is not the newest — the later connect overwrote its token`);
                    console.log(`  ✗ ${name}\n      shared key, not the newest row — the later connect overwrote its token; left alone`);
                    continue;
                }
            } else {
                const reach = await tokenReaches(row.externalUserId!, token);
                await sleep(CALL_SPACING_MS);
                if (reach.kind === 'out_of_reach') {
                    needReconnect.push(`${name}: PROVEN out of reach — ${reach.message}`);
                    unansweredOwners.push({ organisationId: row.organisationId, fbUserId: ((row.metadata ?? {}) as Record<string, unknown>).fbUserId as string | undefined ?? null });
                    console.log(`  ✗ ${name}\n      the stored token cannot see this account: ${reach.message}`);
                    continue;
                }
                if (reach.kind === 'inconclusive') {
                    // Graph refused for a reason that says nothing about ownership. Reporting this
                    // as "reconnect" would send a customer to fix an account that may be perfectly
                    // fine — the first prod run did exactly that with `API access blocked.`
                    unproven.push(`${name}: ${reach.message}`);
                    unansweredOwners.push({ organisationId: row.organisationId, fbUserId: ((row.metadata ?? {}) as Record<string, unknown>).fbUserId as string | undefined ?? null });
                    console.log(`  ? ${name}\n      Graph would not answer: ${reach.message}\n      → NOT a reconnect. Nothing proven either way; row untouched.`);
                    continue;
                }
                if (reach.kind === 'token_dead') {
                    needReconnect.push(`${name}: stored token is dead — ${reach.message}`);
                    console.log(`  ✗ ${name}\n      stored token is dead — every row on this key needs a reconnect: ${reach.message}`);
                    continue;
                }
                if (reach.kind === 'network_error') {
                    retryable.push(`${name}: ${reach.message}`);
                    console.log(`  ! ${name}\n      ${reach.message} — retryable, re-run the script`);
                    continue;
                }
            }
        }

        if (entry.action === 'migrate' && row.externalUserId) {
            controls.push({ name, externalUserId: row.externalUserId, token, organisationId: row.organisationId, fbUserId: ((row.metadata ?? {}) as Record<string, unknown>).fbUserId as string | undefined ?? null });
        }

        console.log(`  ${apply ? '+' : '·'} ${name}`);
        console.log(`      ${entry.fromKey}\n   →  ${entry.toKey}${apply ? '' : '   (dry run — not written)'}`);

        if (apply) {
            // Order matters. The new secret is written FIRST: a crash before the column moves
            // leaves the row on its old, still-valid key, which is a no-op to re-run. The reverse
            // order would leave a row pointing at a key that holds nothing.
            await storeSecret(db, entry.toKey!, secret);
            await db
                .update(systemConnections)
                .set({ vaultRefKey: entry.toKey!, updatedAt: new Date() })
                .where(eq(systemConnections.id, row.id));
            applied.push({
                connectionId: row.id,
                organisationId: row.organisationId,
                serviceName: row.serviceName,
                account: row.externalUserId!,
                fromKey: entry.fromKey!,
                toKey: entry.toKey!,
            });
        }
        const g = groupsMoved.get(entry.fromKey!)!;
        g.moved++;
    }

    // ── The control ─────────────────────────────────────────────────────────────────────────────
    // A negative probe is only evidence if the probe works. Every contested row failing the same way
    // is what an app-level block looks like, and it is indistinguishable from a real ownership
    // answer unless something KNOWN-GOOD is asked the same question. So ask one: a sole-owner row,
    // whose token/account pairing is unambiguous by construction.
    //
    // ⚠️ WHAT THE CONTROL VARIES IS THE ONLY THING IT CAN RULE OUT, and the two dimensions are not
    // the same. A control in another ORGANISATION whose connection was made by the SAME Meta person
    // (`metadata.fbUserId`) shares that person's grant, so it cannot tell an app-wide block from a
    // restriction on that one account — and saying otherwise was exactly the overstatement this
    // whole thread is about. On prod, four of five Meta rows carry ONE fbUserId across two orgs, so
    // this is the normal case here, not a corner one.
    if (!noVerify && (needReconnect.length > 0 || unproven.length > 0) && controls.length > 0) {
        const badOrgs = new Set(unansweredOwners.map(o => o.organisationId));
        const badUsers = new Set(unansweredOwners.map(o => o.fbUserId).filter(Boolean));
        const differsInBoth = controls.find(c => !badOrgs.has(c.organisationId) && c.fbUserId && !badUsers.has(c.fbUserId));
        const differsInUser = controls.find(c => c.fbUserId && !badUsers.has(c.fbUserId));
        const differsInOrg = controls.find(c => !badOrgs.has(c.organisationId));
        const control = differsInBoth ?? differsInUser ?? differsInOrg ?? controls[0];
        const newUser = Boolean(control.fbUserId && !badUsers.has(control.fbUserId));
        const newOrg = !badOrgs.has(control.organisationId);
        const varies = newUser && newOrg ? `a different organisation (${control.organisationId}) AND a different Meta user`
            : newUser ? 'a different Meta user, same organisation'
            : newOrg ? `a different organisation (${control.organisationId}) but the SAME Meta user (${control.fbUserId ?? 'unknown'})`
            : 'the same organisation and the same Meta user — nothing else was available';

        const check = await tokenReaches(control.externalUserId, control.token);
        console.log('\n  ── Control probe ──────────────────────────');
        console.log(`  ${control.name}`);
        console.log(`  sole owner (pairing known good), varying: ${varies}`);
        if (check.kind === 'reaches') {
            console.log(`  ✓ reachable via ${check.via}. The probe works here, so the failures above are about`);
            console.log('    those accounts or their own grant — not about the app as a whole.');
        } else {
            console.log(`  ✗ ${check.kind}: ${check.message}`);
            console.log('  ⚠️  A KNOWN-GOOD pairing failed the SAME way, so the failures above are NOT evidence');
            console.log('      about ownership. What that does and does not establish:');
            if (newUser && newOrg) {
                console.log('      · Two independent grants, two organisations, two Meta users, all refused →');
                console.log('        the block is APP-WIDE. Every Meta call this app makes is affected, publishing');
                console.log('        included. Check the app\'s status and alerts in the Meta dashboard first.');
            } else if (newOrg) {
                console.log(`      · Established: it is not specific to one workspace — org ${control.organisationId} fails too.`);
                console.log(`      · NOT established: app-wide. Every token tried belongs to Meta user`);
                console.log(`        ${control.fbUserId ?? 'unknown'}, so a restriction on that ONE person explains everything`);
                console.log('        seen here just as well. Find a connection made by a different Meta person and');
                console.log('        probe that before blaming the app.');
            } else {
                console.log('      · Nothing is separated yet: the control shares this run\'s organisation and user.');
                console.log('        Re-run with --include-inactive, or probe a connection made by someone else.');
            }
            console.log('      Either way: do NOT ask anyone to reconnect on the strength of this run.');
        }
    }

    if (apply && prune) {
        for (const [key, g] of groupsMoved) {
            if (g.moved !== g.total || g.total === 0) continue;
            await deleteSecret(db, key);
            console.log(`  − pruned legacy secret ${key}`);
        }
    }

    console.log('\n  ── Summary ────────────────────────────────');
    console.log(`  rows considered        : ${targets.length}`);
    console.log(`  ${apply ? 'keys moved             ' : 'keys that would move   '}: ${apply ? applied.length : targets.length - needReconnect.length - unproven.length - retryable.length - skipped.length}`);
    console.log(`  need a reconnect       : ${needReconnect.length}`);
    console.log(`  unproven (see control) : ${unproven.length}`);
    console.log(`  no usable secret       : ${skipped.length}`);
    console.log(`  retryable              : ${retryable.length}`);

    if (needReconnect.length > 0) {
        console.log('\n  ── Cannot be fixed here — the customer must reconnect ──');
        needReconnect.forEach(u => console.log(`    · ${u}`));
        console.log('\n    These rows shared a secret with another account and their own token is gone.');
        console.log('    Reconnecting writes a fresh account-scoped key; the account picker added on');
        console.log('    2026-09-02 lets them pick the right account while they are in there.');
        console.log('    Nothing was changed for these rows — no key, no status, nothing paused.');
    }
    if (unproven.length > 0) {
        console.log('\n  ── Graph would not answer — nothing proven, nothing changed ──');
        unproven.forEach(u => console.log(`    · ${u}`));
        console.log('\n    These rows still share a secret, and this run could not establish who owns it.');
        console.log('    Read the control probe above before acting: only ONE Graph verdict actually means');
        console.log('    "this token cannot see this account" (code 100 / subcode 33). Anything else is a');
        console.log('    question about the app or the permissions, not about the accounts.');
    }
    if (skipped.length > 0) {
        console.log('\n  ── No usable secret on file ──');
        skipped.forEach(u => console.log(`    · ${u}`));
    }
    if (retryable.length > 0) {
        console.log('\n  ── Retryable (transient — just run the script again) ──');
        retryable.forEach(r => console.log(`    · ${r}`));
    }

    if (apply && applied.length > 0) {
        writeFileSync(reportPath, JSON.stringify({ ranAt: new Date().toISOString(), target: describeTarget(), applied }, null, 2));
        console.log(`\n  Report written to ${reportPath}`);
        console.log('  It is also the rollback: restoring each row\'s fromKey undoes this run, and the');
        console.log(`  legacy secrets ${prune ? 'were PRUNED, so a rollback needs the new keys to stay in place' : 'are still in the vault'}.`);
    }
    if (!apply) console.log('\n  Dry run — nothing was written. Re-run with --apply to commit.');
    console.log('');
}

// Only run when invoked directly: the plan above is imported by tests.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
    main()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('\nBackfill failed:', err);
            process.exit(1);
        });
}
