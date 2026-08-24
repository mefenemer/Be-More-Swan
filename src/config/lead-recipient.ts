// src/config/lead-recipient.ts
// Where a lead's outreach actually gets sent, whether it can be sent at all, and which of the two
// lead surfaces the lead is sitting on.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// The precedence `outreachDraft.to → contactEmail → lead.email` was written out by hand in two
// places that MUST agree, because one decides what the user is shown and the other decides where
// the mail goes:
//   • netlify/functions/lead-generation.ts (send_outreach) — the address actually used
//   • assistants.js `_rqRecipient` — the address printed above the Approve button
// A third copy was about to be added for the Review Queue's deliverability filter. Two hand copies
// of a rule this consequential is already one too many: if they ever disagree, the Review Queue
// shows one recipient and the send goes somewhere else, which is the worst class of bug this
// product can have — a real email to the wrong real stranger.
//
// ── Why a config module and not a util ───────────────────────────────────────
// The browser needs this too, and workspace.html is static and unbundled — it cannot import from
// src/. So this file is wired into scripts/gen-client-constants.ts and mirrored into
// src/generated/platform-constants.js as `window.LeadRecipient`. Generating the mirror is what
// makes the drift impossible; see the header of that script for the four bugs hand-copying caused.
//
// ⚠️ The functions below are emitted to the browser via `.toString()`, so they must stay
// self-contained: no imports, no closures over anything except the constants declared in this file
// (the generator re-declares those alongside them, matching the posting-cadence precedent).
//
// ⚠️ That constraint is also why the OUTREACH STAGE lives in this file rather than one of its own.
// `isInOutreachReview` needs both the stage and `isLeadDeliverable`, and an import between two
// config modules does not survive the mirror: esbuild rewrites the call to a bundler-local
// (`import_lead_recipient.isLeadDeliverable`) that does not exist in the browser, so the emitted
// copy throws on the first lead it is asked about. Same module, bare names, no rewrite.

/**
 * Recipient precedence for a lead, highest priority first, as jsonb paths into the record's `data`.
 *
 * Order is deliberate and load-bearing:
 *   1. `outreachDraft.to` — an address a human confirmed or edited on the draft itself wins.
 *   2. `contactEmail`     — what enrichment scraped, or what was typed into the Add-a-lead form.
 *   3. `lead.email`       — the shape a CSV import leaves behind.
 *
 * ⚠️ Changing this order changes who receives mail. It is mirrored into SQL by the `deliverable`
 * filter in netlify/functions/assistant-records.ts, which builds its COALESCE from THIS array —
 * so a new source added here reaches the filter, the UI and the sender together.
 */
export const LEAD_RECIPIENT_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
    ['outreachDraft', 'to'],
    ['contactEmail'],
    ['lead', 'email'],
];

/** Where the drafted body lives. Separate constant so SQL and JS cannot disagree about it either. */
export const LEAD_DRAFT_BODY_PATH: ReadonlyArray<string> = ['outreachDraft', 'body'];

/** Postgres `#>>` path literals, e.g. `{outreachDraft,to}`. Built from the arrays above, never typed out. */
export const LEAD_RECIPIENT_SQL_PATHS: ReadonlyArray<string> =
    LEAD_RECIPIENT_PATHS.map((p) => `{${p.join(',')}}`);

export const LEAD_DRAFT_BODY_SQL_PATH = `{${LEAD_DRAFT_BODY_PATH.join(',')}}`;

/**
 * The address a send would actually go to, or null if the lead cannot be reached.
 *
 * Trims, and treats a blank string as absent — an empty `to` on a draft must fall through to
 * `contactEmail` rather than resolving to '' and reading as "reachable".
 */
export function resolveLeadRecipient(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    for (const path of LEAD_RECIPIENT_PATHS) {
        let value: unknown = data;
        for (const key of path) {
            if (!value || typeof value !== 'object') { value = null; break; }
            value = (value as Record<string, unknown>)[key];
        }
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * Does this lead carry an outreach draft with something in it?
 *
 * The scorer writes `outreachDraft: null` for cold leads and for anything flagged `doNotContact`
 * (src/lib/discovery-scoring.ts), and CSV imports never get one — so a missing draft is a fact
 * about the LEAD, not a failure. A draft with an empty body is treated the same: there is nothing
 * for a reviewer to read.
 */
export function hasOutreachDraft(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const draft = (data as Record<string, unknown>).outreachDraft;
    if (!draft || typeof draft !== 'object') return false;
    const body = (draft as Record<string, unknown>).body;
    return typeof body === 'string' && body.trim().length > 0;
}

/**
 * Is there an email here for a human to sign off?
 *
 * This is the predicate that stocks the Review Queue. Both halves are required and they fail for
 * different reasons: no recipient means enrichment found nothing and nobody has typed an address;
 * no draft means the scorer deliberately declined to write one. A lead missing either belongs in
 * the Leads tab awaiting triage, not in a queue that promises "read this email and send it".
 */
export function isLeadDeliverable(data: unknown): boolean {
    return resolveLeadRecipient(data) !== null && hasOutreachDraft(data);
}

// ── The outreach stage ───────────────────────────────────────────────────────
//
// Enrichment and the Outreach tab's Review column are two screens with two jobs — triage the
// COMPANY, then read the EMAIL — but they are one `approval_status`. Both are `pending_approval`,
// and until this existed the only thing separating them was `isLeadDeliverable` above. That left
// three things broken, all of them the same bug wearing different clothes:
//
//   • Enrichment's Approve had nowhere to send a lead except PAST the review gate. It wrote
//     `approved`, so the lead landed in the Outreach tab's Approved column having never been
//     through the column whose entire job is the human read of the email. It bypassed the gate.
//   • "Send back to review" in the Approved column wrote `pending_approval` — correct on paper —
//     and for a lead with no draft it then vanished from the Outreach tab altogether, because the
//     deliverability filter dropped it. The user pressed a button naming a column, and the lead
//     reappeared on Enrichment instead.
//   • There was no way to say "this one needs more work" and mean it: sending a lead back for
//     review and demoting it to triage were the same write.
//
// `data.outreachStage` is set by a PERSON, and only by a person. Three values, and the third is
// the important one:
//
//   'review'  — a human moved this lead into Outreach ▸ Review. Shown there whatever the
//               deliverability filter thinks, because a human asked for it by name.
//   'triage'  — a human sent it back to Enrichment. Kept OUT of Outreach ▸ Review even when it
//               does carry a draft, or "send it back for more research" would be a no-op on
//               exactly the leads worth researching.
//   absent    — nobody has ruled either way. `isLeadDeliverable` decides, exactly as before.
//
// ⚠️ The absent case is what makes this safe against a live table. Every lead already in the
// database carries no stage, so every column keeps the contents it had this morning and the
// automatic path — a search finds a lead, the scorer drafts an email, it appears in Review — is
// untouched. Nothing backfills it: a stage means "a human decided", and inventing one for a row
// nobody has looked at would be a lie the filter then acts on.
//
// ⚠️ NOT a replacement for the deliverability filter, and it must not become one. That filter is
// what stops a search that found sixty leads from stocking Review with sixty cards promising an
// email nobody wrote. This overrides it one lead at a time, by hand, which is the only volume at
// which overriding it is reasonable.

/** The two things a person can say about where a lead belongs. */
export type LeadOutreachStage = 'review' | 'triage';

/** Where the stage lives on the record's `data`. Never typed out anywhere else. */
export const LEAD_OUTREACH_STAGE_PATH: ReadonlyArray<string> = ['outreachStage'];

/** The Postgres `#>>` path literal, e.g. `{outreachStage}`. Built from the array above. */
export const LEAD_OUTREACH_STAGE_SQL_PATH = `{${LEAD_OUTREACH_STAGE_PATH.join(',')}}`;

/**
 * The stage a person set on this lead, or null when nobody has set one.
 *
 * Null is the honest answer and the common one — "no human has ruled on this" is a third thing,
 * not a quieter version of either ruling. An unrecognised string reads as null for the same reason
 * the server drops unknown approval states rather than 400ing them: a stale client writing a value
 * we have retired must degrade to the automatic behaviour, never to an empty column.
 */
export function leadOutreachStage(data: unknown): 'review' | 'triage' | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const raw = (data as Record<string, unknown>).outreachStage;
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    return v === 'review' || v === 'triage' ? v : null;
}

/**
 * Does this lead belong in the Outreach tab's Review column?
 *
 * The one predicate the column, its badge and every button that moves a lead must agree on. A
 * human's stage wins outright in both directions; with no stage, deliverability decides.
 *
 * ⚠️ Mirrored into SQL by the `deliverable` filter in netlify/functions/assistant-records.ts, which
 * builds the same three-way decision as a CASE. Change one and change the other, or a lead sits in
 * a column whose own button says it is somewhere else.
 */
export function isInOutreachReview(data: unknown): boolean {
    const stage = leadOutreachStage(data);
    if (stage === 'review') return true;
    if (stage === 'triage') return false;
    return isLeadDeliverable(data);
}
