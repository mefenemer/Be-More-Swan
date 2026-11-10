# Video Producer: Your Own Voice, Music Volume and Text You Control: Plan

Added 2026-11-10. **Owner's question:** *"in the social media assistant, the user can manually add voice,
music, text overlays to videos however they are not able to do that in the Video Producer?"* The
owner then asked for a plan.

Builds on [video-producer-studio-plan.md](./video-producer-studio-plan.md) (finished videos go to
My Content, live on prod) and the seven improvements (music moods made with Stable Audio, ducking,
−14 LUFS levelling, script first, look, name captions; on staging 2026-11-10).

Status: **decisions taken 2026-11-10: the owner accepted all six recommendations in §7** (one text line per scene,
brand heading font, Quiet / Normal / Loud, own voice line by line, no mixed voices, AI presenter left for a separate plan).
**Phase 1 (music volume) on staging 6197f842**, help SQL applied to both databases.
**Phase 2 (scene text + Moving/Still) built 2026-11-10, not committed.** Help SQL:
db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzz-video-scene-text.sql (no schema change).
As built, differently from §3:
- **"Plain" keeps a faint 25% backing.** The renderer has no text shadow for overlays, and adding one would mean redeploying the Remotion site.
- **The brand font is used only when it's one of the 9 fonts the renderer has** (`overlay-fonts.ts`). Otherwise it's Impact, as before.
- **The planner prompt was not changed.** It can't set the text fields yet, so they come only from the owner (Change form or chat).
- **Saving a scene stores only the choices that differ from the defaults,** so moving the captions later still moves the words.

---

## 1. Where it stands

| | Social Media post editor | Video Producer today |
|---|---|---|
| **Voice** | Record a voice note in the browser, upload audio, or an AI voice from a script | AI voice only: choose the voice, edit each scene's line, approve the script |
| **Music** | Curated library, generate from a description and pace, upload; per-clip volume and timing | A mood (Stable Audio makes a track), a track from My Content, or none. Ducks under speech automatically. **No volume control** |
| **Text** | Text boxes dragged into place, timed per clip, font, colour, box, animation | One line per scene (60 characters), **fixed** in the upper third (lower if captions are at the top), white Impact on a dark box, "rise", shown for the whole scene (first 3 s over own footage). Plus captions (style picker) and name captions (3 styles) |

The gap is **control, not capability.** The Video Producer's finished video is already built from the
**same pieces as a post**: `ProjectTimeline.overlays` is `Overlay[]` (`src/lib/overlay-geometry.ts`) and
`audio` is `AudioOverlay[]`, rendered by the same Remotion composition (`remotion/PostOverlay.tsx`).
The build just fills them with fixed values (`sceneOverlays`, `musicTrack`, the voiceover track in
`src/utils/video-producer.ts` around line 915). So most of this work is letting the owner choose those
values, then passing them through. The renderer needs no new features.

**Not the aim:** copying the post editor's timeline into the Video Producer. The Video Producer works
scene by scene, and that's what makes it fast. Every control below sits on a scene or on the video's
options row. The post editor keeps its tools: people without a Video Producer, or on a plan without
video, still edit video on posts.

---

## 2. Phase 1: Music volume (small)

**On the options row,** beside Music: **Music volume: Quiet · Normal · Loud** (default Normal).

- **Stored** as `brief.musicLevel: 'quiet' | 'normal' | 'loud'`, read with a guard (an unknown value becomes `normal`).
- **The build** multiplies the levelled music gain (`levels.music`) by 0.5 / 1 / 1.6 (about −6 / 0 / +4 dB).
  It still caps at the track's peak room (`LIMIT_CEILING_DB`). The ducked level (`levels.musicUnder`)
  scales the same way, so the music still drops under speech by the same amount.
- **Why three steps and not a slider:** every video is levelled to −14 LUFS. A raw percentage
  looks precise but means nothing against that. Three words are honest and match the post editor's
  plain style.
- **On a Ready video,** changing it makes a new version (as Music and Look do now). Only the render
  runs again, with nothing new to make, so it's **free**.
- **Chat:** `video_options_proposal` gains `"musicLevel"`. The snapshot shows `music volume: quiet` when it isn't normal.
- **Results / help:** one line in the "Making a Video" article.

Files: `src/lib/video-music.ts` (the multiplier, pure and tested), `video-producer.ts` build,
`video-projects.ts set_options`, `assistant-videos.js optionsHtml`, `disruptive-ui-registry.js`,
`chat-orchestrator.ts` MUSIC section, and the snapshot.

---

## 3. Phase 2: Text you control, per scene

Each scene's **Change** form (where "On screen" already is) gains a small **Text** group:

- **Words.** The existing line, up to 60 characters. Unchanged.
- **Where:** Top · Middle · Bottom. The default is today's rule: top, or bottom when captions are at the top.
  If text and captions would sit in the same place, the form says so and suggests the other position.
  The build won't move it silently.
- **When:**
  - **Whole scene.** The default for stock, AI and pictures.
  - **First 3 seconds.** The default over your own footage, as now.
  - **Last 3 seconds.**
  - **With the words.** It shows while this scene's line is spoken, using the voiceover's word timings. The post editor already does this ("Text boxes follow the voice", `post-voiceover.ts`), so reuse that.
- **Look:** three styles, matching the name-caption choices so a video looks consistent:
  - **Dark box.** White text on a 55% black box (today's).
  - **Plain.** White text with a shadow, no box.
  - **Brand box.** Brand primary colour box, white or black text by contrast.

  The font is the brand heading font when it's one the render has, otherwise today's. There's no font picker per scene (see D-T2).
- **Appears:** Cut · Fade · Rise · Pop (`OVERLAY_ANIMS`, already in the renderer). Default Rise.
- **Preview:** the scene's picture shows the words in the chosen position and style with CSS.
  This is a guide, not the render. It's the first time the Videos tab shows text on a scene before
  "Make the video".

**Stored** on the scene: `textPos`, `textWhen`, `textStyle`, `textAnim`. `enforceStoryboard` keeps them
valid, and they're absent on older storyboards (behaviour stays the same). `sceneOverlays` reads them.
The planner (the storyboard prompt) can also set them, for example "With the words" for a key line, but
never has to.

- **One text line per scene,** as now (D-T1). A second line is what a separate scene is for.
- **A branded-card scene** keeps its words as the card's headline, with no overlay, as now. The Text group shows only Words there.
- **Cost:** changing text on a Ready video is a new version with nothing to make, so it's **free**.
  Before "Make the video" it's a storyboard edit (counts in `edit_count`, as other edits do).
- **Chat:** `video_scene_edit` gains `textPos`, `textWhen`, `textStyle`, `textAnim` with the same validation (`src/utils/chat-video-scene.ts`).

---

## 4. Phase 3: Your own voice (and yourself on camera)

### 4.1 Your own voiceover

The brief form and the script step get **Voice: AI voice · My own voice**.

With **My own voice**, the approved script shows a **Record** and an **Upload** button on each scene's
line. This reuses the post editor's recorder (`_pceRecordAudio`, MediaRecorder) as a small shared module
(`src/components/voice-recorder.js`), plus `gpUploadContentAsset` for uploads.

**Recommendation (D-V1):** record line by line, not the whole video in one go.

- You can redo one line without re-reading the rest.
- Each scene lasts exactly as long as its recording plus a short gap. There's no guessing which words
  belong to which scene. Today the AI voice is one file split by word counts (`sceneTimingsFromWords`),
  and that only works because the AI reads the script exactly. A person ad-libs.
- **"Upload one recording for the whole video"** is still offered, for people who recorded elsewhere.
  It's split the same way as the AI voice, with a note that scene breaks follow the script's word counts.

**Each recording:**

- **Saved and transcribed.** It's stored in My Content as audio with `render_params.kind = 'voiceover'`,
  then transcribed by `transcribeWords` (`src/lib/tts.ts`, already used for the AI voice). That gives
  captions and "With the words" timing. If transcription fails, the audio is kept and that scene has no
  captions, as `voiceover-asset.ts` already does.
- **Shown under the line** with play, length, Redo and Remove. If the words heard differ a lot from the
  script line, it says "Your recording says something different from this line". It warns but never blocks.
- **Moderation.** The transcript goes through the same moderation as typed script text.

**At build:**

- **No AI voiceover is made,** so there's **no voiceover charge** (`VOICEOVER_CREDIT_COST` is not held).
  The estimate on "Make the video" shows that.
- **"Make the video" waits** until every scene with a line has a recording. It's disabled with
  "Record scene 3's line, or remove its words".
- **Each recording becomes a voiceover track** placed at its scene's start. The recording sets the
  scene's length (it replaces `sceneTimingsFromWords` for this video). Each is levelled to −14 LUFS
  (`levelledVoiceover`, as now) and ducks the music.
- **⚠️ Check before building:** captions. `post-render.ts` builds the caption track from voiceover clips.
  Make sure it merges several clips' words with their offsets, not only the first. If it doesn't, the
  build joins the recordings into one levelled file first (the mpg123 decoder from the seven
  improvements can do this), and the renderer stays unchanged.

**New versions:** "Change it" keeps every recording whose line didn't change. A changed line asks for
that line again (the same rule as `voiceSame` today, applied per scene).

**Chat:** the chat can't record for you. It can propose **Voice: my own voice** on an options card,
and then say which lines still need recording, by scene. The snapshot shows "scene 2: recorded",
"scene 3: not recorded yet".

### 4.2 Yourself on camera (the second question, 2026-11-10)

The owner asked whether videos are only made from still images, and how a video of someone speaking and
moving is handled. Today:

- **Not stills only.** A scene can be moving stock footage, an AI clip (moving video made by Kling),
  a picture, a branded card, a product photo, or **your own footage**.
- **Someone speaking works today through your own footage.** "Use my own footage" takes your videos,
  keeps their sound, cuts the ums and dead air, captions what's said, and can add a name caption
  ("Sarah Jones · Owner"). That's the way to make a video of a real person talking.
- **What's missing** is a way to film it **on the Videos tab.** You have to record on your phone and
  upload. Phase 3 adds **Record a video** beside Record a voice: the browser's camera, saved to My
  Content as your own footage, then on into the footage flow as if it had been uploaded.

**Why it can look like stills (found 2026-11-10):** on the storyboard, a moving scene's preview is a
`<video preload="metadata">` with no controls and no autoplay (`sceneHtml` in `assistant-videos.js`).
It shows a paused first frame, which looks exactly like a picture. **Fix, in Phase 2:**

- moving scenes play muted on hover or tap, and pause when the pointer leaves
- a small "▶ Moving" or "Still" tag on each scene, beside its source ("Stock footage", "Your video")

The fix is small and costs nothing.

**Not in this plan: an AI presenter** (a made-up or cloned person speaking your words, lip-synced, as
HeyGen and Synthesia do). It's a different kind of product:

- a new paid supplier
- consent and likeness rules for cloning a real person
- labelling AI people as AI
- a much higher cost per second

The Kling clips can show people moving, but not speaking your words in sync. See D-V3.

---

## 5. What doesn't change

- The post editor's tools stay as they are.
- Nothing spends without "Make the video" saying so. Phases 1 and 2 add no cost. Phase 3 removes the voiceover cost when your own voice is used.
- The renderer and composition stay the same (apart from the caption check in §4.1).
- Old storyboards and videos render exactly as before: every new field is optional, with today's behaviour as the default.

---

## 6. Order and size

| Phase | What | Size | SQL |
|---|---|---|---|
| 1 | Music volume | Small: about half a day | None (brief JSON) |
| 2 | Text: where, when, look, appears, preview | Medium: 1–2 days | None (storyboard JSON) |
| 3a | Your own voice, line by line + whole-file upload | Medium–large: 2–3 days | None expected (assets + storyboard JSON) |
| 3b | Record a video on the Videos tab → own footage | Small–medium: 1 day | None |

Each phase ships on its own, with the GUI and the chat card together (GUI and chat parity), tests,
and a help-article SQL file.

---

## 7. Decisions for the owner

- **D-T1.** One text line per scene, or allow two? *Recommend one.* A second line is a new scene, and it keeps the form short.
- **D-T2.** A font choice per scene? *Recommend no.* Use the brand heading font for every scene. A per-scene font picker makes videos look patchy.
- **D-M1.** Music volume as Quiet / Normal / Loud, or a slider? *Recommend the three words* (see §2).
- **D-V1.** Your own voice recorded line by line (plus an optional whole-file upload), or one recording for the whole video? *Recommend line by line.*
- **D-V2.** Can one video mix your voice on some lines and the AI voice on others? *Recommend no.* Two voices in one video sounds wrong, and it makes "Make the video" harder to explain.
- **D-V3.** An AI presenter (lip-synced person speaking your words): look at it as a separate plan, or not at all? *Recommend a separate plan later, only if customers ask.* Recording yourself (§4.2) covers a real person today, and costs nothing extra.
