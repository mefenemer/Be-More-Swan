// src/config/lead-outreach-state.ts
// Has this lead's outreach email actually gone out, or is it only drafted?
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `approval_status` answers "did the user clear this lead", and nothing more. It cannot answer the
// question the reviewer actually asks next — "did the email go?" — because both outcomes of an
// approval are legitimate:
//
//   • an inbox is connected  → the mail is sent on approval          → SENT
//   • no inbox is connected  → the draft is handed back to the user  → DRAFTED
//
// Until this existed both read as a bare "Approved" everywhere, so a lead nobody had emailed was
// pixel-identical to one that had been. The two stamps that separate them were already on the
// record — `outreachSentAt` is written by lead-generation.ts `send_outreach` on a CONFIRMED send —
// they were simply never surfaced.
//
// ⚠️ `outreachSentAt` outranks `outreachDraftedAt`. A lead can be drafted first (no inbox), then
// sent later once one is connected, and both stamps then sit on the record; the send is the fact
// that matters. The send path also clears the drafted stamp, so this is belt and braces.
//
// ── Why a config module and not a util ───────────────────────────────────────
// Three surfaces state this, and they must not be able to disagree about which state a lead is in:
// the Review tab's card chip, the Leads tab's Approval column, and the banner on an open lead. The
// browser cannot import from src/, so this file is wired into scripts/gen-client-constants.ts and
// mirrored into src/generated/platform-constants.js as `window.LeadOutreach` — same mechanism, and
// same reasoning, as [[client-constants-generated]].
//
// ⚠️ `leadOutreachState` is emitted to the browser via `.toString()`, so it must stay
// self-contained: no imports and no closures over anything outside this file.

/** The two things that can have happened to a lead's outreach email after approval. */
export type LeadOutreachState = 'sent' | 'drafted';

/**
 * How each state is named and coloured. The label is the STATUS the user reads — deliberately the
 * same words on every surface, because "Email Sent" in one tab and "Contacted" in another describe
 * the same fact and read as two.
 *
 * The classes are here rather than per-surface for the same reason the labels are: green for a
 * thing that happened, blue for a thing waiting on the user. Both class strings are already in the
 * compiled stylesheet (style.css is prebuilt — a novel Tailwind class would render unstyled).
 */
export const LEAD_OUTREACH_CHIPS: Record<LeadOutreachState, { label: string; cls: string }> = {
    sent: { label: 'Email Sent', cls: 'bg-green-50 text-green-700 border-green-100' },
    drafted: { label: 'Email Drafted', cls: 'bg-blue-50 text-blue-800 border-blue-200' },
};

/**
 * Which state a lead's outreach is in, or null when nothing has happened to it yet.
 *
 * Null is the honest answer for a lead still awaiting review, and for one approved before these
 * stamps existed — never "drafted", which would claim a hand-off that never took place.
 */
export function leadOutreachState(data: unknown): LeadOutreachState | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const d = data as Record<string, unknown>;
    if (typeof d.outreachSentAt === 'string' && d.outreachSentAt.trim()) return 'sent';
    if (typeof d.outreachDraftedAt === 'string' && d.outreachDraftedAt.trim()) return 'drafted';
    return null;
}
