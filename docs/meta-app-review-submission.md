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
**How the app uses it:** Be More Swan is a social media planning assistant. The business owner
creates or approves a post (image or video with a caption) in their Be More Swan content calendar
and schedules it. At the scheduled time, the app publishes it to their connected Instagram
Business account using the content publishing API (`/{ig-user-id}/media`, then `/media_publish`).
Nothing is published unless the user has created or approved that post.
_Code: `publish-instagram.ts`._

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
**How the app uses it:** The business owner creates or approves posts in their Be More Swan
content calendar. At the scheduled time, the app publishes each post to their connected Facebook
Page (`/{page-id}/feed`, or `/{page-id}/photos` when an image is attached). Posts are only
published when the user has created or approved them.
_Code: `publish-facebook.ts`._

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


### pages_manage_posts (Facebook card, ~2 min)
A–C → select the Page, then:
1. Open the Social Media Manager assistant → **Review** → open a Facebook post draft with an image
   → **Approve & Schedule** for 2–3 minutes ahead. The Facebook publisher runs every 10 minutes,
   so cut the wait.
2. Optionally show it in the Content Calendar.
3. Wait (cut is fine here, but not during login) → open the Facebook Page → show the post live.
   *Annotation: "Published via /{page-id}/photos using pages_manage_posts"*

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

### instagram_content_publish (Instagram card, ~2 min)
A–C → select the account, then:
1. Assistant → **Review** → open an Instagram post draft with an image → **Approve & Schedule** for
   1–2 minutes ahead.
2. Wait → open the Instagram profile → show the post live. *Annotation: "Published via
   /{ig-user-id}/media + /media_publish using instagram_content_publish"*

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

## Reviewer instructions (paste into "Reviewer instructions")

> Be More Swan (https://bemoreswan.com) is an AI social media assistant for small businesses. It
> publishes the posts a business owner approves to their Facebook Page and Instagram Business
> account, and reports how those posts perform.
>
> Test account: [email] / [password]. This account has a paid plan and the social media assistant
> enabled.
>
> 1. Sign in at https://bemoreswan.com/login.
> 2. Go to Integrations. On the Facebook card click Connect, log in with your Facebook test user and
>    select a Page that has a linked Instagram Business account. Then do the same on the Instagram
>    card and select that Page's Instagram account.
> 3. Open the Social Media Manager assistant → Review, open a post with an image and click Approve &
>    Schedule for a couple of minutes ahead. It
>    appears on the Facebook Page (pages_manage_posts) and on Instagram (instagram_content_publish).
> 4. Open Assistants → Social Media Manager and scroll to Performance Metrics. The Engagement Rate,
>    Organic Reach Growth and Meaningful Engagement cards are calculated from post insights
>    (instagram_manage_insights, pages_read_engagement). Insights refresh every 6 hours, so posts
>    published during the review appear in the cards later.

**Before submitting:** create a dedicated reviewer login on production. Don't reuse a real
customer's. Check that every step above matches the current UI labels, and that the reviewer
account can see the Integrations page without onboarding blocking it.
