-- Assistant "Works with" — which OTHER assistants a role has been built to operate alongside,
-- and whether it can run on its own.
-- Drizzle mirror: db/schema.ts (masterAssistants.worksWith).
-- Seed: db/seed-assistant-content.ts.
-- Powers Admin → Master Data → Assistants ("Works With" field) and the public catalogue card,
-- detail modal and role detail page.
--
-- Why: the catalogue card labelled the `integrations` chips "Works with". That reads wrong for
-- external tools (Gmail, Notion, LinkedIn) — those are things the assistant CONNECTS to — and it
-- left no way to say the thing users actually ask: does this assistant need other assistants, or
-- does it stand on its own? So `integrations` is now labelled "Connects with", and "Works with"
-- becomes this separate, first-class field about assistant-to-assistant fit.
--
-- Storage model: a single ordered string[] on master_assistants, matching the existing
-- key_features / integrations copy columns (see db/assistant-content.sql for why the copy values
-- live on the row rather than in a catalog/value split).
--
-- Entry vocabulary — each element is EITHER:
--   'standalone'  — the reserved key; renders as a "Standalone" pill meaning the role delivers
--                   value with no other assistant hired.
--   <role_key>    — a master_assistants.role_key (e.g. 'blog_writer'); renders as that
--                   assistant's current NAME, so a rename in Master Data flows through
--                   everywhere instead of stranding a hardcoded label.
-- Anything else is rendered verbatim, so an admin typo degrades to a plain pill rather than a
-- blank card. Both kinds can coexist: ['standalone', 'blog_writer'] is a valid, common shape.
--
-- Deliberately NOT symmetric and NOT derived: this is an editorial claim about how the roles fit
-- together, owned by a super user in the admin portal — not a graph inferred from the code.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE master_assistants ADD COLUMN IF NOT EXISTS works_with JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN master_assistants.works_with IS
  'string[] — assistant-to-assistant fit. Elements are the reserved key ''standalone'' or another master_assistants.role_key. Distinct from `integrations`, which is external tools ("Connects with").';

-- Backfill: every currently LIVE (non-coming-soon) role stands on its own today — none of them
-- require another assistant to be hired first. Seeding that explicitly means the new section
-- renders something true on day one instead of being invisible until an admin fills it in.
-- Only touches rows still holding the '[]' default, so a re-run never clobbers an admin edit.
UPDATE master_assistants
   SET works_with = '["standalone"]'::jsonb
 WHERE works_with = '[]'::jsonb
   AND coming_soon = false
   AND role_key <> 'campaign_orchestrator';

-- The Campaign Assistant is the one role that is NOT standalone: it holds no connector of its own
-- (connection-map.ts gives it an empty connector policy) and reaches every channel by commissioning
-- another assistant. Its `integrations` column has been naming those assistants — which is exactly
-- the confusion this column exists to fix — so move them here and leave `integrations` empty.
-- Guarded on the exact legacy value so a re-run after an admin edit is a no-op.
UPDATE master_assistants
   SET works_with   = '["social_media_manager","blog_writer","lead_qualifier"]'::jsonb,
       integrations = '[]'::jsonb
 WHERE role_key = 'campaign_orchestrator'
   AND works_with = '[]'::jsonb;
