#!/usr/bin/env node
// scripts/whats-new-draft-watcher.mjs
// Runs Claude ONLY when an admin presses "Draft this week's email now" on Admin ▸ What's New.
//
// Why a watcher: the button is on the website and the drafting happens on this Mac (the screenshots
// need a signed-in browser here). Nothing on the internet can start a process on this Mac, so the Mac
// has to ask. Asking from a scheduled Claude task cost a Claude run every check even when nobody had
// pressed anything; this script asks with ONE plain HTTP request a minute — no Claude, no usage — and
// starts `claude -p --chrome` only when a request is actually waiting.
//
// Kept alive by launchd (scripts/com.aura.whats-new-watcher.plist via whats-new-watcher-service.sh),
// the same pattern as the dev issue-fixer. Config: PRODUCT_UPDATES_INGEST_TOKEN from .env.
//
// The Claude run takes screenshots in YOUR Chrome (Claude in Chrome), so Chrome must be open, the
// extension connected, and bemoreswan.com signed in to the Be More Swan workspace. If it is not, the
// run reports `failed` with that reason and the admin page says so. Nothing on this path can send an
// email: the draft lands as "Waiting for review" and Approve & send stays the only way out.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.WHATS_NEW_BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');
const POLL_MS = Number(process.env.WHATS_NEW_POLL_MS || 60_000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
/** A drafting run that has not finished in this long is stopped and reported as failed. */
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
    if (process.env.PRODUCT_UPDATES_INGEST_TOKEN) return process.env.PRODUCT_UPDATES_INGEST_TOKEN;
    const envFile = path.join(REPO, '.env');
    if (!existsSync(envFile)) return '';
    const line = readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('PRODUCT_UPDATES_INGEST_TOKEN='));
    return line ? line.slice('PRODUCT_UPDATES_INGEST_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : '';
}

/** One call to the machine routes. `Connection: close` so a long Claude run never leaves a dead pooled socket. Never throws. */
async function api(method, resource, body) {
    try {
        const res = await fetch(`${BASE_URL}/.netlify/functions/product-updates?resource=${resource}`, {
            method,
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Connection: 'close' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20_000),
        });
        let data = null;
        try { data = await res.json(); } catch { /* not JSON */ }
        return { status: res.status, data };
    } catch (err) {
        return { status: 0, data: { error: String(err?.cause?.code || err?.message || err) } };
    }
}

/** The exact instructions the Claude run follows. The doc is authoritative; this points at it. */
export function draftPrompt(workDir) {
    return `You are drafting this week's "What's new at Be More Swan" email because an admin pressed "Draft this week's email now". The request is ALREADY CLAIMED — do not run --pending or --claim. You NEVER approve or send the email; an admin does that in the portal.

Work in ${REPO}. Write every working file (draft.json, screenshots, preview) to ${workDir} — never into the repo.

Read docs/weekly-product-update.md FIRST and follow its section "The weekly run (instructions for the Claude task)" exactly, with ONE difference: take the screenshots in Chrome using the Claude in Chrome tools (mcp__claude-in-chrome__*), not a built-in browser pane. Open a NEW tab at https://bemoreswan.com/workspace.html. Read the memory index at /Users/mefenemer/.claude/projects/-Users-mefenemer-WebstormProjects-Be-More-Swan/memory/MEMORY.md and the notes it names under "Before you answer a question about what the product does" before writing any copy, so nothing withheld, unbuilt or blocked on prod is advertised. Follow the doc's privacy rules for screenshots strictly. Never save, approve, publish, delete or send anything in the app, and never sign in or out.

The screenshots must come from the founder's own Be More Swan workspace, which has hired assistants. If the Claude in Chrome tools are unavailable, OR Chrome shows the login page, OR a workspace that is clearly not that one (for example "Choose a plan to activate your workspace", or no assistants), do not click anything there. Run:
  npx tsx scripts/product-updates/upload-draft.ts --done failed --note "<the reason, in plain words>"
and stop.

End the run with exactly one of:
- a successful \`npx tsx scripts/product-updates/upload-draft.ts --upload ${workDir}/draft.json\` (a 201 closes the request by itself), or
- \`npx tsx scripts/product-updates/upload-draft.ts --done nothing --note "<one sentence>"\` when there is nothing customer-facing since the last email, or
- \`npx tsx scripts/product-updates/upload-draft.ts --done waiting_for_review --note "<one sentence>"\` when --last shows a draft already waiting, or
- \`npx tsx scripts/product-updates/upload-draft.ts --done failed --note "<what failed>"\`.

Finish with a few lines: the outcome, and the subject + features if you uploaded.`;
}

/** Tools the unattended run may use without asking. Nothing that can push, merge or delete. */
export const ALLOWED_TOOLS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Bash(git fetch:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)',
    'Bash(npx tsx scripts/product-updates/upload-draft.ts:*)',
    'Bash(sips:*)', 'Bash(cp:*)', 'Bash(mkdir:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(sed:*)', 'Bash(python3 -m http.server:*)',
    'mcp__claude-in-chrome__*',
];

function runClaude(workDir) {
    return new Promise((resolve) => {
        const args = ['-p', '--chrome', '--permission-mode', 'acceptEdits', '--add-dir', workDir, '--allowedTools', ...ALLOWED_TOOLS];
        let child;
        try { child = spawn(CLAUDE_BIN, args, { cwd: REPO, env: process.env }); }
        catch (e) { resolve({ code: null, out: '', err: String(e?.message || e) }); return; }
        let out = '', err = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => { err += '\n[watcher] timed out'; child.kill('SIGTERM'); }, RUN_TIMEOUT_MS);
        child.on('error', (e) => { err += String(e?.message || e); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
        child.stdin.end(draftPrompt(workDir));
    });
}

async function handleRequest() {
    const claim = await api('POST', 'draft-request-claim', {});
    if (claim.status !== 200) { log('claim refused:', claim.status, claim.data?.error); return; }
    const workDir = mkdtempSync(path.join(tmpdir(), 'whats-new-'));
    log('request claimed — starting Claude in', workDir);
    const r = await runClaude(workDir);
    log('Claude finished with code', r.code);
    if (r.out) log(r.out.slice(-2000));
    if (r.err) log('stderr:', r.err.slice(-2000));

    // However Claude ended, the request must not be left "working": if it neither uploaded nor
    // reported, say so on the admin page rather than leaving the button disabled for three hours.
    const after = await api('GET', 'draft-request-poll');
    if (after.data?.request?.status === 'working') {
        const reason = r.code === 0 ? 'The drafting run ended without uploading or reporting an outcome.' : `The drafting run stopped unexpectedly (exit ${r.code}). ${r.err.split('\n').slice(-1)[0] || ''}`;
        await api('POST', 'draft-request-done', { outcome: 'failed', note: reason });
        log('marked failed:', reason);
    }
}

async function main() {
    if (!token()) { log('✖ PRODUCT_UPDATES_INGEST_TOKEN is not set (env or .env) — cannot ask the website. Idling.'); await sleep(60_000); process.exit(1); }
    log(`▶ What's New draft watcher — asking ${BASE_URL} every ${Math.round(POLL_MS / 1000)}s`);
    let lastProblem = '';
    for (;;) {
        const poll = await api('GET', 'draft-request-poll');
        if (poll.status === 200) {
            lastProblem = '';
            if (poll.data?.hasWork) await handleRequest();
        } else {
            // Log a problem once, not every minute (a 404 before deploy, or the Mac offline).
            const problem = `${poll.status} ${poll.data?.error || ''}`.trim();
            if (problem !== lastProblem) { log('poll failed:', problem); lastProblem = problem; }
        }
        await sleep(POLL_MS);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
