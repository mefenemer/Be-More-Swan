-- db/help-articles-2026-12zzzzzz-data-export.sql — Help Centre: Export Your Data (2026-10-20).
--
-- Sorts after db/help-articles-2026-12zzzzz-referrals.sql. No article covered the self-serve
-- workspace export, so Ask Your Team (which answers from these articles, src/utils/help-knowledge.ts)
-- sent "Can I export my data?" to the Audience Excel export. Describes the export exactly as the
-- code does it:
--   • where: Account settings → My Agreements → Your data (user-settings.html #data-export-card)
--   • what: one JSON file — your own records for everyone, plus the organisation's workspace for
--     owners and admins (src/utils/workspace-export.ts, EXPORT_WORKSPACE_ROLES, WORKSPACE_TABLES)
--   • passwords, tokens, secrets and internal storage keys stripped (workspace-export.ts SECRET_COLUMN)
--   • media files listed by name and type, not included (workspace-export.ts header)
--   • one a day; link lasts 24 hours, emailed too, re-downloadable until then (data-export.ts,
--     data-export-background.ts, data-export-download.ts); file purged after expiry
--     (storage-lifecycle-cleanup.ts)
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzz-data-export --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Getting Started', 50, 'Export Your Data', $$
# Export Your Data

You can download a copy of your data at any time, yourself — no need to ask us.

## How to export

1. Open your account menu (your initials, top right) and choose **Account settings**.
2. Go to the **My Agreements** tab and find the **Your data** card.
3. Press **Export my data**.

Your export is prepared in the background — usually a minute or two. When it is ready, a **Download export** button appears on the card and we email you the link too.

## What is in it

The export is a single machine-readable **JSON file**.

- **Everyone** gets their own records: your account and profile, the agreements you have accepted, your support tickets and issue reports, your activity log and your chats with your assistants.
- **Owners and admins** also get the whole workspace: your assistants, posts, blogs, leads, audience, email, campaigns, products, goals, website, bookings, connections, plan and invoices, and the list of team members.

If you are not an owner or admin, ask one of them for the workspace export.

## What is left out

- **Passwords, access tokens, secrets and internal storage keys** are removed from every record.
- **Media files themselves** (images, videos, sound) are not inside the file. Each one is listed by name and type — download the files from your media library.

## Good to know

- You can request **one export a day**.
- The download link lasts **24 hours**. You can download it as many times as you like until then. After that the link stops working and the file is deleted.
- Need a spreadsheet of your audience contacts or leads instead? Use the **Export** option on those pages — this account export is the full copy of your data.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

COMMIT;
