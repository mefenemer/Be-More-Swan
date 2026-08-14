// src/config/crm-export.ts
// Lead CSV export shaped for a HubSpot or Salesforce import (Phase 2 item 12).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Every competing tool in the market scan integrates both CRMs. We ask users to adopt Contacts as
// their CRM instead, which is fine for an SMB that has none and a flat blocker for anyone who
// already runs one — their leads are trapped in our product. Matching the column HEADERS to what
// those importers recognise removes the objection without building or maintaining two integrations:
// the user exports, drags the file into their own importer, and the columns auto-map.
//
// The generic `?format=csv` export is untouched and stays the default. This is an ADDITIONAL shape,
// requested with `&crm=hubspot|salesforce`, and only for leads.
//
// ── What is deliberately NOT exported ────────────────────────────────────────
// **No status/lifecycle column.** Both CRMs model lead status as a *picklist*, and both let an
// admin customise its values. A value outside the org's picklist fails the row on import — so the
// single most-customised field is the one most likely to break the file. Our approval state goes
// into the free-text description instead, where it can never be invalid.
//
// **No phone or job title.** We hold neither. An always-empty column is noise in an import mapper.
//
// **Nothing is invented.** Same rule as the scraper: a blank cell is correct, a plausible guess is
// not. In particular a lead with no named contact exports with EMPTY name cells — see the note on
// `Last Name` below.

export type CrmTarget = 'hubspot' | 'salesforce';

export const CRM_TARGETS: readonly CrmTarget[] = ['hubspot', 'salesforce'];

export function isCrmTarget(value: unknown): value is CrmTarget {
    return typeof value === 'string' && (CRM_TARGETS as readonly string[]).includes(value);
}

/** The fields a lead row can supply, already resolved from the record and its discovery row. */
export interface CrmLeadRow {
    company: string;
    firstName: string;
    lastName: string;
    email: string;
    website: string;
    industry: string;
    /** 'hot' | 'warm' | 'cold' as stored. */
    rating: string;
    description: string;
}

/**
 * Column headers, in order, per target — the exact strings each importer matches on.
 *
 * ⚠️ These are the IMPORTERS' field labels, not ours, and the difference is the whole point. The
 * same concept is "Company" in Salesforce and "Company Name" in HubSpot, "Website" vs "Website URL".
 * A single shared header row would auto-map in one tool and need hand-mapping in the other, which is
 * the friction this removes. Renaming any of these to something tidier breaks the auto-match.
 *
 * ⚠️ `Last Name` is REQUIRED by the Salesforce Lead importer, and most discovery leads have no named
 * contact — a role inbox on a company is what tier-1 enrichment finds. Those rows export with the
 * name cells empty and Salesforce will reject them as Leads; they are Accounts, not people. We do
 * not fabricate a surname from the company to get them through, because that writes a person who
 * does not exist into the user's CRM. The export UI says so before the download.
 */
const COLUMNS: Record<CrmTarget, ReadonlyArray<{ header: string; from: keyof CrmLeadRow | null }>> = {
    salesforce: [
        { header: 'First Name', from: 'firstName' },
        { header: 'Last Name', from: 'lastName' },
        { header: 'Company', from: 'company' },
        { header: 'Email', from: 'email' },
        { header: 'Website', from: 'website' },
        { header: 'Industry', from: 'industry' },
        // The one genuinely exact match in either vocabulary: the standard Salesforce Lead `Rating`
        // picklist is Hot / Warm / Cold, which is our own rating capitalised. Emitted for Salesforce
        // only — HubSpot has no equivalent standard property, so there it folds into Notes.
        { header: 'Rating', from: 'rating' },
        { header: 'Lead Source', from: null },
        { header: 'Description', from: 'description' },
    ],
    hubspot: [
        { header: 'First Name', from: 'firstName' },
        { header: 'Last Name', from: 'lastName' },
        { header: 'Email', from: 'email' },
        { header: 'Company Name', from: 'company' },
        { header: 'Website URL', from: 'website' },
        { header: 'Industry', from: 'industry' },
        { header: 'Lead Source', from: null },
        { header: 'Notes', from: 'description' },
    ],
};

/** Matches the attribution the scenario engine already sends on lead.status_changed. */
export const LEAD_SOURCE = 'Be More Swan';

export function crmHeaders(target: CrmTarget): string[] {
    return COLUMNS[target].map((c) => c.header);
}

/** Salesforce's Rating picklist is capitalised; ours is not. Anything unexpected exports blank. */
function ratingCell(rating: string): string {
    const r = rating.trim().toLowerCase();
    return r === 'hot' ? 'Hot' : r === 'warm' ? 'Warm' : r === 'cold' ? 'Cold' : '';
}

export function crmRow(target: CrmTarget, row: CrmLeadRow): string[] {
    return COLUMNS[target].map((c) => {
        if (c.from === null) return LEAD_SOURCE;
        if (c.from === 'rating') return ratingCell(row.rating);
        return row[c.from] ?? '';
    });
}

/**
 * Split a stored contact name into the two columns both importers want.
 *
 * A single token becomes the LAST name, not the first: Salesforce requires Last Name and ignores
 * First, so one word is more useful there than here. Everything after the first token is the
 * surname, which keeps "Maria del Carmen Ruiz" intact rather than truncating it.
 */
export function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
    const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: '', lastName: parts[0] };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * How our approval states read to someone in the user's own CRM.
 *
 * ⚠️ Never the raw enum. This text lands in a Description field a sales team reads, where
 * "pending_approval" is our database's word for it, not English. An unknown state contributes
 * nothing rather than leaking a new internal token into somebody's CRM.
 */
const APPROVAL_WORDS: Record<string, string> = {
    pending_approval: 'awaiting approval in Be More Swan',
    approved: 'approved in Be More Swan',
    scheduled: 'approved and scheduled in Be More Swan',
    rejected: 'rejected in Be More Swan',
};

/**
 * The free-text column: everything the row knows that has no column of its own.
 *
 * Each fragment ends in a full stop before being joined — assembled without one, the score, the
 * reasons and the next step run together into a single unreadable sentence, which is what the first
 * sample export actually produced.
 */
export function crmDescription(parts: {
    score?: unknown; reasons?: unknown; nextStep?: unknown; approvalStatus?: string | null;
}): string {
    const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
    const out: string[] = [];
    if (typeof parts.score === 'number') out.push(`Fit score ${parts.score}/100.`);
    if (Array.isArray(parts.reasons)) {
        for (const r of parts.reasons) if (typeof r === 'string' && r.trim()) out.push(sentence(r));
    }
    if (typeof parts.nextStep === 'string' && parts.nextStep.trim()) out.push(sentence(`Next step: ${parts.nextStep}`));
    const approval = parts.approvalStatus ? APPROVAL_WORDS[parts.approvalStatus] : undefined;
    if (approval) out.push(sentence(`Status: ${approval}`));
    return out.join(' ');
}

/** A bare domain is not a URL; both importers want a browsable address. */
export function websiteUrl(domain: string | null | undefined): string {
    const d = String(domain ?? '').trim();
    if (!d) return '';
    return /^https?:\/\//i.test(d) ? d : `https://${d}`;
}
