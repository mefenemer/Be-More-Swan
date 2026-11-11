# Content pillars as records: plan

Status: phase 1 built 2026-11-08 to the §2 recommendations (branch feat/pillar-records). db/z-content-pillars.sql applied on staging only; backfill not yet applied. Phases 2 and 3 not started.

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

**Phase 3 (optional, owner's call): Blog and Email topics**
11. The same table with a `kind` column (`pillar` / `topic`), or a decision to leave topics as text.

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
