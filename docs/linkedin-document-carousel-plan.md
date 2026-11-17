# LinkedIn document carousels — PLAN (Top lists follow-on, FR#34)

2026-11-17. **All four decisions in §6 agreed. Phase 0: GO for personal profiles (§4a). Phase 1 built on `feat/linkedin-document-carousel` (§4b); not yet live on prod.**

The ask: "Make it a carousel" (Top lists Phase 2, live on prod) works on Instagram and Threads and leaves LinkedIn alone.
LinkedIn's swipeable carousel is a different kind of post — a **PDF document**, where each page shows as one slide —
and Be More Swan can't post one yet (`li_document` is `planned` in `src/config/post-formats.ts`). This plan makes it live,
so a list post's LinkedIn version becomes a document carousel with the same slides.

---

## 1. Short answer

- **Two of the three pieces already exist.** We render the slides (the brand cards `make-carousel.ts` makes), we can
  build PDFs (`pdf-lib` via `src/lib/render-libs.ts`, already used for Brand Designer flyers), and My Content already
  stores PDFs (`assetType: 'document'`, `content-upload-url.ts`).
- **The missing piece is posting it.** LinkedIn only takes documents through its newer **Documents API + Posts API**
  (`/rest/documents`, `/rest/posts`). We post to LinkedIn through the older **ugcPosts** API, which has no document type.
- **The real risk is permission, not code.** It is not yet known whether our current LinkedIn access ("Share on
  LinkedIn", `w_member_social`) is allowed to call the newer APIs. If it isn't, we need LinkedIn's **Community Management
  API** product, which is an application LinkedIn reviews — the same kind of wait as the Meta app review. Phase 0 finds
  out in an afternoon, before anything is built.

## 2. What LinkedIn requires (checked 2026-11-17)

From LinkedIn's own docs ([Documents API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api?view=li-lms-2026-04),
[Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-04)):

1. `POST /rest/documents?action=initializeUpload` with the owner (a person or a company page) → an upload URL and a
   document id (`urn:li:document:…`).
2. `PUT` the PDF to that URL. One file, PDF (or PPT/DOC), at most **100 MB and 300 pages**.
3. `POST /rest/posts` with the caption as `commentary`, `content.media.id` = the document id, and `content.media.title`
   (LinkedIn shows the title above the document).
4. Every call needs a `Linkedin-Version: YYYYMM` header and `X-Restli-Protocol-Version: 2.0.0`.

Not confirmed: whether a `w_member_social` token may call `/rest/documents` and `/rest/posts` for a **personal profile**,
and what a **company page** needs (`w_organization_social`). That is Phase 0.

## 3. What Be More Swan has today

| Piece | Today | Where |
| --- | --- | --- |
| Slides | Cover + one 4:5 brand card per list item, no AI call | `netlify/functions/make-carousel.ts`, `carouselSlideTexts` in `src/utils/top-lists.ts` |
| PDF making | Flyers are rendered to PDF | `src/lib/flyer.ts` (`flyerPdf`), `pdfLib()` in `src/lib/render-libs.ts` |
| Storing a PDF | Allowed in My Content as a document | `content-upload-url.ts`, `flyer-briefs.ts` (`assetType: 'document'`) |
| LinkedIn posting | Text, one image, several images, video — via `/v2/ugcPosts` | `publishLinkedIn` in `src/utils/social-publish.ts` (its own comment already flags the move to `/rest/posts`) |
| Format | `li_document` exists, marked `planned` | `src/config/post-formats.ts` |

⚠️ LinkedIn's several-images post is **not** a carousel: it shows as a grid, not something you swipe. That is why the
document is the right format for a list (§6, decision 1).

## 4. Build outline

**Phase 0 — can we post a document at all? (half a day, needs the owner's LinkedIn connection on staging)**
- A one-off script (not shipped) that, with the staging LinkedIn token, uploads a two-page test PDF through
  `/rest/documents` and posts it with `/rest/posts` to the owner's own profile as a **connections-only** post, then
  deletes it. Outcome: works / needs the Community Management product / needs a re-connect with a new scope.
- If a company page is connected, the same test for the page.
- Go / no-go back to the owner. **Nothing customer-facing changes in Phase 0.**

**Phase 1 — LinkedIn document carousels (2–3 days, only after a Phase 0 "go")**
- `carouselFormatFor('linkedin')` → `'li_document'`, and `li_document` becomes `live` in `post-formats.ts`.
- `make-carousel.ts`: for a LinkedIn row, put the same slide images into **one PDF** (one 1080×1350 page per slide, via
  `pdfLib()`), save it to My Content as a document, and attach it to that row with `formatKey: 'li_document'`. The same
  press still uses **1 task** for all platforms (decision 4 of the Top lists plan).
- `publishLinkedIn`: when the row's format is `li_document`, upload through the Documents API and post with
  `/rest/posts` (pinned `Linkedin-Version`), with the cover line as the document title. Every other LinkedIn post stays
  on ugcPosts — the full move off ugcPosts is a separate job (§7).
- The editor and the platform preview show the document as its slides (the slide images we already have), with
  "Document carousel" on the LinkedIn tab. The format router (`route-post-formats.ts`) and the pre-publish audit learn
  that a `document` is valid media for `li_document`.
- Chat: the `carousel` action text says "Instagram, Threads or LinkedIn"; the card copy too.
- `/connections` (the public list of what is live) and the Help Centre say LinkedIn carousels are live — **only once it
  has posted for real on prod** (see the memory rule on public claims).
- Tests: the PDF has one page per slide in order; a LinkedIn row gets a document and `li_document`; the publisher picks
  the document path only for `li_document`; one task per press, still.

## 4a. Phase 0 result (2026-11-17, staging, owner's OK)

Run with Marmalade's staging LinkedIn connection — the ordinary "Share on LinkedIn" token (`openid profile email
w_member_social`), `Linkedin-Version: 202608`, from a one-off script that was then deleted:

| Step | Result |
| --- | --- |
| `POST /rest/documents?action=initializeUpload` (owner `urn:li:person:…`) | ✅ 200, upload URL + `urn:li:document:…` |
| `PUT` a 2-page PDF to the upload URL | ✅ 201 |
| `GET /rest/documents/{urn}` | ✅ `AVAILABLE` |
| `POST /rest/posts` (visibility `CONNECTIONS`, `content.media.id` = the document) | ✅ 201 |
| `GET /rest/posts/{urn}` | ❌ 403 — reading posts needs `r_member_social`, which we don't have |
| `DELETE /rest/posts/{urn}` | ✅ 204, within a minute |

**Go for personal profiles. No new LinkedIn product and no re-connect needed** (decision 2 is not triggered for
profiles). Nothing may depend on reading a post back. **Company pages: not tested** — Page posting is switched off
(`LINKEDIN_PAGE_POSTING` unset) and no page was connected. The owner now has Community Management developer access, so
the page test is: check the Community app's Auth tab lists the page scopes, set `LINKEDIN_PAGE_POSTING=on` on staging,
connect the Be More Swan page, post one document carousel, delete it.

## 4b. Phase 1 as built (one change from §4)

**The LinkedIn row keeps the slide images, not a stored PDF.** §4 said to save a PDF to My Content and attach it.
Built instead: the row gets the same brand-card slides as Instagram and Threads, with `formatKey: 'li_document'`, and
`publishLinkedInDocument` (`src/utils/social-publish.ts`) turns them into one PDF when it posts. Why: the editor already
shows and reorders slides, so a stored PDF would go stale the moment a slide moved, and the editor would need a
document preview it doesn't have. Cost and tasks are unchanged (one `carousel` task per press, decision 4).

- `li_document` is `live`: image slides, 2–20, 4:5 or 1:1. PNG/JPEG only (pdf-lib embeds them; brand cards are PNG).
- `carouselFormatFor('linkedin')` → `li_document`, so "Make it a carousel" and the chat's `carousel` action include LinkedIn.
- Publish: `initializeUpload` → `PUT` → poll the document (up to ~20 s; a 403 on the poll is not fatal) → `/rest/posts`
  with the cover line as the document title. The caption is escaped to LinkedIn's "little text" (`littleText`): its
  15 reserved characters are escaped and `#word` becomes `{hashtag|\#|word}` (`#1` stays a rank, not a hashtag).
- An upload failure is a media failure (never a text-only post); LinkedIn's status drives the usual retry rules.
- Every other LinkedIn post stays on ugcPosts (§7).
- `/connections` and the Help Centre say nothing yet — only once one has posted for real on prod.

## 5. Costs

- No AI. A 6-slide PDF is roughly 1–3 MB in R2, kept on the post's normal retention.
- LinkedIn charges nothing for the API. The Community Management product, if needed, is free but reviewed.

## 6. Decisions — all agreed by the owner (2026-11-17)

| # | Question | Decision |
| --- | --- | --- |
| 1 | LinkedIn carousel as a **document** (swipeable, LinkedIn's best-performing format) or as **several images** (works today on our current API, but shows as a grid)? | ✅ **Agreed: document.** A grid isn't a carousel, and posting one as if it were would disappoint. |
| 2 | If Phase 0 shows we need LinkedIn's **Community Management API** product: apply for it? | ✅ **Agreed: yes**, it is also the route off the legacy API we'll need anyway (§7). Expect a review wait. |
| 3 | Personal profiles only, or company pages too? | ✅ **Agreed: both** when the permission allows; profiles first if pages need the extra review. |
| 4 | Charge LinkedIn's PDF as extra work? | ✅ **Agreed: no.** Same press, same 1 task — the slides are already made. |

## 7. Out of scope (noted, not planned here)

- **Moving all LinkedIn posting from ugcPosts to the Posts API.** LinkedIn calls ugcPosts legacy and says the Posts API
  will replace it. If decision 2 brings the Community Management product, that move becomes possible and worth its own
  plan; this plan only adds the document path.
- Automatic carousels (Top lists decision 3) — still "on request" until there are results to look at.
