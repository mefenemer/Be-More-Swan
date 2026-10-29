-- db/z-platform-reviews.sql — reviews OF Be More Swan, from the people using it (beta testers first).
-- src/utils/platform-reviews.ts, netlify/functions/platform-review.ts (the person's own review),
-- netlify/functions/admin-platform-reviews.ts (Admin → Customers → Reviews).
-- Drizzle mirror: db/schema.ts (platformReviews, platformReviewAsks).
--
-- Not the same thing as org_reviews (db/z-reviews.sql): those are a CUSTOMER'S reviews of THEIR
-- business. These are about us, and are never shown inside anyone's workspace.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately), BEFORE or AFTER the code deploys — until it runs, nobody is asked and the admin
-- page says "not set up yet". Idempotent: CREATE … IF NOT EXISTS only. Nothing is dropped or altered.
--
-- ── platform_reviews (one per person) ──────────────────────────────────────
-- body: their words, word for word. display_name / display_detail: how they want to be named if it
-- is quoted ("Sarah K." / "Florist, Leeds"). consent_to_publish: may we quote it publicly at all —
-- an admin can only publish a review whose author said yes.
-- incentive_note: what they got from us, shown beside any public quote. UK law (DMCC Act 2024) bans
-- hiding that a reviewer was given something; beta testers had free access, so theirs says so.
-- status: pending (just sent) | published (may be quoted) | hidden (not quoted, STILL COUNTED in any
-- average — dropping the bad ones from a score is a banned practice too).
-- shared_to: which public sites they clicked through to afterwards ('trustpilot', 'g2'). Both are
-- offered to EVERY reviewer whatever their stars — sending only happy people there is review gating.
--
-- ── platform_review_asks (one per person) ──────────────────────────────────
-- When the app asked, how often, "maybe later" (snoozed_until), "don't ask me again" (opted_out_at)
-- and an admin's emailed request (requested_at).

BEGIN;

CREATE TABLE IF NOT EXISTS platform_reviews (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organisation_id     INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
    rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body                TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    display_name        TEXT,
    display_detail      TEXT,
    consent_to_publish  BOOLEAN NOT NULL DEFAULT false,
    incentive_note      TEXT,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'hidden')),
    source              TEXT NOT NULL DEFAULT 'in_app' CHECK (source IN ('in_app', 'email')),
    shared_to           TEXT[] NOT NULL DEFAULT '{}',
    decided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at          TIMESTAMP,
    created_at          TIMESTAMP NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_reviews_user_uq ON platform_reviews (user_id);
CREATE INDEX IF NOT EXISTS platform_reviews_status_idx ON platform_reviews (status, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_review_asks (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ask_count       INTEGER NOT NULL DEFAULT 0,
    last_asked_at   TIMESTAMP,
    snoozed_until   TIMESTAMP,
    opted_out_at    TIMESTAMP,
    requested_at    TIMESTAMP,
    requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

COMMIT;

-- Check it landed:
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('platform_reviews', 'platform_review_asks');
