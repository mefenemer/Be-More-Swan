// tests/raw-sql-date-params.test.ts
// A JS Date must never be interpolated into a db.execute(sql`...`) template on postgres-js.
//
// This is the bug that took down "Talk it through in chat" for every user. The driver binds
// template values as-is, and its prepared-statement Bind step writes each one with
// Buffer.byteLength — which throws:
//
//   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string or an instance
//   of Buffer or ArrayBuffer. Received an instance of Date
//
// The statement never reaches Postgres, so there is no SQLSTATE and nothing is wrong with the
// schema. drizzle rethrows it wrapped as `Failed query: UPDATE usage_counters ...`, which reads
// exactly like a database fault — it was misdiagnosed three times from that string alone (as a
// missing table, then as schema drift, then as a jsonb type problem) before anyone read err.cause.
//
// Queries built with the drizzle QUERY BUILDER are safe: the column's own mapToDriverValue converts
// the Date first. Only hand-written sql`` templates bypass that, which is why this is a lint rather
// than a type: TypeScript cannot see the difference.
//
// Run:  npx tsx tests/raw-sql-date-params.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src', 'netlify', 'db'];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
}

const DATE_ISH = /\$\{\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}/g;

/**
 * Names that read like a Date. A fallback net only — see dateLocals() for the primary test.
 *
 * ⚠️ This list was the ONLY gate until 2026-08-18, and it is why six live instances of this bug sat
 * in the repo while a test named "must not bind a Date" passed. It flags `cutoff` and misses
 * `thirtyDaysAgo`, `ago24h`, `ago7d`, `in14d`, `staleBefore`, `intervalAgo`, `soonFrom` and `soonTo`
 * — every one of which was a real Date bound into a real template, five of them inside the
 * `.execute(sql`…`)` shape this test already claimed to cover. A hand-maintained list of names
 * cannot be the gate: it only ever knows about the bugs already found.
 */
const LOOKS_LIKE_DATE = /(^|[a-z])(date|periodStart|expiresAt|createdAt|updatedAt|startedAt|cutoff|since|until|deletedAt|scheduledFor)($|[A-Z_])/i;

/**
 * Identifiers this file DECLARES as a Date — `= new Date(...)` or annotated `: Date`.
 *
 * This is the real test, and it needs no allowlist: it reads what the code says the value IS rather
 * than guessing from what it is called. `${staleBefore}` is caught because four lines up the file
 * says `staleBefore: Date`, which no naming convention would have told us.
 *
 * Known limit, stated rather than assumed: a Date that arrives without a local declaration — read
 * off an object, or returned untyped from a helper — is invisible here. LOOKS_LIKE_DATE is kept
 * alongside as a second net for that case, which is the only job it is fit for.
 */
function dateLocals(src: string): Set<string> {
    const names = new Set<string>();
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*new Date\b/g)) names.add(m[1]);
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*Date\b/g)) names.add(m[1]);
    return names;
}

console.log('\nraw sql`` templates must not bind a Date\n');

check('no raw sql`...` template interpolates a Date-shaped identifier', () => {
    // ⚠️ SCOPE WIDENED 2026-08-18, and the narrow version is why this test existed while the bug
    // shipped anyway. It only ever scanned `.execute(sql`…`)`, but the driver binds a raw template
    // the same way WHEREVER it appears — including inside a query-builder `.where(and(…))`, which is
    // exactly where lead-retention-sweep.ts bound a Date. That sweep had never completed a single run
    // since the file was written: the failure only showed as a nightly scheduled invocation erroring
    // in production, and it took giving the job an HTTP endpoint that reports its own result to see
    // it. A lint that checks one call shape is a lint that says the other shapes are safe.
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
        for (const file of walk(path.join(ROOT, dir))) {
            const src = readFileSync(file, 'utf8');
            const declaredDates = dateLocals(src);
            // EVERY sql`` template, not just the ones handed to .execute(). Crude but sufficient:
            // these are all single-level templates that run to the closing backtick.
            const templates = src.matchAll(/\bsql`([^`]*)`/g);
            for (const t of templates) {
                for (const m of t[1].matchAll(DATE_ISH)) {
                    const ident = m[1];
                    const last = ident.split('.').pop() || '';
                    // ⚠️ A DOTTED identifier in a template is a drizzle COLUMN reference
                    // (`${taskRuns.createdAt}`), which serialises to a SQL identifier and is
                    // completely safe — there are seventeen of those in this repo and flagging them
                    // would drown the two real bugs. A bare `${cutoff}` is a local variable, which is
                    // where the Date actually comes from. The residual gap is a Date read off an
                    // object (`${row.createdAt}`); accepted, and named here so it is a known limit
                    // rather than an assumed absence.
                    if (ident.includes('.')) continue;
                    // A name ending in Param/Iso/Str is the CONVERTED value — that is the fix, not
                    // the bug, and flagging it would make the lint impossible to satisfy. `Sql` is a
                    // pre-built sql.raw fragment, not a value at all.
                    if (/(Param|Iso|IsoString|Str|String|Text|Sql)$/.test(last)) continue;
                    // `.toISOString()` and friends are already strings — `${x.toISOString()}`
                    // carries parens, so DATE_ISH never matched it in the first place. What is left
                    // is a bare identifier: flag it if the file DECLARES it a Date, and fall back to
                    // the name heuristic for the Dates that arrive without a local declaration.
                    if (declaredDates.has(last) || LOOKS_LIKE_DATE.test(last)) {
                        offenders.push(`${path.relative(ROOT, file)}: \${${ident}}`);
                    }
                }
            }
        }
    }
    assert.deepEqual(offenders, [],
        'bind `x.toISOString()` instead — postgres-js throws ERR_INVALID_ARG_TYPE in Bind, before the query is sent');
});

check('the two known sites bind an ISO string, not the Date', () => {
    const cap = readFileSync(path.join(ROOT, 'src/utils/atomic-cap-check.ts'), 'utf8');
    assert.match(cap, /const periodStartParam = periodStart\.toISOString\(\)/, 'atomic-cap-check converts first');
    assert.match(cap, /AND period_start = \$\{periodStartParam\}/, 'and binds the converted value');
    const rec = readFileSync(path.join(ROOT, 'netlify/functions/reconcile-billing.ts'), 'utf8');
    assert.match(rec, /AND created_at >= \$\{periodStartParam\}/,
        'the billing reconcile cron had the identical bug and would fail the same way');
});

check('a failed cap check is distinguishable from a plan limit', () => {
    // Both are `allowed: false`. Answering a server fault with the upgrade card tells the user to
    // buy a bigger plan to fix our outage.
    const cap = readFileSync(path.join(ROOT, 'src/utils/atomic-cap-check.ts'), 'utf8');
    assert.ok(cap.includes('failed?: boolean'), 'the result must carry the distinction');
    assert.strictEqual((cap.match(/failed: true/g) || []).length, 3, 'every fault path must set it');
    const chat = readFileSync(path.join(ROOT, 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    assert.match(chat, /if \(capacity\.failed\)/, 'and the caller must branch on it before the paywall');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
