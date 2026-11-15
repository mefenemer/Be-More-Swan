# Google Analytics for the Website Assistant — PLAN (feature request #33)

2026-11-15. **Nothing built.** For the owner to review and decide (§9).

The ask: *"Should we connect to Google Analytics in some way for the website assistant."*

---

## 1. Short answer

- **We already count visitors on hosted sites, without cookies.** Since 2026-11-05 (commit 5cfba2fa) every page view on
  a published site is counted at the edge (`sites-host/edge-functions/serve.ts` → `netlify/functions/site-visit.ts` →
  `src/utils/site-visits.ts`): visitors, page views, most-read pages and where people came from, 30 days against the
  30 before. It shows on the Website Assistant's **Results** tab (the "Visitors" card in
  `src/components/assistant-dashboard-registry.js`, fed by `sites.ts` action `visits`) and the chat reads the same
  figures (`visitsLine` in `src/utils/site-store.ts`). No IP address or browser string is stored, so **customers' sites
  need no cookie banner** — and the card says so.
- **So the answer is "yes, but not by putting Google's tag on our sites first."** Putting GA4 on a hosted site means
  allowing scripts our sites deliberately don't run (CSP `default-src 'none'` in `netlify/functions/site-serve.ts`),
  and almost certainly a cookie banner — losing the "no banner" promise for little gain on a small business site.
- **Recommendation, in order:** (1) make our own counting a little richer and add Google **Search Console** to the
  website (we already have that integration for the Blog Assistant); (2) offer **read-only GA4 reports via OAuth**
  for customers who already use Google Analytics — mainly sites we don't host, or the old site before a move;
  (3) the "paste your GA4 ID" option only if customers ask for it, behind a proper consent banner.

## 2. What exists today

| Piece | Where | Notes |
| --- | --- | --- |
| Cookieless visitor counts | `src/utils/site-visits.ts`, `db/z-site-visits.sql`, `tests/site-visits.test.ts` | Daily totals; per-day visitor hash (HMAC with `SITE_SERVE_SECRET`) deleted after two days |
| Results tab + chat | `assistant-dashboard-registry.js` (Visitors card), `site-store.ts` (chat snapshot) | Chat told "never invent others (no bounce rate, time on page…)" |
| Our own marketing site | `netlify/functions/track-visit.ts`; privacy.html §12 | Same cookieless approach; we say "no third-party analytics" |
| Search Console | `oauth-integrations.ts` (`searchconsole`, `webmasters.readonly`, `SEARCHCONSOLE_CLIENT_ID`), `ingest-gsc-metrics.ts` (daily), Blog setup on the Blogs tab | Blog posts only today; marked **Live** on `connections.html` |
| Google OAuth projects | YouTube (approved 2026-11-05), Gmail (`gmail.send`), Google Calendar (submitted 2026-11-11), Search Console | Each its own client ID; nothing reads Analytics today |
| Hosted-site rules | `site-serve.ts` CSP: no script, no frames | Site import does not look for an existing GA tag |

## 3. The three options

### A. Paste a GA4 Measurement ID — their Google tag runs on our hosted site
- **Customer gets:** their own GA4 dashboard at analytics.google.com, with everything Google offers (devices, countries,
  events, Google Ads links). Nothing new inside Be More Swan.
- **GUI:** Website ▸ Details ▸ a "Google Analytics" card: one field `G-XXXXXXXXXX`, validated, off by default.
  **Chat:** `set_settings` gains `analytics.gaMeasurementId` in the chat-orchestrator prompt; the chat can add, change or
  remove it and says plainly that a cookie banner comes with it.
- **What it costs us:** the CSP must allow `googletagmanager.com` and `google-analytics.com` scripts and connections
  **for those sites only**; our sites gain their first JavaScript; and we must build a **consent banner** (§4) that
  blocks the tag until "Accept". The Visitors card wording ("needs no cookie banner") must change for those sites.
- **Verification:** none (no OAuth).

### B. Read GA4 reports via OAuth — figures in Results and chat
- **Customer gets:** a "Google Analytics" block on the Results tab (users, sessions, top pages, sources, devices,
  countries; 28 days against the 28 before) for **any** site with GA4 — useful for sites we don't host (the Mystery
  Shopper and Blog Assistant customers), and to compare an imported site's old traffic with the new hosted one.
- **GUI:** Connections tab card "Google Analytics" → Google consent → pick the property (Admin API
  `accountSummaries.list`) → figures appear. **Chat:** the snapshot gains one line of GA figures beside `visitsLine`, so
  "how is my website doing?" answers from both; the chat offers the same Connect button as a card (OAuth itself needs
  the customer's click) and can change the chosen property.
- **API:** Data API `runReport`, one call per site per day by a scheduled function, stored as daily totals (no live
  calls on page load). Quota for a standard property is 200,000 tokens a day, 40,000 an hour, 10 concurrent — one
  small report a day is nowhere near it, but the quota is **shared with every other tool the customer connects**, so
  failures must show "Google didn't answer today", never zeros (as `ingest-gsc-metrics.ts` already does).
- **Scope:** `https://www.googleapis.com/auth/analytics.readonly`. Secondary sources class it as **sensitive, not
  restricted** — so Google verification (privacy policy, scope justification, demo video), but **no CASA security
  assessment**. Confirm in the Cloud console, which labels each scope when you add it.

### C. Our own cookieless stats — extend what exists
- **Customer gets, in addition to today:** a 7 / 30 / 90-day switch; **country** (from Netlify's geo header, stored only
  as a daily count per country); **device type** (phone / tablet / computer, bucketed at the edge, browser string never
  sent); **campaign tags** (`utm_source`/`utm_campaign`, as `track-visit.ts` already does for us); and **results that
  matter to a small business** counted server-side — form sent, booking made, shop order — which GA can only do with
  extra event set-up.
- **GUI:** the existing Visitors card grows a range switch and three small lists. **Chat:** `visitsLine` gains the same
  facts; the "never invent others" line stays.
- **Verification:** none. **Banner:** none — no storage on the visitor's device and no identifiers kept, so PECR's
  cookie rule does not apply. Plausible/Fathom work the same way; we don't need to pay them because we already sit in
  front of every request.

### Add-on to all three: Search Console for the website
Most "is anyone finding me?" questions are search questions. Two small pieces: (1) a **"Google verification code"**
field that adds `<meta name="google-site-verification">` to the hosted site's head (no script, CSP unchanged), plus
the DNS-record route for own domains; (2) let the existing Search Console connection feed the **Website** Results tab
(searches people typed, clicks, impressions per page), not only blog posts. Chat reads the same line.

## 4. Consent banner (only if A is built)

- **GA4 sets cookies** (`_ga`, `_ga_<id>`) and Google uses the data for its own purposes. Since the Data (Use and
  Access) Act 2025, PECR has a **statistical-purposes exception**, but the ICO guidance (2026) limits it to analytics done
  only to improve your own service, not shared beyond that, with a free way to object. Commentators widely read GA4 as
  **still needing consent** in the UK; treat it as needing consent. Google Ads features certainly do.
- So A needs: a banner with **Accept / Reject equally prominent**, the tag loaded only after Accept, choice remembered,
  a "Cookie settings" link in every footer, and a cookie section on the customer's privacy page (our site template
  would need one). Google **Consent Mode v2** wired to the banner. The customer is the controller; we say so in the
  card's help text and Help Centre.
- This is a real build (first JavaScript on hosted sites, CSP per site, tests) and a support load ("why is there a
  banner now?"). It is also the main reason to do C and B first.

## 5. Google verification effort (B only)

- **Which project:** add `analytics.readonly` to the **Search Console** project (`SEARCHCONSOLE_CLIENT_ID`), so one
  "Google site stats" consent covers both, and one review. Our notes don't record whether `webmasters.readonly` was
  ever verified on that project — **check the console first**; if it wasn't, one submission does both.
- **Needs:** privacy.html section "Google Analytics data" (what we read, that it's read-only, stored as daily totals,
  deleted on disconnect, never used for ads or to train models — Google's Limited Use wording); scope justification;
  demo video on the review login (org 58, synthetic data only); Connections page card stays **Coming soon** until
  Google approves (`connections.html` is a public claim list).
- **Time:** sensitive-scope reviews are quoted at about 10 working days; real reports run 4–7+ weeks. Plan for six.

## 6. Phased build

**Phase 1 — richer own stats + Search Console (C + add-on).** No banner, no verification.
- Edge: send device bucket and country with each count; app adds `site_visit_countries`, `site_visit_devices`,
  `site_visit_campaigns` daily tables (additive SQL, apply before deploy) and conversion counts from forms, bookings
  and orders already recorded.
- `visitStats` gains a range; Visitors card grows; `visitsLine` updated; tests extended.
- Website ▸ Details: Google verification code field (GUI) + `set_settings` key (chat). Search Console feeds the Website
  Results tab and chat. Help article.

**Phase 2 — read GA4 (B).**
- Provider `google_analytics` in `oauth-integrations.ts` (same Google project as Search Console), property picker,
  `ga4_daily` table, scheduled `ingest-ga4-metrics` (one `runReport` per connected property per day).
- Results block + chat line + chat Connect card. privacy.html section, verification submission, Connections page flip
  only after approval.

**Phase 3 (only if asked) — GA4 tag on hosted sites (A).**
- Consent banner component, per-site CSP, Consent Mode v2, footer link, privacy-page cookie section, Measurement ID
  field + chat key, Visitors card wording for banner sites. Site import detects an old `G-` ID and offers to carry it.

## 7. Costs

- GA4 and both Google APIs: **free** at these volumes. Verification: free (no CASA for a sensitive scope).
- Phase 1: no new paid service; a few small tables of daily totals.
- Plausible/Fathom (~£8–£15 a site a month) are **not needed** — we already do what they do.
- Build: Phase 1 ≈ 2–3 days; Phase 2 ≈ 3–4 days plus the review wait; Phase 3 ≈ 4–5 days plus testing on real sites.

## 8. Risks

| Risk | Answer |
| --- | --- |
| Our figures differ from GA's for the same site | Expected (bots, ad blockers, consent). Label ours "counted on the live site"; never mix the two numbers |
| A banner on every GA site hurts the "no banner" selling point | GA tag is opt-in per site, last phase, card says what it brings |
| Google review drags on | Phase 1 needs no review; Phase 2 ships behind a flag, card says Coming soon until approved |
| Shared GA quota exhausted by the customer's other tools | Daily fetch with retry; "Google didn't answer today", never zeros |
| Public copy over-claims | No "Google Analytics" on `connections.html`, showcase or Help until the matching phase is live |
| Chat invents bounce rate / time on page | Keep the "only these figures" line; GA line lists exactly what was fetched |

## 9. Decisions for the owner

1. **Order:** Phase 1 (own stats + Search Console) first, then B, and A only on demand? *Recommendation: yes.*
2. **Phase 1 extras:** add country, device type, campaign tags and form/booking/order counts — all four, or fewer?
3. **Search Console on the website:** reuse the Blog Assistant's connection for the Website Results tab, and add the
   verification-code field?
4. **B — Google project:** add `analytics.readonly` to the Search Console project and submit one review (after checking
   whether `webmasters.readonly` is already verified)?
5. **B — who gets it:** every paid plan, or only plans with the Website / Mystery Shopper assistants? Free to read (no task
   cost), like Search Console today?
6. **A — at all?** Build the GA4 tag + consent banner only when a customer asks, or never (point them to B instead)?
7. **Wording:** keep "Counted without cookies, so your site needs no cookie banner" as the headline promise of hosted
   sites, and use it in sales copy now that it is true?
