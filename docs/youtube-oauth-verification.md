# YouTube: Google OAuth verification

What Google needs before customers can connect YouTube, what we submitted, and how the demo video
was made, so a resubmission doesn't start from zero. The Meta equivalent is
[meta-app-review-submission.md](meta-app-review-submission.md).

## Where it stands (2026-11-04)

- Google Cloud project `218009229183`, OAuth client
  `218009229183-r5hkj9cll041roqjp6l9mc4ja80qbpvj.apps.googleusercontent.com` (the only client).
- **Verification submitted 2026-11-04**, with reviewer sign-in on staging (see Additional info).
  Until Google approves it, the Connections page and FAQ keep YouTube as **Coming soon**.
- Before submitting it was in **Testing**: only listed test users could connect, and their
  connections expired after 7 days.
- Test user: `BMSReview.test@gmail.com`, channel [@BMSReviewtest](https://www.youtube.com/@BMSReviewtest).
- First real upload: 2026-11-04, [youtube.com/watch?v=0JxJ8Z5tZJo](https://www.youtube.com/watch?v=0JxJ8Z5tZJo),
  which landed **public**, so YouTube isn't forcing uploads to private yet. Before commit
  `f9b62a4c` every upload failed with "invalid content-length header".

## Console settings

**Branding → App domain**
- Home page: `https://bemoreswan.com`
- Privacy policy: `https://bemoreswan.com/privacy`
- Terms of Service: `https://bemoreswan.com/terms_of_service`
- Authorised domain: `bemoreswan.com`

**Data access → scopes.** Exactly these two, matching `SCOPES.youtube` in
`netlify/functions/oauth-integrations.ts`. Both are *sensitive*, not restricted.
```
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.readonly
```

**How will the scopes be used?** (under the 1,000-character limit)
```
Be More Swan helps small businesses publish videos to their own YouTube channel.

youtube.upload: uploads the video, title and description to the channel the user connected. A video is uploaded only after the user approves it or has chosen automatic publishing. Weekly Shorts made by the assistant are opt-in and upload as unlisted. We use it only to upload. This is the narrowest scope that allows uploading.

youtube.readonly: reads the connected channel's name, so the user can see which channel is connected, and its statistics, such as subscriber count, so the user can track their goals. We call channels.list with mine=true only. The upload scope cannot read this data, and we do not need the broader youtube or youtube.force-ssl scopes, which also allow editing and deleting.

We never edit or delete videos or channel settings, and users can disconnect at any time.
```

**Additional info.** Reviewers sign in on **staging** through `review-login.html` (see
`netlify/functions/review-login.ts`). On 2026-11-04 the Google slot was on in staging, with
`REVIEW_LOGIN_PASSWORD` at 32 characters (`REVIEW_LOGIN_EXPIRES=2027-01-31` added the same day), and
off in prod, where the password is empty. Copy the password from Netlify; never write it here.
```
Project 218009229183 is the only Google Cloud project that uses OAuth for Be More Swan. Its only OAuth client is 218009229183-r5hkj9cll041roqjp6l9mc4ja80qbpvj.apps.googleusercontent.com.

Test credentials: our normal login is an emailed magic link, so we have set up a password sign-in for reviewers.
Sign-in page: https://staging--bemoreswan.netlify.app/review-login.html
Email: bmsreview.test@gmail.com
Password: [from Netlify]
This account already has YouTube connected to the channel @BMSReviewtest, which is the same flow as in the demo video.

The demo video shows: connect, consent to both scopes, the connected channel name, the user approving a post, the upload, and the video live and public on the channel (https://www.youtube.com/watch?v=0JxJ8Z5tZJo).

Only a workspace owner or admin can connect YouTube, from Assistant Profile → Connections. Nothing is uploaded without the user's approval or automatic publishing they have switched on. Disconnecting deletes the tokens we store, and users can also remove access in their Google Account settings.
```
Disconnect deletes the vault secret and the `workspace_integrations` row (`deleteIntegration`).
It does **not** revoke the grant at Google, so don't claim that it does.

## Demo video

The file isn't in git: `meta-review-videos/youtube/`. The raw take is `raw.mkv`, the rebuild
script is `ytbuild.py`, and the output is `be-more-swan-youtube-oauth-demo*.mp4`. Upload the
finished file to YouTube as **Unlisted** and paste the link into the Data access page.

Recorded on staging, in Chrome, signed in with the test account. The built-in Claude browser
can't use Google passkeys, so the Google screens must be done in Chrome. Captions sit in a band
under the picture, and the bookmarks bar and Chrome's debugging banner are cropped out.

| Step | On screen | Caption covers |
|---|---|---|
| 0 | Felix (Social Media Assistant) | who is logged in |
| 1 | Assistant Profile → Connections → YouTube → Connect | |
| 2 | Our pre-Google checklist → "continue to YouTube" | |
| 3 | Google "Choose an account" | **OAuth client ID** (Google truncates it in the address bar) |
| 4 | "Google hasn't verified this app" → Continue | expected while pending |
| 5 | Consent screen with both permissions → Continue | each permission named against its scope |
| 6 | Back in the app, channel name on the card | youtube.readonly, channels.list mine=true |
| 7 | YouTube switched on for the assistant | |
| 8 | Create a Post → YouTube Short, X unticked (2× speed) | |
| 9 | Attach the video, write the caption (3× speed) | becomes the title and description |
| 10 | Post it now → Yes, publish now | nothing uploads without approval |
| 11 | Post queued, uploading in the background | videos.insert, resumable |
| 12 | YouTube Studio → Content → Shorts for BMS Test User: the Short, **Visibility: Public** (12 s) | uploaded with youtube.upload, public on the connected channel |

Finished file: `be-more-swan-youtube-oauth-demo.mp4` (3 min 33 s). Step 12 was recorded 2026-11-04
(`step12-raw.mkv`, cropped to `step12-crop.mp4`) and appended with `ytappend12.py`.

Gaps a reviewer might raise: the subscriber-count screen (the justification mentions it) isn't
shown yet, and the client ID appears in a caption rather than the address bar.

## Still to do

Submitted 2026-11-04: demo video, justification, Additional info and questionnaire (all four
"No"). `REVIEW_LOGIN_EXPIRES=2027-01-31` is set on staging (branch:staging and branch-deploy).

1. Answer Google's emails. If they ask for the subscriber-count screen, record the Results tab.
   If the reviewer finds YouTube disconnected on @BMSReviewtest, reconnect it.
2. When Google approves it, switch YouTube back to Live on `connections.html`, the FAQ, and the
   assistant catalogue rows in the database.
3. Then switch the Google reviewer sign-in off: delete `REVIEW_LOGIN_PASSWORD` on staging and
   redeploy. The expiry date turns it off by itself on 2027-01-31 anyway.
