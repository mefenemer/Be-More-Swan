// src/lib/companies-house.ts
// Step 2 of the one-pass contact search (docs/lead-search-one-pass-plan.md §2, §5.2): who runs a UK
// company, from the official register. Free, so it runs before anything is bought.
//
// ── What it gives, and what it never does ────────────────────────────────────
// NAMES ONLY. The register publishes a company's active officers (directors, LLP members) and its
// registered office. It holds no email addresses, so nothing here can make a lead contactable on its
// own — it gives the person-to-address match (src/config/lead-person.ts) and Hunter's Email Finder a
// name to work with, and it gives the outreach draft someone to address.
//
// Sole traders and ordinary partnerships are not on the register at all. A miss is normal.
//
// ── The match is the whole risk ──────────────────────────────────────────────
// A common trading name ("Bloom Florists") has dozens of registered companies. Naming the director of
// the wrong one puts a stranger's name in front of a real business, so a register entry is used only
// when it is unambiguous:
//   • its name, with Ltd / Limited / PLC / LLP and punctuation removed, EQUALS the lead's; and
//   • it is active; and
//   • either its registered postcode is printed on the company's own website, or it is the ONLY
//     active company of that name.
// Anything looser returns null.
//
// ── Contract ─────────────────────────────────────────────────────────────────
// NEVER THROWS, and — like discovery-enrich-provider.ts — says whether the register ANSWERED.
// `error` (no key, 429, timeout) is a fact about us; `miss` is a fact about the company.
//
// Config:
//   COMPANIES_HOUSE_API_KEY      — required; unset means the step is skipped (`not_configured`)
//   COMPANIES_HOUSE_TIMEOUT_MS   — per request (default 4000)
// Limit: 600 requests per 5 minutes per key. Each lead costs at most 2.

const API = 'https://api.company-information.service.gov.uk';
const TIMEOUT_MS = Number(process.env.COMPANIES_HOUSE_TIMEOUT_MS ?? '4000');

/** Officer roles that mean "runs this company". Secretaries and corporate officers are not people to write to. */
const PERSON_ROLES = new Set(['director', 'llp-designated-member', 'llp-member', 'member']);

export interface CompaniesHouseOfficer {
    /** Natural order, as a person would write it: "Jane Ann Smith". */
    name: string;
    /** Register role, readable: "Director", "LLP member". */
    role: string;
    appointedOn: string | null;
}

export interface CompaniesHouseCompany {
    number: string;
    name: string;
    postcode: string | null;
    /** The public register page — provenance a human can open. */
    url: string;
    officers: CompaniesHouseOfficer[];
    /** Why we trusted the match: the site printed the registered postcode, or it was the only one. */
    matchedBy: 'postcode' | 'only_active_match';
}

export type CompaniesHouseOutcome =
    | { status: 'hit'; company: CompaniesHouseCompany }
    | { status: 'miss' }
    | { status: 'error'; reason: string };

export function isCompaniesHouseConfigured(): boolean {
    return Boolean(process.env.COMPANIES_HOUSE_API_KEY);
}

/**
 * A company name reduced to what identifies it. "Debonair Candles Ltd." and "DEBONAIR CANDLES
 * LIMITED" both become "debonair candles". Exported for the tests.
 */
export function normaliseCompanyName(name: string): string {
    return String(name || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w && !['ltd', 'limited', 'plc', 'llp', 'lp', 'cic', 'the', 'uk'].includes(w))
        .join(' ')
        .trim();
}

/**
 * The trading name to look up. A search result's title often carries a tagline
 * ("Debonair Candles | Hand-poured soy candles"), and the register knows only the name.
 */
export function companyNameForLookup(raw: string): string {
    // A spaced dash or a pipe or colon starts the tagline; "Smith-Jones" (unspaced) is a name.
    return String(raw || '').split(/\s+[–—-]\s+|\s*\|\s*|:\s/)[0].trim();
}

/** "SMITH, Jane Ann" → "Jane Ann Smith". The register writes surnames first, in capitals. */
export function officerNaturalName(raw: string): string {
    const [last, rest] = String(raw || '').split(',').map((p) => p.trim());
    const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
    // Honorifics the register sometimes prefixes ("Mrs Jane SMITH") are not part of anyone's name.
    const given = (rest || '').replace(/^(mr|mrs|ms|miss|dr|sir|dame|prof)\.?\s+/i, '');
    return rest ? `${titleCase(given)} ${titleCase(last)}`.trim() : titleCase(last);
}

function roleLabel(role: string): string {
    if (role === 'director') return 'Director';
    if (role === 'llp-designated-member') return 'LLP designated member';
    if (role === 'llp-member' || role === 'member') return 'LLP member';
    return role;
}

function normalisePostcode(pc: unknown): string | null {
    const m = String(pc || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    return m ? `${m[1]} ${m[2]}` : null;
}

type Usage = { workspaceId?: number | null; assistantId?: number | null };

async function get(path: string, timeoutMs: number, _usage?: Usage): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
    const key = process.env.COMPANIES_HOUSE_API_KEY as string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${API}${path}`, {
            signal: controller.signal,
            headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
        });
        // The register is free, so nothing is written to ai_usage_log (a $0 row per call would be noise).
        // 404 on an officers list is "no officers on file", which is an answer, not a failure.
        if (res.status === 404) return { ok: true, body: null };
        if (!res.ok) {
            console.warn(`[companies-house] HTTP ${res.status} for ${path.split('?')[0]} — NOT a miss, the lookup did not happen`);
            return { ok: false, reason: `http_${res.status}` };
        }
        return { ok: true, body: await res.json().catch(() => null) };
    } catch (err) {
        return { ok: false, reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

interface SearchItem { number: string; name: string; status: string; postcode: string | null }

/**
 * Choose the register entry that IS this lead, or null. Pure — exported for the tests.
 * See the header for why each rule is there.
 */
export function chooseCompany(leadName: string, items: SearchItem[], sitePostcodes: string[]): (SearchItem & { matchedBy: CompaniesHouseCompany['matchedBy'] }) | null {
    const want = normaliseCompanyName(companyNameForLookup(leadName));
    if (want.length < 3) return null;
    const same = items.filter((i) => i.status === 'active' && normaliseCompanyName(i.name) === want);
    if (same.length === 0) return null;
    const onSite = new Set(sitePostcodes.map(normalisePostcode).filter(Boolean) as string[]);
    const byPostcode = same.filter((i) => i.postcode && onSite.has(i.postcode));
    if (byPostcode.length === 1) return { ...byPostcode[0], matchedBy: 'postcode' };
    if (byPostcode.length > 1) return null;
    if (same.length === 1) return { ...same[0], matchedBy: 'only_active_match' };
    return null;
}

/**
 * Look a lead up on the register and return its active officers.
 *
 * @param sitePostcodes  postcodes the company's own site printed (discovery-enrich.ts `postcodes`)
 */
export async function lookupCompaniesHouse(
    companyName: string,
    sitePostcodes: string[],
    opts: { timeoutMs?: number; usage?: Usage } = {},
): Promise<CompaniesHouseOutcome> {
    if (!isCompaniesHouseConfigured()) return { status: 'error', reason: 'not_configured' };
    const name = companyNameForLookup(companyName);
    if (normaliseCompanyName(name).length < 3) return { status: 'miss' };
    const timeoutMs = Math.min(opts.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS);
    if (timeoutMs <= 0) return { status: 'error', reason: 'no_budget' };

    const found = await get(`/search/companies?q=${encodeURIComponent(name)}&items_per_page=20`, timeoutMs, opts.usage);
    if (!found.ok) return { status: 'error', reason: found.reason };
    const rawItems = (found.body as { items?: unknown } | null)?.items;
    const items: SearchItem[] = (Array.isArray(rawItems) ? rawItems : [])
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map((i) => ({
            number: String(i.company_number ?? ''),
            name: String(i.title ?? ''),
            status: String(i.company_status ?? ''),
            postcode: normalisePostcode((i.address as Record<string, unknown> | undefined)?.postal_code),
        }))
        .filter((i) => /^[A-Z0-9]{6,10}$/i.test(i.number));

    const chosen = chooseCompany(name, items, sitePostcodes);
    if (!chosen) return { status: 'miss' };

    const off = await get(`/company/${encodeURIComponent(chosen.number)}/officers?items_per_page=35`, timeoutMs, opts.usage);
    if (!off.ok) return { status: 'error', reason: off.reason };
    const rawOfficers = (off.body as { items?: unknown } | null)?.items;
    const officers: CompaniesHouseOfficer[] = (Array.isArray(rawOfficers) ? rawOfficers : [])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        .filter((o) => !o.resigned_on && PERSON_ROLES.has(String(o.officer_role ?? '')))
        .map((o) => ({
            name: officerNaturalName(String(o.name ?? '')),
            role: roleLabel(String(o.officer_role ?? '')),
            appointedOn: typeof o.appointed_on === 'string' ? o.appointed_on : null,
        }))
        .filter((o) => o.name.split(' ').length >= 2);

    return {
        status: 'hit',
        company: {
            number: chosen.number,
            name: chosen.name,
            postcode: chosen.postcode,
            url: `https://find-and-update.company-information.service.gov.uk/company/${chosen.number}`,
            officers,
            matchedBy: chosen.matchedBy,
        },
    };
}
