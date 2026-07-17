# Inspo Tab for Content Assistants — implementation plan

Status: **phases 1–2 built + applied to staging (2026-07-17), phases 3–5 pending**
Roles in scope: `social_media_manager`, `blog_writer`

A dedicated "Inspo" tab where the user parks inspiration material (links, files, images,
typed notes, voice notes) with a description of *what they like about it*, and the
assistant continuously applies those styles/tones to future drafts without re-prompting.

---

## 1. The governing constraint: prompt cost must not scale with library size

The naive build — append every Inspo item to the prompt — fails by design. Every blueprint
section is already dumped wholesale into the system prompt
(`netlify/functions/process-content-jobs.ts:226`), so making Inspo a blueprint section would
grow the prompt linearly with what the user uploads. By item ~50 you are paying for, and
diluting model attention across, 100k+ tokens of other people's blog posts on every draft.

**Inspo is therefore stored unbounded but consumed through two bounded channels.**

### Channel A — the distilled style profile (always on)

A background job reads the active Inspo items and distills them into a compact style
directive (~800–1500 tokens, hard-capped) — e.g. *"prefers short declarative openers,
sardonic register, no emoji, concrete numbers over adjectives."* This is injected on every
generation. Recompiled when the library changes, **not** per draft, so cost is amortised and
size is constant whether the user has 5 items or 500.

This is also simply better than raw stuffing: 40 examples of a tone teach the model less
than one accurate description of that tone.

### Channel B — top-K retrieval (relevance)

For a draft on a given topic, pull the 3–5 most semantically relevant Inspo chunks by
embedding similarity and include them as concrete exemplars. K is fixed → constant cost.

**Result: prompt cost is O(1) in library size.** Growth pressure moves to storage and
profile-recompile, both cheap and off the critical path.

### What this reuses (most of it already exists)

| Need | Already in repo |
| --- | --- |
| Chunking + Voyage embeddings + graceful no-key degradation | `src/utils/kb-embeddings.ts` (`chunkArticle`, `embedTexts`) — generic, no changes needed |
| pgvector schema, HNSW cosine index, tsvector fallback, GDPR vector map | `db/kb-articles.sql` — mirror it |
| Tenant-scoped CRUD + IDOR guard + ingestion pattern | `netlify/functions/kb-articles.ts` — mirror it |
| URL fetch + `cheerio` text extraction + PDF/text parsing | `netlify/functions/process-asset-background.ts` |
| Prompt-injection sanitiser for untrusted scraped content | `_stripPromptInjection()` in the same file |
| Pre-signed R2 upload + MIME allowlist + plan quota | `storage-request-upload.ts` / `storage-confirm-upload.ts` |
| Client-side voice transcription (Web Speech) | `src/components/voice-feedback.js:140` |
| Role-gated optional tab | `kbTab` in `src/components/assistant-dashboard-registry.js:338` |

---

## 2. Data model — `db/inspo-items.sql` (manual apply, idempotent)

Mirrors `db/kb-articles.sql` conventions verbatim (see `docs/db-migrations.md`; no
`drizzle-kit push`). Add matching exports to `db/schema.ts` next to `kbArticles`/`kbChunks`.

```
inspo_items
  id, organisation_id → organisations, ai_assistant_id → ai_assistants (both CASCADE)
  kind                'url' | 'file' | 'text' | 'voice'
  title               TEXT
  source_url          TEXT NULL                 -- AC2
  workspace_asset_id  → workspace_assets NULL   -- AC3, reuses R2 pipeline
  user_note           TEXT NULL                 -- AC2/AC3 "what I like about this"
  body                TEXT NULL                 -- extracted / transcribed text
  is_active           BOOLEAN DEFAULT true      -- AC6 deactivate (vs hard delete)
  ingest_status       'pending'|'ready'|'unsupported'|'failed'
  embedding_status    'pending'|'embedded'|'keyword_only'|'failed'
  chunk_count         INTEGER
  created_by, created_at, updated_at

inspo_chunks            -- exact mirror of kb_chunks
  ..., embedding vector(1024), content_tsv GENERATED, HNSW cosine index, GIN tsv index

inspo_style_profiles    -- Channel A cache, one row per assistant
  organisation_id, ai_assistant_id UNIQUE
  profile_text        TEXT                      -- the distilled directive
  source_item_ids     INTEGER[]                 -- exactly which items fed this (AC6 invalidation)
  item_fingerprint    TEXT                      -- hash(active ids + updated_at), mirrors the blueprint hash pattern
  token_estimate      INTEGER
  compiled_at         TIMESTAMP
```

Per US-GDPR-2.2.2, every embedded chunk gets a `vector_embeddings` map row
(`source_type = 'inspo_item'`) in the same transaction, so erasure jobs can find the vectors.

Caps, mirroring `kb-articles.ts`: `MAX_ITEMS` per assistant (~200), `MAX_NOTE_CHARS`,
`MAX_BODY_CHARS` (~50k).

---

## 3. Backend

| File | Role |
| --- | --- |
| `netlify/functions/inspo-items.ts` | CRUD. GET list / POST create / PUT (incl. `isActive` toggle) / DELETE. Mirrors `kb-articles.ts` incl. `requireTenant` + assistant ownership check. |
| `netlify/functions/process-inspo-background.ts` | Extract (URL / PDF / text / image) → sanitise → chunk → embed → mark ready → invalidate profile. Reuses the extraction logic in `process-asset-background.ts`. |
| `src/utils/inspo-profile.ts` | `compileStyleProfile()` (the distillation LLM call, capped), `getStyleProfile()` (fingerprint check → recompile if stale), `retrieveInspoChunks(query, k)`. |
| `src/utils/inspo-fetch.ts` | Hardened URL fetcher — scheme allowlist, private-IP/DNS-rebind rejection, size cap, timeout, redirect cap. See §7. |

**Trigger discipline:** the dispatch to `process-inspo-background` **must be awaited** —
un-awaited fetches to `-background` workers strand jobs `queued` forever because Lambda
freezes on return (see `memory: background-trigger-must-be-awaited`, fixed in `0cd64e7`).

---

## 4. Generation seams — there are two, and they are different

This is the main trap. Social and blog do **not** share a prompt path.

1. **Social** — `netlify/functions/process-content-jobs.ts:226`. System prompt is built by
   looping blueprint sections. Inject the profile + retrieved chunks here as an explicit
   block **after** the sections and **before** `AURA_SAFE_CONTENT_BENCHMARK`.
2. **Blog** — `netlify/functions/generate-blog.ts:93`. Builds its own inline prompt from
   `tone`; never touches the blueprint. Needs its own injection.

**Do not put Inspo in the blueprint.** Blueprint sections are compiled, hashed and cached;
Inspo changes on a different clock and would either bust the blueprint hash constantly or go
stale. Keep it as a separate runtime injection with its own cache.

Injected block is wrapped in an explicit data boundary (`INSPO CONTENT START/END`) so the
model treats it as data, not instructions — matching the existing RAG convention noted in
`process-asset-background.ts`.

---

## 5. Frontend

- `src/components/assistant-inspo.js` — new IIFE `window.*` module (vanilla, **not** React —
  see `memory: frontend-is-vanilla-not-react`). Model on the 317-line
  `assistant-knowledge-base.js`. Item cards + add-URL / upload / type / mic affordances;
  mic reuses `voice-feedback.js`'s Web Speech recogniser.
- `assistant-detail.html` — tab button + panel alongside the existing `maintab-btn-kb`.
- `assistant-dashboard-registry.js` — add an `inspoTab: { label, description }` config to
  `social_media_manager` and `blog_writer` only (AC1). Same optional-tab mechanism as `kbTab`.
- Rebuild `style.css` if new Tailwind classes are introduced.
- Watch `memory: hidden-class-loses-to-inline-flex` when toggling tab visibility.

---

## 6. Phasing

1. ✅ **Migration + schema exports** — `db/inspo-items.sql`, `db/schema.ts`.
   **Applied to STAGING 2026-07-17** and recorded in the `schema_migrations` ledger
   (`node scripts/db-migrate.mjs apply --only inspo-items --execute`). Verified: 3 tables,
   16 columns on `inspo_items`, HNSW + GIN indexes present.
   **⚠️ PROD still needs the same DDL before `inspo-items.ts` is deployed there.**
   Note `db:migrate:apply` with no `--only` would apply ALL pending files (8 others from
   unrelated in-flight work were pending at the time) — always scope it.
2. ✅ **CRUD + text/voice items** (AC4, AC6) — `inspo-items.ts` + the tab UI.
3. 🟡 **URL + file ingestion** (AC2, AC3) — **backend done, UI outstanding.**
   Done: `src/utils/safe-fetch.ts` (SSRF-hardened fetcher, `tests/safe-fetch.test.ts`, 24
   assertions), `src/utils/prompt-injection.ts` (extracted so both ingest paths share one
   sanitiser), `netlify/functions/process-inspo-background.ts`, and `inspo-items.ts` widened
   to accept `url`/`file` with an **awaited** worker trigger + an IDOR check on the supplied
   `workspaceAssetId`.
   **Outstanding: the add-URL / upload affordances in `assistant-inspo.js`.** The backend
   accepts these kinds but nothing in the UI can send them yet, so AC2/AC3 are not user-
   reachable. Deferred because a background task (shared Web Speech recogniser extraction) is
   concurrently editing that same file — sequence after it lands to avoid a collision.
   Also still needed: R2 upload wiring from the composer (reuse `storage-request-upload` →
   `storage-confirm-upload`, then POST the returned assetId as `workspaceAssetId`).
4. **Channel A + B + both seams** (AC5) — `inspo-profile.ts`, inject into
   `process-content-jobs.ts` and `generate-blog.ts`.
5. **Invalidation correctness** (AC6) — verify a deleted item cannot influence the next
   draft. The invalidation half is already written (`invalidateStyleProfile()` in
   inspo-items.ts fires on every mutation); this step is the compiler side + the test.

Steps 1–2 are independently shippable and prove the tab; step 4 is where the value lands.

### What shipped in phases 1–2

| File | Change |
| --- | --- |
| `db/inspo-items.sql` | new — 3 tables, pgvector + tsvector, mirrors kb-articles.sql |
| `db/schema.ts` | new exports `inspoItems`, `inspoChunks`, `inspoStyleProfiles` |
| `netlify/functions/inspo-items.ts` | new — CRUD + chunk/embed ingestion + profile invalidation |
| `src/components/assistant-inspo.js` | new — tab UI, composer, dictation, item cards |
| `src/components/assistant-dashboard-registry.js` | `inspoTab` config on the two content roles |
| `assistant-detail.html` | `#maintab-btn-inspo` button + `#maintab-inspo` panel |
| `workspace.html` | loads `assistant-inspo.js` |
| `assistants.js` | `_applyDashboardRegistry` gates + inits the tab |

Verified against a stubbed API in a component harness (the repo's existing pattern): list
renders, add saves with an auto-derived title, pause sends `PUT {isActive:false}`, delete
two-step-confirms then removes, edit round-trips the full body, and a script/img payload in
the title+note renders as inert text (no XSS).

**Deviation from the plan above:** §5 said the mic would "reuse voice-feedback.js's Web
Speech recogniser". On inspection that component is a class welded to its own `#vf-*` markup
(`this.container.querySelector('#vf-mic-btn')`), so it can't be called from another tab
without refactoring it. `assistant-inspo.js` therefore carries its own ~40-line recogniser.
If a third caller appears, extract a shared util rather than copy it again.

---

## 7. Open risks and decisions

**AC6 is the subtle one.** "Immediately stop considering" is trivial for Channel B (filter
`is_active`). But Channel A is a *cache* — a deleted item's influence survives inside
`profile_text` until recompile. If someone deletes an item because it was off-brand or
legally risky, "it washes out in a few minutes" is not acceptable. So: deletion/deactivation
invalidates the profile **synchronously**, and generation falls back to retrieval-only rather
than use a profile whose `source_item_ids` contains a removed item.

**AC3's "strictly used for stylistic learning, not copy-pasted" is not enforceable by a tag.**
It's prompt pressure, not a guarantee — and Inspo is by definition other people's
copyrighted work, so the failure mode is republishing a competitor's sentences into a
customer's post. Channel A helps structurally (it carries a *description* of style, never
source text). **Recommendation:** if Channel B ships, add an n-gram overlap check between the
draft and its source chunks before the draft reaches the Review Queue.

**Applied defaults** (raised previously, not yet ruled on — currently assumed):
- *Google Doc links* → **rejected** at add-time with "download and upload it instead". A Doc
  URL is a login wall, not a document; fetching it silently ingests a sign-in page as garbage.
  Real support needs Drive OAuth, which is well beyond this story.
- *`.mp4`* → stored, **user's note is the only signal**, no content extraction. Nothing in the
  stack sees video. Scope this explicitly rather than implying the assistant studies it.
- *Images* → Claude vision can describe them at ingestion; the description becomes `body`.

**~~Pre-existing security gap this story widens.~~ FIXED (phase 3).**
`process-asset-background.ts` fetched user-supplied URLs with no SSRF guard — no scheme
allowlist, no private-IP rejection, no size cap — meaning a user could aim the Lambda at
`169.254.169.254` and read IAM credentials. Now closed: both that path and the new Inspo path
go through `src/utils/safe-fetch.ts` (named generically, not `inspo-fetch.ts`, precisely so
the existing path could adopt it).

Its guarantees, in the order they matter: connections are **pinned** to pre-validated public
addresses via the `lookup` hook on `node:http`, which is what actually closes the DNS-rebind
TOCTOU window (validate-then-`fetch()` does not — the attacker's resolver just answers twice).
Every redirect hop is re-validated (a public URL 302-ing to the metadata IP is the textbook
bypass). IPv4-mapped and NAT64-embedded v6 forms are unwrapped before classification, so
`::ffff:169.254.169.254` can't smuggle through. Plus scheme allowlist, embedded-credential
rejection, streamed byte cap, and a whole-chain timeout.

`tests/safe-fetch.test.ts` covers classification + URL validation exhaustively. It does NOT
cover the redirect chain, byte cap or timeout: exercising those needs a reachable endpoint on
a **public** address, and any server the test could bind (127.0.0.1) is one the guard must
refuse. Deliberately not papered over with a test-only bypass — a backdoor through the check
would be a worse defect than the coverage gap.
