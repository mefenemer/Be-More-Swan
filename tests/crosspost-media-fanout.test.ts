// tests/crosspost-media-fanout.test.ts
// Adding media to a cross-post adds it to EVERY platform of that post.
//
// The bug: a cross-post is one scheduled_posts row per platform, and the review editor shows those
// rows as tabs over a single card. Every media endpoint wrote only the row whose id the client sent
// — the id of the selected tab. So a picture added to a post going to four platforms landed on one,
// the other three published without it, and nothing on screen said so: the tabs the reviewer had not
// clicked still showed their old media.
//
// Two halves are tested here:
//   1. mediaTargetPostIds, the shared rule for which rows a media write may touch — pure logic over a
//      fixture, reproducing the query the util runs.
//   2. That every media endpoint actually goes through it, and that the ONE caller which must not
//      fan out (the approve-time overlay bake) still doesn't. Source-level, because the alternative
//      is a live DB, four endpoints and an image pipeline to catch a one-line omission.
//
// Run:  npx tsx tests/crosspost-media-fanout.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MEDIA_EDITABLE_STATUSES, isMediaEditable } from '../src/config/post-status';
import { landmark } from './landmark';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');

interface Row { id: number; orgId: number; crosspostGroupId: string | null; status: string }

/** mediaTargetPostIds, reproduced over an in-memory table. */
function targetIds(rows: Row[], postId: number, orgId: number, applyToGroup = true): number[] {
    if (!applyToGroup) return [postId];
    const post = rows.find(r => r.id === postId && r.orgId === orgId);
    if (!post || !post.crosspostGroupId || !isMediaEditable(post.status)) return [postId];
    const siblings = rows.filter(r =>
        r.orgId === orgId &&
        r.crosspostGroupId === post.crosspostGroupId &&
        r.status === post.status &&
        (MEDIA_EDITABLE_STATUSES as readonly string[]).includes(r.status));
    return [postId, ...siblings.map(r => r.id).filter(id => id !== postId)];
}

// One 4-platform cross-post awaiting review, one lone post, and a same-group post that has already
// gone out (the sibling a naive "same group" rule would happily rewrite).
const rows: Row[] = [
    { id: 1, orgId: 10, crosspostGroupId: 'grp-a', status: 'pending_approval' },
    { id: 2, orgId: 10, crosspostGroupId: 'grp-a', status: 'pending_approval' },
    { id: 3, orgId: 10, crosspostGroupId: 'grp-a', status: 'pending_approval' },
    { id: 4, orgId: 10, crosspostGroupId: 'grp-a', status: 'pending_approval' },
    { id: 5, orgId: 10, crosspostGroupId: 'grp-a', status: 'published' },
    { id: 6, orgId: 10, crosspostGroupId: null, status: 'pending_approval' },
    { id: 7, orgId: 99, crosspostGroupId: 'grp-a', status: 'pending_approval' },   // another tenant
];

console.log('\ncross-post media fan-out\n');

check('media added to one platform lands on every platform of the post', () => {
    assert.deepEqual(targetIds(rows, 1, 10).sort(), [1, 2, 3, 4], 'the whole cross-post, not just the open tab');
    // From any tab, not just the first — the reviewer may be looking at LinkedIn.
    assert.deepEqual(targetIds(rows, 3, 10).sort(), [1, 2, 3, 4]);
});

check('the post the user is looking at comes first', () => {
    // Callers presign a thumbnail for the row the reviewer is on; "first" must be that row.
    assert.strictEqual(targetIds(rows, 3, 10)[0], 3);
});

check('a published sibling is never rewritten', () => {
    // Post 5 shares grp-a but has gone out. Its media is a matter of record.
    assert.ok(!targetIds(rows, 1, 10).includes(5), 'rewriting a published post rewrites history');
    // And the published post itself gets no fan-out, so its own endpoint can refuse it alone.
    assert.deepEqual(targetIds(rows, 5, 10), [5]);
});

check('a post with no siblings is unaffected', () => {
    assert.deepEqual(targetIds(rows, 6, 10), [6]);
});

check('the fan-out never crosses a tenant boundary', () => {
    // Post 7 carries the same group id under a different org — an id collision must not leak media
    // (or the presigned URL derived from it) into another workspace.
    assert.ok(!targetIds(rows, 1, 10).includes(7), 'another org\'s row is not a sibling');
});

check('opting out writes exactly one row, so a platform can differ', () => {
    // The second half of the requirement: all platforms by default, then change one individually.
    assert.deepEqual(targetIds(rows, 1, 10, false), [1]);
});

check('a target that does not exist still returns itself, never an empty write', () => {
    // An empty array would turn `inArray(id, [])` into a no-op UPDATE that reports success.
    assert.deepEqual(targetIds(rows, 404, 10), [404]);
});

// ── The wiring ──────────────────────────────────────────────────────────────────────────────────
const fn = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

check('every media endpoint routes its write through the shared rule', () => {
    for (const f of [
        'netlify/functions/attach-draft-media.ts',
        'netlify/functions/regenerate-post-media.ts',
        'netlify/functions/set-post-slides.ts',
        'netlify/functions/pexels-search.ts',
    ]) {
        assert.match(fn(f), /mediaTargetPostIds\(/, `${f} still writes a single post id`);
    }
});

check('the writes target the resolved list, not the requested id', () => {
    // The failure this catches: importing the helper, computing targetIds, and then leaving the
    // UPDATE on eq(id, postId) — which looks correct in review and fans out to nothing.
    for (const f of [
        'netlify/functions/attach-draft-media.ts',
        'netlify/functions/regenerate-post-media.ts',
        'netlify/functions/set-post-slides.ts',
    ]) {
        const src = fn(f);
        assert.match(src, /\.where\(inArray\(scheduledPosts\.id, targetIds\)\)/, `${f}: the post UPDATE must cover the group`);
        assert.match(src, /inArray\(scheduledPostAssets\.scheduledPostId, targetIds\)/, `${f}: the junction rows must too`);
    }
});

// ── A single-media picker SWAPS; it never appends ───────────────────────────────────────────────
// "Find a photo" (pexels-search → attachPexelsImageToPost), "Use my own" (attach-draft-media) and
// "Generate with AI" (regenerate-post-media) are three buttons on ONE panel, and the user cannot see
// which endpoint they reached. A carousel is built somewhere else entirely — set-post-slides, which
// alone knows each format's slide ceiling — so none of these three may ever leave a post holding
// more media than it started with.
//
// The stock picker did. It appended, and every consequence was silent: approve-post counts
// contentAssetIds against the format's maxItems, so a LinkedIn Feed post (max 1) that already had a
// picture was refused with "takes at most 1 — this post has 2"; without a format_key to catch it the
// post published BOTH images with the old one leading; and mediaMissing was never cleared, so the
// "⚠️ Media deleted → Source new media" prompt that sends you to this very picker came straight back.
check('every single-media picker replaces the post’s media rather than adding to it', () => {
    const pexels = fn('src/utils/pexels.ts');
    const attachFrom = pexels.indexOf('export async function attachPexelsImageToPost(');
    assert.ok(attachFrom !== -1, 'expected the stock-photo attach to exist');
    const attachPexels = pexels.slice(attachFrom);

    // The array write is the one publish-social-posts reads (resolvePostMediaList), so an append
    // here is what actually reaches LinkedIn.
    assert.match(attachPexels, /contentAssetIds: \[asset\.id\]/,
        'the stock picker must SET the post’s media, not append to whatever it already carried');
    assert.ok(!/contentAssetIds: \[\.\.\.existing/.test(attachPexels),
        'the append is back — a second picture blocks approval on any format with maxItems 1');

    // The junction table has to agree with the array, or approve-post and the publishers read two
    // different pictures off the same post.
    assert.match(attachPexels, /\.delete\(scheduledPostAssets\)[\s\S]{0,200}inArray\(scheduledPostAssets\.scheduledPostId, targets\)/,
        'the old junction rows must go before the replacement lands');

    for (const f of ['netlify/functions/attach-draft-media.ts', 'netlify/functions/regenerate-post-media.ts']) {
        assert.match(fn(f), /contentAssetIds: \[assetId\]/, `${f}: the sibling picker must swap too`);
    }
});

// Sourcing a replacement is the whole point of the "media deleted" prompt, so the flag it drives has
// to come off wherever that prompt can land the user. It cleared on two of the three paths.
check('sourcing new media clears the “media deleted” flag on every path that can source it', () => {
    for (const f of [
        'src/utils/pexels.ts',
        'netlify/functions/attach-draft-media.ts',
        'netlify/functions/regenerate-post-media.ts',
    ]) {
        assert.match(fn(f), /mediaMissing: false/, `${f}: the warning outlives the fix it asked for`);
        assert.match(fn(f), /mediaMissingNote: null/, `${f}: the note is what the banner prints`);
    }
});

// Overlays are positioned against a specific image. The editor has always ASSUMED the server drops
// them when the picture is swapped — gpAiShowThumb clears p.overlays and _gpOverlayCountByPost the
// moment a stock photo attaches — so a server that kept them left the cache and the row disagreeing
// about what is on the post.
check('swapping the picture drops the text that was placed on the old one', () => {
    assert.match(fn('src/utils/pexels.ts'), /imageOverlays: null,[\s\S]{0,120}overlayBaseAssetId: null/,
        'the stock picker must clear the overlay design and its base pin, like attach-draft-media');
    const ws = fn('workspace.html');
    const thumb = ws.slice(landmark(ws, 'function gpAiShowThumb('));
    assert.match(thumb.slice(0, 4000), /p\.overlays = \[\]/,
        'the client mirrors the reset — if it stops, the server-side clear above is the surprise');
});

check('the approve-time overlay bake still writes ONE post', () => {
    // The bake uploads an image flattened against a single post's overlay design. Fanning it out
    // would stamp one platform's text onto all of them — so keepOverlays opts out by default.
    assert.match(fn('netlify/functions/attach-draft-media.ts'),
        /applyToGroup: body\.applyToGroup \?\? !body\.keepOverlays/,
        'the bake must not inherit the fan-out default');
    const ws = fn('workspace.html');
    // Bounded by the NEXT function rather than a byte count. The old `slice(0, 1400)` was measuring
    // how much prose sits above the attach call, so ordinary edits to the function broke it while a
    // dropped keepOverlays would not have — the opposite of what it is for.
    const from = ws.indexOf('async function gpApplyOverlaysBeforeApprove(');
    assert.ok(from !== -1, 'expected the approve-time bake to exist');
    const after = ws.indexOf('\nasync function ', from + 1);
    const bake = ws.slice(from, after === -1 ? ws.length : after);
    assert.match(bake, /keepOverlays: true/, 'the bake is identified by keepOverlays');
    assert.ok(!/applyToGroup:\s*true/.test(bake), 'the bake must never opt INTO the fan-out');
});

// ── The overlay bake moved off the commit path ──────────────────────────────────────────────────
// Flattening the reviewer's text into the picture used to run at approval, on the one click they
// wait on, and cost two round trips PER PLATFORM even for a plain photo with no text — one asking
// whether a video render was needed, one shipping the whole image back as base64 so the client could
// read `overlays.length` and discard it.
//
// It now runs while they are still editing, and the commit answers "is there anything to bake?"
// from the cache. That is only safe because the server stopped trusting the browser: approve-post
// independently refuses a photo whose overlays are not flattened into the attached asset.
check('an unbaked photo cannot be approved, whatever the client believes', () => {
    const approve = fn('netlify/functions/approve-post.ts');
    assert.match(approve, /OVERLAYS_NOT_BAKED/,
        'approve-post must refuse a photo whose text is not baked in — the guarantee cannot live only in the browser');
    assert.match(approve, /isBakedFor\(/, 'the check must compare the attached asset against the CURRENT design');
    assert.match(approve, /!willBeVideo && renderableOverlays\(/,
        'video is exempt: its overlays are rendered on Lambda and gated by render_status instead');

    // A stale bake must fail the check too — a post baked and then edited still carries overlays and
    // a base pin, so identity alone cannot tell it from a current one.
    const render = fn('src/lib/post-render.ts');
    assert.match(render, /export function overlaysFingerprint\(/, 'the design needs a fingerprint to compare against');
    assert.match(render, /rp\.kind !== 'overlay_bake'/, 'an unstamped asset must read as NOT baked');
    assert.match(render, /Number\(rp\.postId\) !== Number\(postId\)/, "another post's bake must not count as this one's");

    // And the stamp has to be written from the SERVER's copy of the design, not the request body,
    // or a client could certify its own bake.
    const attach = fn('netlify/functions/attach-draft-media.ts');
    assert.match(attach, /kind: 'overlay_bake'/, 'the bake must stamp its output asset');
    assert.match(attach, /overlaysHash: overlaysFingerprint\(src\?\.imageOverlays\)/,
        'the fingerprint must come from the post row, never from the caller');
});

check('the client heals an unbaked post instead of reporting it', () => {
    const ws = fn('workspace.html');
    const one = ws.slice(landmark(ws, 'async function _rqApproveOne('));
    const body = one.slice(0, one.indexOf('\nasync function ') === -1 ? one.length : one.indexOf('\nasync function '));
    assert.match(body, /OVERLAYS_NOT_BAKED/, 'the 409 must be recognised, not shown as a generic failure');
    assert.match(body, /gpApplyOverlaysBeforeApprove\(post\.id, \{ force: true \}\)/,
        'the client is the thing that can bake — so it should bake and retry, not ask the user to');
    // Exactly one retry: a second refusal means the bake is not doing what it claims.
    const attempts = body.match(/OVERLAYS_NOT_BAKED/g) || [];
    assert.equal(attempts.length, 2, 'expected one retry — check, heal, check again, then give up');
});

check('nothing-to-bake is answered without a round trip', () => {
    const ws = fn('workspace.html');
    assert.match(ws, /function _pceNothingToBake\(/, 'the commit path must answer this from the cache');
    // Audio makes a still render as video (no platform takes a photo with sound), so a silent photo
    // with no text is the ONLY thing that may skip out early.
    const helper = ws.slice(landmark(ws, 'function _pceNothingToBake('));
    assert.match(helper.slice(0, 900), /hasAudio/, 'a photo with sound still needs a server render');
    assert.match(helper.slice(0, 900), /looksVideo/, 'a video still needs its Lambda render');
    assert.match(helper.slice(0, 900), /if \(!cached\) return false/, 'an unknown post must ask the server, as before');

    // The early bake must not fire for video, or every edit queues a paid Lambda render. It now
    // takes a LIST (a design applied across a cross-post is flattened into each platform's own
    // picture), so the video exclusion is a filter over that list rather than an early return.
    const sched = ws.slice(landmark(ws, 'function _pceScheduleOverlayBake('));
    const schedBody = sched.slice(0, 900);
    assert.match(schedBody, /looksVideo/,
        'baking on edit is for photos only — video would queue a render per keystroke-pause');
    assert.match(schedBody, /return !looksVideo/,
        'the video exclusion must survive the change to a list — a filter that keeps videos bakes them');
    assert.match(schedBody, /if \(!photos\.length\) return/,
        'an all-video group must schedule nothing at all');
});

// Deleting every text box must take the words off the PICTURE, not just out of the design. A baked
// post's attached asset IS the flattened image, so clearing the overlay list used to leave the
// burnt-in copy attached and the post published the text the user had just removed. Nothing
// downstream caught it: approve-post's guard is skipped when there are no overlays, and the base pin
// — the only record of the clean original — was nulled in the same write.
check('clearing the text restores the clean image', () => {
    const save = fn('netlify/functions/save-post-overlays.ts');
    assert.match(save, /if \(!overlays\.length && baseAssetId != null\)/,
        'clearing overlays on a post with a pinned base must undo the bake');
    assert.match(save, /contentAssetIds: \[baseAssetId\]/,
        'the deprecated array is what publish-social-posts reads — restoring only the junction table still publishes the flattened image');

    // Order is the whole trick: the pin is the only pointer to the clean original, so it cannot be
    // released until the restore has used it.
    const restore = save.indexOf('if (!overlays.length && baseAssetId != null)');
    const release = save.indexOf('overlayBaseAssetId: nextBase');
    assert.ok(restore !== -1 && release !== -1, 'expected both the restore and the pin release');
    assert.ok(restore < release, 'the base pin must not be cleared before the restore that needs it');

    // Same scope as the design write it undoes — no wider, no narrower. The reviewer chooses that
    // scope ("Apply to all platforms" in the Text layer), and the undo has to honour the SAME choice:
    // removing text from three platforms while restoring only one platform's picture would leave two
    // of them publishing words that no longer exist in the design.
    const block = save.slice(restore, release);
    assert.match(block, /eq\(scheduledPostAssets\.scheduledPostId, target\.id\)/,
        'the undo runs per target row, inside the same loop the design write does');
    assert.ok(!/mediaTargetPostIds/.test(block),
        'the undo must not resolve its own scope — it rides the list the design write already settled');
});

// Text on the picture is the reviewer's, and a cross-post is ONE post to them. Adding it on
// Instagram and finding Facebook bare — then adding it there too, and getting two designs on one
// post — was the whole complaint. So the design fans out on the same rule as every other media
// write, and the tick-box is how "just this platform" is said.
check('the text design takes the scope the reviewer chose', () => {
    const save = fn('netlify/functions/save-post-overlays.ts');
    assert.match(save, /mediaTargetPostIds\(db, \{/,
        'the design must resolve its targets through the one shared rule, like every other media write');
    assert.match(save, /applyToGroup: body\.applyToGroup === true/,
        'a caller that states no scope keeps the old single-post behaviour rather than fanning out silently');
    assert.match(save, /postIds: posts\.map\(p => p\.id\)/,
        'the client repaints the sibling tabs from this — a correct fan-out still LOOKS broken without it');

    // Each platform pins its OWN clean picture. Copying the anchor's base would make a sibling with
    // a different photo bake its text onto somebody else's image.
    assert.match(save, /target\.overlayBaseAssetId \?\? null/,
        "an existing pin wins, so a re-edit still composites onto the true original");
    assert.match(save, /await attachedAssetId\(target\)/,
        'a sibling with no pin yet takes the picture it actually has attached');

    const ws = fn('workspace.html');
    assert.match(ws, /id="insp-overlay-apply-all"[^>]*checked/,
        'all platforms is the DEFAULT here too, so it ships ticked');
    assert.match(ws, /applyToGroup: _pceOverlayApplyToGroup\(\)/,
        'removing the text must state the same scope as adding it');
    assert.match(ws, /baseAssetId: base\.assetId, applyToGroup/,
        'saving the design must state its scope rather than relying on the server default');
});

// ── The text appeared TWICE ─────────────────────────────────────────────────────────────────────
// A photo's design is flattened into a NEW asset as soon as the reviewer finishes editing it, and
// that asset becomes the post's attachment. The Review canvas paints `overlays` as a live layer over
// whatever preview the server hands back — so once the list was refetched, the words were on screen
// twice: burnt into the pixels, and again as the layer.
check('the review canvas never paints the live text layer over already-baked pixels', () => {
    const drafts = fn('netlify/functions/get-social-drafts.ts');
    assert.match(drafts, /overlayBaseAssetId: scheduledPosts\.overlayBaseAssetId/,
        'the endpoint cannot prefer the clean original without reading the pin');
    assert.match(drafts, /const previewAssetIds = \(/,
        'the preview resolves the clean pre-bake picture, not the flattened attachment');
    assert.match(drafts, /return \[overlayBaseAssetId\]/, 'the pinned original is what the canvas shows');
    assert.match(drafts, /if \(ids\.length !== 1 \|\| ids\[0\] === overlayBaseAssetId\) return contentAssetIds/,
        'an unbaked post, and a carousel, must be left exactly as they are');
    assert.match(drafts, /isVideoMedia\(media\)/,
        "a video keeps showing its rendered clip — the timeline is measured against that clip's length");
    // Publishing is untouched: every publisher reads content_asset_ids, which still holds the bake.
    assert.match(drafts, /hasMedia: Array\.isArray\(contentAssetIds\)/,
        'the approve gate must still answer from what is ATTACHED, not from the preview');
});

// The rule above, RUN rather than pattern-matched — lifted verbatim out of the handler so the four
// cases are checked against the code that ships, not against a copy of it that can drift.
check('the preview swap fires on exactly the baked photos and nothing else', () => {
    const drafts = fn('netlify/functions/get-social-drafts.ts');
    const from = drafts.indexOf('const previewAssetIds = (');
    assert.ok(from !== -1, 'expected the preview rule to exist');
    const to = drafts.indexOf('\n        };', from);
    assert.ok(to !== -1, 'expected the preview rule to be a self-contained arrow function');
    const src = drafts.slice(from, to + '\n        };'.length)
        .replace(/: unknown|: number \| null/g, '')       // strip the annotations; this is JS now
        .replace(/ as number\[\]/g, '');
    // eslint-disable-next-line no-new-func
    const previewAssetIds = new Function(`${src} return previewAssetIds;`)() as
        (ids: unknown, base: number | null, overlays: unknown) => unknown;

    const design = [{ text: 'hello' }];
    assert.deepEqual(previewAssetIds([77], 42, design), [42],
        'a baked photo must preview its CLEAN original, or the live layer doubles the words');
    assert.deepEqual(previewAssetIds([42], 42, design), [42],
        'a design that has not been baked yet is already showing the original — leave it alone');
    assert.deepEqual(previewAssetIds([77], null, design), [77],
        'no pin means no known original, so there is nothing safe to swap to');
    assert.deepEqual(previewAssetIds([77], 42, []), [77],
        'a post with no text has no live layer to double');
    assert.deepEqual(previewAssetIds([77, 78], 42, design), [77, 78],
        'a carousel has no single baked slide — swapping would drop the other slides');
    assert.deepEqual(previewAssetIds(null, 42, design), null,
        'a post with nothing attached must pass straight through');
});

// A cross-post sibling created AFTER the anchor baked its text inherited the flattened picture and
// the design — so the new platform showed the words twice and would have published them twice, since
// its own bake had no base pin and composited straight onto the baked pixels.
check('a new platform inherits the CLEAN picture, not the baked one', () => {
    const setp = fn('netlify/functions/set-post-platforms.ts');
    assert.match(setp, /overlayBaseAssetId: anchorBaseAssetId/,
        "the pin must travel with the design, or the sibling's bake has no clean original to composite onto");
    assert.match(setp, /contentAssetIds: copyAssetIds/,
        'the copy takes the clean original when the anchor has already baked');
    assert.match(setp, /const assetIds = copyAssetIds;/,
        'the junction rows must mirror the SAME assets as the legacy array, or the two disagree at publish time');
});

check('the editor sends the scope it showed, and can narrow it', () => {
    const ws = fn('workspace.html');
    // Every user-facing attach states its scope rather than relying on the server default.
    const calls = ws.match(/applyToGroup: gpApplyToGroup\(\)/g) || [];
    assert.ok(calls.length >= 5, `expected every media call site to send scope, found ${calls.length}`);
    // The checkbox exists, defaults to ticked, and is re-armed per post.
    assert.match(ws, /id="gp-ai-apply-all"[^>]*checked/, 'all platforms is the DEFAULT, so it ships ticked');
    assert.match(ws, /function gpApplyToGroup\(\)[\s\S]{0,400}return !cb \|\| !!cb\.checked/,
        'a missing checkbox must mean "all", not "none"');
    assert.match(ws, /gpAiSyncApplyAllRow\(postId\)/, 'reopening a post must re-arm the scope');
});

check('siblings are refreshed on screen, not left showing the old picture', () => {
    // The half of the bug that hid the other half: the tabs the user had not clicked kept rendering
    // their previous thumbnail, so a correct server-side fan-out would still look like it failed.
    const ws = fn('workspace.html');
    assert.match(ws, /function gpAiMirrorToSiblings\(/);
    const mirrors = ws.match(/gpAiMirrorToSiblings\(/g) || [];
    assert.ok(mirrors.length >= 5, `every attach path must mirror, found ${mirrors.length - 1} call sites`);
    for (const f of ['netlify/functions/attach-draft-media.ts', 'netlify/functions/set-post-slides.ts']) {
        assert.match(fn(f), /postIds: targetIds/, `${f} must tell the client which rows it wrote`);
    }
});

check('the editable-status rule has exactly one definition', () => {
    // set-post-slides used to carry its own copy of this list; the fan-out needs the same answer,
    // and two copies would eventually disagree about whether a post may still be changed.
    const slides = fn('netlify/functions/set-post-slides.ts');
    assert.ok(!/const EDITABLE = \[/.test(slides), 'the local copy is back');
    assert.match(slides, /isMediaEditable\(post\.status\)/);
    assert.deepEqual([...MEDIA_EDITABLE_STATUSES],
        ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'],
        'must match _pceIsEditablePost in workspace.html');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
