# Notice: Google Cloud Added as a Sub-Processor

Written 2026-11-27. The owner asked for the notice to be built after Gmail push was proven on staging
(docs/email-assistant-plan.md, Phase 3b).

## Why it is sent

Gmail push (Phase 3b) sends Gmail's "new mail" notices through Google Cloud Pub/Sub in our own project
(`be-more-swan-mail`, topic `gmail-push`). Each notice carries the mailbox's email address and a Gmail
history number, which is personal data processed by Google Cloud for us, so Google Cloud becomes our
sub-processor (docs/email-assistant-phase0.md §3.3, option (a), decided by the owner 2026-11-12).

The DPA (clause 5) promises workspace owners **14 days' notice** before a new sub-processor, by email
and on the Trust page list. DPA 1.2 does not name Google Cloud, so the specific-authorisation route used
for Recall.ai does not apply.

Gmail itself is not a sub-processor: the customer connected it (Trust page, "Platforms you connect").
Outlook push needs no notice: Microsoft Graph calls our endpoint directly, with no third party between.

## What every claim rests on

| Claim in the copy | Where it comes from |
|---|---|
| Only the mailbox's address and a reference number | `mail-push-gmail.ts` / `parsePubSubPush`: Google publishes `{ emailAddress, historyId }` |
| No email content, subjects or senders | Same; the reader fetches changes from Gmail itself (`mail-reader/watch.ts` header) |
| Undelivered notices kept up to 7 days, then deleted | Subscription `gmail-push-staging`: message retention 7 days (prod subscription to match) |
| US (Google LLC; global infrastructure) | Google LLC is the US party; the topic has no message storage region set, so we don't promise UK/EU or a storage country |
| Not used for customer mailboxes until 14 days after the email | Production has none of the push env vars until then |
| Nothing reaches Google Cloud without Gmail on an Email Assistant | Watches start only for connected Gmail mailboxes in workspaces with the flag on |

## What changes in this PR

- **trust.html** and **privacy.html** (kept the same): a Google Cloud (Pub/Sub) row, "US (Google LLC; global infrastructure)", linking to
  Google's Cloud Data Processing Addendum, plus one sentence saying why it is not a "platform you
  connect". The Trust page header date moves to 27 November 2026.
- **Broadcast `subprocessor_google_cloud_notice`:** email and in-app notice, owners by default.
  Nothing sends it until the owner presses Send in Admin → Growth → Broadcast.
- **tests/broadcast.test.ts:** pins every claim above.

## What the owner does

1. **Check Google's Cloud Data Processing Addendum is in place** for the billing account behind
   `be-more-swan-mail` (Billing → Account management, or the Admin console's legal and compliance
   page). Google says it applies to Cloud customers automatically.
2. **Press Test, then Send** (owners). Note the send date.
3. **14 days after sending**, turn production push on: in Google Cloud create `gmail-push-prod` on
   topic `gmail-push` (push to `https://bemoreswan.com/.netlify/functions/mail-push-gmail`, auth with
   `gmail-push-sender`, audience the same URL, ack 10 s, exponential backoff, message retention 7 days
   — the public copy promises "up to 7 days" — never expire), then set
   `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT` and `GRAPH_NOTIFY_SECRET`
   for the Production context in Netlify, and redeploy.
4. **Objections** to privacy@bemoreswan.com within the 14 days: the alternative is the 10-minute poll,
   which needs no push (leave that workspace's mailboxes unwatched).
