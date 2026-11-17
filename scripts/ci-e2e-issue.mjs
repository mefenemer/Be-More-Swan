#!/usr/bin/env node
// scripts/ci-e2e-issue.mjs — Playwright failures on staging → one GitHub issue.
//
// Runs after the Playwright shards on every push to staging (.github/workflows/ci.yml, `e2e-report`).
// SwanJira only hears about LOCAL runs (it lives on the owner's Mac), so before this a CI failure was
// only a red check nobody was required to look at.
//
//   failed   → open issue labelled `playwright-ci`? comment on it : open one
//   success  → open issue? comment "passing again" and close it : nothing
//   anything else (cancelled, skipped) → nothing
//
// Only tests that failed AFTER Playwright's CI retry count; ones that passed on retry are listed as
// flaky in the same message but never open an issue on their own.
//
// Env: RESULT (needs.e2e.result), REPO, RUN_URL, SHA, SHARDS (e.g. 3), JSON_DIR (downloaded
// artifacts: <dir>/playwright-json-<n>/results.json), GH_TOKEN. DRY_RUN=1 prints instead of calling gh.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LABEL = 'playwright-ci';
const { RESULT, REPO, RUN_URL, SHA = '', SHARDS = '3', JSON_DIR = 'playwright-json', DRY_RUN } = process.env;
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
    parts.push('The HTML report and traces are attached to the run as `playwright-report-<n>` (kept 7 days). This issue closes itself when Playwright passes on staging again.');
    return parts.join('\n');
}

function readShard(n) {
    const f = join(JSON_DIR, `playwright-json-${n}`, 'results.json');
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

function main() {
    if (RESULT !== 'failure' && RESULT !== 'success') {
        console.log(`Playwright result "${RESULT}": nothing to report.`);
        return;
    }
    const open = DRY_RUN ? (process.env.DRY_RUN_OPEN_ISSUE || '') :
        gh(['issue', 'list', '--repo', REPO, '--label', LABEL, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']);

    if (RESULT === 'success') {
        if (!open) { console.log('Playwright passed; no open issue.'); return; }
        gh(['issue', 'close', open, '--repo', REPO, '--comment', `Playwright passes on staging again at \`${short}\`. Run: ${RUN_URL}`]);
        console.log(`Closed #${open}: passing again.`);
        return;
    }

    const body = failureBody(describeRun({ shards: Number(SHARDS), readShard }), { sha: short, runUrl: RUN_URL });
    if (open) {
        gh(['issue', 'comment', open, '--repo', REPO, '--body-file', '-'], body);
        console.log(`Commented on #${open}.`);
        return;
    }
    // The label is created on first use; "already exists" is fine.
    try { gh(['label', 'create', LABEL, '--repo', REPO, '--color', 'D93F0B', '--description', 'Playwright failing in CI on staging (opened and closed by ci.yml)']); } catch { /* exists */ }
    const url = gh(['issue', 'create', '--repo', REPO, '--label', LABEL, '--title', 'Playwright failing on staging', '--body-file', '-'], body);
    console.log(`Opened ${url || 'an issue'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
