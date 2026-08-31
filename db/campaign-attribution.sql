-- db/campaign-attribution.sql — Campaign Assistant, Phase A: the attribution spine.
-- Design: docs/campaign-orchestrator-plan.md §7 Phase 2 ("Outcomes & capture"), brought forward.
-- Drizzle mirror: db/schema.ts (campaignLinks / campaignClickEvents / campaignAttributions).
--
-- APPLY MANUALLY as the DB owner (project convention — new db/*.sql are not pushed by
-- drizzle-kit). Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only campaign-attribution
--
-- ⚠️ A SEPARATE FILE, NOT AN EDIT TO db/campaigns.sql. Adding these tables by editing that file
-- would re-run its whole body, and any constraint there that is ever changed to DROP-then-ADD
-- kills the transaction part-way and silently skips everything after it. New tables go in new
-- files; that is the only shape that stays re-runnable.
--
-- ── What this models ─────────────────────────────────────────────────────────
-- The chain the ROI funnel needs, end to end:
--
--     campaign → tracked link → click → (a person does something) → outcome
--
-- Every step is a row, so "£X of effort produced Y outcomes" is a join rather than a
-- reconstruction. Before this file the chain had NO first half: a grep for
-- utm_source / li_fat_id / gclid / fbclid across the whole repo returned three unrelated tests
-- and one marketing page. Nothing captured a click, so nothing could attribute one.
--
-- ⚠️ src/utils/attribution.ts is NOT related to any of this. It is the "Powered by Be More Swan"
-- export footer. The name collision is unfortunate; the module to reach for here is
-- src/utils/campaign-attribution.ts.
--
-- ── This file adds NO money columns, and unlocks nothing ─────────────────────
-- Paid campaigns stay refused by all three existing guards (CREATABLE_CAMPAIGN_MODES,
-- the maxSpendGbp check at the HTTP boundary in netlify/functions/campaigns.ts, and the
-- campaign_budgets_organic_is_free trigger). A tracked link works identically whether the click
-- came from an ad, an organic post or an email, which is exactly why this half can ship years
-- before the ad platforms approve anything. Do not add a spend column here to "get ahead" — the
-- money ledger already exists as campaign_spend_events with currency='money'.

BEGIN;

-- ── Tracked links ────────────────────────────────────────────────────────────
-- One row per destination a campaign points people at. The token is the whole public surface:
-- https://bemoreswan.com/go/<token> → 302 to destination_url.
CREATE TABLE IF NOT EXISTS campaign_links (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- The public token. Unguessable (64 bits of randomness), because knowing one lets you inflate
  -- another org's click count. Minted by mintLinkToken() in src/utils/campaign-attribution.ts.
  token                 TEXT NOT NULL,

  -- Where the click actually goes. Validated by isDeliverableUrl / safe-fetch's URL rules at the
  -- WRITE boundary, not here — an open redirector is the classic phishing gift, so a link whose
  -- destination was never checked must never be created in the first place.
  destination_url       TEXT NOT NULL,

  -- What the user calls it in the UI ("March webinar — LinkedIn"). Never parsed.
  label                 TEXT,

  -- Where this link is published. Closed vocabulary so the funnel can split paid from organic
  -- without string-matching a UTM. 'paid' is legal here TODAY even though paid campaigns are
  -- not — a tenant running ads on their own account, by hand, can already tag the link.
  medium                TEXT NOT NULL DEFAULT 'organic',
  -- Which network, when medium='paid'. NULL for organic. Free text is deliberate: we do not
  -- control the list, and pinning it would make a tenant's Reddit ad unrecordable.
  network               TEXT,

  -- Soft delete. A link is never hard-deleted: its clicks are history, and a dangling
  -- click_event.link_id would make the funnel silently under-count.
  archived_at           TIMESTAMP,

  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaign_links_medium_check
    CHECK (medium IN ('organic','paid','email','social','other')),
  -- A paid link must say which network, or the funnel's paid row cannot be broken down and the
  -- "which channel worked" question degrades to "some of it was paid".
  CONSTRAINT campaign_links_paid_network_check
    CHECK (medium <> 'paid' OR network IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_links_token_uidx
  ON campaign_links (token);
CREATE INDEX IF NOT EXISTS campaign_links_campaign_idx
  ON campaign_links (campaign_id, archived_at);

-- ── Clicks: APPEND-ONLY ──────────────────────────────────────────────────────
-- Same discipline as campaign_spend_events and revenue_events: a correction appends a row, it
-- never edits one. History that can be rewritten cannot be audited, and this table is the
-- denominator of every cost-per-outcome figure the product will ever show.
CREATE TABLE IF NOT EXISTS campaign_click_events (
  id                    BIGSERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  link_id               INTEGER NOT NULL REFERENCES campaign_links(id) ON DELETE CASCADE,

  -- ── The two independent ways a later action gets tied back to this click ──
  -- Neither is reliable alone, which is the whole reason there are two.
  --
  -- 1. visitor_id — our own first-party cookie, set on the redirect response. Survives the
  --    journey when the destination is a Be More Swan page. In a THIRD-PARTY context (the
  --    tenant's own site) it needs SameSite=None and Safari/ITP caps or drops it outright, so
  --    treating this as "the" answer would quietly over-report Safari users as unattributed.
  visitor_id            TEXT NOT NULL,
  -- 2. click_ref — a per-click id we append to the destination URL as ?bmsc=…, so a capture form
  --    on the destination can echo it back with no cookie involved at all.
  click_ref             TEXT NOT NULL,

  -- The AD NETWORK's own click id, when the ad platform appended one. Recorded because it is the
  -- only key that can ever be reconciled against the network's own reporting, and thrown away
  -- nowhere else. NULL is the common case and is not a failure.
  network_click_id      TEXT,
  -- 'li_fat_id' | 'gclid' | 'fbclid' | 'ttclid' | 'msclkid'. Free text for the same reason
  -- `network` is: new networks appear faster than migrations do.
  network_click_kind    TEXT,

  -- Whatever UTMs rode along, stored whole. Not parsed into columns: they are the caller's data,
  -- they are frequently malformed, and a column per parameter is a migration per campaign tool.
  utm                   JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Provenance, pseudonymised. ⚠️ NEVER store a raw IP here: it is personal data, this table is
  -- retained indefinitely as an audit ledger, and src/utils/ip-pseudonymise.ts already exists
  -- for exactly this. /24 keeps the abuse signal and drops the individual.
  ip_prefix             TEXT,
  referer_host          TEXT,
  -- Deliberately NOT the full user-agent string: a UA is a strong fingerprint, and the only
  -- question the funnel ever asks of it is "was this a bot?".
  is_probable_bot       BOOLEAN NOT NULL DEFAULT false,

  occurred_at           TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_click_link_idx
  ON campaign_click_events (link_id, occurred_at);
CREATE INDEX IF NOT EXISTS campaign_click_campaign_idx
  ON campaign_click_events (campaign_id, occurred_at);
-- The binding lookup: "this visitor just filled a form — which click brought them?" Most recent
-- click for a visitor wins, so the index is ordered to answer that in one seek.
CREATE INDEX IF NOT EXISTS campaign_click_visitor_idx
  ON campaign_click_events (visitor_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_click_ref_uidx
  ON campaign_click_events (click_ref);

-- ── Attributions: click → the thing the person became ────────────────────────
-- The join that makes the funnel a funnel.
--
-- ⚠️ POLYMORPHIC, SO subject_type IS MANDATORY. A campaign click can turn into an audience
-- contact (sign-up form), a discovered lead, or a generic assistant_record — three different
-- tables. vector_embeddings taught this the expensive way: a polymorphic key without its type
-- column produces joins that silently match the WRONG table's row with the same id. There is no
-- foreign key here for the same reason; the type column plus the application's one writer is the
-- integrity story, and cascade deletes are handled by campaign_id above.
CREATE TABLE IF NOT EXISTS campaign_attributions (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  link_id               INTEGER REFERENCES campaign_links(id) ON DELETE SET NULL,
  click_event_id        BIGINT REFERENCES campaign_click_events(id) ON DELETE SET NULL,

  subject_type          TEXT NOT NULL,
  subject_id            INTEGER NOT NULL,

  -- How we tied it: 'click_ref' (the echoed ?bmsc= parameter) or 'cookie' (our first-party
  -- visitor id). Stored because the two have very different reliability, and a funnel that
  -- cannot say which one it used cannot be argued with when a tenant disputes a number.
  bound_via             TEXT NOT NULL,

  bound_at              TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaign_attributions_subject_check
    CHECK (subject_type IN ('audience_contact','discovered_lead','assistant_record')),
  CONSTRAINT campaign_attributions_bound_via_check
    CHECK (bound_via IN ('click_ref','cookie'))
);
-- ⚠️ ONE ATTRIBUTION PER SUBJECT — this index is the model, not an optimisation.
-- A person who clicks three ads and then signs up is ONE outcome, not three. Without this,
-- summing outcomes per campaign double-counts every multi-touch journey and the funnel reports
-- more subscribers than the tenant has. The rule is LAST CLICK AT CAPTURE: the binding is made
-- once, at the moment the subject is created, from that visitor's most recent click. Multi-touch
-- modelling is a reporting question for later, and it can be answered from
-- campaign_click_events, which keeps every touch.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_attributions_subject_uidx
  ON campaign_attributions (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS campaign_attributions_campaign_idx
  ON campaign_attributions (campaign_id, subject_type, bound_at);

COMMIT;

-- ── Row-level security: deliberately NOT enabled here ────────────────────────
-- Identical reasoning to the foot of db/campaigns.sql, and it must stay identical: the
-- application connects as the table OWNER, an owner BYPASSES RLS, so a policy added here would
-- read as protection while never evaluating — which is worse than no policy, because it invites
-- the next reader to skip the application-level check.
--
-- Tenant isolation for these three tables is requireTenant() + organisation_id scoping + an IDOR
-- re-check on any caller-supplied id, exactly as for campaigns and discovery_*.
--
-- ⚠️ ONE EXCEPTION WORTH NAMING: campaign-link-redirect.ts is PUBLIC and unauthenticated — it
-- has no session to scope by. It is safe only because the token is the capability: it resolves
-- exactly one campaign_links row and writes a click for THAT row's organisation_id, never one
-- supplied by the caller. If anything in that function ever starts reading an org id off the
-- request, this comment is the thing that was violated.
--
-- Promoting these into RLS is an R-phase change: add the three table names to
-- db/rls/R1-crown-jewels.sql in the same commit that routes these queries through withTenant().
