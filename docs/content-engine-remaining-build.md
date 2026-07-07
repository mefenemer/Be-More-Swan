# Content Engine — Remaining Build Plan

Companion to `content-engine-epic-plan.md`. Phases 0–3 are built; both gating product decisions are
resolved (epic plan §7). This is the concrete build plan for the three remaining pieces. Created 2026-07-07.

**Good news on schema:** `blog_posts.destinations jsonb`, `traffic_baseline`, and `last_metrics_at`
already exist in the applied schema (`db/blog-posts.sql:44,61-62`, `db/schema.ts:2544,2561-2562`), so
**A (connectors) and B (decay) need no new DB migration.** Only C (C2PA) may add provenance fields.

Order of attack: **A → B → C.** A is the just-decided piece and unblocks user value fastest; C needs a
signing cert procured before code is worth writing.

**Progress (2026-07-07):** A ✅ built, B ✅ built (incl. GSC connect panel), C ✅ scaffolded and
cert-gated (see §C). The codeable surface of the epic is complete; C's activation is external
(cert + `c2pa-node`).

---

## A. Blog connector layer (US 3.2) — WordPress, Ghost, Hashnode, Dev.to + RSS

### Design
One adapter interface, four adapters, a publish dispatcher, a connect/creds path, and an RSS emitter.
Both content representations already exist — no new rendering:
- **Markdown** (`blog_posts.body_markdown`) → Hashnode (`contentMarkdown`), Dev.to (`body_markdown`).
- **Sanitized HTML** (`blog_posts.published_payload`) → WordPress (`content`), Ghost (`html`, `?source=html`).

### Credentials — reuse `workspace_integrations` + `vault_secrets`
- Paste-token connectors (Tier 1) do **NOT** fit `oauth-integrations.ts` (OAuth-only). Add a sibling authed
  function `connect-blog-destination.ts`: accepts creds, **validates with a live test call**, stores the
  secret in `vault_secrets` and a `workspace_integrations` row (`provider` = `wordpress`|`ghost`|`hashnode`|`devto`).
  - WordPress self-hosted: `{ siteUrl, username, appPassword }` (HTTP Basic).
  - Ghost: `{ siteUrl, adminApiKey }` (`id:secret` → JWT per request).
  - Hashnode: `{ personalAccessToken, publicationId }`.
  - Dev.to: `{ apiKey }`.
  - Non-secret config (siteUrl, publicationId) can live on `workspace_integrations` config; the token/password
    goes in `vault_secrets` (KEK/DEK), matching the OAuth providers' `vaultRefKey` pattern.
- **Caveat:** `workspace_integrations` has a `(organisation_id, provider)` unique constraint → one connection
  per platform per org (one WP site, one Ghost site). Fine for v1; multi-site is a later enhancement.
- Tier 2: **WordPress.com** is OAuth2 → register in `INTEGRATION_PROVIDERS` + `SCOPES` and reuse the existing
  `/api/oauth/:provider/connect|callback` flow in `oauth-integrations.ts`.

### Adapter interface — `src/utils/blog-destinations/`
```ts
// types.ts
export interface BlogDestination {
  id: 'wordpress' | 'ghost' | 'hashnode' | 'devto';
  validateCreds(creds): Promise<{ ok: boolean; error?: string }>;
  publish(post, creds): Promise<{ externalId: string; url: string; status: 'published' | 'draft' }>;
}
```
- `wordpress.ts`, `ghost.ts`, `hashnode.ts`, `devto.ts`, plus `index.ts` registry.
- Each maps a `blog_posts` row → the platform payload (title, HTML-or-Markdown body, tags, canonical URL,
  feature image URL resolved fresh from R2/Pexels the same way `widget-api.ts` does).

### Publish dispatch
- Extend `src/utils/blog-publish.ts` (`publishBlogPost`) or add `publish-to-destinations.ts` invoked after a
  post reaches `published`: for each selected destination in `blog_posts.destinations`, load creds, call the
  adapter, write back `destinations[platform] = { status, externalId, url, at }`.
- **Idempotency:** if `destinations[platform].externalId` exists, do an update (not re-create) → no double-post.
- One `audit_logs` row per push (actor, platform, result) — reuses the US 6.1 edit-log discipline.
- Only push `published`/approved posts; never a draft snapshot.

### RSS — `widget-rss.ts` (public, off published payload)
- `GET /api/widget/:publicKey/rss` → RSS 2.0 (or Atom) built from the org's published `blog_posts`
  snapshots. CDN-cacheable like `widget-api.ts` (`s-maxage`). Add the rewrite in `netlify.toml` mirroring
  `/api/widget/*`. Universal fallback for any platform not on the connector list.

### UI (Blog Studio modal + integrations)
- Connection management: paste-creds cards for the 4 platforms (in `integrations.html`/`.js` alongside the
  OAuth connectors), each with a "Test connection" action → `connect-blog-destination.ts` validate.
- Blog Studio modal: a **"Publish to"** multi-select of *connected* destinations, wired into the
  Approve & Schedule / Publish flow; per-destination status chips after publish (from `destinations` jsonb).

### Build sub-order
1. Adapter iface + **Dev.to** + **Hashnode** (Markdown-native, single API key/PAT — smallest surface, proves the interface).
2. **WordPress self-hosted** + **Ghost** (site URL + Basic/JWT).
3. `publish-to-destinations.ts` dispatch + `destinations` write-back + idempotency + audit.
4. **`widget-rss.ts`** + `netlify.toml` route.
5. Blog Studio "Publish to" UI + integrations connection cards.
6. Tier 2: **WordPress.com** OAuth (register provider in `oauth-integrations.ts`).

---

## B. Content decay loop (US 5.1) — GSC only

### Connect
- Register **`search_console`** as an OAuth provider in `oauth-integrations.ts` (`INTEGRATION_PROVIDERS` +
  `SCOPES['search_console'] = 'https://www.googleapis.com/auth/webmasters.readonly'`). `connection-map.ts`
  already exposes the `search_console` capability + `seo_content_strategist` role → surfaces in integrations UI.
- Google OAuth app verification for the sensitive `webmasters.readonly` scope (timeline item, not a blocker).

### Ingest — `ingest-gsc-metrics.ts` (cron, daily)
- For each org with GSC connected + `published` blog posts: query `searchanalytics.query` per post URL
  (clicks/impressions/CTR/position). Write `blog_posts.traffic_baseline` (first run) + `last_metrics_at`;
  keep a rolling recent window for trend.
- Register in `netlify.toml` (`[functions."ingest-gsc-metrics"] schedule = "@daily"` style, like `resolve-ab-tests`).

### Detect → Update Ticket
- Threshold on decline vs baseline (config in `platform_config`) → create a `pending_actions` "Update Ticket"
  for the post, optionally with an **AI-drafted revision** (reuse `generate-blog.ts`/`rewrite-section.ts`) that
  a human approves before re-publish. Keep the detector reading `traffic_baseline`/`last_metrics_at` generically
  so a future GA4 ingester can populate the same columns (per §7 #4).

---

## C. C2PA image signing (US 6.1) — SCAFFOLDED, cert-gated

- Text provenance, AI disclosure, and the audit edit-log are already built. Missing piece = **signing image
  bytes**: embed a C2PA manifest into feature/inline images at generation/publish time.
- Needs (a) a signing library (`c2pa-node` or the Rust `c2pa` CLI in a build step) and (b) a **signing
  certificate** — this cert procurement/management is the real gate, not the code.
- Store the manifest + signer info alongside existing `content_provenance`.

**Status (2026-07-07): scaffold built and dormant.** Everything reachable without a cert is done and tested:
- `src/utils/c2pa-sign.ts` — `isC2paSigningEnabled()` gate (OFF until `C2PA_SIGN_CERT` + `C2PA_SIGN_KEY`
  are set), `buildManifest()`, `signImageBytes()` (identity passthrough when disabled), and
  `signStoredImageAsset()` (R2 fetch → sign → write back in place). `c2pa-node` is lazy-loaded via a
  computed specifier so the missing optional dep never breaks build/typecheck.
- `content_provenance.image_manifest / image_signer / image_signed_at` — schema (`db/schema.ts`) +
  `db/c2pa-image-signing.sql` **applied to Staging 2026-07-07**.
- Guarded hook in `src/utils/blog-publish.ts` (inert while the gate is false → publish path byte-for-byte
  unchanged). Unit test `tests/c2pa-sign.test.ts` (`npm run test:c2pa-sign`).

**Remaining, both external — no code change to go live:**
1. Provision a signing certificate → set `C2PA_SIGN_CERT` / `C2PA_SIGN_KEY` (+ optional `C2PA_TSA_URL`,
   `C2PA_SIGNER_LABEL`).
2. `npm i c2pa-node` and confirm the UNVERIFIED native call in `c2pa-sign.ts` against the pinned version.

---

## Gated / operational notes
- **No new DB migration for A or B** (columns already exist). C added `content_provenance` provenance
  fields via `db/c2pa-image-signing.sql` — manual-apply, DB-owner, idempotent (no `drizzle-kit push` —
  preserves RLS); **applied to Staging 2026-07-07.**
- New OAuth providers (`search_console`, `wordpress.com`) need client-id/secret env vars + redirect URIs
  registered with Google / WordPress.com.
- Tenant isolation: every connector read/write is org-scoped via `workspace_integrations.organisation_id`,
  same discipline as `tests/tenant-guard.test.ts`.
