-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzz-brief-tabs-style.sql — Help Centre: one New brief button, the tabs,
-- the brand style pop-up, and the design editor (2026-11-05, Love Cat Studio's feedback).
--
-- ⚠️ Run this at RELEASE, on prod with the code: Ask Your Team answers from published articles, and these words
-- describe buttons prod does not have until then. Staging can take it now.
--
-- Written from the code: src/components/assistant-briefs.js (TABS, startNewBrief), brand-style-dialog.js,
-- font-picker.js, design-studio.js, src/utils/brief-from-chat.ts (AI_PICTURE_ANSWER), and the STARTING A NEW
-- DESIGN prompt in netlify/functions/chat-orchestrator.ts.
-- Each statement reports its own verdict. Bodies are dollar-quoted: apostrophes stay single.

UPDATE help_articles SET
    content_md = replace(content_md,
$$2. Press **New flyer**.
3. Give it a name, say what the flyer is for, and choose the paper: **A5** (the usual handout), **A4** (a poster or notice), **A6** (a postcard) or **DL** (a slim leaflet). Every flyer is portrait and one-sided.
4. Choose a photo: a stock photo, an AI photo, or untick both for a words-only flyer.
5. Press **Next: draft the words for me** (1 task) or **Next: I'll write the words**.$$,
$$2. Press **New brief** and answer your Brand Designer's questions, choosing **A printed flyer or poster**. It suggests the paper (**A5** for a handout, **A4** for a poster, **A6** for a postcard or **DL** for a slim leaflet), and the flyer opens in the editor as soon as it is ready. Every flyer is portrait and one-sided.$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer'
RETURNING title, is_published, content_md LIKE '%opens in the editor as soon as it is ready%' AS ok;

-- The flyer article's "Save and ask … for pages" button is now "Save and make the flyer", which opens the editor.
-- Only the sentence's start is matched: the rest differs depending on whether the flyer-look file has run.
UPDATE help_articles SET
    content_md = replace(content_md,
$$Press **Save and ask … for pages**. Your Brand Designer draws up to three pages from your words:$$,
$$Press **Save and make the flyer** (or **Make the flyer** on the brief). The editor opens and shows the flyer as soon as it is ready, to change or approve with **Use this design**. Your Brand Designer draws up to three pages from your words:$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer'
RETURNING title, is_published, content_md LIKE '%Save and make the flyer%' AS ok;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 71, 'Briefs and Your Brand Style', $$
# Briefs and Your Brand Style

Your **Brand Designer** works from briefs, and everything it makes starts from your brand style.

## Start a brief

Press **New brief** on the **Briefs** tab. Your Brand Designer asks a few quick questions in the chat beside your briefs, such as what you need it for and how it should feel. Once you answer, it chooses the design that suits, starts making it straight away and opens it in the editor. A short video clip goes to its brief instead, since videos are not changed in the editor.

Only one answer costs anything: **An AI-made picture (1 task)**. A stock photo, or just words and colours, is free.

## Change your design

The editor shows your design on the left and the chat on the right.

- **Click** any words, the picture or a shape to change it: the font, size, colour, a background behind the words and how see-through it is, or the picture's strength.
- **Change the words** in the **Words** box that appears when you click them, or double-click them on the design and type. With nothing selected, **Change the words** lists every piece of text on the design.
- **Drag** it to move it, or drag its corner to make it bigger or smaller. Pink guide lines show when it lines up with the page or something else on it. Hold Alt while dragging to turn them off.
- **+ Add picture** adds one of your own, from your library, from stock, or made by AI (which uses a task). Click a picture to **Crop** it, drag it inside its frame and zoom, or to **Replace** it. Your main picture always sits behind everything else.
- **+ Add shape** adds a rectangle, circle or line. **Layer order** moves the selected part in front of or behind the others, and **Duplicate** copies it.
- Words can also be **italic** or **underlined**, with their own **line spacing**.
- If you remove your **logo** or **QR code**, a button appears to put it back.
- **+ Add words** puts a new line of text on the page, **Page colour** changes the background, and its **Transparency** slider fades that colour towards white paper.
- **Undo** and **Redo** step back and forward. Every change saves itself.
- **Select**, then click part of the design, to ask your Brand Designer about it in the chat, for example "make this stand out more". It shows you the change on a card, and nothing changes until you press **Change it**. It can move or recolour your contact details and offer, but only you can change their wording.
- **Full screen** gives you more room. Press Esc to leave it.
- **More options** takes you back to the brief, to ask for different designs. **Use this design** finishes it and puts it in My Content. For a flyer, that includes the print-ready PDFs.

You can open any option still waiting for you with **Open in editor**.

## Where your briefs are

Briefs move left to right through these tabs. The number on each tells you how many are there.

| Tab | What it means |
|---|---|
| **Not started** | Saved, and waiting for you to ask for options. The tab opens here |
| **Being made** | Your Brand Designer is working on it. Nothing to do yet |
| **To review** | Options are ready. Choose **Use this**, or **Not this** and say why |
| **Approved** | Finished, and in My Content |
| **Archived** | Briefs you stopped. Anything you had approved stays in My Content |

## Not this one

Press **Not this** on an option you don't want, then choose a reason, or type your own and press **Not this one**. It leaves the list, and your Brand Designer takes the reason into account in this brief's next round.

## Changing a brief

**Edit brief** changes what the brief asks for. Saving changes only the brief: anything already made stays as it is, and the next round uses your changes.

## Your brand style

Press **View or change** at the top of the Briefs tab to see and change your colours, font and picture guidelines without leaving the page. Fonts are listed in their own style, with an example of the one you choose.

If it says no brand colours are chosen yet, the black and white you see is only what we use until you pick your own. You can also ask your Brand Designer to help you choose in the chat, and save what you settle on from there.
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order,
    content_md = EXCLUDED.content_md,
    is_published = EXCLUDED.is_published,
    updated_at = now()
RETURNING title, is_published;
