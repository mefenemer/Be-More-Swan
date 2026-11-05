-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzz-flyer-look.sql — Help Centre: how a flyer gets its colours (2026-11-05).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzzzzzzz-voices-captions.sql. Love Cat Studio's flyers came
-- back black and white with the words over the photo. New rounds draw a framed photo instead of a
-- full-page one, and colour every page.
--
-- Written from the code: src/lib/flyer.ts flyerPageStyle, src/utils/flyer-briefs.ts flyerColours,
-- the "The look you want" field in src/components/assistant-briefs.js.
-- Each statement reports its own verdict. Bodies are dollar-quoted: apostrophes stay single.

UPDATE help_articles SET
    content_md = replace(content_md,
$$**Photo at the top**, **Full-page photo** and **Words only**.$$,
$$**Photo at the top**, **Framed photo** and **Words only**. Words never sit on the photo.$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer'
RETURNING title, is_published, content_md LIKE '%Framed photo%' AS ok;

UPDATE help_articles SET
    content_md = replace(content_md,
$$## Printing it$$,
$$## The colours

Each page takes its colour from the first of these that it finds:

1. **The look you want** on the flyer form, for example "bright and playful, pink and teal"
2. Your brand colours, from **Brand style** and your extra brand colours
3. If those are only black and white, colours chosen to suit your business and the flyer. The brief tells you when this has happened.

## Printing it$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer' AND content_md NOT LIKE '%## The colours%'
RETURNING title, is_published, content_md LIKE '%## The colours%' AS ok;
