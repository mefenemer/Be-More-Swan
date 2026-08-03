// tests/youtube-short-drafting.test.ts
// The weekly YouTube Short: a brand card, rendered to a 10s 9:16 mp4, reviewed by a human.
//
// Run:  npx tsx tests/youtube-short-drafting.test.ts
//
// Two things are being protected here, and the first matters more than the feature.
//
// 1. THE EXISTING FAN-OUT IS UNTOUCHED. The Short deliberately rides beside the cross-post stream
//    rather than inside it, because a per-platform format would have meant rewriting the path every
//    assistant drafts through. If a future edit pulls YouTube into that path, the daily cross-post
//    is what breaks, and it breaks silently — a day that looks "covered" simply produces no post.
//
// 2. The Short's own invariants, each of which is a silent failure if wrong: a 1:1 card in a 9:16
//    frame publishes letterboxed; a still with no overlays hits the render worker's "nothing to do"
//    bail-out and leaves a video-only platform holding a photo; an unwatched video auto-published to
//    a real channel cannot be quietly undone.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    SHORT_ASPECT, SHORT_DURATION_S, SHORT_FORMAT_KEY, SHORT_HEIGHT, SHORT_MEDIA_SOURCES,
    SHORT_POST_FORMAT, SHORT_WIDTH, isYoutubeShortFormat,
} from '../src/config/youtube-short';
import { POST_FORMATS } from '../src/config/post-formats';
import { AUTONOMOUS_DRAFT_PLATFORMS } from '../src/utils/publish-policy';
import { readForceVideo, MAX_RENDER_SECONDS, RENDER_FPS } from '../src/lib/post-render';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

console.log('\nWeekly YouTube Short\n');

// ── 1. The existing drafting path must not have moved ────────────────────────

test('YouTube is still absent from the autonomous cross-post platforms', () => {
    // The Short is its OWN standalone job. If YouTube ever appears here it joins the one-idea
    // fan-out instead, which shares a single caption, format and asset across every sibling — so
    // YouTube would receive a 1:1 photo it cannot publish, and the other platforms would inherit
    // whatever the Short's format did to them.
    assert.equal((AUTONOMOUS_DRAFT_PLATFORMS as readonly string[]).includes('youtube'), false);
});

test('the weekly Short is excluded from cross-post coverage', () => {
    // Coverage is tallied per DAY, and the Short takes the same first-of-week slot as that day's
    // cross-post. Counting it would mark the day covered and cancel the ordinary post — one fewer
    // post a week, with nothing anywhere to say why.
    const s = src('src/utils/schedule-gap-fill.ts');
    assert.ok(/isWeeklyShort/.test(s), 'the coverage tally must exclude the standalone YouTube post');
    assert.ok(
        /platform === 'youtube' && !crosspostGroupId/.test(s),
        'the exclusion must be narrow: a YouTube post INSIDE a cross-post group still counts',
    );
});

test('the Short is enqueued as a standalone job, never as a fan-out', () => {
    // The shape lives in enqueueYoutubeShortJob, shared by the weekly cron and the on-demand
    // trigger. All three fields matter and none is self-explanatory: `platform` set with
    // `platforms` NULL is what process-content-jobs reads as "one post, this platform" (and so
    // takes the Short branch), and a null group id is what keeps it out of the cross-post card.
    const s = src('src/utils/schedule-gap-fill.ts');
    const helper = s.slice(s.indexOf('export async function enqueueYoutubeShortJob'));
    assert.ok(/platform: 'youtube'/.test(helper), 'the job must name its platform');
    assert.ok(/platforms: null/.test(helper), 'a platforms list would turn this into a fan-out');
    assert.ok(/crosspostGroupId: null/.test(helper), 'a group id would collapse it into the cross-post card');

    // ...and the weekly path must go through it rather than writing its own row.
    const weekly = s.slice(s.indexOf('if (shortSlot)'), s.indexOf('for (const slot of uncovered)'));
    assert.ok(/enqueueYoutubeShortJob\(db, \{/.test(weekly), 'the weekly enqueue must use the shared helper');
});

// ── 2. The Short's own invariants ────────────────────────────────────────────

test('the frame is a real Shorts frame, and the catalogue agrees', () => {
    assert.equal(SHORT_WIDTH, 1080);
    assert.equal(SHORT_HEIGHT, 1920);
    assert.equal(SHORT_WIDTH % 2, 0, 'h264 requires even dimensions');
    assert.equal(SHORT_HEIGHT % 2, 0, 'h264 requires even dimensions');
    assert.equal(SHORT_HEIGHT / SHORT_WIDTH, 16 / 9);

    const fmt = POST_FORMATS.find(f => f.key === SHORT_FORMAT_KEY);
    assert.ok(fmt, `${SHORT_FORMAT_KEY} is missing from the catalogue`);
    assert.ok(fmt!.aspectRatios.includes(SHORT_ASPECT), 'the card ratio must match the format the router validates');
    assert.equal(fmt!.media, 'video');
    assert.equal(fmt!.availability, 'live');
});

test('the duration fits the format and the render guard', () => {
    assert.ok(SHORT_DURATION_S > 0);
    const fmt = POST_FORMATS.find(f => f.key === SHORT_FORMAT_KEY)!;
    assert.ok(SHORT_DURATION_S <= (fmt.maxDurationS ?? Infinity), 'a Short longer than the format is refused at approve');
    assert.ok(SHORT_DURATION_S <= MAX_RENDER_SECONDS);
    assert.equal(Number.isInteger(SHORT_DURATION_S * RENDER_FPS), true, 'frames must be whole');
});

test('the card is the only media source', () => {
    // Stock and AI images arrive at the provider's chosen ratio; the composition draws a still with
    // objectFit:'contain', so anything that is not 9:16 publishes as a postage stamp on black.
    assert.deepEqual([...SHORT_MEDIA_SOURCES], ['brand_card']);
});

test('the still is generated at 9:16, not at YouTube\'s catalogue ratio', () => {
    // platformFormat('youtube') is 16:9 — that entry describes a standard video. Using it for the
    // card would letterboxed every Short.
    const s = src('netlify/functions/process-content-jobs.ts');
    assert.ok(
        /isYoutubeShort \|\| format === 'story'/.test(s),
        'the Short must take the 9:16 branch when choosing the aspect ratio',
    );
});

test('the draft describes itself as a video from the start', () => {
    assert.equal(SHORT_POST_FORMAT, 'video');
    assert.ok(isYoutubeShortFormat(SHORT_FORMAT_KEY));
    assert.equal(isYoutubeShortFormat('ig_reel'), false);
    assert.equal(isYoutubeShortFormat(null), false);

    const s = src('netlify/functions/process-content-jobs.ts');
    assert.ok(/formatKey: SHORT_FORMAT_KEY/.test(s), 'format_key drives the format router');
    assert.ok(/postFormat: isYoutubeShort \? SHORT_POST_FORMAT/.test(s), 'post_format drives the publishers');
});

test('the render is forced, because there is nothing to burn in', () => {
    // The card already carries the words, so the post has no overlays — and the worker's
    // "no overlays, nothing to do" bail-out would clear the gate and leave a still on YouTube.
    assert.equal(readForceVideo({ forceVideo: true }), true);
    assert.equal(readForceVideo({ width: 1080 }), false, 'an ordinary render input must not force');
    assert.equal(readForceVideo(null), false, 'rows written before the flag existed must not force');

    const worker = src('netlify/functions/render-post-video-background.ts');
    assert.ok(
        /!overlays\.length && !audio\.length && !readForceVideo\(job\.renderInput\)/.test(worker),
        'the bail-out must honour forceVideo',
    );
    const drafter = src('netlify/functions/process-content-jobs.ts');
    assert.ok(/forceVideo: true/.test(drafter), 'the Short must queue its render with forceVideo');
});

test('the rendered clip reports its own duration', () => {
    // validateAgainstFormat can only enforce a length it can see, and duration is otherwise read off
    // a <video> in the browser and never stored.
    const worker = src('netlify/functions/render-post-video-background.ts');
    assert.ok(/durationS: Math\.round\(meta\.durationInFrames \/ meta\.fps\)/.test(worker));
});

test('a failed render never strands the post as unpublishable', () => {
    // render_status holds the post at every publisher. Queueing without a worker behind it would
    // gate the post forever, so the helper rolls the gate back.
    const lib = src('src/lib/post-render.ts');
    const fn = lib.slice(lib.indexOf('export async function queuePostRender'));
    assert.ok(/renderStatus: null/.test(fn), 'a failed dispatch must un-gate the post');
    assert.ok(/status: 'failed'/.test(fn), 'and mark the job failed rather than leaving it queued');
    assert.ok(/await fetch\(/.test(fn), 'the trigger must be awaited or Lambda freezes before it leaves');
});

test('a video is never auto-published, whatever the policy says', () => {
    // brand_card is not held back by the AI-media rule (it is deterministic and on-brand, which is
    // sound for a still). A video nobody has watched, on a real channel, is not.
    const policy = src('src/utils/publish-policy.ts');
    const gate = policy.slice(policy.indexOf('export async function gateAutonomousDraft'));
    assert.ok(
        /AUTONOMOUS_DRAFT_PLATFORMS as readonly string\[\]\)\.includes\(args\.platform\)/.test(gate),
        'a platform with no autonomous drafter must always route to review',
    );
    assert.ok(
        gate.indexOf('includes(args.platform)') < gate.indexOf('getPlatformMode'),
        'the platform check must come FIRST — it cannot be overridden by an auto_publish policy',
    );
});

test('no renderer means no Short — never a draft gated on a render that cannot run', () => {
    // render_status gates every publisher on `IS NULL OR 'done'`, and a render that cannot run
    // settles the post at 'failed'. Queueing without a renderer therefore produces a draft that
    // looks approvable, accepts the approval, and then never publishes. Both ends refuse instead:
    // the enqueuer (no wasted model call) and the drafter (the environment could lose its config
    // between the two).
    const enq = src('src/utils/schedule-gap-fill.ts');
    const fn = enq.slice(enq.indexOf('async function resolveWeeklyShortSlot'));
    assert.ok(
        /if \(!remotionConfigured\(\) \|\| !r2IsConfigured\(\)\) return null;/.test(fn),
        'the weekly slot must not be claimed when there is no renderer',
    );

    const drafter = src('netlify/functions/process-content-jobs.ts');
    assert.ok(
        /isYoutubeShort && attachedMediaSource && remotionConfigured\(\) && r2IsConfigured\(\)/.test(drafter),
        'the drafter must not queue a render it cannot run',
    );
});

test('an autonomous Short uploads unlisted', () => {
    const s = src('netlify/functions/publish-youtube-background.ts');
    assert.ok(/privacyStatus: 'unlisted'/.test(s));
    assert.ok(
        /post\.triggerType !== 'manual'/.test(s),
        'a human-composed YouTube post must keep the normal privacy default',
    );
});

// ── 3. The on-demand trigger ─────────────────────────────────────────────────

test('the trigger and the weekly cron enqueue through the SAME helper', () => {
    // The job shape is load-bearing and looks unremarkable: platform set, platforms NULL, no group
    // id is what makes the drafter take the Short branch. A second hand-written copy that said
    // `platforms: ['youtube']` would read identically and would quietly draft an ordinary 16:9
    // YouTube post that can never publish.
    const gap = src('src/utils/schedule-gap-fill.ts');
    assert.ok(/export async function enqueueYoutubeShortJob/.test(gap), 'the shape must have one definition');
    assert.equal(
        (gap.match(/platform: 'youtube'/g) || []).length, 1,
        'schedule-gap-fill should name the platform exactly once — inside the shared helper',
    );

    const trigger = src('netlify/functions/trigger-youtube-short.ts');
    assert.ok(/enqueueYoutubeShortJob\(/.test(trigger), 'the trigger must reuse the helper, not rebuild the job');
    assert.ok(
        !/insert\(contentGenerationJobs\)/.test(trigger),
        'the trigger must not write its own job row',
    );
});

test('the trigger refuses when there is no renderer or no YouTube', () => {
    const s = src('netlify/functions/trigger-youtube-short.ts');
    assert.ok(/RENDER_UNAVAILABLE/.test(s), 'must refuse before drafting when Remotion/R2 are unset');
    assert.ok(/YOUTUBE_NOT_CONNECTED/.test(s));
    // Order matters: both refusals must precede the enqueue, or the caller pays for a model call
    // to produce a draft that cannot publish.
    assert.ok(
        s.indexOf('RENDER_UNAVAILABLE') < s.indexOf('enqueueYoutubeShortJob(db, {'),
        'the render check must come before the enqueue',
    );
});

test('the queue poke is awaited, and an abort still counts as sent', () => {
    // An un-awaited fetch never leaves a frozen Lambda — the documented way to strand a job. But we
    // also refuse to block on a full drain, so the client aborts at 5s and reports success: the
    // request has already left, and aborting our end does not stop the server.
    const s = src('netlify/functions/trigger-youtube-short.ts');
    const fn = s.slice(s.indexOf('async function pokeQueue'), s.indexOf('export default'));
    assert.ok(/await fetch\(/.test(fn), 'the poke must be awaited');
    assert.ok(/AbortError/.test(fn), 'an abort means the drain is running, not that it failed');
});

// ── 4. Retrying a Short's render ─────────────────────────────────────────────

test('a retry keeps forcing the video — it must not "skip" a Short back to a still', () => {
    // The bug this guards, seen in production on post 345: a Short whose first render failed offers
    // "Try the render again", which posts to trigger-post-render — an endpoint written for the OTHER
    // caller, a reviewer approving a video with text on it. It asked only "is there something to
    // burn in?", found no overlays and no audio on a brand card, answered skipped:'not_video' and
    // CLEARED render_status. The banner disappeared, so it read as success; the post kept its PNG,
    // silently lost its publish gate, and the format router refused it with "A Short can't carry
    // this — Short takes video, and this is image". The cause is two paths building the same render
    // input independently, so the invariant is: whatever decides to render, forceVideo survives.
    const s = src('netlify/functions/trigger-post-render.ts');
    assert.ok(/forceVideo/.test(s), 'the retry path must be able to force a container-only render');
    assert.ok(
        /postFormatSpec\(/.test(s),
        'the decision must come from the declared format spec, not a hardcoded yt_short check',
    );
    // The guard has to sit IN the skip condition. Computing forceVideo and then skipping anyway is
    // exactly the shape of the original bug.
    assert.ok(
        /if \(!forceVideo && !needsVideoRender\(/.test(s),
        'a forced render must bypass the needsVideoRender skip, not merely be computed beside it',
    );
    assert.ok(
        s.indexOf('const forceVideo') < s.indexOf('!needsVideoRender('),
        'forceVideo must be decided before the skip branch can clear the gate',
    );
});

test('a forced retry re-uses the drafter\'s frame metadata, not the 15s default', () => {
    // There is no <video> element behind a still, so the client sends no durationS and frameMeta
    // falls back to a generic 15s — which would republish a 10s Short as a 15s one, with nothing
    // anywhere reporting a change. The previous job's snapshot carries the real numbers.
    const s = src('netlify/functions/trigger-post-render.ts');
    assert.ok(/frameMetaFromJson\(/.test(s), 'a retry should recover the earlier snapshot');
    assert.ok(
        /postRenderJobs\.id\)/.test(s) && /desc\(/.test(s),
        'it must take the LATEST prior job, not an arbitrary one',
    );
});

console.log(`\n${passed} checks passed\n`);
