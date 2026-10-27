// src/config/lead-person.ts
// Steps 3 and 4 of the one-pass contact search (docs/lead-search-one-pass-plan.md §2, §5.3): which
// named person a lead's outreach should be addressed to, and whether an address we ALREADY HOLD is
// theirs. Pure — no network, no database — so the worker, the per-lead buttons and the tests all use
// the same rule.
//
// ⚠️ Nothing here invents a name or an address. Every person comes from a page we read, the
// Companies House register or Hunter; every address from a page or Hunter. `matchPersonEmail` only
// ever chooses among addresses that were literally published — it never builds `jane@` and uses it.

/** Where a named person came from. Shown beside the name, so a human can check it. */
export type LeadPersonSource = 'website' | 'companies_house' | 'hunter';

export interface LeadPerson {
    name: string;
    title: string | null;
    source: LeadPersonSource;
    sourceUrl: string | null;
}

export interface PersonCandidates {
    /** People named on the company's own pages, already through the fabrication guard. */
    site: Array<{ name: string; title: string | null; sourceUrl: string }>;
    /** Active officers from the register (src/lib/companies-house.ts). */
    officers: Array<{ name: string; role: string }>;
    officersUrl?: string | null;
    /** People Hunter's Domain Search returned for the domain, with their addresses. */
    hunter: Array<{ name: string; title: string | null; email: string }>;
}

/** Job titles that mean "can say yes". Read off the page as printed, so this is a word test. */
const DECISION_TITLE_RE = /\b(owner|co-?owner|founder|co-?founder|director|managing|proprietor|principal|partner|ceo|chief|head|manager|president|chair|lead|practice manager|headteacher|head teacher)\b/i;

export function isDecisionMakerTitle(title: string | null | undefined): boolean {
    return !!title && DECISION_TITLE_RE.test(title);
}

/** Lowercase letters only, accents folded: "Zoë O'Neil" → "zoe oneil". */
function fold(s: string): string {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, '').replace(/-/g, '');
}

/** First and last name tokens, or null when there are not two. */
export function nameParts(name: string): { first: string; last: string } | null {
    const words = fold(name).split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;
    return { first: words[0], last: words[words.length - 1] };
}

/** Same person? First and last name must both agree; middle names may differ ("Jane Ann Smith" = "Jane Smith"). */
export function samePerson(a: string, b: string): boolean {
    const x = nameParts(a), y = nameParts(b);
    return !!x && !!y && x.first === y.first && x.last === y.last;
}

/**
 * Choose the person outreach is addressed to, best first:
 *   1. named on their own site with a decision-maker title AND on the register
 *   2. named on their own site with a decision-maker title
 *   3. returned by Hunter with a decision-maker title and an address
 *   4. a register officer also named on their own site
 *   5. the ONLY active officer on the register
 * Several directors and nothing to tell them apart → null. Guessing which director runs the shop
 * is how a stranger's name ends up on the wrong email.
 */
export function pickLeadPerson(c: PersonCandidates): LeadPerson | null {
    const onRegister = (n: string) => c.officers.some((o) => samePerson(o.name, n));
    const decisionSite = c.site.filter((p) => isDecisionMakerTitle(p.title));

    const both = decisionSite.find((p) => onRegister(p.name));
    if (both) return { name: both.name, title: both.title, source: 'website', sourceUrl: both.sourceUrl };
    if (decisionSite[0]) return { name: decisionSite[0].name, title: decisionSite[0].title, source: 'website', sourceUrl: decisionSite[0].sourceUrl };

    const hunter = c.hunter.find((p) => isDecisionMakerTitle(p.title) && nameParts(p.name));
    if (hunter) return { name: hunter.name, title: hunter.title, source: 'hunter', sourceUrl: null };

    const corroborated = c.officers.find((o) => c.site.some((p) => samePerson(p.name, o.name)));
    if (corroborated) return { name: corroborated.name, title: corroborated.role, source: 'companies_house', sourceUrl: c.officersUrl ?? null };

    if (c.officers.length === 1) return { name: c.officers[0].name, title: c.officers[0].role, source: 'companies_house', sourceUrl: c.officersUrl ?? null };
    return null;
}

/**
 * The local parts a person's own address could take, from their real name. Used ONLY to recognise
 * an address that was already published — never to construct one to send to.
 */
export function personLocalParts(name: string): string[] {
    const p = nameParts(name);
    if (!p) return [];
    const { first, last } = p;
    const f = first[0];
    return [...new Set([
        first, `${first}.${last}`, `${first}_${last}`, `${first}-${last}`, `${first}${last}`,
        `${f}.${last}`, `${f}${last}`, `${first}${last[0]}`, `${first}.${last[0]}`, `${last}.${first}`, `${last}${f}`,
    ])];
}

/** The published address that belongs to this person, or null. Personal addresses only. */
export function matchPersonEmail<T extends { email: string; kind: string }>(person: { name: string }, emails: T[]): T | null {
    const forms = new Set(personLocalParts(person.name));
    if (forms.size === 0) return null;
    return emails.find((e) => e.kind === 'personal' && forms.has(e.email.split('@')[0].toLowerCase())) ?? null;
}
