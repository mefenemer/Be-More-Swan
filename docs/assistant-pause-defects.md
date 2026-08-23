# Two defects in the assistant pause system

Found 2026-08-23 while testing the Lead Generator on staging. Neither is related to that work —
both were pre-existing, and both were only visible because a paused assistant happened to be the
one under test. Written up because each is easy to lose and hard to rediscover.

**Both fixed 2026-08-23**, in the same session that found them. The report below is kept as written
— the evidence is what makes the fixes checkable — with the resolution recorded under each.
Guarded by `tests/assistant-pause-defects.test.ts`.

---

## 1. `paused_limit` has no self-service release

**Severity: high.** A paying customer who does the obvious thing to comply with their plan stays
paused, with no route out except a billing change.

### What happens

`provisioningStatus = 'paused_limit'` means "a plan downgrade left more assistants than the tier
allows". It is written in exactly one place — [`stripe-webhook.ts`](../netlify/functions/stripe-webhook.ts),
in the downgrade handler, which pauses the oldest excess assistants:

```ts
await db.update(aiAssistants)
    .set({ isActive: false, provisioningStatus: 'paused_limit', updatedAt: new Date() })
    .where(and(eq(aiAssistants.userId, userId), inArray(aiAssistants.id, pauseIds)));
```

**Nothing re-evaluates that flag when the over-limit condition stops being true.** The two adjacent
recovery paths both explicitly exclude it:

| Path | Resumes | Note |
| --- | --- | --- |
| `stripe-webhook.ts` (payment restored) | `paused_payment` only | filtered in the `where` clause |
| `resume-quota-paused.ts` (allowance reset) | `paused_quota` only | *"paused_payment / paused_limit are other systems' pauses and are likewise untouched"* |

So a user who is 4-over-3 and archives an assistant to comply is now 3-of-3 — within their plan —
and still has a paused assistant. Nothing counts again.

### Observed

Staging org 58 (Marmalade Productions), plan **The Busywork Buster**, `assistant_limit = 3`,
`bonus_assistants = 0`, four active assistants. Three carried `paused_limit`.

The user archived one at `06:47:47`. The paused assistant's `updated_at` stayed at
`2026-08-19 15:41:21` — untouched. It took a manual `UPDATE` to release it.

### The partial workaround, and why it is not a fix

[`manage-assistant.ts`](../netlify/functions/manage-assistant.ts) has a **reinstate** path that
checks capacity and then clears the status:

```ts
if (occupied >= assistantLimit) return 409 CAPACITY;
…
.set({ provisioningStatus: 'complete', archivedAt: null, scheduledDeletionAt: null, … })
```

That is exactly the re-evaluation `paused_limit` needs — but it only applies to an **archived**
assistant being brought back. A `paused_limit` assistant is not archived, so it cannot reach it.
The only self-service route is to archive the paused assistant and then reinstate it, which means
archiving something you want to keep in order to un-pause it.

### Fixed

`src/utils/release-paused-limit.ts` — resumes `paused_limit` assistants up to whatever the plan now
allows, called from the two events that can resolve the condition: **archiving** an assistant
(`manage-assistant.ts`) and a **plan change** that makes room (`stripe-webhook.ts`).

Resolves the limit through the same `effectiveLimit` + `bonusAssistants` path the capacity gate
uses, so one surface cannot hand back a seat the other refuses. Resumes newest-first, the exact
inverse of the downgrade handler. Never throws — an archive must not fail because a courtesy resume
did not.

⚠️ Still not notified: the pause raises `assistants_paused_downgrade`, and the release is silent.
Worth a template, and left out here rather than invented.

⚠️ Whatever does this must resume **only** `paused_limit`, and must not touch `paused_payment`,
`paused_quota`, or an assistant the user switched off themselves (`complete` + `isActive: false`).
That separation is why the statuses are distinct and is worth preserving.

---

## 2. A `system_paused` assistant still spends money on discovery

**Severity: medium.** Not data loss, but a paused customer's account incurring third-party cost is
the wrong side of a billing gate.

### What happens

[`process-discovery-jobs.ts`](../netlify/functions/process-discovery-jobs.ts) — the worker that
runs paid web searches and model calls — contains **no reference at all** to `lifecycleStatus`,
`isActive`, `system_paused` or `archivedAt`. It resolves a job to its campaign and runs it.

The pause writes `isActive: false`. Nothing in the discovery path reads it.

### Observed

Staging assistant 21 ("Ember"), `lifecycle_status = system_paused`, `provisioning_status =
paused_limit` since 2026-08-19, ran discovery job 12 on 2026-08-23 at 06:14–06:21:

| | |
| --- | --- |
| Search calls | 8 (billable, Serper) |
| Model calls | scoring + query generation |
| Cost | £0.008 |
| Leads banked | 50 |

Meanwhile the assistant's own dashboard showed *"This assistant is paused because your plan's
assistant limit was exceeded"* and refused to start work from the UI. The pause gates the
kick-off card; it does not gate the worker.

### The inconsistency is inside one feature

[`lead-enrichment-sweep.ts`](../netlify/functions/lead-enrichment-sweep.ts) — the *other* money
spender in the same subsystem — gates properly, and explains why:

```ts
// Archived or deactivated assistants are not working, and spending their owner's money
// to refresh leads nobody is looking at is the definition of waste.
eq(aiAssistants.isActive, true),
sql`${aiAssistants.archivedAt} IS NULL`,
```

That reasoning applies verbatim to discovery, which spends more per run. One of the two paths has
the gate and the other does not.

### Fixed

The same predicate now runs in `process-discovery-jobs.ts`, immediately after the campaign loads and
**before** query generation, search or scoring — gating the first slice rather than the second.

Both decisions went the way the report argued:

- **Skipped, not failed.** The job returns to the queue with a 15-minute `nextRetryAt` and a
  readable `errorMessage` ("Paused — this assistant is not active, so the search is waiting rather
  than spending"). Failing would kill a run the user can resume in one click, and a failed job is
  not resumable.
- **Checked per tick**, so a pause stops a run already in flight. The backoff is what keeps that
  cheap: a pause lasting weeks costs one indexed query an hour, not one per drain tick.

⚠️ The consequence the report predicted still stands: a run stopped this way is partial, and Tier 1
has no `paused` stop reason, so the campaign card says nothing about why it went quiet. The job's
`errorMessage` carries it; the card does not read that field.

---

## Where the two meet

Together they compound: an assistant paused for exceeding a plan limit cannot be released by the
user, **and** keeps spending money on searches while paused. A customer in that state sees a
product that has stopped working and a bill that has not.
