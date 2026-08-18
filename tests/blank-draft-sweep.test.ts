// tests/blank-draft-sweep.test.ts
// Abandoned blank drafts must be collected — and the sweep must never reach a row holding human work.
//
// Run:  npx tsx tests/blank-draft-sweep.test.ts
//
// A SOURCE-level invariant test, same spirit as reject-regeneration.test.ts and for the same reason:
// every failure mode here is silent. A sweep that is too narrow leaks rows forever and looks fine; a
// sweep that is too wide deletes someone's half-written post and also looks fine. Neither produces an
// error, so the predicate itself is what gets asserted.
//
// The bug this closes: create-manual-post.ts inserts a blank 'draft' row so the three-pane editor has
// something to edit, and NOTHING deleted it. The only two deletes on scheduled_posts in the whole
// repo were archive-cleanup's rejected sweep and set-post-platforms' de-selection.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const cleanup = read('netlify/functions/archive-cleanup.ts');

/**
 * The file with its prose removed — block comments, `//` lines and the `--` lines inside the SQL.
 *
 * Needed because this file EXPLAINS the things it must not do, so a naive substring match reads the
 * warning against reviving a behaviour as the behaviour itself. Assert against code; keep the
 * comments free to name what they are warning about.
 */
const cleanupCode = cleanup
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
const createManualPost = read('netlify/functions/create-manual-post.ts');
const gapFill = read('src/utils/schedule-gap-fill.ts');

console.log('\nAbandoned blank draft sweep\n');

// ── The sweep exists and runs ────────────────────────────────────────────────────────────────────

check('archive-cleanup collects blanks as well as rejected posts', () => {
    assert.ok(
        /async function sweepAbandonedBlanks\s*\(/.test(cleanup),
        'sweepAbandonedBlanks is gone — blank drafts accumulate forever again'
    );
    assert.ok(
        /const blanks = await sweepAbandonedBlanks\(/.test(cleanup),
        'sweepAbandonedBlanks is defined but never called'
    );
});

check('an empty archive sweep does not skip the blank sweep', () => {
    // The original handler early-returned on `if (!expired.length)`, which sat ABOVE everything else.
    // Restoring that shape would silently disable the blank sweep on every day with nothing to
    // archive — i.e. most days — while the function still reported success.
    const handlerStart = cleanup.indexOf('export default withLambda');
    const blankCall = landmark(cleanup, 'await sweepAbandonedBlanks(');
    const earlyReturn = cleanup.indexOf('if (!expired.length)');
    assert.ok(handlerStart >= 0 && blankCall > handlerStart, 'blank sweep is not inside the handler');
    assert.ok(
        earlyReturn === -1 || earlyReturn > blankCall,
        'an early return on an empty archive sweep sits before the blank sweep and skips it'
    );
});

// ── The safety rule: emptiness, checked on every reference ───────────────────────────────────────

check('a swept row has no caption and no hashtags', () => {
    assert.ok(
        /btrim\(coalesce\(sp\.caption, ''\)\) = ''/.test(cleanup),
        'the caption emptiness guard is missing — a written post can be swept'
    );
    assert.ok(
        /btrim\(coalesce\(sp\.hashtags, ''\)\) = ''/.test(cleanup),
        'the hashtags emptiness guard is missing'
    );
});

check('media is checked against BOTH reference sources', () => {
    // release-post-media.ts documents why: scheduled_post_assets is the source of truth, but the
    // deprecated content_asset_ids array still holds the oldest rows and is what publish time reads.
    // Checking one and not the other is exactly how post media went unreclaimed for months.
    assert.ok(
        /NOT EXISTS\s*\(\s*SELECT 1 FROM scheduled_post_assets spa/.test(cleanup),
        'the junction-table media guard is missing — a post with attached media can be swept'
    );
    assert.ok(
        /jsonb_array_length\(sp\.content_asset_ids\) = 0/.test(cleanup),
        'the legacy content_asset_ids media guard is missing'
    );
});

check('the jsonb read is guarded by jsonb_typeof', () => {
    // jsonb_array_length() on a non-array ERRORS. content_asset_ids has no shape constraint, so one
    // malformed row would abort the entire sweep rather than being skipped — the same trap
    // release-post-media.ts documents for its CROSS JOIN LATERAL.
    const arm = cleanup.slice(landmark(cleanup, 'WITH untouched AS'), landmark(cleanup, 'LIMIT ${limit}'));
    assert.ok(
        /jsonb_typeof\(sp\.content_asset_ids\) <> 'array'/.test(arm),
        'jsonb_array_length is called without a jsonb_typeof guard; one malformed row kills the sweep'
    );
    assert.ok(
        landmark(arm, 'jsonb_typeof') < landmark(arm, 'jsonb_array_length'),
        'the typeof guard must be ORed BEFORE the length read to short-circuit it'
    );
});

check('the age gate uses created_at, never updated_at', () => {
    // updated_at only moves when a writer explicitly sets it, and ~30 functions update
    // scheduled_posts. created_at is immutable and always set, so it cannot under-report activity.
    // ⚠️ The COLUMN is what this check is about, so the binding is matched loosely. It used to pin
    // the exact text `${cutoff}` and went red when that Date was converted to `${cutoff.toISOString()}`
    // — a fix for a real outage (postgres-js throws ERR_INVALID_ARG_TYPE binding a Date into a raw
    // template, so this sweep had never completed a run). A test that pins the serialisation of a
    // value it does not care about blocks the repair of a bug it never checked for; the binding has
    // its own guard in tests/raw-sql-date-params.test.ts.
    assert.ok(
        /sp\.created_at\s*<\s*\$\{cutoff/.test(cleanup),
        'the blank sweep lost its created_at age gate — an open composer can be deleted'
    );
    assert.ok(
        !/updated_at\s*<\s*\$\{cutoff/.test(cleanup),
        'the sweep gates on updated_at, which is not reliably bumped by every writer'
    );
});

// ── Cross-post groups are all-or-nothing ─────────────────────────────────────────────────────────

check('a cross-post group is swept only when every member qualifies', () => {
    assert.ok(
        /u\.crosspost_group_id IS NULL/.test(cleanup) &&
        /sib\.id NOT IN \(SELECT id FROM untouched\)/.test(cleanup),
        'the group guard is missing — the empty siblings of a started post can be swept individually'
    );
});

// ── No sweep may key on is_revised ───────────────────────────────────────────────────────────────

check('nothing sweeps on is_revised', () => {
    // A legacy-clone arm was written here and removed: introspected 2026-08-05, both staging and prod
    // hold zero `status='draft' AND is_revised` rows, so it was a daily query against a set proven
    // empty. Reviving it is a mistake in a specific direction — 'draft' + is_revised is no longer a
    // dead combination reserved for pre-2026-07-31 clones, so a sweep keying on it could one day
    // delete a live revision. Hand-delete a stray instead.
    assert.ok(
        !/isRevised/.test(cleanupCode) && !/is_revised/.test(cleanupCode),
        'archive-cleanup keys on is_revised again; see this check for why that is unsafe'
    );
});

// ── Media release still precedes the delete ──────────────────────────────────────────────────────

check('media is released before the rows are deleted', () => {
    const release = cleanup.indexOf('await releasePostMedia(db, ids)');
    const del = cleanup.indexOf('db.delete(scheduledPosts)');
    assert.ok(release >= 0 && del >= 0, 'release or delete step is missing');
    assert.ok(
        release < del,
        'scheduled_post_assets cascades on delete — releasing after it leaves the assets undiscoverable'
    );
    assert.ok(
        /const ids = collected\.map/.test(cleanup),
        'the release runs on `expired` only — it must cover every swept row, so that loosening the ' +
        'emptiness predicate can never silently start leaking media'
    );
});

// ── The premises this sweep was designed against ─────────────────────────────────────────────────
// If either of these changes, the sweep's shape needs revisiting rather than silently drifting.

check('create-manual-post still parks blanks at draft with a placeholder date', () => {
    assert.ok(
        /status: blank \? 'draft' : 'pending_approval'/.test(createManualPost),
        "blanks no longer land at 'draft' — the sweep selects on that status"
    );
});

check("schedule-gap-fill still counts 'draft' as coverage only within the future window", () => {
    // This is why the sweep is row hygiene and not a slot fix: a blank's `now + 24h` placeholder
    // falls out of the `publishDate >= now` filter after a day and stops holding a slot by itself.
    assert.ok(
        /status IN \('draft','pending_approval'/.test(gapFill),
        "gap-fill no longer counts 'draft' as coverage — re-read the sweep's stated scope"
    );
    assert.ok(
        /gte\(scheduledPosts\.publishDate, now\)/.test(gapFill),
        'gap-fill lost its future-window filter; blanks would now hold slots forever and the sweep ' +
        'timing (7 days) becomes user-visible rather than cosmetic'
    );
});

console.log(`\n${passed}/${total} passed\n`);
if (passed !== total) process.exit(1);
