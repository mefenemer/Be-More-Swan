# Facebook + Instagram messages — build and App Review plan

Status: **PLAN, nothing built; all decisions D1–D7 taken by the owner 2026-11-19 (every recommendation accepted)**. Owner asked for it after Meta approved
`pages_manage_posts` + `instagram_content_publish` on 2026-11-18.

## 1. What we are building, in one paragraph

A **Messages** tab on the Social Media Assistant, beside Comments. When someone messages the
customer's Facebook Page or Instagram account, the message appears there (and in Needs you). The
assistant drafts a reply in the brand's voice; the customer edits it if they want and clicks **Send**.
The reply goes out as the Page / Instagram account. Nothing is ever sent by a schedule or a model turn
— only by a person's click, exactly like Comments.

This is "reply faster to people who are already talking to you". It is **not** outbound DM: every
platform forbids messaging someone who hasn't messaged you first, and we never will.

## 2. Meta's rules that shape the design

Re-verify against Meta's docs before recording — messaging rules are the most changeable part of
Meta's platform.

| Rule | Effect on us |
|---|---|
| A Page / IG account may reply only within **24 hours** of the person's **last** message. Each new message from them restarts the clock; our replies don't. | Every conversation shows a countdown. After 24h the Send button is replaced by "Meta closed this conversation — reply in the Facebook/Instagram app" (they can still reply there by hand). Window checked **on the server right before the API call**, not when the draft is made. |
| `HUMAN_AGENT` tag stretches the window (reported as 7 days) for a **human** support reply; automated messages are banned under it, and it needs its own approval. | Not in the first submission (D3). |
| Receiving messages needs a **webhook**: app subscribed to `messages` for Messenger and Instagram, and each Page subscribed via `POST /{page-id}/subscribed_apps`. | New `meta-webhook.ts` + subscription on connect. |
| Instagram messages go through the **linked Facebook Page's** token; the IG account must be professional and linked to a Page (already true for our IG connections). The owner must have "Allow access to messages" switched on in Instagram (Settings → Messages → Connected tools). | Tab shows that tip when IG returns the "not allowed" error. |
| Webhook must answer 200 within a few seconds; Meta retries otherwise and may switch the subscription off. | Store and ack fast; draft later, on request. |

### Permissions to request

| Permission | Why we need it |
|---|---|
| `pages_messaging` | Read Messenger conversations and send replies as the Page |
| `instagram_manage_messages` | Read Instagram DMs and send replies as the IG account |
| `pages_manage_metadata` | Subscribe the Page to our webhook (`subscribed_apps`) |

All three are added to `SCOPES` in `netlify/functions/meta-oauth.ts`. **Existing connections don't
get them until they reconnect** (see §5).

## 3. What exists today

- **Comments tab** (`src/utils/page-comments.ts`, `netlify/functions/page-comments.ts`, `page_comments`
  table): LinkedIn only. Fetch → AI draft (fair use, no task) → person clicks Post reply → notices
  replies made on LinkedIn itself. **This is the pattern to copy.**
- **`social-auto-responder.ts`** + UI in `integrations.js` (~2488, ~2603, ~2631): writes a Messenger
  greeting / auto-reply and an IG auto-reply, and tries to push them to Meta. The push is **broken**
  (no `recipient`, no `pages_messaging` scope since 2026-11-02). See D4.
- `meta-oauth.ts` comments say `pages_messaging` was dropped because there was no webhook or reply
  flow — this plan is that flow.
- No Meta webhook receiver exists. `webhook-intake.ts` is a generic intake for Slack/Zendesk.
- `docs/lead-generator-revenue-engine-plan.md` §5.4 sketched a `dm_windows` table and auto-send
  "pre-approved replies". This plan replaces §5.4 with a simpler, approval-per-reply design (D1).

## 4. Build

### Phase 1 — receive

1. **`netlify/functions/meta-webhook.ts`** (new, public):
   - `GET`: answer `hub.challenge` when `hub.verify_token` matches `META_WEBHOOK_VERIFY_TOKEN`.
   - `POST`: verify `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body with `META_APP_SECRET`);
     reject on mismatch. Dedupe on Meta's message id (`mid`). Store, return 200. No model calls here.
   - Map the Page id / IG account id to the workspace through the stored connection. Unknown id →
     drop and log (never guess a workspace).
   - Ignore echoes of our own sends (`is_echo`) except to mark the conversation as replied — that's
     also how a reply typed in the Facebook/Instagram app is noticed (like Comments does for LinkedIn).
2. **Tables** (`db/z-social-messages.sql`, manual apply on both DBs):
   - `social_conversations`: org, assistant, platform (`facebook`|`instagram`), page/IG account id,
     participant id (page-scoped / IG-scoped id), participant name, `last_inbound_at`,
     `window_closes_at`, status (`new`|`replied`|`dismissed`), `draft`.
   - `social_messages`: conversation, direction (in|out), `mid` (unique), text, attachment type +
     Meta's URL (not copied), sent_at, sent_by user id for outbound.
   - RLS like `page_comments`.
3. **Subscribe on connect**: after a successful FB connect, `POST /{page-id}/subscribed_apps` with
   `messages,messaging_postbacks,message_echoes` (Instagram fields come through the same Page).
   Record the result on the connection; show "Messages not switched on — reconnect" if it failed.
4. **Unsubscribe on disconnect** (`DELETE /{page-id}/subscribed_apps`).

**Phase 1 built 2026-11-19** (branch `feat/meta-messages-phase1`): `netlify/functions/meta-webhook.ts`,
`src/utils/meta-messaging.ts`, `db/z-social-messages.sql`, subscribe on connect (`meta-oauth.ts`),
unsubscribe on disconnect (`integrations.ts`), tests `tests/meta-messaging.test.ts` +
`tests/meta-messaging-db.test.ts` (CI Postgres). To switch on in an environment:
1. Apply `db/z-social-messages.sql` to that database.
2. Netlify env: `META_WEBHOOK_VERIFY_TOKEN` (any long random string) and `META_MESSAGING_ENABLED=true`.
   Leave `META_MESSAGING_ENABLED` unset on prod until Meta approves the three permissions — until
   then only app-role holders (admins, testers) can grant them.
3. Meta dashboard → Webhooks: Page object (fields `messages`, `messaging_postbacks`,
   `message_echoes`) and Instagram object (`messages`), callback `<site>/.netlify/functions/meta-webhook`,
   the same verify token.
4. Reconnect Facebook / Instagram so the Page is subscribed (`metadata.messaging.subscribed`).

### Phase 2 — Messages tab + send

5. **Tab** on the Social Media Assistant, next to Comments, built with `tab-head.js` like the others:
   list of conversations (newest first, countdown pill: green >6h, amber <6h, grey closed), thread
   view, draft box, **Draft reply**, **Send**, **Dismiss**.
6. **Draft**: brand voice + Business Info + products + the thread so far. Metered like Comments
   drafts (fair use, no task). Never invents prices, availability or bookings it can't see — says
   "I'll check and come back to you" instead.
7. **`send` action** (one server path for tab and chat): re-reads the conversation, checks
   `window_closes_at > now()` **immediately before** calling `POST /{page-id}/messages`
   (`messaging_type: RESPONSE`, `recipient: { id }`), then stores the outbound row. Refusals return
   200 with a `reason` the UI shows: `window_closed`, `not_connected`, `scope_missing`,
   `instagram_access_off`.
8. **Notifications**: new message → Needs you + bell (existing notification prefs, new category
   "Messages"). One reminder when a conversation has **4 hours** left with no reply. No email by
   default (D5).
9. **Chat parity** (every capability is GUI and chat): chat can list waiting messages, draft a reply
   and show a card whose **Send** button is the person's click. Regenerate the chat capabilities
   manifest.

### Phase 3 — tidy

10. Retire or rebuild the auto-responder (D4).
11. Help article "Reply to Facebook and Instagram messages"; update `/connections` Facebook +
    Instagram cards to list Messages; What's New item; privacy notice (§6).
12. Optional later: **Save as lead** on a conversation → Lead Generator (not in this plan's build).

### Tests

Signature check (good / bad / missing), challenge handshake, dedupe on `mid`, echo marks replied,
window check refuses at 24h+1s, unknown Page id dropped, RLS, source-scan that nothing calls the send
path from a scheduled function or a model tool without a click.

## 5. Existing customers must reconnect

New scopes only arrive when a customer reconnects Facebook/Instagram. Plan: the Messages tab shows
"Reconnect Facebook to see your messages here" with the Reconnect button, until the stored grant has
`pages_messaging`. No forced reconnect, no email blast. ⚠️ Reconnect lessons from the last review
apply: FB and IG are separate Connect buttons, and the one-workspace-per-account block still holds.

## 6. Privacy

⚠️ **Must land before `META_MESSAGING_ENABLED` goes on in prod** (review of #755): the 90-day purge, GDPR erase, SAR + self-serve export and the Meta data-deletion callback must all cover `social_conversations` / `social_messages`. On staging, keep subscribed Pages to our own test accounts until then.

We'd store messages written by **members of the public** to our customers. Needs:
- Privacy notice: new paragraph (what we store, why, retention). Customer is controller, we're processor — DPA already covers social content; check the wording covers messages.
- Retention: delete message text after **D6** days; keep counts.
- GDPR erase / SAR export (`admin-gdpr-erase.ts`, `admin-sar-export.ts`, self-serve export) include the new tables.
- Data deletion callback: Meta's deletion requests by a user must remove their messages.

## 7. App Review

Submit **after** Phase 2 is live on prod (reviewers test the live app). One submission, three
permissions. Follow the lessons in `docs/meta-app-review-submission.md`:

- One unbroken take per permission, captions, Facebook Login permission screen visible on camera
  (remove the app from FB Business integrations first, else no permission screen).
- Record in org 37. Use `ffmpeg -f avfoundation`, not `screencapture -v`.
- **A second person is needed on camera**: someone messages the Page / IG account from their own
  account, then we reply from the Messages tab and show the reply arriving in their Messenger / IG.
- Only an app admin (Catherine) can submit.

| Recording | Shows |
|---|---|
| `pages_messaging` + `pages_manage_metadata` (Facebook card) | Reconnect Facebook with the new permission screen → message sent to the Page from a second account → appears in Messages tab → Draft → edit → Send → reply visible in the sender's Messenger |
| `instagram_manage_messages` (Instagram card) | Reconnect Instagram → DM to @bemoreswan from a second account → Messages tab → Send → reply visible in the sender's Instagram |

Reviewer instructions must say: replies are only sent by a person clicking Send, only within 24h,
never to someone who hasn't messaged first; no automated or bulk messages.

## 8. Decisions (owner, 2026-11-19: all as recommended)

| # | Question | Decided |
|---|---|---|
| D1 | Approve every reply, or let the assistant auto-send some? | **Every reply is a person's click.** Matches approval-by-default, makes App Review simpler, and the 24h window is long enough with a 4-hour reminder. |
| D2 | Facebook and Instagram together, or Facebook first? | **Together, one submission.** Same code path; two reviews would cost two rounds of recording. |
| D3 | Ask for the `HUMAN_AGENT` tag (longer window) now? | **No, not in the first submission.** Meta rejects it often, and AI-drafted replies sit badly with "human agent". Revisit once we see how often windows close. |
| D4 | The old auto-responder (greeting + auto-reply push)? | **Retire the Meta push**, keep nothing automatic. It's broken today and an auto-reply contradicts D1. |
| D5 | Email when a message arrives? | **No email by default** — Needs you + bell + a 4-hour reminder. A per-user email setting can come later. |
| D6 | Keep message text for how long? | **90 days**, then delete the text and keep counts. |
| D7 | Which plans get it? | **Every plan that has the Social Media Assistant.** Drafting is fair use like Comments, so no new cost line. |

## Sources checked 2026-11-19

- Meta Send API reference — 24h standard window, HUMAN_AGENT rules: https://developers.facebook.com/docs/messenger-platform/reference/send-api/
- Meta Webhooks for Messenger — `pages_messaging` + `pages_manage_metadata` to subscribe: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks
- Get started with Instagram Messaging — `instagram_manage_messages`, Page token, linked Page: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started
- Instagram Webhooks — fields and permissions: https://developers.facebook.com/documentation/instagram-platform/webhooks.md
