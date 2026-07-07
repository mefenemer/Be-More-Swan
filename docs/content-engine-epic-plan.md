# Autonomous Content Engine & Publishing Assistant — Plan & Assessment

Status: **Phases 0–3 built** (blog model, editor, widget, publish, scheduling, A/B beacon, blog-as-assistant).
**Both gating product decisions resolved (§7).** Remaining: connector layer (§4), GSC decay (US 5.1),
C2PA image signing (US 6.1). Last updated 2026-07-07.

Maps the "Autonomous Content Engine & Publishing Assistant" epic onto the existing BMS
(`aura`) codebase, records verified external-connector findings, and proposes a phased build order.

---

## 1. Bottom line

The current platform is a **social-media content engine** (Facebook/Instagram, short captions +
media). The epic is a **long-form blog engine** (Markdown, Substack/Medium/native widget).

~60% of the *infrastructure* the epic needs already exists and is reusable: AI generation, media
pipeline, Pexels sourcing, scheduling, HITL approval, C2PA provenance, AI credits, audit logs.
Net-new work concentrates in three areas: a **Markdown/blog content type**, the **native
embeddable widget** (greenfield), and the **blog-platform connectors**. Substack/Medium were
dropped (no official long-form-push API); the connector set is now **WordPress, Ghost, Hashnode,
Dev.to** — all of which expose an official long-form write API (see §4).

## 2. Already exists and directly reusable

| Epic need | In repo |
|---|---|
| AI text generation | `generate-post.ts`, `ai_blueprints`, `assemble-blueprint.ts`, `content_generation_jobs`, `process-content-jobs.ts` |
| AI image / video gen | `generate-ai-image.ts`, `generate-ai-video.ts`, `media_generation_jobs`, `regenerate-post-media.ts` |
| Stock imagery (US 2.1 AC2) | Full Pexels integration — `pexels-search.ts`, `src/utils/pexels.ts`, `pexels_search_cache` |
| Media compress/resize/attach (AC4) | `process-media-job-background.ts`, `content_assets`, `scheduled_post_assets`, R2 upload |
| Scheduling / calendar / cadence (US 4.1) | `scheduled_posts`, `posting-schedule.sql`, `draft-horizon-fill.ts`, `calendar.js` (drag-drop) |
| HITL approval (draft/approve/reject) | `approve-post.ts`, `reject-post.ts`, `pending_actions`, `review-queue.html`, `quality-review.ts` |
| C2PA provenance (US 6.1 AC1) | `content_provenance` (has `c2paSchemaVersion`, model hash, HITL flag), `content-provenance.ts` |
| AI disclosure/badging (US 6.1 AC2) | `workspace-ai-disclosure.ts`, `eu-disclosure-backfill.sql` |
| Immutable audit log (US 6.1 AC3) | `audit_logs`, `audit-log-immutability.sql`, `agent_run_events` |
| Autonomous optimization loop (US 5.x) | `autonomous-goal-optimizer.ts`, `goal_telemetry`, `post_insights` |
| OAuth connector framework (US 3.2) | `workspace_integrations`, `oauth-integrations.ts`, `authorize-integration.ts`, `vault_secrets`, `src/utils/connection-map.ts` (defines `cms` + `search_console` capability categories + `seo_content_strategist` role) |

**US 6.1 (Compliance/Provenance) is ~80% already built** — cheapest feature to close out.

## 3. Gap analysis — net-new work

| US | Status | Net-new |
|---|---|---|
| 1.1 Brief + 3 paths | Partial (social only) | Blog content type; "Improve Draft"/tracked-changes mode |
| 1.2 Markdown editor + sectional rewrite | Net-new | Markdown viewer, highlight→contextual AI menu, span-scoped rewrite endpoint (vanilla JS) |
| 1.3 SEO metadata | Net-new (`urlSlug`/`metaDescription` = 0 hits) | JSON extraction endpoint + storage columns |
| 2.1 Media | Mostly done | Only "AI Generate custom feature graphic" prompt UI wiring is thin |
| 3.1 Native widget + theming | **Net-new (greenfield, largest)** | Public JSON API, per-workspace `<script>` embed, client widget bundle, theming panel, published-payload store |
| 3.2 Blog connectors (WordPress/Ghost/Hashnode/Dev.to) | Net-new | `BlogDestination` adapter + per-platform adapters + RSS. See §4 |
| 4.1 Queue/cadence | Mostly done | Extend calendar/queue to blog posts |
| 5.1 Content decay | Net-new | Google Search Console OAuth + ingestion; decay threshold → "Update Ticket" (reuse `pending_actions`) |
| 5.2 A/B hook testing | Net-new | Variant storage, widget-side random serving, scroll/time tracking, auto-promote logic |

## 4. External connectors — DECIDED (verified 2026-07-07)

**Substack/Medium DROPPED** (neither offers an official long-form-push API for a new SaaS — Substack's
only write scope is `notes.write`; Medium's API has been closed to new integrations since 1 Jan 2025).
Replaced with four platforms that each expose an **official long-form write API**. **Beehiiv was
evaluated and dropped** — it's a newsletter tool where "publish" emails the subscriber list, not a
blog destination.

| Connector | Official write? | Auth | Body format | Tier |
|---|---|---|---|---|
| Google Search Console (US 5.1) | n/a (read) | OAuth2 + refresh, PKCE S256 | — | **Decay ingest** |
| WordPress (self-hosted) | ✅ `POST /wp/v2/posts` | Application Password (HTTP Basic) + site URL | HTML | **1** (no OAuth) |
| Ghost | ✅ `POST /admin/posts/` | Admin API key `id:secret` → JWT + site URL (paste) | HTML / Lexical | **1** (no OAuth) |
| Hashnode | ✅ `publishPost` GraphQL mutation | Personal Access Token (raw `Authorization`, not Bearer) | **Markdown** (`contentMarkdown`) | **1** (no OAuth) |
| Dev.to (Forem) | ✅ `POST /articles` (v1) | `api-key` header | **Markdown** (`body_markdown`) | **1** (no OAuth) |
| WordPress.com | ✅ `POST /wp/v2/posts` | OAuth2 | HTML | **2** (OAuth) |

### Evidence
- **WordPress** — REST API `POST /wp/v2/posts` (content = HTML). Self-hosted authenticates via Application
  Passwords (HTTP Basic, WP ≥5.6, the recommended machine-to-machine path); WordPress.com uses OAuth2.
- **Ghost** — Admin API `POST /admin/posts/`; auth is a JWT signed from a Custom Integration's Admin API
  key (`id:secret`), sent in the `Authorization` header. Accepts HTML (`?source=html`) or Lexical.
- **Hashnode** — GraphQL `https://gql.hashnode.com`, `publishPost(input: PublishPostInput!)` mutation with
  `contentMarkdown`; auth = Personal Access Token as the raw `Authorization` header (NOT `Bearer`). Markdown-native.
- **Dev.to** — Forem API v1 `POST /articles`; `body_markdown`; `api-key` header + `Accept: application/vnd.forem.api-v1+json`. Markdown-native.
- **GSC** — Google standard OAuth2; `searchconsole.googleapis.com` live (`401 Bearer`); discovery doc scopes
  `webmasters` / `webmasters.readonly`, resources incl. `searchanalytics` (clicks/impressions/CTR/position).
  Overhead: Google OAuth app verification for the sensitive scope (timeline, not a blocker).

### Consequence / approach
- The **Native BMS Widget (US 3.1)** stays the core, fully-controlled distribution primitive; **RSS** off
  the published payload is the universal fallback for anything off this list.
- The four blog connectors are real long-form pushes (unlike the abandoned Substack/Medium). Both content
  representations already exist: `body_markdown` → Hashnode/Dev.to unchanged; sanitized `published_payload`
  HTML → WordPress/Ghost. **No new rendering work.**
- One `BlogDestination` adapter interface (`publish(payload) → { externalId, url, status }`) with one adapter
  per platform, dispatched off `blog_posts.destinations jsonb` (§9). Build Tier 1 (paste-token: WordPress
  self-hosted, Ghost, Hashnode, Dev.to) first; Tier 2 = WordPress.com OAuth (reuses `oauth-integrations.ts`).

## 5. Other risks / feasibility flags
1. **A/B testing (US 5.2) vs. static payload (US 3.1 AC3)** — randomized variant serving + beacons
   conflicts with a cacheable static JSON payload. Decide dynamic vs. static widget up front.
2. **C2PA on images (US 6.1 AC1)** — DB tracks C2PA fields, but actually *signing image bytes* needs a
   signing lib + cert; bigger than the text case (already handled).
3. **Content-type collision** — `scheduled_posts` is social-shaped (`platform`, `caption`, `hashtags`).
   Blogs need `body_markdown`, `meta_*`, `slug`, multi-destination. Recommend a **new `blog_posts`
   table** sharing assets/provenance/scheduling, rather than overloading the social model.

## 6. Recommended phased build order
- **Phase 0 — Foundation:** blog content type/table, extend brief+blueprint for long-form, Markdown storage. *(unblocks everything)*
- **Phase 1 — Authoring (F1):** Markdown editor, sectional rewrite (1.2), SEO metadata (1.3). Media (F2) mostly reuse.
- **Phase 2 — Native widget (F3.1) + compliance (F6):** public JSON API, embed script, theming, transparency badge, RSS output. F6 nearly free here.
- **Phase 3 — Scheduling (F4):** extend calendar/queue to blogs. Low effort.
- **Phase 4 — Connectors:** GSC (for Phase 5); blog push via `BlogDestination` adapters — Tier 1 paste-token
  (WordPress self-hosted, Ghost, Hashnode, Dev.to) then Tier 2 WordPress.com OAuth; RSS fallback.
- **Phase 5 — Autonomy (F5):** GSC ingestion + decay tickets, then widget A/B testing (depends on Phase 2).

## 7. Open product decisions
1. Substack/Medium long-form — **RESOLVED (2026-07-07): DROP both** (no official long-form-push API).
   Native Widget + RSS is the core primitive; connector set = **WordPress, Ghost, Hashnode, Dev.to**
   (all have official long-form write APIs). Beehiiv evaluated and dropped (newsletter, not a blog). See §4.
2. New `blog_posts` table vs. extend `scheduled_posts`? — **RESOLVED: new table.** See §9.
3. Widget rendering — static published JSON (cacheable) vs. dynamic (needed for A/B)? — **RESOLVED: static snapshot + client-side variant pick.** See §8.
4. Decay analytics source — **RESOLVED (2026-07-07): GSC only for v1.** GA4 is a possible additive
   fast-follow; keep the decay detector reading `traffic_baseline`/`last_metrics_at` generically so a
   GA4 ingester can write the same columns later.

---

## 8. US 3.1 — Native Widget technical design

**Architecture:** a static `widget.js` loader (vanilla IIFE, per the "frontend is vanilla" rule)
mounts into a **Shadow DOM** on the customer's site and fetches an **immutable published JSON
snapshot** from a public, CORS-open BMS API keyed by an unguessable **workspace public key**.

### Data model (net-new)
- `blog_posts` (§9) gains `published_payload jsonb` — a rendered, sanitized HTML + meta snapshot
  taken at publish time, so the public API serves a static immutable version, never live-renders per hit.
- `widget_configs` (new, per workspace): `public_key text unique` (`wgt_<nanoid>`, rotatable),
  `theme jsonb` (accent hex, font, layout, custom CSS, badge on/off), `allowed_origins text[]`,
  `organisation_id`. Dedicated table (not columns on `organisations`) so a workspace can host
  multiple embeds/sites later.
- Reuse `content_provenance` + `organisations.aiDisclosureFooterEnabled`/`aiDisclosureFooterText`
  (`db/schema.ts:34-35`) for the transparency badge — US 6.1 AC2 nearly free.

### Public API — one router function, no auth (AC3)
Model on `platform-config-public.ts` (no auth, `Cache-Control`, fail-open) and the
`oauth-integrations.ts` rawUrl router. Add ONE function `widget-api.ts` behind a rewrite mirroring
the existing `/api/oauth/*` rule in `netlify.toml`:
```
/api/widget/*  →  /.netlify/functions/widget-api   (status 200 rewrite)
```
Resources parsed from `:publicKey/:resource`:
- `GET /api/widget/:key/config` → theme tokens
- `GET /api/widget/:key/posts` → published list (paginated, cacheable)
- `GET /api/widget/:key/posts/:slug` → full snapshot payload + `aiAssisted` + hook variants
- `GET /api/widget/:key/media/:token` → **302 to presigned R2 / Pexels CDN**, reusing the
  `media-proxy.ts` mechanism (`resolvePostImage`, redirect-not-stream to dodge Netlify's payload
  limit). Keeps R2 private; public token, not internal asset id (no enumeration).

### Embed snippet (AC1)
```html
<script async src="https://bemoreswan.com/widget.js"
        data-bms-key="wgt_ab12…" data-bms-mount="#bms-blog"></script>
```
`widget.js` (repo root, cache-busted `?v=` like other static JS): reads `data-bms-key`, fetches
`/config` + `/posts`, creates a **Shadow DOM** root (isolates styles both ways — the single most
important decision), applies `theme` as CSS custom properties + scoped `customCss`, runs a hash
router for list ↔ detail, renders the AI Transparency Badge when `aiDisclosureFooterEnabled`.

### Theming Panel (AC2) — dashboard
Authed section (vanilla, matches `dashboard-content.html`) writing via `save-widget-config.ts`
(JWT-cookie auth). Fields: accent hex, font, layout, custom CSS, badge toggle; shows the copy-paste
snippet + live preview iframe. Mind the emerald→pink token remap in `input.css` when defaulting accent.

### Two decisions this forces
1. **Immutable snapshot + client-side A/B** resolves the static-vs-dynamic tension: one cached
   payload carries all 3 hook variants; `widget.js` picks one client-side and POSTs engagement to a
   small uncached beacon. Payload stays CDN-cacheable (`public, max-age, s-maxage` + ETag).
2. **Server-side markdown→sanitized HTML at publish time** (sanitize-html/DOMPurify in a
   `src/utils` helper) — security-critical: output renders on third-party domains, so a stored-XSS
   here hits customers' sites. Sanitize once at publish; store safe HTML in `published_payload`.

### Security posture
- Public key unguessable + rotatable; never expose internal org id/slug in payloads.
- Public API returns only `published` rows for the key's org — same tenant-isolation discipline as
  `tests/tenant-guard.test.ts`.
- CORS `Access-Control-Allow-Origin: *` (read-only), or echo `allowed_origins` if the customer locks it.
- Rate-limit `widget-api` via the existing edge `rate-limit` function (`netlify.toml` path).

### Net-new files
DB `db/blog-posts.sql`, `db/widget-configs.sql` + `db/schema.ts` tables · Functions `widget-api.ts`
(public), `save-widget-config.ts` (authed), `publish-blog.ts` · Static `widget.js`,
`widget-preview.html` · Util `src/utils/markdown-render.ts` · `netlify.toml` rewrite + edge rate-limit
· Dashboard theming panel + snippet UI.

### Sub-order
1. `blog_posts` + publish snapshot → 2. `widget-api` read + media → 3. `widget.js` + Shadow DOM →
4. `widget_configs` + theming panel → 5. badge/provenance wiring.

---

## 9. Phase 0 — `blog_posts` content model

**Decision: new `blog_posts` table** (not extending `scheduled_posts`). `scheduled_posts` carries
~40 columns of social-specific machinery (`platform`, `caption`, `hashtags`, `mentions`,
`postFormat`, missed/red-alert, revised-from chains). Overloading it makes both models murky.
Instead, a clean `blog_posts` table that **reuses the shared workflow primitives**.

### Reuse (do NOT rebuild)
- `content_assets` (generic image/video/link, R2 + Pexels + attribution) via a new
  `blog_post_assets` junction mirroring `scheduled_post_assets` (`scheduledPostId,contentAssetId,position`).
- `content_provenance` via a `provenance_content_id` FK (same pattern as
  `scheduledPosts.provenanceContentId`, `db/schema.ts:1492`).
- `content_generation_jobs` (`job_id`) + `ai_blueprints` (`blueprint_id`) for AI generation linkage.
- `pending_actions` for the HITL approval workflow; `audit_logs` for the human-vs-AI edit log (US 6.1 AC3).
- Confidence/factual-claim governance fields, mirrored from `scheduled_posts` (US-GOV-2.2.1).

### `blog_posts` columns (net-new)
- Identity/tenancy: `id`, `organisation_id`, `user_id`, `assistant_id`, `owner_id`/`owner_label`.
- Body: `title`, `body_markdown` (source of truth), `published_payload jsonb` (sanitized HTML snapshot).
- SEO (US 1.3): `slug` (unique per org), `meta_title`, `meta_description`, `tags jsonb`, `canonical_url`.
- Hero: `feature_asset_id` (→ `content_assets`).
- A/B (US 5.2): `hook_variants jsonb` (up to 3 H1/intro variants), `winning_variant`.
- Workflow: `status` (`draft|pending_approval|in_review|approved|scheduled|publishing|published|paused|failed|rejected|archived`),
  `publish_date`, `published_at`, `is_autonomous`, `generation_reason`.
- Governance: `provenance_content_id`, `confidence_score`, `factual_claims jsonb`, `job_id`, `blueprint_id`.
- Distribution mirror: `destinations jsonb` (per-target status for widget / substack / medium / rss).
- Decay (US 5.1): `last_metrics_at`, `traffic_baseline` — feeds the Update-Ticket detector.

### Reused workflow
Draft → HITL approve (`approve-post` pattern → `publish-blog.ts`) → snapshot render+sanitize into
`published_payload` + stamp `content_provenance.publishedAt` → widget/API serves the snapshot.
Scheduling (F4) reuses `publish_date` + the existing calendar/queue; the publish cron mirrors
`publish-cron-log`.

---

## 10. US 1.2 — Markdown editor + sectional rewrite

**Core model: block-segmented rendered viewer.** Parse `body_markdown` into an ordered list of
**blocks** (heading / paragraph / list / quote / code). Each block keeps `{ id, raw, html }`; the raw
blocks are the single source of truth, `getMarkdown()` = `blocks.map(b => b.raw).join('\n\n')`.
This makes "replace only the selection" (AC3) tractable — the alternative (mapping a selection in one
big rendered HTML blob back to source offsets) is fragile across inline syntax.

### Rendering (AC1) — reuse, don't add deps
Render each block with **marked + DOMPurify**, the exact pattern `chat-session.js` / `workspace.html`
already use (CDN-loaded, minimal escape-first fallback). No new npm dependency. Server-side publish
sanitisation shares `src/utils/markdown-render.ts` (§8).

### Component
`src/components/markdown-editor.js` — IIFE matching the `window.Xxx.mount({...})` convention:
```
const ed = window.MarkdownEditor.mount({ container, initialMarkdown, blogPostId, onChange });
ed.getMarkdown(); ed.setMarkdown(md); ed.destroy();
```

### Selection → contextual menu (AC2)
- On `mouseup`/`selectionchange` inside the preview, compute the Range; if non-empty **and within a
  single block**, resolve it to `{ blockId, rawStart, rawEnd, selectedText }`. **Offsets must map to
  the block's RAW markdown, not rendered text** — build a rendered-text→raw-offset index at render
  time so bold/link syntax isn't corrupted. Multi-block selection: clamp/disable in v1.
- Floating toolbar at the selection rect: **Expand · Condense · Change Tone ▾ · Rewrite…**
  (Change Tone submenu = Professional/Casual/Confident/Friendly, matching the US 1.1 Tone input;
  Rewrite… = free-text instruction).

### Rewrite endpoint (AC3) — one-shot, buffered (NOT streaming)
New authed function `netlify/functions/rewrite-section.ts`:
```
POST { blogPostId, action:'expand'|'condense'|'tone'|'custom', tone?, instruction?,
       selectedText, blockContext, docContext }  →  { rewrittenText }
```
- JWT-cookie auth + verify `blogPostId` belongs to caller's org (tenant-guard discipline).
- Anthropic SDK `messages.create`, **buffered** (Netlify buffers responses — show a skeleton in the
  toolbar like `chat-session.js`). Mirror the generation pattern in `process-content-jobs.ts`.
- Prompt: "Rewrite ONLY the selected text to {action}. Preserve Markdown syntax. Return only the
  replacement — no preamble/fences." Pass block + doc context for coherence; validate the response is
  a fragment (strip stray fences/prose).
- Meter as an AI action via `ai_credit_ledger` (same check as `generate-post`).

### Apply + tracked changes (AC3, also serves US 1.1 tracked-changes path)
- On response, show a **word-level diff** (old vs new) inline with **Accept / Reject** before commit.
  Accept → splice `rewrittenText` into `blocks[blockId].raw[rawStart..rawEnd]`, re-render only that
  block, re-join. **Rest of the document is untouched** — the payoff of the block model. Reject → discard.
- One mechanism satisfies both US 1.2 AC3 and US 1.1 AC2 ("AI revision mode / tracked changes").
- `onChange` → debounced autosave of `body_markdown` (authed `save-blog-draft.ts`). Lock a block
  while its rewrite is in flight to avoid autosave/rewrite races.

### Provenance (US 6.1 AC3, near-free here)
Each accepted rewrite appends `{ blockId, before, after, actor:'ai', action, at }` to the edit log
(`audit_logs` rows); manual keystroke edits log `actor:'human'`. That IS the immutable human-vs-AI
edit trail Feature 6 asks for.

### Net-new files
`src/components/markdown-editor.js` · `netlify/functions/rewrite-section.ts` (authed, one-shot) ·
`netlify/functions/save-blog-draft.ts` (autosave) · reuse marked+DOMPurify (workspace.html loader),
`src/utils/markdown-render.ts`, `ai_credit_ledger`, `audit_logs` · editor host page wiring.

### Risks
- Rendered-text↔raw-offset mapping across inline syntax (the crux — get the index right or replaces corrupt syntax).
- Multi-block selection (v1: disable; v2: iterate blocks).
- Model returning extra prose/fences (validate/strip).
- Buffered latency on long "Expand" (skeleton + timeout, matches chat pattern).

---

## 11. US 5.2 — Dynamic A/B hook testing (widget only)

Interacts directly with the §8 caching model — the design keeps the published payload **fully
CDN-cacheable** and does variant selection client-side, so there is no per-request server work.

### Generate variants (AC1)
At draft time, produce 3 hook variants (`{ id:'A'|'B'|'C', h1, intro }`) via a `generate-hooks`
action (one-shot Anthropic, same pattern as `generate-post`), stored in `blog_posts.hook_variants
jsonb`. `winning_variant text` stays null until decided.

### Serve (AC2)
The cached payload carries all 3 variants + `ab_state:'testing'|'decided'` + `winner`. `widget.js`:
- if `decided` → always render `winner`;
- else → pick a variant client-side, **sticky per visitor via localStorage** (a returning visitor
  sees the same one → cleaner signal), and swap its `h1`/`intro` in for the default.
Payload stays immutable/cacheable — resolves the static-vs-dynamic tension from §5.1 / §8.

### Track (AC3)
`widget.js` measures **dwell** (timer + `visibilitychange`) and **max scroll depth**, then on unload
`navigator.sendBeacon`s a compact anonymous event to a new **uncached** public function
`widget-ab-beacon.ts`: `{ publicKey, slug, variantId, dwellMs, scrollPct, engaged }`. To avoid
unbounded rows, beacons **upsert aggregate counters** in `blog_ab_stats`
(`blog_post_id, variant_id → impressions, sum_dwell_ms, sum_scroll_pct, engaged_count`). No cookies,
no PII — fits the EU posture (§6.1).

### Decide (AC3)
Scheduled `resolve-ab-tests.ts` (cron via `netlify.toml [functions.*] schedule`, like
`bias-sampling`): for `testing` posts with total impressions ≥ threshold, score variants
(weighted dwell + scroll + engaged-rate), set `winning_variant` + `ab_state='decided'`, flip the flag
the widget reads, and log to `audit_logs`. Threshold in `platform_config` or per-widget.
**v1 caveat:** use a min-sample + max-score rule; proper statistical significance (two-proportion
z-test on engaged-rate) is a fast-follow, not v1.

### Net-new files
`blog_ab_stats` table · `widget-ab-beacon.ts` (public, uncached) · `resolve-ab-tests.ts` (cron) ·
`generate-hooks` action · `widget.js` variant logic · `netlify.toml` cron + rate-limit + beacon route.

---

## 12. Completion roundup — reuse-heavy stories (low novelty)

| US | Approach (mostly reuse) | Net-new | Blocked on |
|---|---|---|---|
| 1.1 Brief + 3 paths | `ai_blueprints` + `assemble-blueprint` + `generate-post`; "Improve Draft" seeds the §10 editor with tracked-changes; Rough-Notes textarea → blueprint context | Blog brief form + 3-path router UI | — |
| 1.3 SEO metadata | one-shot Anthropic → structured JSON | `generate-seo.ts` (metaTitle/metaDescription/urlSlug/tags), slug-uniqueness/org, store on `blog_posts`; trigger on approval | — |
| 2.1 Media | Pexels (`pexels-search`), `generate-ai-image`, upload, `process-media-job-background` all exist | Wire editor drag-drop + "AI Source"/"AI Generate" buttons to existing endpoints; attach via `blog_post_assets` | — |
| 3.2 Blog connectors | `oauth-integrations` + `workspace_integrations` + `vault_secrets` for creds; `widget-rss.ts` off published payload; existing `body_markdown` + sanitized `published_payload` HTML feed the adapters | `BlogDestination` iface + 4 adapters (WordPress/Ghost/Hashnode/Dev.to), WordPress.com OAuth, RSS feed | — (§7 #1 resolved) |
| 4.1 Queue/cadence | `calendar.js` UI + publish cron already do Fill-Queue/drag-drop for social | Point the same UI + cron at `blog_posts` (`publish_date`) | — |
| 5.1 Content decay | GSC connector (§4) + `pending_actions` for the Update Ticket + `rewrite`/`generate` for the revision | `ingest-gsc-metrics.ts` (cron) → `traffic_baseline`; threshold → AI-drafted revision needing approval | — (§7 #4 resolved: GSC only) |
| 6.1 Compliance | ~80% exists: `content_provenance`, AI disclosure, `audit_logs` | **C2PA image signing** (needs signing lib + cert — the one heavier item), widget badge (§8), edit-log (§10) | — |

**Design track complete.** Greenfield critical path (§8 widget, §9 blog model, §10 editor, §11 A/B)
and connector layer (§4) are specified; everything else is reuse or gated on the two §7 product calls.
