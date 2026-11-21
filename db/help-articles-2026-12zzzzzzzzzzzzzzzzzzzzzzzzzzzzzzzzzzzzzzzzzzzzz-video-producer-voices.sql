-- db/help-articles-2026-12zz…z-video-producer-voices.sql — Help Centre: "Meet Your Video Producer" still listed six voices (21 November 2026)
--
-- On staging (checked 2026-11-21) the article still read "Six voices, from Warm and friendly to Deep and confident":
-- the replace in help-articles-2026-12zzzzzzzzzzzzzzzzz-voices-captions.sql had not reached it (its source article file,
-- help-articles-2026-12zzzzzzzzzzzzzz-video-producer.sql, upserts the old text), so the voice-languages edit (PR #793)
-- found nothing to change. This brings the line to today's voice list (19 languages, plan A4) with the same caption
-- lines the voices-captions file adds. Guarded by the old wording: a no-op where it is gone, safe to re-run.
-- No schema change. Apply to BOTH databases (prod after the release that carries PR #793).

BEGIN;

UPDATE help_articles SET content_md = replace(content_md,
    '- **Which voice should read your voiceovers?** Six voices, from Warm and friendly to Deep and confident.',
    '- **Which voice should read your voiceovers?** Choose by ear, from women''s and men''s voices in 19 languages, Welsh among them. Press **Listen** to hear each one.
- **Should your videos show captions that follow the voice?** Yes or no.
- **How should the captions look?** Optional. Style, position, size, font and colours.'),
    updated_at = now()
 WHERE title = 'Meet Your Video Producer'
   AND content_md LIKE '%Six voices, from Warm and friendly to Deep and confident.%'
   AND content_md NOT LIKE '%Should your videos show captions that follow the voice?%';

-- Where the captions lines are already there (the voices-captions edit applied, then the line reset), only the voice line.
UPDATE help_articles SET content_md = replace(content_md,
    '- **Which voice should read your voiceovers?** Six voices, from Warm and friendly to Deep and confident.',
    '- **Which voice should read your voiceovers?** Choose by ear, from women''s and men''s voices in 19 languages, Welsh among them. Press **Listen** to hear each one.'),
    updated_at = now()
 WHERE title = 'Meet Your Video Producer'
   AND content_md LIKE '%Six voices, from Warm and friendly to Deep and confident.%';

COMMIT;

-- Check (expect 1, then 0):
-- SELECT count(*) FROM help_articles WHERE title = 'Meet Your Video Producer' AND content_md LIKE '%19 languages, Welsh among them%';
-- SELECT count(*) FROM help_articles WHERE content_md LIKE '%Six voices, from Warm and friendly%';
