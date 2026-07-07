-- US 6.1 — C2PA image-byte signing (EU AI Act Art. 50(2)). Adds the columns that hold the signed
-- image manifest summary beside the existing text provenance row (content_provenance).
--
-- SCAFFOLD: these columns stay NULL in production until a signing certificate is provisioned and
-- C2PA_SIGN_CERT / C2PA_SIGN_KEY are set. The signing code path (src/utils/c2pa-sign.ts) is OFF by
-- default and is a byte-for-byte passthrough until then — see docs/content-engine-remaining-build.md §C.
--
--   image_manifest   — ManifestSummary JSON: { urn, signer, algorithm, signedAt, claims }
--   image_signer     — signer identity (leaf-cert subject or configured C2PA_SIGNER_LABEL)
--   image_signed_at  — when the feature/inline image bytes were signed
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — raw-SQL RLS
-- policies must not be clobbered; see the no-db:push rule).

ALTER TABLE content_provenance
  ADD COLUMN IF NOT EXISTS image_manifest   JSONB,
  ADD COLUMN IF NOT EXISTS image_signer     TEXT,
  ADD COLUMN IF NOT EXISTS image_signed_at  TIMESTAMP;
