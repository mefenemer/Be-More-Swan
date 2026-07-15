# Canva Connector — Implementation Plan

Epic: Canva Integration for BMS Content Library (US1–US4).

> **US4 superseded 2026-07-15.** The AI-assistant half now goes via Canva's remote MCP server
> rather than the media resolver described in §5 — see [canva-mcp-architecture.md](./canva-mcp-architecture.md).
> US1–US3 (connector, browse, import over Connect REST) are unchanged and still correct.
> §5 below remains relevant only if assistants also need to *use imported assets* from the
> Content Library; the resolver's `provider IS NULL` bug (§5.1) still applies to that path.

This plan is written against the actual codebase, which differs from the brief in several
load-bearing ways. Read section 0 before costing anything.

---

## 0. Corrections to the brief

The brief was written for a generic React/Next.js SaaS. Five of its assumptions are wrong here,
and two of them change the shape of the epic.

**0.1 — There is no React. Deliverable 2 of the brief does not apply.**
The frontend is vanilla: static HTML pages at the repo root (`integrations.html`, `my-content.html`)
with sibling IIFE modules (`integrations.js` is 1335 lines, `my-content.js` is 1051) that hang
themselves off `window.*`. There is no JSX, no bundler, no component tree. `src/components/`
holds shared IIFE modules, not React components. Tailwind is compiled ahead of time into
`style.css`, so any new utility class needs a CSS rebuild or it silently does nothing.
`CanvaAssetBrowser` should be built as `window.CanvaBrowser`, an IIFE in `src/components/`,
following the existing modal patterns. Everything the brief says about *look and feel* still
applies; everything it says about *component architecture* should be discarded.

**0.2 — Canva is a source connector, not a "recipe". US1's framing is misleading.**
The Integration Scenario Library (`integration-scenarios.ts`, `db/integration-scenarios.sql`) is a
Zapier-style engine for *outbound* triggers fired at record-approval seams. Canva is an *inbound*
asset source and has no trigger seam. It belongs with the OAuth connectors on `integrations.html`,
alongside HubSpot/Notion/Gmail — not in the scenario engine. The existing rule against inventing
fake recipes for things that aren't scenarios applies directly. Build the connector card;
do not add a Canva scenario row.

**0.3 — The Content Library is `content_assets`, not `workspace_assets`.**
Both tables exist and the names invite the wrong choice. `workspace_assets` is the RAG/knowledge-base
and file store. `content_assets` (`db/schema.ts:1511`) is the media library the Social Media Manager
and Blog Writer actually draw from. Canva assets go in `content_assets`.

**0.4 — Good news: the `provider` column already exists, so US4 AC1 is nearly free.**
`content_assets.provider` is already `'pexels' | 'fal' | null`, with `providerAssetId`,
`attributionName`, `attributionUrl` alongside it. Canva imports become `provider='canva'`,
`providerAssetId=<canva design id>`. The Canva badge and the "Source: Canva" filter fall out of a
column that is already there and already indexed by org.

**0.5 — The two genuinely hard parts are not the ones the brief emphasises.**
The brief treats OAuth and the browse grid as the main event. They are the easy parts: the OAuth
router is uniform and adding a provider is largely mechanical, and the grid is a modal. The real
work is in US4, and it is buried:

- `pickManualAsset()` in `src/utils/media-resolver.ts:73` filters on **`provider IS NULL`**.
  As written, every Canva import is *invisible* to the autopilot. US4 AC2 fails silently — assets
  import fine, look right in the library, and are never picked. This is a one-line filter change
  but it must be a deliberate one (see 5.1).
- That same function picks **oldest-unused-first (LRU)**. There is no topical matching of any kind.
  US4 AC2 says the assistant should "contextually recommend assets that match the post's topic or
  tags" — that capability *does not exist today for any manual asset*. It is new work, and it is the
  single largest item in this epic. See 5.2.
- `content_assets` has **no tags column**. US3 AC5 (tag on import) and US4 AC4 (filter by tag)
  both need new schema. See 3.2.

---

## 1. Architecture & API flow

### 1.1 OAuth — slots into the existing router, with one new capability

`netlify/functions/oauth-integrations.ts` is a universal OAuth 2.0 router already serving 16
providers behind `netlify.toml` rewrites:

```
GET  /api/oauth/canva/connect     → 302 to Canva's authorize URL
GET  /api/oauth/canva/callback    → code→token exchange, saveIntegration, → integrations.html
GET  /api/oauth/status            → per-provider connection state
POST /api/oauth/canva/disconnect  → delete row + vault secret
```

Adding Canva touches five places, all following existing precedent:

1. `src/utils/workspace-integrations.ts:23,25` — add `'canva'` to the `IntegrationProvider` union
   and the `INTEGRATION_PROVIDERS` array.
2. `oauth-integrations.ts` `SCOPES` — the scope string (1.2).
3. `oauth-integrations.ts` — an `authUrl` branch.
4. `oauth-integrations.ts` — a token-exchange branch (Basic auth, like Xero/Notion/QuickBooks).
5. `workspace-integrations.ts` `refreshProviderToken()` — a refresh branch (1.3).

**The one new thing: PKCE.** Canva mandates OAuth 2.0 Authorization Code + PKCE with `S256`
(verified against Canva's authentication docs). No existing provider in this router uses PKCE, so
this is the first. It fits the existing security model cleanly rather than fighting it:

The router already holds the CSRF token and `organisationId` **server-side in the vault** under a
10-minute TTL, with the client-visible `state` carrying only routing info (this is exactly how the
Zendesk subdomain and the QuickBooks realmId ride along). The PKCE `code_verifier` goes in that
same vault entry. It must never touch the `state` param or the client.

```
connect:
  verifier  = base64url(randomBytes(32))
  challenge = base64url(sha256(verifier))
  storeSecret(csrfKey, { csrf, organisationId, codeVerifier: verifier }, TTL 10min)
  → https://www.canva.com/api/oauth/authorize
      ?code_challenge=<challenge>&code_challenge_method=S256
      &response_type=code&client_id=…&scope=…&state=…&redirect_uri=…

callback:
  { csrf, organisationId, codeVerifier } = getSecret(csrfKey)   // verify csrf, then:
  POST https://api.canva.com/rest/v1/oauth/token
    Authorization: Basic base64(client_id:client_secret)
    grant_type=authorization_code&code=…&code_verifier=<verifier>&redirect_uri=…
```

Tokens then persist through `saveIntegration()` — vault-encrypted, never plaintext — like every
other provider. Nothing bespoke.

**Env var naming — get this right on day one.** Name the Netlify vars `CANVA_CLIENT_ID` and
`CANVA_CLIENT_SECRET`. The router reads `${PROVIDER}_CLIENT_SECRET`. Nine existing connectors are
currently dead in production precisely because their vars were named `<PREFIX>_SECRET` instead.
Do not repeat that. Set them on **both** staging and production contexts.

### 1.2 Scopes

```
design:meta:read    list + search designs, titles, thumbnails, updated_at   (US2)
folder:read         browse folders and their contents                        (US2 AC3)
asset:read          image assets that live in folders                        (US2)
design:content:read required to export design contents                       (US3 AC3)
```

`design:content:read` as the export scope is **confirmed** against Canva's create-design-export-job
reference (verified 2026-07-15).

`profile:read` is deliberately **not** requested. The "Connected as …" label (US1 AC3) comes from
`GET /rest/v1/users/me/profile` → `{ profile: { display_name } }`, which Canva documents as
requiring no scope at all. Asking for `profile:read` would widen the consent screen for nothing.

Request the minimum. Do **not** request `design:content:write`, `asset:write`, or any
`brandtemplate:*` scope — we only read. A read-only consent screen is also an easier sell.

### 1.3 Token lifecycle

Canva **rotates refresh tokens and each one is single-use**. This matters: the existing Xero branch
already handles exactly this shape ("Xero ALWAYS rotates the refresh token — the old one is now
dead"), so model the Canva branch on Xero, not on HubSpot.

`getFreshAccessToken()` already does the right thing generically: it refreshes proactively before
expiry, persists rotated tokens, and marks the row `'expired'` when the refresh grant itself is
rejected so the UI can prompt a reconnect. Canva needs a `refreshProviderToken()` branch and
nothing more.

The single-use property has a real hazard: **two concurrent imports both refreshing will race**,
one will burn the token the other is about to use, and the loser kills the connection for the whole
org.

**Confirmed pre-existing, and broader than Canva.** `getFreshAccessToken()`
(`src/utils/workspace-integrations.ts`) does an unguarded read → refresh → store. Two concurrent
callers both read the same refresh token and both POST it; the provider accepts one and rejects the
other, and the loser's `catch` sets `status: 'expired'` on the row — **killing the connection for
the whole org even though the winner just refreshed successfully**. This already applies to Xero,
QuickBooks and Jira, all of which rotate. Nothing today drives enough concurrency to trip it often,
which is presumably why it hasn't surfaced.

Canva makes it likely rather than theoretical: Phase 3's batch import calls `getFreshAccessToken()`
per design across parallel exports. **This is a blocker for Phase 3, not Phase 1** — Phase 1 has no
concurrency. Fix by serialising refresh per (org, provider) with a row lock (`SELECT … FOR UPDATE`
on the integration row) so the loser waits and re-reads the winner's token instead of burning it.
Tracked separately: the fix lives in shared code that touches every provider and shouldn't ride in
on a Canva PR.

### 1.4 Browse (US2)

| Need | Endpoint | Notes |
|---|---|---|
| Search designs | `GET /rest/v1/designs?query=&limit=&continuation=&sort_by=` | `limit` max 100, default 25 |
| Folder contents | `GET /rest/v1/folders/{folderId}/items?item_types=&limit=&continuation=` | `limit` max 100, default 50 |

Three API realities that constrain the UX:

**Thumbnail URLs expire after 15 minutes.** This is the most important browse constraint and it has
two consequences. First, never persist a Canva thumbnail URL in our DB — it will be dead long
before anyone looks at it. Second, a browse modal left open on a second monitor will show broken
images. Stamp each page of results with a fetch time and silently re-fetch the current page when it
is older than ~12 minutes and the modal regains focus.

**Pagination is continuation-token based, not offset.** No page numbers, no total count. The grid
must be infinite-scroll or explicit "Load more"; a numbered pager is not implementable. This also
means "3 items selected" can span pages, so selection state must live outside the rendered page and
survive re-render.

**There is no parent-chain/breadcrumb API.** US2 AC3's `Home > 2026 Campaigns > Summer Launch` must
be assembled client-side from the descent path, which works because the user can only ever arrive at
a folder by descending into it from root. Keep a path stack; push on enter, pop on breadcrumb click.
Deep-linking to a folder is therefore not possible without re-walking, which is fine — don't promise
it.

The root folder is referenced as the literal id `root` — **confirmed** (verified 2026-07-15):
"The top level of the user's content library is represented by the folder with the ID `root`."
Folder-item listing is rate limited to 100 requests/min per user.

Proxy all of this through one function (`canva-browse.ts`) rather than calling Canva from the
browser. The access token must never reach the client, and the proxy is where per-user rate limits
get absorbed.

### 1.5 Import / export (US3)

The Canva export API is **asynchronous** and this drives the whole import design:

```
POST /rest/v1/exports  { design_id, format: { type: 'png' | 'jpg' | 'mp4' | … } }
  → { job: { id, status: 'in_progress' } }
GET  /rest/v1/exports/{exportId}
  → status in_progress | success | failed;  on success → download URLs
```

**Download URLs are valid for 24 hours.** Combined with the 15-minute thumbnail expiry, this settles
a design question the brief left open: **Canva assets must be downloaded into R2, not hotlinked.**
Pexels rows hotlink their CDN URL (their terms require it), and it would be natural to copy that
pattern here. It would break within a day. Canva rows follow the `fal` (AI-generated) pattern
instead: download the bytes, put them in R2, store the key. `src/lib/media-persist.ts` and
`upload-asset.ts` already do this.

Rate limits worth designing around: 20 export-creates/min per user, 75 exports/5min per user,
500/24h per user. A user multi-selecting 60 designs will hit the per-minute ceiling. Queue and
throttle server-side; do not fire 60 parallel creates.

**Reuse the existing async job pattern rather than inventing one.** `media_generation_jobs` +
`process-media-job-background.ts` is a direct precedent: a `-background` Netlify function (15-minute
ceiling), a poll loop with a deadline safely under it (that one uses 12 min), a jobs table row
carrying `status`/`errorMessage`, and a download-to-R2 on success. Canva import is the same shape.

```
POST /api/canva/import  { designIds[], tags[], category }
  → creates one canva_import_jobs row per design (status 'queued')
  → invokes canva-import-background
  → returns { jobIds } immediately

canva-import-background:
  for each design (throttled):
    create export job → poll (backoff, deadline ~12 min)
    on success: download → R2 → INSERT content_assets (provider='canva') → job 'complete'
    on failure/timeout: job 'failed' + errorMessage

GET /api/canva/import-status?jobIds=…   ← the UI polls this for US3 AC4
```

Format selection by design type: `mp4` for designs whose `design_types` indicate video/animation,
`png` otherwise (`jpg` if we want smaller files for photo-heavy designs). Note `design_types`
returns values like doc/email/presentation/sheet/whiteboard/custom/unknown — it does **not**
cleanly tell you "this is a video". Decide the mapping explicitly and default to `png`;
a multi-page presentation exported as PNG yields one image per page, which is a product decision
worth making consciously (import all pages? page 1 only? ask?).

---

## 2. Function inventory

New Netlify functions — all must be `export default withLambda(...)`, never `export const handler`
(the whole codebase moved off the Lambda-compat shape to escape AWS's 4KB env-var limit):

| Function | Purpose |
|---|---|
| `canva-browse.ts` | Proxies list/search designs + folder items; injects the fresh token |
| `canva-import.ts` | Validates selection, creates job rows, kicks off the background worker |
| `canva-import-background.ts` | Export → poll → download → R2 → `content_assets` |
| `canva-import-status.ts` | Job status polling for the progress UI |

Modified:

| File | Change |
|---|---|
| `src/utils/workspace-integrations.ts` | provider union, array, refresh branch |
| `netlify/functions/oauth-integrations.ts` | scopes, PKCE, authUrl, token exchange |
| `src/utils/media-resolver.ts` | the `provider IS NULL` filter (§5.1) + contextual matching (§5.2) |
| `integrations.js` / `integrations.html` | connector card |
| `my-content.js` / `my-content.html` | Canva badge, Source filter, Browse entry point |

---

## 3. Data model

### 3.1 Imported assets

No new table. `content_assets` rows with:

```
provider        = 'canva'
providerAssetId = <canva design id>
assetType       = 'image' | 'video'
storageKey      = <R2 key>            -- downloaded, NOT hotlinked (§1.5)
name            = <canva design title>
attributionUrl  = <canva view url>    -- "Open in Canva" deep link
status          = 'pending'
```

`attributionUrl` is a slight reuse of a stock-attribution field to hold the Canva edit/view link.
It's honest enough (it does point back at the source) and avoids a migration. Note Canva's `urls`
are themselves temporary — valid 30 days — so an "Open in Canva" button built on a stored URL will
rot. Prefer constructing the link from the design id at render time if a stable URL format exists;
otherwise accept the rot and re-resolve on demand.

### 3.2 Tags — the new schema (US3 AC5, US4 AC4)

`content_assets` has no tags column, and US3 AC5 and US4 AC4 both need one. Two options:

**Option A (recommended): a `content_asset_tags` join table.** Normalised, indexable, supports the
"filter by tag" and "match post topic to tag" queries in §5.2 without full-table scans, and lets tags
be reused across assets and eventually renamed.

**Option B: a `text[]` column on `content_assets`.** One migration, no joins, fine for `WHERE
'blog-graphics' = ANY(tags)`. Cheaper now, worse when tag management becomes a feature.

Take A. The AI-matching work in §5.2 will want to query tags directly, and retrofitting a join table
after the fact means rewriting those queries. Note the brief's US3 AC5 conflates *tags* with
*workspaces* ("assign the content to specific workspaces (e.g. 'Blog Graphics', 'Social Media')") —
those examples are tags, not workspaces. Workspaces already mean something specific here (orgs).
Clarify with the product owner before building; I've assumed tags.

New SQL goes in `db/*.sql` and **applies manually** — this repo's migrations are not automatic.

### 3.3 Import jobs

`canva_import_jobs`: `id, organisationId, userId, canvaDesignId, canvaExportJobId, status
(queued|exporting|downloading|complete|failed), errorMessage, contentAssetId, createdAt, updatedAt`.
Modelled on `media_generation_jobs`.

---

## 4. Frontend (vanilla — see §0.1)

### 4.1 `CanvaConnectorCard` → a card in `integrations.js`

`integrations.js` already has the whole vocabulary: a platform catalogue, card rendering,
connect/disconnect, and a shared status-badge helper deliberately used by both the card and the
Overview panel "so the two can never disagree about a connection's state." Reuse it — don't write a
parallel badge.

US1 AC5's confirmation-modal-on-disconnect and AC4's error+Retry map onto existing
`?oauth_error=<reason>` redirect handling. AC3's connected-account name comes from `profile:read`.

### 4.2 `window.CanvaBrowser` — IIFE in `src/components/`

Responsibilities: search box (debounced ~300ms into `canva-browse`), folder grid with breadcrumbs
from the client-side path stack (§1.4), skeleton loaders, multi-select, floating action bar,
import kickoff, progress polling.

Concrete traps in this codebase:

- **The floating action bar must not rely on `.hidden`.** In the compiled `style.css`, adding
  `hidden` does **not** hide an `inline-flex`/`flex` element — specificity loses. Set
  `el.style.display = 'none'` as well. This bug looks exactly like "the action bar won't go away"
  and has bitten this repo before.
- **New Tailwind classes need a `style.css` rebuild** or they no-op. Any premium polish added here
  (staggered grid, transitions) must go through the build.
- **`emerald-*` renders as neon pink.** `input.css` remaps the emerald tokens to the brand accent.
  If you reach for `emerald-500` as a "selected" checkmark colour expecting green, you will get pink,
  and the pink is *correct*. Choose deliberately.
- Selection state must be keyed by design id in a `Set` held outside the DOM, because continuation
  pagination re-renders the grid (§1.4).

### 4.3 Library surface (`my-content.js`)

Canva badge on `provider === 'canva'` (US4 AC1), a "Source: Canva" filter (US4 AC4), and an entry
point that opens `CanvaBrowser`. All read off the existing `provider` column.

---

## 5. US4 — the actual work

### 5.1 Make Canva assets visible to the autopilot

`pickManualAsset()` (`src/utils/media-resolver.ts:73`) filters `isNull(contentAssets.provider)`.
That filter exists to keep the "manual" source meaning *the user's own uploads* and to stop it
picking up Pexels/Fal rows that other sources own.

Canva assets are user-owned content that arrived through a connector — semantically "manual", but
`provider` is non-null. Options:

- **Widen the filter** to `provider IS NULL OR provider = 'canva'`. One line, keeps
  `mediaSources = ['manual','stock','ai']` intact, ships now.
- **Add a fourth `MediaSource`, `'canva'`**, in `src/utils/media-sources.ts` with its own slot in
  the priority matrix. Users could then order Canva ahead of stock, or disable it independently.
  Costs: a migration for stored `mediaSources` arrays, the assistant settings UI, and
  `DEFAULT_ORDER` semantics for existing assistants.

Recommend **widening now, and treating the fourth source as a fast-follow** if users ask to control
Canva independently of their uploads. The widened filter is reversible; the new enum member is a
one-way door that touches stored per-assistant config.

Either way, `pickManualAsset` also excludes assets already attached to any post
(`NOT EXISTS … scheduled_post_assets`). For Pexels that "never reuse" rule is deliberate. For a
Canva brand graphic the user deliberately imported, **never reusing it is probably wrong** — people
import a logo card precisely to use it repeatedly. Flag this to the product owner; it may need to be
provider-conditional.

### 5.2 Contextual matching — the largest item in the epic

US4 AC2 asks the SMM to "contextually recommend imported Canva assets that match the post's topic or
tags." Today `pickManualAsset` is `ORDER BY createdAt ASC LIMIT 1`. There is **no** topical matching
for manual assets, for any provider. This is not a Canva feature — it's a missing capability in the
resolver that this epic is the first to require.

The resolver already receives what's needed: `ResolveArgs.context` carries the topic/caption, and it
is currently used only for Pexels keyword search. Options in increasing order of cost:

1. **Tag overlap.** Match `context` against the tags applied at import (§3.2). Cheap, explainable,
   and directly rewards US3 AC5's tagging step — which is a nice loop: tagging becomes visibly
   useful rather than busywork. Ranks by overlap count, falls back to LRU.
2. **Postgres full-text search** over asset name + tags. Better recall, still no new infrastructure.
3. **Embeddings.** `src/utils/kb-embeddings.ts` already exists for the knowledge base, so the
   pattern is in-house. Best relevance, highest cost, and needs a backfill for existing assets.

Recommend **(1) for this epic**, structured so (2)/(3) can slot in behind the same function
signature. Be explicit with the product owner that AC2's "contextually recommend" is being satisfied
by tag matching, not semantic understanding — if they expected the latter, the estimate changes
materially.

### 5.3 Blog Writer (US4 AC3/AC4)

Embedding into the WYSIWYG and drag-and-drop from a filtered library are self-contained UI work
against `blog-studio.html` and `blog-media.ts`. Cheapest of the US4 items; no resolver involvement.

---

## 6. UX edge cases

**Slow exports.** Already answered structurally by §1.5: the import is a job, not a request. The
modal closes immediately and a toast tracks progress (US3 AC4), so a slow export never blocks the
user. Poll with backoff; deadline at ~12 min inside the 15-min background ceiling. On timeout the
job goes `failed` with a message and a retry affordance — a stuck spinner is the failure mode to
design out.

**Expired token mid-import.** `getFreshAccessToken()` refreshes transparently and marks the row
`'expired'` when the refresh grant itself is rejected. The background worker must call it per
design rather than caching a token across a long batch. On `'expired'`, fail the remaining jobs with
a distinct `needs_reconnect` state so the UI shows "Reconnect Canva" rather than a generic error —
and so already-imported assets in the batch are kept, not rolled back.

**Expired thumbnails.** §1.4 — re-fetch the page on focus after ~12 minutes.

**Revoked in Canva, still "Connected" here.** The first browse 401s. Treat 401 from Canva as
authoritative: mark the row `'expired'` and flip the card to "Needs attention", which is a state the
badge helper already renders.

**Rate limits.** 429 from Canva during a large multi-select import. Back off and retry within the
job rather than failing it; only surface to the user if the deadline is hit.

**Partial batch failure.** 8 of 10 succeed. Report per-asset outcomes; keep the 8. Do not present
it as a single all-or-nothing import.

**Empty Canva account.** Zero designs is a real first-run state — needs an empty state, not a
spinner that never resolves.

---

## 7. Suggested build order

Each phase is independently shippable and verifiable.

1. ~~**OAuth.**~~ **CODE-COMPLETE 2026-07-15** — provider union, PKCE, scopes, refresh branch,
   connector card. Both doc unknowns resolved up front (§1.2, §1.4). Not yet runnable end-to-end:
   needs the Canva app + env vars (§7.1). (US1)
2. **Browse.** `canva-browse.ts` + `CanvaBrowser` read-only: search, folders, breadcrumbs,
   skeletons. Ship: users can look at their designs. (US2)
3. **Import.** Job table, background worker, R2 download, `content_assets` rows, progress toast,
   badge + Source filter. Ship: assets land in the library. (US3 AC1–4, US4 AC1)
4. **Tags.** Join table, tag-on-import, filter-by-tag. (US3 AC5, US4 AC4)
5. **Assistant utilisation.** Resolver filter widening + tag-overlap matching + blog embed.
   (US4 AC2/AC3)

Phases 1–3 deliver a genuinely useful feature on their own: connect, browse, import, use manually.
Phases 4–5 are what make the AI half real, and 5 is where the estimate risk concentrates.

**Phase 3 is blocked** until the token-refresh race (§1.3) is fixed — batch import is exactly the
concurrency that trips it.

### 7.1 Phase 1 handover — what's built, what's outstanding

Built and typechecking; the card is render-verified locally against a stubbed status endpoint:

- `src/utils/workspace-integrations.ts` — `'canva'` in the provider union/array + label; refresh
  branch modelled on Xero, and it treats a **missing rotated refresh token as a hard failure**
  rather than re-storing the spent one (which would strand the connection).
- `netlify/functions/oauth-integrations.ts` — scopes, PKCE (S256) verifier generated at connect and
  stashed in the existing server-side vault entry, authorize URL, token exchange, best-effort
  account label from `/users/me/profile`.
- `integrations.html` — connector card, plus an `inbound: true` flag so the success banner and
  disconnect warning stop claiming assistants "sync actions to" Canva (they don't — it's read-only).

**Outstanding before this can be exercised end-to-end:**

1. ~~Create the Canva Connect integration in Canva's developer portal.~~ DONE.
2. ~~Set `CANVA_CLIENT_ID` + `CANVA_CLIENT_SECRET` on Netlify.~~ **DONE + verified 2026-07-15** —
   both names correct (`_CLIENT_SECRET`, not `_SECRET`) and present in all four deploy contexts
   (production, branch-deploy, deploy-preview, dev).
3. **Register both redirect URIs in the Canva app** — the same client id serves every context, so
   Canva must accept both hosts. Use the apex domain, never `www` (a `www` host 308-redirects to
   apex and OAuth providers don't follow 3xx — this is exactly how the prod Stripe webhook broke):
   - staging → `https://staging--bemoreswan.netlify.app/api/oauth/canva/callback`
   - prod → `https://bemoreswan.com/api/oauth/canva/callback`
4. Deploy the branch to `staging`, then walk connect → consent → callback and confirm the card
   flips to Connected with the account name.

**PKCE is verified** (2026-07-15): the exact `createHash('sha256').update(v).digest('base64url')`
expression used at connect reproduces the RFC 7636 Appendix B known-answer vector
(`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`),
and the generated verifier is a valid 43-char unreserved string. A wrong challenge would fail every
connect at Canva's end, so this was worth pinning down without a deploy.

**Deliberate deviation from US1 AC5.** The AC asks for a styled confirmation modal on disconnect.
This ships with `window.confirm`, because that is what all 13 existing connectors use and a
bespoke modal for Canva alone would be inconsistent. The AC's *intent* — prevent accidental
disconnection — is met. Upgrading to a styled modal is worth doing platform-wide, not per-connector.

**Note on the `iconBg`.** `bg-cyan-100` (the obvious Canva brand choice) is **not** in the compiled
`style.css` and would render as no background at all; `bg-teal-100` is compiled and is used instead.
Any future Canva UI adding new Tailwind classes must run `npm run build:css:prod`.

## 8. Open questions for the product owner

1. **US3 AC5 "workspaces"** — tags, or something else? "Workspaces" already means orgs here (§3.2).
2. **Multi-page designs** — a 12-page presentation exports as 12 PNGs. Import all, page 1, or ask?
   (§1.5)
3. **Asset reuse** — should an imported Canva brand graphic be reusable across posts? The current
   never-reuse rule says no, which is probably wrong for this source. (§5.1)
4. **"Contextually recommend"** — is tag matching sufficient for AC2, or was semantic matching
   expected? Changes the estimate materially. (§5.2)
5. **Canva plan requirements** — does the export API require a paid Canva tier? If so it belongs in
   the connector card's copy before users connect, not in an error afterwards. Unverified.
