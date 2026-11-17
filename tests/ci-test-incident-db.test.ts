// tests/ci-test-incident-db.test.ts — the Fix pipeline's CI ticket SQL on real Postgres.
//
// src/utils/ci-test-incident.ts writes straight SQL against columns that live outside db/schema.ts
// (db/z-platform-incidents.sql) and relies on that file's partial unique index for ON CONFLICT. Only
// Postgres proves those statements run: tests/ci-test-incident.test.ts checks their shape on a fake.
// Runs in the CI rls job (fresh Postgres); skips anywhere else, and never touches staging or prod.
//
// Run:  NETLIFY_DATABASE_URL=postgres://…localhost… npx tsx tests/ci-test-incident-db.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { recordCiTestResult, type CiTestReport } from '../src/utils/ci-test-incident';

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

const RUN = 'https://github.com/mefenemer/Be-More-Swan/actions/runs/1';
const report = (over: Partial<CiTestReport> = {}): CiTestReport => ({
    result: 'failure', sha: '4057719ab78f1da35b03c68bfd34ffeeb32bde6b', runUrl: RUN,
    failed: [{ where: 'e2e/approve.spec.ts:42', project: 'desktop', title: 'Review › approve a draft' }],
    flaky: [], missingShards: [], ...over,
});

async function main() {
    console.log('CI test failures → Fix pipeline ticket (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `ci_incident_test_${Date.now()}`;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
        // The incident columns + partial unique index, exactly as prod got them (idempotent file).
        await sql.unsafe(readFileSync(join(__dirname, '..', 'db', 'z-platform-incidents.sql'), 'utf8'));
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['issue_reports', 'issue_report_messages']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const tickets = () => sql.unsafe(`SELECT id, status, source, organisation_id, user_id, occurrences, description,
                                                 incident_context, resolved_at FROM issue_reports ORDER BY id`);
        const notes = (id: number) => sql.unsafe(`SELECT author_type, author_id, body, status FROM issue_report_messages WHERE issue_id = ${id} ORDER BY id`);

        await check('a failure opens one automatic ticket that passes the table\'s own checks', async () => {
            const out = await recordCiTestResult(db, report());
            assert.equal(out.action, 'opened');
            const [t] = await tickets();
            assert.equal(t.id, out.issueId);
            assert.equal(t.source, 'system');
            assert.equal(t.organisation_id, null);
            assert.equal(t.user_id, null);
            assert.equal(t.status, 'reported');
            assert.ok(String(t.description).startsWith('Automatic: Playwright failing on staging — 1 test'));
            assert.equal(t.incident_context.kind, 'automated_test');
        });

        await check('the same failure counts on the same ticket; a changed set adds an internal note', async () => {
            const again = await recordCiTestResult(db, report());
            assert.equal(again.action, 'updated');
            const changed = await recordCiTestResult(db, report({ failed: [{ where: 'e2e/auth.spec.ts:7', project: 'phone', title: 'Sign in' }] }));
            assert.equal(changed.action, 'noted');
            const rows = await tickets();
            assert.equal(rows.length, 1, 'still one ticket');
            assert.equal(rows[0].occurrences, 3);
            const n = await notes(rows[0].id);
            assert.equal(n.length, 1);
            assert.equal(n[0].author_type, 'admin');
            assert.equal(n[0].author_id, null);
            assert.ok(String(n[0].body).includes('e2e/auth.spec.ts:7'));
        });

        await check('a pass closes it with a note; failing again the same day reopens it, not a duplicate', async () => {
            const closed = await recordCiTestResult(db, { ...report(), result: 'success', failed: [] });
            assert.equal(closed.action, 'closed');
            let [t] = await tickets();
            assert.equal(t.status, 'closed');
            assert.ok(t.resolved_at);
            assert.equal((await recordCiTestResult(db, { ...report(), result: 'success', failed: [] })).action, 'none');

            const reopened = await recordCiTestResult(db, report());
            assert.equal(reopened.action, 'opened');
            const rows = await tickets();
            assert.equal(rows.length, 1, 'ON CONFLICT on (fingerprint, fingerprint_day) reopened today\'s ticket');
            [t] = rows;
            assert.equal(t.status, 'reported');
            assert.equal(t.resolved_at, null);
        });

        await check('customer reports and other automatic incidents are never touched', async () => {
            await sql.unsafe(`INSERT INTO issue_reports (organisation_id, user_id, source, description, status, incident_context)
                              VALUES (NULL, NULL, 'system', 'Automatic: Chat reply failed', 'reported', '{"kind":"chat_turn"}'::jsonb)`);
            const before = await sql.unsafe(`SELECT status, occurrences FROM issue_reports WHERE incident_context ->> 'kind' = 'chat_turn'`);
            await recordCiTestResult(db, { ...report(), result: 'success', failed: [] });
            const after = await sql.unsafe(`SELECT status, occurrences FROM issue_reports WHERE incident_context ->> 'kind' = 'chat_turn'`);
            assert.deepEqual(after, before);
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
