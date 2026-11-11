-- db/help-articles-qr-flyer-editor-2026-11-11.sql — the design editor's QR code buttons, in 'Making a Printed Flyer'.
--
-- Why a second file: db/help-articles-qr-links-2026-11-11.sql added this line next to "If you remove your
-- **logo** or **QR code**, a button appears to put it back.", but neither database's article has that sentence,
-- so its UPDATE ran and changed nothing (checked 2026-11-11 on both). This attaches the same line to one that
-- both databases do have: "- Your **QR code link** starts from …", added by that file's third UPDATE.
--
-- APPLY MANUALLY in the Neon SQL Editor, on staging and prod separately. Idempotent: does nothing if the line
-- is already there, or if the anchor is missing (RETURNING shows no row then).

BEGIN;

UPDATE help_articles SET
    content_md = replace(content_md,
$$- Your **QR code link** starts from $$,
$$- **QR code link** in the design editor shows the link your QR code opens and lets you change it. On a design without one, **+ QR code** adds one, starting from a suggested link: your introductory offer's link, else your booking link, else your website.
- Your **QR code link** starts from $$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer'
  AND content_md LIKE '%- Your **QR code link** starts from %'
  AND content_md NOT LIKE '%**QR code link** in the design editor shows the link%'
RETURNING title, content_md LIKE '%**QR code link** in the design editor shows the link%' AS ok;

COMMIT;
