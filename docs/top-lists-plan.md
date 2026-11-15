# Top lists (listicles) — PLAN (feature request #34)

2026-11-15. **All six decisions agreed by the owner (2026-11-15) — see §8. Phase 1 BUILT 2026-11-15 (uncommitted on
the working tree; see §9). Phases 2–3 not started.**

The ask: *"Top n lists of something is a very popular technique I believe on line to get people to read. I think
because people are curious to see or it helps their research. Is this something we should build into Be More Swan
assistants? Thoughts?"*

---

## 1. Short answer

- **Yes, but as a format, not a new assistant. And half of it is already built.** Social already has a **"List"**
  post shape ("a saveable numbered list", 3–7 items) and Blog already has a **"List article"** type (6–10 numbered
  items, 900–1,200 words). Both live in `src/utils/content-shapes.ts`. Each comes round in turn: about 1 social post in
  11 and 1 article in 8. Owners can switch shapes off under **profile ▸ Content mix** (`assistant-detail.html`,
  saved as `allowed_post_shapes` / `allowed_article_types`). The Blog Studio **"Type of article"** dropdown lets you
  pick "List article" for a single piece (`blog-studio-modal.js` → `generate-blog.ts` `articleType`).
- **What's missing is the "Top 5" version and its reach.** Today's lists have no number in the title. Social lists
  never become **carousels**. Email and Video have no list format at all. The Mentor never suggests one. Chat can only
  write one if the user happens to ask in their own words.
- **Keep the share modest.** The evidence (§2) says lists earn clicks and AI citations. It also says Google is now
  pushing down thin, mass-produced and self-serving "best of" lists. A feed of nothing but listicles looks like spam.
  Lists should stay a regular ingredient, never the whole meal.

## 2. What the evidence says (Nov 2026; mostly vendor studies, so treat the figures as a direction, not fact)

| Claim | Source |
| --- | --- |
| Numbers in headlines lift clicks. Anyword found ~70% of listicle headlines beat non-list ones on CTR. Older Outbrain/HubSpot/Conductor work favours odd numbers. | [Anyword](https://anyword.com/blog/why-listicles-could-be-the-key-to-higher-conversion-rates), [MarketingProfs](https://sb.marketingprofs.com/charts/2017/32983/the-most-effective-number-in-article-headlines-infographic) |
| AI search loves lists. Ahrefs: "best X" lists were 43.8% of pages ChatGPT cited across 750 prompts. In "best software" AI Overviews, third-party lists got 63% of citations and the product's own site got 12%. | [Quattr on Ahrefs](https://www.quattr.com/blog/takeaway-from-ahrefs-ai-search-study), [DerivateX](https://derivatex.agency/blog/what-content-gets-cited-google-ai-overviews/), [Search Engine Land](https://searchengineland.com/ai-search-loves-listicles-what-25000-urls-reveal-about-citations-477682) |
| **But** self-promotional "best of" lists (own product at #1) took steep visibility losses in 2026. AI Overviews often cite them while recommending the competitors instead. A 5.3M-row study (Aug 2026) found Google cut listicles from the top spots except where the query asks for a list. | [Lily Ray / SEJ](https://www.searchenginejournal.com/is-google-finally-cracking-down-on-self-promotional-listicles/566529/), [Search Engine Land](https://searchengineland.com/google-ai-overviews-cite-self-serving-listicles-recommend-competitors-480573), [Relevant Audience](https://www.relevantaudience.com/content-marketing/google-listicle-study-query-phrasing-august-2026/), [PPC Land](https://ppc.land/vendor-listicles-gain-38-median-traffic-since-googles-january-demotion/) |
| Carousels beat single images on LinkedIn, though estimates of the gap range from small to large. Instagram is mixed. | [Ordinal](https://www.tryordinal.com/blog/carousel-posts), [Buffer, 45M posts](https://buffer.com/resources/data-best-content-format-social-media/), [Socialinsider via SMT](https://www.socialmediatoday.com/news/linkedin-company-pages-best-practices-2025-socialinsider/745350/) |

So lists **work when someone is looking for a list** ("ideas for…", "ways to…", "best… in Leeds") and when every
item has real substance. They fail as filler or as a "we're #1" ad.

## 3. Where it fits, assistant by assistant

| Assistant | Today | Add |
| --- | --- | --- |
| **Blog** | "List article" type (`BLOG_ARTICLE_TYPES`), picked in turn or in Blog Studio | A **"Top list"** variant: the title carries the real count ("7 ways to…"), and each item heading leads with the answer. Add an optional "Our pick / how we chose" line for comparison-style lists. |
| **Social** | "List" shape (`SOCIAL_POST_SHAPES`), text only | Turn a list post into a **carousel**: cover slide plus one branded slide per item, using the brand-card renderer (`renderAndPersistBrandCard`, `src/lib/media-persist.ts`) and `set-post-slides.ts`. Instagram/Threads carousels are live. The LinkedIn document carousel is still `planned` in `src/config/post-formats.ts`. |
| **Email Marketing** | Purposes (`src/config/newsletter-purposes.ts`), opening rotation (`emailOpeningBlock`), no structure choice | A **"Top 5" newsletter layout**: an intro plus five short numbered items, each with a link. Newsletter purpose only, never incident or policy-change emails. |
| **Video Producer** | Storyboard beats hook → problem → value → proof → cta, 3–8 scenes (`src/lib/storyboard.ts`) | A **countdown** shape: the hook scene says "3 things…", then one scene per item (5 → 1), with the CTA last. Fits the 3–8 scene limit at up to 5 items. |
| **Business Mentor** | Suggestions tab, set-up proposals | Suggest a list piece when it fits: a topic people search as a list, a product range of 5+, or no list published in 30 days. "Take Me There" opens Blog Studio with "Top list" chosen. |
| Brand Designer, Website, Leads | — | Nothing for now. Revisit a printable "Top 10 tips" flyer later. |

## 4. How it is chosen (GUI and chat, same server action)

- **Automatic:** keep the rotation. "Top list" replaces the current "List" entry rather than adding a slot. ⚠️ The
  social shape count must stay **11** (prime, coprime with the 7 hooks; see `hook-styles.ts`), so this is an edit to
  the existing shape, never a twelfth.
- **One piece, by hand (GUI):** Blog Studio's "Type of article" already works. Add a **"Shape"** choice to the social
  "New post" / regenerate controls, a **"Top 5" layout** to the New Issue dialog, and a **"Countdown"** option to the
  New video brief.
- **Chat:** "make this a top 5" / "turn that into a list" redrafts the piece through the same endpoints, passing
  `shape: 'list'` or `articleType: 'list'` explicitly, so the result never depends on how the model reads the
  request. This needs a new chat block, so regenerate the chat-capabilities manifest (FR#17 rule) or CI fails.
- **Frequency:** Content mix can already switch lists **off**. Add a **"More lists"** option that weights the list
  shape at no more than **1 in 4**. Even at that setting, never put two list pieces back to back.

## 5. Guardrails (in the shared prompt block, plus checks in code)

1. **Real items only.** Items come from the business's products, services, Brand Knowledge, FAQs and inspo. If the
   context can't fill N real items, write fewer and fix the title. **The number in the title is computed from the
   finished list, not taken from the model**, and a test checks the two match.
2. **No invented stats.** `NO INVENTED STATISTICS` (`src/constants/content-quality.ts`) already applies. Lists are where
   the model is most tempted to break it ("3. 73% of customers…").
3. **No self-crowning.** We never write "the 7 best [category] in [town]" with the business at #1. Comparison lists
   name real alternatives, say plainly that we are one of them, and give honest pros and cons (the 2026 evidence
   above).
4. **Substance per item.** Blog items get at least a paragraph, social items a full line, video items a full scene.
   No one-word bullets.
5. **No bait titles.** "You won't believe #4" is banned. Titles state the real count and topic.

## 6. Build outline

- **Phase 1 (prompts + choice, no new tables):** reword the list entries in `content-shapes.ts` into "Top list"
  briefs. Do the title/count check in `blog-generate.ts` and `process-content-jobs.ts`. Add the social "Shape" picker
  and the chat `shape` / `articleType` pass-through. Add the "More lists" weight to Content mix. Add tests for count
  match, the no-back-to-back rule, and 11 shapes.
- **Phase 2 (carousel):** list post → brand-card slides → `set-post-slides.ts`, with a "Make it a carousel" button
  in GUI and chat. Instagram and Threads first. LinkedIn when `li_document` goes live.
- **Phase 3:** the newsletter "Top 5" layout (new template in `newsletter-templates.ts`), the Video countdown shape,
  and the Mentor suggestion plus the Take Me There entry.

## 7. Costs

- **Phases 1 and 3:** no extra AI calls. A list is the same single drafting call with a different brief. Task
  charges stay as they are today.
- **Phase 2:** one brand-card render per slide (image work only, no AI model), so a 6-slide carousel costs a few
  seconds of compute and a little storage. Decision 4 covers whether to charge it.
- **Build:** about 2–3 days for Phase 1, 2–3 for Phase 2, and 3–4 for Phase 3, including tests.

## 8. Decisions — all agreed by the owner (2026-11-15)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Build lists into the existing assistants rather than as a new "Top lists" assistant? | ✅ **Agreed: yes**, format only. No new assistant. |
| 2 | Default share of list pieces: keep today's ~1 in 8–11, or raise it? | ✅ **Agreed: keep.** Offer "More lists" (max 1 in 4) as an opt-in in Content mix. |
| 3 | Social list posts become carousels: automatically, or only on "Make it a carousel"? | ✅ **Agreed: on request** at first; switch to automatic only after we've watched results. |
| 4 | Charge carousel slides as tasks? | ✅ **Agreed: one task per carousel**, not per slide. |
| 5 | Allow comparison lists that name competitors (honestly, us included)? | ✅ **Agreed: yes, blog only**, with the §5.3 rules. Never "best in town" with us at #1. |
| 6 | Which order: Blog + Social (Phase 1–2) first, then Email/Video/Mentor? | ✅ **Agreed: yes.** Phase 1 → Phase 2 → Phase 3. |

## 9. Phase 1 — what was built (2026-11-15)

- `src/utils/top-lists.ts`: `TOP_LIST_RULES` (the §5 guardrails, written into every list brief), the item counters and
  `fixListCount` / `fixCaptionListCount` / `fixArticleListCount`. The title's count is computed from the items written.
  It never touches a year, a price, "24/7", or a title with no number.
- `content-shapes.ts`: the existing `list` shape and `list` article type are now **"Top list"** (edited in place: 11 social
  shapes, 8 article types). `MORE_LISTS_EVERY = 4`. A forced shape is supported (`socialShapeBlock`, `socialShapeByKey`).
- Drafters: `process-content-jobs.ts` honours "More lists" and a picked shape, then fixes the caption and card headline
  count. `blog-generate.ts` honours "More lists" and fixes the post title plus the body's H1.
- **New post ▸ Shape** (`workspace.html` `#gen-post-shape`) → `generate-post.ts` `shape` → `content_generation_jobs.post_shape`.
- **Content mix ▸ More lists** (`assistant-detail.html` / `assistants.js`) → `onboardingContext.list_frequency = 'more'`,
  carried across whole-context saves.
- Chat: a social draft may carry `"shape": "list"`, and its count is fixed before saving. A blog batch topic may carry
  `articleType` (validated) through `generate-blog.ts` to the writer. Chat manifest unchanged (no new block or card).
- ⚠️ **SQL: `db/z-post-shape.sql` on BOTH DBs.** Safe in either order: the drainer reads the column through `to_jsonb`
  and generate-post writes it in a best-effort UPDATE. Until it runs, a picked shape is ignored.
  It is deliberately not in `db/schema.ts`: Drizzle would add it to every job INSERT.
- Tests: `tests/top-lists.test.ts` (18 checks). Three older source-scan tests were updated to the new lines.
- Not done in Phase 1: Shape on the post editor's "Draft with AI" button. Not checked in a browser yet.

