# Be More Swan — automated test catalogue

Generated 2026-11-01 from `tests/*.test.ts` (560 files). Each description is the test file's own header comment.

## How the tests run

- `npm run test:all` — typecheck (`tsc --noEmit`), then every `tests/*.test.ts` in its own process (`scripts/run-tests.mjs`, auto-discovers new files). Excludes `rls-enforcement.test.ts`.
- CI on every push/PR (`.github/workflows/ci.yml`), both required to merge into `main`:
  - **Typecheck + tests** — `npm run test:all`.
  - **RLS tenant-isolation (Postgres)** — a fresh Postgres 17 + pgvector with the RLS policies applied, then the 11 database tests marked *CI Postgres* below.
- Most tests are **pure or source-scan**: no network, no real database, no browser. They check rules, request shapes and that the code/HTML says what it must. They do **not** click through the live app — that's what browser testing on staging adds.

## For the tester

Use this to see what's already locked by automated tests, and to aim browser testing at what isn't: real logins, OAuth connections (Meta, LinkedIn, Google), Stripe checkout, emails arriving, AI drafting/image/video output quality, layout at phone width, and journeys that cross several pages. **These test files are maintained by Claude — please don't edit them;** raise a ticket instead.

A test existing does **not** mean the feature is offered to customers. Some cover code that's built but withheld (e.g. the WordPress / Ghost / Dev.to / Hashnode blog destinations). The public Live / Coming-soon list at `/connections` is the source of truth for what customers can use — don't raise "missing feature" bugs from this file.

## Contents

- [admin](#admin) (12)
- [ai](#ai) (4)
- [assistant](#assistant) (11)
- [audience](#audience) (9)
- [blog](#blog) (31)
- [brand](#brand) (8)
- [calendar](#calendar) (4)
- [campaign](#campaign) (29)
- [chat](#chat) (18)
- [connection](#connection) (7)
- [content](#content) (4)
- [crosspost](#crosspost) (5)
- [discovery](#discovery) (24)
- [draft](#draft) (3)
- [email](#email) (6)
- [form](#form) (3)
- [goal](#goal) (6)
- [help](#help) (4)
- [inspo](#inspo) (5)
- [lead](#lead) (27)
- [linkedin](#linkedin) (5)
- [mentor](#mentor) (12)
- [meta](#meta) (5)
- [music](#music) (3)
- [newsletter](#newsletter) (14)
- [no](#no) (3)
- [notification](#notification) (3)
- [onboarding](#onboarding) (3)
- [outreach](#outreach) (7)
- [overlay](#overlay) (6)
- [partner](#partner) (17)
- [plan](#plan) (4)
- [platform](#platform) (5)
- [post](#post) (14)
- [product](#product) (3)
- [prompt](#prompt) (3)
- [review](#review) (8)
- [site](#site) (27)
- [social](#social) (3)
- [swan](#swan) (4)
- [video](#video) (8)
- [x](#x) (3)
- [other](#other) (180)

## admin

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `admin-bias-audit.test.ts` | The quarterly bias reminder links to admin.html?section=bias-audit — and admin.html had no Bias Audit section at all, so the link landed on the dashboard (reported 2026-10-03). | test:all |
| `admin-cascade-deletes.test.ts` | Every Delete button in the admin portal either works end to end or says why it can't. | test:all |
| `admin-coupons.test.ts` | Admin → Revenue → Coupons: coupons made in Be More Swan are real Stripe coupons, and nothing an admin can type reaches Stripe in a shape it would reject halfway through. | test:all |
| `admin-deep-link-submenu.test.ts` | A direct link — admin.html?view=send-notification, ?view=product-updates, every reminder email — opened the category's sub-menu (title "COMMS") over an EMPTY list. Clicking the rail icon twice filled it. bootAdmin() runs synchronously at the end of the… | test:all |
| `admin-delete-record-method.test.ts` | Admin "Delete" sheet → the function that actually deletes. | test:all |
| `admin-impersonation.test.ts` | US-ADM-1.2.1: admin impersonation, end to end. | test:all |
| `admin-inbox.test.ts` | Admin alert EMAILS go to the business inbox, not each admin's personal account (2026-10-03). | test:all |
| `admin-message-notification.test.ts` | The ad-hoc admin → user in-app message ("Send a Message" in the admin portal's Comms section). | test:all |
| `admin-modal-scope.test.ts` | admin.html is one document holding ~35 `.admin-view` sections. adminNav() shows one by putting `hidden` (display:none) on all the others — and a display:none ancestor hides its whole subtree no matter what the descendant's own classes say. So a dialog that… | test:all |
| `admin-music-bulk-delete.test.ts` | Admin → Music Library can delete tracks in bulk (2026-10-06). The library promised that removing a track never silences a post that already uses it. Delete keeps that promise only if: · the AUDIO FILE is kept whenever any content_assets row still carries… | test:all |
| `admin-music-library.test.ts` | Admin → Music Library: the screen that can take a track out of what every workspace is offered. | test:all |
| `admin-partners.test.ts` | Affiliate Partner Programme, step 3 — Admin → Revenue → Partners (docs/affiliate-partner-programme-plan.md §4.5). | test:all |

## ai

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `ai-music-generation.test.ts` | "✨ Generate music" — Stable Audio 3.0, called direct, paid from the plan's AI credits. | test:all |
| `ai-readability.test.ts` | The build-time copy that lets crawlers and AI assistants read prices and assistant pages without running JavaScript (scripts/seo/ai-readability.mjs, Jobs 5–8 of scripts/build-seo-html.mjs). | test:all |
| `ai-usage-coverage.test.ts` | Every AI call the product makes must land in ai_usage_log, priced, exactly once. | test:all |
| `ai-visibility.test.ts` | Admin → Platform → AI Visibility (admin-ai-visibility.ts, ai-visibility-fetch-background.ts, src/utils/ai-visibility.ts, db/z-ai-visibility.sql). | test:all |

## assistant

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `assistant-colors.test.ts` | The assistant icon colour exists in FOUR places that have to agree, and every disagreement is silent — the assistant just looks like a different assistant on a different page: | test:all |
| `assistant-detail-results-and-dialogs.test.ts` | The assistant details page, after the 2026-10-21 UI/UX reviews: • the Social Media Assistant's Goal Progress + Performance cards live in its Goals tab, renamed "Results" (a registry flag, so the other roles can follow if the owner likes it); • every… | test:all |
| `assistant-go-live.test.ts` | Admin ▸ Assistants (2026-10-10): one status per role, changed only through admin-assistants.ts, and a move to Coming soon / Beta / Live refused while a go-live check fails. Replaces the "Assistant Catalog" + "Master Data → Assistants" pair, where three… | test:all |
| `assistant-metric-counters.test.ts` | The Created / Scheduled / Published tiles on the assistant Overview card, and why they used to disagree with every other screen showing the same work. | test:all |
| `assistant-model-picker.test.ts` | Admin ▸ Assistants ▸ Model & rules (owner, 2026-10-24): choose a role's Claude model, see what it costs, and see the rules its prompts are built from. The adapter is what makes a model change safe — the current generation thinks first (and bills it against… | test:all |
| `assistant-pause-button.test.ts` | The Profile drawer's "Pause Assistant" button (#btn-toggle-status) had a label but no click handler once the Kick-Off card's own pause button went (issue #115) — clicking it did nothing. It must be wired, pause through manage-assistant, and send Resume… | test:all |
| `assistant-pause-defects.test.ts` | The two pause defects found on 2026-08-23 (docs/assistant-pause-defects.md). | test:all |
| `assistant-platform-selection.test.ts` | Turning a platform OFF for an assistant must actually stop it drafting for that platform. | test:all |
| `assistant-showcase.test.ts` | — | test:all |
| `assistant-surface-gaps.test.ts` | Four defects found by reviewing the Blog Writer and Email Marketing Assistant end to end, all of the same family: a surface that LOOKS wired because the registry entry, the toggle or the button is there, over a pipeline that never reaches it. None of them… | test:all |
| `assistant-surfaces-review.test.ts` | The per-assistant review of 2026-10-09: Calendar, Activity, Profile and Set-up, made relevant to each role. Each check names what was wrong on prod (or in code) and pins the fix. | test:all |

## audience

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `audience-capture.test.ts` | The embeddable sign-up form and the double opt-in behind it. | test:all |
| `audience-consent.test.ts` | "May this organisation email this address?" — asked once, answered for every assistant. | test:all |
| `audience-custom-fields.test.ts` | The tenant's own columns — "City", "Plan", "Where we met". | test:all |
| `audience-dynamic-segments.test.ts` | A segment that is a saved RULE rather than a hand-kept list. | test:all |
| `audience-hosted-page.test.ts` | A sign-up page we host, for the customers who have no website to embed a form in. | test:all |
| `audience-import-status.test.ts` | Importing somebody else's list without re-subscribing the people who left it. | test:all |
| `audience-objection.test.ts` | An unsubscribe, or a 90-day pause, must stop COLD OUTREACH too. | test:all |
| `audience-send-history.test.ts` | "What have we actually sent this person?" — the contact drawer's Newsletters section. | test:all |
| `audience-tags.test.ts` | Tags: labels a tenant attaches to people, and then composes into an audience. | test:all |

## blog

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `blog-ai-disclosure.test.ts` | Locks the AI transparency disclosure on blog posts (EU AI Act Art. 50) across every surface. Pure: no network, no DB. | test:all |
| `blog-approve-slot-collision.test.ts` | Locks the fix for: "I reviewed two blogs and asked my assistant to schedule them, and it scheduled them for the same time and date." | test:all |
| `blog-archive-and-refresh.test.ts` | Three faults reported together on 2026-08-19, all from one place: the Blogs tab and Blog Studio disagreeing about what removing a draft means. | test:all |
| `blog-batch-and-bubbles.test.ts` | Owner's list, 2026-10-27: the Blog Writer drafting several articles at once, assistant pop-up bubbles (+ the Business Mentor's suggestions and their Team Chat copy), "Mark as done" on Needs you, and the Lead Generator tab rename / divider / Awaiting-reply… | test:all |
| `blog-blueprint-injection.test.ts` | Blog Autopilot: long-form drafts must receive the workspace's Content Rules (§4) and the owner's AUTHORITATIVE Business Knowledge (§11) from the compiled blueprint. | test:all |
| `blog-card-image.test.ts` | Which picture represents a post in a list — the ladder, and the surfaces that must agree on it. | test:all |
| `blog-card-meta.test.ts` | The byline, the date and the tags — on the post page and on every card in a blog list. | test:all |
| `blog-destinations-panel-copy.test.ts` | Blog Studio's "Where this post gets published" panel makes two claims that are load-bearing and unverifiable by eye. Both were wrong, and both cost real time before this file existed. | test:all |
| `blog-destinations.test.ts` | Locks the pure request builders for the blog connectors (US 3.2 — Dev.to, Hashnode): tag normalisation, canonical/cover mapping, publish-vs-update shape. No network or DB. | test:all |
| `blog-draft-is-async.test.ts` | Blog Studio's "Ask your assistant to draft" must not generate inside the request. | test:all |
| `blog-fonts.test.ts` | Blog Studio ▸ Font family. Locks the one property that makes this feature real: a chosen font is also a FETCHED font. The picker shipped with three options and no webfont loading at all, so "System", "Serif" and "Inter" rendered identically on any machine… | test:all |
| `blog-hosted-index.test.ts` | Locks the hosted blog INDEX at /b/:key — the full-page list a Wix site's "Blog" menu item can link to, instead of squeezing the widget into Wix's fixed-size Embed HTML box. | test:all |
| `blog-index-freshness.test.ts` | Two failures of the same thing — the crawler-visible post index baked into blog.html. | test:all |
| `blog-inline-marks-and-seo.test.ts` | Reported 2026-08-19: "I cannot underline text", "I cannot highlight text", and "why do I need to click to generate SEO". | test:all |
| `blog-json-body-repair.test.ts` | scripts/repair-json-blog-bodies.ts converts blog posts saved as raw layout JSON (before d1fd5db4) into readable Markdown. Pins the pure conversion (src/utils/blog-json-body-repair.ts) and the script's safety rails: dry run by default, conditional write,… | test:all |
| `blog-layout-json-never-leaks.test.ts` | A blog post's body must never be the raw layout JSON. | test:all |
| `blog-lifecycle-counts.test.ts` | Three faults reported together on 2026-08-21, all downstream of one omission: the Blog Writer's Review Queue counted exactly ONE of its lifecycle columns, and Publish told nobody it had run. | test:all |
| `blog-list-paging.test.ts` | Paging for the public blog list — the rules, the SQL they compile to, and the widget that walks them. | test:all |
| `blog-media-directives.test.ts` | Blog Media Composition — locks the `:::media` / `::::columns` directive contract. See docs/blog-media-composition-plan.md §3. | test:all |
| `blog-no-title-only-drafts.test.ts` | "The blog assistant creates a blog with a title and no content." | test:all |
| `blog-outage-handling.test.ts` | The blog pipeline's half of the September outage lesson. | test:all |
| `blog-performance.test.ts` | The Blog Writer's four "Performance Metrics" KPI cards. Locks the presentation rules that keep these cards from claiming things we did not measure. | test:all |
| `blog-reader-features.test.ts` | Four owner asks for published blogs (2026-10-20), each a quiet regression if undone: 1. Blog Studio asks for a feature image before Publish / Approve / Schedule — a nudge, not a gate 2. a post with no feature image shows a placeholder plate (customer blog… | test:all |
| `blog-refusal-never-saved.test.ts` | A blog post's body must never be the drafter refusing, or asking questions back. | test:all |
| `blog-review-reject-seo-sections.test.ts` | Four Blog Writer review changes (2026-09-30): 1. No "Approve & Schedule" on a blog card — a post is approved AFTER it is read, in Blog Studio. 2. Reject a blog draft with a reason; the assistant learns from it (reject-blog-post.ts). 3. Every… | test:all |
| `blog-rss.test.ts` | Locks the pure RSS 2.0 serialiser behind /api/widget/:key/rss (US 3.2 §A.4): escaping, the CDATA breakout guard, RFC-822 dates, guid stability, and the document shape. No network or DB. | test:all |
| `blog-seo.test.ts` | Locks the pure crawler-facing metadata helpers (US 1.3): canonical resolution (incl. the blog-collapse guard), and the head-tag / JSON-LD builder's escaping + shape. No network or DB. | test:all |
| `blog-site-route.test.ts` | Locks the /blog/:slug route on the marketing domain: the pure path parser, the netlify.toml redirect ORDERING (first match wins — the trap this file has sprung twice already), the widget key drift guard between source and blog.html, the engagement beacon… | test:all |
| `blog-studio-usability.test.ts` | Ten faults reported against Blog Studio on 2026-08-19, all variations on one theme: the surface knew things the author could not see. | test:all |
| `blog-unpublish.test.ts` | Locks the unpublish transition (netlify/functions/unpublish-blog.ts + unpublishBlogPost). | test:all |
| `blog-widget-framed.test.ts` | The blog widget inside a website builder's embed frame (Wix "Embed HTML" and friends). | test:all |

## brand

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `brand-card-lifecycle.test.ts` | "Unused generated cards expire; edited ones are kept." The rule, and the cases that make it safe. | test:all |
| `brand-card.test.ts` | Branded text cards: the brand kit (src/utils/brand-kit.ts), the card renderer (src/lib/brand-card.ts) and the stock↔card rotation (src/utils/media-resolver.ts). | test:all |
| `brand-designer-post-briefs.test.ts` | A social draft that found no picture raises a brief for the Brand Designer. Brand Designer plan, Phase 5. The attach rules themselves (a chosen picture is never replaced; a published post is left alone; cross-post siblings get it) are proven on real… | test:all |
| `brand-designer-sources.test.ts` | The Brand Designer's Phase 4 sources — stock video, AI video, and "Add your own" (an upload, or a library picture, which is where a Canva import lands). docs/brand-designer-plan.md §6 step 4. The split image/video settlement is proven on real Postgres in… | test:all |
| `brand-designer.test.ts` | The Brand Designer, Phase 1 — docs/brand-designer-plan.md §4. Briefs → rounds of options from stock, AI and branded cards → the user approves into the library. GUI and chat, one server path. | test:all |
| `brand-extract.test.ts` | Website → brand kit extraction (src/utils/brand-extract.ts) and the retry backoff in src/utils/brand-kit.ts. | test:all |
| `brand-guidelines.test.ts` | Picture guidelines — Brand Designer plan, Phase 2 (§4.5). src/utils/brand-guidelines.ts. | test:all |
| `brand-theme.test.ts` | The brand injector: an organisation's brand kit, resolved into the colours its newsletters are actually built in. | test:all |

## calendar

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `calendar-blog-drag.test.ts` | Blog chips on the Content Calendar are DRAGGABLE. They were not: long-form was the one thing on the grid that could be seen but not moved, so rescheduling next Tuesday's article to Thursday meant opening Blog Studio and re-picking the date by hand. | test:all |
| `calendar-microsoft.test.ts` | The Outlook / Microsoft 365 calendar, signed in (calendar-microsoft.ts): busy times read in Outlook's own terms, bookings and class dates written out by a reconciler that only changes what differs, and the sign-in reusing the Outlook email app with its own… | test:all |
| `calendar-review-ux.test.ts` | Each check pins one behaviour a person relies on, where the old code did the opposite silently: • a post dragged onto a past day went out immediately (no refusal, client or server) • a failed load read as an empty, all-clear page on both screens • "Needs… | test:all |
| `calendar-sync.test.ts` | The owner's calendar with no sign-in (docs/booking-plan.md phase 3): busy times read from their private iCal address (ical-busy.ts, calendar-sync.ts) block appointments; their bookings appear in their calendar through a private subscribe link… | test:all |

## campaign

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `campaign-approve-launch.test.ts` | `approve_launch` — the only action in this product that can start spending a customer's money. | test:all |
| `campaign-attribution.test.ts` | The Campaign Assistant's attribution spine: the binding rule, and the guards that stop the click ledger from quietly under-counting. | test:all |
| `campaign-audience.test.ts` | §9.2 of docs/campaign-orchestrator-plan.md: who a campaign is for, and who it must leave alone. | test:all |
| `campaign-creative.test.ts` | §9.3 of docs/campaign-orchestrator-plan.md: a campaign's tone of voice and its own pictures. | test:all |
| `campaign-decision-card.test.ts` | Found on prod 2026-10-13, approving campaign 1's first plan: | test:all |
| `campaign-email-orders.test.ts` | §9.7 of docs/campaign-orchestrator-plan.md: a campaign can brief the Email Marketing Assistant. | test:all |
| `campaign-first-run-feedback.test.ts` | The owner's first run of a campaign end to end on prod (campaign 1, 2026-10-14), and what it found. Each check pins one fix: 1. Asking for options showed no "working" signal. 2. "Use this" never said whether the brief was finished. 3. A picture brief never… | test:all |
| `campaign-funnel-stage.test.ts` | §9.6 of docs/campaign-orchestrator-plan.md: funnel stage, and outcomes each campaign can count. | test:all |
| `campaign-funnel.test.ts` | The Campaign Assistant's ROI funnel: the arithmetic, and — mostly — the things it refuses to say. | test:all |
| `campaign-hierarchy.test.ts` | §9.4 of docs/campaign-orchestrator-plan.md: umbrella campaigns, always-on campaigns, the year. | test:all |
| `campaign-human-tasks.test.ts` | §9.5 of docs/campaign-orchestrator-plan.md: a campaign can wait on a PERSON. | test:all |
| `campaign-learning.test.ts` | §9.8 of docs/campaign-orchestrator-plan.md: A/B tests and what a campaign taught. | test:all |
| `campaign-notification.test.ts` | The alert that tells a user their campaign is waiting on them. | test:all |
| `campaign-optimiser.test.ts` | Phase C — the paid rails. The kill switch, the budget guarantee, the watchdog, and the lock that keeps all of it unreachable until an ad network approves us. | test:all |
| `campaign-paid-gaps.test.ts` | The three things the paid rails shipped without, and what closing each one had to get right. | test:all |
| `campaign-paid-ui.test.ts` | The paid surface as a user sees it — which for almost every workspace means the LOCKED state. | test:all |
| `campaign-performance.test.ts` | The Campaign Assistant's four Overview KPI cards: the arithmetic, and the wiring that feeds them. | test:all |
| `campaign-picture-counts.test.ts` | A campaign's picture brief is for as many pictures as the posts it serves, and each chosen picture goes on one of those posts. Owner, 2026-10-14: "if the brief is for 10 social posts to be sent out, then the brand designer should be providing options until… | test:all |
| `campaign-plan-editor.test.ts` | A waiting campaign plan can be edited before it is approved (2026-10-13). | test:all |
| `campaign-plan-flow.test.ts` | §9.1 of docs/campaign-orchestrator-plan.md: a campaign's orders must actually flow. | test:all |
| `campaign-prompt-surfaces.test.ts` | The Campaign Assistant's chat prompt must know its own dashboard, its own vocabulary, and the three things it is not allowed to do. | test:all |
| `campaign-proposer.test.ts` | The Campaign Assistant's autonomous run: what it proposes, and what it must never do. | test:all |
| `campaign-reconciler.test.ts` | The Campaign Assistant's RETURN path: how an order settles, and what the reconciler must never do. | test:all |
| `campaign-stats-voice-builder.test.ts` | 2026-10-06 round: email-campaign settings + industry-standard stats, the Voice builder, ToS 2.1, the Swan Index byline, and in-use music tracks being withdrawn rather than deleted. | test:all |
| `campaign-steering-recompiles.test.ts` | A campaign steers drafting ONLY through blueprint section 13-campaign, and generation reads the PERSISTED blueprint. So every event that changes what section 13 should say must recompile the assistants the campaign has ordered work from — otherwise the… | test:all |
| `campaign-tabs-load.test.ts` | Found by testing on prod 2026-10-08, after the §9 release: things that rendered and were wrong. | test:all |
| `campaign-tickets.test.ts` | §9.5, the automatic half: a person's task filed in Jira/Asana, finished when its ticket closes. | test:all |
| `campaign-visual-orders.test.ts` | A campaign commissions pictures from the Brand Designer — `commission_visuals`. Brand Designer plan Phase 3; campaign plan §10. The judge itself is proven on real Postgres in visual-briefs-db.test.ts. | test:all |
| `campaign-work-state.test.ts` | Each piece of a campaign's work states what it is doing, the campaign names ONE next step, and a waiting item can be started without waiting. docs/campaign-orchestrator-flow.md §2, step 1. | test:all |

## chat

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `chat-assistant-settings.test.ts` | Every assistant's chat knows its own status, settings and goals, and can propose a change to them through a card the user confirms — which calls the same endpoint as the Assistant Profile. | test:all |
| `chat-audience.test.ts` | The Email Marketing chat can see the shared Audience and, through cards the user confirms, build a rule-based segment or add one contact — the Audience page's own actions. | test:all |
| `chat-blog-action.test.ts` | The Blog Writer chat can approve, book, unschedule and reject an EXISTING article — by proposing a card the user confirms, which calls the same endpoints as Blog Studio. | test:all |
| `chat-blog-draft.test.ts` | Locks the Blog Writer chat's save-or-discard path end to end. | test:all |
| `chat-brand-card.test.ts` | The chat route's branded-text-card seam. | test:all |
| `chat-draft-claims.test.ts` | Locks replyClaimsPostSaved() — the guard that stops the social chat route telling a user a post was drafted when no scheduled_posts row was written. | test:all |
| `chat-email-action.test.ts` | The Email Marketing chat can approve, approve-for-a-time and send back an EXISTING single email — by proposing a card the user confirms, which calls the Email Studio's own endpoint. | test:all |
| `chat-goals.test.ts` | Every assistant chat lists its goals by id and the metrics it can set one on, and proposes setting, changing or deleting a goal through a card the user confirms — which calls manage-goals.ts, as the Results tab does. | test:all |
| `chat-lead-action.test.ts` | The Lead Generation chat can send a lead's outreach email, move a lead to Outreach, turn one down and record how a deal ended — by proposing a card the user confirms, which calls the tabs' own endpoints. | test:all |
| `chat-library.test.ts` | The Support Agent's chat adds Knowledge Base articles, and the Social Media / Blog Writer chats add Inspo, through confirm cards that POST to the tabs' own endpoints (kb-articles.ts, inspo-items.ts). | test:all |
| `chat-my-account.test.ts` | Every chat can READ the user's own My Account settings — profile, sounds, notification preferences — and says where to change them; it never changes them (owner, 2026-10-22). | test:all |
| `chat-plan-snapshot.test.ts` | Every assistant chat knows the workspace's plan and this month's task balance — the same figures as the usage bar — so "how many tasks do I have left?" gets the real number, not a guess. | test:all |
| `chat-platforms.test.ts` | Chats see which connected platforms their assistant posts to — the "Use for this assistant" switches in Assistant Profile ▸ Connections — and propose turning them on or off through a card that saves exactly as the switch does (update-assistant-context.ts). | test:all |
| `chat-post-action.test.ts` | The Social Media chat can approve, reject, retry and reschedule an EXISTING post — by proposing a card the user confirms, which calls the same endpoints as the Posts tab. | test:all |
| `chat-reviews.test.ts` | The Email Marketing chat gets the Website Assistant's two review cards — reviews_add (save reviews the owner pasted, word for word) and review_decisions (approve or decline customer-sent ones). | test:all |
| `chat-rules.test.ts` | Every assistant chat lists its own Do's and don'ts by id and can propose adding, rewording, switching off/on or deleting one — through a card the user confirms, which calls content-rules.ts, the endpoint the Do's and don'ts card uses. | test:all |
| `chat-schedule.test.ts` | The Social Media and Blog Writer chats see their posting schedule and propose changing how often, which days, what times and which timezone through a card — saved through update-assistant-context.ts, the endpoint the Posting Schedule card autosaves through. | test:all |
| `chat-session-listeners.test.ts` | Every listener a chat attaches to its container must be removed by destroy(). The chat modal destroys the old session and mounts a new one on the SAME container ("New chat", opening another assistant), so a listener destroy() forgets stays attached and… | test:all |

## connection

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `connection-autorefresh.test.ts` | CRON_REFRESHED (integrations.ts) tells the Connections UI which system_connections tokens are renewed silently by a cron, so _connHealth can suppress the "Expiring in Nd" reconnect nag for them. It is a hand-written list of service names sitting in a… | test:all |
| `connection-move.test.ts` | The re-armed tenant-collision block and its way out: src/utils/connection-collision.ts, src/utils/connection-move.ts, move-connection.ts, the collision modal in workspace.html, and db/system-connections-tenant-unique-v2.sql. | test:all |
| `connection-ownership.test.ts` | system_connections.user_id is nullable, and integrations.ts reads `user_id IS NULL` as the sentinel for a "system-wide platform definition". meta-oauth.ts never set the column, so every Facebook and Instagram connection ever made was written into that… | test:all |
| `connection-policy.test.ts` | Server-side connection sandboxing (src/utils/connection-map.ts). | test:all |
| `connection-recovery.test.ts` | Every side-effect a connection failure inflicts must have a path that undoes it. | test:all |
| `connection-selection.test.ts` | Four defects that let ONE workspace holding TWO accounts of the same platform corrupt itself. All four were live on prod until 2026-09-01, and none of them announced itself: the visible symptom was Meta answering "(#10) Application does not have permission… | test:all |
| `connection-status-vocabulary.test.ts` | Every status a WRITER puts in system_connections.status must be one the READERS recognise. | test:all |

## content

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `content-generation-outage.test.ts` | The three things that turned an exhausted API balance into eleven days of lost work. | test:all |
| `content-pillars.test.ts` | One pillar splitter for the profile chips and the post writer (2026-10-06). Be More Swan's five pillars separated by "·" were treated as ONE pillar by drafting; a customer's four pillars separated by spaces likewise — so a pillar could never get its turn. | test:all |
| `content-prompt-surfaces.test.ts` | The Social Media, Blog Writer and Email Marketing chats must be able to SEE their own work and must know the real names of their own page. | test:all |
| `content-snapshot-why.test.ts` | "Why did my post fail?" must be answerable from the chat's own post, article and email lists. | test:all |

## crosspost

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `crosspost-fanout-partial.test.ts` | One-idea fan-out: the primary post is created, then cloned onto every other target platform. | test:all |
| `crosspost-format-routing.test.ts` | Each platform's format is derived from ITS OWN row, not from whichever tab is open. | test:all |
| `crosspost-grouping.test.ts` | Cross-post grouping: every route that can produce sibling posts must give them a shared crosspost_group_id, or the Review Queue renders one card per platform. | test:all |
| `crosspost-media-fanout.test.ts` | Adding media to a cross-post adds it to EVERY platform of that post. | test:all |
| `crosspost-view.test.ts` | "Show a post on several platforms as one post" (src/utils/crosspost-view.ts), plus the two billing fixes from the same day (stripe-webhook.ts), read as source. | test:all |

## discovery

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `discovery-brief-approval.test.ts` | Phase 0: a human reads the actual web searches before the campaign is allowed to spend anything. | test:all |
| `discovery-candidate-resolution.test.ts` | Case A: a search hit on the WRONG PAGE of a real company's site should still find the company. | test:all |
| `discovery-coverage.test.ts` | A discovery run must say whether it saw the market or a corner of it. | test:all |
| `discovery-depth-and-territory.test.ts` | Tier 3: actually reach more of the market, rather than describing how little was reached. | test:all |
| `discovery-domain-filter.test.ts` | Pre-scoring non-prospect filter (src/lib/discovery-domain-filter.ts). The EXCLUDE fixtures are the real domains a staging run (campaign 5, 2026-07-18) qualified as hot/warm leads — directories, a social platform and vendor blogs that no contact enrichment… | test:all |
| `discovery-drain-handoff.test.ts` | A run longer than the platform's function budget must carry on, not drop its tail on the cron. | test:all |
| `discovery-enrich.test.ts` | Lead Generator contact enrichment (src/lib/discovery-enrich.ts) — tier 1, site scrape. This module decides which address a cold outreach email gets SENT to, so a false positive is worse than a miss: it means emailing a stranger, or worse, emailing the… | test:all |
| `discovery-non-company-discard.test.ts` | Blog posts, directories, publishers and suppliers must not land in the Leads tab. | test:all |
| `discovery-paid-enrichment.test.ts` | Tier 2: buying a contact address when reading the company's own site found nothing. | test:all |
| `discovery-plan-reach.test.ts` | Say what a plan can reach BEFORE the user spends on it. | test:all |
| `discovery-prospect-type-gate.test.ts` | The prospect-type gate: src/config/icp-profile.ts (vocabulary + prompt) and the clamp in normaliseLeadCard (src/lib/discovery-scoring.ts). | test:all |
| `discovery-query-gen-exclusions.test.ts` | The query generator must not ask for the things the domain filter throws away. | test:all |
| `discovery-run-summary.test.ts` | The completion notification has to say what the run actually did. | test:all |
| `discovery-schedule.test.ts` | Scheduling a saved search — the "Schedule" control on the Searches tab. | test:all |
| `discovery-scheduled-runs-start-now.test.ts` | A SCHEDULED search must start as promptly as one a human started. | test:all |
| `discovery-scoring-search-area.test.ts` | The scorer must know where the search asked for businesses, and code must enforce its answer. | test:all |
| `discovery-scoring-time-budget.test.ts` | Lead discovery's scoring must finish inside the scheduled worker's tick (2026-10-25). One call for a ten-candidate page took 22–25s on Haiku 4.5 and Opus 5.5 alike — near the limit on its own, before the tick's search and home-page reads. A page is now… | test:all |
| `discovery-scoring-truncation.test.ts` | A scoring reply cut off at the token ceiling must not file every candidate as a cold blank. | test:all |
| `discovery-search-country.test.ts` | A search that names a country must be SEARCHED from that country. | test:all |
| `discovery-search-google-redirects.test.ts` | Google's `google.com/goto` redirect links must never reach a consumer as "google.com". | test:all |
| `discovery-social-handles.test.ts` | Social profile capture (src/lib/discovery-enrich.ts `extractSocialHandles`) — Phase 2 item 7. | test:all |
| `discovery-spend-guards.test.ts` | What stands between a tenant's Searches tab and our search bill. | test:all |
| `discovery-start-now.test.ts` | A search a human just started must actually start. | test:all |
| `discovery-territory-sweep.test.ts` | A campaign must remember which territories it has already worked. | test:all |

## draft

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `draft-horizon-source-of-truth.test.ts` | The draft horizon lives in TWO places and only one of them is authoritative: | test:all |
| `draft-not-lost.test.ts` | A post someone actually built must be reachable again. | test:all |
| `draft-variety.test.ts` | The anti-repetition context a social draft is generated against. | test:all |

## email

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `email-assistant-lifecycle.test.ts` | The Email Marketing Assistant's page follows its work like every other assistant (2026-10-06): · the Review tab counts EVERY column from one list, so an email visibly moves Review → Sent · "Posted" reads "Sent" for emails; failed sends sit in Needs… | test:all |
| `email-campaign-builder.test.ts` | The Email Studio's campaign builder (plan → write → review → save, without the chat) and the Newsletter → Email Marketing rename (2026-10-01). | test:all |
| `email-delivery.test.ts` | "Why isn't this person getting our email?" — Resend's verdict on transactional mail. | test:all |
| `email-domain.test.ts` | Business-domain detection for org grouping (src/utils/email-domain.ts). | test:all |
| `email-merge-escaping.test.ts` | Templated emails (sendTemplatedEmail → renderTemplate → mergeTemplateParts) merge user-controlled values — first names, workspace and assistant names — into three parts with different formats. The HTML body must escape them or a name renders as markup; the… | test:all |
| `email-preheader-merge.test.ts` | The inbox preview line (preheader) was handed to renderMasterTemplate without going through the merge engine, so the Business Mentor's weekly email showed `{{review.proposals \| "Your week, compared with your plan"}}` as its preview text (prod, Oct 2026).… | test:all |

## form

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `form-builder.test.ts` | The Form Builder end to end (docs/form-builder-plan.md): the chat (Mode A), the visual builder (Mode B), the admin API, the public endpoint, campaign linkage, and the migration. | test:all |
| `form-definition.test.ts` | The sign-up form definition (src/utils/form-definition.ts) — one shape for the chat, the form builder and the renderer, and the one gate every definition passes through. | test:all |
| `form-reward.test.ts` | A sign-up form's free download (a lead magnet): part of the form's definition, checked at save, emailed once the person is subscribed (on sign-up, or on confirming), through a signed link that stops working when the file is removed or replaced. And a cover… | test:all |

## goal

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `goal-directive.test.ts` | Locks the seam that makes a SMART goal actually change generated content. | test:all |
| `goal-edit-regrades.test.ts` | Editing a goal's target or end date must re-grade it immediately. | test:all |
| `goal-freshness-note.test.ts` | The Goal Progress card now prints a promise: "Measured automatically once an hour in the background — next check around 1 Aug, 21:00." (_renderGoalFreshnessNote in assistants.js). | test:all |
| `goal-metrics.test.ts` | SMART Goals — the metric catalog (src/config/goal-metrics.ts) gates the Goal Builder dropdown (AC1.1.2) and connection-validation (AC1.1.3). Lock its behaviour so additions can't break it. | test:all |
| `goal-progress.test.ts` | SMART Goals — US1.2 progress/status engine (src/utils/goal-progress.ts). | test:all |
| `goal-summary.test.ts` | SMART Goals — how an assistant's goals collapse into one line on a card (src/utils/goal-summary.ts). | test:all |

## help

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `help-articles-business-mentor.test.ts` | The Business Mentor's four help articles (docs/business-mentor-plan.md §8.3, §8.6) in db/help-articles-2026-12zzzzzzzz-business-mentor.sql: safe to paste into a web SQL editor, unpublished until the role goes Live (copy never runs ahead of the product),… | test:all |
| `help-page-fixes-2026-10-20.test.ts` | Three fixes from the 2026-10-20 review list, each a regression that came back once already or would be invisible until a customer hit it: | test:all |
| `help-seed-retired.test.ts` | The old help-article seed must never run again (owner, 2026-10-22). | test:all |
| `help-support-hub.test.ts` | Help & Support as the one place for help (2026-10-03): the workspace's Report-an-Issue icon and pop-up folded in as a tab, tickets gained a real conversation, and the knowledge base was fixed and extended. | test:all |

## inspo

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `inspo-draft-from-item.test.ts` | The Inspo tab's "Write a … from this" button: click an inspo item and the assistant drafts from it, in its own chat, through its own drafting path. | test:all |
| `inspo-links.test.ts` | Adding a LINK to Inspo (AC2): "use this page to inspire my posts". | test:all |
| `inspo-profile.test.ts` | The two properties the Inspo design rests on (src/utils/inspo-profile.ts). | test:all |
| `inspo-surfaces.test.ts` | Every seam that writes the user's copy must inject the Inspo block. | test:all |
| `inspo-topics.test.ts` | Inspo as a SUBJECT — src/utils/inspo-topics.ts. | test:all |

## lead

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `lead-activity-projection.test.ts` | The sentences the Lead Generator's Activity tab actually shows, and the two ways they go wrong silently. | test:all |
| `lead-approve-surface.test.ts` | "Approving sends the email" is TRUE in one place and FALSE in another, and the same card renders in both. | test:all |
| `lead-bulk-reject.test.ts` | Clearing a queue of leads that can never leave it — without lying to the targeting signal. | test:all |
| `lead-calendar-items.test.ts` | The Lead Generator's Calendar tab draws TWO kinds of item that mean nearly opposite things, and this file exists to stop them merging back into one. | test:all |
| `lead-contact-aggregate.test.ts` | The Searches tab's reachability line — "Contact details for 4 of 65 — 20 publish none, 41 scored cold so were never checked." (Phase 2 item 8 of docs/lead-triage-review-split-plan.md.) | test:all |
| `lead-contact-column.test.ts` | The Leads tab's "Contact" column — can this lead actually be reached? | test:all |
| `lead-deep-enrichment.test.ts` | Deep enrichment: researching a lead and re-scoring it on what turns up. | test:all |
| `lead-delete-evidence.test.ts` | Deleting a lead must not throw away what it taught us, or leave the discovery row lying. | test:all |
| `lead-effort.test.ts` | The Lead Generator's "Effort Saved / Money Saved" strip — the arithmetic, and the two switches that decide whether the strip appears at all. | test:all |
| `lead-email-kind.test.ts` | The role-vs-personal classifier (src/config/lead-email-kind.ts) and its THREE writers — Phase 2 item 9. | test:all |
| `lead-exclusion-gate.test.ts` | An exclusion the user wrote down must be enforced in CODE, not requested in prose. | test:all |
| `lead-look-again.test.ts` | The "Look again" recovery action (Phase 2 item 10). | test:all |
| `lead-outcomes.test.ts` | Phase 4.5 (outcome capture) + the blueprint-version attribution key. Design: docs/strategy-agent-plan.md §0.1, §0.2, §2. | test:all |
| `lead-outreach-lifecycle.test.ts` | What happens to a lead — and to its email — after "Approve & send email". | test:all |
| `lead-outreach-phase.test.ts` | Which step of the outreach journey a lead is at — ONE function decides it, for the staged Outreach tab, its counts and lead-threads.ts `board`. docs/lead-outreach-restructure-plan.md. | test:all |
| `lead-outreach-stages.test.ts` | The Lead Generator's Outreach tab in stages, with the Conversations tab folded in — docs/lead-outreach-restructure-plan.md, Phase 2. | test:all |
| `lead-panel-actions.test.ts` | The Enrichment tab's expanded lead: which buttons exist, where, and exactly once. | test:all |
| `lead-performance.test.ts` | The four Performance Metrics cards on the Lead Generation Assistant. | test:all |
| `lead-person.test.ts` | The one-pass contact search (docs/lead-search-one-pass-plan.md): the pure rules that decide WHO a lead is addressed to and whether an address we hold is theirs, the Companies House match, Hunter's Email Finder parsing, the order of the waterfall, and… | test:all |
| `lead-prompt-surfaces.test.ts` | The Lead Generator's chat prompt must know what the Lead Generator's dashboard contains. | test:all |
| `lead-rating-help.test.ts` | What "hot", "warm" and "cold" mean — one definition, three audiences. | test:all |
| `lead-reject-reasons.test.ts` | Rejecting a discovered lead records WHY — the targeting half of the feedback loop. | test:all |
| `lead-reply-loop.test.ts` | The half of the Lead Generator that happens AFTER the email goes out. | test:all |
| `lead-retention.test.ts` | The 30-day retention clock on a lead, and the Deleted section it moves leads into. | test:all |
| `lead-review-deliverable.test.ts` | The Review Queue holds EMAILS awaiting sign-off, not every lead the last search found. | test:all |
| `lead-table-controls.test.ts` | The Leads tab as a table you can WORK: filter, sort, group, select, and clear out in bulk. | test:all |
| `lead-threads.test.ts` | Phase 2a of docs/lead-generator-revenue-engine-plan.md — reply routing and conversation state. | test:all |

## linkedin

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `linkedin-ads-adapter.test.ts` | The LinkedIn Advertising API adapter — Development Tier, dev-only. | test:all |
| `linkedin-ads-oauth.test.ts` | The LinkedIn ADVERTISING authorisation flow, and the wall between it and the posting connection. | test:all |
| `linkedin-ads-staging.test.ts` | The ad-account picker and `stage_paid` — the two steps between a connected LinkedIn account and a campaign sitting paused, waiting for a human to approve the spend. | test:all |
| `linkedin-media-failure.test.ts` | What LinkedIn tells us when a media upload fails, and whether that survives the trip to failure_reason. The sibling file tests/x-media-failure.test.ts asserts the same guarantee for X, and exists because of three real prod rows shaped like this: | test:all |
| `linkedin-page.test.ts` | LinkedIn Company Page posting through the separate Community Management app. | test:all |

## mentor

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `mentor-card-outcome.test.ts` | The Business Mentor sees what the user did with each card it drew (src/utils/mentor-card-outcome.ts). Staging 2026-10-26: after "Remove this" worked, the next reply said there had been no product to remove — it saw the empty list but not the click. | test:all |
| `mentor-cards.test.ts` | The Business Mentor's cards and quiet mode (docs/business-mentor-plan.md §2.3, §3.3, §3.7, §3.13, §14). Every capability has a screen AND a chat card through one endpoint; the Mentor can't be paused or archived; a suggestion card must say why; the server… | test:all |
| `mentor-chat-review-fixes.test.ts` | Fixes from reviewing a long Business Mentor chat on prod (2026-10-26): - "The Digital Employee" — an ARCHIVED product — showed in the Mentor's Products & Services list, so it told the owner they sold three plans; every other assistant only ever reads… | test:all |
| `mentor-data-inventory.test.ts` | What the Business Mentor may read (docs/business-mentor-plan.md §12.4), and its workspace snapshot. | test:all |
| `mentor-everywhere.test.ts` | The Business Mentor beyond its own page (docs/business-mentor-plan.md §8.6, 2026-10-26): - Ask Your Team (assistant-command.ts) sends business questions to the workspace's active Mentor, with a "Talk to <Mentor> →" button that opens its chat with the… | test:all |
| `mentor-overview-consistency.test.ts` | The Business Mentor's Overview tab must agree with itself. Each test is one contradiction found on staging, 27 Oct, on Nova's Overview ("Week of 26 Oct" review beside the panels): | test:all |
| `mentor-page.test.ts` | Business Mentor Phase 1a: how suggestions behave (docs/business-mentor-plan.md §3.13), the Overview tab's panels (§14) and Admin ▸ Mentor activity (§8.2). | test:all |
| `mentor-phase-1b.test.ts` | Business Mentor Phase 1b (docs/business-mentor-plan.md §3.0a right column): | test:all |
| `mentor-phase-2.test.ts` | Business Mentor Phase 2 (docs/business-mentor-plan.md §4): idea check, strategy documents, break-even, research with sources and playbooks. | test:all |
| `mentor-phase-3.test.ts` | Business Mentor Phase 3 (docs/business-mentor-plan.md §5): the weekly review, commitments, track record and customers. | test:all |
| `mentor-phase-4.test.ts` | Business Mentor Phase 4 (docs/business-mentor-plan.md §6): content checks in the weekly review, and automatic incident reports. | test:all |
| `mentor-rubric-fixes.test.ts` | Fixes from the Business Mentor's first rubric run on staging (2026-10-26, docs/business-mentor-rubric.md): W8 no paid plan → the chat route paywalled the Mentor (403); §2.7 says it still answers, help-only W6 "I've added a card that looks up…" over no card… | test:all |

## meta

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `meta-account-picker.test.ts` | DEFECT 3 of the 2026-09-01 Meta incident: a workspace never got to say WHICH account it was connecting. meta-oauth.ts took `pageList.find(p => p.instagram_business_account?.id)` for Instagram and `?? pageList[0]` for Facebook — the first Page /me/accounts… | test:all |
| `meta-account-reach.test.ts` | Org 37, 2026-09-03: two posts in Needs Attention, and three separate pieces of code all telling the customer something false about why. | test:all |
| `meta-app-block.test.ts` | The 2026-09-02 Meta outage, in miniature. | test:all |
| `meta-deletion-callbacks.test.ts` | meta-callbacks.ts originally served the Threads app only: it verified EVERY signed_request against THREADS_CLIENT_SECRET and revoked rows from workspace_integrations. Pointing the Facebook/Instagram app's data-deletion callback at it would therefore have… | test:all |
| `meta-vault-backfill.test.ts` | The plan behind scripts/backfill-meta-vault-keys.ts, which moves Meta connections off the legacy org+service vault key (`aura/org-<id>/<service>-token`) and onto the account-scoped key. | test:all |

## music

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `music-ingest.test.ts` | Getting a licensed pack into the library — and, more importantly, refusing to. | test:all |
| `music-library.test.ts` | The rules about what may be offered and what must be credited. | test:all |
| `music-picker.test.ts` | The Sound layer's music picker, and the endpoint behind it. | test:all |

## newsletter

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `newsletter-ab-subjects.test.ts` | Two subject lines, a sample, and the winner to everyone else. | test:all |
| `newsletter-campaign-draft.test.ts` | Saving a campaign — an ordered series of emails — written in the Email Marketing Assistant's chat. | test:all |
| `newsletter-chat-draft.test.ts` | Saving an issue written in chat. | test:all |
| `newsletter-design.test.ts` | The Newsletter Design Studio: the block model, the two renderers, and the promises the UI makes about them. | test:all |
| `newsletter-dispatch.test.ts` | Actually sending the thing — the phase where a mistake reaches strangers' inboxes and cannot be recalled. Five failures worth more than the code that prevents them: | test:all |
| `newsletter-drafting.test.ts` | Drafting an issue, and turning it into the email a subscriber actually receives. | test:all |
| `newsletter-from-blog.test.ts` | "Your blog post went out to your subscribers on Thursday, and you didn't do anything." | test:all |
| `newsletter-link-clicks.test.ts` | "Which link worked" — the half of a click rate a tenant can act on. | test:all |
| `newsletter-preference-centre.test.ts` | Something to press other than "unsubscribe". | test:all |
| `newsletter-resend.test.ts` | Resending an issue to the people who never opened it. | test:all |
| `newsletter-role-live.test.ts` | Going live is where an assistant ships with silent holes. Every registry in this product is keyed by roleKey, and a missing entry does not throw — it falls back, usually to the Social Media Manager, and the result is a page of confident numbers about the… | test:all |
| `newsletter-send-time.test.ts` | What time is it for the person receiving this? | test:all |
| `newsletter-sequence-no-route.test.ts` | A welcome sequence / form email campaign with no way to send (no verified sending domain, no connected mailbox) used to HALT each enrolment on the spot with halt_reason 'no_route' — no error, no notification, never resumed. Found 2026-10-05 testing the… | test:all |
| `newsletter-welcome-sequence.test.ts` | The welcome series: mail that goes out on a timer, to strangers, with nobody watching. | test:all |

## no

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `no-body-on-204.test.ts` | A 204 must carry NO body — not even ''. | test:all |
| `no-hardcoded-plan-prices.test.ts` | Plan prices come from master data only (owner, 2026-10-19). | test:all |
| `no-native-dialogs.test.ts` | No browser alert() / confirm() / prompt() in the app's own client code. | test:all |

## notification

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `notification-category-parity.test.ts` | The type→category map exists TWICE — in TypeScript (src/utils/notification-actions.ts TYPE_CATEGORY) and in SQL (db/notifications-categorization.sql, as a CASE inside notification_category_for_type, stamped by a BEFORE INSERT trigger). Nothing kept them in… | test:all |
| `notification-grouping.test.ts` | The notification inbox's "Group by" control, read as source. Nothing here runs a browser — these are the properties whose absence is INVISIBLE in a passing typecheck and in a screenshot of a workspace that happens to have tidy data. | test:all |
| `notification-prefs.test.ts` | Unified Notification Preferences matrix model (src/utils/notification-prefs.ts). | test:all |

## onboarding

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `onboarding-completion-and-capacity.test.ts` | Finishing the onboarding form must (a) read as finished, and (b) never hand out a seat the plan does not have. These were one causal chain, reported together. | test:all |
| `onboarding-recommendations.test.ts` | "Recommended for you" in the setup guide must never block anything: it is a separate list, not steps, so it can never reopen the wizard over a live customer's work or hold up go-live. | test:all |
| `onboarding-status-gate.test.ts` | onboarding.ts creates an ai_assistants row for whatever master role the roleKey names, and used to do it with no status check at all: a hidden, retired or coming-soon role (teasers, mostly unbuilt — crm_enricher was parked there for fabricating data) could… | test:all |

## outreach

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `outreach-connect-return.test.ts` | Connecting an inbox from inside "Approve & send email", and the way back afterwards. | test:all |
| `outreach-offer.test.ts` | A Lead Generator's outreach OFFER (owner, 2026-10-24): a free gift, the intro offer, or just a question — permission-based first emails under 75 words with no link, the link in the first follow-up, and a sign-up through a gift's tracked link credited to… | test:all |
| `outreach-sender-identity.test.ts` | Every AI-written outreach email must know which business it is FROM. | test:all |
| `outreach-sequences.test.ts` | Phase 2b of docs/lead-generator-revenue-engine-plan.md §5.2 — the outreach sequence engine. | test:all |
| `outreach-signature.test.ts` | The Lead Generator's email signature (2026-10-01): plain text, added in code at every send site, and — while set — the drafts stop signing off so nothing is signed twice. | test:all |
| `outreach-subject-rules.test.ts` | Every AI-generated outreach subject line must carry OUTREACH_SUBJECT_RULES. | test:all |
| `outreach-unsubscribe.test.ts` | Cold outreach to a prospect must carry a working way to make it stop. | test:all |

## overlay

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `overlay-anim-client.test.ts` | The browser's copy of overlayAnimAt must agree with the renderer's, to the last decimal. | test:all |
| `overlay-anim.test.ts` | How a text box arrives and leaves (overlayAnimAt in src/lib/overlay-geometry.ts). | test:all |
| `overlay-fonts.test.ts` | The typeface catalogue behind text overlays (src/lib/overlay-fonts.ts). | test:all |
| `overlay-geometry.test.ts` | The overlay box geometry lives in TWO places that MUST agree, or a text box lands in a different spot in the published media than the user dragged it to: 1. src/lib/overlay-geometry.ts — imported by the Remotion video render (and this test) 2.… | test:all |
| `overlay-reanchor.test.ts` | Keeping text with its clip when the cut changes (_pceReanchorOverlays in workspace.html). | test:all |
| `overlay-text-assistant.test.ts` | "Suggest wording" / "Improve this" on a text overlay. | test:all |

## partner

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `partner-applications-db.test.ts` | Applying to be a partner, approval, and the private account link — on REAL Postgres (src/utils/partner-applications.ts, src/utils/referral-code.ts). | CI Postgres |
| `partner-applications.test.ts` | Affiliate Partner Programme, step 4 — applying, the private account link, /invite/<code> and the "Invited by" field (docs/affiliate-partner-programme-plan.md §4.2, §4.6). | test:all |
| `partner-assistant.test.ts` | Affiliate Partner Programme, step 8 — the partner's own Partner Assistant on their Partner page (docs/affiliate-partner-programme-plan.md §4.7). | test:all |
| `partner-codes-db.test.ts` | Partner codes on REAL Postgres — src/utils/invite-codes.ts and how the ledger and the friend offer see a customer who came in on one. | CI Postgres |
| `partner-codes.test.ts` | Affiliate Partner Programme, step 7 — partner codes (docs/affiliate-partner-programme-plan.md §4.2). | test:all |
| `partner-ended-and-disputes.test.ts` | Affiliate Partner Programme — gaps the legal review of Partner Terms v1.1 found in the code (2026-10-23). The ledger behaviour itself is tested on real Postgres in partner-ledger-db.test.ts. | test:all |
| `partner-erasure-db.test.ts` | Erasing a partner's personal data — on REAL Postgres, with the real vault (src/utils/partner-erasure.ts). | CI Postgres |
| `partner-hub.test.ts` | Affiliate Partner Programme, step 5 — the partner's Partner page in the workspace (docs/affiliate-partner-programme-plan.md §4.6). | test:all |
| `partner-ledger-db.test.ts` | The partner commission ledger on REAL Postgres — src/utils/partner-ledger.ts (docs/affiliate-partner-programme-plan.md §4.3). | CI Postgres |
| `partner-ledger.test.ts` | Affiliate Partner Programme, step 2 — the commission ledger's wiring (docs/affiliate-partner-programme-plan.md §4.3). The money SQL itself is proven on real Postgres in tests/partner-ledger-db.test.ts (CI rls job). | test:all |
| `partner-legal-data.test.ts` | Affiliate Partner Programme, step 9 — Partner Terms, the Terms and privacy updates, data export, erasure and partner notifications (docs/affiliate-partner-programme-plan.md §4.8). | test:all |
| `partner-ops-chat.test.ts` | Affiliate Partner Programme, step 3b — the Partner Ops chat on Admin → Revenue → Partners. | test:all |
| `partner-ops-db.test.ts` | The Partner Ops read queries on REAL Postgres — src/utils/partner-ops.ts (the Partners screen's list, and the chat's top referrers / pre-payout audit / recruitment). | CI Postgres |
| `partner-payout-runs-db.test.ts` | The ledger actions and a monthly payout run — on REAL Postgres, with the real vault (src/utils/partner-payout-batches.ts). | CI Postgres |
| `partner-payout-runs.test.ts` | Affiliate Partner Programme, step 6 — the admin ledger and monthly payout runs (docs/affiliate-partner-programme-plan.md §4.4–4.5). | test:all |
| `partner-payouts-db.test.ts` | A partner's payout details and their Partner page numbers — on REAL Postgres, with the real vault (src/utils/partner-payouts.ts, src/utils/vault.ts, src/utils/partner-ops.ts partnerHubSummary). | CI Postgres |
| `partner-rate-periods.test.ts` | Affiliate Partner Programme — dated commission rates (docs/affiliate-partner-programme-plan.md). | test:all |

## plan

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `plan-limit-coercion.test.ts` | plans.featureOverrides is jsonb, so its declared TypeScript shape is a description of intent, not a runtime guarantee. effectiveLimit used to assert that shape (`as number \| null`) rather than check it, and a string limit went straight into… | test:all |
| `plan-moves.test.ts` | Admin → Revenue → Plan moves, and the shared scheduler behind every plan change at renewal. | test:all |
| `plan-products.test.ts` | Be More Swan's own plans in its own Products & Services read as the plan settings say (owner, 2026-10-27): blog drafts said the Busywork Buster gave "three distinct assistants" — a July row, never updated — and the Business Mentor is included on both… | test:all |
| `plan-stripe-refs-backfill.test.ts` | A first subscription is written by two racers — confirm-payment.ts (the browser landing on workspace.html?payment=success) and stripe-webhook.ts (payment_intent.succeeded) — and exactly one of them wins the plans_one_active_per_org_unique index. The loser… | test:all |

## platform

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `platform-allowlist.test.ts` | Every platform the composer offers must be one the drafting endpoints accept. | test:all |
| `platform-caption.test.ts` | Per-platform caption/hashtag fit (src/utils/platform-caption.ts). | test:all |
| `platform-reviews.test.ts` | Reviews OF Be More Swan (src/utils/platform-reviews.ts, platform-review.ts, admin-platform-reviews.ts, platform-review.js): the reviewer's words kept, free access disclosed, consent before quoting, the same Trustpilot / G2 links for every star rating, and… | test:all |
| `platform-strategy-brief.test.ts` | The per-platform strategy (context.platform_strategy) is captured at onboarding and edited in the profile, but for a long time it only reached the model as a raw JSON blob in the blueprint dump — never as a directive — because formatPlatformStrategyBrief… | test:all |
| `platform-tab-removal.test.ts` | A post must be narrowable to one platform. | test:all |

## post

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `post-clip-editor.test.ts` | Phase 5 of docs/video-editing-plan.md: the clip list in the post editor. | test:all |
| `post-destinations.test.ts` | A destination is a platform AND a format. | test:all |
| `post-disclosure-persistence.test.ts` | The AI disclosure survives a caption being REPLACED. | test:all |
| `post-editor-page.test.ts` | The social post editor as a PAGE (not a pop-up), and the quality review that greeted a brand-new, empty post with "could not be completed" (both reported 2026-10-01). | test:all |
| `post-editor-single-surface.test.ts` | There is ONE post editor, it has ONE layout, and that layout leads with the content. | test:all |
| `post-failure-recovery.test.ts` | Locks the failure classification, and the properties that stop the "Needs attention" column becoming a dead end again. No network or DB. | test:all |
| `post-formats.test.ts` | The post-format catalogue reaches the editor through a GENERATED file: 1. src/config/post-formats.ts — the server's, and the authority. approve-post refuses an unschedulable format from here, so this one decides what can actually be queued. 2.… | test:all |
| `post-image-editing-limits.test.ts` | The two things that stopped a customer editing an Instagram post on 2026-09-02, both reported as "it worked before". Neither was a regression — both were long-standing and only met the right picture: a 4284×5712, 6,400,655-byte phone photo. | test:all |
| `post-link.test.ts` | The post's link, and the text a platform actually receives (src/utils/post-link.ts). | test:all |
| `post-media-retention.test.ts` | Media attached to a post must eventually be reclaimed from R2 — and nothing else must be. | test:all |
| `post-performance.test.ts` | US-SMM-PERF: the aggregation behind the assistant-detail "Performance Metrics" cards. These four cards were blank for every assistant because the renderer read a shape (hasData / metrics / series / current / topValuePosts) that no endpoint produced. This… | test:all |
| `post-published-link.test.ts` | "Post published to LinkedIn — tap to view" with nothing to tap (reported 2026-10-01), and the workspace header's identity block moved into the avatar menu. | test:all |
| `post-quality-review.test.ts` | Locks the rules that stop the quality reviewer becoming a treadmill. No network or DB. | test:all |
| `post-render.test.ts` | The pure half of the video-overlay render pipeline (src/lib/post-render.ts): which overlays are worth rendering, and the frame metadata put on the queued job. | test:all |

## product

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `product-dietary.test.ts` | Two follow-ups: dietary markers on products (product-dietary.ts → menus and assistants), and the chat approving or declining reviews customers sent in (a review_decisions card, GUI–chat parity). | test:all |
| `product-price.test.ts` | Prices recorded ONCE, in Business Information (db/z-product-pricing.sql, src/utils/product-price.ts), and reused by every assistant's prompt, the website's products section and Stripe checkout. | test:all |
| `product-update-email.test.ts` | The weekly "What's new" email (docs/weekly-product-update.md). It goes to every customer, so the properties worth locking are the ones whose failure is public and cannot be taken back: • copy from an AI draft is never rendered as HTML • the machine token… | test:all |

## prompt

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `prompt-audit-blog-leads-site.test.ts` | Prompt audit, 2026-10-25 — Blog, Lead Generator outreach and Website (owner: "assistants need to be experts in their role"). Graded live drafts for three businesses (a physio, a bookkeeper, a florist), before and after. Before: a "true story" blog invented… | test:all |
| `prompt-audit-craft.test.ts` | Prompt audit, 2026-10-24 (owner: "assistants need to be experts in their role", and "assistants can only connect with each other if the user has them active"). Graded 18 live drafts for three businesses, before and after: invented customers and results, a… | test:all |
| `prompt-audit-shopper-designer-campaign.test.ts` | Prompt audit, 2026-10-25 — Mystery Shopper, Brand Designer and Campaign Orchestrator (owner: "assistants need to be experts in their role", and "assistants can only connect with each other if the user has them active"). Graded live runs for three… | test:all |

## review

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `review-bulk-remove.test.ts` | Tick several posts in an assistant's Review tab and Remove them together — and the chat's twin, a "remove" post_action_proposal. | test:all |
| `review-discard-assistant-draft.test.ts` | An assistant's draft can be DISCARDED from the review modal, not only rejected. | test:all |
| `review-group-counts.test.ts` | The count pill beside a Review group ("Social media posts") must agree with the tab badge above it. | test:all |
| `review-link-image-regen-stock-more.test.ts` | Three post-editor fixes from one report (2026-09-30): | test:all |
| `review-login.test.ts` | A password login is a door in a product that otherwise has none. | test:all |
| `review-modal-when-defined.test.ts` | _rqReviewRenderActive (workspace.html) quotes `when` in its scheduled/approved and published status notes. Its definition sat beside the old subtitle line and went with it (b1f3a1f4, 2026-07-27), so from then on opening any scheduled, approved or published… | test:all |
| `review-queue-paging.test.ts` | The Review Queue loads a page at a time. The thing that can go wrong is not "wrong count" — it is SPLITTING A CROSS-POST. One logical post is one scheduled_posts row per platform sharing a crosspost_group_id, and the queue collapses those into a single… | test:all |
| `review-requests.test.ts` | Asking customers for a review (src/utils/review-requests.ts, site-review.ts): off until switched on, one neutral email, a signed link to the business's own site, consent before anything is shown, owner approval, the Google link offered to everyone alike,… | test:all |

## site

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `site-audit-covered.test.ts` | The Mystery Shopper's "Ideas for your other assistants" must not repeat what is already covered: ideas suggested before, briefs the user sent, and what the receiving assistants already wrote (owner, 2026-10-21 — the same ideas came back, reworded, after… | test:all |
| `site-audit-pipeline.test.ts` | The Mystery Shopper's run pipeline (src/utils/site-audit.ts runAuditCore), its prompts (src/utils/site-audit-prompts.ts) and the API's guarantees (netlify/functions/site-audits.ts). docs/mystery-shopper-plan.md §4.4. | test:all |
| `site-audit-schedule.test.ts` | The Mystery Shopper's weekly loop (docs/mystery-shopper-plan.md step 4): which audits are due (src/utils/site-audit-schedule.ts), that the job is actually scheduled on prod AND staging, and the pipeline rules that arrived with it — fixes verified only… | test:all |
| `site-audit.test.ts` | The Mystery Shopper's page reader (src/utils/site-extract.ts) and score (src/utils/site-score.ts). docs/mystery-shopper-plan.md §3.1, §4.3. | test:all |
| `site-builder.test.ts` | The Website Assistant's site definition (src/utils/site-definition.ts) and renderer (src/utils/site-render.ts) — docs/website-assistant-plan.md step 1. | test:all |
| `site-calendar-enquiries.test.ts` | From live testing (owner, 2026-10-17): the Website Assistant's Calendar shows availability and bookings together (n of N, n booked · n free, open a booking to decide it); enquirers join the Audience only with their agreement; "Timetable" is "Availability";… | test:all |
| `site-directory.test.ts` | The site page directory (docs/site-directory-plan.md): a map of the customer's website every live assistant reads. Saved pages only — no network: tests/fixtures/site-import/. | test:all |
| `site-domains.test.ts` | A business's own domain for its site (decision D2: Netlify aliases to start — owner, 2026-10-17). | test:all |
| `site-editor-tabs-features.test.ts` | The Website Assistant's page, reshaped (owner, 2026-10-16): Enquiries, Orders and Bookings are tabs of their own; the site's features can be switched off (hidden from the editor, the chat and the draft, and their tabs); a swan beside every section asks for… | test:all |
| `site-forms.test.ts` | The Website Assistant, step 3b: forms on hosted sites — the contact (enquiry) and sign-up sections, drawn as script-free HTML (site-render.ts), and what a POST to /_form does (src/utils/site-forms.ts → site-serve.ts → audience-public.ts for sign-ups). | test:all |
| `site-gallery.test.ts` | The gallery section: the owner's own pictures (library assets or https), each described (alt, required) with an optional caption, as even squares or at their own shape, each linking to itself full size. Library pictures pass the same ownership check as… | test:all |
| `site-host-cache.test.ts` | One site's page must never be served at another site's address. The sites host fetches site-serve?path=… with the site in a header; a cache keyed on the URL alone would mix sites up (seen the day wildcard routing went live, 2026-10-16: one address's page… | test:all |
| `site-hosting.test.ts` | The Website Assistant, step 3a (docs/website-assistant-plan.md §5.2, §7): publishing on <name>.bemoreswan.site — addresses, who may be served, what is served, the publish gate, the separate sites-host project, "Report this site", and the admin's power to… | test:all |
| `site-import.test.ts` | The Website Assistant's "Import my current site" (site-import.ts, site-extract.ts readImportPage, site-import-store.ts, sites.ts import / import_accept / import_discard). Saved pages only — no network: tests/fixtures/site-import/ (and the Mystery Shopper's… | test:all |
| `site-layout.test.ts` | Sites that don't follow the standard structure: one-page sites (structure + combine_pages), pages hidden from the menu, and how each section looks (background, columns, a picture beside text) — all closed choices through the one gate (site-definition.ts)… | test:all |
| `site-media-picker.test.ts` | Pictures and videos on a website (owner, 2026-10-17): the picker offers what the other assistants do — upload, the library, stock found by the assistant, and AI-created pictures and videos — and a library video plays in a hero, a text section or a gallery… | test:all |
| `site-menu.test.ts` | The menu / price list section: groups the owner names, filled with Business Information products, drawn as name · price lines. Names, prices, descriptions and lengths are read from Business Information when the page is drawn (site-shop.ts loadSiteProducts)… | test:all |
| `site-owner-content.test.ts` | The Website Assistant: the owner's own pictures and words on their site. 1. "Choose picture" — library pictures (content_assets) instead of pasted web addresses. 2. "Add your own words" — the owner's text placed on a page WORD FOR WORD (site-words.ts). 3.… | test:all |
| `site-payments-followups.test.ts` | Follow-ups from the first live payments test: a publish shows at once (cache purged by tag), the owner is told when Stripe goes live (return notice + site_payments_ready), Stripe's "your website" question is answered before they start, and Orders has its… | test:all |
| `site-plan-prices.test.ts` | The Mystery Shopper reads our plan prices the way a visitor sees them (2026-10-27). | test:all |
| `site-shop.test.ts` | The Website Assistant, step 3c: selling on hosted sites through each workspace's own Stripe STANDARD account, with no fee to us (decisions D4, D5). src/utils/site-shop.ts, the products section (site-definition.ts / site-render.ts), site-serve.ts /_buy and… | test:all |
| `site-social-feed.test.ts` | The social posts section (owner 2026-10-20): hosted sites only, and ONLY posts published through Be More Swan, read when the page is drawn. The section holds platforms, a count, an on/off switch — and its page is configurable (move_section toPageId), in… | test:all |
| `site-split-pages.test.ts` | One page → several again (owner, 2026-10-16). Combining moved every page onto the home page, so flipping the layout back changed nothing a visitor could see. split_pages is the reverse: the home page splits at each later section with a menu label, proposed… | test:all |
| `site-taster.test.ts` | The Mystery Shopper's free public taster (docs/mystery-shopper-plan.md step 5): the pure result builder and tokens (src/utils/site-taster.ts), the public endpoint's guarantees (netlify/functions/site-audit-public.ts), the result email, and the marketing… | test:all |
| `site-templates.test.ts` | Website templates (owner, 2026-10-18): more design range (self-hosted font pairings, spacing, a tint, a centred header, a full-width "cover" hero), eight templates, a gallery of real previews, and "write the words" filling a template's layout instead of… | test:all |
| `site-text-clamp.test.ts` | Website text that is too long for its place is shortened so it still reads — and the owner is told. | test:all |
| `site-theme.test.ts` | Admin ▸ Site Styles (2026-10-06): the admin edits fonts, text, labels, buttons and borders, and "Set as Be More Swan standard" restyles every page live. What must hold: · the default theme produces NO CSS — publishing it changes nothing · nothing free-form… | test:all |

## social

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `social-credentials.test.ts` | Credential-store routing for the social publish path (src/utils/social-publish.ts). | test:all |
| `social-handles.test.ts` | Social handles have ONE home — Business Information (organisations.social_handles). The Social Media Assistant's set-up asks for them too and writes them back there (onboarding.ts), in the same prefix + handle shape, so the two pages never disagree. | test:all |
| `social-oauth-request.test.ts` | Locks the shape of the LinkedIn / X authorization requests that social-oauth-init.ts builds. These are the details the providers reject on, and each has burned us: · scopes must be SPACE-delimited (RFC 6749 §3.3) — a comma-joined list was refused outright… | test:all |

## swan

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `swan-index-backfill.test.ts` | scripts/submit-missing-swan-index.ts submits published posts that never reached The Swan Index (sent only at publish time, and profiles only became default-on on 2026-09-29). Used on PROD 2026-09-30: 10 posts across Be More Swan, love cat studio and Kudzu. | test:all |
| `swan-index-curation.test.ts` | The Swan Index editorial desk: the curation rules, and the admin.html wiring that reaches them. | test:all |
| `swan-index-opt-out.test.ts` | The Swan Index became Be More Swan-managed (2026-10-06): every workspace syndicates by default, the workspace has no control for it, and opting out is by email — recorded by an editor on Admin ▸ The Swan Index ▸ Opt-outs. What must hold: · no customer… | test:all |
| `swan-index.test.ts` | The Swan Index — pure units: route parsing, handle allocation rules, the render layer's crawler-facing output, and the adapter's registration. No network, no DB. | test:all |

## video

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `video-drivers.test.ts` | Video publishing on the four platforms that previously had none: Facebook, LinkedIn, X, Threads. | test:all |
| `video-edit.test.ts` | The pure half of the edit list (src/lib/video-edit.ts): what survives sanitising, what counts as a real cut, and what trim reaches the renderer. | test:all |
| `video-overlay-timing.test.ts` | A text box on a video is stored as SECONDS, timed against an axis the editor draws from the clip's duration. When the browser cannot read that duration, the editor used to draw the axis anyway from a 15-second fallback — so a box placed at 8–14s on a clip… | test:all |
| `video-producer-go-live.test.ts` | The Video Producer's go-live copy (docs/video-producer-plan.md §7.5): help articles, website page, pricing row, FAQ, Mentor and Ask Your Team — every figure the copy states matching the code. The pricing row and FAQ went live 2026-10-31; the help articles… | test:all |
| `video-producer-phase7.test.ts` | The Video Producer, Phase 7 (docs/video-producer-plan.md): autopilot, "Make a video version" on a post, and the Campaign Assistant's `commission_video` order. | test:all |
| `video-producer-role.test.ts` | The Video Producer role (docs/video-producer-plan.md Phase 6) — every place a role must be wired, checked against each other so a rename in one cannot leave the others lying. | test:all |
| `video-producer.test.ts` | Video Producer Phase 5 — still scenes on the timeline, assembly, the project endpoints. | test:all |
| `video-reframe.test.ts` | Phase 4 of docs/video-editing-plan.md: which platforms re-frame the rendered master, and which posts may share one render. | test:all |

## x

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `x-media-failure.test.ts` | What X tells us when a media upload fails, and whether that survives the trip to failure_reason. | test:all |
| `x-post-credits.test.ts` | URL detection + cost for metered X posting (src/utils/ai-credits.ts). | test:all |
| `x-quota-pause.test.ts` | 'paused_credits' — the X quota park — and the chain of places that all have to agree about it. | test:all |

## other

| Test file | What it protects | Runs in |
| --- | --- | --- |
| `account-graph.test.ts` | Phase 3 of docs/lead-generator-revenue-engine-plan.md §5.3 — the account graph and memory. | test:all |
| `annual-billing.test.ts` | "Pay Annually" (20% off) must charge what the pricing page advertises, sit on the plan's own Stripe product, and survive a plan change. | test:all |
| `asset-metrics.test.ts` | The rules governing content_assets width / height / duration_s. | test:all |
| `audio-overlays.test.ts` | The timed-audio model (src/lib/audio-overlays.ts) — voice notes and sound placed on a post. | test:all |
| `audit-log-login-filter.test.ts` | Admin → Audit Log can filter to "Login": the endpoint reads login_events (not admin_audit_log) and returns rows in the same shape, so the viewer renders them unchanged. | test:all |
| `auth-guard-paths.test.ts` | Guards the invariant that an auth-guard bypass depends on: | test:all |
| `auto-publish-stale-slot.test.ts` | Autopilot will not publish a draft that was written for a moment which has already gone. | test:all |
| `autonomous-draft-brief.test.ts` | The daily autonomous drafter (autonomous-media-suggestions.ts) — src/utils/autonomous-draft-brief.ts. | test:all |
| `autopilot-silent-skip.test.ts` | An assistant that will never draft again must not be a number in a cron response nobody reads. | test:all |
| `beta-ending.test.ts` | Ending the beta: per-workspace end dates, admin-only emails, the founding offer, and what happens on the day — pause, hold, never delete, and switch back on the moment they subscribe. | test:all |
| `beta-testers.test.ts` | Beta testers (decided 2026-10-05, src/utils/beta-testers.ts): anyone who applied through /beta may create an account while registration is locked, and gets the free 'beta' plan — no Stripe, no card. These checks pin the four places that have to agree, each… | test:all |
| `bias-parity.test.ts` | US3 — Demographic Parity Testing for the Be More Swan Safe Content Benchmark. | test:all |
| `billed-mrr.test.ts` | The COGS margin must use what a workspace actually pays, and Check Stripe must show annual subscribers on an old price. | test:all |
| `billing-voucher-dahlia.test.ts` | A coupon must show on our invoices, receipts and the billing page. | test:all |
| `blank-draft-sweep.test.ts` | Abandoned blank drafts must be collected — and the sweep must never reach a row holding human work. | test:all |
| `blueprint-prompt-sync.test.ts` | The blueprint is meant to BE the brief the assistant is generated from. These checks pin the places where the two can silently disagree. | test:all |
| `blueprint-sections.test.ts` | The blueprint reports what an assistant IS configured with. These checks pin the two places it described the configuration from scratch instead of from the code that acts on it, and so reported gaps that did not exist. | test:all |
| `booking-deposits.test.ts` | Deposits for website bookings (docs/booking-plan.md phase 4): set per service (fixed £ or % of a fixed price, per place for a class), paid on the business's own Stripe account while the time is held, announced only once paid, refunded in full when… | test:all |
| `bookings-changes.test.ts` | Bookings phase 2 (docs/booking-plan.md): the customer cancels or moves their own booking from a signed link (booking-links.ts, site-booking.ts), a move can never double-book or lose the booking (bookings.ts createBooking replaceBookingId), and the… | test:all |
| `bookings.test.ts` | Bookings, phase 1 (docs/booking-plan.md): time zones (booking-time.ts), which times can be booked (booking-availability.ts), what may be saved (booking-settings.ts), the booking steps on a site (site-booking.ts), the booking section, and the wiring that… | test:all |
| `bubbles-images-blog-approve.test.ts` | Owner's list, 2026-10-27: 1. Assistant pop-up bubbles sat bottom-left at z-index 60; a page opened while one showed drew over it. They now sit under the header's assistant switcher, above everything. 2. The blog's four AI images were near-copies: one… | test:all |
| `business-hours.test.ts` | The website's "Opening hours & contact" section: the Open-now badge in the business's timezone, the week's hours, closed days, one-tap contact buttons, and the search data — all read from Business Information (business-hours.ts, booking-settings.ts) and… | test:all |
| `button-system.test.ts` | Button colour by INTENT (2026-10-03): six semantic classes, defined once, and the buttons that were re-classed carry no colour utilities of their own to fight them. | test:all |
| `c2pa-sign.test.ts` | Locks the dependency-free surface of the C2PA image-signing scaffold (US 6.1): the enable gate, the manifest builder shape, and the disabled passthrough. The native signing + R2 round-trip cannot run without a cert, so they are out of scope here. No… | test:all |
| `cached-fetch.test.ts` | src/components/cached-fetch.js lets several workspace views share one get-assistants list instead of each fetching its own (measured on prod 2026-10-07: 8 calls across 7 tab switches). A cache in front of state the user can change is only safe if it can… | test:all |
| `callback-request.test.ts` | "Request a call back" — Help & Support form, the ticket it becomes, and the chat card. | test:all |
| `captions.test.ts` | Voiceover captions (Video Producer plan, Phase 3) — src/lib/captions.ts, the audio `captions` flag, the render fingerprint, the worker and the composition. | test:all |
| `carousel-drivers.test.ts` | Multi-attachment posts — carousels — across the drivers that can send them. | test:all |
| `classes.test.ts` | Classes and events (docs/booking-plan.md phase 5): dated sessions with places, booked as ordinary bookings under the same lock, a waitlist when full, a timetable on the site, and the owner's timetable on the Website tab. src/utils/class-sessions.ts,… | test:all |
| `client-constants-fresh.test.ts` | src/generated/platform-constants.js must match what scripts/gen-client-constants.ts would write from src/config/platform-formats.ts right now. | test:all |
| `clip-split-playhead.test.ts` | Instagram-style cutting in the post editor (2026-10-02): a draggable playhead on each clip's trim bar, ✂ Split at it, ⧉ Duplicate. A split is two entries on the SAME asset — the save and the renderer already accept that, so the client is the whole feature. | test:all |
| `clip-trim-slider.test.ts` | The trim slider on a clip, and the reason it went missing. | test:all |
| `compliance-config.test.ts` | AC4.1 — modular compliance layer (src/config/compliance.ts) is now load-bearing across register.ts, onboarding.ts, workspace-ai-disclosure.ts, provision-assistant-async.ts and manage-risk-assessment.ts. These checks lock its behaviour so a refactor can't… | test:all |
| `compliance-verification.test.ts` | Locks the grounding check that stops the compliance verifier filing a fabricated citation. | test:all |
| `confirm-card-reply.test.ts` | The words beside a confirm card never say the change happened (src/utils/confirm-card-reply.ts). | test:all |
| `connections-list-rows.test.ts` | The assistant profile's Connections panel is a LIST of rows, not a grid of tiles (2026-09-30). | test:all |
| `copy-published-post.test.ts` | Sending a post that has ALREADY GONE OUT to another platform. | test:all |
| `crm-export.test.ts` | CRM-shaped lead export (Phase 2 item 12) — src/config/crm-export.ts and the CSV branch of netlify/functions/assistant-records.ts. | test:all |
| `current-date-prompt.test.ts` | The model was dating social posts 2025 because NOTHING in the generation prompt said what day it was — so it answered from its training prior. The fix is a date block in the prompt, which means two things can silently regress: | test:all |
| `dashboard-improvements.test.ts` | The dashboard improvements of 2026-10-09 — what the dashboard review found missing, given what the team can now do: a "Needs you" strip, an honest hours label, every assistant's work (not just social), Campaign / Brand Designer card summaries, a capacity… | test:all |
| `data-export.test.ts` | Self-serve data export (DPA v1.1 §9: "export your workspace data at any time from My Account"). | test:all |
| `data-hub-import-export.test.ts` | The Leads tab's two CSV doors: Import CSV and Export. | test:all |
| `delete-plan-blocked.test.ts` | Admin ▸ Master Data ▸ Plans ▸ Delete must explain itself, not fail. | test:all |
| `deliverability.test.ts` | "Will this arrive?" — answered only where we actually know something. | test:all |
| `directory-exposure.test.ts` | Nothing server-only may be published to the open web. | test:all |
| `disconnect-revoke.test.ts` | Disconnect must not revoke a token that something else still uses: src/utils/disconnect-revoke.ts and the DELETE handler in netlify/functions/integrations.ts. | test:all |
| `discussions.test.ts` | The Lead Generator's Discussions tab: forum threads worth replying to, each with a drafted reply the user posts themselves. | test:all |
| `do-not-contact-gate.test.ts` | A lead the qualification pass says must not be emailed must not be emailed. | test:all |
| `early-access-gate.test.ts` | The 25-task "early access" milestone (US-AUD-2.3.1) used to unlock COMING-SOON roles in hire-assistant.ts — any plan could hire a teaser that wasn't built (or, like crm_enricher, was parked there for fabricating data). Now: coming soon is never hireable;… | test:all |
| `env-routing.test.ts` | Epic: Superadmin Environment Management — US3.3 (Strict Production Default). | test:all |
| `esm-only-imports.test.ts` | Guards the one import mistake that CANNOT be caught by running the code locally. | test:all |
| `everyone-campaigns.test.ts` | The welcome sequence is just another email campaign (2026-10-07). It used to be special: one per org, and saving a chat/planner campaign for "everyone who subscribes" REPLACED its emails. Now any number may exist, only ONE may be on, and nothing is ever… | test:all |
| `explainers-coverage.test.ts` | The Be More Swan "i" explainers (explainers.js) — every icon the UI asks for must exist. | test:all |
| `facebook-insights-page-token.test.ts` | Two invariants in ingest-facebook-insights.ts, both of which failed silently in production and neither of which any behavioural test can reach (every path is a live Graph call). | test:all |
| `facebook-insights.test.ts` | The one piece of ingest-facebook-insights.ts that is pure logic rather than a Graph call, and the one that decides whether `facebook_link_clicks` means what it says. | test:all |
| `fair-use.test.ts` | Chat messages and editing helpers cost no tasks under the single task allowance — only a daily fair-use count (src/utils/fair-use.ts, docs/task-metering.md). Two things must hold everywhere: • every such model call is still metered (meterInteraction or… | test:all |
| `first-draft-on-hire.test.ts` | Two failures that both present as "I hired an assistant and it does nothing". | test:all |
| `follow-up-plan.test.ts` | The Lead Generator's editable follow-up plan — docs/lead-outreach-restructure-plan.md, Phase 3. | test:all |
| `follower-refresh.test.ts` | The two pieces of the Audience follower-count pipeline that are pure logic rather than a platform call: which workspaces the background cron sweeps (refresh-follower-counts.ts) and what each platform's response means (src/utils/follower-counts.ts). | test:all |
| `format-router.test.ts` | Deriving a post's format from its media (src/utils/format-router.ts). | test:all |
| `free-trial.test.ts` | The free 14-day trial, no card (src/utils/trial.ts). Owner decisions 2026-10-17: it starts when a new workspace's owner verifies their email; it is the Busywork Buster's features with 150 tasks; when it ends, assistants pause and scheduled work is held —… | test:all |
| `generation-failure.test.ts` | "A post couldn't be written": the reason in plain words (generation-failure.ts), where the notification leads (the assistant's Activity tab, not the media library), and "Try again" (retry-generation.ts). Reported 2026-10-15: "View content" opened My… | test:all |
| `go-live-fixes.test.ts` | "Fix" and "Suggest" beside each failing go-live check on Admin ▸ Assistants (2026-10-10). Fix = a rule-based correction; Suggest = a draft the admin edits and Applies; nothing is written without Apply, and Apply goes through applyFix's validation — never a… | test:all |
| `graph-error-classification.test.ts` | goal-metric-selftest.ts decides which goal metrics are honestly offerable. This is the function that turns a Graph API failure into that verdict. | test:all |
| `growth-funnel.test.ts` | counter, the sign-up's source, and Admin → Analytics → Growth funnel. | test:all |
| `gsc-decay.test.ts` | Locks the pure maths for the GSC content-decay loop (US 5.1): date-window offset, property matching (URL-prefix vs sc-domain), and the peak-relative decay rule. No network or DB. | test:all |
| `hire-new-assistant-flow.test.ts` | "Hire a New Assistant": the set-up wizard stays out of the way until a role is picked, the catalogue puts what can be hired first and shows hired roles as hired, and the server keeps one assistant per role on every hire path. | test:all |
| `hooks-and-cta.test.ts` | Hooks everywhere + a call-to-action setting (owner, 2026-10-24): one shared list of openings for social posts, articles, emails and cold outreach; and each Social, Blog or Email assistant's call to action can be its own words, the workspace's intro offer,… | test:all |
| `icp-snapshot.test.ts` | The ICP half of the revenue ledger's attribution key (§7.2, docs/strategy-agent-plan.md §0.2). | test:all |
| `image-to-video.test.ts` | Image-to-video (Video Producer plan, Phase 1) — src/lib/fal-gateway.ts + the call sites. | test:all |
| `instagram-retry-classification.test.ts` | Which Instagram publishing failures are worth another attempt. | test:all |
| `integration-coming-soon.test.ts` | "Connects with" entries ending "(coming soon)" render as a muted Coming soon chip (2026-10-10): the Marketing Campaign Orchestrator announces Meta / Google / LinkedIn ads before any connector exists, without its card reading as something a customer can… | test:all |
| `integration-health-check-schedule.test.ts` | integration-health-check.ts sends the "connection expires in N days" and "disconnected" alerts. Its header said "Scheduled daily at 08:30 UTC" for months while netlify.toml had no entry for it, so it never ran, and LinkedIn connections died at 60 days… | test:all |
| `intro-offer.test.ts` | "Do you offer a free trial or an introductory offer?" — one workspace answer on Business Information ▸ Products & Services that every assistant uses (owner, 2026-10-24). | test:all |
| `issue-merge-reclaim.test.ts` | "Merge to staging" is a handshake: the runner claims the merge (queued → merging) and later POSTs the result. A runner that dies in between used to strand the issue in 'merging' forever, with request-merge 409ing every retry. These pin the self-heal: stale… | test:all |
| `job-claim-is-atomic.test.ts` | Two content workers drain content_generation_jobs. Both SELECT with FOR UPDATE SKIP LOCKED — and both issue that SELECT as a STANDALONE statement, so postgres-js autocommits and the row locks are released before the first job is processed. SKIP LOCKED… | test:all |
| `job-generates-once.test.ts` | Winning the claim says nobody else is running this job RIGHT NOW. It does not say the job has never run before — and process-content-jobs re-queues itself on any throw, from a whole try block that contains the post INSERT. So an attempt that died after… | test:all |
| `layout-ir.test.ts` | The layout IR: what the assistant returns when it designs, and the two things we compile it into. | test:all |
| `live-social-connections.test.ts` | "Is this org connected to platform X?" must span BOTH credential stores. | test:all |
| `login-events.test.ts` | login_events records every sign-in, and recording one can never block it. See db/z-login-events.sql and src/utils/login-events.ts. | test:all |
| `mandate-segment-swan-link.test.ts` | Three user asks from 2026-10-06, each a quiet regression if undone: · every assistant's setup asks its Mandate and saves it where Profile ▸ Mandate reads it (onboardingContext.problem_statement) — only the Social Media wizard used to ask it · the email's… | test:all |
| `markdown-editor-blocks.test.ts` | Blog Media Composition — locks the editor's DOCUMENT MODEL: how a draft's Markdown becomes blocks, and what the editor writes back into it (plan §3.1, §3.6, §4 Phases 3–4). | test:all |
| `media-failure-evidence.test.ts` | The SQL behind "AI images/videos are failing across workspaces" (check-provider-balances.ts, readMediaFailureEvidence), run against REAL Postgres — Brand Designer plan, Phase 0. | CI Postgres |
| `media-never-dropped.test.ts` | A post that HAS media must never publish without it and be recorded as a success. | test:all |
| `memory-query.test.ts` | Phase 3 §5.5 — the account-graph query endpoint, and the panel that used to front it. | test:all |
| `model-json-preamble.test.ts` | A model that narrates before it answers must not cost us the answer. | test:all |
| `model-json.test.ts` | Locks the model-reply JSON extraction that feeds post captions. The regression this guards: a ```json-fenced or truncated reply used to fail JSON.parse and get persisted verbatim, so the dashboard's "Requires your attention" cards showed `` ```json {… | test:all |
| `monitor-heartbeat.test.ts` | The watchdog over the monitors: src/utils/monitor-heartbeat.ts + platform-watchdog.ts + .github/workflows/prod-watchdog.yml. | test:all |
| `my-content-status.test.ts` | My Content classifies an asset from the posts that USE it, by the same rule the Calendar reads. | test:all |
| `mystery-shopper-wiring.test.ts` | The Mystery Shopper as a hired assistant (docs/mystery-shopper-plan.md step 3): every registry it must be in, the names the chat quotes against the page that shows them, the set-up ↔ audit bridge, and the GUI/chat parity — each chat card is handled, and… | test:all |
| `naming-spinner-role-titles.test.ts` | Reported 2026-10-02: (1) only the Social Media wizard asked the user to name their assistant; (2/3) "busy" was a mouse cursor, not the pink spinner; (4/5) the detail page's name and swan didn't look clickable; (6) the Brand Protected pill; (8) chat called… | test:all |
| `nav-fit.test.ts` | The public nav (2026-10-27): it ran off the page from 1024px up to ~1060px in English and ~1460px in Spanish, and nine pages never loaded mobileMenu.js, so their hamburger did nothing. | test:all |
| `near-duplicate.test.ts` | The gate that verifies a generated caption is actually new. | test:all |
| `new-post-platform-defaults.test.ts` | A new post should target every connected account by default. | test:all |
| `offer-profile.test.ts` | "What does your business offer?" — Business Information shows booking and food fields only to the businesses that need them (owner, 2026-10-20: a SaaS was asked for allergens and a deposit). | test:all |
| `one-post-per-slot.test.ts` | A scheduled slot gets ONE post, however many jobs were queued for it. | test:all |
| `operational-setup.test.ts` | The onboarding wizard's Operational Setup answers must reach the generation prompt as DIRECTIVES, not just as part of the verbatim blueprint dump. | test:all |
| `opt-out-handling.test.ts` | "Stop emailing me" in a reply must actually stop the emails. | test:all |
| `optimiser-health.test.ts` | The uptime check on the paid-campaign sweep — the one guard the sweep cannot provide for itself. | test:all |
| `orchestration-fire.test.ts` | Phase 5 — orchestration runtime. Locks the JS control flow of fireOrchestrations(): per-link enqueue, idempotency skip, triggerType tagging, and the no-blueprint path. (SQL-level link filtering and the caller-side loop guard are verified on staging.) | test:all |
| `owner-fixes-2026-10-23.test.ts` | The owner's list of 2026-10-23: blog categories that multiplied, a blog title printed twice on LinkedIn, "\| Welcome" beside the logo on the home page, the value hero above the team roster, article cards on the Review page that looked unlike post cards,… | test:all |
| `page-width.test.ts` | One page width across the workspace (owner, 2026-10-23): every routed page's outer wrapper is `.page-wide` — 1360px, centred, 16px sides on a phone and 24px from sm up — the same box as Blog Studio's full page. Before this there were eight widths (672px to… | test:all |
| `paid-optimiser-cron.test.ts` | The daily sweep over live paid campaigns — the file that finally CALLS the kill switch. | test:all |
| `posting-cadence.test.ts` | Locks postsPerWeekFor() — the parser the periodic conversion-post scheduler relies on to turn a stored posting_frequency (canonical label/key OR legacy free text) into posts-per-week. | test:all |
| `prod-review-fixes-2026-10-27.test.ts` | Four prod reports from one review session on an iPad, 2026-10-27. No network or DB. | test:all |
| `products-and-team-awareness.test.ts` | 2026-10-09: (1) a business records its Products & Services once, on Business Information, and EVERY assistant reads them; (2) every assistant's chat knows what its teammates did and what is booked to go out, read per turn from the workspace's records. | test:all |
| `products-one-place.test.ts` | Products and prices live in ONE place — Business Information ▸ Products & Services (owner, 2026-10-21). The Creative Brief and the social onboarding form used to keep their own free-text box (service_offerings), which drifted: £99 there, £69 in the… | test:all |
| `promote-ci-gate.test.ts` | The "Push to prod" lane (scripts/dev-issue-fixer.mjs processPromote) promotes through a PR and merges only when CI passes: scripts/promote-ci-verdict.mjs decides. | test:all |
| `prospect-erasure.test.ts` | "Delete everything you hold about me" — from someone who never signed up. | test:all |
| `provider-balances.test.ts` | The AI-provider balance alert — src/utils/provider-balance.ts + check-provider-balances.ts. | test:all |
| `publish-failure-diagnostics.test.ts` | The three things that made a live Threads outage undiagnosable, pinned so they cannot regress. | test:all |
| `push-notifications.test.ts` | Web Push as the third notification channel. | test:all |
| `quality-review-failure-paths.test.ts` | Two ways a failed quality review used to take a post's decisions down with it (prod, 2026-10-08): 1. the reviewer fenced its JSON (```json … ```) and a bare JSON.parse turned a good verdict into a 502 — src/utils/post-quality-review.ts must use… | test:all |
| `quality-reviewer-copy.test.ts` | The `quality_reviewer` plan feature is called The Quality Reviewer everywhere we sell it (owner, 2026-10-27). | test:all |
| `quick-rewrites-in-place.test.ts` | Step 1's quick rewrites (tone / hashtags / grammar) must edit the post IN PLACE. | test:all |
| `raw-sql-date-params.test.ts` | A JS Date must never be interpolated into a db.execute(sql`...`) template on postgres-js. | test:all |
| `rbac-matrix.test.ts` | src/utils/rbac.ts is the single source of truth for admin authorisation. It earned that role by replacing four parallel schemes that had silently drifted apart: rank-based checks in some functions, hand-rolled ALLOWED_ROLES arrays in others, bare `role ===… | test:all |
| `records-rejection-learning.test.ts` | Tier 1 Support, Meeting Note Taker and the AR Clerk learn from a rejection: reject (assistants.js, optional note) → assistant-records.ts PATCH `feedback` → content_rules row (origin 'rejection_feedback') → chat-orchestrator.ts reads it every turn via… | test:all |
| `referral-offer.test.ts` | A referred friend gets their first month free, and the referrer earns a token only once that friend has actually paid. | test:all |
| `refresh-lands-on-last-view.test.ts` | A refresh must reopen the page you were on — or the Dashboard when nothing is remembered — in both the admin portal and the workspace (user report 2026-10-06: the admin portal always reopened on Bias Audit). The admin cause: the quarterly bias email links… | test:all |
| `register-keeps-session.test.ts` | register.html clears local auth state on load, and aura_session is readable by page script — so an unconditional clear logged out ANYONE who merely opened /register (an existing customer on a "Get Started" link, a beta tester's sign-up link in a logged-in… | test:all |
| `reject-regeneration.test.ts` | Rejecting a post must actually produce a revised one — and it must land somewhere a human can see. | test:all |
| `remotion-bundle-drift.test.ts` | Warns — never fails — when a deployed Remotion site is not running these composition sources. | test:all |
| `remotion-concurrency.test.ts` | How a render is sized against the AWS Lambda concurrency quota (src/lib/remotion-lambda.ts). | test:all |
| `rendered-video-publishability.test.ts` | What happens to a post AFTER a render turns it into a video. | test:all |
| `request-meta-tester.test.ts` | The "add me as a Meta Tester" request: netlify/functions/request-meta-tester.ts + the pre-connect modal in integrations.js / assistant-detail.html. | test:all |
| `requested-by-knowledge-resize.test.ts` | Three changes from one request (owner, 2026-10-23): 1. "Requested by [assistant]" — a second pill beside "Created by" on every card whose work another assistant asked for (src/utils/requested-by.ts). 2. Brand Knowledge actually reaching drafts: blueprints… | test:all |
| `resubscribe-restores-assistants.test.ts` | Found on staging, workspace 58, 2026-10-25: a customer who cancelled and later bought a new plan 1. was told "Your subscription has ended" at every login (login read the OLDEST plan row), and 2. kept every assistant paused on the active plan (nothing… | test:all |
| `resume-capacity.test.ts` | Resuming a paused assistant must not take a seat the plan does not have. | test:all |
| `revenue-ledger.test.ts` | Phase 0 of docs/lead-generator-revenue-engine-plan.md — the revenue ledger. | test:all |
| `reviews.test.ts` | Business Information ▸ Reviews and the website's reviews section: the customers' words kept word for word, an average that hiding can't improve, and a section that quotes only what is recorded. src/utils/reviews.ts, org-reviews.ts, site-render.ts. | test:all |
| `rls-enforcement.test.ts` | US-DB-1.4.1: proves Row-Level Security actually isolates tenants at the database layer for the crown-jewel table ai_assistants — independent of any application WHERE. | CI Postgres |
| `roi-period.test.ts` | ROI reporting window — roi-stats.ts (dashboard) and get-assistant-metrics.ts (assistant detail Impact & ROI) must aggregate over identical date ranges. Locks the shared helper's behaviour, including the month-boundary case where the calendar week reaches… | test:all |
| `role-swap-limit.test.ts` | Capped plans may switch to a different assistant role once per billing month. | test:all |
| `run-insights-ingest-guard.test.ts` | The staging insights trigger is the only cron wrapper that spends money on every call — it issues a paid Graph API request per published post. Its auth guard is therefore the only thing standing between the open internet and an unbounded API bill, so it… | test:all |
| `safe-fetch.test.ts` | SSRF guards for user-supplied URLs (src/utils/safe-fetch.ts). | test:all |
| `schedule-confirmation-time.test.ts` | The confirmation must name the time the post is ACTUALLY going out. | test:all |
| `schedule-visibility.test.ts` | A draft's publish_date is a PROPOSAL; only pressing Schedule makes it an appointment. | test:all |
| `seed-connection.test.ts` | Which database a seed script writes to — and the fallback that used to answer "production". | test:all |
| `sending-domain-check.test.ts` | checkSendingDomain used to POST /verify and then GET immediately. A verify request resets the domain to 'pending' at Resend while it re-checks (~45s), so the read ALWAYS said pending — the Check DNS button could never report a domain as verified, even one… | test:all |
| `seo-reviews.test.ts` | Job 9 of scripts/build-seo-html.mjs: published reviews of Be More Swan on the home and pricing pages (scripts/seo/reviews.mjs, get-reviews.ts). Nothing until three; newest first, never by stars; the visible average equals the marked-up one; every quote… | test:all |
| `signal-inbox.test.ts` | Phase 1a of docs/lead-generator-revenue-engine-plan.md — the Signal Inbox. | test:all |
| `special-category-rule.test.ts` | The special-category refusal is in every prompt an assistant actually runs (2026-10-10). The go-live check passes for a built role BECAUSE of this test — if a seam stops carrying the rule, this fails rather than the Assistants page silently reporting a… | test:all |
| `staging-loose-ends-2026-10-31.test.ts` | Three things found testing the Campaign Assistant, Brand Designer and Video Producer on staging (2026-10-31), each pinned so it can't come back: · the Brand Designer quoted "AI credits" while the workspace is charged tasks · a campaign said "Nothing needed… | test:all |
| `still-motion.test.ts` | Slow movement on stills (Video Producer plan, Phase 4) — src/lib/still-motion.ts, the job input, the worker, the weekly Short and the composition. | test:all |
| `storage-tenant-isolation.test.ts` | US-STOR-1.1.1 AC12 / AC13: Tenant-isolation integration test. | test:all |
| `stored-ips-truncated.test.ts` | The privacy policy (privacy.html) promises IP addresses are truncated before they are stored. Every writer of an agreement or sign-in IP must run it through pseudonymiseIp first. (2026-10-20: accept-tos and accept-dpa stored the full address.) | test:all |
| `storyboard.test.ts` | The Video Producer's storyboard rules (src/lib/storyboard.ts) — every rule the plan lists is enforced in code; this proves each one holds whatever the model returns. | test:all |
| `strategy-agent.test.ts` | Phase 5a slice 2 — the weekly Strategy Agent run (the edit-pattern proposer + expiry sweep). Design: docs/lead-generator-revenue-engine-plan.md §7, docs/strategy-agent-plan.md §4-§5. | test:all |
| `strategy-proposals.test.ts` | Phase 5a of docs/lead-generator-revenue-engine-plan.md §7 — the Strategy Agent's proposal store. | test:all |
| `strict-rules-rows.test.ts` | Strict Rules on the assistant profile are entered one row per rule with an "Add Rule" button, the same way Assistant Rules are — not a textarea that asked the user to start every line with a dash (2026-10-09). Storage is unchanged:… | test:all |
| `subscription-cancel-state.test.ts` | A plan's 'cancelling' status follows Stripe's cancel flag, both ways. | test:all |
| `support-inbox.test.ts` | Admin ▸ Customers ▸ Inbox (2026-10-18): tickets, reported problems and enquiries in one list, each answering "who is it waiting on?" the same way; re-routing between the helpdesk and the fix pipeline; and the panels those rows open, which used to be dead… | test:all |
| `task-metering-db.test.ts` | The single task allowance's money SQL, on REAL Postgres — src/utils/work-metering.ts recordCompletedWork / hasTaskCapacity / grantBonusTasks (docs/task-metering.md). | CI Postgres |
| `task-weights.test.ts` | The single task allowance (docs/task-metering.md): what each finished piece of work costs, and how a pre-cutover credit amount converts. These numbers are what customers are charged — the pricing page, FAQ, terms and help article quote them, so a silent… | test:all |
| `team-chat-replies.test.ts` | A note sent on the Team page gets a REAL reply: a chat turn on that note, in the assistant's newest conversation, written back under the note — with any card shown in place and working. | test:all |
| `team-feed.test.ts` | The Team feed (docs/campaign-orchestrator-flow.md §4) and a campaign's effect on usual posting. Owner, 2026-10-14: assistants and the person tell each other things and ask questions; it lives in the side menu; the bell counts it; and a campaign can make… | test:all |
| `template-feedback.test.ts` | Plan §2.6 (the ⭐ option) — human edits to a drafted message become evidence. | test:all |
| `tenant-api.test.ts` | The tenant-facing API: a shop, a booking system or a Zapier step writing into their own audience. | test:all |
| `tenant-guard.test.ts` | US-DB-1.3.1: Unit tests for the session + tenant guard utilities. | test:all |
| `text-safe.test.ts` | A half-emoji in a prompt made every social draft fail on prod (2026-10-14): Anthropic answered "The request body is not valid JSON: unexpected end of hex escape". See src/utils/text-safe.ts. | test:all |
| `text-search.test.ts` | Full-text fallbacks must match ANY term, never all of them. | test:all |
| `token-refresh-classification.test.ts` | A provider being briefly unavailable must never condemn a working connection. | test:all |
| `token-refresh-single-flight.test.ts` | Concurrency guard for OAuth token refresh (src/utils/single-flight.ts, used by src/utils/workspace-integrations.ts → getFreshAccessToken). | test:all |
| `troubleshoot-advice-memo.test.ts` | The Connections card for a social account with failing setup checks shows one paragraph of advice written by Claude Haiku (social-troubleshoot-chat). It is requested from the card RENDERER, and the grid is drawn on every assistant-page visit — twice per… | test:all |
| `upload-mime.test.ts` | What content-upload-url will and will not accept. | test:all |
| `user-deletion-sole-org.test.ts` | Deleting a user must not leave their empty workspace behind — and must never take a shared or still-billing one with it. | test:all |
| `visual-briefs-db.test.ts` | The Brand Designer's money SQL, on REAL Postgres — src/utils/visual-briefs.ts endRound and sweepStuckRounds. Brand Designer plan, Phase 1. | CI Postgres |
| `voice-and-shapes.test.ts` | Tone settings must produce AUDIBLY different writing, and posts/articles must not share one structure (user report, 2026-10-06). What could quietly regress: · a generator going back to "in a ${tone} tone" — one undefined adjective, every tone the same · a… | test:all |
| `voiceover.test.ts` | Customer voiceovers (Video Producer plan, Phase 2) — src/lib/tts.ts, generate-voiceover.ts, the voiceover credit/task kind, and the post editor panel. | test:all |
| `webhook-verify.test.ts` | Inbound webhook signature verification (src/utils/webhook-verify.ts). | test:all |
| `webhooks.test.ts` | Outbound webhooks — the feature that was deliberately deferred twice, and why it is safe now. | test:all |
| `website-activity.test.ts` | The Website Assistant's Activity tab (src/utils/role-activity.ts websiteItems): its own work and what visitors sent — not the social feed's posts and ideas. Run: npx tsx tests/website-activity.test.ts | test:all |
| `website-assistant.test.ts` | The Website Assistant, step 2 (docs/website-assistant-plan.md): the starter site and the AI draft (src/utils/site-draft.ts), and its wiring as a hired role — registries, the Website tab, the chat cards, the API's guards and the preview's lock-down. | test:all |
| `weekly-digest.test.ts` | The weekly digest (netlify/functions/weekly-digest.ts) has never run in production. Its first version would have emailed only the plan's purchaser, counted different numbers from the dashboard it links to, and compared a raw task_runs count against the… | test:all |
| `work-metering.test.ts` | Background work counts against the monthly task allowance (src/utils/work-metering.ts). | test:all |
| `workspace-review-fixes.test.ts` | Small fixes from the 2026-10-22 UI/UX review of Dashboard, My Assistants and Audience: a dead "Set rate" link, a hire button missing on phones, a Dashboard poll that outlived the page, unescaped assistant names on the card, and an Audience list held behind… | test:all |
| `workspace-roles-take-no-seat.test.ts` | The Business Mentor is included on every plan and never takes a plan seat (docs/business-mentor-plan.md §2.3). The assistant limit is counted in several places, and one that forgets the exclusion either refuses a customer's hire ("you've used all your… | test:all |
| `youtube-resumable-upload.test.ts` | Chunked resumable upload for YouTube (src/utils/social-publish.ts). | test:all |
| `youtube-short-drafting.test.ts` | The weekly YouTube Short: a brand card, rendered to a 10s 9:16 mp4, reviewed by a human. | test:all |
