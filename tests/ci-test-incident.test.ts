// tests/ci-test-incident.test.ts — staging Playwright failures → ONE Fix pipeline ticket.
//
// src/utils/ci-test-incident.ts (the rules), netlify/functions/report-ci-test-result.ts (its door) and
// scripts/ci-e2e-report.mjs (CI's side, with the GitHub-issue fallback). What goes wrong silently:
//   · a ticket per staging push (staging is pushed many times a day) instead of one per problem;
//   · a fixed problem left open, or a failure that reaches nobody because the call failed quietly;
//   · the door taking a report from anyone, or with CRON_TRIGGER_SECRET.
// No database: the SQL goes to a fake that answers like issue_reports would.
//
// Run:  npx tsx tests/ci-test-incident.test.ts

import assert from 'node:assert';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
    parseCiTestReport, failureKey, describeCiFailure, recordCiTestResult, type CiTestReport,
} from '../src/utils/ci-test-incident';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const RUN = 'https://github.com/mefenemer/Be-More-Swan/actions/runs/44077961621';
const failing = (over: Partial<CiTestReport> = {}): CiTestReport => ({
    result: 'failure', sha: '4057719ab78f1da35b03c68bfd34ffeeb32bde6b', runUrl: RUN,
    failed: [{ where: 'e2e/approve.spec.ts:42', project: 'desktop', title: 'Review › approve a draft', error: 'Error: expected visible' }],
    flaky: [], missingShards: [], ...over,
});

/** A fake db: holds at most one open automatic ticket, answers the four statements the module runs. */
function fakeDb(open: { id: number; failure_key: string | null } | null) {
    const dialect = new PgDialect();
    const log: Array<{ sql: string; params: unknown[] }> = [];
    let state = open;
    const db = {
        execute: async (q: any) => {
            const { sql, params } = dialect.sqlToQuery(q);
            log.push({ sql, params });
            if (/^\s*SELECT id, incident_context/.test(sql)) return state ? [state] : [];
            if (/^\s*INSERT INTO issue_reports/.test(sql)) { state = { id: 99, failure_key: null }; return [{ id: 99 }]; }
            return [];
        },
    };
    return { db, log, statements: () => log.map((l) => l.sql.trim().split(/\s+/).slice(0, 3).join(' ')) };
}

async function main() {
    console.log('\nWhat CI sends');

    await check('a real report is accepted and sized; anything else is refused', () => {
        const r = parseCiTestReport({ ...failing(), failed: Array.from({ length: 60 }, (_, i) => ({ where: `e2e/a.spec.ts:${i}`, project: 'desktop', title: 't'.repeat(900) })) });
        assert.ok(r);
        assert.equal(r!.failed.length, 40, 'capped at 40 tests');
        assert.equal(r!.failed[0].title.length, 300, 'titles capped');
        assert.equal(parseCiTestReport({ ...failing(), result: 'maybe' }), null);
        assert.equal(parseCiTestReport({ ...failing(), sha: 'not-a-sha' }), null);
        assert.equal(parseCiTestReport({ ...failing(), runUrl: 'https://evil.example/x' }), null, 'only a GitHub Actions run link');
        assert.equal(parseCiTestReport(null), null);
    });

    await check('the failure key ignores order, and changes when the failing set changes', () => {
        const a = failing({ failed: [{ where: 'e2e/a.spec.ts:1', project: 'desktop', title: 'a' }, { where: 'e2e/b.spec.ts:2', project: 'phone', title: 'b' }] });
        const b = failing({ failed: [...a.failed].reverse() });
        assert.equal(failureKey(a), failureKey(b));
        assert.notEqual(failureKey(a), failureKey(failing()));
        assert.notEqual(failureKey(failing()), failureKey(failing({ missingShards: [2] })), 'a runner that never started counts');
    });

    await check('the ticket title counts the tests; the body names each one and says nothing is live', () => {
        const { title, details } = describeCiFailure(failing({ flaky: [{ where: 'e2e/c.spec.ts:9', project: 'desktop', title: 'c' }] }));
        assert.equal(title, 'Automatic: Playwright failing on staging — 1 test');
        assert.ok(details.includes('e2e/approve.spec.ts:42 [desktop] Review › approve a draft'));
        assert.ok(details.includes('Error: expected visible'));
        assert.ok(details.includes(RUN), 'links the run');
        assert.ok(/nothing is live/i.test(details));
        assert.ok(details.includes('flaky): e2e/c.spec.ts:9'));
        assert.equal(describeCiFailure(failing({ failed: [], missingShards: [3] })).title, 'Automatic: Playwright failing on staging — a test runner did not start');
    });

    console.log('\nThe Fix pipeline ticket');

    await check('first failure opens ONE automatic ticket: no reporter, no workspace, the full description', async () => {
        const f = fakeDb(null);
        const out = await recordCiTestResult(f.db, failing());
        assert.deepEqual(out, { action: 'opened', issueId: 99 });
        const ins = f.log.find((l) => /^\s*INSERT INTO issue_reports/.test(l.sql))!;
        assert.ok(/VALUES \(NULL, NULL, 'system'/.test(ins.sql), 'organisation_id NULL, user_id NULL, source system');
        assert.ok(String(ins.params[0]).startsWith('Automatic: Playwright failing on staging — 1 test\n\n'), 'first line is the board title');
        assert.ok(/ON CONFLICT \(fingerprint, fingerprint_day\)/.test(ins.sql), 'a ticket closed earlier today is reopened, not duplicated');
        assert.ok(/status = 'reported'/.test(ins.sql));
        const ctx = JSON.parse(String(ins.params.find((p) => typeof p === 'string' && p.startsWith('{"kind"'))));
        assert.equal(ctx.kind, 'automated_test');
    });

    await check('the same failure again only counts it: no note, no new ticket', async () => {
        const f = fakeDb({ id: 7, failure_key: failureKey(failing()) });
        assert.deepEqual(await recordCiTestResult(f.db, failing()), { action: 'updated', issueId: 7 });
        assert.deepEqual(f.statements(), ['SELECT id, incident_context', 'UPDATE issue_reports SET']);
        assert.ok(/occurrences = occurrences \+ 1/.test(f.log[1].sql));
    });

    await check('a different set of failing tests adds one internal note to the open ticket', async () => {
        const f = fakeDb({ id: 7, failure_key: 'e2e/old.spec.ts:1|desktop' });
        assert.deepEqual(await recordCiTestResult(f.db, failing()), { action: 'noted', issueId: 7 });
        const n = f.log.find((l) => /^\s*INSERT INTO issue_report_messages/.test(l.sql))!;
        assert.ok(/'admin', NULL/.test(n.sql), 'internal: no author, never shown to a customer');
        assert.ok(String(n.params[1]).includes('the failing tests changed'));
        assert.ok(!f.log.some((l) => /^\s*INSERT INTO issue_reports /.test(l.sql)), 'no second ticket');
    });

    await check('a pass closes the open ticket with a note; a pass with nothing open does nothing', async () => {
        const f = fakeDb({ id: 7, failure_key: 'x' });
        assert.deepEqual(await recordCiTestResult(f.db, { ...failing(), result: 'success', failed: [] }), { action: 'closed', issueId: 7 });
        assert.ok(f.log.some((l) => /^\s*UPDATE issue_reports SET status = 'closed', resolved_at = now\(\)/.test(l.sql)));
        assert.ok(f.log.some((l) => /issue_report_messages/.test(l.sql) && String(l.params[1]).includes('passes on staging again')));
        const none = fakeDb(null);
        assert.deepEqual(await recordCiTestResult(none.db, { ...failing(), result: 'success', failed: [] }), { action: 'none', issueId: null });
        assert.equal(none.log.length, 1, 'only the lookup');
    });

    await check('it only ever touches open automatic Playwright tickets', async () => {
        const f = fakeDb(null);
        await recordCiTestResult(f.db, failing());
        const sel = f.log[0];
        assert.ok(/source = 'system'/.test(sel.sql) && /incident_context ->> 'kind' =/.test(sel.sql));
        assert.ok(sel.params.includes('automated_test'));
        assert.ok(/status NOT IN \('closed', 'roadmap'\)/.test(sel.sql));
    });

    console.log('\nThe door (report-ci-test-result)');

    const { default: handler } = await import('../netlify/functions/report-ci-test-result');
    const call = (auth: string | null, body: unknown, method = 'POST') => handler(new Request('https://bemoreswan.com/.netlify/functions/report-ci-test-result', {
        method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    }) as any, {} as any);

    await check('fails closed without its own secret, and refuses the wrong one or a cron secret', async () => {
        delete process.env.CI_REPORT_SECRET;
        process.env.CRON_TRIGGER_SECRET = 'cron-secret';
        assert.equal((await call('Bearer cron-secret', failing())).status, 503, 'unset → 503, never open');
        process.env.CI_REPORT_SECRET = 'ci-secret-value';
        assert.equal((await call('Bearer cron-secret', failing())).status, 401, 'CRON_TRIGGER_SECRET is not accepted');
        assert.equal((await call(null, failing())).status, 401);
        assert.equal((await call('Bearer ci-secret-valuX', failing())).status, 401);
        assert.equal((await call('Bearer ci-secret-value', failing(), 'GET')).status, 405);
    });

    await check('with the right secret, a body that is not a report is refused before any database work', async () => {
        process.env.CI_REPORT_SECRET = 'ci-secret-value';
        assert.equal((await call('Bearer ci-secret-value', 'not json')).status, 400);
        assert.equal((await call('Bearer ci-secret-value', { result: 'failure', sha: 'zz', runUrl: RUN })).status, 400);
    });

    console.log('\nCI side (scripts/ci-e2e-report.mjs)');

    // @ts-ignore — plain ESM script, no types
    const { reportToFixPipeline } = await import('../scripts/ci-e2e-report.mjs');
    const payload = { result: 'failure', sha: 'abc1234', runUrl: RUN, failed: [], flaky: [], missingShards: [] };

    await check('recorded by the Fix pipeline → no GitHub fallback; it sends the secret as Bearer', async () => {
        let seen: any = null;
        const ok = await reportToFixPipeline(payload, { url: 'https://x/fn', secret: 's3', fetchImpl: async (u: string, init: any) => { seen = { u, init }; return new Response('{"ok":true,"action":"opened"}', { status: 200 }); } });
        assert.equal(ok, true);
        assert.equal(seen.init.headers.Authorization, 'Bearer s3');
        assert.deepEqual(JSON.parse(seen.init.body), payload);
    });

    await check('not set up, an error answer or no answer → false, so CI falls back to a GitHub issue', async () => {
        assert.equal(await reportToFixPipeline(payload, { url: '', secret: 's3' }), false, 'no URL');
        assert.equal(await reportToFixPipeline(payload, { url: 'https://x/fn', secret: '' }), false, 'no secret');
        assert.equal(await reportToFixPipeline(payload, { url: 'https://x/fn', secret: 's3', fetchImpl: async () => new Response('nope', { status: 503 }) }), false, '503');
        assert.equal(await reportToFixPipeline(payload, { url: 'https://x/fn', secret: 's3', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), false, 'network error');
    });

    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
