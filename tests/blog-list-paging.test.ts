// tests/blog-list-paging.test.ts
// Paging for the public blog list — the rules, the SQL they compile to, and the widget that walks
// them.
//
// Why this suite is worth its length: the bug it replaces was SILENT. /api/widget/:key/posts
// answered with a hard 50 and no way to ask for more, so a blog's 51st post stopped appearing with
// no message and no control — the oldest simply fell off the end. Nothing failed, nothing logged,
// and the only symptom was a customer eventually noticing their early posts had gone. Every check
// here is aimed at a failure of that shape: correct-looking output that quietly omits rows.
//
// Run:  npx tsx tests/blog-list-paging.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
    DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, listSortKey, afterCursor, pageSize, parseCursor, takePage,
} from '../src/utils/blog-list-paging';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dialect = new PgDialect();
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── page size ───────────────────────────────────────────────────────────────
console.log('\nPage size\n');

check('⚠️ the default is the PRE-PAGING size — an old cached widget must not shrink', () => {
    // widget.js is served from one origin and embedded on customer sites, so at any moment some
    // visitors are running a cached copy that sends no `limit`. If the default dropped to the new
    // client's page size, every one of those embeds would silently show 12 posts instead of 50,
    // with no "load more" to reach the rest — a regression on live customer sites caused purely by
    // deploying the fix. 50 is the number the endpoint answered with before it could page.
    assert.equal(DEFAULT_PAGE_SIZE, 50);
    for (const absent of [undefined, null, '', 'abc', '0', '-5', '2.5', 'NaN']) {
        assert.equal(pageSize(absent), 50, `pageSize(${JSON.stringify(absent)}) must fall back to the default`);
    }
});

check('an explicit page size is honoured, and capped', () => {
    assert.equal(pageSize('12'), 12);
    assert.equal(pageSize('1'), 1);
    assert.equal(pageSize(String(MAX_PAGE_SIZE)), MAX_PAGE_SIZE);
    assert.equal(pageSize('9999'), MAX_PAGE_SIZE, 'paging exists so callers walk, not so they scrape');
});

check('a cursor is a positive whole id, or nothing', () => {
    assert.equal(parseCursor('42'), 42);
    for (const bad of [undefined, null, '', '0', '-1', '1.5', 'abc', "1 OR 1=1"]) {
        assert.equal(parseCursor(bad), null, `parseCursor(${JSON.stringify(bad)}) must be refused`);
    }
});

// ── the page / cursor split ─────────────────────────────────────────────────
console.log('\nSplitting a page off the result\n');

const rows = (n: number, from = 100) => Array.from({ length: n }, (_, i) => ({ id: from - i }));

check('a full result yields a cursor; a short one does not', () => {
    // The caller fetches size + 1. That extra row IS the answer to "is there another page?".
    const full = takePage(rows(13), 12);
    assert.equal(full.page.length, 12, 'the extra row must never be served');
    assert.equal(full.nextCursor, '89', 'the cursor is the last SERVED row, not the peeked one');

    const short = takePage(rows(7), 12);
    assert.equal(short.page.length, 7);
    assert.equal(short.nextCursor, null);
});

check('⚠️ the last page ends with an explicit null, not a missing key', () => {
    // undefined serialises to an absent property, which a client cannot tell from a bug or a
    // truncated response — and the safe reading of "I did not get a cursor field" is to retry.
    const end = takePage(rows(3), 12);
    assert.strictEqual(end.nextCursor, null);
    assert.ok('nextCursor' in end);
    assert.ok(JSON.stringify(end).includes('"nextCursor":null'), 'null must survive serialisation');
});

check('exactly one full page is the boundary case, and reports no more', () => {
    // Off by one here means either a phantom empty page at the end of every blog, or the last
    // post being unreachable. Both are invisible until someone counts.
    const exact = takePage(rows(12), 12);
    assert.equal(exact.page.length, 12);
    assert.equal(exact.nextCursor, null, 'a result that exactly fills the page has nothing after it');
});

check('an empty result is not an error', () => {
    const none = takePage([] as { id: number }[], 12);
    assert.deepEqual(none.page, []);
    assert.equal(none.nextCursor, null);
});

check('walking the pages returns every row exactly once', () => {
    // The property that actually matters, asserted end to end rather than inferred: page through a
    // known list and confirm the union is the whole list, in order, with nothing repeated. This is
    // what "the 51st post disappeared" would have failed.
    const all = rows(37);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
        // Both annotated: `cursor` feeds `start`, `start` feeds takePage, and takePage's result
        // feeds `cursor` again — a loop TS cannot infer its way around (TS7022).
        const start: number = cursor ? all.findIndex((r) => String(r.id) === cursor) + 1 : 0;
        const { page, nextCursor }: { page: { id: number }[]; nextCursor: string | null } =
            takePage(all.slice(start, start + 12 + 1), 12);
        seen.push(...page.map((r) => r.id));
        cursor = nextCursor;
        if (!cursor) break;
    }
    assert.deepEqual(seen, all.map((r) => r.id), 'every row, in order, once');
    assert.equal(new Set(seen).size, seen.length, 'no row served twice');
});

// ── the SQL ─────────────────────────────────────────────────────────────────
console.log('\nThe SQL it compiles to\n');

check('⚠️ the sort key COALESCEs — a NULL key makes a post unreachable forever', () => {
    // published_at is nullable. A NULL sort key does not merely sort oddly: every keyset
    // comparison against it evaluates to NULL, so the row is excluded from every page after the
    // first. The post exists, serves fine at its own URL, and can never be reached from the list.
    const { sql: text } = dialect.sqlToQuery(listSortKey);
    assert.match(text, /COALESCE\("blog_posts"\."published_at", "blog_posts"\."created_at"\)/);
});

check('⚠️ the cursor subselect is scoped to the SAME org and status', () => {
    // Without these filters the cursor is a cross-tenant oracle: pass a stranger's post id and the
    // response tells you where their post — draft or otherwise — sorts in time. With them, a
    // foreign id matches no row, the row comparison yields NULL, and the page comes back empty.
    const { sql: text, params } = dialect.sqlToQuery(afterCursor(9, 37));
    assert.match(text, /c\.organisation_id = \$\d/, 'the subselect must filter by organisation');
    assert.match(text, /c\.status = 'published'/, 'the subselect must exclude drafts');
    assert.deepEqual(params, [9, 37], 'both the cursor id and the org id are bound parameters');
});

check('the comparison is row-wise over (sort key, id) — not the date alone', () => {
    // Comparing only the timestamp loses every row that shares a second with the cursor row.
    const { sql: text } = dialect.sqlToQuery(afterCursor(9, 37));
    assert.match(text, /\(COALESCE\([^)]*\), "blog_posts"\."id"\) < \(\s*SELECT COALESCE/,
        'must compare the (sort key, id) pair against the cursor row');
});

check('the cursor never travels as a date', () => {
    // A timestamp in a query string has to be formatted, parsed and timezone-resolved, and any of
    // those going wrong reorders someone's blog. Reading the sort key out of the row sidesteps all
    // three — so the only parameters here are two integers.
    const { params } = dialect.sqlToQuery(afterCursor(9, 37));
    assert.ok(params.every((p) => typeof p === 'number'), `expected only ids, got ${JSON.stringify(params)}`);
});

// ── the endpoint's wiring ───────────────────────────────────────────────────
console.log('\nThe endpoint\n');

const api = readFileSync(join(root, 'netlify/functions/widget-api.ts'), 'utf8');

check('the list query orders by the sort key AND the id', () => {
    // Two posts published in the same second come back in whatever order the planner picks, and a
    // keyset cursor over an ambiguous order skips or repeats rows at exactly that boundary.
    const list = api.slice(landmark(api, "if (resource === 'posts' && !slug)"), landmark(api, "if (resource === 'posts' && slug)"));
    assert.match(list, /\.orderBy\(desc\(listSortKey\), desc\(blogPosts\.id\)\)/);
});

check('it fetches one more row than it serves', () => {
    const list = api.slice(landmark(api, "if (resource === 'posts' && !slug)"), landmark(api, "if (resource === 'posts' && slug)"));
    assert.match(list, /\.limit\(size \+ 1\)/, 'the peeked row is how nextCursor is decided');
    assert.match(list, /takePage\(rows, size\)/, 'and it must be split through takePage, not by hand');
});

check('⚠️ the internal row id is never serialised into the response', () => {
    // id is selected for the cursor only. Echoing it back alongside the slug would publish a
    // guessable, enumerable handle on a table this endpoint deliberately keys by an unguessable
    // widget public_key — the whole reason there is no id enumeration here.
    const list = api.slice(landmark(api, "if (resource === 'posts' && !slug)"), landmark(api, "if (resource === 'posts' && slug)"));
    const shape = list.slice(landmark(list, 'const posts = page.map'), landmark(list, 'return json('));
    assert.ok(!/\bid:/.test(shape), `the response shape must not carry the row id: ${shape}`);
});

check('the cursor is only applied when one was actually supplied', () => {
    const list = api.slice(landmark(api, "if (resource === 'posts' && !slug)"), landmark(api, "if (resource === 'posts' && slug)"));
    assert.match(list, /\.\.\.\(cursorId \? \[afterCursor\(cursorId, orgId\)\] : \[\]\)/);
});

// ── the widget ──────────────────────────────────────────────────────────────
console.log('\nThe widget that walks it\n');

const widget = readFileSync(join(root, 'widget.js'), 'utf8');

check('the widget asks for a page and follows nextCursor', () => {
    assert.match(widget, /\/posts\?limit=' \+ PAGE_SIZE/, 'the first request must ask for a page');
    assert.match(widget, /'&cursor=' \+ encodeURIComponent\(listState\.cursor\)/, 'and later ones must carry the cursor');
    assert.match(widget, /data\.nextCursor \|\| null/, 'the cursor must come from the response');
});

check('⚠️ a further page APPENDS — it never replaces what is on screen', () => {
    // The reader has scrolled through three pages by now. Assigning instead of concatenating would
    // drop everything above the fold on every click, which reads as the list resetting itself.
    const fn = widget.slice(landmark(widget, 'function loadMore()'), landmark(widget, 'function renderList()'));
    assert.match(fn, /mine\.posts = mine\.posts\.concat\(data\.posts \|\| \[\]\)/);
});

check('⚠️ a failed "load more" keeps the posts already rendered', () => {
    // The catch must not put "Unable to load posts." over a part-read list — that throws away the
    // posts they came for because page four timed out.
    const fn = widget.slice(landmark(widget, 'function loadMore()'), landmark(widget, 'function renderList()'));
    const cat = fn.slice(landmark(fn, '.catch('), landmark(fn, '.finally('));
    assert.ok(!/innerHTML/.test(cat), 'the load-more failure path must not overwrite the list');
    assert.match(cat, /mine\.error = true/, 'it should record the failure so the button can offer a retry');
});

check('the button only appears when there IS another page', () => {
    const fn = widget.slice(landmark(widget, 'function paintList()'), landmark(widget, 'function loadMore()'));
    assert.ok(
        landmark(fn, 'if (listState.cursor)') < landmark(fn, 'bms-more'),
        'the "load more" control must be gated on a cursor existing',
    );
});

check('⚠️ an in-flight page cannot land on a list that has been replaced', () => {
    // The reader clicks a post while page two is in flight, then comes Back. renderList() has
    // rebuilt listState by the time the response arrives; without the identity check the old
    // response appends its page onto the new list and paints over the fresh one.
    const fn = widget.slice(landmark(widget, 'function loadMore()'), landmark(widget, 'function renderList()'));
    assert.match(fn, /var mine = listState;/, 'the request must capture the state it belongs to');
    assert.match(fn, /if \(mine === listState\) paintList\(\)/, 'and only repaint if that state is still current');
});

check('concurrent clicks cannot fire two requests for the same page', () => {
    const fn = widget.slice(landmark(widget, 'function loadMore()'), landmark(widget, 'function renderList()'));
    assert.ok(
        landmark(fn, 'listState.loading) return') < landmark(fn, 'getJSON('),
        'the in-flight guard must run before the fetch',
    );
});

check('the button is styled — :host{all:initial} strips the UA button styling', () => {
    // Without an explicit font the button renders in 13px Arial inside an otherwise themed page.
    assert.match(widget, /\.bms \.bms-more\{[^}]*font:inherit/);
});

// ── the crawler bake ────────────────────────────────────────────────────────
console.log('\nThe crawler-visible index\n');

check('⚠️ the SEO bake follows the cursor to the END', () => {
    // Baking only the first page would recreate, for search engines, exactly the invisible-after-N
    // truncation that paging was added to fix — and this list is the ONLY thing linking crawlers
    // to the server-rendered post pages.
    const build = readFileSync(join(root, 'scripts/build-seo-html.mjs'), 'utf8');
    // ⚠️ The end marker is searched FROM the start, not from 0. `injectMarked` is used by every
    // bake job in this file, so an unanchored indexOf finds the FIRST one — which sits above
    // inlineBlogPosts, making end < start and slicing to an empty string that passes nothing.
    const start = landmark(build, 'async function inlineBlogPosts()');
    const fn = build.slice(start, landmark(build, 'const res = injectMarked', start));
    assert.match(fn, /data\.nextCursor \|\| null/, 'it must read the cursor');
    assert.match(fn, /cursor \? `&cursor=/, 'and send it on the next request');
    assert.match(fn, /posts = posts\.concat/, 'accumulating rather than overwriting');
    assert.ok(/for \(let page = 0; page < \d+; page\+\+\)/.test(fn), 'the loop must be bounded — a build that hangs is worse than one that stops');
});

check('the blog page preflight only asks whether anything exists', () => {
    // It reads nothing but .length, so pulling a full page to answer it delays the widget mount
    // behind a request 50x larger than the question.
    const blog = readFileSync(join(root, 'blog.html'), 'utf8');
    assert.match(blog, /\/posts\?limit=1'/, 'the existence check should ask for one row');
});

console.log(`\n${passed} checks passed.`);
