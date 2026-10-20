-- db/swan-index-refile-2026-10-20.sql
-- One-off editorial re-filing of The Swan Index, reviewed 2026-10-20 against the live site
-- (titles, standfirsts and tags). PROD ONLY — staging has its own test pieces.
--
-- Two of these (eating-well, tv-and-film) had NO section. From the same release a piece without a
-- section no longer appears anywhere on the site (src/utils/swan-index/queries.ts HAS_SECTION), so
-- run this before or with that deploy or those two drop off.
--
-- Matched on author handle + slug; a row that has since been renamed simply matches nothing.
-- Expect "UPDATE 10".

UPDATE swan_index_posts p
   SET section = v.section, updated_at = now()
  FROM swan_index_profiles pr,
       (VALUES
         ('restorative-futures',      'restorative-practice-trauma-informed-care', 'operations'),
         ('restorative-futures',      'restorative-practice-in-youth-justice-how-conferencing-reduces-reoffending', 'operations'),
         ('restorative-futures',      'restorative-practice-residential-care', 'operations'),
         ('be-more-swan',             'founders-stop-building-workflows', 'operations'),
         ('be-more-swan',             'growing-saas-ai-powered-blog-writing', 'growth'),
         ('love-cat-studio',          'when-your-hands-know-what-to-do-how-making-something-changes-everything', 'lifestyle'),
         ('love-cat-studio',          'what-if-eating-well-starts-with-listening-rather-than-rules', 'lifestyle'),
         ('kudzu-collaborations-llc', 'why-tv-and-film-productions-need-embedded-wellness-support-too', 'people'),
         ('kudzu-collaborations-llc', 'employee-burnout-signs-high-performers', 'people'),
         ('kudzu-collaborations-llc', 'quiet-turnover-crisis-top-performers-leave', 'people')
       ) AS v(handle, slug, section)
 WHERE pr.id = p.profile_id
   AND lower(pr.handle) = v.handle
   AND p.slug = v.slug;

-- Check: every public piece and its section. Expect no NULL section in the status live/featured rows.
-- SELECT pr.handle, p.slug, p.status, p.section
--   FROM swan_index_posts p JOIN swan_index_profiles pr ON pr.id = p.profile_id
--  WHERE p.status IN ('live', 'featured')
--  ORDER BY p.section NULLS FIRST, p.live_at DESC;
