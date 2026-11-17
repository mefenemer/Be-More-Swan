#!/usr/bin/env node
// scripts/ci-e2e-report.mjs — Playwright result on staging → the admin portal's Fix pipeline.
//
// Runs after the Playwright shards on every push to staging (.github/workflows/ci.yml, `e2e-report`).
// Owner, 2026-11-17: staging CI failures go to the Fix pipeline (prod admin → Issues), where tickets are
// worked. SwanJira still only hears about LOCAL runs (it lives on the owner's Mac).
//
//   1. POST the result to the production site's report-ci-test-result function (CI_REPORT_URL,
//      Bearer CI_REPORT_SECRET). It opens / notes / closes ONE ticket: src/utils/ci-test-incident.ts.
//   2. FALLBACK — secret not set yet, or prod unreachable / erroring: one GitHub issue labelled
//      `playwright-ci` (open, or comment on the open one). A failure must never go unreported.
//   On success, any open `playwright-ci` GitHub issue (from a fallback) is closed as well.
//
// Only tests that failed AFTER Playwright's CI retry count; ones that passed on retry are listed as
// flaky but never open a ticket on their own.
//
// Env: RESULT (needs.e2e.result), REPO, RUN_URL, SHA, SHARDS (e.g. 3), JSON_DIR (downloaded
// artifacts: <dir>/playwright-json-<n>/results.json), GH_TOKEN, CI_REPORT_URL, CI_REPORT_SECRET.
// DRY_RUN=1 prints instead of calling gh or the site.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LABEL = 'playwright-ci';
const { RESULT, REPO, RUN_URL, SHA = '', SHARDS = '3', JSON_DIR = 'playwright-json', DRY_RUN, CI_REPORT_URL, CI_REPORT_SECRET } = process.env;
const short = SHA.slice(0, 8);

function gh(args, input) {
    if (DRY_RUN) {
        console.log(`[dry run] gh ${args.join(' ')}${input ? `\n${input}` : ''}`);
        return '';
    }
    return execFileSync('gh', args, { encoding: 'utf8', input }).trim();
}

/** Every test in a Playwright JSON report, with its title path and final status. */
export function collectTests(report) {
    const out = [];
    const walk = (suite, path) => {
        const here = suite.title && !suite.file?.endsWith(suite.title) ? [...path, suite.title] : path;
        for (const spec of suite.specs ?? []) {
            for (const t of spec.tests ?? []) {
                const last = t.results?.[t.results.length - 1];
                const message = (last?.error?.message ?? last?.errors?.[0]?.message ?? '')
                    .replace(/\u001b\[[0-9;]*m/g, '')
                    .split('\n').find((l) => l.trim()) ?? '';
                out.push({
                    status: t.status, // expected | unexpected | flaky | skipped
                    project: t.projectName,
                    where: `e2e/${spec.file}:${spec.line}`,
                    title: [...here, spec.title].join(' › '),
                    error: message.trim().slice(0, 200),
                });
            }
        }
        for (const child of suite.suites ?? []) walk(child, here);
    };
    for (const s of report.suites ?? []) walk(s, []);
    return out;
}

export function describeRun({ shards, readShard }) {
    const failed = [];
    const flaky = [];
    const missing = [];
    for (let n = 1; n <= shards; n++) {
        const report = readShard(n);
        if (!report) { missing.push(n); continue; }
        for (const t of collectTests(report)) {
            if (t.status === 'unexpected') failed.push(t);
            else if (t.status === 'flaky') flaky.push(t);
        }
    }
    return { failed, flaky, missing };
}

export function failureBody({ failed, flaky, missing }, { sha, runUrl }) {
    const line = (t) => `- \`${t.where}\` [${t.project}] ${t.title}${t.error ? `\n  > ${t.error.replace(/`/g, "'")}` : ''}`;
    const parts = [`Playwright failed on staging at \`${sha}\`. Run: ${runUrl}`, ''];
    if (failed.length) parts.push(`**Failed after retry (${failed.length}):**`, ...failed.slice(0, 30).map(line), '');
    if (failed.length > 30) parts.push(`…and ${failed.length - 30} more — see the run.`, '');
    if (missing.length) parts.push(`**Runner(s) ${missing.join(', ')} of the Playwright shards produced no results** (set-up or install failed before the tests ran) — see the run.`, '');
    if (flaky.length) parts.push(`Passed only on retry (flaky, ${flaky.length}): ${flaky.slice(0, 10).map((t) => `\`${t.where}\``).join(', ')}`, '');
    parts.push('The HTML report and traces are attached to the run as `playwright-report-<n>` (kept 7 days). This issue closes itself when Playwright passes on staging again. (It is here because the Fix pipeline could not be reached.)');
    return parts.join('\n');
}

function readShard(n) {
    const f = join(JSON_DIR, `playwright-json-${n}`, 'results.json');
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

/** Step 1: the Fix pipeline. True when prod recorded it; false means "use the GitHub fallback". */
export async function reportToFixPipeline(payload, { url = CI_REPORT_URL, secret = CI_REPORT_SECRET, fetchImpl = fetch } = {}) {
    if (!url || !secret) {
        console.log('Fix pipeline reporting not configured (CI_REPORT_URL / CI_REPORT_SECRET): using a GitHub issue.');
        return false;
    }
    if (DRY_RUN && fetchImpl === fetch) {
        console.log(`[dry run] POST ${url}\n${JSON.stringify(payload, null, 2)}`);
        return true;
    }
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        if (!res.ok) {
            console.log(`::warning::Fix pipeline answered ${res.status}: ${text.slice(0, 200)} — using a GitHub issue instead.`);
            return false;
        }
        console.log(`Fix pipeline: ${text.slice(0, 200)}`);
        return true;
    } catch (err) {
        console.log(`::warning::Could not reach the Fix pipeline (${err?.message || err}) — using a GitHub issue instead.`);
        return false;
    }
}

function openGithubIssue() {
    return DRY_RUN ? (process.env.DRY_RUN_OPEN_ISSUE || '') :
        gh(['issue', 'list', '--repo', REPO, '--label', LABEL, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']);
}

async function main() {
    if (RESULT !== 'failure' && RESULT !== 'success') {
        console.log(`Playwright result "${RESULT}": nothing to report.`);
        return;
    }
    const run = RESULT === 'failure' ? describeRun({ shards: Number(SHARDS), readShard }) : { failed: [], flaky: [], missing: [] };
    const payload = {
        result: RESULT, sha: SHA, runUrl: RUN_URL,
        failed: run.failed, flaky: run.flaky, missingShards: run.missing,
    };
    const recorded = await reportToFixPipeline(payload);

    const open = openGithubIssue();
    if (RESULT === 'success') {
        if (!open) { console.log('Playwright passed; no open GitHub issue.'); return; }
        gh(['issue', 'close', open, '--repo', REPO, '--comment', `Playwright passes on staging again at \`${short}\`. Run: ${RUN_URL}`]);
        console.log(`Closed GitHub issue #${open}: passing again.`);
        return;
    }
    if (recorded) return; // the Fix pipeline has it

    const body = failureBody(run, { sha: short, runUrl: RUN_URL });
    if (open) {
        gh(['issue', 'comment', open, '--repo', REPO, '--body-file', '-'], body);
        console.log(`Commented on GitHub issue #${open}.`);
        return;
    }
    // The label is created on first use; "already exists" is fine.
    try { gh(['label', 'create', LABEL, '--repo', REPO, '--color', 'D93F0B', '--description', 'Playwright failing in CI on staging (fallback when the Fix pipeline cannot be reached)']); } catch { /* exists */ }
    const url = gh(['issue', 'create', '--repo', REPO, '--label', LABEL, '--title', 'Playwright failing on staging', '--body-file', '-'], body);
    console.log(`Opened GitHub issue ${url || ''}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => { console.error(err); process.exitCode = 1; });
}
