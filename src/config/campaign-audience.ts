// src/config/campaign-audience.ts
// Who a campaign is for, and who it must leave alone. docs/campaign-orchestrator-plan.md §9.2.
//
// Pure and import-free on purpose: campaigns.ts, the blueprint, the chat snapshot and the lead
// search loader all read the same shape, and a second normaliser anywhere is how one surface ends
// up saving a persona another silently ignores.
//
// ── Why an audience at all ───────────────────────────────────────────────────
// "A goal without an audience is just a wish." Before this, a campaign's only "who" was an
// optional `audience` string on whichever order happened to carry one, so most campaigns drafted
// for nobody in particular. The campaign now owns the default audience; an order can still name
// its own (a Blog Writer brief for Persona A while the Lead Generator hunts Persona B), and the
// order's wins for that order's work.

/** Stored in campaigns.audience (jsonb). Every field optional — "not said yet" is real. */
export interface CampaignAudience {
    /** Short label, e.g. "SMB founders". Shown on the row and quoted into drafting. */
    persona?: string;
    /** Who they are and what they care about, in the user's words. */
    description?: string;
    /** Companies (domains) this campaign must never go looking for. Normalised, de-duplicated. */
    excludeDomains?: string[];
}

export const AUDIENCE_PERSONA_MAX = 80;
export const AUDIENCE_DESCRIPTION_MAX = 500;
/** A list longer than this is a customer export, which belongs in a CRM, not on one campaign. */
export const AUDIENCE_EXCLUDE_DOMAINS_MAX = 100;

/**
 * Normalise one company identifier to its bare domain: lowercased, no scheme, no path, no `www.`.
 * Matches the dedupe key discovered leads are stored under, which is what an exclusion is
 * compared against — an un-normalised "https://www.Acme.co.uk/about" would exclude nothing.
 */
export function normaliseCompanyDomain(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    let s = input.trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
    s = s.replace(/^[^@/]*@/, '');                    // an email address names its company's domain
    s = s.split(/[/?#:]/)[0];                         // path, query, fragment, port
    s = s.replace(/^www\./, '').replace(/\.$/, '');
    // A domain has at least one dot and only these characters. Anything else ("Acme Ltd") is a
    // company NAME, which a domain comparison can never match — refusing it is more honest than
    // storing an exclusion that silently does nothing.
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** Split free text (commas, spaces, new lines) into normalised, unique domains. */
export function parseDomainList(raw: unknown): string[] {
    const parts = Array.isArray(raw)
        ? raw
        : typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
    const out: string[] = [];
    for (const p of parts) {
        const d = normaliseCompanyDomain(p);
        if (d && !out.includes(d)) out.push(d);
        if (out.length >= AUDIENCE_EXCLUDE_DOMAINS_MAX) break;
    }
    return out;
}

/**
 * Whatever arrived over the wire → a stored audience, or null when nothing was said.
 *
 * Total: never throws, because it runs on model output (the chat card) as well as on the form.
 */
export function normaliseAudience(raw: unknown): CampaignAudience | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const out: CampaignAudience = {};
    const persona = text(r.persona, AUDIENCE_PERSONA_MAX);
    const description = text(r.description, AUDIENCE_DESCRIPTION_MAX);
    const excludeDomains = parseDomainList(r.excludeDomains);
    if (persona) out.persona = persona;
    if (description) out.description = description;
    if (excludeDomains.length) out.excludeDomains = excludeDomains;
    return Object.keys(out).length ? out : null;
}

/**
 * The one line drafting reads: "SMB founders — owners of 5–50 person firms who …".
 *
 * An order's own audience (a free string on its brief) beats the campaign's, because it is the
 * more specific instruction — that is what lets one campaign brief two assistants for two personas.
 * Null when neither says anything; the directive then omits the line rather than guessing.
 */
export function audienceLine(campaignAudience: unknown, orderAudience?: unknown): string | null {
    if (typeof orderAudience === 'string' && orderAudience.trim()) return orderAudience.trim();
    const a = normaliseAudience(campaignAudience);
    if (!a || (!a.persona && !a.description)) return null;
    if (a.persona && a.description) return `${a.persona} — ${a.description}`;
    return (a.persona ?? a.description) as string;
}
