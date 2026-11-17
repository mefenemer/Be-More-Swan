// src/utils/ci-test-incident.ts — Playwright failing in CI on staging → the Fix pipeline.
//
// Owner, 2026-11-17: staging CI failures belong in the admin portal's Fix pipeline (Issues), where
// tickets are worked, not in GitHub issues. They arrive as automatic incidents like
// platform-incident.ts's (source 'system', no reporter, no organisation, nobody notified), through
// netlify/functions/report-ci-test-result.ts, which ci.yml's `e2e-report` job calls after every push
// to staging.
//
// ONE open ticket at a time, not one per day: a failure that lasts a week is one problem.
//   failure, no open ticket   → open one; the description names every failed test
//   failure, ticket open      → occurrences +1; an internal note only when the SET of failing tests
//                               changed (staging is pushed many times a day)
//   success, ticket open      → internal note + status 'closed'
//   success, none open        → nothing
// Unlike platform-incident.ts nothing is scrubbed: test names, file paths and CI links are our own
// code, not customer content — and they are exactly what whoever fixes it needs.

import { sql } from 'drizzle-orm';
import { fingerprintOf, ukDay } from './platform-incident';

type Db = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

export const CI_TEST_KIND = 'automated_test' as const;

export interface CiFailedTest {
    where: string;    // e2e/approve.spec.ts:42
    project: string;  // desktop | phone
    title: string;    // describe › test
    error?: string;   // first line of the error
}

export interface CiTestReport {
    result: 'failure' | 'success';
    sha: string;
    runUrl: string;
    failed: CiFailedTest[];
    flaky: CiFailedTest[];
    /** Playwright runners that produced no results (set-up or install failed before the tests). */
    missingShards: number[];
}

export type CiIncidentAction = 'opened' | 'updated' | 'noted' | 'closed' | 'none';

const MAX_TESTS = 40;
const cap = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Pure: validate and size-limit what CI sent. Null when it isn't a report at all. */
export function parseCiTestReport(body: unknown): CiTestReport | null {
    const b = body as Record<string, unknown> | null;
    if (!b || (b.result !== 'failure' && b.result !== 'success')) return null;
    const sha = cap(b.sha, 40);
    const runUrl = cap(b.runUrl, 300);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(runUrl)) return null;
    const tests = (v: unknown): CiFailedTest[] => (Array.isArray(v) ? v : []).slice(0, MAX_TESTS).map((t: any) => ({
        where: cap(t?.where, 160), project: cap(t?.project, 40), title: cap(t?.title, 300), error: cap(t?.error, 300) || undefined,
    })).filter((t) => t.where && t.title);
    const missingShards = (Array.isArray(b.missingShards) ? b.missingShards : [])
        .map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 50).slice(0, 10);
    return { result: b.result, sha, runUrl, failed: tests(b.failed), flaky: tests(b.flaky), missingShards };
}

/** Pure: which tests are failing, order-independent — a note is added only when this changes. */
export function failureKey(r: CiTestReport): string {
    return [...r.failed.map((t) => `${t.where}|${t.project}`).sort(), ...r.missingShards.map((n) => `shard ${n}`)].join('\n');
}

/** Pure: the ticket's description (first line = the title on the board) and an update note. */
export function describeCiFailure(r: CiTestReport): { title: string; details: string } {
    const n = r.failed.length;
    const title = n
        ? `Automatic: Playwright failing on staging — ${n} test${n === 1 ? '' : 's'}`
        : `Automatic: Playwright failing on staging — ${r.missingShards.length ? 'a test runner did not start' : 'see the run'}`;
    const line = (t: CiFailedTest) => `• ${t.where} [${t.project}] ${t.title}${t.error ? `\n    ${t.error}` : ''}`;
    const parts: string[] = [
        `Staging commit ${r.sha.slice(0, 8)} · run ${r.runUrl}`,
        'Staging only: nothing is live. Fix on staging; the ticket closes itself when Playwright passes there again.',
    ];
    if (n) parts.push('', `Failed after retry (${n}):`, ...r.failed.map(line));
    if (r.missingShards.length) parts.push('', `Runner(s) ${r.missingShards.join(', ')} of 3 produced no results (set-up failed before the tests ran).`);
    if (r.flaky.length) parts.push('', `Passed only on retry (flaky): ${r.flaky.map((t) => t.where).join(', ')}`);
    parts.push('', 'The HTML report and traces are on the run as playwright-report-<n> (kept 7 days).');
    return { title, details: parts.join('\n') };
}

async function note(db: Db, issueId: number, body: string, status: string | null = null): Promise<void> {
    await db.execute(sql`
        INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
        VALUES (${issueId}, 'admin', NULL, ${body}, ${status})`);
}

/** Apply one CI result to the Fix pipeline. Throws on database errors: the caller reports them to CI. */
export async function recordCiTestResult(db: Db, r: CiTestReport): Promise<{ action: CiIncidentAction; issueId: number | null }> {
    const open = await db.execute(sql`
        SELECT id, incident_context ->> 'failureKey' AS failure_key FROM issue_reports
         WHERE source = 'system' AND incident_context ->> 'kind' = ${CI_TEST_KIND}
           AND status NOT IN ('closed', 'roadmap')
         ORDER BY id DESC LIMIT 1`) as Array<{ id: number; failure_key: string | null }>;
    const current = open[0] ?? null;

    if (r.result === 'success') {
        if (!current) return { action: 'none', issueId: null };
        await note(db, current.id, `✅ Playwright passes on staging again at ${r.sha.slice(0, 8)}. Run: ${r.runUrl}`, 'closed');
        await db.execute(sql`
            UPDATE issue_reports SET status = 'closed', resolved_at = now(), updated_at = now() WHERE id = ${current.id}`);
        return { action: 'closed', issueId: current.id };
    }

    const key = failureKey(r);
    const { title, details } = describeCiFailure(r);
    const context = JSON.stringify({
        kind: 'automated_test', errorClass: 'Playwright', message: title.replace(/^Automatic: /, ''),
        view: 'ci.yml · e2e', ids: { commit: r.sha.slice(0, 8) }, failureKey: key, runUrl: r.runUrl,
    });

    if (current) {
        await db.execute(sql`
            UPDATE issue_reports SET occurrences = occurrences + 1, last_seen_at = now(), updated_at = now(),
                   incident_context = ${context}::jsonb
             WHERE id = ${current.id}`);
        if (current.failure_key === key) return { action: 'updated', issueId: current.id };
        await note(db, current.id, `🧪 Still failing, and the failing tests changed.\n\n${title.replace(/^Automatic: /, '')}\n${details}`);
        return { action: 'noted', issueId: current.id };
    }

    // One fingerprint per day keeps the (fingerprint, fingerprint_day) index happy; a ticket closed
    // earlier today and failing again is reopened rather than duplicated.
    const fp = fingerprintOf(CI_TEST_KIND, 'Playwright', null);
    const rows = await db.execute(sql`
        INSERT INTO issue_reports (organisation_id, user_id, source, description, source_location,
                                   fingerprint, fingerprint_day, occurrences, last_seen_at, incident_context)
        VALUES (NULL, NULL, 'system', ${`${title}\n\n${details}`}, 'System · Automated tests (Playwright on staging)',
                ${fp}, ${ukDay()}::date, 1, now(), ${context}::jsonb)
        ON CONFLICT (fingerprint, fingerprint_day) WHERE fingerprint IS NOT NULL
        DO UPDATE SET status = 'reported', resolved_at = NULL, description = EXCLUDED.description,
                      occurrences = issue_reports.occurrences + 1, last_seen_at = now(), updated_at = now(),
                      incident_context = EXCLUDED.incident_context
        RETURNING id`) as Array<{ id: number }>;
    return { action: 'opened', issueId: rows[0]?.id ?? null };
}
