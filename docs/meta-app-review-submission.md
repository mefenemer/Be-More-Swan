# Meta App Review — Facebook/Instagram app submission

Copy-paste answers for the "Allowed usage" step of the App Review form. Each answer is based on
how the code uses the permission (file references included so they can be kept accurate).

**Why this is needed:** the app is Live and Business-verified, but none of these permissions has
Advanced Access yet. Until App Review approves them, only people with a role on the app (admins,
developers, testers) can complete Facebook Login. Everyone else, such as customers, gets
"Feature Unavailable … updating additional details for this app".

**Short-term unblock:** add the customer as a Tester (App Roles → Roles). They accept at
developers.facebook.com/requests, and then they can connect. `request-meta-tester.ts` already exists for this.

---

## Resubmission 2026-11-02: `pages_manage_posts` + `instagram_content_publish`

**Result of the first review:** approved `instagram_manage_insights`, `instagram_basic`,
`business_management`, `pages_read_engagement`, `pages_show_list`. Rejected `pages_manage_posts`
and `instagram_content_publish`, both for *"Screencast Not Aligned with Use Case Details"*. Meta
says the use case **is allowed**. Only the video was the problem: it must show (1) the complete
Meta login, (2) the user granting the permission, (3) the end-to-end use, (4) English UI with
captions explaining buttons, and (5) state whether the app is server-to-server (it is not).

**What most likely failed the old video** (it followed the old script in this doc):
- **No visible grant.** If the Facebook login had already approved Be More Swan, Meta shows only
  "Continue as …" and skips the permission list. The reviewer never sees the permission granted.
  You must remove the app from Facebook first (step P2 below).
- **A cut between approving and the post going live.** The old script used Approve & Schedule and
  "cut the wait" (the publisher runs every 10 minutes). The reviewer can't tell the post on
  Facebook came from Be More Swan. **Post Now** publishes in seconds, so the whole thing fits in
  one continuous take.
- **The use-case text said "at the scheduled time"** while the video showed something else. The
  answers above now describe exactly what the new video shows: Post Now, and Schedule for Later as
  the alternative.

### Before recording

- **P1. Record in the workspace that already owns the Page/IG** (bemoreswan's own workspace, prod
  org 37), or in a workspace whose Page isn't connected anywhere else. The one-workspace-per-account
  block (`ENFORCE_TENANT_COLLISION`, armed on prod) refuses a Page that is live in another workspace.
  So the `meta-review@` reviewer workspace **cannot** connect @bemoreswan. In that workspace,
  disconnect Facebook and Instagram on Integrations first.
- **P2. Remove Be More Swan from the Facebook login:** facebook.com → Settings & privacy →
  Settings → **Business integrations** → Be More Swan → Remove. This is the only way Meta shows
  the full permission screen again. ⚠️ It cuts every connection made with that login, including
  Love Cat Studio (org 38). Reconnect both afterwards, ticking **all** businesses, Pages and IG
  accounts. Do it when no posts are due. Repeat P2 before the second recording.
- **P3. Set the language to English (US or UK)** on Facebook (Settings → Language and region) and
  Instagram, and in the browser. Close other tabs and bookmarks that show personal things. Use a
  window ≤ 1440 px wide and turn notifications off.
- **P4. A fresh draft waits in Review** for each platform, with an image (JPEG) and a short,
  obviously-new caption, e.g. "Testing Be More Swan publishing — 2 Nov". Use a new draft per take,
  because a published post can't be posted again.
- **P5. Dry run once, off camera,** on prod: Post Now on a throwaway draft for each platform →
  Published → "View live post" opens it. Delete the test post on Facebook/Instagram afterwards.
  If it fails, fix it before recording. Don't find out on camera.
- **P6. Log out of Be More Swan and Facebook** (and Instagram on the web) before pressing record.

### Recording 1 — `pages_manage_posts` (Facebook card, ~3 min, one unbroken take)

Captions go on screen as text boxes (iMovie titles, ScreenFlow or Camtasia callouts), held ~4 s
each. No audio needed. Zoom in on the permission screen and the published post.

| # | On screen | Caption |
|---|---|---|
| 1 | bemoreswan.com → Log in → sign in | "Be More Swan: social media assistant for small businesses. The business owner logs in." |
| 2 | Sidebar → **Integrations** → Facebook card | "Integrations: where the owner connects their social accounts." |
| 3 | Click **Connect** on Facebook → pre-connect checklist → continue | "'Connect' starts Facebook Login so Be More Swan can publish to the owner's Page." |
| 4 | facebook.com login page → type email + password → Log in | "Meta login: the owner logs in to Facebook." |
| 5 | Meta dialog → businesses → **Pages** (tick the Page) → IG if asked | "The owner chooses which Facebook Page Be More Swan can use." |
| 6 | Permission review screen, **zoomed**, with "Create and manage content on your Page" visible and on → **Save / Continue** | "Granting pages_manage_posts: lets Be More Swan publish posts the owner approves to this Page." |
| 7 | Back in Be More Swan → picker (if shown) → Facebook card shows **Connected** | "The Facebook Page is now connected." |
| 8 | Open the Social Media Manager assistant → **Review** → open the Facebook draft | "The AI assistant drafted this post. Nothing is published until the owner approves it." |
| 9 | Hover **Post Now** (show Schedule for Later and Reject too) | "'Post Now' publishes immediately. 'Schedule for Later' publishes at a chosen time. 'Reject' discards it." |
| 10 | Click **Post Now** → confirmation | "Be More Swan calls POST /{page-id}/photos with the Page token (pages_manage_posts)." |
| 11 | Reopen the post (Content Calendar) → green **Posted** box → click **View live post →** | "Published. 'View live post' opens it on Facebook." |
| 12 | Facebook Page shows the post (same image + caption), **zoomed** | "The post is live on the business's Facebook Page, published by Be More Swan." |

### Recording 2 — `instagram_content_publish` (Instagram card, ~3 min, one unbroken take)

Do P2 again first, so the grant appears.

| # | On screen | Caption |
|---|---|---|
| 1–2 | Same as Recording 1 | (same) |
| 3 | Click **Connect** on Instagram → "Connecting Instagram" → **Continue to Facebook** | "Instagram Business accounts connect through Facebook Login." |
| 4 | Facebook login → email + password | "Meta login: the owner logs in with the Facebook account that manages their Instagram." |
| 5 | Meta dialog → business → Page → **Instagram account** ticked | "The owner chooses the Instagram Business account Be More Swan can use." |
| 6 | Permission review screen, **zoomed**, with the Instagram content-publishing permission visible and on → Continue | "Granting instagram_content_publish: lets Be More Swan publish posts the owner approves to this Instagram account." |
| 7 | Picker shows **@username** → select → Instagram card **Connected** | "The Instagram Business account is now connected." |
| 8–9 | Assistant → **Review** → Instagram draft → hover the buttons | (as Recording 1, with "Instagram") |
| 10 | **Post Now** | "Be More Swan creates a media container (POST /{ig-user-id}/media) and publishes it (POST /{ig-user-id}/media_publish)." |
| 11 | Reopen the post → green **Posted** box → **View live post →** | "Published. 'View live post' opens it on Instagram." |
| 12 | instagram.com profile → the post, **zoomed** | "The post is live on the business's Instagram account, published by Be More Swan." |

### In the submission form (both permissions)

- Paste the new "How the app uses it" text above. Upload Recording 1 for `pages_manage_posts`
  and Recording 2 for `instagram_content_publish`.
- Add to the notes: *"Be More Swan is a web app using Facebook Login with the user's own access
  token. It is not a server-to-server app and does not use system user tokens. The screencast
  shows the full Facebook login, the permission being granted, and the post being published and
  shown live on Facebook/Instagram in one continuous recording."*
- Check the reviewer login (`review-login.html`, `META_REVIEW_LOGIN_*`) still works and hasn't
  expired. Leave fresh Facebook and Instagram drafts in the reviewer workspace's Review list.

---

## Not submitted: `pages_messaging`

Removed from this submission and from `SCOPES` in `netlify/functions/meta-oauth.ts`. Why:

- Reviewers for `pages_messaging` expect to message the Page in Messenger and see the app respond.
  The app has no Messenger webhook (no `hub.challenge` handler, no `/{page-id}/subscribed_apps`).
- The required "API test call" is unlikely to pass. The `/{page-id}/messaging` call in
  `social-auto-responder.ts` has no `recipient`, so the Send API rejects it.
- Instagram DM greetings need `instagram_manage_messages`, which is not requested anyway.

Consequence: the auto-responder's push to Meta (`social-auto-responder.ts`) will fail for new
connections until messaging is built properly and approved. Re-add the scope only alongside a
webhook, a `subscribed_apps` subscription and a real reply flow, then submit it on its own.

---

## Not submitted: `pages_manage_metadata`

Removed from this submission and from `SCOPES`. Its only use was the Meta branch of Sync Profile
(`social-profile-sync.ts`), which is now disabled (`META_PROFILE_SYNC_ENABLED = false`) and its
button hidden for Facebook/Instagram, because it:
- set the Page website to Be More Swan's own URL (`baseUrl`), overwriting the customer's;
- read the Instagram connection, so a Facebook-only connect was skipped;
- sent hours and category in formats Meta's Page update doesn't accept.

Fix those, re-add the scope, and submit it on its own.

---

## Permission answers

### pages_show_list
**How the app uses it:** After the user logs in with Facebook, Be More Swan calls `/me/accounts`
to list the Facebook Pages the user manages, and the Instagram Business account linked to each Page.
The user then chooses which Page/Instagram account to connect to their Be More Swan workspace. We
only use the list to let the user make that choice and to store the chosen Page's ID and access
token so the app can publish and read insights on their behalf.
_Code: `meta-oauth.ts` (`/me/accounts?fields=id,name,instagram_business_account`)._

### business_management
**How the app uses it:** Many small businesses own their Facebook Page through a Meta Business
portfolio. Those Pages, and the Instagram accounts linked to them, are not always returned by
`/me/accounts`. During connection, Be More Swan calls `/me/businesses` and then each business's
owned and client Pages, only to find the Page and Instagram account the user wants to connect. We
do not create, modify or manage businesses, ad accounts, assets or users in Business Manager.
_Code: `meta-oauth.ts` business-portfolio fallback._

### instagram_basic
**How the app uses it:** When the user connects, Be More Swan reads the ID and username of each
Instagram Business account linked to their Pages. It shows them as @username in an account
picker, so the user can choose which account to connect, and it stores the chosen account's ID
for publishing and insights. The app also reads the connected account's follower count
(`followers_count`), which appears in the Audience panel on the assistant's page. There, the
business owner can track audience growth alongside their marketing goals.
_Code: `meta-oauth.ts`, `src/utils/meta-accounts.ts` (picker), `src/utils/follower-counts.ts`._

### instagram_content_publish
**How the app uses it (resubmission wording, 2026-11-02 — matches the screencast step for step):**
Be More Swan is a web app that helps small businesses run their social media. A business owner
logs in to Be More Swan, opens Integrations and clicks Connect on the Instagram card. They log in
with Facebook and grant Be More Swan access to the Instagram Business account linked to their
Facebook Page, including permission to publish content. Be More Swan's AI assistant drafts a post
(an image and a caption). The owner opens the draft in the Review panel, reads it, and clicks
**Post Now**. Be More Swan then publishes it to their Instagram Business account using the content
publishing API: it creates a media container with `POST /{ig-user-id}/media` and publishes it with
`POST /{ig-user-id}/media_publish`. The post is marked Published in Be More Swan, with a "View
live post" link to the post on Instagram. Owners can also click **Schedule for Later**, and the
same publishing call runs at the time they choose. Be More Swan never publishes a post the owner
has not approved. It uses Facebook Login with the user's own access token. It is not a
server-to-server app and does not use a system user token.
_Code: `publish-instagram.ts`, `approve-post.ts` (`publish_now`), `publish-now-background.ts`._

### instagram_manage_insights
**How the app uses it:** After a post is published through Be More Swan, the app periodically
reads that post's insights (reach, likes, comments, saves, shares, video views) via
`/{media-id}/insights`. It combines them into the Performance Metrics cards on the assistant's
page (Engagement Rate, Organic Reach Growth, Meaningful Engagement), which show the business owner
how their content is performing and track progress toward their marketing goals. Insights are only shown to the account owner and their
workspace team. They are never shared with third parties or used for advertising.
_Code: `ingest-instagram-insights.ts`, `get-assistant-performance.ts`._

### pages_read_engagement
**How the app uses it:** Be More Swan reads the reactions, comments and shares on posts it
published to the user's Facebook Page, and the Page's follower count. Engagement is combined
across posts into the Engagement Rate and Meaningful Engagement cards on the assistant's page. The
follower count appears in its Audience panel. Be More Swan does not show individual post stats.
Only the Page owner and their workspace team see this data, and it is never shared with third
parties or used for advertising.
_Code: `ingest-facebook-insights.ts` (post `reactions`/`comments`/`shares` summaries),
`src/utils/follower-counts.ts` (`followers_count`, `fan_count`)._

> ⚠️ Not claimed: reach, impressions and link clicks. The ingester also calls `/{post-id}/insights`
> for those, but Page/post insights likely also need `read_insights`, which is not requested. Add
> them to this answer only if `read_insights` is added to `SCOPES` and to the submission.

### pages_manage_posts
**How the app uses it (resubmission wording, 2026-11-02 — matches the screencast step for step):**
Be More Swan is a web app that helps small businesses run their social media. A business owner
logs in to Be More Swan, opens Integrations and clicks Connect on the Facebook card. They log in
with Facebook, choose the Facebook Page they want to connect, and grant Be More Swan permission to
create and manage content on that Page. Be More Swan's AI assistant drafts a post (an image and a
caption). The owner opens the draft in the Review panel, reads it, and clicks **Post Now**. Be More
Swan then publishes it to the connected Page with `POST /{page-id}/photos`, or
`POST /{page-id}/feed` for a text-only post, using that Page's access token. The post is marked
Published in Be More Swan, with a "View live post" link to the post on the Facebook Page. Owners
can also click **Schedule for Later**, and the same call runs at the time they choose. Be More
Swan never publishes a post the owner has not approved. It uses Facebook Login with the user's own
access token. It is not a server-to-server app and does not use a system user token.
_Code: `publish-facebook.ts`, `approve-post.ts` (`publish_now`), `publish-now-background.ts`._

---

## Screencast scripts

Based on Meta's guide (developers.facebook.com/docs/app-review/submission-guide/screen-recordings):
- **Every recording** starts logged out of Be More Swan *and* Facebook. Show the full login, the
  Connect click, and the **whole Meta dialog** with the permission visibly granted. Then show the
  feature using the data, and the result on Facebook/Instagram itself.
- English UI, 1080p, screen width ≤ 1440px, larger cursor, mouse not keyboard, **no audio**.
- Add on-screen annotations naming the permission at the moment it's used, and zoom in on small
  details (QuickTime + iMovie is enough).
- You don't explain *why* in the video. That goes in the form's description.

**Which card:** Integrations has two separate cards. **Facebook** (`platform=facebook`) stores
the Page connection used by Facebook publishing and Page engagement. Its picker
lists Page names. **Instagram** (`platform=instagram`) stores the Instagram account connection. Its
picker lists @usernames. Use Facebook for `pages_*` and Instagram for `instagram_*`.

**Be More Swan shows no per-post stats.** Insights only appear combined, in the **Performance
Metrics** cards (assistant page) and the **Audience** block. Show the per-post numbers on
Facebook/Instagram as the source.

**Before recording anything:**
- The reviewer account's Page is owned by a Business portfolio, and the Facebook user is *not* a
  direct Page admin (needed to show business_management).
- That Page has a linked Instagram Business account.
- The Facebook user manages **at least two Pages**. With one, Be More Swan skips its picker
  (`meta-oauth.ts:483`) and the Page list that pages_show_list produces is never shown.
- A few posts were published *by Be More Swan* to both, at least a day ago, with some likes and
  comments. That way the Performance Metrics cards and Audience block show real values, not "—" or 0.

The common opening (steps A–C) is the same in every recording:
- **A.** Logged out → log in to bemoreswan.com → **Integrations**.
- **B.** Click **Connect** on the stated card → Facebook login.
- **C.** Meta dialog: select the business, the Page (and the Instagram account if asked) → leave
  all permissions on → continue. *Annotation: "Granting <permission>"*

### pages_show_list (Facebook card, ~1 min)
A–C, then:
1. Pause on Be More Swan's picker, which lists the user's Pages by name (needs 2+ Pages, or the
   picker is skipped). *Annotation: "Pages listed via /me/accounts using pages_show_list"*
2. Select the Page → show the Facebook card as connected.

### business_management (Facebook card, ~1.5 min)
0. Optional first: business.facebook.com → Business settings → Accounts → Pages → show the Page is
   owned by the portfolio. *Annotation: "Page owned by a Business portfolio, not directly by the user"*

A–C, showing the **business selection** step in the dialog, then:
1. Pause on the picker with the portfolio-owned Page listed. *Annotation: "Found via
   /me/businesses → owned_pages using business_management, not returned by /me/accounts"*
2. Select it → connected.


### pages_manage_posts
**Superseded:** rejected 2026-11-02. Use the script in "Resubmission 2026-11-02" above.

### pages_read_engagement (Facebook card, ~2 min)
A–C → select the Page, then:
1. Assistant → **Performance Metrics** → pause on Engagement Rate and Meaningful Engagement.
   *Annotation: "Combined from reactions, comments and shares on the Page's posts, read via
   pages_read_engagement"*. Don't point at Click-Through Rate (see the read_insights note).
2. **Audience** block → the Facebook follower count. *Annotation: "Page follower count read via
   pages_read_engagement"*
3. Open one of those posts on the Facebook Page → show its reactions, comments and shares as the
   source.

### instagram_basic (Instagram card, ~1.5 min)
A–C, then:
1. Pause on the picker showing **@username** "via <Page name>". *Annotation: "Instagram username and
   account ID read via instagram_basic"*
2. Select → connected.
3. Assistant → **Audience** block → the Instagram follower count. *Annotation: "followers_count
   read via instagram_basic"*
4. Open the Instagram profile → same handle and follower count.

### instagram_content_publish
**Superseded:** rejected 2026-11-02. Use the script in "Resubmission 2026-11-02" above.

### instagram_manage_insights (Instagram card, ~2 min)
A–C → select the account, then:
1. Assistant → **Performance Metrics** → pause on Engagement Rate, Organic Reach Growth and
   Meaningful Engagement. *Annotation: "Calculated from Instagram post insights read via
   instagram_manage_insights"*. Click-Through Rate is always empty for Instagram, so don't point
   at it.
2. Open one of the published posts on Instagram → **View insights** → show reach, likes, comments,
   saves and shares. *Annotation: "These per-post insights are read every 6 hours and combined
   into the cards above"*

---

## Reviewer instructions (paste into "Provide testing instructions")

**Set up first (on production):**
- Reviewer account **`meta-review@bemoreswan.com`**. Normal login is a magic link a reviewer can't
  open, so the reviewer uses `review-login.html` instead. To create the account, alias the address
  to a real mailbox, sign up, and open the one magic link. Put the workspace on a plan with the
  Social Media Manager assistant via the admin billing override, so the 14-day trial can't expire
  during review or Meta's later re-checks.
- Netlify prod env, the **Meta reviewer slot** (separate from Google's `REVIEW_LOGIN_*`, which keeps
  working): `META_REVIEW_LOGIN_PASSWORD` (≥ 20 chars, otherwise the slot stays dark),
  `META_REVIEW_LOGIN_EXPIRES` (ISO date, well past the review, e.g. 2027-01-31; expired or
  unparseable turns it off). `META_REVIEW_LOGIN_EMAIL` is only needed to override the default
  `meta-review@bemoreswan.com`. The password goes only into Meta's form, not this doc. Delete
  `META_REVIEW_LOGIN_PASSWORD` to switch the Meta reviewer off without affecting Google's.
- ⚠️ Netlify only applies env changes on the next deploy. After setting (or deleting) these,
  trigger a deploy. Until then `review-login.html` says "Reviewer sign-in is not currently
  enabled" (the endpoint 404s). Function logs show `meta slot refused: <reason>` if a value is
  wrong; no log line means the variable isn't reaching functions (scope/context/name).
- Test `https://bemoreswan.com/review-login.html` in a private window before submitting.
- A draft Facebook post and a draft Instagram post, each with a JPEG image, waiting in the
  assistant's Review list.

The reviewer connects their **own** Facebook test user and Page, so they will have no published
posts or insights at first. The instructions point them to the screencasts for that.

> Be More Swan (https://bemoreswan.com) is a web app for small businesses. Its AI Social Media
> Manager drafts posts. The business owner reviews and approves them, and Be More Swan publishes
> them to the owner's Facebook Page and Instagram Business account and reports how they perform.
>
> **Login:** https://bemoreswan.com/review-login.html (reviewer sign-in page, not the normal login)
> Email: meta-review@bemoreswan.com
> Password: [REVIEW_LOGIN_PASSWORD]
> This account has a plan that includes the Social Media Manager assistant, and draft posts are ready to approve.
>
> **Facebook (pages_show_list, business_management, pages_manage_posts, pages_read_engagement)**
> 1. Go to Integrations → Facebook card → Connect, and log in with your Facebook test user.
> 2. Select a Page, ideally one owned by a Business portfolio. Be More Swan's picker lists your
>    Pages (shown when you manage two or more). Select one.
> 3. Open the Social Media Manager assistant → Review, open the Facebook draft and click
>    Post Now. Within about a minute the post shows as Published, with a "View live post" link
>    that opens it on your Page.
>
> **Instagram (instagram_basic, instagram_content_publish, instagram_manage_insights)**
> 4. Go to Integrations → Instagram card → Connect, and select your Page's Instagram Business
>    account. The picker shows it as @username.
> 5. Open the Instagram draft and click Post Now. It appears on the Instagram profile within
>    about a minute, and "View live post" opens it.
>
> **Insights and engagement (instagram_manage_insights, pages_read_engagement, instagram_basic)**
> 6. In the assistant, the Performance Metrics cards (Engagement Rate, Organic Reach Growth,
>    Meaningful Engagement) and the Audience block (follower counts) are calculated from post
>    insights and engagement, which are imported every 6 hours. For a newly connected test Page
>    they stay empty until posts have been live for a while, so please see the screencasts for
>    these with real data.
>
> Be More Swan never publishes anything the user has not approved.

## Data handling answers

- **Processors with access to Platform Data:** Yes.
  - Netlify: IT solutions/cloud processing, United Kingdom + United States
  - Neon: IT solutions/cloud processing, United Kingdom
  - Anthropic: IT solutions/cloud processing, United States

  These match the sub-processor list on privacy.html and trust.html.
- **Responsible entity:** Be More Swan Ltd (ICO data controller ZC272072), United Kingdom.
- **National security requests in the past 12 months:** No.
- **Public-authority request policies:** tick only what is actually in place ("None of the above"
  unless a written policy exists).

## App settings checked for review

- Platform: **Website**, Site URL `https://bemoreswan.com`.
- Valid OAuth Redirect URI: `https://bemoreswan.com/.netlify/functions/meta-oauth?action=callback`
  (or `META_REDIRECT_URI` if set; see `meta-oauth.ts:243`).
- Data deletion callback: `https://bemoreswan.com/api/meta/facebook/delete` (`meta-callbacks.ts`).
