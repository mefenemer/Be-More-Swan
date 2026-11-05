# Google OAuth verification — YouTube project (218009229183)

Reply to the "[Action Needed] Your Google APIs Verification Request" email of 2026-11-05.
Send it only once everything in "Before you reply" is done. The reply says it is. In particular,
it says the demo video shows the subscriber count, which isn't true until the clip in item 3 is added.

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

1. **Scope match.** ✅ Checked 2026-11-05: Data Access lists exactly `youtube.readonly` and
   `youtube.upload` as sensitive, with nothing non-sensitive or restricted. The justification is
   filled in (874/1000 characters).
2. **Privacy policy.** ✅ Done 2026-11-05: privacy.html section 13 now has a "YouTube API Services" subsection (anchor `#youtube-api-services`). Live on prod, rechecked 2026-11-05. It says:
   - Be More Swan uses YouTube API Services, with links to the YouTube Terms of Service
     (https://www.youtube.com/t/terms) and the Google Privacy Policy
     (https://policies.google.com/privacy).
   - What we access: channel ID, name and subscriber count, and the
     videos the user uploads through us.
   - What we use it for, who we share it with (nobody beyond hosting sub-processors), how it is
     protected (AES-256-GCM encrypted tokens, TLS), and how long we keep it.
   - How to revoke access, both in-app (Disconnect) and at
     https://security.google.com/settings/security/permissions.
3. **Demo video.** ✅ Done: https://youtu.be/W2E0gbRaM00 (uploaded 2026-11-05, with the subscriber-count
   steps) plays for anyone with the link on the Be More Swan channel. It replaces https://youtu.be/d1K6GqxN2pM
   (3:33, no subscriber count). The old cut was checked frame by frame on 2026-11-05. Its
   captioned steps:
   1. Assistant Profile → Connections → YouTube → Connect, recorded on staging.
   2. Our own checklist pop-up, then "Continue to YouTube".
   3. Google sign-in. The caption shows the OAuth client ID `218009229183-r5hkj9…` (the project's
      only client).
   4. Google's "hasn't verified this app" notice.
   5. Consent screen showing both scopes: "Manage your YouTube videos" (upload) and "View your
      YouTube account" (readonly).
   6. Connected, with the channel name read via channels.list mine=true.
   7. YouTube switched on for the assistant.
   8–10. A YouTube Short is created, a video attached and titled, and the owner approves it:
      "Post it now → Yes, publish now".
   11. The upload runs with videos.insert (resumable).
   12. The Short appears in YouTube Studio on the owner's channel, Public.

   ⚠️ **Gap:** the video never shows the **subscriber count**, but both the Console
   justification and the reply say `youtube.readonly` is used for it. Google asks you to
   "demonstrate the full operational functionality of every requested scope", so this is the one
   likely objection. Fix: add a ~15-second clip showing the assistant's Results tab → Autopilot card → "Audience"
   chart with the YouTube subscriber count, then cut to YouTube Studio → Dashboard showing the same
   number. Re-upload and replace the link.
   Joined 2026-11-05 as new Steps 13–16 (from 3:33, 26 s, real screen captures with captions, no
   live motion): Felix's connection and YouTube Studio both show channel "BMS Test User", and both
   show 0 subscribers. Uploaded 2026-11-05 as https://youtu.be/W2E0gbRaM00; the draft reply below
   now links it.
   Minor: the consent screen names the app "staging--bemoreswan.netlify.app" rather than "Be More
   Swan". That is expected while branding is unverified, and isn't a reason to re-record.
4. **Reviewer access.** ✅ Checked 2026-11-05:
   - The staging sign-in is deployed: `https://staging--bemoreswan.netlify.app/review-login.html`
     returns 200, the function answers GET with 405 (live), and `REVIEW_LOGIN_EXPIRES` is 2027-01-31.
     The account is the code default `bmsreview.test@gmail.com`, because `REVIEW_LOGIN_EMAIL` is
     unset. The password is `REVIEW_LOGIN_PASSWORD` in the Netlify branch-deploy context.
   - The redirect URI is `https://staging--bemoreswan.netlify.app/api/oauth/youtube/callback`
     (`${BASE_URL}/api/oauth/youtube/callback`). The video shows a successful connect on staging,
     so it is registered on the YouTube client.
   - ✅ Signed in end to end with the password sent to Google (2026-11-05). It lands on
     workspace.html as Marmalade Productions (staging org 58), with 8 assistants.
   - ✅ Workspace data checked as the reviewer: Audience has 0 contacts; Ember has one lead ("Test
     Lead for Gmail") and forum suggestions from public Reddit threads; Felix's 72 drafts are about
     Marmalade's own films. Nothing about a real customer.
   - ⚠️ **Bug found and fixed (commit 24bfd1cf, staging):** Felix's Results tab → Audience showed
     YouTube "—". `get-follower-counts` returned `fetch failed` because `src/utils/follower-counts.ts`
     read the stored Google access token, which expires after 1 hour, without refreshing it. It now
     uses `getFreshAccessToken`, as goal telemetry already did. Until this fix reached the reviewer's
     staging, a reviewer could not see `youtube.readonly` reading the subscriber count. It needs a
     staging→main PR to reach prod.
   - ✅ Fix confirmed on staging as the reviewer (06:35 UTC, 2026-11-05): `get-follower-counts`
     returns YouTube `count: 0, available: true`. The 0 is a real API value, because hidden or
     missing counts come back as unavailable. Check that YouTube Studio shows the same number on the
     clip. If it doesn't, the connected channel isn't the one in Studio. X still returns
     `fetch failed` in the same chart, which is a separate problem and not part of this verification.
5. **Sender check.** ✅ Done 2026-11-05: Gmail's Show original gives SPF PASS (IP 209.85.220.73),
   DKIM PASS with domain google.com, and DMARC PASS. The email really came from Google. Optional
   extra: Cloud Console → Google Auth Platform → Verification Center should show the same request.

---

## Draft reply (paste into the reply to the Google email)

> Hello Third Party Data Safety Team,
>
> Thank you for the checklist. We have audited project be-more-swan (218009229183) against it and
> made the changes below.
>
> **App and scopes**
> Be More Swan (https://bemoreswan.com) is an AI marketing assistant for small businesses. It
> drafts social posts and short videos, and publishes them to the business's own accounts. This
> project requests two scopes, both used only by the YouTube connection:
>
> 1. `https://www.googleapis.com/auth/youtube.upload`: we upload the video, title and description
>    to the channel the user connected, using videos.insert. A video is uploaded only after the
>    user approves it, or if the user has chosen automatic publishing. Weekly Shorts made by the
>    assistant are opt-in and upload as unlisted. This is the narrowest scope that allows uploading; we do not request
>    `youtube` or `youtube.force-ssl` because we never edit, delete or comment on existing content.
> 2. `https://www.googleapis.com/auth/youtube.readonly`: we call channels.list (mine=true) to show
>    the connected channel's name on the connection card, so the user knows which channel will be
>    published to. We also show its subscriber count on the assistant's Results
>    tab, so the user can see how their channel is growing. youtube.upload does not authorise
>    channels.list, and no narrower scope returns channel statistics.
>
> The scopes configured in Cloud Console exactly match the scopes the app requests. No restricted
> scopes are requested.
>
> **Demo video (unlisted):** https://youtu.be/W2E0gbRaM00
> It was recorded on our staging environment, as your guidance asks for a live app. It shows the
> OAuth client ID, the unverified-app notice, the consent screen with both scopes, the connected
> channel's name and subscriber count in the app (youtube.readonly), and an approved video being
> uploaded and then shown on the channel in YouTube Studio (youtube.upload).
>
> **Test access**
> Sign-in page: https://staging--bemoreswan.netlify.app/review-login.html
> Email: bmsreview.test@gmail.com
> Password: <PASSWORD>
> The account needs no phone verification or payment. After signing in: My Assistants → Felix →
> Assistant Profile → Connections → YouTube → Connect, then sign in with any Google account that
> has a YouTube channel. To publish: Posts → Create a Post → YouTube Short → attach a video →
> approve → "Post it now". The subscriber count is on Felix's Results tab, in the "Audience" chart
> of the Autopilot card.
>
> **Privacy policy:** https://bemoreswan.com/privacy#youtube-api-services (section 13). It states
> what YouTube data we access and why, that we share it only with the service providers that run
> the app (hosting, database, and AI providers who are contractually barred from training on it),
> how it is protected (tokens encrypted with
> AES-256-GCM, TLS in transit), how long we keep it and how it is deleted, and how users can revoke
> access in the app or in their Google security settings. Google user data is never used for
> advertising, never sold, and never used to train AI/ML models.
>
> **Use case:** publishing the user's own videos to their own channel. We do not reward
> viewers for subscribing, liking or any other interaction.
>
> Please let us know if you need anything else.
>
> Kind regards,
> <NAME>
> Be More Swan
