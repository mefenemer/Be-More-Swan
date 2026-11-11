# Content pillars as records: plan

Status: phase 1 LIVE (on main by 2026-11-11; db/z-content-pillars.sql and the backfill applied on both DBs). Phase 2 built 2026-11-11: the Social chat's one-pillar card (`pillar_proposal`, src/utils/chat-pillar-card.ts), "Bring back" for archived pillars (profile + chat), Results ▸ Posts by pillar, and the help article db/z-content-pillars-help-2026-11-11.sql (not yet applied). Phase 3 (Blog/Email topics) not started.

Phase 2 choice: the Business Mentor keeps changing pillars through its set-up answer card (the whole list as text). The server reconciles that text to the records (keeping rows, descriptions and history, reviving archived names), so no Mentor pillar card was built. The Social chat's own set-up answers leave content_pillars out and refuse it.

⚠️ Learned on staging: the profile autosave must NOT send `content_pillars` (only when the AI wand or strategy fix wrote text into the hidden `#edit_pillars`). Sending the page's copy let a stale save reconcile the records back to an old list. Text answers now revive an archived pillar of the same name rather than creating a new one.

## 1. Where things are today

- **Pillars are one text box.** Social Media wizard (`onboarding-social-media.html`, `val_pillars`) and
  the profile (`assistant-detail.html`, `edit_pillars`). The profile splits the box with the shared
  splitter (`src/public/content-pillars.js`) and saves `onboarding_context.content_pillars` as an
  array of up to 5 names. The wizard saves the raw string. There is no id or description, and nothing to
  hold per-pillar settings.
- **Posts are tagged by name.** `scheduled_posts.pillar` is text. Balancing (least-used over 60 days, in
  `process-content-jobs.ts` and `autonomous-draft-brief.ts`) matches on the exact name, so **renaming a
  pillar resets its count to zero** and the old name's posts fall out of the count.
- **Chat replaces the whole answer.** The set-up card (`setup-field.ts`, `content_pillars`) rewrites the
  full text, so adding one pillar means the model retyping all the others. That is how the Mentor came
  to refuse on 2026-11-02.
- **Voice is one text box** (Social) or a radio option (Blog, Email). It is one description, not a list,
  so this plan leaves it alone.
- **Blog and Email have "Topics & themes"** (`blogTopics`, `newsletterTopics`), separated by commas.
  They have the same shape as pillars, but they are not pillars.

## 2. Decisions for the owner

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Which assistants? | **Social Media first.** Blog and Email topics move to the same records in phase 3, if wanted. | Social is the only assistant that balances posts across pillars. Topics are prompt text only. |
| 2 | Per assistant or per workspace? | **Per assistant.** | Two Social assistants (for example, a brand account and a founder account) need different pillars. The Mentor reads every assistant's pillars anyway. |
| 3 | What does a pillar hold? | **Name, an optional description of a sentence or two ("what goes under this"), order, and on/off.** No percentage share yet. | The description gives the post writer more than a two-word label. A share would replace "least used" balancing and is a separate decision. |
| 4 | Keep the 5-pillar cap? | **Yes, 5 switched on.** Switched-off pillars don't count. | Today's rule, and it keeps the calendar varied. Switching off keeps a pillar's history without drafting under it. |
| 5 | What happens to deleted pillars' posts? | **Pillars are archived, never deleted.** Posts keep their link to the pillar and their text tag. | Counts and the Results tab stay truthful. |

## 3. Storage

New table `content_pillars`:

```
id              serial primary key
organisation_id integer not null → organisations (cascade)
assistant_id    integer not null → ai_assistants (cascade)
name            text not null          -- ≤ 60 chars, unique per assistant among non-archived
description     text                   -- ≤ 300 chars
sort_order      integer not null default 0
is_active       boolean not null default true
archived_at     timestamp
created_at / updated_at
```

`scheduled_posts.pillar_id integer null → content_pillars (set null)`. Keep writing the text
`pillar` as well, for history and for every reader that shows it.

**The table is the source of truth. `onboarding_context.content_pillars` is DERIVED from it** (the
names of active pillars in order), written on every change by one function. This is the same pattern
as Form Builder's "definition is the truth" rule. The ten or so readers that only want names
(generate-profile-bio, relationship-checklist, goal-ai, social-auto-responder, Mentor surfaces,
redraft-upcoming, onboarding summary) then keep working untouched. They can move to the table later.

## 4. Build steps

**Phase 1: records and the profile (Social)**
1. SQL: `db/z-content-pillars.sql` (table, `pillar_id`, indexes). Apply on BOTH DBs before deploy.
2. Backfill script: for every Social assistant, `parsePillars(onboarding_context.content_pillars)`
   becomes rows. Then set `scheduled_posts.pillar_id` where `pillar` matches a name exactly. Posts tagged before
   2026-10-06 carry whole strings and stay unlinked, which is expected. Dry run on staging, then on
   Love Cat read-only, before prod.
3. `src/utils/content-pillars-store.ts`: list / add / update / reorder / archive, plus
   `syncDerivedPillars()` writing `onboarding_context.content_pillars`. One server action per change
   (`netlify/functions/content-pillars.ts`), with org and assistant checked.
4. Profile UI: replace the `edit_pillars` box with a list of pillar rows (name, description, on/off,
   drag to reorder, archive, "+ Add pillar"). Pillars save one at a time, not through the profile autosave.
   The 5-active cap is enforced on the server. The splitter's warnings (a pillar that reads like a sentence)
   move to the name field.
5. Wizard: keep the one box for speed of set-up. On finish, `onboarding.ts` splits it into rows
   (the same splitter) so new assistants start with records.
6. Drafting: `process-content-jobs.ts` and `autonomous-draft-brief.ts` read the rows, count by
   `pillar_id` (so renames keep their history), pass name and description to the model, and save both
   `pillar_id` and `pillar` on the post.
7. Redraft offer: a change to an active pillar's name or description, or adding, switching off or
   archiving one, triggers the existing redraft-upcoming panel.

**Phase 2: chat (GUI and chat parity)**
8. Social chat and Mentor: new cards `pillar_add`, `pillar_update`, `pillar_archive` (and reorder if
   cheap) calling the same server action. Remove `content_pillars` from the set-up field card's
   changeable list (move it to `SOCIAL_WIZARD_EXCLUDED`, with the reason). Chat prompts list pillars
   with their ids.
9. Results tab: posts per pillar over 30/60/90 days, by `pillar_id`.
10. Help article on pillars (SQL file applied on staging now, prod at release). Update the
   explainer `content-pillars` text.

**Phase 3 (optional, owner's call): Blog and Email topics** — planned in §7.

## 5. Tests

- Store: cap of 5 active, unique names, archive keeps posts linked, derived context matches rows.
- Backfill: splits like `parsePillars`, links exact names only, run twice gives no duplicates.
- Drafting: least-used counts by id survive a rename. An archived pillar is never picked. Description reaches
  the prompt.
- Chat: cards are proposed, never applied without a click. Set-up card no longer offers `content_pillars`.
- Source scan: the profile no longer has a free-text `edit_pillars`.

## 6. Risks

- **Two sources during rollout.** If the app deploys before the SQL, reads fall back to
  `onboarding_context`. Ship the backfill with the deploy, and keep the fallback for one release.
- **Peer sessions edit `assistants.js`.** Build in a worktree.
- **Prod help before prod app.** Apply the help SQL to prod only at release.

## 7. Phase 3 plan: Blog and Email topics as records (2026-11-11)

Status: **phase 3a LIVE-ready** (on staging; SQL + backfill on both DBs, 2026-11-11). **Phase 3b built
2026-11-11** (branch feat/topics-3b): the Blog and Email chats get the one-topic card (kept through their
uiElement rebuilds; their set-up answers leave the topics out and refuse them), Results ▸ Posts by topic /
Emails by topic over 90 days, and the help section db/z-content-topics-help-2026-11-11.sql (not applied).
Found on staging: the model quoted names inside its JSON reply and the whole reply was lost; prompt names
are now in curly quotes and model-json.ts escapes stray quotes as a last-resort parse.

### 7.1 Where things are today

- **Blog Writing Assistant:** `onboarding_context.blogTopics` is one text box ("Topics & themes",
  required at set-up, `assistant-onboarding-schemas.js`). After set-up it is edited in the settings'
  Operational Setup section (schema-driven, `edit_op_blogTopics`, saved by the profile autosave).
  Autopilot ideation (`src/utils/blog-topic-ideation.ts`) puts the whole text in the brief as "pick one
  of these". Nothing balances topics, and `blog_posts` records no topic, so one topic can win every time.
- **Email Marketing Assistant:** `onboarding_context.newsletterTopics`, the same kind of box. The
  autopilot (`draft-newsletter-issues.ts`) passes the WHOLE text as every issue's `topic`, so each email
  is about everything on the list. `newsletter_issues` records no topic either.
- **Chat:** both are ordinary set-up answers, changed by retyping the whole text on the set-up card
  (their own chats and the Mentor's).
- ⚠️ **Naming trap:** "pillar article" already means a long-form blog post in the Campaign
  Orchestrator (`draft_blog_pillar`, campaign-vocab.ts). So Blog and Email must say **Topics**, never
  "pillars", anywhere the customer reads.

### 7.2 Decisions for the owner

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Store topics in the same table? | **Yes: `content_pillars` rows on the Blog or Email assistant.** No `kind` column: the assistant's role says what the rows are. | One store, one endpoint, one list component, one chat card, all already proven. The table is per assistant, so nothing mixes. |
| 2 | What do customers call them? | **"Topics"** on Blog and Email; "Content pillars" stays on Social. | "Pillar article" means something else on the Blog (see 7.1). It is also the word they typed at set-up. |
| 3 | How many switched on? | **8 for Blog and Email** (5 stays for Social). | Blogs and newsletters cover more subjects than a feed, and post far less often, so 8 still rotates within a few months. |
| 4 | Blog: does each post get ONE topic? | **Yes, the least-used topic over 90 days**, the way Social works. A rejection's reason, a campaign brief or an Inspo subject still outranks it, as today. | Today one topic can win every post. 90 days, not 60, because a blog posts weekly at most. |
| 5 | Email: one topic per issue? | **A lead topic per issue (least used), with the others listed as "may also mention".** | A newsletter often rounds several things up. A lead topic stops every issue being about everything, without forcing single-subject emails. |
| 6 | Results per topic? | **Yes: "Posts by topic" / "Emails by topic"** in the same Autopilot card place. | Same reason as Social: the owner sees whether a topic is being skipped. |

### 7.3 Storage

- No new table. `db/z-content-topics.sql`: `blog_posts.pillar_id` and `newsletter_issues.pillar_id`
  (nullable, `REFERENCES content_pillars(id) ON DELETE SET NULL`), plus `blog_posts.pillar` and
  `newsletter_issues.pillar` text (the name, like `scheduled_posts.pillar`). Apply on BOTH DBs before
  deploy (the Drizzle schema lists the columns, so whole-row selects fail without them).
- The store's derived write becomes role-aware: Social writes `content_pillars` (an array, as now); Blog
  writes `blogTopics` and Email `newsletterTopics` as **comma-joined text**, because the wizard field and
  every reader treat them as text. One function decides the key and shape from the role:
  `derivedKeyFor(roleKey)`.
- The cap becomes role-aware: `maxActiveFor(roleKey)` (5 Social, 8 Blog/Email). The 60-character name
  limit stays.

### 7.4 Build steps

**Phase 3a: records, settings and drafting**
1. SQL above. Store: `derivedKeyFor`, `maxActiveFor`, used by add / update / restore / sync and the
   derived write. `content-pillars.ts` accepts `blog_writer` and `newsletter_editor` as well as Social.
2. Backfill script: the same, for Blog and Email assistants (their text through the shared splitter,
   capped at 8). Dry run first. No posts to link (nothing recorded a topic before).
3. Wizard finish (`onboarding.ts`, and whatever finishes the schema-driven wizards for Blog and Email)
   creates rows from the answer, as Social does.
4. Settings: the Operational Setup field for `blogTopics` / `newsletterTopics` is replaced by the same
   list component (`pillar-list.js`, with labels from the role: "Topics", "+ Add topic", "Archived
   topics"). ⚠️ **The phase 1 lesson applies:** the autosave must NOT send `blogTopics` /
   `newsletterTopics` from the page. The schema-driven collect writes every `data-onboarding-key` field
   back, so those two keys need the same "send only when the wand wrote text" rule, and
   `update-assistant-context.ts` must carry them across and reconcile a sent text answer to the rows
   (generalise the `content_pillars` branch to the role's derived key).
5. Blog drafting: `blog-topic-ideation.ts` picks the least-used active topic over 90 days (by
   `pillar_id`, then by name) for an undirected slot and writes "Write about this topic: … (what goes
   under it: …)". The chosen topic's id and name are saved on the `blog_posts` row.
6. Email drafting: `draft-newsletter-issues.ts` picks a lead topic the same way, passes it as `topic`
   with the other active topics as notes ("may also mention"), and saves it on the issue.

**Phase 3b: chat, Results, help**
7. Chat: the Blog and Email routes get the pillar card (`chat-pillar-card.ts`, worded "topic", their own
   cap). Their set-up answers leave `blogTopics` / `newsletterTopics` out and refuse them. ⚠️ The
   Email route REBUILDS its uiElement (unknown types become null), so `pillar_proposal` must be added
   to what it keeps, or the card never reaches the user. The Mentor keeps the set-up card (text,
   reconciled server-side).
8. Results: "Posts by topic" (Blog, `blog_posts`) and "Emails by topic" (Email, `newsletter_issues`),
   reusing `pillarUsageRows` with the table chosen by role, over 90 days.
9. Help: add a Blog/Email section to the pillars article, or a short "Topics" article. SQL on staging
   with the code, prod at release.

### 7.5 Tests

- Store: the derived key and shape per role (array for Social, text for Blog/Email); caps 5 vs 8.
- Autosave: the settings page leaves `blogTopics` / `newsletterTopics` out unless the wand wrote text.
- Blog ideation: one topic per undirected slot, least used first; guidance and Inspo still win; the
  topic is saved on the post.
- Email: a lead topic per issue, the others as notes; saved on the issue.
- Chat: Blog and Email routes draw the card ("topic" wording), the Email route keeps it, set-up
  answers omit the keys.
- Source scan: no "pillar" in customer-facing Blog/Email copy.

### 7.6 Risks

- **The clobber again.** The schema-driven autosave writes every answer field back. Missing step 4's
  rule would let a stale save archive topics, as happened on staging on 2026-11-08.
- **Email route drops unknown cards** (step 7).
- **Required at set-up.** `blogTopics` and `newsletterTopics` are required wizard fields; the wizard
  keeps its single box (fast set-up) and the rows are made at finish.
- **Peer sessions** edit `assistants.js` and `chat-orchestrator.ts`: build in a worktree.

### 7.7 Size

Phase 3a is about the size of phase 1 (SQL, store changes, settings list, two drafting paths, backfill).
Phase 3b is smaller than phase 2, because the card, the list and the usage rows already exist.

