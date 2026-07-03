-- Migration: rebrand live help_articles content (US4.2). Idempotent string replacement.
-- No legal_documents table exists — legal copy is static HTML (rebranded in the repo).
-- Applied manually (like other db/*.sql) — no schema change, so RLS is untouched.

UPDATE help_articles SET
  title = replace(replace(replace(title,
            'Aura-Assist', 'Be More Swan'),
            'Aura Assist', 'Be More Swan'),
            'aura-assist.com', 'bemoreswan.com'),
  content_md = replace(replace(replace(replace(replace(content_md,
            'Aura-Assist', 'Be More Swan'),
            'Aura Assist', 'Be More Swan'),
            'The Aura Team', 'The Be More Swan Team'),
            'Aura Team', 'Be More Swan Team'),
            'aura-assist.com', 'bemoreswan.com')
WHERE title LIKE '%Aura%' OR content_md LIKE '%Aura%' OR content_md LIKE '%aura-assist.com%';
