# Brand Designer — Printable Flyers Plan

Added 2026-11-02. Status: **built on staging code 2026-11-02 (steps 1–5 of §6), not deployed.**
`db/z-brand-designer-flyers.sql` must be applied to BOTH databases before this code deploys. Decisions
taken with the plan's defaults: all four sizes, front only, 1 task to draft the words, email-to-printer
left for phase 2. Step 6 (Mentor, catalogue, help article) waits for go-live.

**As built — where it differs from the design below:**
- Business Information holds no phone number or email, so contact details start from the workspace's
  LAST flyer, else just the website (`contactDefaults` in `src/utils/flyer-words.ts`). The user types
  them once on "Edit flyer"; every later flyer starts from them.
- The print-shop PDF has 3 mm bleed with the TrimBox/BleedBox set, but no drawn crop marks — print
  shops read the TrimBox, and marks need a slug area outside the bleed.
- The PDF is layered: the photo embedded as itself (JPEG/PNG), the words a transparent 300 dpi PNG on
  top. A webp photo is flattened into the word layer.
- A6 under a photo fits a short set of words only; the full set is refused naming the field (the
  words-only page still fits).
- An AI photo on a flyer option stays in R2 when the option is turned down (it may be shared by the
  other page of that round) — the same known gap as undecided AI options in the Brand Designer plan.

Code: `src/lib/flyer.ts` (renderer + PDF), `src/config/flyer-vocab.ts`, `src/utils/flyer-briefs.ts`
(round + approve), `src/utils/flyer-words.ts` (drafting), `netlify/functions/brand-briefs.ts`
(`draft_flyer_words`), Briefs tab "New flyer", My Content Print / PDF downloads, chat card fields.
Tests: `tests/flyer.test.ts`.

Why: Love Cat Studio asked their Business Mentor for a flyer they could print. The Mentor rightly said no
assistant can make one and pointed them at Canva. The owner wants the Brand Designer to make flyers. An
approved flyer lands in My Content, where it can be printed or sent to a printer.

Related: [brand-designer-plan.md](./brand-designer-plan.md) (briefs, rounds, approve → My Content),
[business-mentor-plan.md](./business-mentor-plan.md) §3.5 (who to hire next).

---

## 1. Requirements (from the owner)

1. The **Brand Designer** makes flyers. This is not a new assistant.
2. The flow is **draft → approve**, the same as the Brand Designer's pictures.
3. An approved flyer is saved to **My Content**, where the user can **print it** or **send it to a
   printer**.
4. **GUI and chat parity**: anything done on the screen can be done by chatting. Chat proposes and the
   click spends.

## 2. What already exists — reuse, do not rebuild

| Flyers need | Already built ✅ | Where |
|---|---|---|
| Brief → rounds of options → approve | Visual briefs | `src/utils/visual-briefs.ts`, `netlify/functions/brand-briefs.ts`, `generate-brief-options-background.ts`, tab `src/components/assistant-briefs.js` |
| Text that is spelt right | Branded cards drawn by satori + resvg, not by an AI model | `src/lib/brand-card.ts` (fonts embedded in `brand-card-fonts.ts`) |
| Brand colours, logo, wordmark | `organisations.brand_kit` + `brand_guidelines` | `src/utils/brand-kit.ts`, `brand-guidelines.ts` |
| A photo for the flyer | Stock (Pexels, free) and AI image (FLUX, `ai_image` task weight) sources | `SOURCE_SPECS` in `src/config/visual-brief-vocab.ts` |
| What the flyer should say | Business Info, products, intro offer, the call-to-action setting, Brand Knowledge | read today by every drafting prompt |
| A QR destination | The `/card` digital business card page, the website, a booking link | `card.html` |
| Saving and downloading | `content_assets`; My Content already has a **Document** type; Download is a presigned R2 link | `my-content.js` `MEDIA_TYPES`, `content-asset-download.ts` |
| Charging | Single task allowance, quoted on the button | `TASK_WEIGHTS`, `work-metering.ts` |
| Chat cards | `visual_brief_proposal`, `visual_option_review` | chat route `brand_designer` |

What's missing: a **flyer brief** (paper size, the flyer's words), a **page layout renderer**, a
**print-ready PDF**, and **Print / send to printer** in My Content.

## 3. The design

### 3.1 A flyer is a brief with `purpose = 'flyer'`

- New purpose `flyer`, labelled "Printed flyer". Today the database only allows the existing purposes
  (`visual_briefs.purpose`).
- **Paper size goes in its own column, not in `aspect_ratio`.** `aspect_ratio` also drives stock
  search and AI generation, and both of those only understand the four social ratios. New column
  `visual_briefs.paper_size`, allowed values `'A6' | 'A5' | 'A4' | 'DL'`, NULL for everything that
  isn't a flyer. A5 is the default, because it is the usual handout size. Every size is portrait in v1.
- The photo for a flyer is fetched at `4:5`, the closest portrait ratio the sources support. It is then
  cropped into the layout's photo box, so `aspect_ratio` stays `4:5` on flyer briefs.
- New column `visual_briefs.flyer_content jsonb` holds the **words**, which the user can edit:
  `headline`, `subheading`, `points[]` (at most 3), `offer`, `callToAction`, `contact`
  {phone, email, website, address}, `dateLine` (for events and opening times), and `qr` {url, label}.

### 3.2 Who writes the words

- When the brief is opened, the designer **drafts** `flyer_content` from the brief's message, Business
  Info, products, the intro offer, the call-to-action setting and Brand Knowledge. This is one model
  call, run through the same prompt layers as other drafts.
- **Contact details and the QR link are never drafted by the model.** They are filled from Business
  Info and the brand kit. A field we don't have is left empty, never made up. The model only writes
  the headline, subheading, points and call to action.
- The user edits the words on the brief **before** any round runs. A round then draws exactly those
  words. The "Wrong words on it" rejection reason sends the user back to the text, not into a re-roll.

### 3.3 A round = layouts × one photo source

- `brand_card` gets a sibling round source, `flyer_layout`, which is only offered on flyer briefs. A
  round renders **3 layouts** from the same words:
  1. **Photo top**: photo across the top half, then the words, with contact details and the QR in the
     footer.
  2. **Full-bleed photo**: the photo fills the page, with the words on a solid brand-colour panel.
  3. **Type only**: no photo, a bold brand colour, the headline large. This is free and always works.
- The photo comes from whichever sources the brief ticks (stock is free, AI images cost the usual
  `ai_image` task weight). If there's no photo, layouts 1 and 2 are dropped and the round says why
  (`generation_note`).
- Each option is stored as a **preview PNG** (the page at 150 dpi) for review in the grid and the
  chat. The PDF is made only on **approve**, so we never print-render twelve rejected candidates.

### 3.4 The renderer: `src/lib/flyer.ts`

- Built on the brand-card pieces: satori builds the page (JSX → SVG), resvg turns it into an image,
  and it reuses the same embedded fonts, the palette and contrast rule (`resolveCardPalette`), and
  `inlineLogo`. Same input ⇒ identical output, the same as cards.
- **Page sizes at 300 dpi**: A6 1240×1748, A5 1748×2480, A4 2480×3508, DL (99×210 mm) 1169×2480. The
  bleed version adds 3 mm (35 px) on every side, and the backgrounds and full-bleed photo extend into it.
- **Text never gets cut off.** Each text block has a box. The text shrinks in steps down to a minimum
  print size (about 9 pt for points, 7 pt for contact details). If it still doesn't fit, the round
  **refuses that layout** and names the field ("The points are too long for A6. Shorten them or choose
  A5."). It never silently clips.
- **QR code**: the `qrcode` package drawn as an SVG on the page, at least 20 mm square, with a quiet
  border. It points at a URL from `flyer_content.qr`, and the default order is booking link → website
  → `/card`.
- **Low-resolution warning**: if the photo would print below about 150 effective dpi at its box size,
  the option shows "This photo may look soft when printed".
- **The PDF**: `pdf-lib` places the 300 dpi PNG on a page of the exact paper size in points. The text
  is rasterised at 300 dpi, which is fine for print, and it keeps us to one renderer we already trust.
  A vector PDF (selectable text, smaller file) is a later improvement (§7, D6).
  Check both new packages work as CommonJS before adding them.
- The colours are RGB. Home printers and online print shops accept RGB PDFs. We don't do CMYK
  conversion in v1, and we never claim "print-shop CMYK".

### 3.5 Approve → My Content

- Approving renders **two PDFs** into R2: `flyer.pdf` at the exact size for home printing, and
  `flyer-print-shop.pdf` with 3 mm bleed and crop marks. It creates **one** `content_assets` row with
  asset type `document`, mime `application/pdf`, provider `flyer`. The row's storage key is the home
  PDF, and `render_params` holds the print-shop key and the preview PNG key.
- My Content gets a `flyer: 'Flyer'` media type, the same way cards get "Branded card", so "my flyers"
  is a filter. The tile shows the preview PNG, not a PDF icon.
- The viewer gets three buttons:
  - **Print**: opens the home PDF in a new tab (presigned, `inline`), where the browser's PDF viewer
    prints it. A cross-origin PDF can't be printed from an iframe on our page, so it has to be a tab.
  - **Download PDF**: the existing `content-asset-download.ts`, with a choice between "For home
    printing" and "For a print shop (with bleed)".
  - **Email to my printer** (phase 2): the user types the printer's address and a note, a preview
    shows exactly what will be sent, and one click sends it through Resend with the print-shop PDF
    attached. This sends a message on the user's behalf, so nothing goes without that click, and the
    chat can only propose it. Attachments go through Resend's attachment API from R2. Watch the
    suppression list.
- Not in v1: ordering prints from an online printer. That needs a UK print-on-demand partner with an
  API, which nobody has researched yet (§6 step 7).

### 3.6 GUI and chat

- **GUI**: on the Briefs tab, "New brief" → purpose "Printed flyer" shows a paper size picker and the
  words editor (with the drafted text, every field editable, and character guides per paper size).
  "Ask <name> for options" shows the cost. The review grid shows the previews in page shape.
- **Chat**: `visual_brief_proposal` takes `purpose: 'flyer'`, `paperSize` and `flyerContent`. Chat can
  draft and rewrite the words (free, chat is under fair use) and start a round **only when every
  source is free** (`sourcesAreFree`, the same rule as today). A round with an AI photo is saved and
  then started on the Briefs tab. `visual_option_review` shows the preview PNGs. After approval the
  chat links to the flyer in My Content and says where the Print button is. Chat cannot print.
- **Campaigns**: out of scope for v1. `commission_visuals` stays limited to social shapes
  (`SOCIAL_PURPOSES` already excludes anything else).

### 3.7 Cost

- Drawing layouts is free, the same as branded cards. An AI photo costs the usual `ai_image` weight.
- Drafting the words is a model call → **1 task** per draft or redraft (new `TASK_WEIGHTS.flyer_copy`).
  It goes through `hasTaskCapacity` before the call and `recordCompletedWork` after it
 , and the cost is quoted on the "Draft the words" button. Typing your
  own words is free. (Open decision D3.)

### 3.8 The Mentor and the catalogue

- The Mentor recommends hires from the **catalogue description** (`mentor-hire.ts`) and knows what the
  team does from its snapshot. Once flyers are live on prod:
  - Update the Brand Designer's catalogue row (`description`, `key_features`) with "printable flyers".
    That row belongs to the admin after insert, so give the owner an `UPDATE`, or edit it in Admin →
    Master Data. Never re-run the seed.
  - Add a line to `mentor-craft.ts`: printed materials (flyers, posters, leaflets) → the Brand Designer
    if hired, otherwise recommend hiring it. Canva is only for people who already use Canva.
- Help article (published `help_articles`, which the Ask Your Team assistant also reads), the
  assistant page, and the brand designer starter prompts ("Make me a flyer for…").
- Public copy says nothing about flyers until they're live on prod.
  Say "printable flyers you can print or send to a print shop". Don't say "print-ready CMYK" or "we
  print them for you".

## 4. Failure modes designed for up front

| Risk | Answer |
|---|---|
| Model invents a phone number or offer | Contact and QR are filled from data only; the model writes four text fields; the offer comes from the intro-offer setting |
| Text too long for the paper | Shrink to a print minimum, then refuse that layout with the field named, never clip |
| No brand kit | Neutral monochrome, the same as cards, never a borrowed palette |
| Soft photo | Effective-dpi warning on the option |
| QR that doesn't scan | ≥ 20 mm with a quiet zone; test decodes the rendered PNG |
| Huge files | A4 300 dpi PNG inside a PDF ≈ 3–8 MB; stored in R2 and downloaded via presign (no 6 MB function limit) |
| Rounds stuck | Same credit hold + 10-minute sweep as other rounds |
| Printing blocked cross-origin | Print opens the PDF in its own tab |
| Email to printer silently dropped | Show Resend's result; mention spam folders; suppression check |

## 5. Schema — `db/z-brand-designer-flyers.sql`

Idempotent. Apply to **both** DBs **before** the code deploys.

- Widen the `visual_briefs.purpose` CHECK to include `'flyer'`. Drop the constraint by name and add it
  back in one transaction. Beware the DROP-then-ADD trap on a re-run:
  use `DROP CONSTRAINT IF EXISTS` and then `ADD`.
- `ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS paper_size TEXT CHECK (paper_size IN ('A6','A5','A4','DL'))`
- `ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS flyer_content JSONB`
- Widen `visual_brief_options.source` to include `'flyer_layout'`.
- Mirror everything in `db/schema.ts`.

## 6. Build order

1. **Renderer + PDF** (`src/lib/flyer.ts`, `pdf-lib`, `qrcode`), with tests: identical output for the
   same input, page sizes in mm read back from the PDF, the QR decodes, the overflow refusal, no text
   outside the trim.
2. **SQL** (§5) on staging, then the brief engine: `purpose: 'flyer'`, `paper_size`, `flyer_content`,
   the `flyer_layout` source, preview PNGs, PDFs on approve. Tests on real Postgres alongside
   `tests/visual-briefs-db.test.ts`.
3. **Words**: the drafting prompt, metering, the words editor on the Briefs tab.
4. **My Content**: the Flyer type, preview tile, Print, Download (home / print shop).
5. **Chat**: the card fields, the route prompt, the free-only start rule, starter prompts.
6. **The Mentor, catalogue, help article, explainers.** Then a staging run with a realistic test org
   (not real Love Cat data), a printed A5 check on paper, and a promote to prod.
7. **Phase 2**: email to my printer. **Phase 3**: research a print-on-demand partner (UK, API,
   flyers) as its own plan.

Each step lands with the GUI control, the chat path, `data-explain` text, and tests, the same as the
Brand Designer plan §6.

## 7. Open decisions (the owner's)

- **D1 — Sizes**: A6, A5, A4 and DL portrait, or start with A5 + A4 only?
- **D2 — Double-sided**: front only in v1 (recommended), or a back page (map, price list, terms)?
- **D3 — Cost of drafting the words**: 1 task (recommended), or free?
- **D4 — Email to my printer**: in v1, or phase 2 (recommended)?
- **D5 — Plans**: flyers on every plan that has the Brand Designer, or only some?
- **D6 — Vector PDF later**: worth it for sharper text and smaller files, at the cost of a second
  rendering path?

## 8. Selling it

Canva makes flyers too. Our difference is that **the designer already knows the business**: its
offer, its call to action, its brand and its contact details. The user approves a flyer that's
already written instead of filling in a template. Don't claim print quality or "replaces your
designer" until real customers have printed some.
