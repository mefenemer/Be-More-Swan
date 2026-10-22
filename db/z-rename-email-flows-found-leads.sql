-- db/z-rename-email-flows-found-leads.sql
-- Two user-facing renames decided by the owner on 2026-10-22, carried into the copy that lives in the
-- database (the code and chat prompts were renamed in the same change):
--
--   • An Email Marketing Assistant series is an "email flow", and its tab "Email Flows" — "campaign"
--     now belongs to the Marketing Campaign Orchestrator alone.
--   • The Lead Generation Assistant's "Enrichment" tab is "Found leads".
--
-- (The Campaign Orchestrator's "Orders" tab became "Briefs" too, but no stored copy names it.)
--
-- Internal names are unchanged: newsletter_sequences, campaign_orders, the `datahub` tab id, every
-- role_key. Only text a person reads is touched.
--
-- Idempotent: every statement only rewrites rows that still contain an old phrase, and the new
-- phrases never contain an old one, so a re-run changes nothing. Each statement ends in RETURNING so
-- the Neon editor reports what it changed (a bare UPDATE prints "No result" either way).
--
-- No semicolons inside string literals: the Neon SQL editor splits pasted scripts on them.

-- Help Centre articles (also what "Ask Your Team" answers from).
UPDATE help_articles
   SET content_md = replace(replace(replace(replace(replace(replace(replace(replace(content_md,
           'Email Campaigns', 'Email Flows'),
           'Email campaigns', 'Email flows'),
           'email campaigns', 'email flows'),
           'Email Campaign', 'Email Flow'),
           'Email campaign', 'Email flow'),
           'email campaign', 'email flow'),
           '**Enrichment**', '**Found leads**'),
           'Enrichment tab', 'Found leads tab'),
       title = replace(replace(title, 'Email Campaign', 'Email Flow'), 'Email campaign', 'Email flow'),
       updated_at = now()
 WHERE content_md ~ '(E|e)mail (C|c)ampaign|\*\*Enrichment\*\*|Enrichment tab'
    OR title ~ 'Email (C|c)ampaign'
RETURNING title, is_published, length(content_md) AS chars;

-- The assistant catalogue: tagline, description and the key-feature bullets.
UPDATE master_assistants
   SET tagline = replace(replace(tagline, 'email campaigns', 'email flows'), 'email campaign', 'email flow'),
       description = replace(replace(description, 'email campaigns', 'email flows'), 'email campaign', 'email flow'),
       key_features = replace(replace(replace(key_features::text,
           'Email Campaigns', 'Email Flows'), 'email campaigns', 'email flows'), 'email campaign', 'email flow')::jsonb
 WHERE coalesce(tagline, '') ~* 'email campaign'
    OR coalesce(description, '') ~* 'email campaign'
    OR key_features::text ~* 'email campaign'
RETURNING role_key, tagline;

-- The public assistant showcase pages.
UPDATE assistant_showcases
   SET content = replace(replace(replace(content::text,
           'Email Campaigns', 'Email Flows'), 'email campaigns', 'email flows'), 'email campaign', 'email flow')::jsonb
 WHERE content::text ~* 'email campaign'
RETURNING role_key;
