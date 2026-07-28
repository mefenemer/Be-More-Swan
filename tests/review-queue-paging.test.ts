// tests/review-queue-paging.test.ts
// The Review Queue loads a page at a time. The thing that can go wrong is not "wrong count" — it is
// SPLITTING A CROSS-POST. One logical post is one scheduled_posts row per platform sharing a
// crosspost_group_id, and the queue collapses those into a single card. A row-level LIMIT would put
// Facebook on page 1 and its LinkedIn sibling on page 2, rendering the same post as two cards that
// each claim to be the whole thing — and the reviewer would approve half of it.
//
// So the endpoint pages by GROUP. This test reproduces that paging over a fixture and asserts the
// invariants; it is pure logic, no DB.
//
// Run:  npx tsx tests/review-queue-paging.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');

interface Row { id: number; crosspostGroupId: string | null; status: string }

/** The server's grouping, mirrored from get-social-drafts.ts. */
function pageIdsFor(rows: Row[], limit: number, offset: number) {
    const order: string[] = [];
    const byKey = new Map<string, number[]>();
    for (const r of rows) {
        const key = r.crosspostGroupId ? `g:${r.crosspostGroupId}|${r.status ?? ''}` : `id:${r.id}`;
        if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
        byKey.get(key)!.push(r.id);
    }
    return {
        ids: order.slice(offset, offset + limit).flatMap(k => byKey.get(k)!),
        groupTotal: order.length,
        keys: order.slice(offset, offset + limit),
    };
}

// 4 single-platform posts, then one 4-platform cross-post, then 6 more singles = 11 groups, 14 rows.
const rows: Row[] = [
    ...[1, 2, 3, 4].map(id => ({ id, crosspostGroupId: null, status: 'pending_approval' })),
    ...[5, 6, 7, 8].map(id => ({ id, crosspostGroupId: 'grp-a', status: 'pending_approval' })),
    ...[9, 10, 11, 12, 13, 14].map(id => ({ id, crosspostGroupId: null, status: 'pending_approval' })),
];

console.log('\nreview queue paging\n');

check('a page is counted in groups, not rows', () => {
    const p = pageIdsFor(rows, 10, 0);
    assert.strictEqual(p.groupTotal, 11, '14 rows collapse to 11 cards');
    assert.strictEqual(p.keys.length, 10, 'a page of 10 must be 10 CARDS');
    assert.strictEqual(p.ids.length, 13, '...which here is 13 rows, because one card is 4 platforms');
});

check('a cross-post is never split across two pages', () => {
    const groupRows = [5, 6, 7, 8];
    for (let limit = 1; limit <= 11; limit++) {
        for (let offset = 0; offset < 11; offset++) {
            const ids = pageIdsFor(rows, limit, offset).ids;
            const present = groupRows.filter(id => ids.includes(id));
            assert.ok(present.length === 0 || present.length === 4,
                `limit=${limit} offset=${offset} returned ${present.length}/4 of the cross-post — a half-group renders as a card claiming to be the whole post`);
        }
    }
});

check('paging through covers every row exactly once', () => {
    const seen: number[] = [];
    for (let offset = 0; offset < 11; offset += 10) seen.push(...pageIdsFor(rows, 10, offset).ids);
    assert.deepEqual([...seen].sort((a, b) => a - b), rows.map(r => r.id), 'a row was dropped or duplicated');
    assert.strictEqual(new Set(seen).size, seen.length, 'a row appeared on two pages');
});

check('an offset past the end yields nothing rather than wrapping', () => {
    assert.deepEqual(pageIdsFor(rows, 10, 99).ids, []);
});

check('offset counts groups, so the client must send a GROUP count', () => {
    // Page 1 is 10 groups but 13 rows. Sending 13 as the next offset would skip 3 cards.
    const first = pageIdsFor(rows, 10, 0);
    const byGroups = pageIdsFor(rows, 10, first.keys.length).ids;
    const byRows = pageIdsFor(rows, 10, first.ids.length).ids;
    assert.deepEqual(byGroups, [14], 'the 11th group is the only one left');
    assert.notDeepEqual(byRows, byGroups, 'offsetting by row count silently skips posts');
});

// ── The wiring, at source level ─────────────────────────────────────────────────────────────────
/** The endpoint's opt-in decision, reproduced exactly. */
function pagingFor(limit?: string) {
    const rawLimit = limit;
    const paged = rawLimit !== undefined && rawLimit !== null && rawLimit !== '';
    const pageSize = paged ? Math.min(50, Math.max(1, Number(rawLimit) || 10)) : 0;
    return { paged, pageSize };
}

check('a caller that sends no limit is NOT paged', () => {
    // The regression this exists for: pageSize was clamped with Math.max(1, ...) BEFORE the opt-in
    // test, and Math.max(1, Number(undefined) || 0) is 1 — so `paged = pageSize > 0` was true for
    // every caller that had asked for nothing, and each got a single group back. The workspace queue
    // hid it by always sending limit; the assistant-detail Review tab showed one post.
    assert.deepEqual(pagingFor(undefined), { paged: false, pageSize: 0 }, 'absent limit must never page');
    assert.deepEqual(pagingFor(''), { paged: false, pageSize: 0 }, 'an empty limit is not a request to page');
});

check('an explicit limit pages, and junk falls back to a usable page', () => {
    assert.deepEqual(pagingFor('10'), { paged: true, pageSize: 10 });
    assert.deepEqual(pagingFor('1'), { paged: true, pageSize: 1 });
    assert.deepEqual(pagingFor('999'), { paged: true, pageSize: 50 }, 'capped');
    // Opting in with nonsense must still yield a page, never a silent 1.
    assert.deepEqual(pagingFor('abc'), { paged: true, pageSize: 10 });
    assert.deepEqual(pagingFor('0'), { paged: true, pageSize: 10 });
});

check('paging is opt-in, so the other callers still get the whole list', () => {
    const fn = readFileSync(path.join(ROOT, 'netlify/functions/get-social-drafts.ts'), 'utf8');
    assert.match(fn, /const paged = rawLimit !== undefined/, 'presence of the param decides, not a number derived from it');
    assert.ok(!/const paged = pageSize > 0/.test(fn), 'deriving the opt-in from a clamped number is the bug');
    assert.match(fn, /\.limit\(paged \? pageIds!\.length : 50\)/, 'unpaged keeps the original ceiling');
    // _pceRefetchPostGroup is the one that matters: it refetches after every card save, and a
    // silently-paged response would stop updating posts outside the first page.
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    const refetch = ws.slice(ws.indexOf('async function _pceRefetchPostGroup('));
    assert.ok(!/limit=/.test(refetch.slice(0, 500)), 'the editor refetch must NOT page');
});

check('the client offsets by groups and appends rather than replacing', () => {
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    const more = ws.slice(ws.indexOf('async function rqLoadMorePosts('));
    assert.match(more.slice(0, 1200), /const offset = rqGroupSocialDrafts\(_rqLoadedPosts\)\.length/,
        'offsetting by rows would skip whole posts — see the test above');
    assert.match(more.slice(0, 1200), /_rqLoadedPosts = \[\.\.\._rqLoadedPosts, \.\.\.\(pj\.drafts \|\| \[\]\)\]/,
        'replacing would evict page 1 from _rqPostCache, which is what the editor opens from');
});

check('the pending badge reports the total, not the page', () => {
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    assert.match(ws, /const pending = _rqPostsTotal \?\? postGroups\.length/,
        '"10 awaiting review" on a queue of 24 is worse than no badge');
});

// ── The sidebar pill and the queue must count the same thing ────────────────────────────────────
// Two functions write .pending-badge: the 60s poll (refreshPendingBadge) and rqRenderGroups when
// the queue is opened. They disagreed, so the pill was wrong on load and silently "corrected itself"
// the moment you clicked Review — which is exactly how the bug was reported.
check('the sidebar pill counts CARDS, not per-platform rows', () => {
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    const poll = ws.slice(ws.indexOf('async function refreshPendingBadge('));
    const head = poll.slice(0, 1400);
    // The bug: drafts.length is one row PER PLATFORM, so a 4-platform post read as 4 in the sidebar
    // and 1 in the queue.
    assert.ok(!/const socialCount = \(socialDrafts \|\| \[\]\)\.length/.test(head),
        'counting raw rows is the bug');
    assert.match(head, /limit=1&offset=0/, 'page it, so the server returns a grouped total');
    assert.match(head, /typeof body\.total === 'number'/, 'the grouped total is the count');
});

check('the sidebar pill is not inflated by rows nothing renders', () => {
    const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
    const poll = ws.slice(ws.indexOf('async function refreshPendingBadge('), ws.indexOf('// ── Review Queue ──'));
    // get-pending-actions has no renderer left (rqLoadItems draws posts only), so counting it gave a
    // pill that could never be cleared — and that rqRenderGroups dropped on the first click anyway.
    assert.ok(!/get-pending-actions/.test(poll), 'the pill must count what its destination shows');
    // Both writers must therefore land on the same unit.
    assert.match(poll, /\.pending-badge/, 'the poll still owns the pill');
});

// ── The assistant-detail Review tab pages too ────────────────────────────────────────────────────
// It is a fragment loaded INTO workspace.html, so it reuses rqGroupSocialDrafts / rqRenderSocialCard
// but has its own fetch + "Show more" loop in assistants.js. Its regression was the mirror image of
// the workspace one: it never sent a limit at all, so before the server fix it got a single group,
// and after the fix it dumped the entire queue with no paging. These pin the paged wiring.
check('the detail Review tab requests a page, not the whole queue', () => {
    const js = readFileSync(path.join(ROOT, 'assistants.js'), 'utf8');
    const render = js.slice(js.indexOf('async function _detailRqRenderGroups('));
    assert.match(render.slice(0, 1600), /limit=\$\{_DETAIL_RQ_PAGE_SIZE\}&offset=0/,
        'the first load must be paged, or a large queue re-presigns every asset at once');
    assert.match(render.slice(0, 4000), /container\.innerHTML = [\s\S]*\+ _detailRqMoreButton\(statusKey\)/, 'no Show-more button ⇒ pages past the first are unreachable');
});

check('the detail tab offsets by groups and appends, like the workspace queue', () => {
    const js = readFileSync(path.join(ROOT, 'assistants.js'), 'utf8');
    const more = js.slice(js.indexOf('window._detailRqLoadMore ='));
    assert.match(more.slice(0, 1200), /rqGroupSocialDrafts\(_detailRqLoadedPosts\) : _detailRqLoadedPosts\)\.length/,
        'offsetting by rows would skip whole posts across the group boundary');
    assert.match(more.slice(0, 1200), /_detailRqLoadedPosts = \[\.\.\._detailRqLoadedPosts, \.\.\.\(pj\.drafts \|\| \[\]\)\]/,
        'replacing rather than appending would evict earlier pages from the editor cache');
});

check('the detail Review badge reports the server total, not the first page', () => {
    const js = readFileSync(path.join(ROOT, 'assistants.js'), 'utf8');
    assert.match(js, /const groupedCount = _detailRqTotal \?\? postGroups\.length/,
        'a paged first response is 10 cards — the badge must show the queue total');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
