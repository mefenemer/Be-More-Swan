-- db/z-website-forms.sql — the Website Assistant, step 3b: forms on hosted sites.
-- docs/website-assistant-plan.md §7. Code: src/utils/site-forms.ts (what a POST to /_form does),
-- netlify/functions/site-serve.ts, src/utils/site-render.ts (contact + signup sections).
-- Drizzle mirror: db/schema.ts (siteEnquiries).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-website-forms.sql                              (staging)
--   npm run db:migrate:apply -- --only z-website-forms.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── site_enquiries ─────────────────────────────────────────────────────────
-- A message sent from a site's contact section. It is NOT a sign-up: the sender asked a question,
-- they did not ask for marketing email, so nothing here touches audience_contacts. The owner is
-- notified (site_enquiry_received) and emailed; the Website tab lists them.
-- Sign-up sections need no table: they post through the existing audience-public subscribe path.
--
-- ── notifications ──────────────────────────────────────────────────────────
-- site_enquiry_received is suggested_action (someone is waiting for a reply). The call site passes
-- category and metadata.assistantId; this CASE row keeps the categorisation trigger in step.

BEGIN;

CREATE TABLE IF NOT EXISTS site_enquiries (
    id               SERIAL PRIMARY KEY,
    site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    email            TEXT NOT NULL,
    phone            TEXT,
    message          TEXT NOT NULL,
    page_path        TEXT,
    status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_enquiries_site_idx ON site_enquiries (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS site_enquiries_org_idx ON site_enquiries (organisation_id);

COMMIT;
