-- db/help-articles-2026-12zz…z-voice-languages.sql — Help Centre: voices in Welsh and seven more languages; captions in the language spoken (20 November 2026)
--
-- Plan A4 (docs/video-producer-screen-walkthrough-plan.md §11.4). The voice list (src/public/voice-catalogue.json) now
-- has Welsh, Swedish, Danish, Norwegian, Finnish, Greek, Czech and Romanian voices, and a video's caption files are named
-- and translated from the language it is spoken in (a Welsh video's captions are Welsh, and English is a translation).
-- Three in-place replace() edits: each is a no-op once applied (the old wording is gone), safe to re-run. No schema
-- change. Apply to BOTH databases AFTER the release that carries A4 reaches them. Named to sort after every other
-- 2026-12z… video article (the share-captions article it edits sorts before it).

BEGIN;

UPDATE help_articles SET content_md = replace(content_md,
    'There are voices in English (British, Scottish, Irish, American and Australian), French, German, Spanish, Italian, Portuguese, Dutch, Polish, Arabic, Hindi and Japanese.',
    'There are voices in English (British, Scottish, Irish, American and Australian), Welsh, French, German, Spanish, Italian, Portuguese, Dutch, Polish, Swedish, Danish, Norwegian, Finnish, Greek, Czech, Romanian, Arabic, Hindi and Japanese.'),
    updated_at = now()
 WHERE title = 'Voiceovers, Captions and Choosing a Voice'
   AND content_md LIKE '%Polish, Arabic, Hindi and Japanese.%';

UPDATE help_articles SET content_md = replace(content_md,
    'from women''s and men''s voices in eleven languages.',
    'from women''s and men''s voices in 19 languages, Welsh among them.'),
    updated_at = now()
 WHERE title = 'Meet Your Video Producer'
   AND content_md LIKE '%voices in eleven languages.%';

UPDATE help_articles SET content_md = replace(content_md,
    '**English (as spoken)** downloads free as SRT or VTT, for YouTube, Vimeo, your website or an editor.',
    'The captions **as spoken**, in the language of the voice (for example Welsh for a Welsh voiceover), download free as SRT or VTT, for YouTube, Vimeo, your website or an editor.'),
    updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md LIKE '%**English (as spoken)** downloads free%';

UPDATE help_articles SET content_md = replace(content_md,
    'To add another language, choose it and press **Translate**.',
    'To add another language, choose it and press **Translate**. A video spoken in Welsh or another language can have English captions this way.'),
    updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md LIKE '%To add another language, choose it and press **Translate**. Each language%';

COMMIT;

-- Check (expect 1, 1, 1, 1):
-- SELECT count(*) FROM help_articles WHERE title = 'Voiceovers, Captions and Choosing a Voice' AND content_md LIKE '%Welsh, French, German%';
-- SELECT count(*) FROM help_articles WHERE title = 'Meet Your Video Producer' AND content_md LIKE '%19 languages, Welsh among them%';
-- SELECT count(*) FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%captions **as spoken**, in the language of the voice%';
-- SELECT count(*) FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%can have English captions this way%';
