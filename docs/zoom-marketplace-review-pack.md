# Zoom Marketplace review pack: the Note Taker's bot on Zoom (DRAFT, 2026-11-27)

**What this is:** everything needed to get Be More Swan's own Zoom app approved, so the Note Taker's bot can join
Zoom calls hosted on our customers' accounts. Owner decision, 27 Nov 2026: **bot only, no Zoom transcript pick-up**.
Pick-up can be added to the same app in a later version if paid Zoom customers ask for "no bot".

**Why we need it:** since March 2026, Zoom only lets a bot into a meeting on someone else's account "on behalf of"
(OBF) a Zoom user who:
- has authorised **our** Zoom app;
- **is in that meeting**.

Recall can't do this for us. Every bot vendor needs the customer's own app approval (`docs/note-taker-bot-plan.md` §10).
Our development credentials only reach meetings on Be More Swan's own Zoom account, which is enough for testing and
the demo video, but not for customers.

**✅ Phase 0 passed on staging, 27 Nov 2026:** the bot joined a Zoom meeting hosted by hello@bemoreswan.com through
our token URL, the minutes were written (record 931) and Recall's media was deleted. The app is created (§1, done).

**What's built (#935, merged to staging; flag `meeting_bot_zoom` OFF on prod):**
- **Connect Zoom** in the "Send to a call" dialog: `oauth-integrations.ts`, provider `zoom`.
- **The signed OBF token URL** Recall calls as the bot joins: `zoom-obf-token.ts`. Each bot's Recall request carries
  `zoom.obf_token_url`.
- **The deauthorization endpoint Zoom requires:** `zoom-deauthorize.ts`.
- **A clear reason when it fails:** the strip says "The person who connected Zoom wasn't in the call" when Zoom
  refuses the bot for that reason.

Nothing is submitted yet.

## 1. App set-up (the owner, in marketplace.zoom.us, signed in to Be More Swan's Zoom account)

1. Develop → Build App → **General App** → **User-managed**.
2. Name: **Be More Swan Note Taker**. Company: Be More Swan Ltd.
3. **OAuth redirect URLs**, also on the allow list:
   - `https://staging--bemoreswan.netlify.app/api/oauth/zoom/callback`
   - `https://bemoreswan.com/api/oauth/zoom/callback` (set on the Production tab, strict mode)
4. **Scopes:** `user:read:token` (mint the OBF token) and `user:read:user` (show which account is connected, and match
   a deauthorization to the right connection).
5. **Features → Embed → Meeting SDK: on**, with "Are you developing a meeting bot or AI notetaker use case?" ON (OBF
   only, no ZAK) and "Request anonymous join exception" OFF. Recall needed nothing uploaded (Phase 0).
6. **Uninstall notice:** Zoom's event list has NO "app deauthorized" event for General apps. It is the **Production tab →
   Basic information → Deauthorization URL** box (the Development tab has none, so it can't be tested on staging):
   `https://bemoreswan.com/.netlify/functions/zoom-deauthorize` (✅ filled in 28 Nov 2026; #935 is on prod). The **Secret
   Token** is on Features → Access.
7. **Netlify (the owner pastes these; Claude never types them):**
   - `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET`: the Development keys on branch:staging, the Production-tab keys on
     production (both set 27 Nov 2026).
   - `ZOOM_WEBHOOK_SECRET_TOKEN`: the secret token from step 6.

   The OBF token URL is signed with the client secret under its own label, so no extra secret is needed.
8. **SQL:** run `db/z-meeting-bot-zoom-flag.sql` on both databases (it seeds the flag OFF). For the staging test, turn
   it on for org 58 only (`allowed_workspace_ids = {58}`).

## 2. Phase 0: prove it on our own account (before submitting)

Development credentials reach only meetings on Be More Swan's own Zoom account, so the test is:

1. Set up the app (§1) and turn the flag on for org 58 on staging.
2. Note Taker → Inbox → **Send to a call** → **Connect Zoom** → sign in to Be More Swan's Zoom → Allow.
3. Start a Zoom meeting from that same account, and stay in it.
4. Paste its `zoom.us/j/…` link → **Send the Note Taker**.
5. Expect the following:
   - Recall calls the token URL. The function log shows `[zoom-obf-token] issued`.
   - The bot joins and its tile shows.
   - When the call ends, the minutes land in the Inbox.
6. Check the failure case: send a bot to a meeting, then leave before it joins. The strip should say the connected
   person wasn't in the call.

## 3. Listing text

- **Short description (≤ 100 characters):** Your Note Taker joins your Zoom call, then writes the minutes for you to approve.
- **Long description:**
  > Be More Swan's Note Taker writes up your meetings for you. Paste your Zoom meeting link into Be More Swan and the
  > Note Taker joins the call as a participant called "Note Taker for <your business>". It shows a tile saying it is taking
  > notes and posts a message in the chat so everyone knows it is there. After the call it writes the minutes: a
  > summary, the decisions, and each action item with its owner. The minutes wait in your Be More Swan Inbox until you
  > approve them. Nothing is posted, emailed or shared before you approve it.
  >
  > Zoom lets the Note Taker in on behalf of the Zoom account you connect, so that person must be in the call.
  > Everyone in the meeting can see it, and the host can remove it at any time.
- **Category:** Productivity (or Note-taking / Meeting tools if offered).
- **Links:**
  - Privacy Policy: `https://bemoreswan.com/privacy.html` (its "Meetings the Note Taker joins" section already covers
    the bot).
  - Terms: `https://bemoreswan.com/terms_of_service.html` (clause 9.3 covers meetings).
  - Support: `https://bemoreswan.com/contact.html` (form plus hello@bemoreswan.com; the Help Centre links to it).
  - Documentation: `https://bemoreswan.com/help#the-note-taker-on-zoom` (§6; `db/help-articles-note-taker-zoom-2026-11-28.sql`,
    inserted unpublished: publish it on submission day so the link works for the reviewer).
- **Screenshots (1280×720), from staging:**
  1. "Send to a call" with the Zoom line;
  2. Zoom's consent screen;
  3. the bot in a Zoom call with its tile and chat message;
  4. "Live & upcoming" with the bot in the call;
  5. the minutes in the Inbox.

## 4. Scope justifications

| Scope | Why |
|---|---|
| `user:read:token` | When the user sends the Note Taker to a Zoom meeting they are in, we fetch a one-time on-behalf-of token for that one meeting, as Zoom's Meeting SDK rule requires. It is only requested when the bot joins, only for meetings the user sent it to, and never stored. |
| `user:read:user` | Show which Zoom account is connected ("connected as …"), and remove that connection when Zoom tells us the app was uninstalled. |

We don't read recordings, chat history, contacts, calendars or meetings the user didn't send the Note Taker to.

## 5. Privacy and security answers (Zoom's security questionnaire)

- **What we receive from Zoom's API:**
  - the connected user's id and email;
  - a short-lived OBF token per meeting, used immediately and never stored;
  - OAuth tokens.
- **In the meeting:**
  - Our meeting-bot provider, **Recall.ai** (with AssemblyAI for transcription), joins as a visible participant.
  - It makes a transcript with speaker names.
  - Recall's copy of the media is kept at most 48 hours; we ask Recall to delete it once the call is over.
  - UK and EU workspaces are processed in the EU (Frankfurt); US workspaces in the US. This matches the Trust page.
- **Minutes:** written by our AI provider (Anthropic) and stored in the customer's workspace until they delete them.
- **Tokens:** OAuth tokens are encrypted with AES-256-GCM in a secrets vault, never in table columns or logs. Zoom's
  rotating refresh token is saved on every refresh.
- **OBF token URL:** signed per bot (HMAC-SHA256). It works only for that bot, only while the bot is on its way in or
  in the call, and only within 12 hours of its join time. The token is never logged.
- **Deauthorization:**
  - The endpoint checks Zoom's signature (`x-zm-signature`, with a five-minute window).
  - It deletes that Zoom user's connection in every workspace, and no further Zoom bots can be sent.
  - Minutes already written stay the customer's.
- **Consent:**
  - The bot is a named, visible participant with a "Taking notes" tile, and it posts a pinned chat message on joining.
  - Our Terms (clause 9.3) require the customer to tell attendees and get any consent the law requires.
  - The host can remove the bot at any time.
- **Transport and access:** HTTPS only (TLS 1.2+); least-privilege production access with MFA.
- **Sub-processors:** Netlify, Neon, Anthropic, Recall.ai, AssemblyAI (all listed on the Trust page).
- **Certifications:** none (no SOC 2). Answer honestly. Recall.ai holds SOC 2 Type II.
- **Pen test:** none done. ⚠️ Answer honestly, or run a basic scan of the connect, token and deauthorize endpoints first.

## 6. Help article (also the "Documentation" link)

1. **Connect Zoom:** Note Taker → Inbox → **Send to a call** → **Connect Zoom** → sign in → Allow. Any Zoom plan works.
2. **Use:**
   - Paste a Zoom meeting link with the meeting number in it (`zoom.us/j/…`). Personal links (`zoom.us/my/…`) can't be
     used.
   - Press **Send the Note Taker**.
   - **The person who connected Zoom must be in the call**, or Zoom won't let the Note Taker in.
3. **In the call:** the Note Taker shows up as "Note Taker for <business>" with a tile, and posts a message in the chat.
   Tell everyone it is recording.
4. **After the call:** the minutes appear in your Inbox for you to approve.
5. **Remove:** Send to a call → **Disconnect Zoom**, or in Zoom: App Marketplace → Manage → Added apps → Remove.
6. **Cost:** as for Meet and Teams, 1 task for each started 5 minutes in the call (free until 1 January 2027).

## 7. Test plan for the reviewer

- **Test account: on PROD, not staging.** Zoom's reviewers install the app with its **Production** credentials, whose
  redirect URL is bemoreswan.com. Staging runs the Development credentials, which only work for meetings on our own
  Zoom account, so a reviewer can't use it.
  - The existing reviewer slot `meta-review@bemoreswan.com` (prod user 47, workspace 46, `/review-login.html`,
    `META_REVIEW_LOGIN_EXPIRES` 2027-11-30), already shared with LinkedIn's review.
  - Workspace 46 needs: a Note Taker, DPA 1.2 accepted, Terms 2.5 accepted by user 47, and `meeting_bot_zoom` on for
    it only (`allowed_workspace_ids = {46}` on prod). The other workspaces stay off.
- **Steps:**
  1. Sign in.
  2. Open the Note Taker → Inbox → Send to a call → Connect Zoom → authorise with the reviewer's Zoom account.
  3. Start a Zoom meeting from that account and stay in it.
  4. Paste its link → Send the Note Taker. Admit it if the waiting room is on.
  5. Talk for 2–3 minutes about a short agenda with one task, then end the meeting.
  6. Within a few minutes the minutes appear in the Inbox. Approve them.
  7. Remove the app in the Zoom Marketplace. Reopen Send to a call: it says Connect Zoom again.
- **Demo video (≤ 5 min):** the same steps on our own account, showing the consent screen and each scope in use.

## 8. Questions for Recall (sent 27 Nov 2026)

Phase 0 answered 1 and 2 in practice: nothing was uploaded and no flag was needed; the bot joined with our token. 3 is
still open (it only affects how we answer a failed request).

1. For OBF, does Recall need **our** Zoom app's Meeting SDK client id and secret uploaded (dashboard or the Zoom
   OAuth app API), or does Recall's own SDK app accept OBF tokens minted by our app?
2. Is `zoom.obf_token_url` on by default for pay-as-you-go accounts, both EU and US, or does it need a feature flag?
3. How do you call the URL: which headers, how often, the timeout, and how do you treat a non-200 answer?

## 9. Before submitting (checklist)

- [x] Recall's §8 questions sent; 1 and 2 answered by Phase 0 (nothing to upload)
- [x] App created (§1); env vars in Netlify (staging + prod); flag SQL on both databases; flag on for org 58 (staging)
- [x] Phase 0 (§2) passed: bot joined a call on our own account through the token URL; minutes written (record 931)
- [ ] The "not in the call" failure shows its reason in the strip
- [x] Prod redirect URL and deauthorization endpoint set; Production credentials in Netlify (28 Nov 2026)
- [ ] Reviewer workspace 46 on prod ready (Note Taker, DPA 1.2, Terms 2.5, `meeting_bot_zoom` allowed {46})
- [ ] Help article published; screenshots and demo video recorded
- [ ] After approval: turn `meeting_bot_zoom` on for everyone; update /connections, the help article, the chat's
      capability wording ("Meet or Teams" → "Meet, Teams or Zoom") and What's New
