-- db/swan-index-wellbeing-section.sql
-- The Swan Index — an eighth section, Wellbeing, beside Lifestyle (owner, 2026-10-20: "add it, not
-- replace"). Wellbeing is health and support AT WORK — staff, teams, the people around the owner;
-- Lifestyle stays the owner's own hours, health and life outside the business.
--
-- Run on BOTH staging and prod. Safe to re-run. Nav order: Wellbeing goes after Culture, Lifestyle
-- moves to last. The new-submission guesser (SECTION_TAG_ALIASES in
-- src/utils/blog-destinations/swanindex.ts) learns the section's tags in the same release.

INSERT INTO swan_index_sections (key, label, standfirst, position, active) VALUES
  ('wellbeing', 'Wellbeing', 'Health, stress and support at work — for everyone in the business.', 7, true)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label, standfirst = EXCLUDED.standfirst, position = EXCLUDED.position, active = true;

UPDATE swan_index_sections SET position = 8 WHERE key = 'lifestyle';

-- Check: eight active sections, Wellbeing at 7, Lifestyle at 8.
-- SELECT key, label, position, active FROM swan_index_sections WHERE active ORDER BY position;
