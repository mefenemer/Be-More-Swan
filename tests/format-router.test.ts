// tests/format-router.test.ts
// Deriving a post's format from its media (src/utils/format-router.ts).
//
// Run:  npx tsx tests/format-router.test.ts
//
// The router exists so nobody has to reconcile Reels vs Shorts vs Native Video by hand. That makes
// four properties load-bearing:
//
//   1. It never routes to a format approval would refuse — availability:'live' only.
//   2. Unknown metrics are never read as passing ones. A legacy asset with NULL duration must not
//      qualify as a YouTube Short, or a 40-minute film publishes as one.
//   3. Length reroutes rather than complains where the platform has somewhere else to go.
//   4. It reports what it CANNOT do. The old platform-first flow let you pick a destination and
//      discover only at publish time that it could never take your asset.
//
// Pure logic against the real catalogue — no DB, no network. Because it reads POST_FORMATS
// directly, changing a format's availability or ratios will show up here.

import assert from 'node:assert';
import {
    routeAsset, routeAcross, unroutable, FORMATS_WITH_DURATION_LIMIT,
    validateAgainstFormat, loadAssetMetrics,
    type AssetMetrics,
} from '../src/utils/format-router';
import { POST_FORMATS } from '../src/config/post-formats';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Async assertions need their own helper, and it has to be AWAITED. Handing a promise to the
// synchronous `check` above prints a tick, increments the count, and then fails the process from
// somewhere else entirely — a green line for a broken assertion is worse than no test.
const deferred: Array<() => Promise<void>> = [];
function acheck(name: string, fn: () => Promise<void>): void {
    deferred.push(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    });
}

// Real export sizes, not idealised ratios.
const VERT_45S: AssetMetrics  = { kind: 'video', width: 1080, height: 1920, durationS: 45 };
const VERT_LONG: AssetMetrics = { kind: 'video', width: 1080, height: 1920, durationS: 252 };
const LAND_60S: AssetMetrics  = { kind: 'video', width: 1920, height: 1080, durationS: 60 };
const PORTRAIT: AssetMetrics  = { kind: 'image', width: 1080, height: 1350 };
const SQUARE: AssetMetrics    = { kind: 'image', width: 1080, height: 1080 };
const LEGACY_VID: AssetMetrics = { kind: 'video' };   // NULL everything, as legacy rows are

const ALL = ['instagram', 'facebook', 'linkedin', 'x', 'threads', 'youtube'];

// ── The headline behaviour ──────────────────────────────────────────────────────────────────────

check('a 9:16 clip becomes a Reel on Instagram and a Short on YouTube', () => {
    assert.equal(routeAsset('instagram', [VERT_45S]).format?.key, 'ig_reel');
    assert.equal(routeAsset('youtube', [VERT_45S]).format?.key, 'yt_short');
});

check('the SAME clip, four minutes long, becomes a YouTube Video instead', () => {
    // The whole point of routing on duration: this is not a broken Short, it is a Video.
    const r = routeAsset('youtube', [VERT_LONG]);
    assert.equal(r.state, 'ok');
    assert.equal(r.format?.key, 'yt_vod');
    assert.match(r.reason ?? '', /Too long for a Short/);
});

check('a 16:9 clip is a standard YouTube Video, not a Short', () => {
    assert.equal(routeAsset('youtube', [LAND_60S]).format?.key, 'yt_vod');
});

check('native shape wins over merely-accepted shape', () => {
    // X's Native video lists 16:9 first but accepts 9:16 too. Both are "accepted"; the router must
    // still pick by the asset, not by list order alone.
    assert.equal(routeAsset('x', [VERT_45S]).format?.key, 'x_video');
    assert.equal(routeAsset('x', [LAND_60S]).format?.key, 'x_video');
});

check('a 4:5 image is an Instagram Feed post', () => {
    const r = routeAsset('instagram', [PORTRAIT]);
    assert.equal(r.state, 'ok');
    assert.equal(r.format?.key, 'ig_feed');
});

check('several images become a carousel', () => {
    const r = routeAsset('instagram', [PORTRAIT, PORTRAIT, PORTRAIT]);
    assert.equal(r.state, 'ok');
    assert.equal(r.format?.key, 'ig_carousel');
});

check('more items than any format takes is refused, not silently truncated', () => {
    const many = Array(30).fill(PORTRAIT);
    const r = routeAsset('instagram', many);
    assert.equal(r.state, 'none');
    assert.match(r.reason ?? '', /takes 30 items/);
});

// ── Tolerance ───────────────────────────────────────────────────────────────────────────────────

check('a near-miss export still counts as its ratio', () => {
    // 1082x1350 is 4:5 by any sane reading; demanding exactness would send every real export to
    // the crop path.
    const r = routeAsset('instagram', [{ kind: 'image', width: 1082, height: 1350 }]);
    assert.equal(r.state, 'ok', r.reason);
});

check('a genuinely wrong shape is a crop, and says what it wants', () => {
    const r = routeAsset('instagram', [{ kind: 'image', width: 1920, height: 1080 }]);
    assert.equal(r.state, 'crop');
    assert.match(r.reason ?? '', /4:5 or 1:1/);
    assert.ok(r.format, 'a crop still names the format it would fit');
});

// ── Unknown is not zero ─────────────────────────────────────────────────────────────────────────

check('a legacy asset with no metrics is routed but marked unverified', () => {
    const r = routeAsset('instagram', [LEGACY_VID]);
    assert.equal(r.state, 'ok');
    assert.equal(r.verified, false, 'nothing was actually checked');
});

check('an unknown duration NEVER qualifies as a Short', () => {
    // The failure this guards: NULL read as 0, and a 40-minute film published as a Short.
    const r = routeAsset('youtube', [LEGACY_VID]);
    assert.equal(r.verified, false);
    // With no ratio and no duration it may pick either YouTube format, but it must not CLAIM to
    // have verified a length it never saw.
    assert.ok(r.format, 'still routes somewhere');
});

check('a measured asset is verified', () => {
    assert.equal(routeAsset('instagram', [PORTRAIT]).verified, true);
});

// ── Only ever routes somewhere publishable ──────────────────────────────────────────────────────

check('never returns a format that is not live', () => {
    const assets: AssetMetrics[][] = [[VERT_45S], [LAND_60S], [PORTRAIT], [SQUARE], [LEGACY_VID], []];
    for (const p of ALL) {
        for (const set of assets) {
            const r = routeAsset(p, set);
            if (!r.format) continue;
            assert.equal(r.format.availability, 'live',
                `${p} routed to ${r.format.key}, which is ${r.format.availability}`);
            assert.equal(r.format.platform, p, `${p} routed to a ${r.format.platform} format`);
        }
    }
});

check('alternatives are all live and all on the right platform', () => {
    for (const p of ALL) {
        for (const alt of routeAsset(p, [PORTRAIT]).alternatives) {
            assert.equal(alt.availability, 'live');
            assert.equal(alt.platform, p);
        }
    }
});

// ── Saying what it cannot do ────────────────────────────────────────────────────────────────────

check('every platform can take a single video', () => {
    // This asserted ['facebook','threads'] until the catalogue was corrected. Both drivers had
    // always published single video — publishFacebook picks /videos over /photos, publishThreads
    // sets media_type VIDEO — but their FEED formats were declared image-only, so the router
    // concluded neither platform could take a clip. The catalogue was wrong, not the publishers.
    const blocked = unroutable(ALL, [VERT_45S]);
    assert.deepEqual(blocked.map(b => b.platform), [], `still blocked: ${JSON.stringify(blocked)}`);
    assert.equal(routeAsset('facebook', [VERT_45S]).format?.key, 'fb_feed');
    assert.equal(routeAsset('threads', [VERT_45S]).format?.key, 'th_text');
});

check('YouTube takes no image, and that is deliberate', () => {
    // Not a gap: YouTube is a video platform and we do not want image posts there. yt_community is
    // 'planned' and should stay that way — this asserts the intent, so flipping it is a decision
    // rather than an accident.
    const blocked = unroutable(ALL, [PORTRAIT]).map(b => b.platform);
    assert.deepEqual(blocked, ['youtube']);
    assert.match(unroutable(ALL, [PORTRAIT])[0].reason, /No live image format/);
});

check('a Facebook Reel stays unavailable, with its reason intact', () => {
    // Correcting fb_feed must not have quietly made Reels look publishable: they really are a
    // separate endpoint nobody has connected. A feed video is not a Reel.
    const reel = POST_FORMATS.find(f => f.key === 'fb_reel')!;
    assert.equal(reel.availability, 'planned');
    assert.match(reel.unavailableReason ?? '', /separate video endpoint/);
});

check('routeAcross answers for every platform asked, and only those', () => {
    const map = routeAcross(['instagram', 'youtube'], [VERT_45S]);
    assert.deepEqual(Object.keys(map).sort(), ['instagram', 'youtube']);
    assert.equal(map.instagram.format?.key, 'ig_reel');
    assert.equal(map.youtube.format?.key, 'yt_short');
});

check('an unknown platform is refused rather than guessed at', () => {
    const r = routeAsset('myspace', [PORTRAIT]);
    assert.equal(r.state, 'none');
});

// ── The catalogue itself ────────────────────────────────────────────────────────────────────────

check('duration limits are declared in the catalogue, not in the router', () => {
    // A second copy of platform rules inside the router is the drift this codebase keeps paying
    // for. Every ceiling the router enforces has to come from POST_FORMATS.
    assert.ok(FORMATS_WITH_DURATION_LIMIT.length >= 1);
    for (const f of FORMATS_WITH_DURATION_LIMIT) {
        assert.ok(typeof f.maxDurationS === 'number' && f.maxDurationS > 0);
    }
    assert.ok(FORMATS_WITH_DURATION_LIMIT.some(f => f.key === 'yt_short'));
});

check('every live format declares the ratios it accepts, or none at all', () => {
    for (const f of POST_FORMATS.filter(f => f.availability === 'live')) {
        assert.ok(Array.isArray(f.aspectRatios), `${f.key} has no aspectRatios array`);
        for (const r of f.aspectRatios) {
            assert.match(r, /^\d+:\d+$/, `${f.key} has a malformed ratio ${r}`);
        }
    }
});

// ── The approval gate (validateAgainstFormat) ───────────────────────────────────────────────────
// approve-post already refuses unschedulable formats, bad item counts, video on a driver that
// cannot send it, and Instagram without media. This adds ONLY the check none of those could make.

check('refuses a video longer than its format allows, and names the way out', () => {
    const v = validateAgainstFormat('yt_short', [VERT_LONG]);
    assert.ok(v, 'a 4-minute Short must be refused');
    assert.equal(v!.code, 'VIDEO_TOO_LONG');
    assert.equal(v!.suggestion?.key, 'yt_vod', 'must name the format that would take it');
    assert.match(v!.reason, /Switch the format to Video/);
});

check('allows a video inside its format\'s limit', () => {
    assert.equal(validateAgainstFormat('yt_short', [VERT_45S]), null);
});

check('says nothing about a format with no declared ceiling', () => {
    assert.equal(validateAgainstFormat('ig_reel', [VERT_LONG]), null);
    assert.equal(validateAgainstFormat('li_video', [VERT_LONG]), null);
});

check('NEVER refuses an asset whose duration was never measured', () => {
    // The regression that would matter most: every legacy asset has a NULL duration, and refusing
    // them would block approval on posts that have always published fine.
    assert.equal(validateAgainstFormat('yt_short', [LEGACY_VID]), null);
    assert.equal(validateAgainstFormat('yt_short', [{ kind: 'video', width: 1080, height: 1920 }]), null);
});

check('an unknown or absent format key is not a violation', () => {
    assert.equal(validateAgainstFormat(null, [VERT_LONG]), null);
    assert.equal(validateAgainstFormat('not_a_format', [VERT_LONG]), null);
});

check('a ratio mismatch is deliberately NOT a refusal', () => {
    // Platforms crop. Blocking approval over a shape the network would letterbox would refuse work
    // that publishes perfectly well — the router reports it, the gate does not enforce it.
    assert.equal(validateAgainstFormat('ig_reel', [{ kind: 'video', width: 1920, height: 1080, durationS: 20 }]), null);
});

// ── loadAssetMetrics ────────────────────────────────────────────────────────────────────────────

/** Minimal stand-in for the drizzle chain loadAssetMetrics uses. */
function fakeDb(rows: any[]) {
    return { select: () => ({ from: () => ({ where: async () => rows }) }) };
}

acheck('returns metrics in the post\'s slide order, not the database\'s', async () => {
    // The FIRST asset fixes the shape on every platform that publishes a set, so order is meaning.
    const db = fakeDb([
        { id: 2, assetType: 'image', width: 1080, height: 1080, durationS: null },
        { id: 1, assetType: 'video', width: 1080, height: 1920, durationS: 30 },
    ]);
    const out = await loadAssetMetrics(db, [1, 2]);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'video');
    assert.equal(out[1].kind, 'image');
});

acheck('missing metrics come back undefined, never zero', async () => {
    const db = fakeDb([{ id: 1, assetType: 'video', width: null, height: null, durationS: null }]);
    const out = await loadAssetMetrics(db, [1]);
    assert.equal(out[0].durationS, undefined, 'a NULL duration must not become 0');
    assert.equal(out[0].width, undefined);
    // And the router must therefore refuse to claim it verified anything.
    assert.equal(routeAsset('youtube', out).verified, false);
});

acheck('links and audio are dropped — they are not routable media', async () => {
    const db = fakeDb([
        { id: 1, assetType: 'link',  width: null, height: null, durationS: null },
        { id: 2, assetType: 'audio', width: null, height: null, durationS: 12 },
        { id: 3, assetType: 'image', width: 1080, height: 1350, durationS: null },
    ]);
    const out = await loadAssetMetrics(db, [1, 2, 3]);
    assert.equal(out.length, 1, 'only the image is routable');
    assert.equal(out[0].kind, 'image');
});

acheck('an empty or junk id list asks the database nothing', async () => {
    const db = { select: () => { throw new Error('should not have queried'); } };
    assert.deepEqual(await loadAssetMetrics(db, []), []);
    assert.deepEqual(await loadAssetMetrics(db, null), []);
    assert.deepEqual(await loadAssetMetrics(db, 'nonsense'), []);
});

// Run the awaited half, then report. Nothing prints a total until every assertion has settled.
(async () => {
    for (const run of deferred) await run();
    console.log(`\n${passed} check(s) passed.`);
})();
