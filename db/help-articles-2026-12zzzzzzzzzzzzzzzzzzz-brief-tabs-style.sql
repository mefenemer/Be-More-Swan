-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzz-brief-tabs-style.sql — Help Centre: one New brief button, the tabs,
-- and the brand style pop-up (2026-11-05, Love Cat Studio's feedback).
--
-- ⚠️ Run this at RELEASE, on prod with the code: Ask Your Team answers from published articles, and these words
-- describe buttons prod does not have until then. Staging can take it now.
--
-- Written from the code: src/components/assistant-briefs.js (TABS, startNewBrief), brand-style-dialog.js,
-- font-picker.js, and the STARTING A NEW BRIEF prompt in netlify/functions/chat-orchestrator.ts.
-- Each statement reports its own verdict. Bodies are dollar-quoted: apostrophes stay single.

UPDATE help_articles SET
    content_md = replace(content_md,
$$2. Press **New flyer**.
3. Give it a name, say what the flyer is for, and choose the paper: **A5** (the usual handout), **A4** (a poster or notice), **A6** (a postcard) or **DL** (a slim leaflet). Every flyer is portrait and one-sided.
4. Choose a photo: a stock photo, an AI photo, or untick both for a words-only flyer.
5. Press **Next: draft the words for me** (1 task) or **Next: I'll write the words**.$$,
$$2. Press **New brief** and answer your Brand Designer's questions, choosing **A printed flyer or poster**. It suggests the paper and proposes the flyer for you to save.

Prefer a form? Press **Use a form instead**, choose **Printed flyer** under **What is it for?**, then choose the paper: **A5** (the usual handout), **A4** (a poster or notice), **A6** (a postcard) or **DL** (a slim leaflet). Every flyer is portrait and one-sided. Choose a photo, or untick both for a words-only flyer, then press **Next: draft the words for me** (1 task) or **Next: I'll write the words**.$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer'
RETURNING title, is_published, content_md LIKE '%Use a form instead%' AS ok;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 71, 'Briefs and Your Brand Style', $$
# Briefs and Your Brand Style

Your **Brand Designer** works from briefs, and everything it makes starts from your brand style.

## Start a brief

Press **New brief** on the **Briefs** tab. Your Brand Designer asks a few quick questions in the chat beside your briefs, such as what you need it for and how it should feel, then proposes the design that suits: a picture, a printed flyer or a short video clip. Nothing is made or spent until you press the button on the brief.

Prefer not to chat? Press **Use a form instead**.

## Where your briefs are

Briefs move left to right through these tabs. The number on each tells you how many are there.

| Tab | What it means |
|---|---|
| **Not started** | Saved, and waiting for you to ask for options |
| **Being made** | Your Brand Designer is working on it. Nothing to do yet |
| **To review** | Options are ready. Choose **Use this**, or **Not this** and say why |
| **Approved** | Finished, and in My Content |
| **Archived** | Briefs you stopped. Anything you had approved stays in My Content |

## Talk about one option

Press **Select**, then click an option or a brief. It appears above the chat's message box, so you can say what to change, for example "like this one, but brighter". Press Esc to stop selecting.

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
