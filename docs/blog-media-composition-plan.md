# Blog Media Composition — epic plan

Authoring goal: in the Blog Studio, an author can bring in an **image, video or audio clip** from
their content library, a Canva design, a Pexels stock search, or an AI generation — and **drag it
into the body** where they want it: inline with the text, or as part of a **column layout**.

This plan is the design + phasing for that. No code has been written yet.

Companion to `docs/content-engine-epic-plan.md` (the blog epic proper). Read §8 of that doc first —
the publish snapshot contract described there is what constrains most of the decisions below.

---

## 1. Where we are today

More exists than a first look suggests. The honest inventory:

| Capability | State |
| --- | --- |
| Feature (hero) graphic | **Works.** `blog_posts.feature_asset_id` FK, set via `blog-media.ts`. |
| Inline **image** in the body | **Works.** Editor emits `![alt](asset://N)`; `markdown-render.ts` rewrites to a src-less `<img data-bms-asset="N">`; `widget-api.ts` resolves a fresh presigned URL at read time. |
| Library / Upload / Pexels / Canva / AI pickers | **Wired** into the Blog Studio media panel (`blog-studio-modal.js:210-244`). |
| Inline **video** | **Broken end-to-end** — see §2.1. |
| Inline **audio** | **Does not exist** — see §2.2. |
| Positional insert / drag-drop | **Does not exist** — see §2.3. |
| Media in Dev.to / Hashnode syndication | **Already broken** — see §2.4. |
| Column layouts | **Does not exist** — see §2.5. |

### The `asset://` indirection is the good bone here

The one thing to preserve at all costs. The body never stores a media URL:

```
![alt](asset://42)                     ← body_markdown (source of truth, stable)
  → <img data-bms-asset="42">          ← published_payload (markdown-render.ts, immutable snapshot)
    → <img src="https://…presigned…">  ← read time (widget-api.ts:38-57)
```

Presigned R2 URLs expire; the published payload is immutable and CDN-cacheable. Baking a URL into
the snapshot would produce blog posts whose images die after the presign TTL. **Every media type we
add must go through this same three-step indirection.** This is the single most important
invariant in this plan.

---

## 2. The gaps, precisely

### 2.1 Inline video is silently broken

Three independent breaks, all of which must be fixed together for video to render at all:

1. `blog-media.ts:139` accepts `assetType === 'video'` for the inline role — so a video *attaches*
   and appears in `blog_post_assets`.
2. But the editor only has `insertImage()` (`markdown-editor.js:494`), which emits
   `![](asset://N)` — an `<img>`. A video in an `<img>` renders nothing.
3. And `markdown-render.ts`'s `ALLOWED_TAGS` has no `video`, so even correct markup is stripped at
   publish.

Net effect today: **you can attach a video to a blog post and it will never appear.** Worth stating
plainly because it's a live bug, not just a missing feature.

### 2.2 Audio does not exist as a concept

- `contentAssets.assetType` is `'image' | 'video' | 'link'` (`db/schema.ts:1613`).
- `content-assets.ts:250` validates against exactly that list — an audio asset cannot be created.
- Audio MIME types exist only in unrelated corners: `storage-request-upload.ts` allows them under
  `voice_recording` / `brand_document`, and `tour-narration.ts` does TTS. Neither is the content
  library.

So audio is **net-new plumbing** through upload → library → picker → attach → render → widget.

### 2.3 No positional insert

`insertImage()` appends the image **as its own new block at the end of the document**
(`markdown-editor.js:494-505`). There is no "insert at index", so there is nothing for a drop
target to call.

> ⚠️ **Known trap.** `renderAll()` mid-edit orphans the open textarea and silently wedges the whole
> editor shut. The editor already guards this (`markdown-editor.js:193`). Drag-drop pokes exactly
> this seam — every new insert path must respect the guard rather than re-render blindly.

### 2.4 Syndicated posts already ship broken media refs

`publish-blog-destinations.ts:64` passes `post.bodyMarkdown` to Dev.to / Hashnode **raw**. An inline
image therefore arrives at Dev.to as the literal string `![alt](asset://42)` — and `asset://42` is
not a URL any external platform can resolve. The `bodyHtml` fallback is no better: it's the snapshot
HTML, whose `<img data-bms-asset="42">` is deliberately src-less (§1).

So inline media in syndicated posts is **already broken today**, before this epic adds anything.

Note the hero already does the right thing: `coverImageUrl: null` (`publish-blog-destinations.ts:69`)
with the comment that private-R2 heroes are presigned/expiring and we never hand an external platform
a URL that will 404 later. **The decision in §3.6 extends that existing, correct precedent to body
media** rather than inventing a new rule.

### 2.5 Columns have no representation

Markdown has no column syntax, and the block model (`splitBlocks`, `markdown-editor.js:63`) is a
**flat** array of blank-line-separated blocks. Columns are inherently nested. This is the deepest
change in the epic.

---

## 3. Design decision: extend Markdown with directives

**Decided** (over a JSON block document, and over raw HTML blocks).

- *JSON block document* would be the cleanest model, but it's a rewrite of the editor,
  `markdown-render`, the publish snapshot, `widget-api`, plus a migration of every existing draft.
- *Raw HTML blocks* is fastest and rejected on security grounds: this HTML renders on **third-party
  customer domains** via the widget. The sanitiser allowlist is the control that makes that safe;
  widening it to arbitrary HTML is a stored-XSS surface on someone else's site.
- *Directives* keep `body_markdown` as the source of truth, keep every existing draft valid, reuse
  the `asset://` indirection, and keep the sanitiser allowlist narrow and enumerable.

### 3.1 Syntax

Generic-directive style (the `remark-directive` convention — a recognised shape, not invented here):

**Leaf directive** — a single media item:

```
:::media{asset=42 type=video caption="Our Q3 walkthrough" align=wide}
```

**Container directive** — a column layout, holding ordinary Markdown blocks:

```
::::columns{cols=2}
:::column
Ordinary **Markdown** here.
:::
:::column
:::media{asset=42 type=image}
:::
::::
```

Note the outer fence uses *more* colons than the inner — standard directive nesting.

Images keep working as plain `![alt](asset://N)`. We do **not** migrate them to `:::media`;
the directive is for what Markdown can't express. Two syntaxes for images is a small wart, accepted
deliberately: it means zero migration risk and every existing draft stays byte-identical.

### 3.2 The parser must be written once and run in two places

This is the main piece of incidental complexity, so call it out early:

- **Client**: `markdown-editor.js` renders via the global `window.marked` + `window.DOMPurify`
  (loaded by the host page).
- **Server**: `markdown-render.ts` imports `marked` + `sanitize-html` and produces the immutable
  snapshot.

If these two disagree, the editor preview lies about what gets published. So the directive
tokenizer must be **one** artifact consumed both ways: author `src/lib/marked-bms-directives.js` as
a plain UMD-ish file that attaches to `window.BmsDirectives` **and** supports `module.exports`, so
the browser can `<script>` it and the esbuild-bundled function can `import` it.

(This matches the existing house style — `src/components/*.js` are `window.*` IIFE modules; see the
memory note that this frontend is vanilla, not React.)

### 3.3 Rendering contract

Directives compile to the same src-less, `data-bms-asset` shape as images:

| Directive | Snapshot HTML | Resolved at read time by widget-api |
| --- | --- | --- |
| `:::media{type=image}` | `<img data-bms-asset="N">` | `src` |
| `:::media{type=video}` | `<video data-bms-asset="N" controls preload="metadata">` | `src` |
| `:::media{type=audio}` | `<audio data-bms-asset="N" controls preload="metadata">` | `src` |
| `:::columns` | `<div class="bms-columns" data-cols="2">` + `<div class="bms-column">` | — |
| `caption=` | wrapped in `<figure>` + `<figcaption>` | — |

### 3.4 Sanitiser changes (security-critical — review carefully)

`markdown-render.ts` `ALLOWED_TAGS` gains: `video`, `audio`, `source`, `div`.
(`figure` / `figcaption` are already allowed.)

Constraints that must hold:

- `video` / `audio` attrs: **`data-bms-asset`, `controls`, `preload`, `width`, `height`, `poster`
  only.** Explicitly **no** `src` in the snapshot — same rule as `img` today; `widget-api` injects
  it. Explicitly **no** `autoplay` and no event-handler attributes.
- `div` is allowed **only** with `class` restricted via sanitize-html's `allowedClasses` to
  `bms-columns` / `bms-column`, plus a `data-cols` limited to `2|3`. A bare or arbitrary-class
  `div` must not survive.
- `allowedSchemesByTag` extends to `video: ['https']`, `audio: ['https']` for the Pexels-hotlink
  case (where `externalUrl` is a real CDN URL rather than a presigned key).
- The directive parser must not be a bypass: attribute values are escaped, and `asset=` accepts
  **digits only**.

**A test asserting that a hostile directive cannot emit script/onerror/src-injection belongs in the
same commit as the allowlist change**, not a later phase.

### 3.5 Syndication carries no media — text only

**Decided.** The blog post is published **with** media to our own widget. Dev.to / Hashnode receive
a **text-only** projection: no hero, no inline images, no video, no audio, no columns.

Rationale (and why this isn't a compromise):

- It extends the existing, deliberate `coverImageUrl: null` precedent (§2.4) rather than fighting it.
- Our media URLs are presigned and expiring. Anything we hand an external platform 404s later. The
  alternatives — permanently hosting public copies, or hotlinking private R2 — are both worse and
  neither is in scope.
- Pexels is **hotlink-only under its ToS** (`src/utils/pexels.ts:7-9`). Re-hosting a Pexels asset on
  Dev.to's CDN would breach that. A text-only projection sidesteps the licensing question entirely.
- It fixes the live bug in §2.4 instead of extending it to three more media types.

Implementation — one function, `stripMediaForSyndication(md)` in `src/utils/blog-publish.ts`,
applied at `publish-blog-destinations.ts:64`:

| Input | Output |
| --- | --- |
| `![alt](asset://N)` | removed |
| `:::media{…}` | removed |
| `::::columns` / `:::column` | **unwrapped** — inner Markdown survives, stacked in source order |
| `![alt](https://…)` | **kept** — a real public URL still resolves off-platform |
| `bodyHtml` | must be stripped to match, or set `null` so the adapter falls back to Markdown |

Two constraints that matter:

- **Unwrap columns, don't drop them.** Dropping a `:::column` container would silently delete the
  author's *prose*, not just their media. Stacking preserves the words.
- **Never leak directive syntax.** A syndicated post must never contain literal `:::media{…}` text.
  This is the same failure mode as the §5 risk table's "directive leaking as literal text", and it's
  why stripping is a parser-level operation, not a regex over the raw string.

The author should be told, not surprised: the Syndicate panel needs a quiet line —
*"Dev.to and Hashnode receive text only; media stays on your site."*

**This lands in Phase 1**, not Phase 4 — it closes a current bug (§2.4) and the strip must exist
*before* directives can reach a syndication payload.

### 3.6 `splitBlocks` must become container-aware

`splitBlocks` (`markdown-editor.js:63-81`) tracks ``` fences only. A `:::column` containing two
paragraphs separated by a blank line would be shredded into separate top-level blocks. It needs a
directive-container depth counter alongside `inFence`.

---

## 4. Phasing

Each phase is independently shippable and leaves the product working.

### Phase 1 — Directive foundation + fix inline video
*Closes the live bug in §2.1.*

1. `src/lib/marked-bms-directives.js` — the shared tokenizer/renderer (§3.2).
2. `markdown-render.ts` — allowlist + transform for `video`/`audio`/`div` (§3.4), **with the
   hostile-input test**.
3. `widget-api.ts` — generalise the resolver. Its regex is `img`-specific today
   (`widget-api.ts:54`); it must resolve `data-bms-asset` on `img|video|audio`.
4. `markdown-editor.js` — `insertMedia({assetId, type, …})` emitting `:::media`; keep `insertImage`
   as a thin wrapper so nothing else breaks.
5. `blog-studio-modal.js` — inline picker offers video; `routeImage` → `routeMedia` carrying type.
6. `widget.js` + blog CSS — style `<video>`/`<audio>`, responsive.
7. `stripMediaForSyndication` (§3.5) + the Syndicate-panel note. Closes the §2.4 bug.

**Exit:** attach a video inline → it plays on the published widget; syndicate the same post → Dev.to
shows clean prose with no broken image refs and no literal `:::media{…}`.

### Phase 2 — Audio as a first-class asset type
*Everything in §2.2.* **Audio is upload-only** (decided): no stock provider (Pexels has none) and no
AI audio generation. The library/upload path is the whole story for now — so the Studio's audio
picker offers Library + Upload only, and must not render a Stock or AI button it can't honour.

1. `content-assets.ts:250` — `validTypes` gains `'audio'`.
2. `storage-request-upload.ts` — audio MIME routing for library uploads (the existing audio MIMEs
   live under `voice_recording`/`brand_document`; blog audio needs its own category rather than
   being smuggled through a brand-document upload).
3. `db/schema.ts:1613` comment + any `assetType` unions. **No DDL** — `asset_type` is `text`, so
   this is a validation change, not a migration.
4. `blog-media.ts:139-142` — permit `audio` for the inline role (feature stays image-only).
5. Library UI (`assets.js` / `my-content.js`) — an audio filter/tab, `<audio>` preview.
6. `resolveAssetDisplayUrl` is type-agnostic — **no change needed** (verify, don't assume).

**Exit:** upload an MP3 to the library, attach it inline, it plays on the widget.

### Phase 3 — Positional insert + drag-and-drop
*Everything in §2.3. The UX payload of the request.*

1. `markdown-editor.js` — `insertMediaAt(index, media)`; drop zones between blocks; respect the
   `renderAll()`-mid-edit guard (§2.3 trap).
2. Picker items become `draggable=true`, carrying a JSON `dataTransfer` payload
   (`{source:'library'|'pexels'|'canva', assetId|candidate, type}`).
3. Drop handler: attach via `blog-media` **first**, then insert the directive with the returned
   `assetId` — a drop must never write a directive pointing at an unattached asset.
4. Drag-reorder of existing media blocks.
5. Also accept an **OS file drop** straight into the body (reuse `uploadContentAsset`,
   `blog-studio-modal.js:565`).

> Testing note: automated browser tabs lack OS focus, so `blur()` won't fire and native
> drag-and-drop is not reliably scriptable. **This phase needs real mouse+keyboard verification** —
> same lesson as the blog-body persistence work.

### Phase 4 — Column layouts
*Everything in §2.5. The deepest change — do not start before Phase 3 is stable.*

1. `splitBlocks` container-awareness (§3.6).
2. Nested block model: a `columns` block owns child block arrays. This touches block IDs, the
   click-to-edit textarea seam, and the AI-rewrite selection toolbar (which currently assumes a
   flat block list).
3. Editor UI: "Insert columns" (2 / 3), drop targets *within* a column, drag between columns.
4. Widget CSS: grid, and a mobile stack — columns must collapse to one column under ~640px.

**Exit:** a 2-column row with text one side and a dropped image the other, correct on the widget
and stacked on mobile.

### Phase 5 — "Ask my assistant to source / generate media"
*Largely reuse, once the seams above exist.*

1. **Pexels video is already built** — `PexelsVideoCandidate` + `PEXELS_VIDEO_SEARCH_URL`
   (`src/utils/pexels.ts:40-53`), and `pexels-search.ts:54` already accepts `mediaType: 'video'`.
   The blocker is coupling: `pexels-search.ts` attaches via `attachPexelsImageToPost(postId…)`
   (`scheduledPosts`-scoped), and `blog-media.ts:124` hardcodes `assetType: 'image'` in
   `createPexelsAsset`. **Decouple candidate-search from post-attachment**, then blog gets stock
   video nearly free.
2. `blog-media.ts` — accept a `pexelsCandidate` with `type=video`.
3. AI generation: `generate-ai-video.ts` + `process-media-job-background.ts` already exist and are
   async/job-based — the Studio needs a job-poll UI, not a new backend.
   ⚠️ `generate-ai-video` is one of the functions fixed by the *background trigger must be awaited*
   lesson — don't reintroduce an un-awaited dispatch.
4. Assistant-driven sourcing: `media-resolver.ts` / `media-sources.ts` (`manual → stock → ai`) is
   the existing priority matrix, but it is **`scheduledPosts`-scoped**. Blog needs its own entry
   point into the same resolver.

> ⚠️ **Two generation seams.** Social media flows through blueprint sections in
> `process-content-jobs.ts`; blog has its **own inline prompt** in `generate-blog.ts`. Anything
> that teaches the assistant about media placement must be injected in **both**, or blog silently
> won't learn it.

---

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| **Sanitiser widening → stored XSS on customer domains** | Narrow enumerated allowlist (§3.4); `div` gated by `allowedClasses`; hostile-input test lands with the change; run `/security-review` on Phase 1. |
| **Editor/server render divergence** (preview lies about published output) | One shared tokenizer artifact (§3.2), consumed by both. |
| **`renderAll()` wedges the editor** | Known trap; respect the existing guard; real mouse+keyboard verification in Phase 3. |
| **Nested blocks break AI-rewrite** | Phase 4 gated behind stable Phase 3; rewrite toolbar assumes flat blocks — needs explicit re-test. |
| **Directive syntax leaking as literal `:::` text** | If a draft's directives fail to parse they must render as *nothing* or a placeholder, never raw `:::media{…}` in a customer's published post. |
| **Presign TTL baked into snapshot** | The `asset://` invariant (§1) — never emit `src` into `published_payload`. |

## 6. Explicitly out of scope

- Migrating existing `![](asset://N)` images to `:::media` (§3.1).
- **Any** media in syndicated Dev.to / Hashnode posts — text-only by decision (§3.5).
- **Stock or AI-generated audio** — audio is upload-only by decision (Phase 2).
- Audio in the **feature** slot (hero stays image-only).
- Video/audio in **social** posts (`scheduled_posts`) — this epic is blog-only.
- Transcoding, captions/subtitles, or poster-frame extraction.
- A C2PA manifest for AI-generated video/audio (`src/config/compliance.ts:114` flags this as
  pending; it is a separate compliance thread).

## 7. Decisions taken

Resolved 2026-07-17, recorded here so the reasoning isn't re-litigated mid-build:

1. **Document model** → extend Markdown with `:::media` / `:::columns` directives (§3). Not a JSON
   block model (rewrite + migration), not raw HTML (stored-XSS surface on customer domains).
2. **Media types** → image, video and audio all droppable into the body.
3. **Syndication** → Dev.to / Hashnode get **text only**; media stays on our widget (§3.5).
4. **Audio** → **upload-only**. No stock provider, no AI generation (Phase 2).
5. **Sanitiser** → narrow enumerated allowlist, `div` gated by `allowedClasses`, hostile-input test
   in the same commit, `/security-review` on Phase 1 (§3.4).

## 8. Open questions

1. **Column layout in the widget theme** — do columns inherit the author's widget theme
   (`bs-save-theme`), or ship fixed neutral CSS? *Not blocking until Phase 4.*
