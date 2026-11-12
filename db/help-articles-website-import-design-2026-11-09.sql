-- db/help-articles-website-import-design-2026-11-09.sql — Help Centre: bringing your current website
-- across (the import, 2026-11-08/09: links, look, platforms, blog posts, products, old addresses), and
-- designing your website (the design settings added 2026-11-08). Two NEW articles; nothing else changes.
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted, NO semicolons inside
-- the body. ⚠️ Apply with the release that takes the import work to production (production still caps
-- an import at 8 pages until then). Staging first, then prod:
--   node scripts/db-migrate.mjs apply --only help-articles-website-import-design-2026-11-09 --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Your Assistants', 76, 'Bringing Your Current Website Across', $$
# Bringing Your Current Website Across

If you already have a website, your **Website Assistant** can read it and lay it out as a draft of your new one. Your words stay exactly as you wrote them. It only works for a site that is yours.

## How to do it

1. Open your Website Assistant and go to the **Website** tab.
2. Under **Import my current site**, enter your site's address and choose whether to copy your pictures into your library.
3. Press **Read my site**. It takes a minute or two.
4. Look at what it found, then press **Preview the imported site**.
5. If you're happy, press **Use this as my draft**. Or press **Discard** and keep the draft you have.

Using it replaces your current draft. Nothing goes live until you press **Publish**. Importing uses 1 task, and only if a draft is made.

## What comes across

| From your current site | On your new one |
|------------------------|-----------------|
| Your home page and up to 20 pages from its menu | The same pages, in the same order, with drop-down menus where yours had them |
| Your words, headings, lists and quotes | Exactly as written, laid out as sections |
| Links and buttons, including "Read more" on cards and links inside sentences | Pointing at the matching page on your new site |
| Your pictures (if you chose to copy them) | Copied into your library, at full size |
| Your colours, fonts, button and card style, header and footer colours | Set in **Design**, where you can change them |
| Your social media profiles, email and phone number | In your site's details and footer |
| Videos and maps | A picture and a "Watch the video" or "See us on the map" button |
| Page addresses that change | The old address forwards to the new page |

A very long page is folded into fewer sections, with its headings kept as subheadings, so none of your words are lost.

## Your blog

- **Using the Blog Assistant already?** Your blog page becomes your new site's blog, showing the posts you publish.
- **A blog on another platform** (WordPress, Squarespace, Wix, Ghost and others): up to 30 of its posts come across as **drafts** in your Blog Assistant. Check each one and publish it when you're ready.

## Shops

Prices are never put on your pages, because they belong with your products. If your old site is a shop, the import lists the products it found. Tick the ones you want and press **Add ticked products to Business Information**. They are added to **Business Information ▸ Products & Services** with their prices. A product you already have is never changed.

## What doesn't come across

- Pages behind a log-in, members' areas and password-protected pages
- Baskets, checkouts and customer accounts
- Chat boxes, booking widgets and anything else that runs as a script (your new site runs none)
- Your old forms. Their questions are listed, and your new site has its own contact form, which sends enquiries to you
- Animations and sliders, which become still content

Anything the import couldn't place is listed before you choose, under **Didn't fit on its page**.

## Which websites work

Most website builders, including Wix, Squarespace, WordPress (with Elementor or WooCommerce), Shopify, Webflow, Framer, GoDaddy, Duda, Weebly and Ghost, and sites built by hand or with AI tools. Sites that draw their words with JavaScript are read in a browser first.

We follow your site's robots.txt. Our reader is called **bemoreswan-siteimport**.
$$, TRUE),

('Your Assistants', 77, 'Designing Your Website', $$
# Designing Your Website

Your website's look lives in the **Design** card on your Website Assistant's **Website** tab. It starts from your brand kit, or from your old site if you brought it across. Every choice is checked so your site stays readable on a phone and a computer.

## Colours

| Setting | What it colours |
|---------|-----------------|
| **Main colour** | Buttons and links |
| **Text** and **Background** | Your words and your page. A pair that's hard to read is refused |
| **Second colour** | The button in a call-to-action band, so it stands out |
| **Tint for alternate sections** | The soft background behind every other section |
| **Heading colour** | Your headings. It must be readable on the background |
| **Header colour** and **Footer colour** | The bands at the top and bottom. The words on them change to stay readable |

Tick **Same as text** or **Same as background** to clear a colour.

## Lettering, buttons and cards

- **Lettering**: a heading and body font pairing, hosted by us so no visitor is sent to another company.
- **Buttons**: filled, outlined, or filled and fully rounded.
- **Cards** (features, steps, testimonials): a thin border, a soft shadow, or flat.
- **Corners**, **Spacing** and **Header** layout.

## Sections

Each section has its own **Background**: automatic, plain, soft tint, your main colour, or a soft gradient of your colours.

Feature and step cards can each have a **picture** across the top and a **link** under the words, such as "Read more" pointing at the page about that service.

In any text box, the buttons above it format your words:

- **B** makes the words you've chosen bold, and **I** puts them in italics. Ctrl+B and Ctrl+I (⌘B and ⌘I on a Mac) do the same.
- **• List** and **1. List** turn the lines you've chosen into a bullet list or a numbered list.
- **Link** links the words you've chosen. Type the page, like `/our-courses`, or a web address in the brackets.
- **Subheading** (in a text section) puts a subheading on a line of its own.

Press a button again to take the format off. In the box you'll see small marks, like `**bold**` or `- ` at the start of a list line. They make the formatting, and your site shows it properly.

Words in square brackets with no address after them, like `[Customer name]`, are placeholders to fill in before you publish.

## In your site's details

- **Your social profiles**: one address per line. They appear in your footer.
- **Old addresses that forward here**: addresses from your old site that now lead to a new page. Remove any you don't need.

You can also ask your Website Assistant in chat to change any of these. It shows you the change before anything is saved.
$$, TRUE)

ON CONFLICT (title) DO NOTHING
RETURNING id, title;

COMMIT;
