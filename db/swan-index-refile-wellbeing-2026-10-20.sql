-- db/swan-index-refile-wellbeing-2026-10-20.sql
-- Moves the workplace-wellbeing pieces into the new Wellbeing section. PROD ONLY, and only AFTER
-- db/swan-index-wellbeing-section.sql (admin-swan-index refuses an unknown section, and the public
-- pages join the label from swan_index_sections — a key with no row there shows no label).
--
-- Chosen from title, standfirst and tags on 2026-10-20. Staff turnover, hiring and care-practice
-- pieces stay where they are. The Neon console shows "0 rows" for an UPDATE; run the check below.

UPDATE swan_index_posts p
   SET section = 'wellbeing', updated_at = now()
  FROM swan_index_profiles pr,
       (VALUES
         ('kudzu-collaborations-llc', 'why-employee-wellness-support-actually-matters'),
         ('kudzu-collaborations-llc', 'why-tv-and-film-productions-need-embedded-wellness-support-too'),
         ('kudzu-collaborations-llc', 'employee-burnout-signs-high-performers'),
         ('kudzu-collaborations-llc', 'hidden-cost-only-support-system'),
         ('kudzu-collaborations-llc', 'office-manager-burnout-emotional-labor'),
         ('kudzu-collaborations-llc', 'substance-use-work-small-business'),
         ('kudzu-collaborations-llc', 'nurse-coaching-medical-leave-workplace-return'),
         ('restorative-futures',      'restorative-practice-staff-burnout-resilience')
       ) AS v(handle, slug)
 WHERE pr.id = p.profile_id
   AND lower(pr.handle) = v.handle
   AND p.slug = v.slug;

-- Check: expect 8 rows.
-- SELECT pr.handle, p.slug, p.status FROM swan_index_posts p
--   JOIN swan_index_profiles pr ON pr.id = p.profile_id WHERE p.section = 'wellbeing' ORDER BY p.slug;
