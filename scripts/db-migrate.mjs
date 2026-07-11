#!/usr/bin/env node
// db-migrate.mjs — apply-and-track + audit tool for the hand-applied db/*.sql migrations.
//
// The 70+ db/*.sql files are idempotent and applied MANUALLY (never `drizzle-kit push` — that
// would drop the raw-SQL RLS policies Drizzle can't see). This tool records what has actually
// been applied to a given database in the `schema_migrations` ledger, so prod/staging schema
// state is verifiable instead of remembered.
//
// It deliberately does NOT wrap each file in an outer transaction: ~15 files run their own
// BEGIN/COMMIT. Each file is executed as-is (files own their transactions), then the ledger row
// is written in a separate statement. Files are idempotent, so a mid-file failure just leaves the
// migration PENDING and it is retried next run.
//
// Commands:
//   status                 Read-only. Show APPLIED / PENDING / DRIFTED / ORPHAN for every db/*.sql.
//   apply                  DRY RUN by default — list the pending files it would apply, in order.
//   apply --execute        Actually apply pending files (in order), recording each in the ledger.
//   baseline --execute     Record ALL current files as applied WITHOUT running them. Use only on a
//                          database you have independently confirmed already has every object.
//
// Flags:
//   --execute              Perform writes (required by apply/baseline; without it they dry-run).
//   --only <substr>        Restrict to files whose name contains <substr> (repeatable).
//   --url-var <NAME>       Env var holding the connection string (default: NETLIFY_DATABASE_URL).
//   --include-rls          Also manage db/rls/*.sql (applied AFTER the root files). Off by default.
//   --yes                  Skip the interactive confirmation before an --execute apply.
//
// Env is loaded from .env (via dotenv) exactly like drizzle.config.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_DIR = join(ROOT, 'db');
const RLS_DIR = join(DB_DIR, 'rls');
const TRACKING_DDL = join(DB_DIR, '_migrations-tracking.sql');

loadEnv({ path: join(ROOT, '.env') });

// ── arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
const flags = {
  execute: argv.includes('--execute'),
  includeRls: argv.includes('--include-rls'),
  yes: argv.includes('--yes'),
  only: argv.reduce((acc, a, i) => (a === '--only' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []),
  urlVar: (() => {
    const i = argv.indexOf('--url-var');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : 'NETLIFY_DATABASE_URL';
  })(),
};

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m' };
const paint = (c, s) => `${c}${s}${C.reset}`;

function die(msg) {
  console.error(paint(C.red, `✗ ${msg}`));
  process.exit(1);
}

// ── discover migration files (deterministic order) ───────────────────────────
// Root db/*.sql sorted alphabetically. The tracking-table DDL and anything starting with '_'
// are excluded from the managed set (the tracker applies the DDL itself). If --include-rls,
// db/rls/*.sql are appended AFTER the root files (RLS depends on tables existing).
function discoverFiles() {
  const root = readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort()
    .map((f) => ({ name: f, path: join(DB_DIR, f) }));
  let files = root;
  if (flags.includeRls) {
    const rls = readdirSync(RLS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: `rls/${f}`, path: join(RLS_DIR, f) }));
    files = [...root, ...rls];
  }
  if (flags.only.length) {
    files = files.filter((f) => flags.only.some((s) => f.name.includes(s)));
  }
  return files.map((f) => {
    const contents = readFileSync(f.path, 'utf8');
    return { ...f, contents, checksum: createHash('sha256').update(contents).digest('hex') };
  });
}

async function ensureTracking(sql) {
  const ddl = readFileSync(TRACKING_DDL, 'utf8');
  await sql.unsafe(ddl);
}

async function loadLedger(sql) {
  const rows = await sql`SELECT filename, checksum, applied_at, baselined FROM schema_migrations`;
  return new Map(rows.map((r) => [r.filename, r]));
}

// classify each file against the ledger
function classify(files, ledger) {
  const seen = new Set();
  const result = files.map((f) => {
    const rec = ledger.get(f.name);
    seen.add(f.name);
    if (!rec) return { ...f, state: 'PENDING' };
    if (rec.checksum !== f.checksum) return { ...f, state: 'DRIFTED', appliedAt: rec.applied_at, baselined: rec.baselined };
    return { ...f, state: 'APPLIED', appliedAt: rec.applied_at, baselined: rec.baselined };
  });
  const orphans = [...ledger.keys()].filter((k) => !seen.has(k)); // in DB, not on disk
  return { result, orphans };
}

function connect() {
  const url = process.env[flags.urlVar];
  if (!url) die(`Env var ${flags.urlVar} is not set (checked .env). Pass --url-var <NAME> to override.`);
  return postgres(url, { max: 1, onnotice: () => {} });
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdStatus(sql) {
  await ensureTracking(sql);
  const files = discoverFiles();
  const ledger = await loadLedger(sql);
  const { result, orphans } = classify(files, ledger);

  const counts = { APPLIED: 0, PENDING: 0, DRIFTED: 0 };
  for (const r of result) {
    counts[r.state]++;
    const badge =
      r.state === 'APPLIED' ? paint(C.green, 'APPLIED ')
      : r.state === 'PENDING' ? paint(C.yellow, 'PENDING ')
      : paint(C.red, 'DRIFTED ');
    const when = r.appliedAt ? paint(C.dim, `  ${new Date(r.appliedAt).toISOString().slice(0, 10)}${r.baselined ? ' (baselined)' : ''}`) : '';
    if (r.state !== 'APPLIED') console.log(`  ${badge} ${r.name}${when}`);
  }
  console.log(paint(C.dim, `  (${counts.APPLIED} applied files hidden)`));
  if (orphans.length) {
    console.log(paint(C.cyan, '\n  ORPHAN ledger rows (recorded in DB, file no longer on disk):'));
    orphans.forEach((o) => console.log(`    ${o}`));
  }
  console.log(
    `\n${paint(C.bold, 'Summary:')} ` +
    `${paint(C.green, counts.APPLIED + ' applied')}, ` +
    `${paint(C.yellow, counts.PENDING + ' pending')}, ` +
    `${paint(C.red, counts.DRIFTED + ' drifted')}` +
    (orphans.length ? `, ${paint(C.cyan, orphans.length + ' orphan')}` : '') +
    paint(C.dim, `   [${flags.urlVar}]`),
  );
  if (counts.PENDING || counts.DRIFTED) {
    console.log(paint(C.dim, `\nRun \`node scripts/db-migrate.mjs apply\` for a dry run of the pending files.`));
  }
}

async function cmdApply(sql) {
  await ensureTracking(sql);
  const files = discoverFiles();
  const ledger = await loadLedger(sql);
  const { result } = classify(files, ledger);
  const pending = result.filter((r) => r.state === 'PENDING' || r.state === 'DRIFTED');

  if (!pending.length) {
    console.log(paint(C.green, '✓ Nothing to apply — every managed file is recorded as APPLIED.'));
    return;
  }

  console.log(paint(C.bold, `${pending.length} file(s) to apply (in order):`));
  pending.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.name} ${p.state === 'DRIFTED' ? paint(C.red, '(drifted — will re-run)') : ''}`));

  if (!flags.execute) {
    console.log(paint(C.yellow, `\nDRY RUN — nothing was executed. Re-run with --execute to apply. [${flags.urlVar}]`));
    return;
  }

  if (!flags.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(paint(C.yellow, `\nApply ${pending.length} file(s) to ${flags.urlVar}? Type "apply" to confirm: `));
    rl.close();
    if (answer.trim() !== 'apply') die('Aborted — confirmation not given.');
  }

  const actor = `${userInfo().username}@db-migrate`;
  for (const f of pending) {
    process.stdout.write(`  → ${f.name} … `);
    const t0 = Date.now();
    try {
      await sql.unsafe(f.contents); // file owns its own transaction if it needs one
      const ms = Date.now() - t0;
      await sql`
        INSERT INTO schema_migrations (filename, checksum, applied_by, execution_ms, baselined)
        VALUES (${f.name}, ${f.checksum}, ${actor}, ${ms}, false)
        ON CONFLICT (filename) DO UPDATE
          SET checksum = EXCLUDED.checksum, applied_at = now(),
              applied_by = EXCLUDED.applied_by, execution_ms = EXCLUDED.execution_ms, baselined = false`;
      console.log(paint(C.green, `ok (${ms}ms)`));
    } catch (err) {
      console.log(paint(C.red, 'FAILED'));
      console.error(paint(C.red, `\n✗ ${f.name} failed — halting. No ledger row written for this file.`));
      console.error(paint(C.dim, err.message || String(err)));
      process.exit(1);
    }
  }
  console.log(paint(C.green, `\n✓ Applied ${pending.length} file(s).`));
}

async function cmdBaseline(sql) {
  await ensureTracking(sql);
  const files = discoverFiles();
  const ledger = await loadLedger(sql);
  const { result } = classify(files, ledger);
  const toMark = result.filter((r) => r.state !== 'APPLIED');

  if (!toMark.length) {
    console.log(paint(C.green, '✓ Ledger already reflects every file — nothing to baseline.'));
    return;
  }
  console.log(paint(C.bold, `${toMark.length} file(s) would be recorded as APPLIED *without running them*:`));
  toMark.forEach((f) => console.log(`   ${f.name}`));
  console.log(paint(C.yellow, '\n⚠  Baseline records reality; it does NOT create any objects. Only use this against a'));
  console.log(paint(C.yellow, '   database you have independently confirmed already contains all of these objects.'));

  if (!flags.execute) {
    console.log(paint(C.yellow, `\nDRY RUN — nothing recorded. Re-run with --execute to baseline. [${flags.urlVar}]`));
    return;
  }
  if (!flags.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(paint(C.yellow, `\nBaseline ${toMark.length} file(s) on ${flags.urlVar}? Type "baseline" to confirm: `));
    rl.close();
    if (answer.trim() !== 'baseline') die('Aborted — confirmation not given.');
  }
  const actor = `${userInfo().username}@db-migrate`;
  for (const f of toMark) {
    await sql`
      INSERT INTO schema_migrations (filename, checksum, applied_by, execution_ms, baselined)
      VALUES (${f.name}, ${f.checksum}, ${actor}, 0, true)
      ON CONFLICT (filename) DO UPDATE
        SET checksum = EXCLUDED.checksum, applied_at = now(), applied_by = EXCLUDED.applied_by, baselined = true`;
  }
  console.log(paint(C.green, `\n✓ Baselined ${toMark.length} file(s) as applied.`));
}

// ── main ───────────────────────────────────────────────────────────────────
const sql = connect();
try {
  if (command === 'status') await cmdStatus(sql);
  else if (command === 'apply') await cmdApply(sql);
  else if (command === 'baseline') await cmdBaseline(sql);
  else die(`Unknown command "${command}". Use: status | apply | baseline`);
} catch (err) {
  die(err.message || String(err));
} finally {
  await sql.end({ timeout: 5 });
}
