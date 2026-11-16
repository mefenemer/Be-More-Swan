-- db/z-site-markers.sql — Buying triggers Phase 4 (docs/buying-triggers-plan.md §5, FR#36): "website changed".
--   lead_site_watch.site_markers  the tools last seen on a watched lead's home page (ad tracking, booking, shop,
--                                 website builder; src/lib/triggers/site-watch.ts). NULL = never read: the
--                                 first read is silent.
--   lead_watch.crtsh_checked_at   when we last looked for a first website (crt.sh) for a watched company with
--   lead_watch.launch_domain      no website on record, and the domain found (src/utils/lead-launch-watch.ts).
--
-- APPLY MANUALLY as the DB owner on BOTH environments, before or after the code: until it runs, the code skips
-- both checks quietly (it looks for the columns first). Idempotent: ADD COLUMN IF NOT EXISTS only, nothing is
-- dropped or changed. ALTER TABLE IF EXISTS: lead_site_watch comes from db/z-lead-site-watch.sql.

ALTER TABLE IF EXISTS lead_site_watch ADD COLUMN IF NOT EXISTS site_markers JSONB;
ALTER TABLE lead_watch ADD COLUMN IF NOT EXISTS crtsh_checked_at TIMESTAMPTZ;
ALTER TABLE lead_watch ADD COLUMN IF NOT EXISTS launch_domain TEXT;
