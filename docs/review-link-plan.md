# Review link: plan

Status: Phase 1 (Social Media Assistant) built on 2026-11-07, not yet committed or released. Decisions 2 to 5 in §2 were built to the recommendations and are still the owner's to change.

## 1. The idea in one paragraph

A subscriber shares one piece of work (a social post, or a Brand Designer design) through a private
link. The guest needs no account. They see the work, type their name, and either approve it or ask
for changes. The subscriber is told and decides what happens next. After responding, the guest is
offered their own 14-day trial. That is the growth loop:

    subscriber shares → guest responds → guest sees the product working → guest starts a trial

**Goal:** find out, cheaply, whether subscribers share and whether guests convert, before anything
larger (a canvas, live collaboration) is considered.

**Not the goal:** collaboration in general. This is approval of one item, by someone outside the workspace.

## 2. Decisions for the owner

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | What stays paid? Pricing sells Workspace Collaboration as "Invite team members, managers, or clients to view and approve outputs", ticked on the top plan and Coming soon on the Busywork Buster. Free links overlap with that. | **Decided by the owner 2026-11-07: links and team seats are both free.** A link covers one item with no login. A seat gives a named person access to chosen assistants, and comes later. Trial accounts get both, with seats capped. Reword the plan feature when seats launch. | The loop only grows if every subscriber can share. A guest cannot draft, edit, use chat or see anything else. |
| 2 | Does a guest's approval publish the post? | **No. It records a sign-off, and the subscriber still presses Approve.** | Publishing to someone's connected accounts from a forwardable, no-login link is too much risk. `publishPolicy` is the user's consent, and a link is not them. Revisit if subscribers ask. |
| 3 | Can the "Shared with Be More Swan" credit be removed? | **Shown to everyone in v1.** Removing it could become a paid extra if agencies ask. | The credit is the loop. Do not design for a request nobody has made yet. |
| 4 | Which assistants first? | **Social Media Assistant, then Brand Designer.** | Social repeats every month. Designs look good when shared, and the editor exists. |
| 5 | How long do links last? | **30 days, can be revoked at any time.** | Long enough for a slow client, short enough that old links do not linger. |

## 3. What each person sees

### Guest (`/r/<token>`, no login)
1. A header with the subscriber's workspace name and "would like your thoughts".
2. The work:
   - **Social post:** the caption, media and planned date, for each platform in the cross-post.
   - **Design:** the options on offer, with the option to choose one.
3. A name field (required) and a comment box.
4. **Approve** or **Ask for changes** (the comment is required for changes). Designs add **Choose this one**.
5. A thank-you, then the trial offer. The offer never appears before they have responded.
6. A small "Shared with Be More Swan" credit in the footer throughout, plus "Report this page".

Dead links (expired, revoked, item gone, workspace lapsed) all show the same plain "This link is no
longer active. Ask the person who sent it for a new one." The reply must not reveal which case applies.

### Subscriber
- **Share for review** on a Review Queue card, on a design option in the Briefs tab, and in the design
  editor. It offers Copy link, and an optional email to one address.
- **Status on the card:** Shared, Viewed, Sarah approved, Sarah asked for changes.
- **Responses on the card**, labelled with the name as typed, since it is unverified. If the work has
  changed since then, it says "Changed since this response".
- **Actions** use the existing server paths and only run when the subscriber clicks:
  Approve (`approve-post`), Request changes with the guest's comment prefilled (`request-post-changes`),
  and Approve option (`decideOption`).
- **Revoke link** on the card.
- **A notification** when someone responds (Inbox, bell, email per their preferences).

### Chat (same commit as the GUI, per the parity rule)
"Send this to Sarah to approve" produces a card. The user's click creates the link or sends the email.
Chat can also answer "Has anyone responded?" Chat never creates a link or emails anyone on its own.

## 4. Build

### Data (`db/review-links.sql`, apply to both DBs before the code ships)

```sql
CREATE TABLE IF NOT EXISTS review_links (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  item_kind        TEXT NOT NULL CHECK (item_kind IN ('social_post','design_brief')),
  item_id          INTEGER NOT NULL,          -- a post in the cross-post group, or a visual_briefs id
  token_hash       TEXT NOT NULL UNIQUE,      -- sha256; the token itself is never stored
  label            TEXT,                      -- subscriber's own note, e.g. "for Sarah"
  expires_at       TIMESTAMP NOT NULL,
  revoked_at       TIMESTAMP,
  view_count       INTEGER NOT NULL DEFAULT 0,
  first_viewed_at  TIMESTAMP,
  trial_clicks     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_links_item ON review_links (organisation_id, item_kind, item_id);

CREATE TABLE IF NOT EXISTS review_link_responses (
  id               SERIAL PRIMARY KEY,
  link_id          INTEGER NOT NULL REFERENCES review_links(id) ON DELETE CASCADE,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  guest_name       TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('approved','changes','comment')),
  option_id        INTEGER,                   -- the design option chosen, if any
  body             TEXT,
  content_hash     TEXT NOT NULL,             -- what they were looking at
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_link_responses_link ON review_link_responses (link_id, created_at);
```

No guest email and no IP address is stored. Mirror both tables in `db/schema.ts`.

### Server
- **`src/utils/review-links.ts`** is the single module for both surfaces: create, revoke, list, resolve
  a token, and **`reviewProjection(link)`**, the one function that decides what a guest can see.
- **`netlify/functions/review-link.ts`** (signed in, `requireTenant`, owner/admin/member,
  `checkImpersonationBlock` on writes): `create`, `revoke`, `list`, `send_email`.
- **`netlify/functions/review-link-public.ts`** (no login, POST only): `view`, `respond`, `trial_click`.
  Add it to the `rate-limit` edge function list in `netlify.toml`, as `site-audit-public` is.

### Reuse points
| Need | Reuse | Note |
|---|---|---|
| Post rendering | `src/components/platform-post-preview.js` | Check it needs nothing else from `workspace.html` |
| Cross-posts | `crosspost_group_id` | One card = the whole group, as in the Review Queue |
| Media | `resolveAssetDisplayUrl()` at read time | Short-lived URLs are right for a page being viewed. Do **not** use newsletter signed URLs: they last forever and cannot be revoked. |
| Designs | The option's stored preview image | Do not render on a public request. `renderDesign*` is heavy (see cold-start note) and would be an open door to spending compute. |
| Spam | `checkRateLimit`, plus honeypot and minimum fill time as in `audience-public.ts` | A caught bot gets the same reply as a person |
| Trial attribution | `signupSource` in `register.ts` | `{ source: 'review-link', campaign: <item_kind> }`. Confirm it passes `LABEL_RE`. |
| Notification | `createNotification` | New type `review_link_response` touches five places: `notification-actions.ts`, `notification-prefs.ts`, `notification-templates-catalog.ts`, `db/notifications-categorization.sql`, the call site. Pass `category` explicitly. |
| Chat card | `disruptive-ui-registry.js` | Chat routes drop unknown cards, so add it to each route's allow-list, name it in the prompt, pin it in the prompt-surfaces test. |

### Page
`shared-review.html` is a static page, with `/r/:token` rewritten to it (status 200) in `netlify.toml`,
ahead of any catch-all. Use root-absolute asset paths, since a subdirectory URL breaks relative ones.
It is **not** a marketing page: no sitemap, nav or footer entry. The auth guard only blocks its listed
paths, so no change is needed there, but confirm on a deploy preview.

## 5. Security rules (each one gets a test)

1. **Tokens:** 32 random bytes, stored only as a sha256 hash. Not the Mystery Shopper's HMAC token,
   which cannot be revoked.
2. **Reach:** the organisation and item come only from the link row, never from the request. A link
   opens exactly one item.
3. **Allow-listed output:** `reviewProjection` builds a new object field by field. Never returned:
   prompts, quality warnings, content rules, reject reasons, connection details, provider ids or
   assistant settings. A test fails if any of those appear.
4. **Not single use, and opening changes nothing:** Outlook's scanner opens links before people do and
   runs page scripts (prod user 39, 2026-10-27). So a POST sent when the page loads would count the
   scanner as a view, and a customer would see "seen" when nobody has opened it. The page's `view` call only reads. The `opened` call counts a view, and is sent only on the
   guest's first real interaction (a click, key press or scroll), never on load. Approve and Request
   changes already need a click.
5. **No leaks:** `Referrer-Policy: no-referrer` and `noindex`. Netlify `[[headers]]` skip function
   responses, so the function sets its own, and the static page needs a matching `netlify.toml` rule.
6. **Guest text is untrusted:** render with `textContent`, cap the length. It reaches a model only when
   the subscriber clicks Request changes, and passes through `enforcePromptModeration` first. The
   rewrite prompt must treat it as feedback to weigh, not instructions.
7. **No guest actions spend or publish:** no AI, no tasks, no status change on the post or option.
8. **Lapsed workspaces:** a link stops working once the workspace has no active plan or trial. Archived
   assistants' items also go dead (`archived-assistant-drafts.ts`).
9. **Limits:** caps on live links per workspace, responses per link, and emails per day, so this cannot
   be used as free hosting or a mail cannon. "Report this page" goes to the existing reports path.
10. **No marketing to guests:** the trial offer is on-screen only. Their names and comments belong to
    the subscriber's workspace.

## 6. Phases

**Phase 1: Social Media Assistant** (the main piece of work)
SQL, module, both functions, guest page, Review Queue button and status, notification, chat card,
email option, tests, trial offer with attribution.
Done when a post can be shared on staging, opened in a private window, approved, and the subscriber
sees it and approves it, through both the GUI and chat.

**Phase 2: Brand Designer** (small, once Phase 1 stands)
A `design_brief` projection, Choose this one, buttons in the Briefs tab and design editor, chat.

**Phase 3: Measure for 30 days** (see §7). Build nothing new during it.

**Phase 4: Decide what is next.** Candidates, only if the numbers justify them: Blog and Email review,
Website Assistant draft preview, a shared Mystery Shopper report ending in "Check my own site", meeting
notes sent to attendees, tying guest sign-ups into refer-a-friend.

## 7. Measuring it

Starting thresholds are my estimates, not benchmarks. With few customers they are directional, so also
ask the people who used it.

| Measure | Source | Worth expanding at | Rethink below |
|---|---|---|---|
| Active subscribers sharing at least once | `review_links` | 25% | 10% |
| Links opened by a guest | `first_viewed_at` | 60% | 30% |
| Opened links that get a response | `review_link_responses` | 50% | 20% |
| Guests who click the trial offer | `trial_clicks` | 5% | 1% |
| Trials started | `signup_sources` where source is `review-link` | Any repeat trend | None after 30 days |

If subscribers do not share, a better guest experience will not help, so go and ask them why. A canvas
only comes back on the table if guests repeatedly ask to work together live.

## 8. Release checklist

- [ ] Owner decisions in §2
- [ ] `db/review-links.sql` on staging, then prod, **before** the code
- [ ] `db/notifications-categorization.sql` updated
- [ ] Add both tables to `src/utils/workspace-export.ts`, the one home of the data export's contents
- [ ] Pricing: reword Workspace Collaboration (`pricing.html` row and the DB plan feature)
- [ ] Help article, new SQL file. Ask Your Team only reads published `help_articles`
- [ ] Privacy notice covers guest names and comments. Terms cover shared links. Bump the terms version
      with the login prompt copy only if the terms change materially
- [ ] Tests: unit for §5, a Playwright spec for the guest journey, the prompt-surfaces pin
- [ ] Manual staging run with a real email to a Hotmail/Outlook address, to prove the scanner does not
      break the link and does not record a view
- [ ] Commit only this feature's hunks: `workspace.html` and other shared files had uncommitted work from
      parallel sessions when this was written

## 9. Left out of v1

Live cursors and canvases, guest accounts, guest AI prompts, "fork to my workspace", guest-triggered
publishing, removing the credit, Admin dashboard (SQL is enough for 30 days), referral credit for guest
sign-ups, pins on images, version history beyond the content hash.
