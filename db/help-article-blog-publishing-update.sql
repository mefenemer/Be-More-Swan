-- db/help-article-blog-publishing-update.sql
-- ONE article, applied on its own. Generated 2026-08-31 from db/seed-help-articles.sql so the two
-- stay byte-identical — re-generate rather than hand-editing this file.
--
-- Why not the whole seed: that file failed to apply through the Neon SQL editor on 2026-08-24 (its
-- own header records it), and the path that worked was per-article UPDATEs. Ten of its thirteen
-- articles are already byte-identical to what is live, so a full re-seed rewrites what it need not.
--
-- The leading suspect there was a CLIENT-SIDE statement splitter cutting at a semicolon inside a
-- dollar-quoted body — invisible to Postgres, fatal to a web console. This article had exactly one
-- such semicolon, in the sentence about page builders stripping the script tag. It is now an em
-- dash in BOTH files, so there is no semicolon left anywhere but the statement terminator below.
--
-- ⚠️ UPDATE, not INSERT … ON CONFLICT: the title is unchanged, so this edits the live row in place.
-- ⚠️ RETURNING is load-bearing — a bare UPDATE reads "No result" in the Neon editor whether it
--    changed one row or none, so success and failure look identical. Expect exactly ONE row back.
-- ⚠️ The body is dollar-quoted: everything inside is literal. Never double an apostrophe in here.

UPDATE help_articles
SET content_md = $$
# Publishing Your Blog to Your Own Website

Your Blog Writing Assistant researches, drafts and schedules long-form posts. Once you approve one,
it goes live in two places at once:

| Where | What it is |
|-------|------------|
| **Your website** | A drop-in embed that renders your posts on a page of your own site, styled to match |
| **A shareable link** | Every post also gets its own permanent web address you can send to anyone |

You do not need a developer, a plugin, or a website rebuild. You need one line of code on one page.

## Step 1: Get your embed snippet

1. Open your Blog Writing Assistant and click **Write Blog Post**. This opens Blog Studio.
2. On the left, find the **Widget** panel.
3. At the bottom is your **Embed snippet**. Click **Copy**.

What you copied looks like this:

    <script async src="https://bemoreswan.com/widget.js"
            data-bms-key="wgt_your_key_here" data-bms-mount="#bms-blog"></script>

The `wgt_` value is your own private identifier. It is created automatically the first time you open
Blog Studio, it never changes, and it only ever shows your published posts.

## Step 2: Add it to your website

Paste two things onto whichever page should hold your blog:

1. `<div id="bms-blog"></div>` where you want the posts to appear.
2. The snippet you copied, anywhere on the same page.

That is the whole installation. The embed brings its own styling and cannot clash with your site
design, because it renders in an isolated container.

### What if I do not have a blog page yet?

This is the most common situation, and it is a fair bit easier than it sounds. You are not building a
blog — you are making one nearly-empty page for the embed to sit on.

- **Website builder** (Wix, Squarespace, Shopify, Webflow): add a new blank page called Blog, drop in
  an **Embed** or **Custom Code** block, and paste both lines into it. Then add Blog to your menu.
- **WordPress**: add a new Page, use a **Custom HTML** block, paste both lines, publish.
- **Hand-built site**: create a new page, paste both lines into the body, and add a link to it in
  your navigation.

If your builder offers a "code" or "HTML" block anywhere, that is the one you want.

## Step 3: Make it look like yours

Back in the Widget panel you can set:

- **Accent colour** — used for links and buttons in your posts.
- **Font family** — System, Serif, or Inter.
- **Show AI transparency badge** — whether posts your assistant drafted carry a small
  "AI-assisted content" label. Posts you wrote yourself are never labelled either way.

Click **Save settings**. Changes apply to your live blog straight away.

## Being found on Google

The embed is designed for your readers. Search engines are handled separately, and automatically:
every published post also gets its own standalone page at an address like

    https://bemoreswan.com/b/wgt_your_key_here/your-post-title

These pages carry proper titles, descriptions, social-sharing previews and structured data. They are
what search engines read, and they are what you should share on social media or in a newsletter.

To help Google find them faster, submit this address in Google Search Console:

    https://bemoreswan.com/b/wgt_your_key_here/sitemap.xml

You can also connect Search Console from the assistant's **Connections** tab, or from the
**Search performance** panel in Blog Studio — they are the same connection, so either will do. Your
assistant will then spot posts that are losing search traffic and flag them for a refresh, and the
Search Impressions and Organic Clicks figures on its Overview start filling in.

### The Your site URL and Post URL pattern settings

These two optional fields tell search engines to credit **your** domain for a post instead of ours.

**Fill in both, or neither.** They only take effect together, and this is not a technicality: the
pattern must contain `{slug}` so that each post gets its own distinct address. Setting only the site
URL would point every post at the same page and tell Google your entire blog is duplicate content.

Only fill them in if your website genuinely serves each post at its own address, for example
`https://yoursite.com/blog/a-post-title`. If your blog lives on one page with the embed on it — which
is the normal setup described above — leave both blank.

## Sharing each post further

Your blog is always the original. From the assistant's **Connections** tab you can also send every
published post to:

- **LinkedIn** — each post is shared to your feed as a short lead-in linking back to the full
  article, so the reading (and the search credit) stays on your own page. It uses the same LinkedIn
  connection as the rest of your workspace, and turning it off here never disconnects LinkedIn.
- **The Swan Index** — our own business magazine. Posts are submitted under your byline for an
  editor to review, again linking back to you as the original.

Both are optional and both are per-post: open a post in Blog Studio and untick anywhere you would
rather it did not go.

Publishing straight into a blog you already own elsewhere — WordPress, Ghost and the like — is
built but not switched on yet. It is not in the Connections tab today, and we will say so here when
it is.

## If something is not working

**The blog area is empty.** Check the page actually contains `<div id="bms-blog"></div>` — the embed
needs something to render into, and the id must match exactly. Also confirm your builder did not strip
the script tag — some page builders only allow scripts inside a dedicated Embed or Custom Code block.

**It says "No posts yet."** The embed is connected and working — you simply have no *published*
posts. Drafts and scheduled posts do not appear until they go live. Check the Review Queue for posts
waiting on your approval.

**It says "Unable to load posts."** The key is usually wrong or incomplete. Copy the snippet again
rather than retyping it.

**A post looks wrong or you want it taken down.** Open it in Blog Studio and use **Unpublish**. It
disappears from your site immediately.
$$,
    updated_at = NOW()
WHERE title = 'Publishing Your Blog to Your Own Website'
RETURNING id, title, is_published, updated_at;
