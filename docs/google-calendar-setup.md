# Google Calendar sign-in — Google Cloud setup

What the owner does in Google Cloud so customers can press **Connect Google calendar** (Business Information ▸
Bookings ▸ Your calendar). The code is already live and switched off: it switches itself on as soon as the two
Netlify settings in step 6 exist. Code: `src/utils/calendar-google.ts`, `netlify/functions/oauth-integrations.ts`.
Background: `docs/booking-calendly-gaps-plan.md` (C). Decided 2026-11-08: a **new, separate** Google Cloud project,
so a calendar review can never touch the approved YouTube project or the Gmail project.

## The exact values (copy these)

| Thing | Value |
| --- | --- |
| Permissions (scopes) | `openid`, `.../auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.events` |
| Redirect URI — prod | `https://bemoreswan.com/api/oauth/google_calendar/callback` |
| Redirect URI — staging | `https://staging--bemoreswan.netlify.app/api/oauth/google_calendar/callback` |
| Netlify settings | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` |
| Authorised domain | `bemoreswan.com` |

⚠️ The scopes in the console must match the code **exactly** — no more, no fewer. The Gmail submission was rejected
in August for exactly this (console said one scope, the code asked for another). The code asks for
`openid email https://www.googleapis.com/auth/calendar.events`; Google shows `email` as `.../auth/userinfo.email`.
`calendar.events` is a **sensitive** scope, not a restricted one: verification needs a demo video, **no paid
security assessment (CASA)**.

## 1. Create the project

1. Go to [console.cloud.google.com](https://console.cloud.google.com), signed in as the account that owns the
   YouTube and Gmail projects.
2. Project picker (top bar) ▸ **New project**. Name: `Be More Swan Calendar`. Same organisation / location as the
   other two. **Create**, then make sure the new project is selected in the top bar for every step below.

## 2. Turn on the Google Calendar API

**APIs & Services ▸ Library** ▸ search **Google Calendar API** ▸ **Enable**. (Nothing else is needed: the Meet link
is made through the Calendar API.)

## 3. The sign-in screen (Google Auth Platform)

**APIs & Services ▸ OAuth consent screen** (it opens the **Google Auth Platform**) ▸ **Get started**.

**Branding**
- App name: `Be More Swan`
- User support email: the support address Be More Swan uses on the other projects
- App logo: the same logo as the YouTube project (a logo means Google also checks branding — allow a few days)
- Application home page: `https://bemoreswan.com`
- Privacy policy: `https://bemoreswan.com/privacy.html`
- Terms of service: `https://bemoreswan.com/terms_of_service.html`
- Authorised domains: `bemoreswan.com`
- Developer contact email: yours

**Audience**
- User type: **External**.
- Leave it in **Testing** for now, and under **Test users** add up to 100 Google accounts to try it with — your own,
  and the Google account you'll use for the demo video. Only these accounts can connect until Google approves.

**Data access** ▸ **Add or remove scopes** ▸ tick exactly these three (paste the calendar one into "Manually add
scopes" if it isn't listed):
- `openid`
- `.../auth/userinfo.email`
- `https://www.googleapis.com/auth/calendar.events` — "View and edit events on all your calendars"

**Save.** Do not add `calendar`, `calendar.readonly` or anything else.

## 4. The login keys (OAuth client)

**Google Auth Platform ▸ Clients ▸ Create client**
- Application type: **Web application**
- Name: `Be More Swan — booking calendar`
- Authorised JavaScript origins: leave empty
- Authorised redirect URIs: add **both**
  - `https://bemoreswan.com/api/oauth/google_calendar/callback`
  - `https://staging--bemoreswan.netlify.app/api/oauth/google_calendar/callback`
- **Create**, then copy the **Client ID** and **Client secret**. (The secret is shown once in full — download the
  JSON if offered, and keep it somewhere safe. Don't paste it into a chat.)

## 5. Privacy policy paragraph (before submitting)

Google's reviewers check that the privacy policy says what the app does with Calendar data. Section 13 already has
the Limited Use statement naming Google Calendar; add a short "What we access" paragraph for Calendar like the
YouTube one. Ask Claude to draft it from `calendar-google.ts` — in short: we read only the start and end times of
events on your main calendar (never titles, descriptions or guests) to stop bookings at busy times; we add, change
and remove the events for bookings and class dates we created; we can add a Google Meet link to a video booking's
event; you can disconnect in Business Information ▸ Bookings or at myaccount.google.com/permissions; on disconnect
we stop reading and delete the busy times we stored (events already added stay in your calendar).

## 6. Switch it on (Netlify)

Netlify ▸ site **bemoreswan** ▸ **Site configuration ▸ Environment variables** ▸ **Add a variable** (all deploy
contexts — staging is a branch deploy of the same site, so it uses the same values):
- `GOOGLE_CALENDAR_CLIENT_ID` = the Client ID
- `GOOGLE_CALENDAR_CLIENT_SECRET` = the Client secret (mark it secret)

Then **Deploys ▸ Trigger deploy ▸ Deploy site** (and redeploy `staging`) so functions pick them up.

## 7. Try it (with a test user)

On staging, in a workspace that takes bookings (Marmalade, org 58, has a test setup):
1. Business Information ▸ Bookings ▸ Your calendar: the **Use Google Calendar?** box now shows. If Outlook is
   connected, disconnect it first — one calendar at a time.
2. **Connect Google calendar** ▸ choose a test-user account ▸ Google warns "Google hasn't verified this app" while
   in Testing ▸ **Continue** ▸ allow. You land back on Bookings with "Google calendar connected — <address>".
3. Put an event in that Google calendar during opening hours: within 15 minutes that time can't be booked.
4. Make and confirm a booking: it appears in the Google calendar within moments.
5. Set **How video call links are made** to **A Google Meet for each booking**, make a video booking and confirm it:
   the confirmation email and the calendar event carry a `meet.google.com` link.
6. **Disconnect**: the busy times stop counting; the events stay in the calendar.

Tell Claude what happened at each step if anything looks wrong.

## 8. Ask Google to verify it

1. **Audience ▸ Publish app** (moves it from Testing to In production; it will show "Needs verification").
2. **Verification centre ▸ Prepare for verification / Submit**. Google asks for:
   - **Why each scope is needed** — for `calendar.events`: "Business owners connect their Google calendar so
     bookings made on their Be More Swan website appear in it, times they're busy can't be booked, and video
     bookings can get a Google Meet link. We read only event start and end times, and only change events we created."
   - **A demo video** (YouTube, unlisted is fine) showing, in English: the Be More Swan screen with **Connect Google
     calendar**; the Google consent screen with the app name and the **calendar.events** permission visible and the
     browser address bar showing the client ID; connecting; a busy time blocking a booking slot; a booking appearing
     in Google Calendar; a Google Meet link being made; disconnecting. Same scopes in the video as in the console.
   - **Test login** if they ask: the review login for org 58 (`bmsreview.test@gmail.com`; the password is in the
     review-login setup — rotate it after approval).
   - Domain ownership of `bemoreswan.com` — already verified in Search Console for the YouTube project; if Google
     asks again, verify it for this project too.
3. Google usually replies within a few days to a few weeks, often with questions. Reply in the console thread.

## 9. After approval

- Tell Claude: it moves Google Calendar to **Live** on the public `/connections` page (it must stay off that page
  until then) and updates the Help Centre article to mention Google Calendar sign-in.
- Rotate the review-login password.

## If something goes wrong

| What you see | Usually means |
| --- | --- |
| "redirect_uri_mismatch" | The redirect URI in step 4 differs by a character (http vs https, a trailing slash) |
| Connect button never appears | The two Netlify settings aren't set, or the site wasn't redeployed after setting them |
| "Access blocked: app not verified" for a customer | Still in Testing and their account isn't a test user — expected until approval |
| Sent back with "Google didn't give access to your calendar" | The calendar tick-box was unticked on Google's screen |
| "One calendar can be signed in at a time" | Outlook is connected — disconnect it first |
