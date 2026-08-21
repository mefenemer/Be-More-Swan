// src/public/newsletter-findings.d.ts
// Types for the shared "before you send" findings. The implementation is deliberately plain .js so
// the SAME artifact runs in the browser (live, as the author types) and on the server (on the issue
// GET) — see newsletter-findings.js's header for why a second copy is not an option.

export type FindingSeverity = 'blocker' | 'warning' | 'note';

export interface Finding {
    code: string;
    severity: FindingSeverity;
    /** Written for the tenant. Says what is wrong AND why it matters. */
    message: string;
}

/** Structural findings about one email. Never totalled, never a score. */
export function contentFindings(issue: { subject?: string; text?: string; html?: string }): Finding[];

/** blocker → 0, warning → 1, note → 2. */
export function severityRank(f: Finding): number;

/** A copy of the list, most severe first. */
export function sortFindings(list: Finding[]): Finding[];

/** Whitespace-separated tokens. The same count the "only N words" finding reports. */
export function countWords(s: string): number;
