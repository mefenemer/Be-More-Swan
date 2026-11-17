// netlify/functions/report-ci-test-result.ts — CI tells the Fix pipeline how Playwright did on staging.
//
// POST { result: 'failure' | 'success', sha, runUrl, failed[], flaky[], missingShards[] }
// Called by .github/workflows/ci.yml (`e2e-report` → scripts/ci-e2e-issue.mjs) after every push to
// staging, against the PRODUCTION site: the Fix pipeline the owner works is prod's. The rules for
// opening, noting and closing the ticket are in src/utils/ci-test-incident.ts.
//
// AUTH: its own shared secret, CI_REPORT_SECRET, as `Authorization: Bearer <secret>` — not
// CRON_TRIGGER_SECRET, so the key GitHub holds can do this one thing and nothing else. Fails closed
// (503) when unset; CI then falls back to a GitHub issue.

import { timingSafeEqual } from 'crypto';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { parseCiTestReport, recordCiTestResult } from '../../src/utils/ci-test-incident';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function secretMatches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });
    const secret = process.env.CI_REPORT_SECRET;
    if (!secret) return json(503, { ok: false, error: 'CI reporting is not configured.' });
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (!secretMatches(auth.replace(/^Bearer\s+/i, '').trim(), secret)) return json(401, { ok: false, error: 'Unauthorized.' });

    let body: unknown;
    try { body = JSON.parse(event.body || ''); } catch { return json(400, { ok: false, error: 'Body must be JSON.' }); }
    const report = parseCiTestReport(body);
    if (!report) return json(400, { ok: false, error: 'Not a CI test report.' });

    try {
        const out = await recordCiTestResult(getDb(), report);
        console.log('[report-ci-test-result]', report.result, report.sha.slice(0, 8), JSON.stringify(out));
        return json(200, { ok: true, ...out });
    } catch (err) {
        console.error('[report-ci-test-result] could not record:', (err as Error)?.message);
        return json(500, { ok: false, error: 'Could not record the result.' });
    }
});
