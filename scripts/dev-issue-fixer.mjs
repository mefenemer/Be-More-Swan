#!/usr/bin/env node
// scripts/dev-issue-fixer.mjs
//
// "Pass to Developer" — local AI auto-fix runner.
//
// This watcher runs on a DEVELOPER MACHINE, where the repo and the Claude Code CLI
// live. The cloud admin portal only queues work; this script does the actual fixing:
//
//   1. Poll  GET  $AURA_BASE_URL/.netlify/functions/admin-issue-handoff?action=claim
//   2. For each claimed issue:
//        • create an isolated git worktree on a new branch off $BASE_BRANCH
//        • run Claude Code headless (`claude -p … --permission-mode acceptEdits`) to fix it
//        • commit, push, and open a PR with `gh`
//   3. POST the result back; the issue parks at "Fix In Progress" with a PR ready to merge.
//
// It ALSO drains the merge queue: when a super-admin presses "Merge to staging" in the
// admin ticket, this watcher claims that request (?action=claim-merge), runs `gh pr merge`,
// and reports back (?action=merge-result) — which is what finally flips the issue to
// "Fixed & Ready to Test".
//
// Nothing here touches your current working tree — all edits happen in a throwaway
// worktree under the OS temp dir, which is removed when the issue is done.
//
// Required env:
//   AURA_BASE_URL      e.g. https://staging--bemoreswan.netlify.app  (or http://localhost:8888)
//   DEV_HANDOFF_TOKEN  must match the same env var on the Netlify deployment
// Optional env:
//   AURA_REPO          path to the repo (default: the repo this script lives in)
//   BASE_BRANCH        branch to fork fixes from (default: staging)
//   POLL_INTERVAL_MS   idle poll cadence (default: 15000)
//   CLAUDE_BIN         Claude Code CLI binary (default: claude)
//   ONCE=1             process at most one issue then exit (handy for testing)
//
// Run:  npm run dev:issue-fixer

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir, hostname, homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = (process.env.AURA_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.DEV_HANDOFF_TOKEN || '';
const REPO = process.env.AURA_REPO || join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_BRANCH = process.env.BASE_BRANCH || 'staging';
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const ONCE = process.env.ONCE === '1';
// A human-readable identity for this runner, sent on every claim so the admin portal can
// show which of several concurrent runners is working which issue. Override with RUNNER_ID
// (e.g. "alice-laptop") when the default host:pid isn't distinctive enough.
const RUNNER_ID = (process.env.RUNNER_ID || `${hostname()}:${process.pid}`).slice(0, 120);

const ENDPOINT = `${BASE_URL}/.netlify/functions/admin-issue-handoff`;
// Idle cadence while paused on a session limit, waiting for the admin to press "Resume runner".
const RESUME_POLL_MS = Number(process.env.RESUME_POLL_INTERVAL_MS || 10000);
// The Claude Code CLI prints one of these when the account's usage/session limit is exhausted.
const SESSION_LIMIT_RE = /session limit|usage limit|hit your (?:usage|session|rate) limit|rate limit/i;
// A probe result that means the account's stored credential is no longer a valid login (its
// OAuth token expired / was revoked) — distinct from a rate limit. Recovering needs a one-time
// interactive `claude auth login` on this machine; no portal button can do it. Used to flag the
// account as "login expired" in the portal instead of a Switch button that would just re-fail.
const LOGGED_OUT_RE = /not logged in|please run\s*\/login|run\s+`?\/login|invalid api key|oauth token (?:has )?expired|refresh token (?:has )?expired/i;
const isLoggedOut = (out) => LOGGED_OUT_RE.test(out || '');
// How often the runner proactively "keeps warm" every stored-but-inactive account: switch to it,
// probe (which refreshes its OAuth token), re-snapshot, switch back. Keeps rotation accounts from
// going stale through disuse — the recurring reason a later switch would hit "Not logged in".
const ACCOUNT_REFRESH_MS = Number(process.env.AURA_ACCOUNT_REFRESH_MS || 12 * 60 * 60 * 1000);
// Emails whose most recent probe reported a dead login. Surfaced to the portal via
// listKnownAccounts so the account renders as "login expired — re-login on runner".
const staleAccounts = new Set();

// Shared control flags. `stopping` is set on SIGINT (main + resume-wait loops watch it);
// `paused` is set when a fix hits a Claude session limit so main pauses instead of claiming more.
let stopping = false;
let paused = false;

if (!BASE_URL || !TOKEN) {
  console.error('✖ AURA_BASE_URL and DEV_HANDOFF_TOKEN are required.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Run a command, returning { ok, stdout, stderr }. Never throws.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim() || (r.error ? String(r.error.message) : ''),
  };
}
// Async twin of run(): spawns instead of spawnSync so the event loop stays free while the
// command runs. Used for the long Claude Code fix, where a background heartbeat timer must be
// able to fire (spawnSync would block the whole thread and freeze the timer). Never rejects.
function runAsync(cmd, args, opts = {}) {
  const { input, encoding, maxBuffer, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, spawnOpts); }
    catch (e) { resolve({ ok: false, code: null, stdout: '', stderr: String(e?.message || e) }); return; }
    let stdout = '', stderr = '';
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += (stderr ? '\n' : '') + String(e?.message || e); });
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
    if (input !== undefined && child.stdin) { child.stdin.end(input); }
  });
}

const git = (args, opts = {}) => run('git', ['-C', opts.cwd || REPO, ...args], opts);

// Resilient JSON fetch to the handoff endpoint.
//
// Why this exists: a fix can take MINUTES (the Claude Code run) between claiming an
// issue and reporting the result. Node's global fetch (undici) pools keep-alive
// sockets; after that long idle gap the server has usually closed the pooled socket,
// so the *first* request afterwards — the success report — reuses a dead socket and
// rejects with the opaque `TypeError: fetch failed` (cause ECONNRESET / "other side
// closed"). The next request gets a fresh socket and works, which is exactly why the
// failure report always lands while the success report didn't.
//
// We defend on three fronts: send `Connection: close` so no socket is ever pooled,
// retry connection-level failures on a fresh connection, and — if we still give up —
// surface the underlying cause so the recorded message is actionable instead of just
// "fetch failed".
//
// Every attempt also carries an AbortSignal timeout: on links that drop connections
// silently (no RST — e.g. Starlink/CGNAT), a fetch can otherwise hang FOREVER, turning
// the runner into a zombie the portal still shows as "working". Netlify functions cap
// out well under a minute, so anything slower is a dead connection, not a slow server.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60000);
async function apiFetch(url, init = {}, { tries = 3, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...init,
        headers: { Connection: 'close', ...(init.headers || {}) },
      });
    } catch (e) {
      lastErr = e;
      const cause = e?.cause;
      const code = cause?.code || cause?.message || '';
      log(`  ${label} fetch attempt ${attempt}/${tries} failed: ${e.message}${code ? ` (${code})` : ''}`);
      if (attempt < tries) await sleep(500 * attempt);
    }
  }
  const cause = lastErr?.cause;
  const detail = cause ? ` — ${cause.code || cause.message || String(cause)}` : '';
  throw new Error(`${lastErr?.message || 'fetch failed'}${detail}`);
}

async function claimNext() {
  const res = await apiFetch(`${ENDPOINT}?action=claim`, {
    headers: { 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
  }, { label: 'claim' });
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.issue || null;
}

// While a fix runs (minutes), ping the server so the issue's heartbeat and this runner's
// liveness row stay fresh. That's what lets the server tell "busy on a long fix" from "died
// mid-fix": a silent runner past the reclaim window gets its issue re-queued and its panel row
// pruned. tries:1 so a slow beat never stacks; a missed beat is harmless (the next one covers).
const FIX_HEARTBEAT_MS = Number(process.env.AURA_FIX_HEARTBEAT_MS || 60000);
async function sendFixHeartbeat(id) {
  try {
    await apiFetch(`${ENDPOINT}?action=fix-heartbeat&id=${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
      body: JSON.stringify({ activeAccount: activeClaudeAccount() }),
    }, { tries: 1, label: 'fix-heartbeat' });
  } catch (e) { log(`#${id} heartbeat error: ${e.message}`); }
}

async function report(id, payload) {
  const res = await apiFetch(`${ENDPOINT}?id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN },
    body: JSON.stringify(payload),
  }, { label: 'report' });
  if (!res.ok) throw new Error(`report failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function claimMerge() {
  const res = await apiFetch(`${ENDPOINT}?action=claim-merge`, {
    headers: { 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
  }, { label: 'claim-merge' });
  if (!res.ok) throw new Error(`claim-merge failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.issue || null;
}

async function reportMerge(id, payload) {
  const res = await apiFetch(`${ENDPOINT}?id=${id}&action=merge-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN },
    body: JSON.stringify(payload),
  }, { label: 'merge-result' });
  if (!res.ok) throw new Error(`merge-result failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Session-limit block / resume protocol ────────────────────────────────────
// The raw oauthAccount object from the CLI's own config (~/.claude.json) — there is no
// non-interactive `claude` command that prints it. Best-effort: null when unreadable.
function oauthAccountInfo() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    return cfg?.oauthAccount || null;
  } catch { return null; }
}

// Which Claude account the CLI is logged into on THIS machine right now, as a display label.
// Sent with block/resume traffic so the portal can show the admin whether the re-login (or
// portal-requested account switch) actually took effect. Best-effort: null when unreadable.
function activeClaudeAccount() {
  const acct = oauthAccountInfo();
  if (!acct) return null;
  const email = acct.emailAddress || null;
  const org = acct.organizationName || null;
  const label = email ? (org && org !== email ? `${email} (${org})` : email) : org;
  return label ? String(label).slice(0, 200) : null;
}

// ── Claude CLI credential snapshots (portal-driven account switching) ─────────
// The portal's "Switch CLI to <account>" button can't run an interactive OAuth login, so the
// runner keeps a per-account snapshot of the CLI's stored credential, taken automatically
// whenever an account is seen logged in. Switching = save the live credential back to its
// snapshot, restore the target's snapshot, patch ~/.claude.json's oauthAccount, then verify
// with a probe call. Each account therefore needs ONE ordinary `claude auth login` on this
// machine ever; after that it can be switched to with a click.
//
// Storage matches what the CLI itself uses: on macOS the login lives in the user Keychain
// (service "Claude Code-credentials"), so snapshots are stored as sibling Keychain items —
// same protection as the CLI's own copy. Elsewhere the CLI uses ~/.claude/.credentials.json,
// and snapshots are 0600 files next to it. Only account *labels* are ever sent to the portal.
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SNAPSHOT_KEYCHAIN_SERVICE = 'Claude Code-credentials.aura-snapshot';
const CREDS_FILE = join(homedir(), '.claude', '.credentials.json');
const SNAPSHOT_DIR = join(homedir(), '.claude', 'aura-account-snapshots');
const SNAPSHOT_INDEX = join(SNAPSHOT_DIR, 'index.json'); // emails only — never credentials
// Accounts the admin rotates between (comma-separated emails). Optional: purely additive —
// it lets the portal show not-yet-seeded accounts greyed out so the admin knows a one-time
// login is still needed. Accounts NOT listed here still work once they've been seen once.
const EXPECTED_ACCOUNTS = (process.env.AURA_CLAUDE_ACCOUNTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const useKeychain = process.platform === 'darwin' && !existsSync(CREDS_FILE);
const security = (args, input) => run('security', args, input !== undefined ? { input } : {});

// The live CLI credential. Returns { blob, acctAttr } or throws with a readable reason.
function readLiveCredential() {
  if (useKeychain) {
    const r = security(['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w']);
    if (!r.ok) throw new Error(`could not read the CLI credential from the Keychain: ${r.stderr || 'not found'}`);
    // The item's account attribute (usually the macOS username) — reused when writing so we
    // update the CLI's item in place instead of creating a second one.
    const meta = security(['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE]);
    const acctAttr = (meta.stdout.match(/"acct"<blob>="([^"]*)"/) || [])[1] || userInfo().username;
    return { blob: r.stdout, acctAttr };
  }
  if (!existsSync(CREDS_FILE)) throw new Error(`no CLI credential found (${CREDS_FILE} missing — is the CLI logged in?)`);
  return { blob: readFileSync(CREDS_FILE, 'utf8'), acctAttr: null };
}

function writeLiveCredential(blob, acctAttr) {
  if (useKeychain) {
    const r = security(['add-generic-password', '-U',
      '-a', acctAttr || userInfo().username, '-s', CLAUDE_KEYCHAIN_SERVICE, '-w', blob]);
    if (!r.ok) throw new Error(`could not write the CLI credential to the Keychain: ${r.stderr}`);
    return;
  }
  writeFileSync(CREDS_FILE, blob);
  chmodSync(CREDS_FILE, 0o600);
}

const snapshotFile = (email) => join(SNAPSHOT_DIR, `${email.replace(/[^a-z0-9@._+-]/gi, '_')}.json`);

function readSnapshot(email) {
  if (useKeychain) {
    const r = security(['find-generic-password', '-s', SNAPSHOT_KEYCHAIN_SERVICE, '-a', email, '-w']);
    if (!r.ok) return null;
    try { return JSON.parse(r.stdout); } catch { return null; }
  }
  try { return JSON.parse(readFileSync(snapshotFile(email), 'utf8')); } catch { return null; }
}

function writeSnapshot(email, snap) {
  const blob = JSON.stringify(snap);
  if (useKeychain) {
    const r = security(['add-generic-password', '-U', '-a', email, '-s', SNAPSHOT_KEYCHAIN_SERVICE, '-w', blob]);
    if (!r.ok) throw new Error(`could not store the credential snapshot for ${email}: ${r.stderr}`);
  } else {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(snapshotFile(email), blob);
    chmodSync(snapshotFile(email), 0o600);
  }
  // Track which accounts have snapshots (emails only) so we can enumerate without
  // dumping the keychain. Best-effort — a lost index just means re-seeding the list.
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const idx = new Set(storedAccountEmails());
    idx.add(email.toLowerCase());
    writeFileSync(SNAPSHOT_INDEX, JSON.stringify({ emails: [...idx].sort() }, null, 2));
  } catch (e) { log(`⚠ could not update the snapshot index: ${e.message}`); }
}

function storedAccountEmails() {
  try { return (JSON.parse(readFileSync(SNAPSHOT_INDEX, 'utf8')).emails || []).map((e) => String(e).toLowerCase()); }
  catch { return []; }
}

// [{email, stored}] for the portal: every account we hold a snapshot for, plus any expected
// (AURA_CLAUDE_ACCOUNTS) account that hasn't been seeded yet, plus whatever is live right now.
function listKnownAccounts() {
  const stored = new Set(storedAccountEmails());
  const live = (oauthAccountInfo()?.emailAddress || '').toLowerCase();
  if (live) stored.add(live); // live login is snapshotted on sight, treat as stored
  const all = new Set([...stored, ...EXPECTED_ACCOUNTS]);
  return [...all].sort().map((email) => ({
    email,
    stored: stored.has(email),
    // A stored account whose last probe found a dead login: still snapshotted, but the snapshot
    // no longer authenticates, so it needs a one-time re-login rather than a click-to-switch.
    ...(staleAccounts.has(email) && email !== live ? { stale: true } : {}),
  }));
}

// Save the live login under its own email so it can be switched back to later.
// Called on startup, after successful probes, and before every switch-away.
function snapshotActiveAccount() {
  const acct = oauthAccountInfo();
  const email = (acct?.emailAddress || '').toLowerCase();
  if (!email) return null;
  try {
    const live = readLiveCredential();
    writeSnapshot(email, { credential: live.blob, acctAttr: live.acctAttr, oauthAccount: acct, savedAt: new Date().toISOString() });
    staleAccounts.delete(email); // a fresh snapshot means this login is good again
    return email;
  } catch (e) {
    log(`⚠ could not snapshot the active Claude account (${email}): ${e.message}`);
    return null;
  }
}

// Swap the CLI's stored login to `target` (an email). Throws with a portal-friendly message
// when the target has never been seeded. Does NOT probe — the caller verifies and acks.
function switchClaudeAccount(target) {
  const email = target.trim().toLowerCase();
  const snap = readSnapshot(email);
  if (!snap || !snap.credential) {
    throw new Error(`No stored login for ${email} on the runner machine. Log into it once there (claude auth login) — it is snapshotted automatically and switchable from then on.`);
  }
  snapshotActiveAccount(); // keep the outgoing account's freshest tokens
  writeLiveCredential(snap.credential, snap.acctAttr);
  // Point the CLI's config at the switched-in account so it doesn't mix identities.
  if (snap.oauthAccount) {
    const cfgPath = join(homedir(), '.claude.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.oauthAccount = snap.oauthAccount;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
}

// Tell the portal this runner is rate-limited (it re-queues the issue + prompts the admin).
async function reportBlocked(id, payload) {
  const res = await apiFetch(`${ENDPOINT}?action=report-blocked&id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
    body: JSON.stringify(payload),
  }, { label: 'report-blocked' });
  if (!res.ok) throw new Error(`report-blocked failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Control poll: while paused it asks whether an admin pressed "Resume runner" / "Restart
// runner"; on every healthy main-loop pass it doubles as the liveness heartbeat that keeps the
// portal's Runner panel (active account + switchable accounts) current. Also delivers a pending
// "Switch CLI to <account>" request. Returns { resume, restart, switchAccount }.
let _lastSnapshottedEmail = null;
async function checkResume() {
  // A different account logged in since we last looked (e.g. the admin just seeded one of
  // the rotation accounts by hand) — snapshot it immediately so it becomes switchable
  // without waiting for a probe or restart.
  const liveEmail = (oauthAccountInfo()?.emailAddress || '').toLowerCase();
  if (liveEmail && liveEmail !== _lastSnapshottedEmail) {
    if (snapshotActiveAccount()) log(`📸 snapshotted Claude account ${liveEmail} — now switchable from the portal.`);
    _lastSnapshottedEmail = liveEmail;
  }
  const acct = activeClaudeAccount();
  const accounts = encodeURIComponent(JSON.stringify(listKnownAccounts()));
  const res = await apiFetch(`${ENDPOINT}?action=resume-check${acct ? `&account=${encodeURIComponent(acct)}` : ''}&accounts=${accounts}`, {
    headers: { 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
  }, { label: 'resume-check' });
  if (!res.ok) throw new Error(`resume-check failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    resume: data.resume === true,
    restart: data.restart === true,
    switchAccount: typeof data.switchAccount === 'string' && data.switchAccount.trim() ? data.switchAccount.trim() : null,
  };
}

// Admin pressed "Restart runner" in the portal. Under launchd (KeepAlive) simply exiting is
// the restart — launchd relaunches the service within its ThrottleInterval. When run by hand
// in a terminal there is no supervisor, so spawn a detached fresh copy of ourselves first.
// The server already deleted our status row; the new process re-reports if still blocked.
function restartSelf() {
  log('🔄 restart requested from the admin portal.');
  if (process.env.AURA_RUNNER_SUPERVISED === '1') {
    log('  supervised by launchd — exiting; KeepAlive relaunches a fresh process (~30s).');
    process.exit(0);
  }
  log('  not supervised — re-spawning a fresh copy of this script…');
  const child = spawn(process.argv[0], process.argv.slice(1), {
    detached: true, stdio: 'inherit', cwd: process.cwd(), env: process.env,
  });
  child.unref();
  process.exit(0);
}

// Report the result of the post-Resume login probe: ok:true clears the block server-side.
async function ackResume(ok, message) {
  const res = await apiFetch(`${ENDPOINT}?action=resume-ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
    body: JSON.stringify({ ok, message, activeAccount: activeClaudeAccount() }),
  }, { label: 'resume-ack' });
  if (!res.ok) throw new Error(`resume-ack failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Report the result of a portal-requested account switch. ok:true also clears a
// session-limit block server-side (a verified switch doubles as a successful Resume).
async function ackSwitch(ok, message) {
  const res = await apiFetch(`${ENDPOINT}?action=switch-ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-handoff-token': TOKEN, 'x-runner-id': RUNNER_ID },
    body: JSON.stringify({ ok, message, activeAccount: activeClaudeAccount(), knownAccounts: listKnownAccounts() }),
  }, { label: 'switch-ack' });
  if (!res.ok) throw new Error(`switch-ack failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Execute a "Switch CLI to <account>" request end-to-end: swap the stored credential,
// verify with a probe, report the outcome. Returns true when the switch produced a
// working login (which also means any session-limit pause is over).
async function handleSwitch(target) {
  log(`🔁 portal requested a Claude account switch → ${target}`);
  try {
    switchClaudeAccount(target);
  } catch (e) {
    log(`✗ switch failed before probing: ${e.message}`);
    await ackSwitch(false, e.message).catch((ae) => log(`  switch-ack error: ${ae.message}`));
    return false;
  }
  const probe = probeClaude();
  if (probe.ok) {
    staleAccounts.delete(target.trim().toLowerCase());
    snapshotActiveAccount(); // freshen the switched-in account's snapshot too
    log(`✓ switched to ${target} — Claude login verified.`);
    await ackSwitch(true, `Switched the CLI to ${target} and verified the login.`).catch((ae) => log(`  switch-ack error: ${ae.message}`));
    return true;
  }
  // A dead login (vs. a rate limit) can't be fixed by another switch — flag it so the portal
  // shows "login expired — re-login on runner" instead of a Switch button that would re-fail.
  if (isLoggedOut(probe.out)) staleAccounts.add(target.trim().toLowerCase());
  const why = probe.limited
    ? (probe.out.match(/[^\n]*(?:session|usage|rate)\s+limit[^\n]*/i) || [`${target} is also rate-limited.`])[0].trim()
    : isLoggedOut(probe.out)
      ? `its saved login has expired — re-login once on the runner machine (claude auth login as ${target}).`
      : `probe call failed: ${probe.out.slice(0, 200) || 'no output'}`;
  log(`✗ switched credentials to ${target}, but ${why}`);
  await ackSwitch(false, `Switched the CLI to ${target}, but ${why}`).catch((ae) => log(`  switch-ack error: ${ae.message}`));
  return false;
}

// Keep-warm pass: OAuth tokens die if an account sits unused, which is why a later "Switch CLI
// to <acct>" can land on "Not logged in". To prevent that, periodically visit every stored account
// that isn't the active one — switch to it, probe (which refreshes its token), re-snapshot the
// refreshed credential — then return to the account we started on. Accounts that come back logged
// out are flagged stale (they genuinely need a one-time re-login); rate-limited ones are left be.
// Only runs when the runner is idle (called from the main loop's idle branch), never mid-fix.
let _lastRefreshAt = 0;
async function maybeRefreshStoredAccounts() {
  if (Date.now() - _lastRefreshAt < ACCOUNT_REFRESH_MS) return;
  _lastRefreshAt = Date.now(); // stamp up front so a failing pass doesn't retry in a tight loop
  const originalActive = (oauthAccountInfo()?.emailAddress || '').toLowerCase();
  const targets = listKnownAccounts()
    .filter((a) => a.stored && a.email !== originalActive)
    .map((a) => a.email);
  if (!targets.length) return;
  log(`♻ keep-warm: refreshing ${targets.length} stored Claude account(s) so they stay switchable…`);
  snapshotActiveAccount(); // capture the active account first so we can return to it
  for (const email of targets) {
    if (stopping) break;
    try {
      switchClaudeAccount(email);
    } catch (e) {
      log(`  ⚠ ${email}: ${e.message}`);
      continue;
    }
    const probe = probeClaude();
    if (probe.ok) {
      snapshotActiveAccount(); // re-snapshot with the freshly refreshed token
      log(`  ✓ ${email} refreshed`);
    } else if (probe.limited) {
      log(`  • ${email} rate-limited — login still valid, left as is`);
    } else if (isLoggedOut(probe.out)) {
      staleAccounts.add(email);
      log(`  ⚠ ${email} login expired — needs a one-time re-login on this machine (claude auth login)`);
    } else {
      log(`  ⚠ ${email} probe failed: ${probe.out.slice(0, 120) || 'no output'}`);
    }
  }
  // Return to whatever account the runner was using before the pass.
  if (originalActive) {
    try {
      switchClaudeAccount(originalActive);
      const back = probeClaude();
      if (back.ok) snapshotActiveAccount();
      log(`♻ keep-warm done — active account restored to ${originalActive}`);
    } catch (e) {
      log(`  ✗ keep-warm could not restore the active account (${originalActive}): ${e.message}`);
    }
  }
}

const SQL_START = '---SQL-MIGRATION-START---';
const SQL_END = '---SQL-MIGRATION-END---';

// The ticket thread as prompt lines. On retries this carries the reporter's
// "why the previous fix didn't work" feedback plus the earlier attempt's summary —
// the most important context the fixer has, so it must not be dropped.
function threadLines(issue) {
  const thread = Array.isArray(issue.thread) ? issue.thread.filter((m) => m && m.body) : [];
  if (thread.length === 0) return [];
  return [
    ``,
    `--- TICKET THREAD (oldest first; 'user' = the reporter, 'admin' = the team/AI) ---`,
    `The thread may include previous fix attempts and the reporter's feedback on why a fix`,
    `failed testing. Treat the LATEST reporter feedback as the current problem statement —`,
    `do not repeat an approach the thread says already failed.`,
    ...thread.map((m) => {
      const when = m.createdAt ? ` @ ${m.createdAt}` : '';
      const moved = m.status ? ` [status → ${m.status}]` : '';
      return `[${m.authorType}${when}]${moved}\n${m.body}`;
    }),
  ];
}

function buildPrompt(issue) {
  return [
    `You are an autonomous developer fixing a bug reported by a user of the Aura / "Be More Swan" app.`,
    `Work in the current repository. Make the smallest, safest change that fixes the issue.`,
    `Do NOT run any git commands and do NOT commit — only edit files. The harness handles git, the branch, and the pull request.`,
    ``,
    `DATABASE CHANGES: this project never uses drizzle-kit push — schema changes ship as idempotent hand-written SQL in db/*.sql, applied manually. If (and only if) your fix needs a database change:`,
    `  1. Add the idempotent SQL to the appropriate db/*.sql file (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded constraints), and update db/schema.ts to match.`,
    `  2. ALSO output the exact SQL to run, wrapped EXACTLY between these markers on their own lines:`,
    `       ${SQL_START}`,
    `       <the idempotent SQL>`,
    `       ${SQL_END}`,
    `  A super-admin will review and run that SQL against staging from the issue ticket. Omit the markers entirely if no DB change is needed.`,
    ``,
    `When you are done, end your reply with a short plain-text summary of the root cause and exactly what you changed (file names + why).`,
    ``,
    `--- ISSUE #${issue.id} ---`,
    `Reported by: ${issue.reporterName || 'a user'}`,
    `Location in app: ${issue.sourceLocation || 'unknown'}`,
    issue.sourceUrl ? `URL: ${issue.sourceUrl}` : '',
    issue.hasImage ? `(The reporter attached a screenshot, available in the admin portal.)` : '',
    ``,
    `Description:`,
    issue.description || '(no description provided)',
    ...threadLines(issue),
  ].filter(Boolean).join('\n');
}

// Split Claude's output into the migration SQL (between the markers) and the human
// summary (everything else, with any leftover ```sql fences from the block stripped).
function extractMigrationSql(out) {
  const start = out.indexOf(SQL_START);
  const end = out.indexOf(SQL_END);
  if (start === -1 || end === -1 || end < start) return { sql: null, summary: out.trim() };
  let sql = out.slice(start + SQL_START.length, end).trim();
  sql = sql.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim(); // tolerate fenced SQL
  const summary = (out.slice(0, start) + out.slice(end + SQL_END.length)).replace(/\n{3,}/g, '\n\n').trim();
  return { sql: sql || null, summary: summary || 'A fix has been produced.' };
}

async function processIssue(issue) {
  const id = issue.id;
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const branch = `fix/issue-${id}-${ts}`;
  let worktree = null;

  try {
    log(`#${id} fetching origin…`);
    git(['fetch', 'origin', '--quiet']);

    // Prefer the remote base branch; fall back to a local one.
    const baseRef = git(['rev-parse', '--verify', `origin/${BASE_BRANCH}`]).ok
      ? `origin/${BASE_BRANCH}` : BASE_BRANCH;

    worktree = mkdtempSync(join(tmpdir(), `aura-issue-${id}-`));
    log(`#${id} creating worktree on ${branch} from ${baseRef}`);
    const wt = git(['worktree', 'add', '-b', branch, worktree, baseRef]);
    if (!wt.ok) throw new Error(`worktree add failed: ${wt.stderr}`);

    log(`#${id} running Claude Code…`);
    // Heartbeat throughout the fix so the server knows this runner is alive (not stalled) —
    // fire one immediately, then on an interval, and always clear it when the run ends.
    sendFixHeartbeat(id);
    const heartbeat = setInterval(() => sendFixHeartbeat(id), FIX_HEARTBEAT_MS);
    let claude;
    try {
      claude = await runAsync(CLAUDE_BIN, ['-p', '--permission-mode', 'acceptEdits'], {
        cwd: worktree,
        input: buildPrompt(issue),
      });
    } finally {
      clearInterval(heartbeat);
    }
    const rawOut = claude.stdout || claude.stderr || 'No output from the AI runner.';
    if (!claude.ok) {
      const errText = `${claude.stderr || ''}\n${claude.stdout || ''}`;
      // A session/usage limit isn't this issue's fault — EVERY fix will fail until a Claude
      // account with credit is logged in. Park the whole runner and let the admin resume it,
      // rather than burning the issue as a normal failure (which just re-fails on re-queue).
      if (SESSION_LIMIT_RE.test(errText)) {
        const resetHint = (errText.match(/resets?\s+([^\n·]+?(?:\([^)]*\))?)\s*(?:[·\n]|$)/i) || [])[1]?.trim() || null;
        const message = (errText.match(/[^\n]*(?:session|usage|rate)\s+limit[^\n]*/i) || [errText.trim()])[0].trim().slice(0, 500);
        log(`#${id} ⏸ Claude session limit hit — pausing runner${resetHint ? ` (resets ${resetHint})` : ''}`);
        await reportBlocked(id, { message, resetHint, activeAccount: activeClaudeAccount() }).catch((e) => log(`#${id} ✖ could not report block: ${e.message}`));
        paused = true;
        return; // the finally block cleans up the worktree; the issue was re-queued server-side
      }
      throw new Error(`Claude Code exited ${claude.code}: ${claude.stderr || claude.stdout}`);
    }

    // Pull out the migration SQL (if any) and keep it out of the human summary.
    const { sql: migrationSql, summary } = extractMigrationSql(rawOut);
    if (migrationSql) log(`#${id} fix includes a DB migration (${migrationSql.length} chars) — will be run from the ticket`);

    // Did it actually change anything?
    const status = git(['status', '--porcelain'], { cwd: worktree });
    if (!status.stdout) {
      throw new Error(`Claude Code produced no file changes.\n\nAI notes:\n${summary}`);
    }

    log(`#${id} committing + pushing…`);
    const add = git(['add', '-A'], { cwd: worktree });
    if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
    const commit = git(['commit', '-m', `fix: issue #${id} (AI auto-fix)\n\n${summary}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`], { cwd: worktree });
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);
    const push = git(['push', '-u', 'origin', branch], { cwd: worktree });
    if (!push.ok) throw new Error(`git push failed: ${push.stderr}`);

    log(`#${id} opening pull request…`);
    const prBody = `Automated fix for reported issue #${id}.\n\n**Location:** ${issue.sourceLocation || 'unknown'}\n\n**Reported description:**\n${issue.description || ''}\n\n**AI summary:**\n${summary}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const pr = run('gh', ['pr', 'create', '--base', BASE_BRANCH, '--head', branch,
      '--title', `Fix: issue #${id} — ${(issue.sourceLocation || 'reported issue').slice(0, 60)}`,
      '--body', prBody], { cwd: worktree });
    const prUrl = pr.ok ? (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout : null;
    if (!pr.ok) log(`#${id} ⚠ gh pr create failed (branch still pushed): ${pr.stderr}`);

    log(`#${id} reporting success${prUrl ? ` — ${prUrl}` : ''}${migrationSql ? ' (+SQL pending)' : ''}`);
    await report(id, { ok: true, summary, branch, prUrl, sql: migrationSql });
    log(`#${id} ✓ done`);
  } catch (e) {
    log(`#${id} ✖ ${e.message}`);
    await report(id, { ok: false, summary: e.message }).catch((re) => log(`#${id} ✖ could not report failure: ${re.message}`));
  } finally {
    if (worktree) {
      git(['worktree', 'remove', '--force', worktree]);
      try { rmSync(worktree, { recursive: true, force: true }); } catch {}
    }
  }
}

// Merge an already-produced fix PR into staging with `gh pr merge`, then report back.
// Runs against the remote PR — no worktree/checkout needed. Branch cleanup is best-effort
// and never fails the merge.
async function processMerge(job) {
  const id = job.id;
  const target = job.prUrl || job.branch;
  try {
    if (!target) throw new Error('No pull request URL or branch to merge.');
    log(`#${id} merging ${target} into ${BASE_BRANCH}…`);
    git(['fetch', 'origin', '--quiet']);

    const m = run('gh', ['pr', 'merge', target, '--merge'], { cwd: REPO });
    const outcome = (m.stdout || m.stderr || '').trim();
    if (!m.ok) throw new Error(outcome || 'gh pr merge failed');

    // Best-effort: delete the merged branch on the remote. Ignore failures.
    if (job.branch) git(['push', 'origin', '--delete', job.branch]);

    log(`#${id} ✓ merged to ${BASE_BRANCH}`);
    await reportMerge(id, { ok: true, outcome: outcome || `Merged ${target} into ${BASE_BRANCH}.` });
    log(`#${id} ✓ merge reported`);
  } catch (e) {
    log(`#${id} ✖ merge failed: ${e.message}`);
    await reportMerge(id, { ok: false, outcome: e.message })
      .catch((re) => log(`#${id} ✖ could not report merge failure: ${re.message}`));
  }
}

// Run a cheap Claude call to confirm the CLI is authenticated to an account with credit.
// Uses a throwaway cwd so the model can't touch the repo. Returns { ok, out, limited }.
function probeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'aura-claude-probe-'));
  try {
    const r = run(CLAUDE_BIN, ['-p', '--permission-mode', 'acceptEdits'], {
      cwd: dir,
      input: 'Reply with exactly the two characters: ok',
    });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    const limited = SESSION_LIMIT_RE.test(out);
    return { ok: r.ok && !limited, out, limited };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Paused after a session limit: poll the portal until an admin presses "Resume runner", then
// verify the (hopefully re-logged-in) Claude account with a probe. Only a passing probe ends
// the pause; a still-limited probe reports back and keeps waiting for the next Resume.
async function waitForResume() {
  log('⏸ runner paused — Claude session limit. Log into an account with credit on THIS machine, then press "Resume runner" in the admin portal.');
  while (!stopping) {
    await sleep(RESUME_POLL_MS);
    let status;
    try { status = await checkResume(); }
    catch (e) { log(`  resume-check error: ${e.message}`); continue; }
    if (status.restart) restartSelf(); // does not return
    // "Switch CLI to <account>" pressed while paused: a verified switch IS the resume —
    // no separate Resume press needed. A failed one reports why and keeps waiting.
    if (status.switchAccount) {
      if (await handleSwitch(status.switchAccount)) {
        log('✓ account switch cleared the session-limit block — resuming normal operation.');
        return;
      }
      continue;
    }
    if (!status.resume) continue;

    log('▶ resume requested — verifying the Claude login…');
    const probe = probeClaude();
    if (probe.ok) {
      snapshotActiveAccount(); // the admin logged in by hand — capture it for future switches
      log('✓ Claude login verified — resuming normal operation.');
      await ackResume(true, 'Claude login verified; runner resumed.').catch((e) => log(`  resume-ack error: ${e.message}`));
      return;
    }
    const why = probe.limited
      ? (probe.out.match(/[^\n]*(?:session|usage|rate)\s+limit[^\n]*/i) || ['The Claude account is still rate-limited.'])[0].trim()
      : `Probe call failed: ${probe.out.slice(0, 200) || 'no output'}`;
    log(`✗ still not usable — ${why}. Waiting for another Resume.`);
    await ackResume(false, why).catch((e) => log(`  resume-ack error: ${e.message}`));
  }
}

async function main() {
  log(`dev-issue-fixer watching ${ENDPOINT}`);
  log(`runner=${RUNNER_ID} repo=${REPO} base=${BASE_BRANCH} poll=${POLL_MS}ms${ONCE ? ' once' : ''}`);
  process.on('SIGINT', () => { log('shutting down…'); stopping = true; });

  // Seed/refresh the live account's credential snapshot so it stays switchable-back-to.
  const seeded = snapshotActiveAccount();
  const known = listKnownAccounts();
  log(`claude account: ${activeClaudeAccount() || 'unknown'}${seeded ? ' (snapshot saved)' : ''}`);
  log(`switchable accounts: ${known.filter((a) => a.stored).map((a) => a.email).join(', ') || 'none yet'}${known.some((a) => !a.stored) ? ` · awaiting one-time login: ${known.filter((a) => !a.stored).map((a) => a.email).join(', ')}` : ''}`);

  while (!stopping) {
    // 0) Heartbeat + control signals (restart / account switch), even while healthy —
    //    this is what keeps the Runner panel live and its Switch buttons working
    //    without waiting for a session limit. Failures are non-fatal.
    try {
      const ctl = await checkResume();
      if (ctl.restart) restartSelf(); // does not return
      if (ctl.switchAccount) await handleSwitch(ctl.switchAccount);
    } catch (e) { log(`heartbeat error: ${e.message}`); }

    // 1) A fix to produce takes priority.
    let issue = null;
    try { issue = await claimNext(); }
    catch (e) { log(`poll error: ${e.message}`); }
    if (issue) {
      await processIssue(issue);
      // A session limit during the fix pauses the whole runner: no point claiming more work
      // while the CLI is rate-limited. Wait for the admin to re-login and press Resume.
      if (paused) {
        if (ONCE) { log('paused on session limit; exiting (ONCE).'); break; }
        await waitForResume();
        paused = false;
      }
      if (ONCE) break;
      continue; // immediately check for more
    }

    // 2) Otherwise, a fix that's been approved for merge to staging.
    let merge = null;
    try { merge = await claimMerge(); }
    catch (e) { log(`merge poll error: ${e.message}`); }
    if (merge) {
      await processMerge(merge);
      if (ONCE) break;
      continue;
    }

    if (ONCE) { log('nothing queued; exiting (ONCE).'); break; }

    // Idle: keep the inactive rotation accounts' logins warm so switching to them keeps working.
    // Non-fatal — a failed pass just means the next switch might still find a stale login.
    try { await maybeRefreshStoredAccounts(); }
    catch (e) { log(`keep-warm error: ${e.message}`); }

    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
