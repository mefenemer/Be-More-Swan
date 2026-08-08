// src/config/lead-recipient.ts
// Where a lead's outreach actually gets sent, and whether it can be sent at all.
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
