// Staging never drained scenario_jobs (found 2026-11-16 preparing the Meeting Note Taker real-account run):
// process-scenario-jobs is a SCHEDULED function, Netlify fires those only on production and answers a URL
// call to one with 403, and staging-crons.yml had no row for it. So on staging an approved meeting queued
// its follow-up email, Slack, Notion and Jira/Asana hand-offs and none ever ran.
// Run: npx tsx tests/staging-scenario-drain.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

// 1. One drain, two callers: production's schedule and staging's wrapper.
const proc = read('netlify/functions/process-scenario-jobs.ts');
assert.ok(proc.includes('export async function drainScenarioJobs('));
assert.ok(proc.includes('const result = await drainScenarioJobs();'), 'the scheduled handler calls the shared drain');
const wrap = read('netlify/functions/run-scenario-jobs.ts');
assert.ok(wrap.includes("import { drainScenarioJobs } from './process-scenario-jobs';") && wrap.includes('await drainScenarioJobs()'));

// 2. The wrapper fails closed, like every other staging trigger.
assert.ok(wrap.includes("if (event.httpMethod !== 'POST') return { statusCode: 405"));
assert.ok(wrap.includes('if (!secret) {') && wrap.includes('statusCode: 503'));
assert.ok(wrap.includes('if (token !== secret) return { statusCode: 401'));

// 3. The workflow pokes the WRAPPER (not the scheduled function, which would 403), as a job row.
const wf = read('.github/workflows/staging-crons.yml');
const jobs = wf.slice(wf.indexOf('JOBS="'), wf.indexOf('RAN=""'));
assert.match(jobs, /\n\s+run-scenario-jobs\s+300\s+120\n/);
assert.ok(!/\n\s+process-scenario-jobs\s+\d+/.test(jobs), 'never the scheduled function itself');

// 4. Production's schedule is unchanged, and the wrapper has the full synchronous budget.
const toml = read('netlify.toml');
assert.match(toml, /\[functions\.process-scenario-jobs\]\n {2}schedule = "\*\/10 \* \* \* \*"/);
assert.match(toml, /\[functions\.run-scenario-jobs\]\n {2}timeout = 26/);

console.log('staging-scenario-drain: all checks passed');
