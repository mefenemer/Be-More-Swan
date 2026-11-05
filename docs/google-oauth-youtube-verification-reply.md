# Google OAuth verification — YouTube project (218009229183)

Reply to the "[Action Needed] Your Google APIs Verification Request" email of 2026-11-05.
Send it only once the four fixes in "Before you reply" are done. The reply says they are.

## What this project actually requests (checked against the code, 2026-11-05)

| Scope | Sensitivity | Used for | Code |
| --- | --- | --- | --- |
| `https://www.googleapis.com/auth/youtube.upload` | Sensitive | Upload a video the user has approved to their own channel (resumable upload, `videos.insert`) | `src/utils/social-publish.ts` (upload), `netlify/functions/publish-youtube-background.ts` |
| `https://www.googleapis.com/auth/youtube.readonly` | Sensitive | `channels.list?mine=true`: the channel name on the connection card, plus the channel's subscriber count on the assistant's Results tab | `netlify/functions/oauth-integrations.ts:850`, `src/utils/follower-counts.ts:66`, `netlify/functions/poll-goal-telemetry.ts:104` |

No other Google scope runs on this project. Gmail (`gmail.send`) is on a **different** project
(609555613434). The Search Console scope exists in the code, but its client ID
(`SEARCHCONSOLE_CLIENT_ID`) isn't set anywhere, so it never runs. Neither project has a restricted
scope, so **no CASA assessment is needed**.

## Before you reply

1. **Scope match.** In Cloud Console → `be-more-swan` → Google Auth Platform → Data Access, the list
   must be **exactly** `youtube.upload` + `youtube.readonly`. Remove anything else, including
   Search Console, Drive, Sheets or Gmail. Any mismatch is an automatic rejection, which is how
   the Gmail submission failed on 2026-08-26.
2. **Privacy policy.** ✅ Done 2026-11-05: privacy.html section 13 now has a "YouTube API Services" subsection (anchor `#youtube-api-services`). Deploy it to prod before replying. It says:
   - Be More Swan uses YouTube API Services, with links to the YouTube Terms of Service
     (https://www.youtube.com/t/terms) and the Google Privacy Policy
     (https://policies.google.com/privacy).
   - What we access: channel ID, title and thumbnail, subscriber count, and the
     videos the user uploads through us.
   - What we use it for, who we share it with (nobody beyond hosting sub-processors), how it is
     protected (AES-256-GCM encrypted tokens, TLS), and how long we keep it.
   - How to revoke access, both in-app (Disconnect) and at
     https://security.google.com/settings/security/permissions.
3. **Demo video.** Upload it to YouTube as unlisted. In order:
   - Sign in → Connections → YouTube → Connect.
   - On the Google consent screen, click "Show all services" so both scopes can be read.
   - Back in the app, the connection card shows the channel name (`youtube.readonly`).
   - Results tab shows the subscriber count; cut to YouTube Studio showing the same number.
   - Approve a video → publish it → cut to YouTube Studio showing the video on the channel
     (`youtube.upload`).
   - Show the browser address bar while the consent screen is up, so the OAuth client ID is visible.
4. **Reviewer access.** The staging reviewer sign-in is live until 2027-01-31
   (`https://staging--bemoreswan.netlify.app/review-login.html`, account `bmsreview.test@gmail.com`;
   the password is `REVIEW_LOGIN_PASSWORD` in Netlify). Check the staging callback URL is listed under
   the YouTube OAuth client's authorised redirect URIs, and that the reviewer workspace can reach
   the YouTube connection.

---

## Draft reply (paste into the reply to the Google email)

> Hello Third Party Data Safety Team,
>
> Thank you for the checklist. We have audited project be-more-swan (218009229183) against it and
> made the changes below.
>
> **App and scopes**
> Be More Swan (https://bemoreswan.com) is an AI marketing assistant for small businesses. It
> drafts social posts and short videos, and publishes them only after the business owner approves
> them. This project requests two scopes, both used only by the YouTube connection:
>
> 1. `https://www.googleapis.com/auth/youtube.upload`: when the user approves a video in the app,
>    we upload it to their own channel with videos.insert. Nothing is uploaded without the user
>    approving it first. This is the narrowest scope that allows uploading; we do not request
>    `youtube` or `youtube.force-ssl` because we never edit, delete or comment on existing content.
> 2. `https://www.googleapis.com/auth/youtube.readonly`: we call channels.list (mine=true) to show
>    the connected channel's name on the connection card, so the user knows which channel will be
>    published to. We also show its subscriber, view and video counts on the assistant's Results
>    tab, so the user can see how their channel is growing. youtube.upload does not authorise
>    channels.list, and no narrower scope returns channel statistics.
>
> The scopes configured in Cloud Console exactly match the scopes the app requests. No restricted
> scopes are requested.
>
> **Demo video (unlisted):** <VIDEO LINK>
> The video shows the consent screen with every scope expanded, the channel name and statistics
> appearing in the app, and an approved video being uploaded and then shown in YouTube Studio.
>
> **Test access**
> Sign-in page: https://staging--bemoreswan.netlify.app/review-login.html
> Email: bmsreview.test@gmail.com
> Password: <PASSWORD>
> The account has no phone verification or payment step. After signing in: Connections → YouTube →
> Connect, then sign in with any Google account that has a YouTube channel.
>
> **Privacy policy:** https://bemoreswan.com/privacy (section 13, including its YouTube API
> Services section). It states what YouTube data we access and why, that we share it with no
> third party beyond our hosting sub-processors, how it is protected (tokens encrypted with
> AES-256-GCM, TLS in transit), how long we keep it and how it is deleted, and how users can revoke
> access in the app or in their Google security settings. Google user data is never used for
> advertising, never sold, and never used to train AI/ML models.
>
> **Use case:** publishing the user's own approved videos to their own channel. We do not reward
> viewers for subscribing, liking or any other interaction.
>
> Please let us know if you need anything else.
>
> Kind regards,
> <NAME>
> Be More Swan
