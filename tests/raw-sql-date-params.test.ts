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

/** Identifiers whose value is a Date often enough to be worth refusing inside a raw template. */
const DATE_ISH = /\$\{\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}/g;
const LOOKS_LIKE_DATE = /(^|[a-z])(date|periodStart|expiresAt|createdAt|updatedAt|startedAt|cutoff|since|until|deletedAt|scheduledFor)($|[A-Z_])/i;

console.log('\nraw sql`` templates must not bind a Date\n');

check('no execute(sql`...`) template interpolates a Date-shaped identifier', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
        for (const file of walk(path.join(ROOT, dir))) {
            const src = readFileSync(file, 'utf8');
            // Each raw template passed to .execute(). Crude but sufficient: the template literal
            // runs to the closing backtick, and these are all single-level templates.
            const templates = src.matchAll(/\.execute\(\s*sql`([\s\S]*?)`\s*\)/g);
            for (const t of templates) {
                for (const m of t[1].matchAll(DATE_ISH)) {
                    const ident = m[1];
                    const last = ident.split('.').pop() || '';
                    // A name ending in Param/Iso/Str is the CONVERTED value — that is the fix, not
                    // the bug, and flagging it would make the lint impossible to satisfy.
                    if (/(Param|Iso|IsoString|Str|String|Text)$/.test(last)) continue;
                    // `.toISOString()` and friends are already strings, so only a BARE identifier
                    // that reads like a Date is suspicious.
                    if (LOOKS_LIKE_DATE.test(last)) {
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
