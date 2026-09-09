// tests/swan-index-curation.test.ts
// The Swan Index editorial desk: the curation rules, and the admin.html wiring that reaches them.
//
// Two halves, because two different things go silently wrong here:
//   · the RULES (src/utils/swan-index/curation.ts) decide what appears on a public masthead and,
//     through robotsForStatus, what search engines index. A wrong answer is invisible until an
//     author's own article stops ranking.
//   · the WIRING (admin.html) is four separate edits — VIEW_LABELS, ADMIN_CATS, the adminNav
//     dispatch and the <section> itself. Miss one and the page is simply not there, with no error:
//     that is exactly how Manage Emails was lost (see tests/rbac-matrix.test.ts).
//
// Run:  npx tsx tests/swan-index-curation.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
    robotsForStatus, canTransition, transitionPatch, isCurationStatus,
    parseEditorScore, parseMonthlyCap, normaliseNote, reorderFeatured,
    CURATION_STATUSES, QUEUE_STATUSES,
} from '../src/utils/swan-index/curation';
import { permissionsForRole } from '../src/utils/rbac';
import { PUBLIC_STATUSES } from '../src/utils/swan-index/queries';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/**
 * The same, for a check that has to await something.
 *
 * ⚠️ Do NOT hand an async fn to check(). It calls fn() and counts the pass on the next line, so a
 * returned promise is counted green before it settles and its rejection surfaces as an unhandled
 * rejection long after the ✓ was printed — a failing assertion reported as a passing test, which is
 * the one failure mode a test file must not have.
 */
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── the indexing rule ───────────────────────────────────────────────────────
console.log('\nIndexing is derived from editorial status\n');

check('only a featured piece is indexable', () => {
    assert.equal(robotsForStatus('featured'), 'index,follow');
    for (const s of CURATION_STATUSES) {
        if (s === 'featured') continue;
        assert.equal(robotsForStatus(s), 'noindex,follow', `${s} must not be indexable`);
    }
});

check('every value robotsForStatus can return satisfies the DB CHECK', () => {
    // blog_posts / swan_index_posts both constrain robots to these four. A fifth string here would
    // be rejected by Postgres at write time, which is a 500 on an editor's click.
    const allowed = new Set(['index,follow', 'index,nofollow', 'noindex,follow', 'noindex,nofollow']);
    for (const s of CURATION_STATUSES) assert.ok(allowed.has(robotsForStatus(s)), robotsForStatus(s));
});

check('robots always travels with the status — a transition can never omit it', () => {
    for (const s of CURATION_STATUSES) {
        const patch = transitionPatch(s, { liveAt: null, featuredAt: null });
        assert.equal(patch.status, s);
        assert.equal(patch.robots, robotsForStatus(s), `${s} patch must carry the matching robots`);
    }
});

// ── transitions ─────────────────────────────────────────────────────────────
console.log('\nTransitions\n');

check("withdrawn is the author's word — nothing an editor does can leave it", () => {
    for (const to of CURATION_STATUSES) {
        if (to === 'withdrawn') continue;
        const r = canTransition('withdrawn', to);
        assert.equal(r.ok, false, `withdrawn → ${to} must be refused`);
        assert.match(r.error!, /withdrawn by its author/i);
    }
});

check('and no editor transition can put a piece INTO withdrawn', () => {
    for (const from of CURATION_STATUSES) {
        if (from === 'withdrawn') continue;
        assert.equal(canTransition(from, 'withdrawn').ok, false, `${from} → withdrawn must be refused`);
    }
});

check('the everyday moves are allowed', () => {
    for (const [from, to] of [
        ['pending', 'live'], ['pending', 'featured'], ['pending', 'rejected'],
        ['live', 'featured'], ['featured', 'live'], ['live', 'rejected'], ['rejected', 'live'],
    ] as const) {
        assert.ok(canTransition(from, to).ok, `${from} → ${to} should be allowed`);
    }
});

check('a no-op transition is not an error', () => {
    for (const s of CURATION_STATUSES) assert.ok(canTransition(s, s).ok, `${s} → ${s}`);
});

check('featured ⇔ ranked, or the DB CHECK rejects the write', () => {
    const featured = transitionPatch('featured', { liveAt: null, featuredAt: null });
    assert.ok(featured.featuredRank != null, 'featured must be given a rank');
    for (const s of CURATION_STATUSES) {
        if (s === 'featured') continue;
        assert.equal(transitionPatch(s, { liveAt: null, featuredAt: null }).featuredRank, null,
            `${s} must clear featuredRank`);
    }
});

check('liveAt is set once and never rewritten', () => {
    const first = new Date('2026-07-01T00:00:00Z');
    const now = new Date('2026-08-21T00:00:00Z');
    // Promoting an old piece to the front page must not re-date it — every chronological list on
    // the site orders on liveAt, and they would all reshuffle around an editorial decision.
    const promoted = transitionPatch('featured', { liveAt: first, featuredAt: null }, now);
    assert.ok(!('liveAt' in promoted), 'an already-live piece keeps its original date');
    const fresh = transitionPatch('live', { liveAt: null, featuredAt: null }, now);
    assert.equal(fresh.liveAt, now, 'a first publication gets today');
});

check('taking a piece off the site clears its publication date', () => {
    const now = new Date('2026-08-21T00:00:00Z');
    for (const s of ['pending', 'rejected'] as const) {
        assert.equal(transitionPatch(s, { liveAt: new Date(), featuredAt: new Date() }, now).liveAt, null);
    }
});

check('featuredAt is stamped once, and cleared when the piece leaves the site', () => {
    const now = new Date('2026-08-21T00:00:00Z');
    const earlier = new Date('2026-08-01T00:00:00Z');
    assert.equal(transitionPatch('featured', { liveAt: earlier, featuredAt: null }, now).featuredAt, now);
    assert.ok(!('featuredAt' in transitionPatch('featured', { liveAt: earlier, featuredAt: earlier }, now)));
    assert.equal(transitionPatch('rejected', { liveAt: earlier, featuredAt: earlier }, now).featuredAt, null);
});

check('isCurationStatus rejects anything not in the vocabulary', () => {
    for (const s of CURATION_STATUSES) assert.ok(isCurationStatus(s));
    for (const s of ['draft', 'published', 'FEATURED', '', null, 7]) assert.equal(isCurationStatus(s), false, String(s));
});

check('the two public statuses agree with the public read path', () => {
    // queries.ts decides what renders; curation.ts decides what an editor can set. A status public
    // in one and not the other is a piece that is either unreachable or unremovable.
    assert.deepEqual([...PUBLIC_STATUSES].sort(), ['featured', 'live']);
    for (const s of PUBLIC_STATUSES) assert.ok(QUEUE_STATUSES.includes(s), `${s} must be visible in the queue`);
});

// ── input parsing ───────────────────────────────────────────────────────────
console.log('\nInput parsing\n');

check('editor score takes 1–5 or nothing, and refuses rather than clamps', () => {
    for (const v of [1, 3, 5, '4']) assert.deepEqual(parseEditorScore(v), { ok: true, value: Number(v) });
    for (const v of [null, undefined, '']) assert.deepEqual(parseEditorScore(v), { ok: true, value: null });
    for (const v of [0, 6, 9, -1, 2.5, 'x']) assert.equal(parseEditorScore(v).ok, false, `${v} must be refused`);
});

check('monthly cap refuses 0 — it reads as uncapped and means the opposite', () => {
    assert.deepEqual(parseMonthlyCap(8), { ok: true, value: 8 });
    assert.deepEqual(parseMonthlyCap(''), { ok: true, value: null });
    assert.deepEqual(parseMonthlyCap(null), { ok: true, value: null });
    assert.equal(parseMonthlyCap(0).ok, false);
    assert.equal(parseMonthlyCap(501).ok, false);
    assert.equal(parseMonthlyCap(1.5).ok, false);
});

check('notes are trimmed, capped and normalised to null when empty', () => {
    assert.equal(normaliseNote('  hello  '), 'hello');
    assert.equal(normaliseNote('   '), null);
    assert.equal(normaliseNote(undefined), null);
    assert.equal(normaliseNote('x'.repeat(5000))!.length, 2000);
    assert.equal(normaliseNote('x'.repeat(500), 300)!.length, 300);
});

// ── permission ──────────────────────────────────────────────────────────────
console.log('\nAccess\n');

check('curate_swan_index is platform_admin and above, not support', () => {
    assert.ok(permissionsForRole('platform_admin').includes('curate_swan_index'));
    assert.ok(permissionsForRole('super_admin').includes('curate_swan_index'));
    assert.ok(!permissionsForRole('support_agent').includes('curate_swan_index'));
    assert.ok(!permissionsForRole('billing_admin').includes('curate_swan_index'));
});

// ── admin.html wiring ───────────────────────────────────────────────────────
// ⚠️ Wrapped in a function, not run inline: tsx compiles this file to CJS, where a top-level
// `await` is a transform error that takes the WHOLE suite down — not just these checks. Called
// at the foot of the file, which is also what prints the final tally.
async function reorderChecks(): Promise<void> {
    // ── setting the whole running order ─────────────────────────────────────────
    // Drag-to-reorder and "move to position N" both post the ENTIRE order, so this is the one place
    // where a bad request can renumber the front page rather than nudge it.
    console.log('\nReordering the front page\n');

    /** A db stubbed down to the two calls reorderFeatured makes, so the rules are testable dry. */
    function stubDb(currentlyFeatured: number[], executed: unknown[] = []) {
        return {
            transaction: async (fn: (tx: unknown) => unknown) => fn({
                select: () => ({ from: () => ({ where: async () => currentlyFeatured.map((id) => ({ id })) }) }),
                execute: async (q: unknown) => { executed.push(q); },
            }),
        } as never;
    }

    await checkAsync('a malformed order is refused before it reaches the database', async () => {
        // stubDb is deliberately NOT passed: each of these must return without opening a transaction,
        // so a null db is the assertion. A throw here means validation moved after the read.
        for (const bad of ['nope', null, undefined, 42, [1, 2.5], [0], [-1], ['3']]) {
            const r = await reorderFeatured(null as never, bad);
            assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
        }
    });

    await checkAsync('an order listing the same piece twice is refused', async () => {
        // Left alone this would write two ranks to one row and leave a gap, so the front page would
        // render N-1 pieces and ORDER BY would pick between the survivors arbitrarily.
        const r = await reorderFeatured(null as never, [1, 2, 1]);
        assert.equal(r.ok, false);
        assert.match((r as { error: string }).error, /same piece twice/);
    });

    await checkAsync('⚠️ a STALE order is a conflict, not a write — the set must match exactly', async () => {
        // The trap this closes: an editor drags a two-item list while a colleague promotes a third
        // piece. Applying the drag anyway would rank only the two, leaving the newcomer holding a rank
        // from before the change — the colleague's promotion silently reshuffled by a gesture that
        // never knew about it. Both directions must fail, and both must be reported as a CONFLICT so
        // the endpoint can answer 409 and the UI can say "reload" rather than "bad request".
        const missing = await reorderFeatured(stubDb([1, 2, 3]), [3, 1]);         // fewer than are featured
        const extra   = await reorderFeatured(stubDb([1, 2]),    [1, 2, 9]);      // one that is not
        const swapped = await reorderFeatured(stubDb([1, 2, 3]), [1, 2, 9]);      // right size, wrong member
        for (const r of [missing, extra, swapped]) {
            assert.equal(r.ok, false);
            assert.equal((r as { conflict?: boolean }).conflict, true, 'must be flagged as a conflict → 409');
        }
    });

    await checkAsync('a valid order writes every rank in ONE statement', async () => {
        // Not a loop of updates. resequenceFeatured issues N of them, and a reader landing between two
        // sees duplicate ranks — the ambiguity it exists to remove. One statement has no interior.
        const executed: unknown[] = [];
        const r = await reorderFeatured(stubDb([1, 2, 3], executed), [3, 1, 2]);
        assert.deepEqual(r, { ok: true, count: 3 });
        assert.equal(executed.length, 1, `expected a single UPDATE, got ${executed.length}`);
    });

    await checkAsync('⚠️ the ranks are bound as SCALARS with int casts, not as one array', async () => {
        // Two live traps in one statement:
        //   · an interpolated JS array becomes a single ROW value in Postgres, not a list — error 42809
        //     at runtime, which no typecheck sees;
        //   · a VALUES list of bound params with no cast is inferred as `text`, and joining it to an
        //     integer id fails with "operator does not exist: integer = text".
        // Both only ever show up against a real database, so assert on the compiled SQL instead.
        const executed: unknown[] = [];
        await reorderFeatured(stubDb([4, 7, 9], executed), [9, 4, 7]);
        const { sql: text, params } = new PgDialect().sqlToQuery(executed[0] as never);

        assert.match(text, /UPDATE/, 'must be an UPDATE');
        assert.match(text, /FROM \(VALUES /, 'must join against a VALUES list');
        assert.equal((text.match(/::int/g) || []).length, 6, 'every bound value needs an explicit ::int');
        // id → rank, flattened in order: piece 9 leads, then 4, then 7.
        assert.deepEqual(params, [9, 1, 4, 2, 7, 3]);
        // The guard that matters: six separate placeholders, not one carrying an array.
        assert.ok(params.every((v) => typeof v === 'number'), `params must be scalars: ${JSON.stringify(params)}`);
    });

    await checkAsync('reordering only ever touches featured rows', async () => {
        // featured_rank is CHECK-constrained to be NULL unless the piece is featured. The set-equality
        // guard above should make this unreachable, but the statement carries the predicate anyway —
        // the constraint turns a logic slip into a 500 on an editor's drag.
        const executed: unknown[] = [];
        await reorderFeatured(stubDb([1], executed), [1]);
        const { sql: text } = new PgDialect().sqlToQuery(executed[0] as never);
        assert.match(text, /p\.status = 'featured'/, 'the UPDATE must be scoped to featured rows');
    });
}

console.log('\nadmin.html wiring\n');

const html = readFileSync(join(root, 'admin.html'), 'utf8');
const VIEWS = ['swan-queue', 'swan-front-page', 'swan-contributors'];
const LOADERS: Record<string, string> = {
    'swan-queue': 'loadSwanQueue', 'swan-front-page': 'loadSwanFrontPage', 'swan-contributors': 'loadSwanContributors',
};

check('all four wiring points exist for every view', () => {
    const labels = html.slice(landmark(html, 'const VIEW_LABELS'), landmark(html, 'const ADMIN_CATS'));
    const cats = html.slice(landmark(html, 'const ADMIN_CATS'), landmark(html, 'function _getAdminRole'));
    const nav = html.slice(landmark(html, 'function adminNav(view)'), landmark(html, '// ══ The Swan Index'));
    for (const v of VIEWS) {
        assert.ok(labels.includes(`'${v}'`), `VIEW_LABELS is missing ${v} — the page title falls back to the raw key`);
        assert.ok(cats.includes(`view: '${v}'`), `ADMIN_CATS is missing ${v} — unreachable from the nav`);
        assert.ok(nav.includes(`view === '${v}'`), `adminNav does not dispatch ${v} — the page renders empty`);
        assert.ok(html.includes(`<section id="view-${v}"`), `no markup for ${v}`);
        assert.ok(html.includes(`function ${LOADERS[v]}(`), `${LOADERS[v]} is not defined`);
    }
});

check('every Swan Index nav child is gated on curate_swan_index', () => {
    const cats = html.slice(landmark(html, 'const ADMIN_CATS'), landmark(html, 'function _getAdminRole'));
    for (const v of VIEWS) {
        const line = cats.split('\n').find((l) => l.includes(`view: '${v}'`))!;
        assert.match(line, /perm: 'curate_swan_index'/, `${v} must be gated: ${line.trim()}`);
    }
});

check('⚠️ the desk never SENDS a robots value — indexing is derived, not chosen', () => {
    // The whole SEO posture depends on robots following status. A control here would be a second
    // source of truth, and the two would part company the first time someone featured a piece
    // without ticking it. The UI may DISPLAY p.robots; it must never put it in a request body.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    assert.ok(js.length > 2000, 'could not slice the Swan Index admin script');
    assert.ok(!/robots\s*:/.test(js), 'the editorial desk must not build a robots field into any payload');
    assert.ok(js.includes('p.robots'), 'it should still display the resulting value');
});

check('the server refuses a robots value too — belt and braces', () => {
    // Even if the UI grew one, the endpoint must not honour it.
    const api = readFileSync(join(root, 'netlify/functions/admin-swan-index.ts'), 'utf8');
    assert.ok(!/body\.robots/.test(api), 'admin-swan-index.ts must never read robots from the request body');
    assert.ok(api.includes('transitionPatch'), 'it derives robots through transitionPatch');
});

check('the endpoint is gated on the permission it claims', () => {
    const api = readFileSync(join(root, 'netlify/functions/admin-swan-index.ts'), 'utf8');
    assert.match(api, /hasPermission\(row\?\.role, 'curate_swan_index'\)/);
});

check('declining is not possible without a reason', () => {
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    const decide = js.slice(landmark(js, 'async function swanDecide('), landmark(js, '// ── Front Page'));
    assert.match(decide, /status === 'rejected'/, 'swanDecide must special-case a decline');
    // The guard has to come BEFORE the request, or the note requirement is decorative.
    assert.ok(
        landmark(decide, "status === 'rejected'") < landmark(decide, 'await api('),
        'the note check must run before the PATCH is sent',
    );
});

check('a missing section list omits the control rather than offering only "none"', () => {
    // The overview request populates _swanSections. If it fails, rendering the <select> would give
    // the editor exactly one choice — no section — and the next save would send it, clearing a
    // section nobody touched. The control is omitted instead, and swanDecide only sends `section`
    // when the element exists.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    assert.ok(js.includes('const sectionsKnown = _swanSections.length > 0'), 'no guard on an empty section list');
    assert.ok(
        landmark(js, 'sectionsKnown') < landmark(js, 'id="swan-read-section"'),
        'the guard must be decided before the control is rendered',
    );
    assert.match(js, /section: document\.getElementById\('swan-read-section'\)\?\.value \?\? undefined/,
        'an absent control must send undefined, not an empty string');
});

check('a retired section stays selectable on a piece that already has it', () => {
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    assert.ok(js.includes('(retired)'), 'a deactivated section must still render as the current value');
});

check('suspension is confirmed through dialogs.js, not the browser box', () => {
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    assert.ok(!/window\.confirm\(/.test(js), 'use window.confirmModal — dialogs.js exists to replace confirm()');
    assert.ok(js.includes('window.confirmModal('), 'suspension must be confirmed');
    // Invented option keys are silently ignored by showConfirmModal, leaving a destructive action
    // behind a button reading "Confirm".
    for (const key of ['title:', 'confirmLabel:', 'cancelLabel:']) {
        assert.ok(js.includes(key), `confirmModal call is missing ${key}`);
    }
});

check('the front page offers all three reorder routes', () => {
    // Drag alone would make reordering mouse-only, and ▲▼ alone makes a piece travelling the length
    // of the list an O(n) clickfest. Each covers what the others cannot; losing one is a silent
    // accessibility or usability regression, not a broken feature anyone would notice in testing.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    const front = js.slice(landmark(js, '// ── Front Page'), landmark(js, '// ── Safe Content Benchmark panel'));
    assert.ok(front.includes("swanMove(${p.id}, 'up')"), 'the ▲ nudge is gone — keyboard users lose reordering');
    assert.ok(front.includes('swanMoveTo(${p.id}, this.value)'), 'the position control is not wired');
    assert.ok(front.includes('data-swan-grip'), 'no drag handle is rendered');
    assert.ok(front.includes('function swanReorder('), 'swanReorder is not defined');
});

check('⚠️ the drag handlers are bound ONCE, not on every render', () => {
    // The trap: loadSwanFrontPage() replaces the rows via innerHTML but KEEPS the container, and a
    // successful drop calls loadSwanFrontPage() again. Bind per render and the handler stack grows
    // every time the feature is used. Verified against a real browser rather than assumed: it does
    // NOT double-send, because the `_swanDragId === null` check in the drop handler runs before the
    // request and the later copies return early. What it does is run every dragstart and dragover N
    // times over, N climbing for as long as the view is open — jank on a long drag, and a listener
    // leak on a page left open all day.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    const bind = js.slice(landmark(js, 'function _swanBindDrag('), landmark(js, 'function _swanRowUnder('));
    assert.match(bind, /dataset\.dragBound === '1'\) return;/, 'no guard against re-binding the container');
    assert.ok(
        landmark(bind, 'dragBound') < landmark(bind, 'addEventListener'),
        'the guard must come BEFORE the first listener is attached',
    );
});

check('⚠️ a rejected reorder reloads the list — the optimistic DOM move must not survive', () => {
    // dragover rearranges the DOM as the pointer moves, so by the time the request fails the editor
    // is already looking at the new order. Reloading only on success would leave the front page
    // LOOKING reordered while the server holds the old order — the worst outcome available here,
    // because nothing on screen says the change did not take.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    const fn = js.slice(landmark(js, 'async function swanReorder('), landmark(js, 'function swanMoveTo('));
    assert.equal((fn.match(/loadSwanFrontPage\(\)/g) || []).length, 1, 'exactly one reload, on both paths');
    assert.ok(
        landmark(fn, 'catch (e)') < landmark(fn, 'loadSwanFrontPage()'),
        'the reload must sit AFTER the catch, so a failure reverts the view too',
    );
});

check('dragover cancels the event, or the drop never fires', () => {
    // HTML5 drag and drop: an uncancelled dragover means the element is not a valid drop target, so
    // `drop` is never dispatched. The rows would follow the pointer and then snap back, with no
    // request sent and no error — a feature that looks broken rather than one that reports a fault.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    const bind = js.slice(landmark(js, 'function _swanBindDrag('), landmark(js, 'function _swanRowUnder('));
    const over = bind.slice(landmark(bind, "addEventListener('dragover'"), landmark(bind, "addEventListener('drop'"));
    assert.match(over, /e\.preventDefault\(\)/, 'dragover must preventDefault');
});

check('only the grip is draggable — not the row around the controls', () => {
    // A draggable ancestor swallows the pointer interaction of the <select> and the buttons inside
    // it, which would take out the position control and ▲▼ — the two keyboard-reachable routes.
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    const front = js.slice(landmark(js, '// ── Front Page'), landmark(js, '// ── Safe Content Benchmark panel'));
    const row = front.slice(landmark(front, 'data-swan-id="${p.id}"'), landmark(front, 'data-swan-grip'));
    assert.ok(!/draggable/.test(row), 'the row element itself must not be draggable');
    assert.match(front, /data-swan-grip draggable="true"/, 'the grip is the draggable element');
});

check('the position control computes the right order — the real source, executed', () => {
    // Source-scanning proves swanMoveTo is WIRED; it says nothing about whether the splice is
    // right, and an off-by-one here reorders a live front page. So pull the two functions out of
    // admin.html as text and actually run them against a stub DOM: the arithmetic is checked, and
    // because the source is extracted rather than restated there is no copy to drift out of date.
    const cur = html.slice(landmark(html, 'function _swanCurrentOrder('), landmark(html, 'async function swanReorder('));
    const moveTo = html.slice(landmark(html, 'function swanMoveTo('), landmark(html, '// Delegated, and bound ONCE'));

    const rows = [10, 20, 30];
    const sent: number[][] = [];
    const doc = {
        getElementById: () => ({
            querySelectorAll: () => rows.map((id) => ({ dataset: { swanId: String(id) } })),
        }),
    };
    const swanMoveTo = new Function('document', 'swanReorder', `${cur}\n${moveTo}\nreturn swanMoveTo;`)(
        doc, (order: number[]) => sent.push(order),
    ) as (id: number, position: string | number) => void;

    swanMoveTo(30, 1);
    assert.deepEqual(sent.pop(), [30, 10, 20], 'the last piece jumping to the lead pushes the rest down');

    swanMoveTo(10, 3);
    assert.deepEqual(sent.pop(), [20, 30, 10], 'the lead dropping to last pulls the rest up');

    swanMoveTo(20, 3);
    assert.deepEqual(sent.pop(), [10, 30, 20], 'a middle piece moving down lands at the position asked for');

    // Out of range is clamped, not sent. The <select> can only offer 1..N, but swanMoveTo is a
    // global an editor can reach from the console and a clamp is cheaper than a 400.
    swanMoveTo(20, 99);
    assert.deepEqual(sent.pop(), [10, 30, 20], 'a position past the end clamps to last');
    swanMoveTo(20, 0);
    assert.deepEqual(sent.pop(), [20, 10, 30], 'a position below one clamps to the lead');

    // A no-op must not spend a request — every reorder is an audit-log row.
    swanMoveTo(10, 1);
    swanMoveTo(999, 2);   // not on the front page at all
    assert.deepEqual(sent, [], 'a move that changes nothing must send nothing');
});

check('the desk never reaches the reorder endpoint with an id', () => {
    // ?resource=reorder takes the whole order in the body and no id. An `&id=` on the URL would be
    // silently ignored by the server, which is the kind of thing that survives review as "working".
    const js = html.slice(landmark(html, '// ══ The Swan Index — editorial desk'),
                          landmark(html, '// Boot: restore from URL param'));
    assert.match(js, /\?resource=reorder`/, 'the reorder request must carry no query beyond the resource');
});

void reorderChecks()
    .catch((err) => { console.error(`  ✗ the reorder checks could not run\n    ${err}`); process.exitCode = 1; })
    .then(() => { console.log(`\n${passed} checks passed.`); });
