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
`/{media-id}/insights`. It combines them into the Performance Metrics cards on the assistant's
page (Engagement Rate, Organic Reach Growth, Meaningful Engagement), which show the business owner
how their content is performing and track progress toward their marketing goals. Insights are only shown to the account owner and their
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
6. Assistants → the Social Media Manager assistant → **Performance Metrics**. Pause on Engagement
   Rate, Organic Reach Growth and Meaningful Engagement. *(instagram_manage_insights,
   pages_read_engagement)*. The cards are aggregates, not per post, and Click-Through Rate is
   always empty for Instagram, so don't point at it.
7. Open one of the published posts on Instagram → **View insights** and show its reach, likes,
   comments, saves and shares. Caption: these per-post insights are what Be More Swan reads
   every 6 hours to calculate the cards. The cards must show real values before you record: use
   posts published a day or more ago, after an ingest run.

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
> 5. Open Assistants → Social Media Manager and scroll to Performance Metrics. The Engagement Rate,
>    Organic Reach Growth and Meaningful Engagement cards are calculated from post insights
>    (instagram_manage_insights, pages_read_engagement). Insights refresh every 6 hours, so posts
>    published during the review appear in the cards later.

**Before submitting:** create a dedicated reviewer login on production. Don't reuse a real
customer's. Check that every step above matches the current UI labels, and that the reviewer
account can see the Integrations page without onboarding blocking it.
