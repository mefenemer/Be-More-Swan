// src/utils/issue-github.ts — the GitHub helpers the Fix pipeline still uses.
//
// The cloud AI developer (ai-fix.yml, "Pass to Developer") was removed on 2026-11-13: Claude works
// tickets from an interactive session instead (docs/fix-pipeline-interactive.md). What stays in GitHub
// Actions is merging a fix to staging (merge-to-staging.yml, issue-cloud-merge.ts) and the one-fix hotfix
// into main (hotfix-pr.yml, issue-hotfix.ts); this module is what those, the live check and the proof
// checklist share.
//
// Tokens: GITHUB_AI_FIX_TOKEN, else GITHUB_HOTFIX_TOKEN (fine-grained, this repo: Actions read/write,
// Pull requests read; Checks read optional). Reads fall back to GITHUB_FIX_CHECK_TOKEN.

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> }>;

/** dev_runner_id of a claim held by a GitHub Actions workflow (merge to staging). */
export const CLOUD_RUNNER_ID = 'GitHub Actions';

const DEFAULT_REPO = 'mefenemer/Be-More-Swan';
export const repoOf = (r?: string) => r || process.env.GITHUB_REPO || DEFAULT_REPO;

export function ghHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fix-pipeline',
    };
}
export const writeToken = () => process.env.GITHUB_AI_FIX_TOKEN || process.env.GITHUB_HOTFIX_TOKEN || '';
export const readToken = () => writeToken() || process.env.GITHUB_FIX_CHECK_TOKEN || '';

export const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
const SLACK_MS = 2 * 60_000;

/** Strip control characters (keeping newlines and tabs) and cap the length. */
export function sanitiseText(s: string | null | undefined, max = 3000): string {
    const clean = String(s ?? '')
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 20).trimEnd()}\n…(cut short)` : clean;
}

export interface WorkflowRun { id: number; status: string; conclusion: string | null; url: string }

/** A workflow's newest dispatch run with this run-name, started no earlier than `since` (less a little slack). */
export async function findWorkflowRun(opts: { workflow: string; title: string; since: Date | string | null; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<WorkflowRun | null | 'error'> {
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    const since = ms(opts.since) - SLACK_MS;
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/actions/workflows/${opts.workflow}/runs?event=workflow_dispatch&per_page=50`, { headers: ghHeaders(opts.token) });
        if (!res.ok) return 'error';
        const runs = (await res.json())?.workflow_runs;
        const run = Array.isArray(runs) ? runs.find((r: any) => r.display_title === opts.title && ms(r.created_at) >= since) : null;
        return run ? { id: Number(run.id), status: String(run.status), conclusion: run.conclusion ?? null, url: String(run.html_url) } : null;
    } catch {
        return 'error';
    }
}

/** A run's own reason for failing: its error annotation with this title. Shown escaped only. */
export async function findRunFailureReason(opts: { runId: number; title: string; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<string | null> {
    const repo = repoOf(opts.repo);
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const jr = await f(`https://api.github.com/repos/${repo}/actions/runs/${opts.runId}/jobs?per_page=5`, { headers: ghHeaders(opts.token) });
        if (!jr.ok) return null;
        const job = (await jr.json())?.jobs?.[0];
        const checkRunId = job?.check_run_url ? String(job.check_run_url).split('/').pop() : job?.id;
        if (!checkRunId) return null;
        const ar = await f(`https://api.github.com/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=20`, { headers: ghHeaders(opts.token) });
        if (!ar.ok) return null;
        const notes = await ar.json();
        const mine = Array.isArray(notes) ? notes.find((a: any) => a.title === opts.title && a.message) : null;
        return mine ? sanitiseText(String(mine.message), 3000) : null;
    } catch {
        return null;
    }
}
