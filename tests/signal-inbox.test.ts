// tests/signal-inbox.test.ts
// Phase 1a of docs/lead-generator-revenue-engine-plan.md — the Signal Inbox.
//
// The two things worth pinning here, because neither is enforceable by types:
//   1. `isBatchable` must be true for EXACTLY 'ready'. Widening it is how the personal-inbox
//      protection becomes reachable by one click on 47 leads — the whole point of the class A/B
//      split in plan §2.3.
//   2. The composite cursor must order identically to the SQL ORDER BY. If they diverge, paging
//      silently drops or repeats rows, which looks like flaky data rather than a bug.
//
// No database — pure functions and the shared wire contract.
// Run:  npx tsx tests/signal-inbox.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SOURCE_KINDS, HANDOFF_STATES, isBatchable, resolveSourceLabel, savedSearchLabel,
    encodeCursor, decodeCursor, compareSignals, INBOX_PAGE_SIZE,
    AUTO_PROMOTE_THRESHOLD_DEFAULT, type Signal,
} from '../src/config/signal-sources';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnText = readFileSync(join(root, 'netlify/functions/signal-inbox.ts'), 'utf8');
const sqlText = readFileSync(join(root, 'db/signal-inbox-1a.sql'), 'utf8');
const componentText = readFileSync(join(root, 'src/components/assistant-signal-inbox.js'), 'utf8');

// ── 1. The batch gate ────────────────────────────────────────────────────────

check('ONLY `ready` is batchable — needs_review can never be bulk-approved', () => {
    for (const s of HANDOFF_STATES) {
        assert.equal(isBatchable(s), s === 'ready', `isBatchable('${s}') should be ${s === 'ready'}`);
    }
    assert.equal(isBatchable('needs_review'), false, 'THE load-bearing case: an anomaly must never batch');
    assert.equal(isBatchable(undefined), false);
    assert.equal(isBatchable('READY'), false, 'case-sensitive — no accidental widening');
});

check('the server re-checks the gate rather than trusting the client', () => {
    // The approve branch must re-read and re-classify. A client-supplied handoffStatus would make
    // the gate bypassable by editing a fetch body.
    const approveBranch = fnText.slice(fnText.indexOf("action === 'approve'"));
    assert.ok(approveBranch.includes('classifySignal(row)'),
        'approve must re-classify server-side from fresh rows');
    assert.ok(approveBranch.includes('isBatchable('),
        'approve must gate on isBatchable, not on anything the client sent');
});

check('the personal-inbox rule matches the one send_outreach enforces', () => {
    // Both surfaces must call the SHARED predicate rather than spelling the condition out. They
    // each used to test `emailSource === 'scrape'` literally, which was correct only while scraping
    // was the sole way an address arrived unattended — a PURCHASED address matches neither literal,
    // so a named individual bought from a broker would have been emailed with no confirmation at
    // all. Asserting on the predicate is what keeps the two in step through changes like that.
    assert.ok(fnText.includes('needsPersonalInboxConfirmation('),
        'the needs_review carve-out must go through the shared predicate, not a hand-written condition');
    assert.ok(!/emailSource === 'scrape'/.test(fnText),
        'a literal scrape test has come back — it waves through every non-scraped source');
});

check('signal ids are feed-prefixed so the two id spaces cannot collide', () => {
    assert.ok(fnText.includes('`search:${leadId}`'), 'saved-search ids must be prefixed');
    // A bare int must not parse — otherwise a social id could be approved as a search id.
    assert.ok(/\^search:\(\\d\+\)\$/.test(fnText.replace(/\\\\/g, '\\')),
        'parseSignalId must anchor on the search: prefix');
});

// ── 2. Cursor ────────────────────────────────────────────────────────────────

check('cursor round-trips', () => {
    const c = { occurredAt: '2026-08-02T10:00:00.000Z', id: 'search:42' };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
});

check('a malformed cursor decodes to null rather than throwing', () => {
    assert.equal(decodeCursor('not-base64!!'), null);
    assert.equal(decodeCursor(''), null);
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(Buffer.from('{}').toString('base64url')), null, 'missing fields');
    assert.equal(decodeCursor(Buffer.from(JSON.stringify({ occurredAt: 'nonsense', id: 'x' })).toString('base64url')), null,
        'an unparseable date must be rejected, not carried into a comparison');
});

check('compareSignals sorts newest first, id descending as tie-break', () => {
    const s = (occurredAt: string, id: string) => ({ occurredAt, id } as Signal);
    const rows = [
        s('2026-08-01T00:00:00.000Z', 'search:1'),
        s('2026-08-02T00:00:00.000Z', 'search:9'),
        s('2026-08-02T00:00:00.000Z', 'search:10'),
    ];
    const sorted = [...rows].sort(compareSignals).map((r) => r.id);
    assert.equal(sorted[0], 'search:9', 'newest first; "search:9" > "search:10" as a STRING tie-break');
    assert.equal(sorted[2], 'search:1', 'oldest last');
});

check('the function orders by (created_at DESC, id DESC) to match the cursor', () => {
    assert.ok(fnText.includes('desc(discoveredLeads.createdAt)') && fnText.includes('desc(discoveredLeads.id)'),
        'SQL ordering must match compareSignals or paging drops rows');
});

// ── 3. Labels ────────────────────────────────────────────────────────────────

check('the source label is "<Assistant> Search" and degrades safely', () => {
    assert.equal(resolveSourceLabel('Nadia'), 'Nadia Search');
    assert.equal(resolveSourceLabel('  Nadia  '), 'Nadia Search', 'trimmed');
    assert.equal(resolveSourceLabel(''), 'Saved search', 'no name → generic, never " Search"');
    assert.equal(resolveSourceLabel(null), 'Saved search');
});

check('the label is resolved at read time, never stored', () => {
    // Storing it would leave historical signals labelled with an assistant's OLD name after a rename.
    assert.ok(fnText.includes('resolveSourceLabel(assistant.name)'),
        'signal-inbox must derive the label from the live assistant row on every read');
    assert.ok(!/sourceLabel:\s*discoveredLeads\./.test(fnText) && !sqlText.includes('source_label'),
        'no persisted source_label column may exist');
});

check('an unnamed saved search falls back to a truncated idea', () => {
    assert.equal(savedSearchLabel('UK retreat venues', 'anything'), 'UK retreat venues');
    assert.equal(savedSearchLabel('', 'Short idea'), 'Short idea');
    assert.equal(savedSearchLabel(null, null), 'Untitled search');
    const long = 'Country-house and estate venues in the UK hosting corporate retreats with no online booking';
    const out = savedSearchLabel(null, long);
    assert.ok(out.length <= 42, `truncated to ${out.length}`);
    assert.ok(out.endsWith('…'), 'truncation is visible');
});

// ── 4. Standalone operation (plan §1.6) ──────────────────────────────────────

check('the inbox works with ONLY a Lead Generator hired', () => {
    assert.ok(fnText.includes('hasSocialFeed'),
        'the response must tell the client whether a social feed exists');
    assert.ok(fnText.includes("roleKey, 'social_media_manager'"),
        'social presence is detected, not assumed');
    // The saved-search feed must not be conditional on the social one.
    const listBranch = fnText.slice(fnText.indexOf("action === 'list'"), fnText.indexOf("action === 'approve'"));
    assert.ok(listBranch.includes('discoveredLeads'), 'saved-search signals are read unconditionally');
});

check('no social assistant shows an OFFER, never an empty state', () => {
    assert.ok(componentText.includes('!state.hasSocialFeed'),
        'the upsell footer is conditional on the social feed being absent');
    assert.ok(componentText.includes('needs a Social Media Assistant'),
        'the copy offers rather than nags');
});

check('auto-promotion is OFF by default', () => {
    // Shipping it on would bulk-promote the existing backlog on deploy — an unrequested,
    // effectively irreversible action. 75 is a suggestion, not an active default.
    assert.equal(AUTO_PROMOTE_THRESHOLD_DEFAULT, null);
});

// ── 5. Projection, not duplication ───────────────────────────────────────────

check('saved-search signals are projected, never written as rows', () => {
    assert.ok(!/insert\s*\(\s*signals/i.test(fnText), 'the inbox must not write signal rows');
    assert.ok(!sqlText.includes('CREATE TABLE') || !/CREATE TABLE[^;]*signals/i.test(sqlText),
        'Phase 1a introduces no signals table — discovered_leads stays the source of truth');
});

check('the migration is additive and idempotent', () => {
    assert.ok(sqlText.includes('ADD COLUMN IF NOT EXISTS name'), 'name column guarded');
    assert.ok(sqlText.includes('ADD COLUMN IF NOT EXISTS signals_published_at'), 'stamp column guarded');
    assert.ok(sqlText.includes('CREATE INDEX IF NOT EXISTS'), 'index guarded');
    assert.ok(!/\bUPDATE\b|\bDELETE\b/i.test(sqlText.replace(/--.*$/gm, '')),
        'Phase 1a moves no data — both columns are nullable with no backfill');
});

// ── 6. Notification idempotency ──────────────────────────────────────────────

check('one notification per RUN, claimed conditionally so a retry cannot double-notify', () => {
    const worker = readFileSync(join(root, 'netlify/functions/process-discovery-jobs.ts'), 'utf8');
    assert.ok(worker.includes('isNull(discoveryJobs.signalsPublishedAt)'),
        'the publish must be claimed by a conditional UPDATE, not a read-then-write');
    assert.ok(worker.includes('claimed.length === 0'),
        'a caller that did not win the claim must return without notifying');
    assert.ok(worker.includes("createNotification(db, 'search_signals_published'"),
        'the run-completion notification must go through notify.ts, the single write path');
});

check('the notification template exists with the variables the call site supplies', () => {
    const cat = readFileSync(join(root, 'src/utils/notification-templates-catalog.ts'), 'utf8');
    assert.ok(cat.includes("templateKey: 'search_signals_published'"), 'template registered');
    for (const v of ['search.name', 'search.companies', 'assistant.name']) {
        assert.ok(cat.includes(v), `template must declare ${v}`);
    }
    // The copy must not leak "signal" — our internal word for a row in this tab. A notification
    // arrives with none of the tab's explanatory copy around it, so it has to name the thing the
    // user recognises (a company) and the tab they can find (Searches).
    // Only the title/message lines — templateKey and type legitimately keep the internal name.
    const tpl = cat.slice(cat.indexOf("templateKey: 'search_signals_published'"));
    const body = tpl.slice(0, tpl.indexOf('variables:'));
    const copy = body.split('\n').filter((l) => /^\s*(title|message):/.test(l)).join('\n');
    assert.ok(copy.includes('title:') && copy.includes('message:'), 'found both copy lines');
    assert.ok(!/signal/i.test(copy), 'user-facing copy must not use the word "signal"');
    assert.ok(copy.includes('Searches'), 'copy must name the tab by its user-facing label');
});

// ── 7. Wire contract ─────────────────────────────────────────────────────────

check('vocabularies are unique and the page size is sane', () => {
    assert.equal(new Set(SOURCE_KINDS).size, SOURCE_KINDS.length);
    assert.equal(new Set(HANDOFF_STATES).size, HANDOFF_STATES.length);
    assert.ok(INBOX_PAGE_SIZE > 0 && INBOX_PAGE_SIZE <= 50,
        'a page big enough to make batch approve a reflex defeats the gate');
});

check('a missing migration reports MIGRATION_PENDING, not a generic failure', () => {
    assert.ok(fnText.includes('MIGRATION_PENDING'),
        'the most likely post-deploy failure needs an actionable code');
    assert.ok(componentText.includes('MIGRATION_PENDING'),
        'and the client must explain it rather than showing a generic error');
});

console.log(`\n${passed} checks passed.`);
