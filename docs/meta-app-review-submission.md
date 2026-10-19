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

## ⚠️ Decide first: `pages_messaging`

This is the permission most likely to fail review. It is also the only one that requires
"API test calls" and reproduction steps.

- Reviewers for `pages_messaging` expect to **send a message to the Page in Messenger and see the
  app respond**. The app has no Messenger webhook (no `hub.challenge` handler, no
  `/{page-id}/subscribed_apps` call), so it never receives or replies to messages.
- `social-auto-responder.ts` sets the Messenger **greeting** via `/{page-id}/messenger_profile`
  (legitimate). It also POSTs to `/{page-id}/messaging` with no `recipient`, which the Send API
  rejects, so the "auto-reply" never actually sends.
- The Instagram DM greeting call (`/{ig-user-id}/messenger_profile`) needs
  `instagram_manage_messages`, which is not requested at all.

**Recommendation:** remove `pages_messaging` from this submission (Edit submission → remove), and
remove it from `SCOPES` in `netlify/functions/meta-oauth.ts:42` so the login dialog doesn't ask for
it. Ship publishing, insights and profile sync first. Submit messaging later, once there is a webhook
and a real reply flow to demonstrate. Submitting it now risks the **whole** submission being
rejected.

The answers below include `pages_messaging` in case you keep it.

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
**How the app uses it:** Be More Swan reads the connected Instagram Business account's ID,
username and profile details. We show the user which account is connected, and we use the ID for
publishing and insights. We also read the user's own media IDs so we can match posts the app
published with their performance metrics.
_Code: `meta-oauth.ts`, `publish-instagram.ts`, `ingest-instagram-insights.ts`._

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
`/{media-id}/insights`. It shows them to the business owner on the Performance Metrics cards and
progress toward their marketing goals. Insights are only shown to the account owner and their
workspace team. They are never shared with third parties or used for advertising.
_Code: `ingest-instagram-insights.ts`, `get-assistant-performance.ts`._

### pages_read_engagement
**How the app uses it:** Be More Swan reads the connected Page's basic details, and reads
engagement and insights (reach, impressions, link clicks, reactions) for posts the app published
to that Page. These metrics appear only to the Page owner in their performance dashboard, and
they help the user see which content drives traffic to their website.
_Code: `ingest-facebook-insights.ts` (`post_impressions_unique`, `post_impressions`, `post_clicks_by_type`)._

### pages_manage_posts
**How the app uses it:** The business owner creates or approves posts in their Be More Swan
content calendar. At the scheduled time, the app publishes each post to their connected Facebook
Page (`/{page-id}/feed`, or `/{page-id}/photos` when an image is attached). Posts are only
published when the user has created or approved them.
_Code: `publish-facebook.ts`._

### pages_manage_metadata
**How the app uses it:** Be More Swan keeps the business's Facebook Page profile consistent with
the business profile the owner maintains in Be More Swan. When the user triggers a profile sync (and
once right after connecting), the app updates the Page's website, description, category and opening
hours. The data comes from what the user entered in their Be More Swan business profile.
_Code: `social-profile-sync.ts` (`POST /{page-id}`)._

### pages_messaging _(see warning above)_
**How the app uses it:** Be More Swan generates a Messenger greeting for the business, using the
business's tone of voice. After the owner reviews and approves it, the app sets it on their Page
via the Messenger Profile API (`/{page-id}/messenger_profile`). People who open a conversation with
the Page then see it.
_Code: `social-auto-responder.ts`._
_Reviewer test calls / reproduction: Meta requires at least one successful messaging API call in the
last 30 days, made from the app, and steps a reviewer can follow to see the result in Messenger._

---

## Screencast scripts

General rules Meta enforces (most rejections come from these):
- Use English UI (or captions), at least 720p, with no cuts that hide the login flow.
- Start **logged out** of Be More Swan. Show login → Connect Facebook/Instagram → the **Meta
  permission dialog with each permission visible** → the account selection → the feature using it.
- Show the result **on Facebook/Instagram itself** (the published post, the updated Page info), not
  just inside Be More Swan.
- One recording covering everything is fine. Upload it against each permission, and add short
  captions/annotations that name the permission as each feature appears.

Suggested single recording (~4–5 min):
1. Log in to bemoreswan.com with the reviewer account → Integrations → Connect Facebook & Instagram.
2. Meta dialog: choose the business portfolio, Page and Instagram account, and leave all permissions
   granted. *(pages_show_list, business_management)*
3. Back in Be More Swan: the connected Page and Instagram username are shown. *(instagram_basic)*
4. Trigger the profile sync [check the button label] → open the Facebook Page in a new tab → show the updated website,
   description and hours. *(pages_manage_metadata)*
5. Content calendar: create a post with an image, approve it, publish [check label] or schedule for one minute
   ahead → show it live on the Facebook Page *(pages_manage_posts)* and on Instagram
   *(instagram_content_publish)*.
6. Open the assistant's Performance Metrics → show the reach/engagement figures for those
   posts. *(instagram_manage_insights, pages_read_engagement)*. Use posts that are a day or more
   old so the figures are non-zero, and say so in a caption.
7. *(only if keeping pages_messaging)* Generate the auto-responder → approve → open the Page in
   Messenger from a different account → show the greeting.

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
> 2. Go to Integrations and click "Connect Facebook & Instagram". Log in with your Facebook test
>    user and select a Page that has a linked Instagram Business account.
> 3. Click [profile sync button] to see the Page's website/description/hours updated (pages_manage_metadata).
> 4. Open the Content Calendar, create a post with an image, approve it and publish it [check the button label]. It
>    appears on the Facebook Page (pages_manage_posts) and on Instagram (instagram_content_publish).
> 5. Open the assistant's Performance tab to see post insights (instagram_manage_insights,
>    pages_read_engagement). Insights refresh every 6 hours.

**Before submitting:** create a dedicated reviewer login on production. Don't reuse a real
customer's. Check that every step above matches the current UI labels, and that the reviewer
account can see the Integrations page without onboarding blocking it.
