# Video Producer as a Studio: Plan

Added 2026-11-09, from the owner, after the first real footage tests on staging. Builds on
[video-producer-plan.md](./video-producer-plan.md) (the role, LIVE on prod 2026-11-01) and
[video-producer-footage-and-ai-plan.md](./video-producer-footage-and-ai-plan.md) (footage review and
tightening, on staging).

Status: **decisions taken 2026-11-09 — the owner accepted every recommendation in §8 (D-S1…D-S6).**
**Phases 1–2 built 2026-11-09 (commit def5d734)**, waiting on `db/z-video-producer-studio.sql` before deploy.

As built, differently from §4.1: projects render through their OWN worker
(`render-video-project-background.ts` → `src/utils/video-render.ts renderProject`), not by making
`post_render_jobs.post_id` nullable. The post render path is untouched, and the render state lives on
`video_projects` (`render_id`, `render_bucket`, `render_region`). Same composition, same resolvers.

---

## 1. Why

The owner's words (2026-11-09): *"I was not expecting to be able to post to social media from the
Video Producer, I was expecting to be able to make/edit videos which are stored in My Content area and
can be downloaded for the user to use externally or can then be used in other assistants e.g. Social
Media or Blog Writer. The Video Producer seems to be mixing the two which is not correct."*

Today a finished video **is a post.** That was a deliberate choice on 2026-10-31 so the video reused the
Review Queue, rendering and publishing. In practice it causes trouble:

- **The form asks where to post** ("Post it as Instagram Reel / YouTube Short / Facebook Reel"), which
  is the Social Media Manager's job.
- **The finished file didn't exist until a post was approved.** Rendering is tied to a post, so the
  Review Queue played the raw source. The owner watched an untrimmed 29 s clip with no captions or
  closing card and was asked to approve it. Commit `a42a1852` now renders straight after the build,
  but that's a patch.
- **The review screen treats a video as an editable post.** It painted its own copy of the text over a
  render that already had it. Fixed in `9a82d920`, but the cause is the same.
- **It can't be used anywhere else.** A video made for Instagram can't easily go into a blog post, a
  website or a download, and the platforms chosen in the brief are fixed into the posts it made.
- **Two places to check one video:** the Videos tab (storyboard) and the Review Queue (result).

## 2. The new shape, left to right

```
Video Producer (a studio)                           Other assistants (publishers)
──────────────────────────────────────────────      ─────────────────────────────────────────
brief  ─┐                                           Social Media Manager: "Use in a post"
footage ┼→ storyboard → Make the video → render ─→   → a draft post with the video
from a  │   (check,      (spends tasks)   │          Blog Writer: "Use in a blog post"
post /  ┘    change)                      │          → the video in a draft article
campaign                                  ▼          Website Assistant, Email, … → My Content
                                   finished MP4 in My Content     Download → use anywhere
                                   (Videos tab plays it; Change it → a new version)
```

The Video Producer **makes and changes videos.** It never creates, schedules or publishes a post.
Everything it makes is a `content_assets` video in My Content, which every assistant can already pick,
and which My Content can already download (`content-asset-download.ts`).

## 3. What each surface does

### 3.1 Videos tab (the studio)

- **New video / Use my own footage**: as now, but **"Post it as" is replaced by "Shape"**: Vertical
  9:16 (Reels, Shorts, Stories), Square 1:1 (feeds), Wide 16:9 (YouTube, websites). The render already
  takes a `targetRatio`, and stills and stock reframe to it.
- **Stages** become: To check → Being made → **Ready** → Archived. "Ready" means the finished MP4 is
  in My Content.
- **A Ready video plays the finished file** (the render, never the source), with its length, shape and
  "Contains AI" if any scene is AI.
- **Buttons on a Ready video:** ▶ play · **Download** · **Use in a post** · **Use in a blog post** ·
  **Change it**.
  - **Change it** reopens the storyboard: scenes, on-screen text, "Keep as filmed", voice, captions.
    Making it again produces a **new version**. The old one stays in My Content (D-S1).
  - **Use in a post / Use in a blog post** appear only when that assistant is hired and **active**
    (the rule in memory: never hand off to a missing or paused teammate). Otherwise: "Download it, or
    hire a Social Media Manager to post it."
- **The caption the storyboard writes** becomes a **"suggested words"** note that travels with the
  video to whoever uses it. It is not a post caption.

### 3.2 My Content

- Finished videos show with the Video Producer as their maker, with a "made by Vic" filter, and open
  their project on the Videos tab.
- Download already works. Nothing new is needed beyond showing the version and "Contains AI".
- The building blocks a video is made from (stock clips, AI clips, voiceover, caption track) stay out
  of the user's view as they do today. Only the finished video is listed as made by the Producer.

### 3.3 Social Media Manager: "Use in a post"

- Creates **a draft post for the active Social Media Manager** with the video attached (the same
  attach path as `attach-draft-media.ts`), using the Producer's suggested words as the starting
  caption. It goes to **that assistant's** Review Queue, where the platforms, wording, hashtags,
  schedule and approval belong.
- The Social Media chat gets the same: "post my new video" offers a card naming Ready videos.
- Cost: D-S3.

### 3.4 Blog Writer: "Use in a blog post"

- The Blog Writer's editor already places video in the article body (`blog-studio-modal.js`
  "Images & media"). "Use in a blog post" opens a **new blog draft brief** for the active Blog Writer,
  with the video attached as body media and the suggested words as the brief. Or, when a draft is
  open, it inserts the video there.

### 3.5 Videos that start somewhere else

| Start | Today | New |
|---|---|---|
| "Make a video version" on a post | Plans a video that becomes NEW posts | Plans a video; when Ready, it **attaches to that post** (replacing its media), the way an approved Brand Designer picture does (`brief-post-media.ts attachApprovedToPost`) — D-S4 |
| Campaign Assistant `commission_video` | Settles when the post is approved | Settles when the video is **Ready**; the campaign hands it to the Social Media Manager with `placeOnCampaignPost`, as `commission_visuals` already does |
| Autopilot | Storyboards only | Unchanged: storyboards only, never spends |
| Chat "plan me a video" | Brief card → storyboard | Unchanged, but the card asks for a **shape**, not platforms |
| "Suggest edits" on a video post (Review Queue) | Opens the footage form | Unchanged; when Ready, offers to attach the new cut back to that post (as row 1) |

### 3.6 Chat

- The Video Producer's prompt stops talking about the Review Queue and posting. It talks about
  shape, Ready, Download, "Use in a post", "Use in a blog post" and versions. GUI and chat stay on
  the same server actions (the parity rule): new cards `video_use_in_post` and `video_use_in_blog`
  that the user approves.

## 4. Data and render changes

### 4.1 Render a project, not a post

`post_render_jobs.post_id` is NOT NULL and the worker (`render-post-video-background.ts`) reads the
post's `video_edit`, `image_overlays` and `audio_overlays`. Change:

- **The project holds the timeline.** `buildProject` writes `{ videoEdit, overlays, audio,
  targetRatio }` to a new `video_projects.timeline` column instead of inserting `scheduled_posts`.
- **Render jobs can belong to a project.** `post_render_jobs.post_id` becomes nullable and gains
  `video_project_id` (one of the two must be set — a CHECK). The worker reads the timeline from
  whichever it belongs to. The composition (`remotion/PostOverlay.tsx`) is unchanged, so **no Remotion
  redeploy.**
- **Output:** the rendered asset is named after the video's title, linked from
  `video_projects.output_asset_id` and `version`, and the project goes `building → rendering → ready`
  (or `render_failed`, with "Try the render again" on the Videos tab).
- The post path keeps working exactly as it is for posts people edit by hand.

SQL (`db/z-video-producer-studio.sql`, both DBs before deploy): `video_projects.timeline jsonb`,
`output_asset_id`, `version`, `shape`, `parent_project_id` (the version it was changed from); status
CHECK + `rendering`, `ready`, `render_failed`, `archived`; `post_render_jobs.post_id` nullable +
`video_project_id` + CHECK.

### 4.2 Money

Unchanged: "Make the video" holds and settles exactly as now. A render costs no tasks (it never has).
"Use in a post" and "Use in a blog post" cost what D-S3 says.

### 4.3 What happens to videos already made

Projects already `built`, and their posts, stay as they are (they still publish through the Review
Queue). From the release, new builds go to My Content. The Videos tab shows old ones under
"Made (before 9 Nov)" with "Open the Review Queue".

## 5. What does not change

The storyboard rules, footage review, tightening, captions, voices, AI clips, the build's holds and
settlement, the stuck sweep, the autopilot, and every money rule. Everything since 2026-11-09 on staging
carries over.

## 6. Copy that must change in the same release (public-copy rule)

- Help articles: Video Producer (3), voices & captions, "What counts as a task" if D-S3 changes it.
- `assistant.html` Video Producer page and its showcase text, `ai-…` assistant pages, `llms.txt`.
- `pricing.html` row and FAQ ("lands in the Review Queue" → "saved to My Content, ready to post or
  download").
- The Video Producer chat prompt, its setup questions (`assistant-onboarding-schemas.js`: drop
  platforms, add default shape), Mentor / Ask Your Team routing text.
- `/connections` is unaffected (the Producer posts nowhere).

## 7. Build order

| Phase | What | Test |
|---|---|---|
| 1 | SQL + render a project to My Content (§4.1); build writes the timeline, not posts; Videos tab plays the finished file, with Download and Try again | Staging: a brief video and a footage video both end Ready in My Content with captions, cuts and card, no post created |
| 2 | Shape instead of platforms (form, chat card, setup) | A 1:1 and a 16:9 render of the same storyboard |
| 3 | Change it → new version; versions in My Content | Change one scene, make again, both versions download |
| 4 | Use in a post (SMM) and Use in a blog post (Blog Writer), GUI + chat cards, active-teammate check | Draft post in the SMM's Review Queue with the video; blog draft with the video in the body |
| 5 | Make a video version → attaches back to that post; Campaign `commission_video` settles on Ready + `placeOnCampaignPost` | A post gets its video; a campaign order settles |
| 6 | Copy (§6), help articles (dated file, never the retired seed), pricing/FAQ | Copy matches the product |

Phases 1–3 are the studio; 4–5 are the hand-offs. Each ships behind the role being active, as now.

## 8. Open decisions (the owner's)

| # | Decision | Recommendation |
|---|---|---|
| D-S1 | Versions: keep every version, or replace the old file? | Keep every version; the newest is "current". Old ones can be deleted from My Content |
| D-S2 | Shapes in the first release | 9:16, 1:1 and 16:9 together — the render supports them; own 16:9 footage crops to 9:16 centred |
| D-S3 | Cost of "Use in a post" / "Use in a blog post" | Free when it only attaches the video with the suggested words (no model call). The usual 1 task only if the user asks that assistant to write or rewrite the words |
| D-S4 | "Make a video version" of a post | Attach the finished video to that post, keeping its caption, like an approved Brand Designer picture |
| D-S5 | Can the Video Producer still post anything itself? | No. Posting belongs to the Social Media Manager |
| D-S6 | Videos with AI clips | Marked "Contains AI" in My Content; the label/disclosure on publish stays the Social Media Manager's job (footage plan §6) |

## 9. Risks

- **Rendering is the one heavy change.** The worker is shared with every post render; the project path
  must not change how posts render. Tests pin both paths.
- **Hand-offs depend on teammates being active.** Without a Social Media Manager the only route is
  Download, which must be obvious, not hidden.
- **Campaign orders in flight** at release still expect a post. The reconciler keeps the old rule for
  orders created before the release.
