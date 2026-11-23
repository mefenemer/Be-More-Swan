-- db/z-partner-terms-cross-border.sql — Partner Terms 1.3 after the UK / EU / US legal and financial reviews
-- (2026-11-23). Drizzle mirror: db/schema.ts (partners.end_reason, partnerTermsAcceptances).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-terms-cross-border.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-terms-cross-border.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-partner-activity.sql first.
--
--   partners.end_reason      + 'change_declined' — Terms 8.1: not accepting a new version within 60 days of it
--                              taking effect counts as leaving (7.1), with the 7.4(a) run-off
--   partner_terms_acceptances  Terms 1.2: an append-only record of every acceptance (version, channel, who, when).
--                              partners.terms_version / terms_accepted_at still say what's current; this keeps history.

BEGIN;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_end_reason_check;
ALTER TABLE partners ADD CONSTRAINT partners_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('inactivity', 'closure', 'left', 'change_declined', 'breach', 'other'));

CREATE TABLE IF NOT EXISTS partner_terms_acceptances (
    id               SERIAL PRIMARY KEY,
    partner_id       INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    applicant_email  TEXT,
    version          TEXT NOT NULL,
    channel          TEXT NOT NULL CHECK (channel IN ('application', 'partner_page')),
    accepted_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_terms_acceptances_partner_idx ON partner_terms_acceptances (partner_id, accepted_at);

-- Terms 4.5(b)/(c): the VAT position of each partner in each payout run, frozen when the run is created, so a
-- self-billed statement or export never changes if the partner later edits their VAT number (review of #823).
CREATE TABLE IF NOT EXISTS partner_payout_vat (
    batch_id    INTEGER NOT NULL REFERENCES partner_payout_batches(id) ON DELETE CASCADE,
    partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    vat_number  TEXT,
    vat_pence   INTEGER NOT NULL DEFAULT 0 CHECK (vat_pence >= 0),
    PRIMARY KEY (batch_id, partner_id)
);

-- Existing acceptances (staging test partners) become the first history row, once.
INSERT INTO partner_terms_acceptances (partner_id, user_id, version, channel, accepted_at)
SELECT p.id, p.user_id, p.terms_version, 'partner_page', p.terms_accepted_at
  FROM partners p
 WHERE p.terms_version IS NOT NULL AND p.terms_accepted_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM partner_terms_acceptances a WHERE a.partner_id = p.id);

COMMIT;

-- Check: SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'partners_end_reason_check';
--        SELECT count(*) FROM partner_terms_acceptances;
