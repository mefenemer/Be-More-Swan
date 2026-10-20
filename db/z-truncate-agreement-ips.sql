-- db/z-truncate-agreement-ips.sql — truncate the full IP addresses already stored on Terms and DPA
-- acceptances, to match what the privacy policy promises (privacy.html: "IP addresses recorded in
-- audit and security tables are truncated before they are stored").
--
-- Until 2026-10-20, netlify/functions/accept-tos.ts and accept-dpa.ts stored the whole address. They
-- now run it through src/utils/ip-pseudonymise.ts. This brings the existing rows in line, using the
-- SAME rule:
--   IPv4 → last octet replaced with 'x'          203.0.113.9   → 203.0.113.x
--   IPv6 → first 4 groups kept + ':x:x:x:x'      2001:db8:a:b:c:d:e:f → 2001:db8:a:b:x:x:x:x
--   anything else → NULL (never stored raw)
--
-- ⚠️ IRREVERSIBLE: the discarded part of each address is gone. That is the point.
-- Idempotent: already-truncated values (ending '.x' or ':x') are left alone, so a re-run is a no-op.
-- APPLY MANUALLY as the DB owner, to BOTH environments, AFTER the code fix is deployed (otherwise a
-- new acceptance in between stores a full address again; re-running then catches it).
--   npm run db:migrate:apply -- --only z-truncate-agreement-ips                              (staging)
--   npm run db:migrate:apply -- --only z-truncate-agreement-ips --url-var DATABASE_URL_PROD  (prod)
--
-- Preview first (read-only):
--   SELECT 'tos' AS t, count(*) FROM tos_acceptances WHERE ip_address IS NOT NULL AND ip_address !~ '[.:]x$'
--   UNION ALL
--   SELECT 'dpa', count(*) FROM dpa_acceptances WHERE ip_address IS NOT NULL AND ip_address !~ '[.:]x$';

BEGIN;

UPDATE tos_acceptances
SET ip_address = CASE
    WHEN ip_address ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
        THEN regexp_replace(ip_address, '\.\d{1,3}$', '.x')
    WHEN position(':' IN ip_address) > 0
        THEN array_to_string((string_to_array(ip_address, ':'))[1:4], ':') || ':x:x:x:x'
    ELSE NULL
END
WHERE ip_address IS NOT NULL AND ip_address !~ '[.:]x$';

UPDATE dpa_acceptances
SET ip_address = CASE
    WHEN ip_address ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
        THEN regexp_replace(ip_address, '\.\d{1,3}$', '.x')
    WHEN position(':' IN ip_address) > 0
        THEN array_to_string((string_to_array(ip_address, ':'))[1:4], ':') || ':x:x:x:x'
    ELSE NULL
END
WHERE ip_address IS NOT NULL AND ip_address !~ '[.:]x$';

COMMIT;
