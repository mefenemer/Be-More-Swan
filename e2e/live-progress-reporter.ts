// Writes the run's live state to .playwright-live/progress.json after every test, so something
// outside Playwright can show it while it runs. SwanJira's "Automated tests" tab polls this file
// (docs/swanjira-testing-loop.md). Local runs only — CI uses the list + html reporters.
//
// A dot-directory on purpose: Netlify never publishes dotfiles, and Playwright wipes test-results/
// and playwright-report/ at the start of a run, which would blank the page mid-run.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

type TestState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'flaky';

interface TestRow {
    id: string;
    title: string;
    file: string;
    project: string;
    status: TestState;
    durationMs: number | null;
    error: string | null;
}

export default class LiveProgressReporter implements Reporter {
    private dir = '';
    private rootDir = '';
    private startedAt = '';
    private rows = new Map<string, TestRow>();

    onBegin(config: FullConfig, suite: Suite) {
        this.rootDir = config.rootDir;
        // Beside playwright.config.ts (the repo root); rootDir is the test directory.
        this.dir = join(config.configFile ? dirname(config.configFile) : join(config.rootDir, '..'), '.playwright-live');
        mkdirSync(this.dir, { recursive: true });
        this.startedAt = new Date().toISOString();
        for (const test of suite.allTests()) {
            this.rows.set(test.id, {
                id: test.id,
                title: test.title,
                file: relative(this.rootDir, test.location.file),
                project: test.parent.project()?.name || '',
                status: 'pending',
                durationMs: null,
                error: null,
            });
        }
        this.write('running');
    }

    onTestBegin(test: TestCase) {
        const row = this.rows.get(test.id);
        if (row) row.status = 'running';
        this.write('running');
    }

    onTestEnd(test: TestCase, result: TestResult) {
        const row = this.rows.get(test.id);
        if (!row) return;
        // outcome() settles retries: a test that failed then passed is 'flaky', not 'failed'.
        const outcome = test.outcome();
        row.status = outcome === 'expected' ? 'passed'
            : outcome === 'flaky' ? 'flaky'
            : outcome === 'skipped' ? 'skipped'
            // A failure that will be retried is still running, as far as the page is concerned.
            : result.retry < test.retries ? 'running'
            : 'failed';
        row.durationMs = result.duration;
        // First line only, colour codes stripped — the HTML report has the whole thing.
        const message = result.error?.message?.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) || null;
        row.error = row.status === 'failed' ? message : null;
        this.write('running');
    }

    onEnd(result: FullResult) {
        this.write(result.status, new Date().toISOString());
    }

    private write(status: string, finishedAt: string | null = null) {
        const tests = [...this.rows.values()];
        const count = (s: TestState) => tests.filter((t) => t.status === s).length;
        const payload = {
            status,
            startedAt: this.startedAt,
            finishedAt,
            totals: {
                total: tests.length,
                passed: count('passed'),
                failed: count('failed'),
                flaky: count('flaky'),
                skipped: count('skipped'),
                running: count('running'),
                pending: count('pending'),
            },
            tests,
        };
        // Write-then-rename, so a reader polling mid-write never gets half a file.
        const tmp = join(this.dir, 'progress.json.tmp');
        writeFileSync(tmp, JSON.stringify(payload, null, 2));
        renameSync(tmp, join(this.dir, 'progress.json'));
    }
}
