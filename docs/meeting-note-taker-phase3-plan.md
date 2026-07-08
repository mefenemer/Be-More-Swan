# Meeting Note Taker — Phase 3 Implementation Plan (Jira / Asana task push)

Detailed build plan for Phase 3 of `docs/meeting-note-taker-plan.md`: turn approved
action items into real Jira / Asana tickets, one ticket per item, with per-task sync
state so partial syncs and retries are safe.

**Status:** PLAN ONLY — no code written yet. This doc + `db/action-items.sql` are for
review before the new infra lands. Nothing here has been applied to the DB.

**Exit criterion:** approving a meeting creates one Jira (or Asana) ticket per approved
action item, each row tracking `synced / failed / pending`, and the inbox shows
"5 of 8 synced".

---

## 0. What already exists (reused, not rebuilt)

- **Approval → scenario engine seam:** meeting approval → `MEETING_BOOKED` →
  `enqueueHandoffOnApproval` (assistant-records.ts) → `scenario_jobs` →
  `process-scenario-jobs.ts` → `runAction` → `ACTION_HANDLERS`. Phase 3 adds one handler
  (`create_tasks`) and two recipes; the queue/retry/audit machinery is untouched.
- **OAuth provider framework:** `src/utils/workspace-integrations.ts` (token vault,
  `getFreshAccessToken`, per-provider `refreshProviderToken`) + `oauth-integrations.ts`
  (connect `authUrl` + `callback` token-exchange, CSRF vault, `saveIntegration`). Adding a
  provider is a localized diff in these two files + env vars — see §3.
- **Child-table pattern:** `discovered_leads` FKs into `assistant_records` (cascade) — the
  exact shape `action_items` follows (see `db/action-items.sql`).
- **Tasks already flow to the engine:** `enqueueHandoffOnApproval` sets `fields.tasks`
  (from `data.tasks`), and `buildSummaryPayload` already forwards them to Slack/Notion. Phase
  3 reads the SAME tasks, but through the new normalized table so per-task state can persist.
- **DIY escape hatch:** `universal_webhook_meeting` (Tier 2) already POSTs tasks to any URL —
  users on unsupported trackers keep that. No change.

---

## 1. Data model — normalized `action_items` (Phase 0.2 decision)

One row per action item, child of the meeting `assistant_records` row. Materialized at
**approval time** (latest edited tasks), then synced by the handler. Kept separate from the
`assistant_records.data.tasks` JSON blob, which stays the render/edit source of truth; the
table is the *sync ledger*.

Columns (full DDL in `db/action-items.sql`):
- `id`, `organisation_id` (cascade), `ai_assistant_id` (cascade),
  `meeting_record_id` → `assistant_records(id)` cascade.
- `description`, `assignee` (text, may be "Unassigned"), `due_date` (text — echoed as the LLM
  produced it, e.g. "by Friday"; parsed to a date best-effort at sync time only).
- `sync_status`: `pending | synced | failed | skipped` (default `pending`).
- `provider`: `jira | asana | null` (null until synced; set on first sync attempt).
- `external_ticket_id`, `external_url`, `error_message`.
- `synced_at`, `created_at`, `updated_at`.
- Unique index on `(meeting_record_id, description)` → **idempotent materialization** (re-
  approving/editing upserts rather than duplicating); index on `(organisation_id, sync_status)`.

Drizzle mirror (add to `db/schema.ts` when building — shown here for review only):
```ts
export const actionItems = pgTable("action_items", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  meetingRecordId: integer("meeting_record_id").notNull().references(() => assistantRecords.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  assignee: text("assignee"),
  dueDate: text("due_date"),
  syncStatus: text("sync_status").notNull().default("pending"),
  provider: text("provider"),
  externalTicketId: text("external_ticket_id"),
  externalUrl: text("external_url"),
  errorMessage: text("error_message"),
  syncedAt: timestamp("synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("action_items_meeting_idx").on(t.meetingRecordId),
  index("action_items_org_status_idx").on(t.organisationId, t.syncStatus),
  uniqueIndex("action_items_meeting_desc_uidx").on(t.meetingRecordId, t.description),
  check("action_items_sync_status_check", sql`${t.syncStatus} IN ('pending','synced','failed','skipped')`),
]);
```

**Materialization point:** in `assistant-records.ts`, when a meeting record transitions into a
live state (the existing `handoffRecord` branch), upsert `action_items` from the latest
`data.tasks` BEFORE `enqueueHandoffOnApproval`. Best-effort + idempotent (same guard style as
the enqueue). This means the rows exist by the time the job runs.

---

## 2. Engine glue (`src/utils/scenario-engine.ts`)

- Add `TASK_ACTIONS = new Set(['create_tasks'])` and `buildTasksPayload(subject, mappings)`.
- Payload shape the handler consumes:
  `{ meetingRecordId: subject.recordId, projectKey?, issueType?, asanaProjectGid?, mapAssignees? }`
  — the recipient/target config comes from the active_scenario's stored `fieldMappings`
  (e.g. `fieldMappings.projectKey`, `fieldMappings.issueType`), NOT from the LLM. The tasks
  themselves are read from `action_items` by `meetingRecordId` inside the handler (not passed
  in the payload) so the handler always syncs the current DB state, and retries are exact.
- `buildActionPayload` dispatch: `if (TASK_ACTIONS.has(actionType)) return buildTasksPayload(...)`.

---

## 3. Providers — `jira`, `asana` (OAuth2)

Both are standard OAuth2 + refresh. Per-provider diffs:

**`src/utils/workspace-integrations.ts`**
- Add `'jira'`, `'asana'` to `IntegrationProvider` union, `INTEGRATION_PROVIDERS`, `PROVIDER_LABELS`.
- Add a `refreshProviderToken` block each:
  - Jira: `POST https://auth.atlassian.com/oauth/token` (`grant_type=refresh_token`,
    client id/secret, `refresh_token`). Atlassian rotates refresh tokens → persist the new one.
  - Asana: `POST https://app.asana.com/-/oauth_token` (same grant). Persist rotated refresh token.

**`netlify/functions/oauth-integrations.ts`**
- `SCOPES.jira = 'write:jira-work read:jira-work read:jira-user offline_access'`;
  `SCOPES.asana = 'default'` (Asana scopes are app-level; `offline_access`-equivalent is implicit).
- `authUrl` blocks:
  - Jira: `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=…&scope=…&redirect_uri=…&state=…&response_type=code&prompt=consent`.
  - Asana: `https://app.asana.com/-/oauth_authorize?client_id=…&redirect_uri=…&response_type=code&state=…&scope=…`.
- `callback` token-exchange blocks:
  - Jira: exchange code → then `GET https://api.atlassian.com/oauth/token/accessible-resources`
    to resolve the **cloudId** (like Xero's `/connections` step); store cloudId as `tenantId`,
    site name as `externalAccountName`. All API calls root at
    `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`.
  - Asana: exchange code → `data.workspace`/`GET /workspaces` for the default **workspace gid**;
    store as `tenantId`, workspace name as `externalAccountName`.
- Env vars (staging + prod): `JIRA_CLIENT_ID/SECRET`, `ASANA_CLIENT_ID/SECRET`.

**`db/seed-catalog.ts` PROVIDERS:** add
`{ providerKey: 'jira', displayName: 'Jira', category: 'pm', authType: 'oauth2', logoKey: 'jira' }`
and the Asana equivalent.

> ⚠️ Like the Threads/TikTok/YouTube handlers, the Jira/Asana API calls will follow the
> documented contracts but MUST be verified against live connected accounts before GA.

---

## 4. Action handler — `create_tasks` (`netlify/functions/sync-action.ts`)

`handleCreateTasks(db, userId, organisationId, payload)`:
1. Load `action_items` for `payload.meetingRecordId` where `sync_status IN ('pending','failed')`.
   If none → return 200 "nothing to sync" (idempotent no-op on re-run).
2. Resolve provider + token via `getFreshAccessToken(db, orgId, provider)`. The provider is
   derived from the recipe (Jira handler vs Asana handler — either one `create_tasks` handler
   that branches on a `payload.provider`, or two thin handlers `jira_create_tasks` /
   `asana_create_tasks`; **recommend two registry keys → one shared impl** for clean logs).
3. For each row, create ONE ticket:
   - Jira: `POST /rest/api/3/issue` `{ fields: { project: {key}, summary: description,
     description: <ADF>, issuetype: {name: issueType||'Task'}, duedate?: <parsed> } }`.
   - Asana: `POST /api/1.0/tasks` `{ data: { name: description, notes, projects:[gid],
     due_on?: <parsed>, workspace } }`.
   - On success: set `sync_status='synced'`, `external_ticket_id`, `external_url`,
     `provider`, `synced_at`. On failure: `sync_status='failed'`, `error_message` (row-level;
     the loop continues — one bad task never blocks the rest).
4. Return `{ success, synced, failed, total }`. Job-level: succeed if ≥1 synced and none left
   `pending`; surface partial failures in the job `error_message` for the logs tab. `logApiCall`
   once per ticket (endpoint path only, per SC6).

Register `jira_create_tasks` + `asana_create_tasks` in `ACTION_HANDLERS`.

---

## 5. Recipes (`db/seed-catalog.ts`)

```
jira_create_tasks   — providerKey 'jira',  tier 1, scenarioType 'meeting_handoff',
                      actionType 'jira_create_tasks',  when ['MEETING_BOOKED'],
                      fieldSchema: [ projectKey* → 'project', issueType → 'issuetype' ]
asana_create_tasks  — providerKey 'asana', tier 1, scenarioType 'meeting_handoff',
                      actionType 'asana_create_tasks', when ['MEETING_BOOKED'],
                      fieldSchema: [ asanaProjectGid* → 'project' ]
```
Both Tier-1 (require the provider connected — NOT connection-optional; a ticket needs a real
project). `fieldMappings` stores the target project/issue-type the user picks in the config
modal. Run `db:seed-catalog` to register (manual, per convention).

---

## 6. Inbox / card surfacing (per-task state)

- **Meeting card** (`disruptive-ui-registry.js` `renderActionItemAssignmentCard`): when the
  record carries synced action items, render a small per-task status pill (✓ synced / ⚠ failed)
  and a header count "5 of 8 synced". Data comes from `action_items` via a new lightweight read
  (extend the record fetch or `assistant-records.ts` GET to join the counts).
- **Review Queue ("Inbox")**: same count on the record row.
- No new approve/reject flow — sync is a consequence of approval, shown as status.

---

## 7. Build order (each independently shippable)

1. `db/action-items.sql` (this PR) + Drizzle mirror + materialization in `assistant-records.ts`.
   *Exit:* approving a meeting writes `action_items` rows (sync_status `pending`). No external calls yet.
2. Engine glue (`buildTasksPayload` + dispatch) + the shared `create_tasks` impl behind a
   feature flag, wired to `universal_webhook`-style dry-run logging. *Exit:* jobs resolve, rows
   flip to `skipped` (no provider) — proves the pipeline with zero OAuth.
3. Jira provider (OAuth + handler branch) + `jira_create_tasks` recipe. *Exit:* real Jira tickets.
4. Asana provider + `asana_create_tasks` recipe.
5. Inbox per-task status surfacing.

---

## 8. Open questions for review

1. **One handler or two?** Recommend two registry keys (`jira_create_tasks`,
   `asana_create_tasks`) sharing one impl — cleaner audit logs + per-provider recipe wiring.
2. **Assignee mapping.** Meeting assignees are free-text names ("Sarah"), not Jira/Asana
   account ids. Recommend v1: put the name in the description/notes and leave the ticket
   unassigned (safe, no brittle user-lookup). A name→account resolver is a fast-follow.
3. **Due-date parsing.** `due_date` is free text ("by Friday"). Recommend best-effort parse to
   ISO for `duedate`/`due_on`; on parse failure, omit the field (never guess a wrong date).
4. **Provider category key.** New `category: 'pm'` for the library grouping — confirm the UI
   groups unknown categories acceptably (it renders `providerCategory` as-is today).
```
