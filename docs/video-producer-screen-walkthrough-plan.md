# Video Producer: Screen Walkthrough Videos (Presenter Over the Screen): Plan

Added 2026-11-15. **Owner's question:** could the Video Producer make a video like Atera's
*"Atera's ultimate platform walkthrough"* on YouTube (youtube.com/watch?v=JNUmVqBtYIs)? The owner then asked for a plan.

Builds on [video-producer-footage-and-ai-plan.md](./video-producer-footage-and-ai-plan.md) (own footage,
tightening, own-sound captions, all live) and
[video-producer-manual-controls-plan.md](./video-producer-manual-controls-plan.md) (Record a video
with teleprompter, own voice, scene text).

Status: **nothing built. All decisions taken 2026-11-17:** the owner said "go with your recommendations" for
D-W1–W6 (§8) and D-A2–A7 (§11.9). D-A1 (Kling AI Avatar v2 Standard) was the owner's own pick the same day. What follows from them:
- **Terms notice:** D-A3 (2 tasks per presenter-second) is a new charge, so the 30-day notice under clause 20.2
  must go out before the AI presenter is sold. D-W3 may add a second charge after Phase 4 measures render costs.
- **Welsh is in** at launch (D-A5): the bake-off showed `eleven_v3` speaks it, so Welsh lines use `eleven_v3`.
- **First build step:** Phase 0 (fix the stale footage-review prompt), then Phases 1–2 (layouts) and A1 (roster) can start.

**Added later on 2026-11-15:** the owner wants **the presenter to be an AI-made human avatar**, chosen
from **male and female presenters**, with a **choice of language**. See §11 (decisions D-A1 to D-A7, all taken).
This replaces D-V3 in the manual-controls plan ("AI presenter: separate plan later").

**Phase A0 bake-off done 2026-11-15** ([ai-avatar-bakeoff-2026-11-15.md](./ai-avatar-bakeoff-2026-11-15.md), $21.43): all 5 services worked; **D-A1 DECIDED 2026-11-17: the owner chose Kling AI Avatar v2 Standard** after watching the clips. **Welsh works only with `eleven_v3`** (multilingual v2 refuses `cy`).

---

## 1. What the Atera video is

Watched 2026-11-15 at 0:09, 0:45, 3:22 and 5:50:

- **6 min 2 s, landscape 16:9.** One presenter talks to camera the whole way: office, plant, black T-shirt.
- **Most of it is the product on screen** (screen recordings of the Atera dashboard). The presenter
  **stays in a round bubble, bottom right,** and keeps talking. His voice never stops.
- **Sometimes the other way round:** the presenter fills the frame with a **small window of the
  screen** in the bottom-left corner (3:22).
- **Captions** all the way through, plus **YouTube chapters** ("Introduction to Atera", "Software deployment and…").
- **Ends on the presenter full frame** with the call to action ("start your free trial… no credit card required").
- No music to speak of, no stock footage, no AI. It's one person, one screen, edited well.

This is a very common format for anyone selling software, an online course, a booking system or any
service with a screen. It's also cheap to make, so it suits our customers.

---

## 2. What the Video Producer does today

| Part of the Atera video | Today | Where |
|---|---|---|
| Presenter filmed to camera | ✅ Record in the browser with a teleprompter, or upload | `src/components/video-recorder.js` |
| Pauses, "um"s and false starts cut out | ✅ Tightening, plus Edit the words | `src/lib/footage.ts` `tightenSegment` |
| Screen recordings | ✅ Uploaded as own footage (any MP4/MOV/WebM) | `footage-reader.js` |
| Captions from the presenter's words | ✅ Own-sound caption track | `video-producer.ts` `makeCaptionTrack` |
| Chapters (in the app and on YouTube) | ✅ | `src/lib/video-chapters.ts` |
| 16:9 shape | ✅ | `storyboard.ts` `VIDEO_SHAPES` |
| Name caption, music, closing card | ✅ | |
| **Screen shown while the presenter keeps talking** | ❌ Scenes only play one after another | footage review prompt: *"never over someone speaking"* (`footage.ts:225`) |
| **Presenter in a bubble over the screen, or screen in a window over the presenter** | ❌ One picture at a time | `remotion/PostOverlay.tsx:304`: one `<Series>` of full-frame clips |
| **Recording the screen** | ❌ Camera only | no `getDisplayMedia` anywhere in `src/` |
| **A 6-minute video** | ❌ Lengths are 15 / 30 / 60 s, at most 8 scenes | `storyboard.ts:43`, `:68` |
| A long tightened take | ⚠️ At most 40 pieces per video | `video-edit.ts:93` `MAX_CLIPS` |

**Already works today, worth saying in help:** a Loom-style recording, with the webcam bubble already
baked into the screen recording, is just one video file. The Video Producer can tighten it, caption
it and add a closing card now. What's missing is making that look *from two separate recordings*,
which is what gives control (switch layouts, move the bubble, cut the screen independently).

---

## 3. The design: a layout per scene

One idea covers the whole Atera video: **the presenter's sound runs underneath, and each scene chooses
what you see.** Four layouts:

| Layout | You see | You hear |
|---|---|---|
| **Presenter** (today's own-video scene) | Presenter full frame | Presenter |
| **Screen + bubble** | Screen full frame, presenter in a round bubble in a corner | Presenter |
| **Screen only** (cutaway) | Screen, or any stock clip, picture or product photo, full frame | Presenter |
| **Presenter + window** | Presenter full frame, screen in a small rounded window in a corner | Presenter |

"Screen only" with a stock clip or picture is also the long-missing **B-roll over your own sound**
(noted as a gap on 2026-11-09 against the Format Finder demo), so this helps every talking-head video,
not just software demos.

### 3.1 Scene model (`src/lib/storyboard.ts`)

An `own_video` scene (the presenter, `assetId` + `inS`/`outS` + `cuts`) gains an optional **cover**:

```ts
cover?: {
  layout: 'bubble' | 'cover' | 'window';     // Screen + bubble · Screen only · Presenter + window
  source: 'own_video' | 'stock_video' | 'stock_photo' | 'product_photo' | 'ai_image';
  assetId?: number;                            // the screen recording (or picture)
  inS?: number;                                // where in the screen recording to start; absent = synced (§5)
  keywords?: string; prompt?: string;          // stock / AI, as on a scene today
  fromS?: number; toS?: number;                // part of the scene it covers, seconds into the scene; absent = all of it
  corner?: 'br' | 'bl' | 'tr' | 'tl';          // bubble / window corner; default br (bubble), bl (window)
}
```

No `cover` = today's behaviour. `enforceStoryboard` checks the asset is the workspace's own, clamps
times, and drops `cover` on scenes that aren't `own_video`.

### 3.2 Timeline and render (`video-edit.ts`, `PostOverlay.tsx`)

**Covers are timed in output seconds, like text overlays and audio, not per clip.** A tightened scene
is many pieces of the presenter's file, and the screen must play continuously across them.

- `ProjectTimeline.covers: Array<{ startS, endS, src, inS, kind: 'video'|'image', layout, corner }>`.
- Every presenter `VideoClip` gets `layout?: 'full' | 'bubble' | 'hidden'` plus `corner`. `sceneClips`
  (`video-producer.ts:586`) **splits a piece where a cover starts or ends**, so each piece has one layout.
- **Render, three layers** inside the existing composition:
  1. **Behind:** cover videos/stills for `bubble` and `cover` layouts (muted `OffthreadVideo` / `MovingStill` in a `<Sequence from=…>`).
  2. **The presenter `<Series>`** (as today, it still carries the sound): `full` draws as now; `bubble`
     draws in a circle (CSS `border-radius: 50%`, about 24% of the short side, 4% margin, thin white ring);
     `hidden` draws nothing but keeps `volume`.
  3. **In front:** `window` covers (rounded rectangle, about 32% of the width).
  Then the look tint, text, captions and name captions on top as today. **Captions move up** when a
  bubble or window sits at the bottom (same rule as text over captions today).
- **Remotion site redeploy** on staging and prod (`REMOTION_AWS_PROFILE=bemoreswan-remotion`), like the
  seven improvements. Before that, a bundle that doesn't know `covers` would ignore them, so the build
  must not write covers until the redeploy stamp is in place (same guard pattern as stills, 2026-10-31).

---

## 4. Controls (GUI and chat: every capability is in both)

- **Each own-video scene's Change form** gets a **Layout** row with four thumbnails (Presenter / Screen +
  bubble / Screen only / Presenter + window), then **"What's on screen"**: pick a screen recording from
  the scene's footage (with a start time, m:ss) or stock, picture or product photo as today, plus a
  **corner** picker. An optional **"Only from m:ss to m:ss"** for covering part of a scene.
- **Preview** in the scene card with CSS: the screen still with the presenter's frame in a circle.
- **Chat:** `edit_scene` accepts `cover` (same sanitiser), so "show the dashboard while I talk about
  patching, with me in the corner" works. Any new chat card means **regenerating the chat
  capabilities manifest** or CI fails.
- **Whole-video switch** on the options row: **Bubble corner** and **Bubble size: Small · Medium**.

---

## 5. Recording the screen and the presenter together

The easiest way to get a good result: **record both at once, so they're in sync.**

- `video-recorder.js` gains **"Record my screen too"** (desktop browsers only, `getDisplayMedia`; phones
  hide it, D-W5). Two `MediaRecorder`s start on the same frame and give **two files**: camera + mic (the
  presenter) and screen (no sound, unless D-W6 says otherwise). A live preview shows the bubble.
- Both upload as normal footage, linked: `content_assets.render_params.recordedWith = <other asset id>`
  and the start offset (normally 0). **A linked screen needs no `inS`:** its cover plays from the same
  moment in the screen file as the presenter's current piece, so tightening cuts both together and they
  never drift. *(When a cover is synced, the cover layer follows the presenter's cuts instead of playing
  continuously: built from the same pieces as layer 2.)*
- **Teleprompter** works as now; the script can sit beside the shared screen.
- **Uploaded separately** (recorded in OBS, QuickTime or Loom without the camera): no sync. The owner,
  or the planner (§6), picks the start time per scene, and the screen plays continuously.
- **Length:** a walkthrough take is often longer than 5 minutes. Raise `MAX_FOOTAGE_S` to 10 minutes
  for screen + camera pairs only (D-W2). The 500 MB cap stays; WebM screen video is small.

---

## 6. Planning and footage review

- **Footage review** (`footage.ts`) is told which videos are screen recordings (from the pairing, or the
  frames look like an app or website: the review already sees frames) and that it **may** now suggest
  "show the screen while you speak". It suggests a layout per sentence: product moments go to Screen +
  bubble, the opening and the call to action to Presenter.
- **Planner prompt** (`storyboardSystemPrompt`) learns `cover` and the four layouts, with one rule:
  never cover the first 2 seconds or the call to action (faces build trust; Atera does the same).
- **Fix now, separately (small):** the footage review prompt at `footage.ts:225` still says the
  Video Producer *"can NOT add background music… lower-thirds"*. Both shipped on 2026-11-10, so reviews
  never suggest music or a name caption. Update the list when this phase lands, or before as a one-line fix.

---

## 7. Longer videos

| | Today | Walkthrough |
|---|---|---|
| Length choices | 15 / 30 / 60 s | add **2 / 5 / 10 min** for footage videos only |
| Scenes | 3–8 | up to **20** for footage videos (a scene ≈ a chapter) |
| Pieces per video | 40 (`MAX_CLIPS`) | **200**; tightening a 6-min take makes about 60–120 pieces |
| Render ceiling | 600 s (`MAX_TIMELINE_SECONDS`) | unchanged: 10 min is the cap |
| Render wait | 12 min poll (`video-render.ts:35`) | measure a 6-min 1080p 16:9 render on staging first; raise the Lambda frames-per-chunk if needed |

`fitLength` already leaves own-video scenes at their own length, so a long walkthrough is "as long as you
spoke, minus the pauses". The length choice just tells the planner how much to keep.

**Cost:** own-footage builds are free today, and the render is our cost. A 10-minute render costs
noticeably more than a 30-second one (measure in Phase 4). See D-W3.

---

## 8. Decisions (all taken 2026-11-17: the owner chose the recommendations)

| # | Question | Recommendation |
|---|---|---|
| D-W1 | Call it something? | ✅ A **"Screen walkthrough"** start option next to "Use my own footage". It opens the recorder with "Record my screen too" ticked and 16:9 chosen. Same studio underneath. |
| D-W2 | Longest walkthrough | ✅ **10 minutes** (the render ceiling). Footage clips up to 10 min for screen + camera pairs. |
| D-W3 | Charge for long renders? | ✅ **Free up to 1 minute as now; above that, measure first** (Phase 4), then decide tasks per minute. Any new charge needs the Terms 30-day notice (like per-second AI video). |
| D-W4 | Bubble look | ✅ **Circle, bottom right, medium, thin white ring.** Corner and Small/Medium choosable. No square option at first. |
| D-W5 | Phones | ✅ Screen recording is **desktop only** (phone browsers can't share the screen). Phones can still upload a screen recording. |
| D-W6 | The screen's own sound | ✅ **Off by default** (it double-plays notifications and the presenter's voice). A tick box "Keep the screen's sound" for demos with sound. |

---

## 9. Phases

| Phase | What | Size | Notes |
|---|---|---|---|
| **0** | Fix the stale "can NOT add music / lower-thirds" line in the footage review prompt; help line that Loom-style recordings already work | XS | Independent; can ship now |
| **1** | Render: `covers` + presenter `layout` in `video-edit.ts` sanitiser and `PostOverlay.tsx`; caption lift; Remotion redeploy both envs | M | Unit tests on the sanitiser; a staging render with a hand-written timeline |
| **2** | Scene `cover` in the storyboard, `sceneClips` splitting, the Layout row on the Change form, chat `edit_scene`, preview | M | GUI and chat together. Manifest regenerated |
| **3** | "Record my screen too": two recorders, linked assets, synced covers, 10-min pairs | M | Desktop Chrome / Safari / Edge; test a real 5-min take |
| **4** | Long videos: 2 / 5 / 10 min, 20 scenes, 200 pieces, render timing and cost measured | S–M | Feeds D-W3 |
| **5** | Planner + footage review suggest layouts; "Screen walkthrough" start option (D-W1) | M | |
| **6** | Copy: help article (SQL, both DBs), FAQ, pricing row if D-W3 charges, assistant page sample (make our own Be More Swan walkthrough with it) | S | |

Phases 1–2 alone already give B-roll over own sound and the bubble look from uploaded files.

---

## 10. Risks

- **Render time and memory:** two 1080p videos decoding at once for 6–10 minutes. Measure in Phase 1.
  Fall back to 720p covers if Lambda struggles.
- **WebM screen recordings with no duration** (Chrome): the footage reader already measures these (`openVideo`).
- **Sync drift:** two `MediaRecorder`s can start a few frames apart. Store the measured offset from
  the first frame timestamps, and test with a clap at the start.
- **Privacy:** a screen recording can show emails, customer names or passwords. Add a line on the
  recorder ("Only share the window you need"), and the footage review should flag visible email addresses.
- **Old Remotion bundle** ignores covers silently, hence the redeploy guard in §3.2.

---

## 11. The AI presenter (owner, 2026-11-15)

**What the owner asked for:** the presenter is **a realistic human made by AI**, not someone who has
to film themselves. The owner picks them from a **choice of male and female presenters** and can **change
their language**. Everything in §3 to §10 still applies: the AI presenter simply **replaces the
filmed presenter** as the scene's speaker. They appear full frame, in the bubble, or are heard behind a
screen-only scene.

### 11.1 How it works

1. **Script first, as today.** The owner writes or approves the script (storyboard "script first").
2. **Pick a presenter:** a gallery card per presenter (face, name, Female/Male, a 5-second sample clip).
3. **Pick the language.** The script is translated if needed (Claude, like caption translations),
   and the **voice comes from the existing voice list** (`src/public/voice-catalogue.json`, 38 voices,
   female/male, 11 languages). Each presenter has a **default voice per language** that matches
   their gender and age, and the owner can override it with the existing voice picker.
4. **Make the voice** (ElevenLabs, as today; the word timings feed captions).
5. **Make the presenter speaking it:** the presenter's face picture plus the voice audio go to an
   **audio-driven avatar model on fal** (§11.2). The lips follow whatever audio they're given, so
   **one face speaks any language** and changing language is just new audio plus a new clip. No re-casting.
6. **Background removed** for the bubble (or the avatar is made on a plain studio background and
   cropped into the circle, which needs no removal; see D-A4).
7. The clip becomes the presenter track (an `own_video`-like scene source `ai_presenter`), and the
   rest is §3: screen covers, bubble, captions, chapters.

**Only the scenes where the presenter is seen get a clip.** Screen-only scenes need just the voice. So
a 6-minute walkthrough showing the presenter for about 90 seconds (intro, a few key moments, call to
action) costs a quarter as much as one with the presenter on screen all the way through (§11.4).

### 11.2 Which model (researched 2026-11-15)

Audio-driven "talking avatar" models on fal, the supplier we already use (no new contract, same `FAL_KEY`):

| Model (fal endpoint) | $ per second | Longest per call | Notes |
|---|---|---|---|
| **Kling AI Avatar v2 Standard** `fal-ai/kling-video/ai-avatar/v2/standard` | **$0.056** | ~5 min (unverified) | Recommended default |
| **Kling AI Avatar v2 Pro** `…/ai-avatar/v2/pro` | $0.115 | same | "High quality" option |
| OmniHuman 1.5 `fal-ai/bytedance/omnihuman/v1.5` | $0.16 | 60 s (720p) / 30 s (1080p) | Strong gestures; chunk it |
| VEED Fabric 1.0 `veed/fabric-1.0` | $0.08 (480p) / $0.15 (720p) | up to 300 s | |
| HeyGen Avatar IV `fal-ai/heygen/avatar4/image-to-video` | $0.10 | not stated | Up to 1080p |
| HeyGen Avatar V `fal-ai/heygen/avatar5/digital-twin` | $0.10 | not stated | **HeyGen's preset avatars only; transparent WebM** |
| InfiniteTalk `fal-ai/infinitalk` | $0.20 | ~29 s per call | Too dear |

- **No independent quality benchmark exists.** Like the Kling clip bake-off on 2026-11-01, **Phase A0
  is a bake-off.** As run on 2026-11-15: one ~10–13 s line each in English (female face), French (male face) and
  Polish (female face), through Kling Std, Kling Pro, OmniHuman 1.5, Fabric 720p and HeyGen Avatar IV (15 clips),
  plus one 37 s English drift clip and one Welsh clip on Kling Std. Judged on lip-sync, eyes and blinking, head
  and hand movement, teeth, and drift. Rerun every quarter, because the
  rankings change monthly. The model is picked by env (`FAL_AVATAR_MODEL`), like `FAL_I2V_MODEL`.
- **Long videos are made in chunks** of about 30 to 60 seconds, split at sentence ends, all from the
  same face picture, submitted **in parallel** (the background worker has a 15-minute cap; the
  same lesson as Kling 3 clips). Cuts between chunks land on sentence breaks, where an edit looks
  natural anyway.
- **Dedicated platforms looked at and not chosen for stock presenters:** HeyGen API (strong, but a second
  supplier and dearer per minute), Synthesia (its usage policy **forbids reselling**, so it's out), D-ID,
  Tavus and Argil (no advantage over fal for this).

### 11.3 The presenter roster (male and female)

The fal models have **no stock people**: we make our own roster.

- **12 presenters to start: 6 female, 6 male,** across ages (20s to 60s) and ethnicities, in business-casual
  clothes, waist up, looking at the camera, on a plain soft-grey studio background (which also makes the
  bubble and background removal easy). Made with FLUX.2 Pro (our image model), each checked by hand.
- **All fictional:** generated faces, never based on a real person, and never named after one.
- **Stored as one JSON list,** like the voice list (`src/public/presenter-catalogue.json`): id, display
  name, gender, age band, face image, default voice per language, sample clip. One list, read by the
  gallery, the server and chat, with a test that pins it (the same rule as voices: never hard-code a list in a screen).
- **Sample clips** made once per presenter (a 5-second English hello) and stored statically, so the
  gallery never spends money.
- **Later (D-A6):** the owner's **own presenter made from a photo** (their own face or a staff member's), with consent.

### 11.4 Languages

- **The lips follow any audio,** so every presenter can speak every language the voice list has.
- **Voices:** today's voice list covers 11 languages. ElevenLabs v3 can speak 74. **Add voices to the
  catalogue** for any language customers need (plus `make-voice-samples`).
- **Welsh (checked 2026-11-15):** `eleven_multilingual_v2` (the app default) refuses Welsh, but `eleven_v3` speaks it well
  (Scribe heard it back almost word for word). Offering Welsh means Welsh lines use `eleven_v3` plus a Welsh voice entry.
- **Translate once, keep both:** a "Make it in another language" button makes **a new version** of
  the video in that language (same presenter, same screens, translated script, new voice and new presenter
  clips). The screen covers and timings are reused. Scene lengths change with the new audio, so covers are
  laid out again from the new word timings.
- **Lip-sync quality varies by language** (strongest in English and Chinese). The bake-off tests English,
  French and Polish. Arabic and Hindi get tested before we promise them.

### 11.5 Cost and price

| | Presenter on screen | Our cost (Kling Std) | Our cost (Kling Pro) |
|---|---|---|---|
| 60-second promo, presenter all the way | 60 s | ~$3.40 | ~$6.90 |
| 6-minute walkthrough, presenter 90 s | 90 s | ~$5 | ~$10 |
| 6-minute walkthrough, presenter all the way | 360 s | ~$20 | ~$41 |

Plus ElevenLabs voice (small) and the render. **Price in tasks per presenter-second,** like AI video
since the per-second change: at our current rate (Kling 3 at $0.112/s costs 4 tasks/s), Standard is about
**2 tasks per second** and Pro about **4**. **Language versions cost the same again** (new clips). The
build shows the cost and holds it first, as today. Any new charge in the Terms needs the **30-day notice**
(clause 20.2), as with AI video per second.

### 11.6 Labelling and consent

- **Every video with an AI presenter counts as realistic AI:** `containsRealisticAi` (`video-render.ts`)
  becomes true, so YouTube's "altered or synthetic" box is ticked (`src/utils/ai-disclosure.ts`) and the
  workspace "Made with AI" caption line applies (on by default).
- **A small "AI presenter" note** in the video itself (in a corner for the first 3 seconds, and on the
  closing card). The EU AI Act Article 50 labelling duty has applied since 2 August 2026, and the duty
  to mark AI output in machine-readable form (C2PA metadata) applies from 2 December 2026. Look at
  C2PA marking of the finished file in the render step.
- **Fictional presenters need no consent.** Their faces are made up, and the help and terms say so.
- **A real person's face (D-A6) needs explicit consent** from that person: a recorded consent statement
  (the HeyGen-style flow), stored with the presenter, withdrawable (deleting the presenter deletes the
  face and stops new videos). Under UK GDPR a face used to make a likeness can count as biometric data,
  so this needs a DPA note and the privacy policy updated. **Not in the first release.**
- **Voices:** stock ElevenLabs voices as today. Cloning the owner's own voice is a separate decision (ElevenLabs verifies it).

### 11.7 Changes to the rest of this plan

- **§3 scene model:** a new scene source `ai_presenter` (script line, presenter id, language, made clip
  asset id), drawn exactly like `own_video` (full / bubble / hidden) with the voice as its sound.
- **§5 recording** becomes optional: the owner can record only the screen ("Record my screen") and
  let the AI presenter talk over it. The screen and the presenter are then synced by the script's word
  timings, not by recording them together.
- **§6 planning:** the planner matches each script sentence to a screen moment (from the screen
  recording's frames, read by the footage reader) and picks a layout. The presenter is shown for the opening,
  the call to action and moments the owner marks. The rest is Screen + bubble or Screen only, which keeps the cost down.
- **Chat:** "use Priya and make it in Spanish" → a `presenter` / `language` card, using the same
  server action as the GUI. The chat capabilities manifest is regenerated.

### 11.8 Phases for the AI presenter

| Phase | What | Size |
|---|---|---|
| **A0** ✅ | Bake-off (5 models × 3 language lines, one face each; drift and Welsh clips), plus Welsh check on ElevenLabs; owner picked Kling Standard | S |
| **A1** ✅ | Roster: 12 fictional presenters (FLUX), presenter-catalogue.json, sample clips, gallery picker component (not yet on a page) | M |
| **A2** | Picker on the brief form + chat presenter card; `ai_presenter` scene source: chunked parallel fal calls, retries, task holds and refunds, background handling, "AI presenter" note | M–L |
| **A3** | Screen walkthrough with AI presenter: covers from word timings (needs §3 Phases 1–2) | M |
| **A4** | "Make it in another language" versions; add voices to the catalogue for new languages | M |
| **A5** | Copy: help, FAQ, pricing (tasks per presenter-second), Terms notice if charged, assistant page sample | S |
| Later | The owner's own presenter from a photo, with recorded consent (D-A6) | L |

A1 and A2 work for **any** video, not only walkthroughs: "an AI presenter introduces your offer" for
30-second social videos is likely the most-used version.

**A1 as built (2026-11-17):** `src/public/presenter-catalogue.json` (12: Amara, Priya, Grace, Mei, Sofia, Eileen,
Daniel, Kwame, Arjun, Luis, Callum, Kenji; each with their own English voice), `src/lib/presenters.ts` (`presenterVoice`:
own voice, else the catalogue voice of their gender for that language), `presenters/<id>.jpg` (1920×1080 face for the
avatar model), `-thumb.jpg` and `.mp4` (5-second "Hi, I'm …" made with Kling AI Avatar v2 Standard), made by
`scripts/make-presenters.mjs` (about $4 in all), and `src/components/presenter-picker.js` (Female / Male filter, Watch,
Use; `fieldHtml` for forms). **Not yet on any page and no chat card:** a picker that changes nothing would mislead, so the
brief form and the chat get it with A2, when choosing a presenter makes one.

### 11.9 Decisions (all taken 2026-11-17)

| # | Question | Recommendation |
|---|---|---|
| D-A1 | Which model? | ✅ **Decided 2026-11-17: Kling AI Avatar v2 Standard** (`fal-ai/kling-video/ai-avatar/v2/standard`, $0.0562/s), picked by env `FAL_AVATAR_MODEL`. Pro stays a possible "High quality" option later. |
| D-A2 | How many presenters to start? | ✅ **12 (6 female, 6 male),** mixed ages and ethnicities, all fictional. Add more when customers ask. |
| D-A3 | Price | ✅ **Tasks per presenter-second: 2 per second** (Kling Standard, D-A1; 4 if a High quality option is added later), shown and held before making. Needs the Terms 30-day notice before launch. |
| D-A4 | Background | ✅ **Plain studio background**, cropped in the bubble. Real background removal only if the bake-off shows edges look wrong full frame. |
| D-A5 | Languages at launch | ✅ **The 11 in the voice list, plus Welsh** (the bake-off showed `eleven_v3` speaks it; Welsh lines use `eleven_v3`, and a Welsh voice entry is added to the catalogue). |
| D-A6 | Customers' own face as a presenter | ✅ **Not at launch.** A later phase with recorded consent and a DPA note. |
| D-A7 | Presenter on screen the whole video, or only key moments? | ✅ **Key moments by default** (opening, call to action, marked moments), "Show me throughout" as a choice. It keeps the cost about 4× lower on long videos. |
