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
    DISCARDED_STATUSES,
    BOOKED_STATUSES,
    AWAITING_REVIEW_STATUSES,
    ATTENTION_STATUSES,
    UNSURFACED_STATUSES,
    CREATED_STATUSES,
    REVIEW_QUEUE_STATUS_FAMILIES,
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

// The vocabulary is IMPORTED now, not scraped back out of the handler with a regex. It used to be
// declared inline in get-assistant-metrics.ts while get-social-drafts.ts kept its own, shorter
// families for the Review Queue columns — which is precisely how the two drifted apart and the tiles
// came to out-run the tabs beneath them. One home, both readers.
const DISCARDED: readonly string[] = DISCARDED_STATUSES;
const BOOKED: readonly string[] = BOOKED_STATUSES;
const AWAITING: readonly string[] = AWAITING_REVIEW_STATUSES;
const ATTENTION: readonly string[] = ATTENTION_STATUSES;
const UNSURFACED: readonly string[] = UNSURFACED_STATUSES;

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

check('the five lists are disjoint, so no post is counted in two tiles', () => {
    const lists: Array<[string, readonly string[]]> = [
        ['DISCARDED', DISCARDED], ['BOOKED', BOOKED], ['AWAITING_REVIEW', AWAITING],
        ['ATTENTION', ATTENTION], ['UNSURFACED', UNSURFACED],
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
    // A status nobody classified is a post that is either counted in nothing or counted in a tile
    // with no screen behind it. This is the assertion that fires when a new PostStatus is added and
    // this file is not revisited.
    //
    // 'published' is Created-only in the sense that it has its OWN tile rather than a sub-tile.
    // 'draft' and 'missed' are UNSURFACED: real rows, shown on no screen by design (a blank composer
    // row; the legacy expiry whose writer is gone), and therefore counted on none — including in
    // Created, which used to sweep them up and hand the user a headline no tab could account for.
    const all = [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES] as readonly string[];
    const classified = new Set([...DISCARDED, ...BOOKED, ...AWAITING, ...ATTENTION, ...UNSURFACED, 'published']);
    for (const s of all) {
        assert.ok(classified.has(s),
            `'${s}' is in no tile bucket — decide whether it is discarded, booked, awaiting review, ` +
            `attention, unsurfaced, or published`);
    }
    for (const s of [...DISCARDED, ...BOOKED, ...AWAITING, ...ATTENTION, ...UNSURFACED]) {
        const known: readonly string[] = all;
        assert.ok(known.includes(s), `the tiles classify '${s}', which is not a PostStatus`);
    }
});

check('Created is the union of the buckets that have a column, and nothing else', () => {
    // The identity the user checks by eye: the Created tile == Review + Scheduled + Posted +
    // Needs attention. It broke when Created was "everything not discarded", because that also
    // swept in 'draft' and 'missed', which no column lists.
    const expected = [...AWAITING, ...BOOKED, ...ATTENTION, 'published'].sort();
    assert.deepEqual([...CREATED_STATUSES].sort(), expected,
        'Created must be exactly the surfaced buckets — a status in it that no column serves is a ' +
        'number the user cannot go and look at');
    for (const s of [...DISCARDED, ...UNSURFACED]) {
        assert.ok(!(CREATED_STATUSES as readonly string[]).includes(s),
            `'${s}' inflates Created with rows that appear in no tab`);
    }
});

check('rejected and cancelled never inflate Created', () => {
    // A post the user turned down is not content the assistant produced. Both actors' statuses are
    // discarded — 16 cancelled rows were padding this tile.
    assert.ok(DISCARDED.includes('rejected') && DISCARDED.includes('cancelled'));
    assert.ok(DISCARDED.includes('admin_test'), 'dry-runs are not the user\'s content either');
    // And the row-level breakdown loop (same handler, below the totals query) has to apply the same
    // rule, or the bars contradict the tiles they break down. It filters by what Created COUNTS
    // rather than by what it discards, so an unsurfaced 'draft' cannot pad a platform's bar either.
    assert.match(metrics, /if \(!COUNTED\.has\(r\.status\)\) continue;/,
        'the per-platform loop must skip anything the totals query does not count');
    // Both must read the SAME list — a second hand-written copy is how they drift apart.
    assert.match(metrics, /const COUNTED = new Set<string>\(CREATED_STATUSES\)/,
        'the loop must derive its Set from CREATED_STATUSES, not re-list the statuses');
});

console.log('\nOne cross-post is one post\n');

check('the vocabulary is imported, not re-declared in the handler', () => {
    // The whole class of bug: two files answering the same question from two hand-written lists.
    assert.match(metrics, /from '\.\.\/\.\.\/src\/config\/post-status'/);
    assert.ok(!/const (DISCARDED|BOOKED|AWAITING_REVIEW|ATTENTION)_STATUSES = \[/.test(metrics),
        'get-assistant-metrics.ts must read the lists from src/config/post-status.ts, not re-declare them');
    assert.match(metrics, /status\} in \(\$\{quoted\(CREATED_STATUSES\)\}\)/,
        "Created must select the surfaced statuses, not merely exclude the discarded ones");
});

check('the totals count distinct cross-post groups, not rows', () => {
    assert.match(metrics, /count\(distinct coalesce\(/,
        'counting rows here is what made the Scheduled tile read 49 against a Scheduled tab of 9');
    assert.match(metrics, /crosspostGroupId[\s\S]{0,60}?'id:' \|\| /,
        'a post with no group must fall back to its own id, or every ungrouped post collapses into one');
});

check('the tile and the column agree on what one card is', () => {
    // The tile counts distinct crosspost groups REGARDLESS of status; the Review Queue used to key a
    // card on group + status, so a cross-post half-paused by a dead connection was one post in the
    // tile and two cards in the Scheduled column — the tab out-running the tile by one, for the same
    // post. Both keys are now group-or-id, and the card carries per-platform state instead.
    const socialKey = socialDrafts.match(/const key = r\.crosspostGroupId \? `[^`]*`/)?.[0] ?? '';
    assert.ok(socialKey && !socialKey.includes('status'),
        "get-social-drafts' page key must not split a group by status — see tests/review-queue-paging.test.ts");
    const tileKey = metrics.match(/count\(distinct coalesce\([^)]*\)[^)]*\)/)?.[0] ?? '';
    assert.ok(!/status/.test(tileKey), 'the tile counts groups, not group-and-status pairs');
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
    assert.deepEqual([...(REVIEW_QUEUE_STATUS_FAMILIES.archived ?? [])], ['rejected', 'cancelled'],
        'Archived is rejected + cancelled — and NOT admin_test, which is an internal dry-run');
});

check('every status a tile counts is served by exactly one Review Queue column', () => {
    // THE invariant. This is the mismatch the user reports as "the card totals don't match the
    // tabs": a status counted in a tile that no column asks for is a post they can see a number for
    // and never open. 'paused' (a dead connection) and 'publishing' were both in that hole, and
    // 'in_review' was counted as awaiting review while the Review column asked for
    // 'pending_approval' alone.
    //
    // The columns, as the client sends them (assistants.js _DETAIL_RQ_COLUMNS), expanded through the
    // families the server applies.
    const columnFilters = ['pending_approval', 'scheduled', 'published', 'failed'];
    const served = new Map<string, string[]>();
    for (const f of columnFilters) {
        for (const st of (REVIEW_QUEUE_STATUS_FAMILIES[f] ?? [f]) as readonly string[]) {
            served.set(st, [...(served.get(st) ?? []), f]);
        }
    }
    for (const st of CREATED_STATUSES as readonly string[]) {
        const cols = served.get(st);
        assert.ok(cols, `'${st}' is counted in a tile but no Review Queue column lists it — that is ` +
            `a number with no screen behind it`);
        assert.equal(cols!.length, 1, `'${st}' is listed by ${cols!.join(' and ')} — one post, one column`);
    }
    // …and the client must actually be sending those filters.
    for (const [key, filter] of [
        ['review', 'pending_approval'], ['scheduled', 'scheduled'],
        ['posted', 'published'], ['attention', 'failed'],
    ] as const) {
        assert.match(assistantsJs, new RegExp(`${key}:\\s*\\{ postStatus: '${filter}' \\}`),
            `the ${key} column must request '${filter}'`);
    }
});

check('the families are expanded from the shared vocabulary, not re-typed', () => {
    assert.match(socialDrafts, /REVIEW_QUEUE_STATUS_FAMILIES/,
        'get-social-drafts must read the families from src/config/post-status.ts');
    assert.ok(!/const STATUS_FAMILIES: Record<string, string\[\]> = \{/.test(socialDrafts),
        'a second hand-written family map is how the queue and the tiles drifted apart the first time');
    assert.deepEqual([...(REVIEW_QUEUE_STATUS_FAMILIES.scheduled ?? [])], [...BOOKED],
        "the Scheduled column must list exactly what the Scheduled tile counts");
    assert.deepEqual([...(REVIEW_QUEUE_STATUS_FAMILIES.pending_approval ?? [])], [...AWAITING],
        'the Review column must list exactly what the Autopilot card reports as awaiting review');
});

console.log('\nThe tiles keep up with the queue\n');

check('a queue change recounts the tiles', () => {
    // The tiles were filled once, on page open. Approving a draft moved the Scheduled tab's badge
    // and left the tile above it saying the old number until a reload — the same contradiction as a
    // vocabulary drift, arriving by a different route. detailRqRefresh is the hook every mutation
    // site in the product already calls, which is why the recount hangs off it rather than off
    // eleven separate callers.
    assert.match(assistantsJs, /window\.detailRqRefresh = function\(\) \{[\s\S]{0,400}?window\._refreshAssistantMetrics\?\.\(\)/,
        'detailRqRefresh must recount the Overview tiles as well as the columns');
    assert.match(assistantsJs, /window\._refreshAssistantMetrics = function/);
});

check('the recount keeps the period the user is looking at', () => {
    // Re-running with the 'all' default would snap a This Week / This Month selection back to All
    // Time every time a post moved.
    assert.match(assistantsJs, /_detailMetricsPeriod = period;/,
        'the renderer must remember which period is on screen');
    assert.match(assistantsJs, /_fetchAndRenderAssistantMetrics\(current, period\)/,
        'the refresh must replay the remembered period, not the default');
});

check('the recount is debounced and re-reads the assistant at fire time', () => {
    // One approve fans out into several refresh calls (list + badge + notification poll). And the
    // user may have opened another assistant while the timer was pending — repainting this card
    // with the previous assistant's totals is worse than not repainting at all.
    assert.match(assistantsJs, /clearTimeout\(_detailMetricsRefreshTimer\)/);
    assert.match(assistantsJs, /const current = window\._currentAssistantId;/);
});

check('a refresh may repaint zeros, so a tile cannot freeze at its last non-zero reading', () => {
    // The "no recorded activity yet" guard hides the strip on a brand-new assistant. Applying it to
    // a REFRESH would leave "Created 1" over an empty queue after the only post was rejected.
    assert.match(assistantsJs, /const stripShown = !!roiStrip && !roiStrip\.classList\.contains\('hidden'\);/);
    assert.match(assistantsJs, /if \(!d\.totalCreated && !d\.hoursSaved && !stripShown\) return;/);
});

check('the awaiting-review figure is reconciled where it already has a home', () => {
    // It deliberately has no fourth tile — the Autopilot card's "waiting for your review" is the
    // one place it lives, and that number now comes from the same aggregation as the tiles.
    assert.match(assistantsJs, /_syncAutopilotPending\(d\.totalAwaitingReview \?\? 0\)/);
});

console.log(`\n${passed} passed\n`);
