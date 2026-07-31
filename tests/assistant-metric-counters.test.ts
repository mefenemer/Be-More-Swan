// tests/assistant-metric-counters.test.ts
//
// The Created / Scheduled / Published tiles on the assistant Overview card, and why they used to
// disagree with every other screen showing the same work.
//
// Two independent bugs, both of which made the tiles read HIGHER than the Review Queue:
//
//   • VOCABULARY — 'pending_approval' and 'in_review' were in the SCHEDULED list, so a draft
//     waiting on the user was reported as booked to go out. "Scheduled" is a promise; a draft is
//     not one.
//   • GRANULARITY — the totals counted scheduled_posts ROWS. A cross-post is one row per platform
//     sharing a crosspost_group_id, so a single post fanned to four platforms counted four times.
//     Observed on a real assistant: the Scheduled tile read 49 against a Scheduled tab of 9.
//
// The per-platform breakdown deliberately still counts rows — splitting a cross-post back into its
// sends is the only thing that block has to say. So the two genuinely disagree, and the fix was to
// LABEL that rather than to force them equal. The label assertions below are part of the fix, not
// decoration: an unexplained 9-vs-49 is what sent someone looking in the first place.
//
// NOT COVERED: the aggregation running against a real database (needs one). These lock the status
// vocabulary, the grouping rule and the SQL-construction traps that silently return wrong numbers.
//
// Run:  npx tsx tests/assistant-metric-counters.test.ts

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    SCHEDULE_ACTIVE_STATUSES,
    SCHEDULE_INACTIVE_STATUSES,
    type PostStatus,
} from '../src/config/post-status';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const metrics = read('netlify/functions/get-assistant-metrics.ts');
const assistantsJs = read('assistants.js');
const detailHtml = read('assistant-detail.html');
const socialDrafts = read('netlify/functions/get-social-drafts.ts');

/** Pull one of the `const NAME_STATUSES = [...]` vocabulary lists back out of the handler. */
function statusList(name: string): string[] {
    const decl = metrics.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1];
    assert.ok(decl !== undefined, `${name} has been renamed or removed from get-assistant-metrics.ts`);
    return [...decl!.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
}

const DISCARDED = statusList('DISCARDED_STATUSES');
const BOOKED = statusList('BOOKED_STATUSES');
const AWAITING = statusList('AWAITING_REVIEW_STATUSES');
const ATTENTION = statusList('ATTENTION_STATUSES');

console.log('\nThe tiles mean what they say\n');

check('"Scheduled" excludes work still waiting on the user', () => {
    // The original bug, stated directly. If this fails, the Scheduled tile is once again promising
    // the user that unapproved drafts are going out.
    for (const s of ['pending_approval', 'in_review']) {
        assert.ok(!BOOKED.includes(s),
            `'${s}' is back in BOOKED_STATUSES — a draft awaiting review is not a booked slot`);
        assert.ok(AWAITING.includes(s), `'${s}' must be reported as awaiting review instead`);
    }
});

check('"Scheduled" also excludes work that has already gone or has stopped', () => {
    assert.ok(!BOOKED.includes('published'), 'a published post is no longer scheduled — it is done');
    assert.ok(!BOOKED.includes('failed'), 'a failed post is not going out without help; it needs attention');
    assert.ok(ATTENTION.includes('failed'));
});

check('a post parked on X quota still counts as scheduled', () => {
    // paused_credits is committed work waiting on quota, not an abandoned draft. Dropping it here
    // would repeat the disappearing act documented in tests/x-quota-pause.test.ts.
    assert.ok(BOOKED.includes('paused_credits'),
        'a post parked on quota is still booked — it resumes on the monthly reset or a credit top-up');
    assert.ok(BOOKED.includes('paused'));
});

check('the four lists are disjoint, so no post is counted in two tiles', () => {
    const lists: Array<[string, string[]]> = [
        ['DISCARDED', DISCARDED], ['BOOKED', BOOKED], ['AWAITING_REVIEW', AWAITING], ['ATTENTION', ATTENTION],
    ];
    for (let i = 0; i < lists.length; i++) {
        for (let j = i + 1; j < lists.length; j++) {
            const overlap = lists[i][1].filter(s => lists[j][1].includes(s));
            assert.deepEqual(overlap, [],
                `${lists[i][0]} and ${lists[j][0]} both claim ${overlap.join(', ')}`);
        }
    }
});

check('every status the app can write lands in exactly one bucket', () => {
    // Created = everything not discarded, so a status nobody classified silently inflates it. This
    // is the assertion that fires when a new PostStatus is added and this file is not revisited.
    //
    // Three statuses are deliberately Created-only — real content, in no sub-tile:
    //   'published' has its own tile; 'draft' is produced but uncommitted; 'missed' is the legacy
    //   expiry (its writer, check-review-urgency, is deleted — see the calendar memo). None is
    //   discarded: the user never turned them down, so they stay in the Created total.
    const CREATED_ONLY = ['published', 'draft', 'missed'];
    const all = [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES] as readonly string[];
    const classified = new Set([...DISCARDED, ...BOOKED, ...AWAITING, ...ATTENTION, ...CREATED_ONLY]);
    for (const s of all) {
        assert.ok(classified.has(s),
            `'${s}' is in no tile bucket — decide whether it is discarded, booked, awaiting review, ` +
            `attention, or (deliberately) counted only in Created`);
    }
    for (const s of [...DISCARDED, ...BOOKED, ...AWAITING, ...ATTENTION]) {
        const known: readonly string[] = all;
        assert.ok(known.includes(s), `the tiles classify '${s}', which is not a PostStatus`);
    }
});

check('rejected and cancelled never inflate Created', () => {
    // A post the user turned down is not content the assistant produced. Both actors' statuses are
    // discarded — 16 cancelled rows were padding this tile.
    assert.ok(DISCARDED.includes('rejected') && DISCARDED.includes('cancelled'));
    assert.ok(DISCARDED.includes('admin_test'), 'dry-runs are not the user\'s content either');
    // And the row-level breakdown loop (same handler, below the totals query) has to skip them too,
    // or the bars contradict the tiles.
    assert.match(metrics, /if \(DISCARDED\.has\(r\.status\)\) continue;/,
        'the per-platform loop must skip discarded statuses the same way the totals query does');
    // Both must read the SAME list — a second hand-written copy is how they drift apart.
    assert.match(metrics, /const DISCARDED = new Set<string>\(DISCARDED_STATUSES\)/,
        'the loop must derive its Set from DISCARDED_STATUSES, not re-list the statuses');
});

console.log('\nOne cross-post is one post\n');

check('the totals count distinct cross-post groups, not rows', () => {
    assert.match(metrics, /count\(distinct coalesce\(/,
        'counting rows here is what made the Scheduled tile read 49 against a Scheduled tab of 9');
    assert.match(metrics, /crosspostGroupId[\s\S]{0,60}?'id:' \|\| /,
        'a post with no group must fall back to its own id, or every ungrouped post collapses into one');
});

check('the fallback key cannot collide with a group id', () => {
    // coalesce(group::text, id::text) would make group '7' and post 7 the same post. The 'id:'
    // prefix is what keeps the two id spaces apart.
    const expr = metrics.match(/count\(distinct coalesce\([^)]*\)[^)]*\)/)?.[0] ?? '';
    assert.match(expr, /'id:'/, 'the ungrouped-post key must be namespaced away from crosspost group ids');
});

check('each tile is a FILTER over one distinct-count, not a sum of per-status counts', () => {
    // Summing per-status counts double-counts a mixed group: 2 published + 1 failed siblings is
    // real, and would count once in Created for each status it touches.
    assert.match(metrics, /filter \(where /);
    const calls = [...metrics.matchAll(/groupedCount\(/g)].length;
    assert.ok(calls >= 5, `expected a groupedCount per tile, found ${calls}`);
});

console.log('\nThe SQL comes back readable\n');

check('every raw count is aliased, so the tiles are not all the same number', () => {
    // drizzle does not alias raw sql select fields: five bare count(...) expressions all return as
    // "count" and the driver keeps one. Every tile would have shown an identical, wrong figure.
    assert.match(metrics, /const groupedCount = \(predicate: SQL, alias: string\)/,
        'the alias must be a required argument — an optional one is a trap');
    assert.match(metrics, /\.as\(alias\)/);
    // Each call site passes an alias matching its JS key, so the read-back name is never in doubt.
    for (const key of ['created', 'scheduled', 'published', 'awaitingReview', 'needsAttention']) {
        assert.match(metrics, new RegExp(`${key}: groupedCount\\([\\s\\S]{0,200}?'${key}'\\)`),
            `the '${key}' tile's SQL alias must match the JSON key it is read back by`);
    }
});

check('the ::int cast is parenthesised around the whole FILTER expression', () => {
    assert.match(metrics, /\(count\(distinct[\s\S]*?filter \(where \$\{predicate\}\)\)::int/,
        'count(…) filter (…)::int leans on precedence between FILTER and the cast — wrap it');
});

console.log('\nThe screen explains the difference instead of hiding it\n');

check('the breakdown says it is per-platform, because it sums higher than the tiles', () => {
    assert.match(detailHtml, /id="metrics-breakdown-note"/,
        'the note needs an id so the renderer can describe what the bars count');
    assert.match(assistantsJs, /bdNote\.textContent = 'All-time, per platform'/);
    assert.match(assistantsJs, /bdNote\.title = [^;]*cross-post appears once per platform/,
        'without this, a breakdown summing higher than the totals reads as a contradiction');
});

check('each tile carries a tooltip naming what it rolls up', () => {
    for (const [id, must] of [
        ['metrics-total-created', /rejected or cancelled/],
        ['metrics-total-scheduled', /awaiting your review/],
        ['metrics-total-published', /gone live/],
    ] as const) {
        const line = assistantsJs.match(new RegExp(`el\\('${id}'\\)\\.title = '([^']*)'`))?.[1] ?? '';
        assert.ok(line, `${id} has no tooltip — "Created 18" against 6 review cards needs explaining`);
        assert.match(line, must);
        assert.match(line, /[Cc]ross-posts count once/, `${id}'s tooltip must state the grouping rule`);
    }
});

console.log('\nEvery counted post is reachable from some screen\n');

check('failed posts have a column and a click-through, not just a number', () => {
    // A 'failed' post is in no other column: Archived is rejected/cancelled, and failed is neither.
    // Three of them sat unnoticed for a week because the only way in was the calendar.
    assert.match(assistantsJs, /attention: \{ postStatus: 'failed' \}/);
    assert.match(detailHtml, /data-status="attention"/, 'the Needs attention column must exist');
    assert.match(detailHtml, /id="metrics-needs-attention"/);
    assert.match(detailHtml, /detailRqOpenStatus\('attention'\)/,
        'the failure line must deep-link to the column that can act on the posts');
});

check('the failure line hides at zero rather than sitting permanently empty', () => {
    assert.match(assistantsJs, /attention\.classList\.toggle\('hidden', !n\)/);
});

check('Archived covers cancelled as well as rejected', () => {
    // The client sends the FAMILY name; the server expands it. Sending 'rejected' again would leave
    // cancelled posts counted in nothing and listed nowhere.
    assert.match(assistantsJs, /archived:\s*\{ postStatus: 'archived' \}/,
        "the column must request the family, not the single 'rejected' status");
    assert.match(socialDrafts, /archived: \['rejected', 'cancelled'\]/,
        'get-social-drafts must expand the family, or the column returns nothing');
});

check('the awaiting-review figure is reconciled where it already has a home', () => {
    // It deliberately has no fourth tile — the Autopilot card's "waiting for your review" is the
    // one place it lives, and that number now comes from the same aggregation as the tiles.
    assert.match(assistantsJs, /_syncAutopilotPending\(d\.totalAwaitingReview \?\? 0\)/);
});

console.log(`\n${passed} passed\n`);
