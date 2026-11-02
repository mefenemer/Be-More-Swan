-- db/help-articles-2026-12zzzzzzzzzzzzzzzzz-voices-captions.sql — Help Centre: voices, captions and
-- text that follows the voice (2026-11-02).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzzzzzz-flyers.sql. One new article, and the Video
-- Producer articles' voice lines brought up to date (they said "Six voices").
--
-- ⚠️ INSERTED UNPUBLISHED (is_published = FALSE). Ask Your Team answers from PUBLISHED articles only
-- (src/utils/help-knowledge.ts). Publish with the statement at the foot of this file in the release
-- that ships the voice picker and caption styles — on staging, run it once you have checked it there.
-- The two corrections below are safe on any database: they only replace a sentence that is wrong
-- after the release, so run them with the release, not before.
--
-- Written from the code:
--   voices by language and gender, Listen, Choose — src/public/voice-catalogue.json, src/components/voice-picker.js
--   Add a voiceover, Show captions, the caption look, Time the text to the voice — workspace.html,
--     src/components/caption-style.js, src/utils/post-voiceover.ts, src/lib/captions.ts alignTextToWords
--   1 task for a voiceover, captions and timing free — generate-voiceover.ts
--   chat: voiceover / captions / time_text cards — src/utils/chat-post-action.ts, chat-orchestrator.ts
--   Video Producer setup + brief: voice, captions, caption look — assistant-onboarding-schemas.js, assistant-videos.js
--   Read aloud on the Voice builder, 40 new readings a day — netlify/functions/read-aloud.ts
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzzzzzz-voices-captions --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Your Assistants', 73, 'Voiceovers, Captions and Choosing a Voice', $$
# Voiceovers, Captions and Choosing a Voice

A voiceover is an AI voice reading your words over a post. Captions show those words on the video as they're spoken, so the post still makes sense with the sound off.

## Choosing a voice

Wherever you pick a voice, the voice picker opens. Choose a **language**, then **Female**, **Male** or **All**, and press **Listen** to hear each voice. Listening is free. Press **Use this voice** on the one you like.

There are voices in English (British, Scottish, Irish, American and Australian), French, German, Spanish, Italian, Portuguese, Dutch, Polish, Arabic, Hindi and Japanese. A voice reads your script in the language it's written in, and sounds most natural in its own.

## Adding a voiceover to a post

1. Open the post in the post editor.
2. Press **Add a voiceover**.
3. Write what it should say. Leave out web links, because they sound wrong read aloud.
4. Check the voice, or press **Change** to pick another.
5. Press **Make the voiceover**. It uses 1 task.

Any music already on the post is turned down under the voice. A photo post with a voiceover is published as a short video.

## Captions

Click the voiceover on the timeline to see its settings.

- **Show captions** turns them on or off.
- **How the captions look** sets the style, where they sit, their size, the font, the text colour and the colour of the word being spoken. Tick **Dark band behind the words** to make them easier to read on busy footage. The sample shows your choices.

The style can be the spoken word picked out in colour, a whole phrase at a time, or one large word at a time. Captions are added when the video is made, so they don't show in the editor's preview. Changing them is free.

## Text that follows the voice

If the post has text boxes, press **Time the text to the voice**. Each box then shows while its words are being said. A box whose words aren't said keeps its own timing, and the message under the button names it. This is free.

## Asking your assistant instead

You can ask in chat, for example "add a voiceover to Thursday's post in a British man's voice", "make the captions bigger and put them at the top" or "make the text follow the voice". A card shows what will happen, with a **Listen** button for the voice. Nothing changes until you press the button on the card.

## Video Producer videos

Your Video Producer asks for a voice, whether to show captions and how they should look when you hire it. Every **New video** can change them. Choose a voice in another language and the script is written in that language.

## Hearing your writing voice

On an assistant's profile, the **Voice** builder's **Preview** writes samples in your chosen voice. Press **Read aloud** to hear one in a real voice. Press **Change voice or language** to choose who reads them. In another language, the samples are written in that language. You can hear 40 new readings a day, and ones you've already heard always play again.
$$, FALSE)

ON CONFLICT (title) DO UPDATE SET
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order,
    content_md = EXCLUDED.content_md,
    updated_at = now();

-- The Video Producer articles described the old voice list and caption switch.
UPDATE help_articles SET content_md = replace(content_md,
    '- **Which voice should read your voiceovers?** Six voices, from Warm and friendly to Deep and confident.',
    '- **Which voice should read your voiceovers?** Choose by ear, from women''s and men''s voices in eleven languages. Press **Listen** to hear each one.
- **Should your videos show captions that follow the voice?** Yes or no.
- **How should the captions look?** Optional. Style, position, size, font and colours.'), updated_at = now()
 WHERE title = 'Meet Your Video Producer';

UPDATE help_articles SET content_md = replace(content_md,
    '- **Length**, **Call to action**, **Voice** and **Pictures from**. These start from your set-up answers.',
    '- **Length**, **Call to action**, **Voice**, **Captions** and **Pictures from**. These start from your set-up answers. Press **Listen** to hear the voice and **Change** to pick another. A voice in another language gets a script in that language.'), updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post';

COMMIT;

-- With the release that ships the voice picker and caption styles, publish:
--   UPDATE help_articles SET is_published = TRUE, updated_at = now() WHERE title = 'Voiceovers, Captions and Choosing a Voice';
