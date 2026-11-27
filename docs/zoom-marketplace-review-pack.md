# Zoom Marketplace review pack: Note Taker (DRAFT, 2026-11-27)

**What this is:** the answers and materials for Zoom's app review, drafted early so the owner can submit as soon as
a working build exists. Zoom's review is 7–10+ business days and outside our control (`docs/meeting-apps-pickup-plan.md`,
D1). Nothing here is submitted yet. Items marked **⚠️ Phase 0** are confirmed only once the test script has run on a
real paid Zoom account.

## 1. One app or two? (decision for the owner)

The Note Taker needs Zoom for two things:

| | Pick-up (this plan) | Bot on Zoom (`docs/note-taker-bot-plan.md` step 4) |
|---|---|---|
| What it does | After a recorded call, reads the transcript Zoom made | Lets our Recall bot join a call on someone else's Zoom account (OBF rule, since 2 Mar 2026) |
| Zoom feature | REST API, user-managed OAuth | Meeting SDK + an OBF token per call |
| Scopes | `cloud_recording:read:list_user_recordings`, `cloud_recording:read:list_recording_files`, `cloud_recording:read:meeting_transcript`, `user:read:user` | `user:read:token` (plus `user:read:user`) |
| Customer needs | Paid plan, cloud recording, audio transcript | Any plan; the person who connected Zoom must be in the call |

**Recommendation: one General app, one review, both features.**
- A Zoom General app can carry REST scopes and the Meeting SDK together, so the customer connects Zoom once for both.
- Zoom reviews every scope against the demo anyway, so two apps would mean two listings, two demo videos and two
  waits for the same company and product.
- Zoom's optional scopes let the connect ask only for what a customer uses, if we want that later.

**The catch:** one review covers both features, so it can't be submitted until both work end to end on our own
account. That includes the bot's OBF token endpoint, which the bot session owns. If the bot part isn't ready when
pick-up is, submit pick-up alone and add the bot scopes in a later version, which needs a second, usually shorter,
review. Either way, the app is **created once** now.

## 2. App set-up (the owner, in marketplace.zoom.us, signed in to Be More Swan's Zoom account)

1. Develop → Build App → **General App** → **User-managed**.
2. Name: **Be More Swan Note Taker**.
3. OAuth redirect URLs, also on the allow list:
   - `http://localhost:8765/callback` (Phase 0 test script; remove before submitting)
   - `https://staging--bemoreswan.netlify.app/api/oauth/zoom/callback`
   - `https://bemoreswan.com/api/oauth/zoom/callback` (prod; ⚠️ confirm the prod host)
4. Scopes: the pick-up four above. Add `user:read:token` and the Meeting SDK feature only if §1 goes the one-app way.
5. **Deauthorization notification endpoint:** `https://bemoreswan.com/.netlify/functions/zoom-deauthorize`. Zoom
   requires this for a published app, even though pick-up itself polls. When a user removes the app, we delete their
   tokens and stop picking up.
6. Copy the Development Client ID and secret into the main `.env` as `ZOOM_TEST_CLIENT_ID` / `ZOOM_TEST_CLIENT_SECRET`
   (Phase 0). Production keys go into Netlify as `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` later. **The owner pastes
   these; Claude never types them.**

## 3. Listing text

- **Short description (≤ 100 characters):** Turns your recorded Zoom meetings into minutes and action items for you to approve.
- **Long description:**
  > Be More Swan's Note Taker writes up your Zoom meetings for you. When a meeting you hosted is recorded to the cloud
  > with an audio transcript, the Note Taker reads the transcript Zoom made, then writes the minutes: a summary, the
  > decisions, and each action item with its owner. The minutes wait in your Be More Swan Inbox until you approve them.
  > Nothing is posted, emailed or shared before you approve it.
  >
  > The Note Taker never records your meeting itself; it only reads the transcript Zoom already made. It needs a paid
  > Zoom plan with cloud recording and "Create audio transcript" switched on. It checks for new transcripts every
  > 15 minutes.
- **Category:** Productivity (or Note-taking / Meeting tools if offered).
- **Links:** Privacy Policy `https://bemoreswan.com/privacy.html`, Terms `https://bemoreswan.com/terms_of_service.html`,
  Support `https://bemoreswan.com/help` (⚠️ confirm the URL), Documentation = the help article in §6.
- **Screenshots (1280×720):** (1) the Connect Zoom card on Connections, (2) Zoom's sign-in and consent screen,
  (3) the "Last checked … · N meetings found" line, (4) minutes in the Inbox with the "From Zoom" pill, (5) approved
  minutes. Taken from staging with a test workspace.

## 4. Scope justifications (one line each, as Zoom asks)

| Scope | Why |
|---|---|
| `cloud_recording:read:list_user_recordings` | Every 15 minutes, list the connected user's cloud recordings that ended since the last check, to find meetings that have a transcript. |
| `cloud_recording:read:list_recording_files` | Read one meeting's recording files to see whether its audio transcript is finished before we read it. |
| `cloud_recording:read:meeting_transcript` | Read that meeting's transcript, which is the only content the Note Taker turns into minutes. ⚠️ Phase 0: the .vtt download may make this one unnecessary; then drop it. |
| `user:read:user` | Show which Zoom account is connected ("Connected as …") and keep each Zoom account tied to one workspace. |
| `user:read:token` (if one app) | Get a one-time on-behalf-of token when the user sends the Note Taker's bot to a call they are in, as Zoom's OBF rule requires. |

We never read video or audio files, chat, participants' emails, or meetings from other users' accounts.

## 5. Privacy and security answers (Zoom's security questionnaire)

- **What data:** a meeting's id, topic, start time, length, and its transcript text with speaker names. No audio or video.
- **Where it goes:** the transcript is sent to our AI model provider (Anthropic) to write the minutes, under our DPA.
  The minutes are stored in the customer's workspace (Neon Postgres, EU). ⚠️ Confirm the region wording against the
  Trust page.
- **Retention:** the transcript is not stored. We read it, write the minutes, and discard it. The minutes stay until
  the customer deletes them or closes the account. ⚠️ This follows the parent session's proposal for D5; change it if
  the owner keeps "30 days".
- **Tokens:** OAuth tokens are encrypted with AES-256-GCM in a secrets vault, never in table columns or logs. Refresh
  tokens are rotated on every use (Zoom issues a new one each time).
- **Deauthorization:** the deauthorization endpoint deletes the tokens and the pick-up state within seconds, and
  stops all reads. The minutes already written belong to the customer and stay.
- **Transport:** HTTPS only (TLS 1.2+), Netlify hosting, verification of Zoom's webhook signature on the deauthorize
  endpoint.
- **Access:** least privilege; only the owner-operator has production access, with MFA.
- **Sub-processors:** Netlify, Neon, Anthropic (the Trust page lists them all).
- **Certifications:** none (no SOC 2). Answer honestly; Zoom accepts small developers without one.
- **Pen test:** none done. ⚠️ Answer honestly, or run a basic OWASP scan of the connect and deauthorize endpoints first.

## 6. Help article (also the "Documentation" link)

1. **Before you start:** a paid Zoom plan; in Zoom Settings → Recording, turn on **Cloud recording** and **Create audio
   transcript**.
2. **Connect:** Note Taker → Connections → Meeting apps → **Connect Zoom** → sign in to Zoom → Allow.
3. **Use:** record your meeting to the cloud. About 15–30 minutes after Zoom finishes the transcript, the minutes appear
   in your Inbox. Approve, edit or discard them.
4. **Which meetings:** meetings you hosted and recorded to the cloud. Meetings you only joined don't appear.
5. **Remove:** Connections → Zoom → **Disconnect**, or in Zoom: App Marketplace → Manage → Added apps → Remove. Both
   stop pick-up at once.
6. **Cost:** 1 task for each meeting written up. Meetings with no transcript cost nothing.

## 7. Test plan for the reviewer

- **Test account:** a Be More Swan staging workspace with the Note Taker and the `meeting_pickup` flag on. Login via the
  env-gated reviewer login (`review-login.ts`); switch it off after the review.
- **Zoom side:** the reviewer uses their own paid Zoom test account with cloud recording and audio transcript on.
- **Steps:**
  1. Sign in to Be More Swan with the test login.
  2. Note Taker → Connections → Connect Zoom → authorise.
  3. Hold a 3-minute Zoom meeting, record it to the cloud, and talk through a short agenda with one task.
  4. Wait for Zoom's transcript email, then press **Check now** on the Zoom card (no 15-minute wait).
  5. The minutes appear in the Inbox with the "From Zoom" pill. Approve them.
  6. Remove the app in the Zoom Marketplace; the Zoom card shows Not connected after a refresh.
- **Demo video (≤ 5 min):** the same steps on our own account, showing the consent screen and every scope's use.

## 8. Before submitting (checklist)

- [ ] Phase 0 passed on a real paid account (`zoom-phase0.mjs`); scope list final
- [ ] Zoom source + connect + deauthorize endpoint merged, flag on for the staging test workspace
- [ ] Real run on staging: minutes from a recorded Zoom call, charge and dedupe correct
- [ ] Privacy Policy and Trust page name Zoom as a transcript source (parent session's legal copy)
- [ ] Localhost redirect removed; production redirect added
- [ ] Reviewer login on and dated; screenshots and demo video recorded
- [ ] §1 decided (one app, or pick-up only first)
