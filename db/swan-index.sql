-- The Swan Index — first-party syndication destination (theswanindex.com).
--
-- A curated business publication whose entire corpus is blog posts written in Be More Swan and
-- syndicated here by their authors. It is destination #6 in the blog-connector registry
-- (src/utils/blog-destinations/), not a parallel publishing path — so it inherits the existing
-- idempotent re-publish, per-destination draft/live mode, per-post opt-out and the mandatory
-- EU AI Act disclosure for free.
--
-- ── The one design decision worth reading ──────────────────────────────────────────────────────
-- swan_index_posts does NOT copy the article body. It REFERENCES blog_posts.id and the magazine
-- renders from that row's published_payload at read time, resolving media exactly as
-- netlify/functions/blog-page.ts does.
--
-- Every external adapter must copy, because it is pushing bytes over someone else's API. This one
-- owns both ends, and copying would buy nothing while costing correctness: an author who edits or
-- unpublishes would leave a stale copy live under their own byline on a domain they do not control.
-- Referencing makes "the magazine shows what the author currently publishes" a property of the
-- schema rather than a job that has to keep running. It also lets the magazine carry the post's
-- MEDIA — the external adapters strip it (presigned URLs expire, Pexels is hotlink-only), but a
-- same-infrastructure reader can resolve it fresh on every request.
--
-- Only the fields curation needs to sort, filter and paginate on are denormalised onto the row.
--
-- ── Why robots defaults to noindex,follow ──────────────────────────────────────────────────────
-- A domain hosting third-party content at volume to accumulate search authority is the shape
-- Google's site-reputation-abuse and scaled-content-abuse policies exist to demote, and a manual
-- action here would take down every author's copy with OUR customers' names on the bylines.
-- rel=canonical is a hint, not a directive, so it is not on its own a defence.
--
-- Syndicated copies are therefore not indexable by default; `follow` still passes link equity back
-- to the author's own domain, which is the thing they actually want. Editorial curation is what
-- lifts a piece to 'index,follow' (see swan_index_posts.robots and the 'featured' status) — a
-- hand-picked front page is a publication, and search engines treat it as one.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).
--
-- ⚠️ Depends on organisations, users, blog_posts and content_assets. Alphabetically this file
--    sorts after all four, so a from-scratch `db-migrate apply` orders correctly.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- swan_index_profiles — the author/masthead identity, one per workspace.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Existence of a row IS the opt-in: listBlogDestinations() reports the swanindex destination as
-- connected when one exists, which is why there is no separate `connected` flag to fall out of sync.
CREATE TABLE IF NOT EXISTS swan_index_profiles (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Public identity. handle is the URL segment: /@handle and /@handle/{slug}.
  handle            TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  role_title        TEXT,                                   -- "Founder", "Global Portfolio Director"
  company_name      TEXT,
  bio               TEXT,
  avatar_asset_id   INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,

  -- The author's own site. Shown on the profile AND used as the fallback when a post carries no
  -- canonical_url of its own — the whole point of the network is to point back here.
  site_url          TEXT,

  -- Validated public profile URLs, keyed by the platform ids in src/config/platform-formats.ts:
  --   {"linkedin": "https://www.linkedin.com/in/…", "x": "https://x.com/…"}
  -- One jsonb rather than six columns because that platform list has grown twice already, and
  -- every value is host-checked before it is stored (src/utils/swan-index/socials.ts) — an
  -- unchecked URL field on an indexable masthead is a link farm.
  socials           JSONB NOT NULL DEFAULT '{}'::jsonb,

  status            TEXT NOT NULL DEFAULT 'active',         -- active | suspended | withdrawn
  -- Front-page eligibility, i.e. the paid tier. A profile can publish to its own page regardless;
  -- this is what makes it eligible to be selected for the curated front page.
  front_page_tier   BOOLEAN NOT NULL DEFAULT false,

  -- Volume cap. The single most effective spam-farm control, and it must be enforced server-side
  -- rather than in the UI: 8 live pieces per calendar month is a busy trade columnist and nowhere
  -- near a content farm. NULL means uncapped (staff/partner publications only).
  monthly_post_cap  INTEGER DEFAULT 8,

  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT swan_index_profiles_status_check CHECK (status IN ('active','suspended','withdrawn')),
  -- Lowercase alphanumeric + hyphen, 3–30 chars. Enforced in the DB because the handle is a public
  -- URL segment and a profile row is created by an automated publish path, not only by a form.
  CONSTRAINT swan_index_profiles_handle_check CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
  CONSTRAINT swan_index_profiles_cap_check    CHECK (monthly_post_cap IS NULL OR monthly_post_cap > 0)
);

-- Handles are case-insensitively unique: /@AcmeCorp and /@acmecorp must not be two publications.
CREATE UNIQUE INDEX IF NOT EXISTS swan_index_profiles_handle_unique ON swan_index_profiles (lower(handle));
CREATE INDEX        IF NOT EXISTS swan_index_profiles_status_idx    ON swan_index_profiles (status);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- swan_index_posts — one row per syndicated piece. A curation layer over blog_posts, not a copy.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS swan_index_posts (
  id                SERIAL PRIMARY KEY,
  -- UNIQUE: re-syndicating an already-submitted post updates this row rather than duplicating it.
  -- This is what makes the adapter's publish() idempotent, matching every external adapter.
  blog_post_id      INTEGER NOT NULL UNIQUE REFERENCES blog_posts(id) ON DELETE CASCADE,
  profile_id        INTEGER NOT NULL REFERENCES swan_index_profiles(id) ON DELETE CASCADE,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  -- ── Editorial state ──────────────────────────────────────────────────────────────────────────
  --   pending   submitted as a draft; visible to nobody but the editor queue
  --   live      on the author's own profile page, chronologically (the Medium half)
  --   featured  additionally selected for the curated front page (the Monocle half)
  --   rejected  declined by an editor; stays for the audit trail, renders nowhere
  --   withdrawn author pulled it, or the source post left 'published'
  status            TEXT NOT NULL DEFAULT 'pending',
  section           TEXT,                                    -- 'operations' | 'growth' | …
  featured_rank     INTEGER,                                 -- front-page order; 1 = lead story
  editor_note       TEXT,
  editor_score      INTEGER,                                 -- 1–5, the curation signal

  -- Crawler directive for THIS copy. Default noindex per the header note; curation lifts it.
  robots            TEXT NOT NULL DEFAULT 'noindex,follow',

  -- ── Snapshot: only what list queries sort, filter and paginate on ────────────────────────────
  -- Never the body. Denormalised so the front page is one indexed scan instead of a join fan-out
  -- across blog_posts for every card.
  slug              TEXT NOT NULL,                           -- unique per profile, not globally
  title             TEXT NOT NULL,
  dek               TEXT,                                    -- the standfirst under the headline
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The author's own URL for this piece, copied from blog_posts.canonical_url at submit time.
  -- Every rendered magazine page emits this as rel=canonical; a NULL here means the source post
  -- had none and the page falls back to self-canonical.
  author_canonical_url TEXT,

  submitted_at      TIMESTAMP NOT NULL DEFAULT now(),
  live_at           TIMESTAMP,
  featured_at       TIMESTAMP,

  -- Editorial safety screen; see the ALTER further down and swan-index/safety.ts.
  safety_check      JSONB,
  safety_checked_at TIMESTAMP,

  -- Readership, aggregated by the same beacon widget-ab-beacon.ts already serves.
  view_count        INTEGER NOT NULL DEFAULT 0,
  read_count        INTEGER NOT NULL DEFAULT 0,              -- dwell > 15s or > 50% scrolled

  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT swan_index_posts_status_check CHECK (status IN ('pending','live','featured','rejected','withdrawn')),
  CONSTRAINT swan_index_posts_robots_check CHECK (robots IN ('index,follow','index,nofollow','noindex,follow','noindex,nofollow')),
  CONSTRAINT swan_index_posts_score_check  CHECK (editor_score IS NULL OR editor_score BETWEEN 1 AND 5),
  -- A featured piece must have a rank, and a ranked piece must be featured — the front page reads
  -- ORDER BY featured_rank, and either half of that pair alone produces a silently empty slot.
  CONSTRAINT swan_index_posts_featured_rank_check CHECK (
    (status = 'featured' AND featured_rank IS NOT NULL) OR
    (status <> 'featured' AND featured_rank IS NULL)
  )
);

-- URL identity: /@handle/{slug}. Unique per profile so two workspaces can both publish
-- "how-we-cut-churn" without one having to take a numeric suffix.
CREATE UNIQUE INDEX IF NOT EXISTS swan_index_posts_profile_slug_unique ON swan_index_posts (profile_id, slug);
-- The profile page: this author's pieces, newest first.
CREATE INDEX IF NOT EXISTS swan_index_posts_profile_live_idx ON swan_index_posts (profile_id, status, live_at DESC);
-- The front page: ORDER BY featured_rank over the handful of featured rows.
CREATE INDEX IF NOT EXISTS swan_index_posts_featured_idx ON swan_index_posts (featured_rank)
  WHERE status = 'featured';
-- "Latest" across the whole network, and the section feeds.
CREATE INDEX IF NOT EXISTS swan_index_posts_live_at_idx  ON swan_index_posts (live_at DESC)
  WHERE status IN ('live','featured');
CREATE INDEX IF NOT EXISTS swan_index_posts_section_idx  ON swan_index_posts (section, live_at DESC)
  WHERE status IN ('live','featured');
-- The editor queue.
CREATE INDEX IF NOT EXISTS swan_index_posts_pending_idx  ON swan_index_posts (submitted_at)
  WHERE status = 'pending';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- swan_index_sections — the masthead's own taxonomy.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Deliberately NOT the authors' free-text tags. Tags are whatever an AI put on a post; a section is
-- an editorial decision, and a fixed set of them is most of what separates a magazine from a feed.
CREATE TABLE IF NOT EXISTS swan_index_sections (
  key          TEXT PRIMARY KEY,                             -- URL segment: /section/{key}
  label        TEXT NOT NULL,
  standfirst   TEXT,                                         -- the line under the section masthead
  position     INTEGER NOT NULL DEFAULT 0,                   -- nav order
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT swan_index_sections_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$')
);

-- The masthead's seven sections. Named for what a reader is dealing with this week, not for a
-- topic cloud. The first cut used Capital / Craft / Systems, which sounded like a management
-- consultancy: "Capital" reads as venture finance to an owner-operator whose actual subject is
-- cashflow, and "Craft" was a section nobody could predict the contents of.
INSERT INTO swan_index_sections (key, label, standfirst, position) VALUES
  ('operations', 'Operations', 'How the work actually gets done.',                    1),
  ('growth',     'Growth',     'Demand, pricing and the pursuit of customers.',       2),
  ('money',      'Money',      'Money in, money out, and the decisions between.',     3),
  ('people',     'People',     'Hiring, managing and the cost of getting it wrong.',  4),
  ('technology', 'Technology', 'Tooling, automation and the machinery of scale.',     5),
  ('culture',    'Culture',    'What a business is like to work in, and why.',        6),
  ('lifestyle',  'Lifestyle',  'The hours, the health and the life outside the business.', 7)
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Guard: the source post must be the author's own.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- swan_index_posts carries organisation_id for query convenience, which means it can disagree with
-- the blog_posts row it points at — and a disagreement here is one workspace publishing another's
-- article under its own byline. Composite FKs are the only way to make that unrepresentable, so
-- blog_posts gets the unique key the reference needs. (Redundant with its PK by design; that is
-- what a composite FK target requires.)
ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_id_org_unique;
ALTER TABLE blog_posts ADD  CONSTRAINT blog_posts_id_org_unique UNIQUE (id, organisation_id);

ALTER TABLE swan_index_posts DROP CONSTRAINT IF EXISTS swan_index_posts_post_org_fk;
ALTER TABLE swan_index_posts ADD  CONSTRAINT swan_index_posts_post_org_fk
  FOREIGN KEY (blog_post_id, organisation_id) REFERENCES blog_posts (id, organisation_id) ON DELETE CASCADE;

ALTER TABLE swan_index_profiles DROP CONSTRAINT IF EXISTS swan_index_profiles_id_org_unique;
ALTER TABLE swan_index_profiles ADD  CONSTRAINT swan_index_profiles_id_org_unique UNIQUE (id, organisation_id);

ALTER TABLE swan_index_posts DROP CONSTRAINT IF EXISTS swan_index_posts_profile_org_fk;
ALTER TABLE swan_index_posts ADD  CONSTRAINT swan_index_posts_profile_org_fk
  FOREIGN KEY (profile_id, organisation_id) REFERENCES swan_index_profiles (id, organisation_id) ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Additions to an already-created table.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- This file is the one place the profile table is defined, and it is idempotent by contract, so a
-- new column goes in the CREATE above AND here — the CREATE is a no-op on every database that
-- already has the table. db-migrate reports this file as DRIFTED after such an edit and re-runs it,
-- which is the intended path, not a warning to work around.
ALTER TABLE swan_index_profiles ADD COLUMN IF NOT EXISTS socials JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Editorial safety screen, 2026-08-22 ────────────────────────────────────────────────────────
-- The report an editor sees in the review drawer: one row per benchmark, with a verdict. Stored on
-- the submission rather than recomputed per view so it is also a record of what was true when the
-- piece was approved. NULL means "not screened yet", which the UI must say out loud — see the
-- unchecked-is-not-pass rule in src/utils/swan-index/safety.ts.
ALTER TABLE swan_index_posts ADD COLUMN IF NOT EXISTS safety_check      JSONB;
ALTER TABLE swan_index_posts ADD COLUMN IF NOT EXISTS safety_checked_at TIMESTAMP;

-- ── Section rename, 2026-08-22 ─────────────────────────────────────────────────────────────────
-- capital → money and systems → technology are the same section under a plainer word, so the
-- pieces move with them. craft ("product, design and the discipline of making") has no successor;
-- technology is the least wrong home for what was filed there, and an editor can re-file by hand.
--
-- The retired keys are DEACTIVATED, not deleted: swan_index_posts.section has no foreign key, so a
-- delete would leave any row this UPDATE missed pointing at nothing, and the public list query
-- LEFT JOINs the label — it would render a piece with a blank section rather than fail loudly.
-- Inactive keeps them out of the nav and out of /section/:key while the label still resolves.
UPDATE swan_index_posts SET section = 'money',      updated_at = now() WHERE section = 'capital';
UPDATE swan_index_posts SET section = 'technology', updated_at = now() WHERE section IN ('systems', 'craft');
UPDATE swan_index_sections SET active = false WHERE key IN ('capital', 'craft', 'systems');

-- Positions are re-stated rather than left to the seed INSERT: on a database that already had the
-- first six, ON CONFLICT DO NOTHING skipped every row above, so people would still sit at 5.
UPDATE swan_index_sections SET position = 1 WHERE key = 'operations';
UPDATE swan_index_sections SET position = 2 WHERE key = 'growth';
UPDATE swan_index_sections SET position = 3 WHERE key = 'money';
UPDATE swan_index_sections SET position = 4 WHERE key = 'people';
UPDATE swan_index_sections SET position = 5 WHERE key = 'technology';
UPDATE swan_index_sections SET position = 6 WHERE key = 'culture';
UPDATE swan_index_sections SET position = 7 WHERE key = 'lifestyle';
UPDATE swan_index_sections SET standfirst = 'Hiring, managing and the cost of getting it wrong.' WHERE key = 'people';

-- Undo the duplicated byline. ensureProfile() seeded company_name from organisations.name, the same
-- field display_name comes from, so every profile nobody had edited read "Acme, Acme" on the
-- article page and "Acme at Acme" in the admin list. Renderers now drop a company that repeats the
-- name; this clears the stored copy so the profile FORM shows what the page actually prints.
UPDATE swan_index_profiles
   SET company_name = NULL, updated_at = now()
 WHERE company_name IS NOT NULL
   AND lower(btrim(company_name)) = lower(btrim(display_name));

COMMENT ON TABLE swan_index_profiles IS 'The Swan Index — public author identity, one per workspace. Row existence is the opt-in.';
COMMENT ON TABLE swan_index_posts    IS 'The Swan Index — curation layer over blog_posts. References the body, never copies it.';
COMMENT ON TABLE swan_index_sections IS 'The Swan Index — editorial taxonomy. Distinct from authors free-text tags.';
