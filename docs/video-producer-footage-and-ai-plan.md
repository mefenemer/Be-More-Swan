# Video Producer — Your Own Footage and AI Clips: Plan

Added 2026-11-01, from the owner. Builds on [video-producer-plan.md](./video-producer-plan.md) (the
role, the storyboard, sourcing, the build worker, all LIVE on prod 2026-11-01) and
[video-editing-plan.md](./video-editing-plan.md) (the `video_edit` model and the post editor).

Status: **plan only, nothing built.** The decisions in §9 are the owner's.

---

## 1. Requirements (owner, 2026-11-01)

1. **Your own video, reviewed.** Upload your own videos. The Video Producer watches them,
   suggests edits based on what you're trying to achieve, and makes them once you agree.
2. **AI clips from a chat or text message.** Describe a clip in chat or on the Videos tab and get
   it made.
3. **Quality as good as the best AI video on the market,** with samples showing what it can do:
   realistic people, quality cartoon and so on.
4. **One tool for every source.** A video can use your own images and videos, stock, AI, or any
   mix of them.

## 2. The market (checked 2026-11-01)

- **Footage review is normal now.** CapCut's AutoCut picks the best takes and assembles a rough
  cut. Opus Clip finds the strongest moments in a long video and cuts shorts from them. Descript
  edits a video by editing its transcript. They all work the same way: transcribe, find the key
  moments, propose cuts, and the person accepts or changes them. Nobody claims the AI paces a
  story well on its own, so **suggest, then apply on approval** is the right model and also what
  the market does.
- **AI video models change every few weeks.** Rankings disagree by source and date. Wan 3.0,
  Seedance 2.5, Veo 3.1 / Gemini Omni and Kling (3.0, with 4.0 launched in October) are the names
  at the top. Some now make sound and picture together. Sora's API is reported closed (one source,
  unconfirmed).
- **What that means for us.** Hard-wiring one "best" model will be out of date within months.
  Pick a model **per style**, switch it with configuration, and rerun the bake-off (§5.3) every
  quarter.
- **What we do that they don't.** The AI tools mostly do one thing: edit your footage, or make AI
  clips, or assemble stock. Ours writes from your business details and Products & Services and
  mixes all three in one storyboard, with your review before anything posts. That's the angle,
  and it's only claimable once §4 ships.

Sources: [exemplary.ai, Oct 2026](https://exemplary.ai/blog/ai-video-generation-models-2026) ·
[llm-stats blind-vote board](https://llm-stats.com/leaderboards/best-ai-for-video-creation) ·
[videogen.io](https://videogen.io/best-ai-video-models) ·
[Kling AI](https://en.wikipedia.org/wiki/Kling_AI) ·
[SimilarLabs AI editors](https://similarlabs.com/blog/best-ai-video-editing-tools-2026)

## 3. What already exists. Reuse it, don't rebuild it.

| Need | Already there |
|---|---|
| A timeline of clips with in and out points, stills, overlays, voiceover, captions, music | `VideoEdit` / `VideoClip` (`src/lib/video-edit.ts`), the post editor, Remotion render (`remotion/`, `src/lib/post-render.ts`) |
| A plan you check before anything is spent | Storyboard (`src/lib/storyboard.ts`), Videos tab, `edit_scene`, `enforceStoryboard` |
| Sourcing per scene, a hold, settled per scene | `sourceScene` / `buildProject` (`src/utils/video-producer.ts`), `holdBuild`, `buildTasks` |
| Uploading files to R2 | `storage-request-upload` / `storage-confirm-upload`, `content-upload-url`, My Content |
| Speech to words with timings | `generate-voiceover.ts` (OpenAI transcription), `src/lib/captions.ts` |
| AI clips | `submitFramedVideo` (`src/lib/fal-gateway.ts`): a FLUX first frame, then image-to-video. The model is set by env (`FAL_I2V_MODEL`, default `kling-video/v2.5-turbo`; v3 takes 3–15 s) |
| Prompt moderation | `enforcePromptModeration` |
| Chat proposes, GUI confirms, both call one server action | the video_producer route in `chat-orchestrator.ts`, Plan this video card |
| Measuring a video file | Only inside Remotion (`Root.tsx` `calculateMetadata`). **No server function can open a video today.** §4.2 has to work around that |

## 4. Your own footage

### 4.1 A new scene source: `own_video`

Add `own_video` to `SCENE_SOURCES`: a segment `{ assetId, inS, outS }` of a video in the
workspace's library. This one change gives requirement 4. The planner can then mix your footage,
stock, branded cards and AI in one storyboard, the build treats it like `product_photo` (no
sourcing, no cost), and `sceneClips` already emits `inS`/`outS`.

`enforceStoryboard` checks that the asset is the workspace's own video and that the segment lies
inside its measured length (§4.2). It never trusts the model's numbers.

### 4.2 Understanding a video (the hard part)

Claude takes images, not video, so "watching" a video means:

1. **Frames.** A frame every ~2 seconds (at most 40), plus one at each scene cut.
   - **At upload, in the browser:** a `<video>` plus canvas grabs frames while the file uploads.
     This costs nothing, and the frames are stored as small JPEGs beside the video.
   - **For videos already in My Content:** a small Remotion still composition on the Lambda we
     already run (`renderStillOnLambda` at chosen timestamps). The same call returns the measured
     length, width and height, which no server function can get today.
2. **Speech.** Send the file to the same OpenAI transcription the voiceover uses, for words with
   timings. Files over 25 MB first get an audio-only Remotion render. A video with no speech gets
   `words: []`, and that's fine.
3. **A shot list.** One Claude call (frames with their timestamps, plus the transcript) returns
   segments: `{ inS, outS, what's in it, who's speaking and what, problems (shaky, dark, out of
   focus, people talking over each other, dead air), strongest moments }`. Stored on the asset as
   `footage_analysis` (JSON, versioned) so it's done once per video.

Limits for v1: videos up to 5 minutes and 500 MB, at most 10 analysed per request. Anything longer
gets a friendly refusal ("trim it first, or pick the part you want").

### 4.3 Suggest edits, then apply them on approval

On the Videos tab: **Use my own footage** → pick or upload videos → say what you want ("a 30-second
Reel announcing our autumn menu, end on the booking link") → **Review my footage**.

The Video Producer returns:

- **What it saw:** a short read of each video, its usable moments and its problems.
- **Suggested edits,** each with a tick box and a one-line reason:
  - trim or cut a segment ("cut 0:12–0:19: the camera shakes and nothing is said")
  - reorder ("open on the latte art, it's the strongest shot")
  - fill a gap with stock, a branded card or an AI clip ("you have no closing shot, add a branded
    card with the booking link")
  - text on screen, captions, music, a voiceover (or keep your own sound)
  - fit the length and frame (9:16 crop, keep faces in frame)
- **A storyboard** made from the ticked suggestions. It's the same storyboard as today, with
  `own_video` scenes in it. **Make the video** then goes down the existing build and review path.

Edits never apply without a tick, and nothing posts unapproved. Applying a suggestion only changes
the storyboard. The original upload is never changed.

Chat gets the same thing. You attach or name a video in chat. The reply describes what it saw and
shows a **Review these suggestions** card that opens the same tick list. Chat never applies edits
itself (the assistant-gui-chat-parity rule).

### 4.4 An existing post

"Make a video version" already exists. Add **Suggest edits** in the post editor for a video post:
it runs §4.3 against the post's own `videoEdit` and proposes changes to that timeline. That covers
a video someone cut themselves.

## 5. AI clips

### 5.1 A clip on its own, from chat or the Videos tab

**New AI clip** on the Videos tab, and "make me a clip of…" in chat:

1. Describe it, and pick a **style** (§5.2), a length and a shape (9:16, 1:1, 16:9).
2. **See the first frame,** which costs 1 task (an AI picture). Today's flow already makes this
   frame and throws it away. Showing it lets someone fix a wrong-looking frame before spending
   the clip's tasks. They can try again or change the words.
3. **Make the clip** (the clip's tasks). It lands in My Content, and can go straight into a post
   or a storyboard scene.

Under the hood it's a one-scene project (`kind: 'clip'`) on the same worker, hold and settlement,
so stuck sweeps, refunds and the Results tab already work.

### 5.2 Styles

A style is a prompt preset plus a model, so each style can use whichever model does it best:

| Style | For | Notes |
|---|---|---|
| Realistic | people, places, everyday scenes | fictional people only (§6) |
| Cinematic | landscapes, atmosphere, openers | |
| 3D animated | friendly explainers, mascots | |
| 2D cartoon | playful, illustrated brands | |
| Product and close-up | textures, food, materials | never the business's own product (an existing rule) |

Each style gets `FAL_I2V_MODEL_<STYLE>` (falling back to `FAL_I2V_MODEL`), so a better model is a
configuration change, not a release. `imageToVideoInput` already branches by model family. Add one
branch per new family.

### 5.3 Picking models: a bake-off, not a guess

Before building §5.1, run the same 6 prompts in each style through the candidate models on fal
(Kling 3 / 4, Veo 3.1, Seedance 2.5, Wan 3.0, Hailuo as fallback) at 9:16 and 1080p:

- Score each output for realism, motion, prompt-following and artefacts (hands, faces, warped text).
- Record the price per second **verified on the day.**
- Keep the results, side by side, in `docs/ai-video-bakeoff-<date>.md`.

Then pick per style, and set prices in tasks from the real cost (D-F2). Rerun it every quarter.
This replaces the old plan's D3.

**Sound:** some models make sound with the picture. Offer **with sound** as a per-clip choice
(ambient sound, no speech in v1), off by default, because a voiceover and music usually go over
it.

### 5.4 Length

Kling 3 takes 3–15 seconds. `aiClipSeconds` currently picks 6 or 10 (the v2.5 lengths). Once the
model is v3-family, ask for exactly the spoken length plus 0.3 s, rounded up. That's cheaper and
there's no clamping.

### 5.5 Samples on the website

A **What AI clips can look like** strip on the Video Producer page: one 5–6 s clip per style,
made with §5.1 on staging, from prompts about made-up businesses, each labelled "Made with AI".
These go in `SAMPLE_VIDEOS`, like the three samples there now. Every sample is a real output with
no editing, and the prompt is shown under each one.

## 6. Safety, consent and labelling

- **No real people.** Refuse prompts that name or describe a real or famous person, and add a
  moderation rule for likeness requests ("looks like…"). Realistic children are refused outright.
- **Your footage, your consent.** Upload asks once per workspace: "I have permission to use the
  people and music in videos I upload." The analysis never identifies people by name or face.
- **Labelling.** Realistic AI video is expected to be labelled. YouTube has an "altered or
  synthetic content" setting, and Meta shows an AI info label. When a post contains an AI clip,
  set the platform's disclosure field where the publish API offers one. Where it doesn't, add a
  short "Made with AI" line to the caption (an owner choice, D-F4). This ties in with the
  existing AI-notice work for images.
- **Music in uploads.** Copyrighted music in someone's footage is their responsibility. The
  analysis notes "music detected" and suggests **Replace with library music.**

## 7. Failure modes designed for up front

| Risk | Design |
|---|---|
| A segment past the end of the file (the "No frame found" failures, 2026-11-01) | segments are clamped to the length Remotion measured (§4.2), never the model's numbers |
| A huge or odd upload (HEVC, variable frame rate, 4K) | size and length caps, Remotion measures it, unreadable files are refused with a clear message |
| The analysis invents moments | every suggested segment must fall within the shot list's segments, and a quote must appear in the transcript |
| Paying for a clip nobody wanted | the 1-task first frame before the clip's tasks (§5.1) |
| The model provider changes or goes away | style → model set by env, Hailuo fallback, quarterly bake-off |
| Cost drifts from the price in tasks | task weights set from the bake-off's verified prices, checked on the Systems page |
| Long analyses hitting the function timeout | analysis runs in the background worker (like `build`), with polling from the tab |

## 8. Build order

| Phase | What | Notes |
|---|---|---|
| 0 | Bake-off (§5.3) + decisions D-F1…D-F5 | one day, no code shipped |
| 1 | `own_video` scene source + segment checks + build and render support | test: a storyboard mixing own, stock and AI renders on staging |
| 2 | Frames at upload (browser) + Remotion frame/measure function + transcription of uploads | pinned by tests against a real sample file |
| 3 | Shot list (`footage_analysis`) + **Review my footage** + suggested edits → storyboard | Videos tab first |
| 4 | Chat parity for 3 + **Suggest edits** in the post editor | |
| 5 | AI clip on its own (§5.1), styles (§5.2), env per style, first-frame step | GUI and chat together |
| 6 | Sound option, length to the second (§5.4) | after the models are picked |
| 7 | Labelling (§6) on publish | before AI clips are sold as realistic |
| 8 | Go-live copy: help articles (change "doesn't watch footage you give it"), showcase, FAQ, the samples strip (§5.5), pricing | the dated help-article file, never the retired seed |

Each phase is shippable on its own, behind the role being active and the plan having video.

## 9. Open decisions (the owner's)

| # | Decision | Recommendation |
|---|---|---|
| D-F1 | What a footage review costs | 2 tasks per review (vision + transcription), free re-suggest on the same analysis |
| D-F2 | AI clip price in tasks per style | set from the bake-off's verified price per second. Today's flat 20 may be too low for the top models |
| D-F3 | Which plans | footage review on every plan that has the Video Producer, AI clips on plans with AI video (as today) |
| D-F4 | AI labelling when the platform has no field | a short "Made with AI" line in the caption, which can't be turned off for realistic people |
| D-F5 | Upload limits | 5 minutes, 500 MB, 10 videos per review |

## 10. What we can claim, and when

- After Phase 3: "Upload your own videos. Your Video Producer watches them, suggests edits for what
  you want and makes them when you agree."
- After Phase 5: "Describe a clip and it makes it, in realistic, cinematic, 3D or cartoon style."
- Never: "the best AI video on the market" or "replaces CapCut". Say instead that it uses leading
  AI video models, reviewed every quarter, and keep the bake-off file as the evidence.
- Not in this plan: avatars or talking heads, voice cloning, lip-sync, long-form, TikTok.
