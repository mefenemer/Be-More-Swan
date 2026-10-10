# Weekly "What's new" email

Every week, customers get a short Be More Swan–branded email about the features shipped that week, with
a screenshot of each one. **Nothing is ever sent without an admin pressing Approve & send.**

```
Your Mac (weekly Claude task)                 bemoreswan.com
──────────────────────────────                ──────────────────────────────────────────────
1. read the week's commits on main
2. pick the customer-facing features
3. write the copy
4. screenshot each one (own workspace)
5. upload-draft.ts --upload  ───────────────▶ product-updates.ts?resource=ingest
                                              → saved as "Waiting for review"
                                              → reminder email to hello@bemoreswan.com
                                              Admin → Comms → What's New Emails
                                              → edit, preview, "Send me a test"
                                              → Approve & send  (the ONLY way anything is sent)
                                              → send-product-update-background.ts emails every
                                                customer who has not unsubscribed
```

| Piece | File |
|---|---|
| Tables | `db/product-update-emails.sql` |
| Validation, rendering, signed links | `src/utils/product-update-email.ts` |
| Who receives it | `src/utils/product-update-recipients.ts` |
| Upload + admin API | `netlify/functions/product-updates.ts` |
| Sender | `netlify/functions/send-product-update-background.ts` |
| Screenshot route (public, signed) | `netlify/functions/product-update-image.ts` → `/api/product-updates/image` |
| Unsubscribe (public, signed per user) | `netlify/functions/product-update-unsubscribe.ts` → `/api/product-updates/unsubscribe` |
| Admin page | `admin.html` → Comms → What's New Emails (`?view=product-updates`) |
| Upload / local preview | `scripts/product-updates/upload-draft.ts` |
| Tests | `tests/product-update-email.test.ts` |

**Recipients:** every active customer account (`users.role = 'user'`, `status = 'active'`, not in its
deletion cooling-off) that has not turned off **What's new at Be More Swan** (`email_preferences.whats_new`).
Customers can turn it off from the email's Unsubscribe link (or Gmail's one-click button), or from
Account settings → Notification Preferences. Account, billing and security emails are unaffected.

## Drafting on demand — "Draft this week's email now"

The admin page has a **Draft this week's email now** button. The draft is written on the founder's Mac
(the screenshots need a signed-in browser there), and nothing on the internet can start a process on
that Mac — so the button records a request (`platform_config` key `product_updates.draft_request`,
`src/utils/product-update-draft-request.ts`) and the Mac asks for it.

The asking is done by **`scripts/whats-new-draft-watcher.mjs`**, kept alive by launchd like the dev
issue-fixer. It makes one plain HTTP request a minute — no Claude, no usage — and only when a request is
waiting does it claim it and start **one** `claude -p --chrome` run, which does the weekly run below
with the screenshots taken in **your Chrome** (Claude in Chrome). So Chrome must be open, the extension
connected, and bemoreswan.com signed in to the Be More Swan workspace; if not, the run reports `failed`
with that reason and the admin page shows it. A run that ends without uploading or reporting is marked
failed by the watcher, so the button never stays stuck.

Turn it on once (you, not the assistant):
```bash
cp scripts/com.aura.whats-new-watcher.plist ~/Library/LaunchAgents/
```
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aura.whats-new-watcher.plist
```
Logs: `~/Library/Logs/aura-whats-new-watcher.log`. Nothing on this path can send an email: Approve & send
is still the only way.

---

## One-off setup

1. **Screenshot account.** The screenshots are taken in the founder's own workspace (Be More Swan
   marketing itself), signed in to the browser pane in the Claude app. Decided 2026-10-03 instead of a
   separate demo account. The privacy rules in step 4 are what keep customers' and personal data out.
2. **Upload token.** Generate it into `.env` without it ever being printed, then copy it to Netlify:
   ```bash
   echo "PRODUCT_UPDATES_INGEST_TOKEN=$(openssl rand -hex 32)" >> .env
   ```
   ```bash
   npx netlify env:set PRODUCT_UPDATES_INGEST_TOKEN "$(grep '^PRODUCT_UPDATES_INGEST_TOKEN=' .env | cut -d= -f2)" --context production
   ```
3. **Migration — before the code deploys.**
   ```bash
   npm run db:migrate:apply -- --only product-update-emails --url-var DATABASE_URL_PROD --yes
   ```
4. Deploy (push `main`). Then `npx tsx scripts/product-updates/upload-draft.ts --last` should print
   `{"last": null}`, which proves the token and the tables.

---

## The weekly run (instructions for the Claude task)

Work in this repo. Write all working files to your scratchpad directory, never into the repo.
**You never approve or send the email, and you never change anything in the app while taking
screenshots** — no Save, Approve, Publish, Delete or Send in the app.

### 1. Find the window
```bash
git fetch origin main
```
```bash
npx tsx scripts/product-updates/upload-draft.ts --last
```
- `commitTo` present → the window is `commitTo..origin/main`.
- `last` is null → use the last 7 days: `git log origin/main --since="7 days ago"`.
- If `last.status` is `ready`, last week's email is still waiting for review. Stop and say so; do not upload.

### 2. Pick the features
```bash
git log <from>..origin/main --no-merges --pretty="%h %ad %s" --date=short
```
Read the commit bodies (`git show -s --format=%B <sha>`). Keep only changes a customer can see and use.
Leave out bug fixes, hotfixes, refactors, admin-only changes, migrations, tests and anything internal.

Before you describe a capability, check it is real and offered. Read the memory index first, especially:
`blog-destinations-withheld.md`, `public-copy-claims-vs-system.md` and `music-library-build.md`. Never
advertise something that is built but withheld, behind an empty library, or blocked on prod (for example,
Facebook/Instagram while the Meta app is not live). Check UI labels against the source so the copy uses
the names customers see.

Aim for 3–7 features. **If there are none, do not upload.** Report "nothing customer-facing this week" and stop.

### 3. Write the copy
For each feature: a heading starting with one emoji, then one or two sentences on what it does and why it
is useful. UK English, plain words, no jargon, no internal names (say "Email Marketing Assistant", never
`newsletter_editor`). Also write:
- `subject` — under 70 characters, naming the one or two biggest features
- `preheader` — the line inboxes show after the subject
- `intro` — one sentence (the email already opens with "Hi {first name},")

The renderer treats everything as plain text: no HTML or Markdown. A blank line starts a new paragraph.

### 4. Take the screenshots
1. Open bemoreswan.com/workspace.html in the browser pane. If it shows the login page, stop: ask the user
   to sign in to their own account in the pane, then continue. Never sign in or out yourself.
2. Use the pane's default desktop size (about 800px wide, which suits a 600px email). Do not emulate a
   larger viewport: the screenshot is scaled down and blurs.
3. Go to each feature. Wait until the pink loading spinner has gone before you capture. Close menus and
   dialogs you do not want in the picture.
4. Copy the screenshot file and crop it to the feature with `sips` (it takes `--cropOffset <y> <x>` then
   `--cropToHeightWidth <h> <w>`). Name the files `1-<feature>.jpg`, `2-…` and so on.
5. **Privacy rules.** These screenshots go to every customer, and the workspace is a real account:
   - Never screenshot lead lists, lead details, contacts, the Audience page's subscriber list, inboxes,
     conversations, email threads, billing, or any page listing other people or companies.
   - Never show an email address, phone number, street address or a person's full name. That includes
     placeholders that echo the account's own details (the Lead Generator's email signature field does).
   - Prefer set-up screens, editors, empty states and the workspace's own example content.
   - Crop tightly to the feature, so the sidebar, account menu and unrelated cards are cut out.
6. Open each crop and check it against those rules, and for error banners, red over-limit counters and
   typos in the visible content. Retake on different content if needed. If a screenshot cannot be taken
   cleanly, leave `image` off that item rather than ship a bad one.

### 5. Build, preview and upload
Write `draft.json` next to the screenshots:
```json
{
  "subject": "…", "preheader": "…", "intro": "…",
  "commitFrom": "<first sha in the window>", "commitTo": "<origin/main sha>",
  "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD",
  "items": [ { "heading": "…", "body": "…", "image": "1-feature.jpg" } ]
}
```
```bash
npx tsx scripts/product-updates/upload-draft.ts --preview <dir>/draft.json
```
Open the preview (serve the folder with `python3 -m http.server`, or a `.claude/launch.json` entry,
then use the browser pane) and read it through once. Then upload:
```bash
npx tsx scripts/product-updates/upload-draft.ts --upload <dir>/draft.json
```
A `201` response means the draft is saved and the reminder went to hello@bemoreswan.com (`reminded: true`).
A `409` means an earlier draft is still waiting: stop and report it; do not pass `--replace` unless the
user asked.

### 6. Report
Tell the user in a few lines: the subject, the features included, anything you left out and why, and the
`reviewUrl` from the upload. Do not paste the draft text.

---

## Behaviour worth knowing
- **One draft waits at a time.** A second upload is refused (409) until the first is approved or
  discarded. `--replace` discards the waiting one.
- **Discarding loses nothing.** `--last` skips discarded emails, so next week's window starts from the
  last email that was kept, and the discarded week's features are picked up again.
- **Edits are explicit.** The admin preview is rendered by the server from the saved copy, and Approve is
  disabled while there are unsaved edits, so you always approve exactly what the preview shows.
- **Nobody is emailed twice.** Each recipient gets a `product_update_sends` row before their send, under
  a unique (email, user) index. A worker that runs out of time hands over to a fresh one, which skips
  everyone already done. If that hand-over fails, **Resume sending** on the admin page does the same.
- **Screenshots live in the database** (`product_update_images`), served through a signed URL that
  never expires, because an email sits in an inbox for years and R2 here is private.
