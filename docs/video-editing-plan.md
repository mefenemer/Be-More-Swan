# Video editing for the social media assistant — implementation plan

Status: **phases 1–4 + the font fix PROVEN by real renders; phase 5 PARTIAL (clip list + crop frame built, timeline-drag / sequential preview NOT built) — 2026-09-10. BOTH Remotion sites on `0addd793aa37cf5a`; `video_edit` applied to BOTH databases; app code NOT yet pushed** — phase 6 deferred

Roles in scope: `social_media_manager`
Prompted by: a prod user (Limi DJ) asking the assistant to "create a reel with these 4 videos I uploaded"

📋 **Release state, 2026-09-10.** `video_edit` is on staging and prod. Both Remotion sites are on
`0addd793aa37cf5a` (verified by fetching both `bundle.js` files — byte-identical, and both contain
`Arimo`, `Anton`, `delayRender` and `fadeInS`). **The app code is the only half not yet shipped.**
Until it is, prod previews the OS fonts in the editor while the renderer draws webfonts — the smaller
of the two possible windows, and already an improvement for the five metric clones, whose OS face and
webfont are metrically identical.

✅ **The code is now safe to ship ahead of the migration.** Every reader fetches `video_edit`
separately behind a try/catch, so an environment without the column treats every post as unedited —
which is how it behaved before this work existed. Applying the SQL is what switches the feature on,
not what stops the deploy breaking. (This was NOT true of phases 1–4 as first written; see §7.)

✅ Remotion sites deployed 2026-09-10, staging and prod, bundle `c1d0500a7b814bac`, verified
byte-identical by fetching both `bundle.js` files and grepping for `targetRatio` and `fadeInS`
(the latter appears only if the fade is actually read at runtime). The bundle is backward compatible:
old inputProps carry no `clips`, so existing posts render exactly as before.

⚠️ **Verify a phase against the code before quoting it as outstanding.** `blog-media-composition-plan.md`
sat claiming "no code yet" for a month while four phases shipped. Update this status line in the same
commit that lands a phase.

Trim, stitch, sound and per-platform re-framing for video posts. Today a post carries exactly one
clip, and the only server-side video work is burning timed text overlays onto it
(`remotion/PostOverlay.tsx`, driven by `src/lib/post-render.ts`).

---

## 1. The governing idea: one cut, many frames

Editing is **platform-agnostic**. The user trims and orders clips once, against no platform in
particular, producing a single 9:16 master. Framing is the only thing that varies per platform, and
it is derived, never asked for — the same principle `src/utils/format-router.ts` already applies to
stills.

This is cheap because of how the live formats fall out (`src/config/post-formats.ts`):

| Platform | Live video format | Accepted ratios | Takes the master? |
| --- | --- | --- | --- |
| Instagram | `ig_reel` | 9:16 | yes, as-is |
| LinkedIn | `li_video` | 16:9 · 9:16 · 1:1 | yes, as-is |
| X | `x_video` | 16:9 · 9:16 · 1:1 | yes, as-is |
| YouTube | `yt_short` | 9:16, ≤180s | yes, under 3 min |
| Facebook | `fb_feed` | 1:1 · 4:5 · 16:9 | no — 1:1 derivative |
| Threads | `th_text` | 1:1 · 4:5 | no — 1:1 derivative |

**Two renders per post at most**, regardless of how many platforms are selected: Facebook's feed and
Threads both accept 1:1, so they share one derivative. That matters because renders are quota-bound
(§7).

Facebook only needs the crop because `fb_reel` is `availability: 'planned'` — Facebook Reels use a
separate endpoint we have never connected, so vertical video lands in the feed. Building that
endpoint later removes Facebook from the derivative column and gets the master to five platforms.

Over 180s, YouTube stops being a Short and `yt_short` → `yt_vod` wants 16:9 — a third render, at the
length where renders are already most expensive. **Cap v1 at three minutes** and say so in the editor.

---

## 2. What already exists

Half the proposed feature set shipped months ago. Finishing it is cheaper than building it.

**Timed text overlays — built.** Boxes with `[startS, endS)`, a drag timeline in the post editor, a
Remotion Lambda bake on approve. `render_status` is the publish gate for all three publishers. See
`docs/remotion-render.md`.

**Own music — mostly built.** `src/lib/audio-overlays.ts` models audio exactly like `image_overlays`;
the Sound layer in the editor takes an upload or a mic recording. A music file is the same object as
a voice note. Two gaps:

- **Fades are dead data.** `AUDIO_DEFAULTS` sets `fadeInS`/`fadeOutS`, `audio-overlays.ts:74-75`
  normalises them, they reach the composition in `PostOverlayProps` — and `remotion/PostOverlay.tsx:73`
  applies only `volume` and `trimBefore`. Every track hard-cuts.
- **No control over source audio.** `<OffthreadVideo src={videoSrc} />` plays the clip's own audio at
  full volume with no gain parameter anywhere. "Add music" currently means music *plus* camera audio.

**The assistant already writes the creative direction — and we throw it away.** For `format === 'reel'
|| 'video'`, `process-content-jobs.ts:472` asks the model for a shot-by-shot `reelScript` and an array
of `textOverlays`. Both are generated, then flattened into the media brief as prose at
`process-content-jobs.ts:691` ("no new column needed") because there was no timeline to put them on.
Phase 1 makes them material rather than advice — no new prompt, no extra model call.

**Trim, stitch and re-framing — nothing.** The composition takes one `videoSrc` and derives its output
frame by measuring that clip (`remotion/Root.tsx` `calculateMetadata`).

---

## 3. Division of labour: user vs assistant

The line is **taste and footage**. The assistant never watches the video — everything it contributes
is derived from the brief it wrote, not from the clips it was given.

| Step | Who | Notes |
| --- | --- | --- |
| Upload footage | User | Multi-file upload already works (`gpUploadContentAssets`, commit `5141780`) |
| Caption, hashtags, script, on-screen text | Assistant | Already built, see §2 |
| Pick which clips | User | No vision on clip content — it cannot know which take is good |
| Trim each clip | User | The taste part; keep it manual |
| Clip order | Assistant proposes | It wrote the script, so it can order against its own beats |
| Place overlay text | Assistant proposes | `textOverlays` arrive placed and roughly timed |
| Sound defaults | Assistant proposes | Mute camera audio when a track is present; set the fade |
| Platforms | Assistant | Already picks from the assistant's configured platforms |
| Format per platform | System | Derived by `format-router.ts`, never asked for |
| Re-frame for FB/Threads | Automatic, visible | Centred default, shown with safe area, draggable (§6) |
| Schedule | Assistant | Already picks a slot; publish stays gated on approval unless autopilot |

**Open question for product:** seed everything and open the editor on the assistant's version, or
start empty with the script alongside? Seeding is the better demo and risks feeling like someone
else's cut. Recommendation: seed, but never publish from a seeded cut without review.

**Named as v2, not v1:** extracting frames and passing them to a vision model to find the usable
seconds. A demo of this feature will strongly imply we already do it — say that we don't.

---

## 4. Phase 0 — clear the ceilings (no code, start immediately)

These have external lead times and gate everything downstream.

1. **Request an AWS Lambda concurrency increase.** ⚠️ **Blocked on the console — 2026-09-10.** The
   AWS account is a SUB-ACCOUNT of an Organization, so `npx remotion lambda quotas increase` refuses:
   a member account's request must be raised at
   `https://eu-west-2.console.aws.amazon.com/servicequotas/home/services/lambda/quotas/L-B99A9384`
   (quota `L-B99A9384`, region eu-west-2), possibly from the management account. Don't retry the CLI.

   ✅ **The other half of this ceiling is fixed:** a 300s-per-chunk function is deployed
   (`remotion-render-4-0-498-mem2048mb-disk2048mb-300sec`). It is NOT in use yet —
   `REMOTION_LAMBDA_FUNCTION_NAME` still names the 120sec one in both Netlify contexts. The timeout,
   not the concurrency cap, is what actually stopped a 45s reel.

   Original note: account limit is 10 (`npx remotion lambda quotas`),
   and the deployed function times out at **120s per chunk**
   (`remotion-render-4-0-498-mem2048mb-disk2048mb-120sec`). A 10s Short already had to be throttled to
   fit — `src/lib/remotion-lambda.ts` pins `concurrency` from `REMOTION_MAX_LAMBDAS` (default 3) for
   exactly this reason. Fewer Lambdas means more frames each against that 120s ceiling, so
   `REMOTION_MAX_LAMBDAS` is also the real cap on clip length. A 45s stitched reel will not render
   until this moves.
2. ~~**Render one video WITH text overlays through Lambda.**~~ 🔴 **DONE 2026-09-10 — and it DOES
   substitute.** First render ever with real timed text boxes, compared frame-for-frame against
   `npx remotion still` on the Mac with identical props: the letterforms differ (C terminals, E arms,
   N junctions — consistent with DejaVu Sans, not a metric-compatible face) and **the box is visibly
   narrower on Lambda**. Since the box is sized by the rendered text, the geometry moves with it, so
   the editor preview is not what publishes.

   ✅ **FIXED and PROVEN the same day.** `src/lib/overlay-fonts.ts` maps every picker name to a
   webfont stack; the editor, the browser bake and the composition all resolve through it, and
   `useOverlayFonts` in `PostOverlay.tsx` holds the render (`delayRender`) until the faces are
   downloaded. Re-rendered the same frame on Lambda and compared against a fresh local still: the
   letterforms and the box now match.

   🚨 **The fix has TWO halves and they must ship together, per environment.** The site bundle
   resolves fonts through the new module; the app code (editor + generated constants) resolves them
   the same way. Deploying only one half leaves the preview and the render disagreeing again — just
   differently. Staging currently has the new BUNDLE and the old app code, which is fine only
   because nothing is being published from it.

   ⚠️ Measuring it in pixels is harder than it looks: Remotion's bundled ffmpeg has no pgm encoder,
   `-f rawvideo` to a file errors, stdout piping is swallowed by the npx wrapper, and there is no
   image decoder in node_modules. Compare crops by eye, or add a decoder first.

   **What each name now resolves to.** Five are true metric clones, so a failed download keeps the
   box the same size: Arial/Helvetica→Arimo, Georgia→Gelasio, Times New Roman→Tinos,
   Courier New→Cousine. Four have no metric clone in existence and are visual substitutions:
   Verdana→Open Sans, Trebuchet MS→Cabin, Impact→Anton, Comic Sans→Comic Neue. Those four LOOK
   different from the OS face on a Mac — which is a real change to the editor — but they were already
   rendering as something arbitrary on Lambda, so the published result strictly improves.

   ⚠️ Stored `fontFamily` values are UNCHANGED. This is a resolution layer, not a migration: a post
   scheduled before the fix renders correctly after it. Never rename an id in that catalogue.

   ⚠️ Weight 400 only, and no `wght` in the URL. Anton publishes a single weight, and a
   `wght@400;700` on it is a 400 from Google that fails the WHOLE stylesheet — silently restoring
   every fallback, i.e. re-creating the original bug with no error anywhere.
3. **Decide the music route** (§9). Blocks nothing before phase 5.

**Done when:** a 45s test render completes on the prod site, and we know whether Impact is Impact.
(Half done: we now know the answer to the font half — it is not Impact. The concurrency item is still open,
and the render proven below was 5s, well inside the current budget.)

---

## 4a. Proven on staging, 2026-09-10

A real Lambda render against `bemoreswan-overlay-staging`, driving `startRender` with a two-clip
timeline built from one 16:9 source: clip A `[0, 2)`, clip B `[5, 8)`, `targetRatio: '9:16'`,
`framePosition: {offsetX: 0, offsetY: -0.5}`, plus two timed text boxes.

| Claim | Predicted | Rendered |
| --- | --- | --- |
| Stated frame overrides the source | 1080×1920 (DAR 9:16) from a 16:9 source | 1080×1920, DAR 9:16 |
| Duration is the SUM of trimmed clips | 2 + 3 = 5s | 5.03s (the 0.03 is AAC frame padding on the audio stream; video is 150 frames) |
| `trimBefore` SEEKS, not just shortens | the two segments show different content | confirmed — clip A is the dark opening, clip B a completely different scene |
| Overlays time against the whole piece | "CLIP ONE" 0–2s, "CLIP TWO" 2–5s | each appears over its own clip |
| Source audio survives at default gain | an audio stream, unmuted | aac 48kHz stereo present |

⚠️ **Not yet proven by a render:** the DB-side plumbing — `resolveEditClips`, the fingerprint sharing
in `trigger-post-render` and the sibling fan-out in the worker. Those are unit-tested but have never
run against a real cross-post group. The render above drove `startRender` directly, which is exactly
why it could prove the composition without the column being on prod.

---

## 5. Phases 1–3 — the edit model

### Phase 1 — the edit list (ships alone as single-clip trim)

Add `scheduled_posts.video_edit` (jsonb), modelled on the existing `image_overlays` / `audio_overlays`
arrays so this stays one pattern rather than three. Holds: ordered clips with in/out points, target
ratio, per-clip source gain, per-platform frame offset.

🚨 **The clip list must live in `video_edit`, not in `scheduled_post_assets`.**
`post-render.ts:294` `attachRenderedVideo()` **deletes every junction row** for the post and inserts
the rendered file at `position: 0`. That is correct today (one base clip in, one rendered clip out)
and destructive the moment the junction table *is* the edit. This is the single most important
structural decision in the plan.

Fan-out: the **cut is shared** across crosspost siblings the way media writes already fan out; the
**frame is per-sibling**. Nobody should trim the same four clips four times. Note this cuts against
the current default — overlays are per-post today (see `media-writes-fan-out-to-crosspost`), so pick
the side deliberately rather than inheriting it.

⚠️ SQL before code, on **both** DBs. `db.select()` names every column, so `video_edit` breaks the post
read path everywhere until the column exists.

**Ship it first as trim on one clip.** Useful alone, and it proves the model before any composition work.

#### What landed (2026-09-09)

`db/post-video-edit.sql` (⚠️ **not applied to staging or prod**), `scheduledPosts.videoEdit` in the
schema mirror, `src/lib/video-edit.ts` (the model, sanitiser and `resolveTrim`),
`netlify/functions/save-post-video-edit.ts`, trim plumbed through
`remotion/PostOverlay.tsx` → `remotion/Root.tsx` → `render-post-video-background.ts`, the render gate
extended in `needsVideoRender()`, and `tests/video-edit.test.ts` (26 checks).

Three decisions worth knowing before phase 2 touches this:

- **The worker matches the trim to the base asset id, not to `clips[0]`.** The base is resolved
  independently (overlay pin, then junction table), so the two can disagree — swap the media after
  trimming and `clips[0]` describes a clip that is no longer attached. Applying its in/out points to
  a different video publishes the wrong seconds of the wrong footage with no error anywhere. Phase 2
  removes the mismatch by making the edit the only source of clips.
- **`inS: 0` with no `outS` is deliberately not a trim** (`clipIsTrimmed`). Otherwise opening the
  editor and changing nothing gates the post behind a render that changes nothing.
- **The trim sent to Lambda is advisory.** Nothing server-side can open the video, so
  `calculateMetadata` intersects it with the file's real duration. A collapsed window falls back to
  the whole clip rather than a zero-frame composition, which is a hard Remotion error at the end of a
  paid render.

Still open in this phase: `save-post-audio.ts` returns a `needsRender` flag that does not yet account
for a trim. Harmless until the editor exists (no client reads it for video edits), but it should be
corrected when phase 5 wires the panel, or the sound panel will say "no render needed" on a post that
is about to render.

### Phase 2 — multi-clip composition ✅ code written 2026-09-10

- `PostOverlay` takes a clip array and renders a `<Series>` of `OffthreadVideo`, each with its own
  `trimBefore`/`trimAfter`, instead of one bare `videoSrc`. (Remotion 4.x — `<Series>` and
  `@remotion/transitions` are both available.)
- **`calculateMetadata` stops measuring "the" source clip.** Today `remotion/Root.tsx` derives width,
  height and duration from the single video. With four clips there is no such thing: the output frame
  becomes explicit from the target ratio, and duration becomes the sum of the trimmed segments. This
  inverts the composition's founding assumption and is where the care goes. Keep the even-dimension
  rounding — h264 chroma subsampling fails the encode on an odd one.
- Per-clip fit: cover with a centre offset, so a stray landscape clip fills the vertical frame instead
  of sitting as a letterboxed stamp.
- `resolveOverlayVideoBase()` (`post-render.ts:123`) becomes `resolveEdl()` — returns the ordered list
  rather than `[0]`. Keep the `overlay_base_asset_id` pin semantics: a re-render composites onto the
  clean originals, never onto an already-rendered copy.
- Text overlays need no change — `src/lib/overlay-geometry.ts` is fractional, so boxes land identically
  at any output size.

#### What landed (2026-09-10)

`resolveEditClips()` in `post-render.ts` (the timeline, org-scoped and presigned, falling back to
`[base]` when there is no edit), `frameForRatio()` + `MAX_TIMELINE_SECONDS` in `video-edit.ts`, a
`<Series>` in `PostOverlay.tsx` behind a shared `timelineOf()` normaliser, per-clip measurement in
`Root.tsx`, and `clips` + `targetRatio` on `RenderInput`. `tests/video-edit.test.ts` is now 35 checks.

Four decisions worth knowing:

- **`editHasTrim` was too narrow and is superseded by `editChangesMedia`.** Stitching changes the
  file even when every clip plays whole, so gating on trimming alone would have let an untrimmed
  four-clip reel skip the render and publish as clip one, alone, with no error anywhere. The gate
  parameter on `needsVideoRender` is renamed `hasEdit` to match.
- **`videoSrc`/`videoTrim` are still sent alongside `clips`.** Not indecision — the renderer is an S3
  bundle a git push does not update, so there is always a window where new inputProps meet an old
  bundle. An old bundle ignores `clips` and still finds `videoSrc`, so the worst case is clip one
  rendering rather than a failed render. `timelineOf()` collapses both into one path immediately, so
  the component still has a single rendering branch. **Delete the legacy props once both sites are
  redeployed and no queued job predates them.**
- **A `<Series>` covers exactly the sum of its sequences and nothing after it**, so audio outlasting
  the footage would have played over black — the one regression this change could introduce.
  `calculateMetadata` extends the final clip to cover the overhang, holding its last frame, which is
  what the still + voice note case has always done with its image.
- **The frame is stated only when it cannot be inherited.** A single clip is still measured and
  rendered at its own size; two or more get `targetRatio`, defaulting to 9:16. Sizes come from
  `frameForRatio` ("short side 1080, long side capped at 1920"), which lands on the documented
  1080×1920 / 1080×1080 / 1080×1350 / 1920×1080 without a lookup table that would drift from
  POST_FORMATS.

### Phase 3 — sound ✅ code written 2026-09-10

- Apply `fadeInS`/`fadeOutS` in the composition (`interpolate` on the `Audio` volume). They are already
  stored, defaulted and passed in.
- Add per-clip source gain, with one honest default: **when a music track is present, mute the
  originals.** Four clips of club noise under a track is the failure mode this exists to prevent.
- Ducking under speech is the same mechanism — volume as a function of frame — not a new dependency.
- Upload path needs nothing.

#### What landed (2026-09-10)

`audioGainAt()` in `audio-overlays.ts` (fade maths, pure and tested), `resolveClipGain()` in
`video-edit.ts`, `volume` as a frame callback on `<Audio>`, `volume={c.gain}` on each
`<OffthreadVideo>`, and `gain` carried through `ResolvedClip` → `RenderInput` → the composition.
`tests/video-edit.test.ts` is now 46 checks.

- **The mute-under-audio default deliberately does NOT reach an unedited post.** We cannot tell a
  music bed from a voice note — both are `audio_overlays` — so applying the rule everywhere would
  silently re-mix every existing video-with-a-voice-note the next time it rendered, dropping the
  camera audio nobody asked us to drop. `resolveEditClips` applies it only in the edit branch; the
  `[base]` fallback carries no gain at all, so Remotion's own default applies and an untouched post
  sounds exactly as it did.
- **`gain` is absent rather than 1 when undecided**, which is what makes the default expressible at
  all: "the user has not chosen" and "the user chose full volume" have to be different answers, or
  the mute could never fire without overriding a deliberate choice.
- **Fades are capped at half the clip each**, so a 0.5s fade pair on a 0.4s blip ramps up and
  straight back down rather than overlapping into a gain above the one the user set.
- ⚠️ **Found while wiring this: phase 2's `calculateMetadata` rebuilt each clip field by field**, so
  it dropped `gain` the moment the field existed. Those props REPLACE what the worker sent, so
  anything not copied forward is lost. It now spreads the original clip and overrides only what it
  measured — worth remembering for phase 4, which adds another per-clip field.

---

## 6. Phase 4 — per-platform re-framing ✅ code written 2026-09-10

Trigger off the router's existing answer. `routeAsset()` already returns `state: 'crop'` per platform
along with the format the asset *would* fit — that is precisely the signal, and it needs no new
platform knowledge anywhere.

Render the master once; render one derivative per **distinct target ratio** actually needed by the
selected platforms. Today that is at most one (1:1).

⚠️ **This deliberately overturns rule 4 in `format-router.ts`: "Nothing is ever silently re-cut."**
Keep the honesty rather than the rule — auto-crop, but show the crop frame in the review panel with
the safe area marked, default to centre, and let the user drag it. Silently centre-cropping a vertical
shot to a square is how you publish a post with the head cut off. Record the offset on the EDL so a
re-render reproduces it.

Failure isolation comes free: each crosspost sibling is its own `scheduled_posts` row with its own
`render_status`, so a failed Facebook re-frame holds Facebook and nothing else.

⚠️ Watch `post_format` on the derivative. `attachRenderedVideo` moves it to `'video'` while leaving
`reel`/`short` alone — a re-framed Facebook sibling must not inherit the master's reel format, or
`publish-instagram.ts`-style format branching goes wrong on the other platform.

#### What landed (2026-09-10)

`reframeRatioFor()` in `format-router.ts`, `renderFingerprint()` + `renderPlanFor()` in
`post-render.ts`, `framePosition` through `RenderInput` → the composition's `objectPosition`, a
sharing branch in `trigger-post-render.ts` and a fan-out on the worker's success path.
`tests/video-reframe.test.ts` — 16 checks.

- **The re-frame target is 4:5, not the 1:1 this document assumed.** Picking the CLOSEST accepted
  ratio rather than the first listed throws away less picture, and Facebook and Threads both land on
  4:5 — so they still share one derivative. Confirmed by test, because if those two ever diverge the
  fan-out silently costs an extra render.
- **Sharing waits on the JOB, not on a finished asset.** Approvals arrive in a loop, so a sibling's
  render is almost always still in flight; looking for a completed asset would miss nearly every
  time and render the same file four times over.
- 🚨 **The fingerprint hashes everything that reaches the composition, and the worker RECOMPUTES it
  per sibling before attaching.** The dangerous version of this feature shares a render between two
  posts that are not identical — sibling B publishes with sibling A's text burned in, and nothing
  reports a problem. Text overlays are per-post by design, so that divergence is ordinary. Hashing
  the whole input makes "same fingerprint" mean "same output" by construction rather than by a
  judgement about which fields matter.
- ⚠️ **Found while writing it: the fan-out first recomputed siblings against the ANCHOR's base
  asset.** A sibling carrying different footage would have fingerprinted as identical and been handed
  the wrong video. Each sibling now resolves its own base. Anything that goes into the fingerprint
  must belong to the post being fingerprinted.
- **Only a re-framed row carries a `framePosition`.** Putting it on the master too would fold it into
  the fingerprint and split siblings that render identical files.

---

## 7. Phase 5 — the editor ⚠️ PARTIAL, 2026-09-10

The post editor's timeline is already multi-track and no longer video-only (text segments pink, audio
indigo, `data-tl-kind` routing a drag to the right array and endpoint).

- Add a clip track: drag to reorder, handles to trim.
- Add the per-platform crop frame as a view on that timeline, not a separate screen.
- Seed from the assistant's draft: `textOverlays` become placed text boxes, script beats become the
  suggested clip order. Editable on arrival, never locked.
- **Browser scrubbing matters more than it looks.** Every render costs a Lambda slot out of ten and
  people iterate on cuts. Previewing locally is what stops the quota becoming the bottleneck again.

#### What landed (2026-09-10) — and what did NOT

**Built:** a crop-frame view (below) and a Clips panel in the post editor's stage strip (`#pce-clips-block`, above the timeline
because the cut decides its axis). Lists every clip in order with its measured length, reorders with
arrows, trims with in/out fields, removes, warns past three minutes, and persists to
`save-post-video-edit` on every change — shared across the cross-post group. An unedited post SEEDS
its cut from the video already attached, so uploading four clips in the composer and opening the
editor shows four clips ready to trim rather than an empty panel. `tests/post-clip-editor.test.ts`,
20 checks.

**Deliberately not built, and still outstanding:**
- **Drag-to-trim on the timeline track.** The clip track is a genuinely different interaction from
  text and audio: those float on a fixed axis answering "when does this happen", while clips TILE the
  axis and trimming one shifts everything after it. Reusing `_rqBindTimeline`'s drag handler would be
  wrong. The in/out fields are functional but plainer.
- ~~**The per-platform crop frame as a view.**~~ ✅ **Built 2026-09-10.** `#pce-crop-block` draws the
  source clip with the platform's frame over it, everything outside dimmed, draggable (and
  arrow-key nudgeable) along whichever axis overflows. Only rendered where the master is actually
  re-framed, which today is Facebook and Threads.

  ⚠️ **The derivative is NOT a crop of the master** — both are independent cover-fits of the SOURCE,
  so a 4:5 copy of a 16:9 source keeps MORE width than the 9:16 master does. Drawing a 4:5 window
  inside the 9:16 master would show the reviewer something that will never publish. The backdrop is
  the source at its own shape.

  ⚠️ **The browser does not re-derive the re-frame.** `get-social-drafts` answers `reframe` using
  `reframeRatioFor`, the same function the renderer uses; a second implementation in workspace.html
  would drift, and a crop preview that disagrees with the render is worse than none.

  ⚠️ **Only the overflowing axis may hold an offset.** An offset on the axis that already fits
  changes no pixel but DOES change the render fingerprint — which would split siblings that produce
  identical files into two separate renders.
- **Sequential preview.** The editor's `<video>` plays the ATTACHED media, which is still the single
  original clip; the stitched result does not exist until the render. Scrubbing a multi-clip cut needs
  a small player that walks the list. Without it, iterating on a cut costs a Lambda render each time —
  the quota pressure §4 warns about.

⚠️ **A bug the crop view exposed in the clip panel, worth remembering:** `save-post-video-edit`
replaces the whole edit object, so the clip panel's save — which sent only `clips` and `targetRatio` —
would have silently discarded every crop offset the moment anyone nudged a trim. Nothing would have
reported it until the post published mis-framed. Every save now carries `frames` through, and a test
pins it. **Any future field on the edit has the same hazard.**

⚠️ **Also corrected here:** phases 1–4 named `video_edit` in their main `db.select()`, which meant the
code could not ship before the migration without breaking every video post — and, once the review
queue read it too, rendering the queue EMPTY. All three readers now fetch it separately behind a
try/catch (`readPostVideoEdit`, and the batch read in `get-social-drafts`), so an environment without
the column behaves exactly as it did before the feature existed. **The deploy ordering constraint is
gone**: code may now ship before the SQL.

---

## 8. Known traps

- **A git push does not update the renderer.** The deployed Remotion site is an S3 bundle; a composition
  change needs an explicit `remotion:deploy-site-{staging,prod}`. The drift stamp has reported "in step"
  while prod was months stale — verify by fetching `bundle.js` and grepping it, not by trusting the stamp.
- **Every worker exit path must reach a terminal `render_status`.** A post left at `pending`/`rendering`
  is invisible to all three publishers forever — a silent drop, worse than a visible `failed`. More
  clips means more ways to exit early.
- **`REMOTION_REGION` (ours) ≠ `REMOTION_AWS_REGION` (the CLI's).** The CLI silently defaults to
  us-east-1; `--region=eu-west-2` is pinned in the npm scripts, ad-hoc invocations still need the flag.
- **Nothing gates a push.** Netlify runs no typecheck and no tests, and a push to `staging` releases to
  production. A local run is the only gate this work gets.

---

## 9. Phase 6 — music we supply (deferred)

v1 is the customer's own audio file. When we come back to it, there are two forks and only one is a
technology decision.

### Fork one — licensing

| Route | Examples | Rights model | Verdict |
| --- | --- | --- | --- |
| Generative | Mubert, AudioPod, Sonilo | Pay per generation, commercial rights included by default | **Start here** |
| Catalogue | Soundstripe, Artlist, HookSounds | Per-subscriber licence; distributing to our customers needs a bespoke B2B sub-licensing agreement | Only if asked for |

Generative wins beyond the paperwork: it can be asked for the **exact duration of the finished cut**,
which removes looping and trimming from a pipeline that has enough timing logic already. And writing a
mood prompt from the brief is exactly what the assistant is for — it already writes the shot script.

### Fork two — the engine (already decided)

🚨 **Do not add a second rendering engine.** FFmpeg, Shotstack and Cloudinary all answer "how do I
merge audio into video when I have no renderer". We have one: Remotion Lambda in eu-west-2, already
deployed, already burning our text overlays, and `PostOverlayProps.audio` already takes an array of
tracks. Music is a **source**, not a pipeline. Two engines that both know how a post becomes a file
would diverge permanently.

Two specifics that look attractive and do not survive contact with this stack:

- **`-c:v copy`** (swap audio without re-encoding) is genuinely fast, but only when swapping audio is
  *all* you do. We re-encode anyway to stitch, burn text and re-frame, so the saving is unavailable by
  construction.
- **Self-hosted workers.** Our functions run on Lambda via `@netlify/aws-lambda-compat` — which is
  precisely why rendering was pushed out to Remotion Lambda in the first place. There is no long-running
  worker host to put ffmpeg on.

### What it actually costs us

- A **music source list** mirroring `src/utils/media-sources.ts` — own upload first, generated as
  fallback, order and membership editable per assistant. Same resolver shape as
  `src/utils/media-resolver.ts`, same UI pattern as the Media Sources card in Operational Setup.
- One more **audio track** on a composition that already accepts an array. No render changes beyond
  the phase 3 fade work.
- **Credits through the existing ledger.** Pay-per-generation is the `holdCredits` / `settleHold` flow
  AI images and video already use (`src/utils/ai-credits.ts`). No new billing surface.

The engineering is small once licensing is settled; the commercial conversation is the long pole.

---

## 10. Out of scope for v1

Transitions; beat-syncing cuts to the track; auto-captions; the Facebook Reels and Stories endpoints;
reading the footage with a vision model.

**Not possible, and worth saying out loud:** we cannot attach Instagram's own music library — Meta's
Content Publishing API has no field for it. Baked-in audio is the only route available to any
scheduling tool, and it forfeits the reach native audio gets. Customers who care will notice, so say it
before they ask.
