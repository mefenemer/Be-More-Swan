# Site page directory — plan

Status: **APPROVED** by the owner 2026-10-31 with every recommendation in §9 (D1–D7). Built on staging the same day; `db/z-site-directory.sql` must be applied to BOTH databases before the code deploys.

## 1. The problem

Every assistant knows the customer's website **address** and nothing on it:

- `org.websiteUrl` reaches drafting as one line (`src/utils/blueprint.ts:271`,
  `src/utils/autonomous-draft-brief.ts:103`).
- Business Information links reach prompts as name + URL only (`src/utils/business-knowledge.ts`).
- The Mystery Shopper reads the homepage (plus two secondary pages) for its own audit, and
  "Import my current site" reads the homepage + menu pages once. Neither result is shared.

So a social post about the yoga class links to the homepage, a blog article has no internal links,
a lead email for "garden design" points at `/` instead of `/garden-design`, and the Business Mentor
can't say "you sell 6 services and only 2 have a page".

## 2. What we build

A **site page directory**: for each page on the customer's site, a small entry:

| Field | Example |
| --- | --- |
| `url` | `https://lovecat.studio/workshops` |
| `title` | `Workshops` |
| `summary` | one line, ≤ 140 chars: `Weekend pottery workshops for beginners in Bristol.` |
| `offers` | up to 4 short items: `Beginner wheel class`, `Hand-building`, `Gift vouchers` |
| `kind` | `home` · `service` · `about` · `contact` · `booking` · `shop` · `other` (rule-based) |

Stored once per workspace, refreshed weekly and on demand, read by every live assistant through
**one loader** as a compact, capped prompt block. It is a **map of the site**, not the site's text.

## 3. Sources

### 3.1 A Be More Swan-hosted site (no crawl)
If the workspace has a **published** site (`sites.status = 'published'`), read the frozen published
definition (`site_versions` at `sites.published_version`) directly — no fetch, no robots, no cost:

- `url` = verified custom domain if there is one (`site_domains`), else `siteOrigin(slug)`
  (`src/utils/site-hosting.ts`) + `/` + page slug.
- `title` = page title; `summary` = the page's hero subheadline, else its first text paragraph.
- `offers` = feature/steps item titles, and product/menu sections' **product names** looked up in
  Business Information (`org_products`) — names only, never prices.

Rebuilt immediately on every publish (a hook in `site-store.ts` publish), so it is never stale.

### 3.2 An external site (crawl)
For `org.websiteUrl` when it is not the hosted site:

1. **sitemap.xml** — `Sitemap:` lines in robots.txt, else `/sitemap.xml`; one level of sitemap
   index followed. Same host only (www/non-www equal).
2. Else **the homepage's menu** — the import's `readImportPage` nav links.
3. Filter with the import's existing `SKIP_PATH` / `FILE_PATH` rules (no cart, login, legal, tag
   pages, individual blog posts or products), de-duplicate, cap at **`DIRECTORY_MAX_PAGES` = 30**
   (home first, then menu order, then sitemap order).
4. Read each page through `fetchSiteHtml` (`src/utils/site-fetch.ts` → `robots.ts` →
   `safe-fetch.ts`) under a **new crawler name** `bemoreswan-sitedirectory`, so an owner can block
   it on its own. Sequential, 10 s timeout, 2 MB per page.
5. A page with too little text (JavaScript-drawn, under `IMPORT_THIN_WORDS`) is re-read with the
   headless renderer (`src/utils/site-js-render.ts`) — at most **5 renders per refresh** (§9 D4).

Entries are built **deterministically** from the page (§9 D1): title = `<title>`/og:title/H1;
summary = meta description, else the first paragraph, trimmed to one sentence; offers = H2/H3
headings with generic ones dropped ("Welcome", "Contact us", "Follow us", "FAQ"…). Any summary or
offer that **states a price** (`statesPrice` in `site-extract.ts`) is dropped — prices live only in
Business Information.

### 3.3 Which source wins
Hosted and published → hosted (§3.1). Otherwise `org.websiteUrl` → crawl. Neither → no directory,
and the Business Information tab says why. (§9 D2 if the owner wants both read.)

## 4. Storage — `db/z-site-directory.sql` (applied to BOTH DBs before the code ships)

One row per workspace:

```sql
CREATE TABLE IF NOT EXISTS site_directories (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('hosted','crawl')),
  source_url       text NOT NULL,
  status           text NOT NULL DEFAULT 'reading' CHECK (status IN ('reading','ready','failed')),
  pages            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url,title,summary,offers[],kind}]
  excluded         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [path,…] the owner left out; survives refreshes
  message          text,                                  -- owner-readable: robots refused, couldn't reach…
  refreshed_at     timestamptz,
  next_refresh_at  timestamptz,
  requested_by     integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_directories_org_uq UNIQUE (organisation_id)
);
CREATE INDEX IF NOT EXISTS site_directories_due_idx ON site_directories (next_refresh_at);
```

A failed refresh keeps the **last good pages** (status `failed` + message), so one bad week never
empties the block. Every reader is wrapped in try/catch → "no directory", so a missing table is a
missing block, never a failed turn (memory: schema-column-breaks-reads-until-applied).

## 5. Refresh

- **Weekly**: `dispatch-site-directories.ts` scheduled daily on prod (netlify.toml) and poked on
  staging by `.github/workflows/staging-crons.yml`, like `dispatch-site-audits.ts`. Queues
  workspaces whose `next_refresh_at` is due (or never read) **and** that have at least one working
  assistant, at most 40 per tick — which spreads the first build over a few days; after that each
  workspace is due a week after its own last read, so reads stay spread out.
- **"Re-read my site"**: Business Information button and a chat card — same server action. At most
  once per hour per workspace (the button says when it can run again).
- **Automatically**: on hosted-site publish (§3.1), and when `org.websiteUrl` changes.
- Work runs in `site-directory-background.ts` (15 min budget; needs the same
  `external_node_modules` Chromium config as `draft-site-background`).

## 6. The prompt block — `src/utils/site-directory.ts`

ONE loader + renderer, like `business-knowledge.ts`: `loadSiteDirectoryBlock(db, orgId)`.

```
YOUR WEBSITE'S PAGES — Use these to link to the most relevant page instead of the homepage, and only
ever link to pages listed here. Business Information is authoritative: … Never quote prices from the website …
- https://lovecat.studio/ — Lovecat Studio: Pottery studio and shop in Bristol.
- https://lovecat.studio/workshops — Workshops: Weekend pottery workshops for beginners. (Wheel class; Hand-building; Gift vouchers)
- https://lovecat.studio/contact — Contact: Visit or message the studio.
```

- **Hard cap `SITE_DIRECTORY_CHAR_CAP` = 2,500 characters** (§9 D3): the chat pays it every turn
  inside the 26 s request. Home and contact always kept; then service/booking/shop pages; then the
  rest; lines that don't fit are dropped whole, with "(+N more pages)".
- Excluded pages never appear. Each line carries the page's FULL address: link grounding
  (`layout-ir.ts groundLinks`) keeps only a link that appears verbatim in what the model was given.
- Read **live** (not a blueprint snapshot), like the products block, so a refresh reaches the next
  draft.

### Where it is wired (every live assistant)
| Surface | File | Use |
| --- | --- | --- |
| Chat, every route | `netlify/functions/chat-orchestrator.ts` (beside `knowledgeBlock`) | answer "which page…", link the right page |
| Social drafts | `process-content-jobs.ts` | link the matching page in the post |
| Blog drafts | `src/utils/blog-generate.ts` | 2–3 internal links to real pages only |
| Email / newsletter | `newsletter-generate.ts`, `newsletter-campaign-generate.ts` | button/link to the right page |
| Lead outreach | the outreach drafting in `lead-generation.ts` / `process-discovery-jobs.ts` | point at the matching service page |
| Business Mentor | `src/utils/mentor-snapshot.ts` + its review | **gaps**: products/services in Business Information with no matching page, no contact/about page |
| Campaign Orchestrator, Website Assistant, Brand Designer, Mystery Shopper | via the chat block | same map |

A source-scan test pins that each of these calls the one loader and nothing else formats the
directory.

## 7. GUI and chat parity

**Business Information → new tab "Website Pages"** (`assets.html` / `assets.js`):
source and address, last read, status message, the page list (title, path, summary, offers),
a **Leave out / Put back** switch per page, and **Re-read my site**.

**Chat** (every structured route, memory: assistant-gui-chat-parity): the block above lets it
*show* the directory; one confirm card `site_directory` with `refresh` and `exclude`/`include`
(path) — the card calls the same `netlify/functions/site-directory.ts` action as the GUI; the chat
never claims it re-read the site before the card is confirmed.

API: `GET /api/site-directory` → view; `POST {action:'refresh'|'exclude'|'include', path?}`.

## 8. Metering

Recommended: **a refresh costs no task** — no model call (D1), it produces no content, and it runs
for the customer's benefit across every assistant. If the owner picks model-written summaries
(D1 option b), a refresh spends **1 task** via `hasTaskCapacity` / `recordCompletedWork`
(`work-metering.ts`), weekly refreshes are skipped at the cap (the old directory stays), and the
manual button says so.

## 9. Open decisions for the owner

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| **D1** | Who writes the one-line summary and "offers"? | **(a)** Rules: meta description / first paragraph / headings — free, never invents. **(b)** One cheap model call per refresh over the extracted text — nicer summaries, small invention risk, 1 task. | **(a)** — the same "the model never writes a word about their site" rule as the import. Revisit if summaries read poorly on real sites. |
| **D2** | Both a hosted site and a different `websiteUrl`? | Read the hosted site only · read both and merge | Hosted only — it's the one we serve and link to. |
| **D3** | Prompt cap | 1,500 · **2,500** · 4,000 characters | 2,500 (~20 pages). |
| **D4** | Headless Chrome for JavaScript sites on refresh | Yes, up to 5 pages · No (plain read only) | Yes, up to 5 — lovecat-style sites otherwise get an empty directory. |
| **D5** | Page cap per site | 15 · **30** · 50 | 30 — small businesses rarely have more that matter. |
| **D6** | Metering | Free · 1 task per refresh | Free (follows D1a). |
| **D7** | Which plans | All plans · paid only | All plans — it improves what every assistant already does. |

## 10. Build order (as built)

1. `db/z-site-directory.sql` + Drizzle schema; owner applies to staging and prod.
2. `src/utils/site-directory.ts` (pure: sitemap parse, page pick, entry build, hosted build, prompt
   block, mentor gaps) + `site-directory-store.ts` (DB + fetch).
3. Background worker, dispatcher, netlify.toml schedule, staging-crons entry.
4. Loader wired into every surface in §6.
5. API + Business Information tab + chat card.
6. Tests (`tests/site-directory.test.ts`): sitemap and menu picking on saved pages, price stripping,
   generic-heading filter, hosted-definition build, cap and ordering, exclusions survive refresh,
   failed refresh keeps last pages, no `recordCompletedWork` call (D6), source-scan of every
   surface.
7. Help article (dated SQL file) and memory note.

## 11. What was built (2026-10-31)

| Piece | File |
| --- | --- |
| Table | `db/z-site-directory.sql`, `db/schema.ts` `siteDirectories` |
| Pure: pages, entries, block, gaps, crawl | `src/utils/site-directory.ts` |
| DB, THE loader, refresh, dispatch, exclusions | `src/utils/site-directory-store.ts` |
| Worker / daily dispatch / staging wrapper | `netlify/functions/site-directory-background.ts`, `dispatch-site-directories.ts`, `run-site-directory-dispatch.ts` |
| API (GUI + chat card) | `netlify/functions/site-directory.ts` |
| Business Information tab | `assets.html` (`data-panel="sitepages"`) |
| Chat block + card | `src/utils/chat-site-directory.ts`, `disruptive-ui-registry.js` `site_directory` |
| Surfaces | chat-orchestrator (every route + hand-off), process-content-jobs, blog-generate (+ internal-links hint), newsletter-generate (×2), newsletter-campaign-generate, sender-identity (all 6 outreach prompts), mentor-snapshot (`websiteGaps`) |
| Hooks | publish/unpublish (`sites.ts`), website address change (`organisation-profile.ts`) |
| Help | `db/help-articles-website-pages-2026-10-31.sql` |
| Tests | `tests/site-directory.test.ts` |
