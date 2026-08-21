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
import {
    robotsForStatus, canTransition, transitionPatch, isCurationStatus,
    parseEditorScore, parseMonthlyCap, normaliseNote,
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

console.log(`\n${passed} checks passed.`);
