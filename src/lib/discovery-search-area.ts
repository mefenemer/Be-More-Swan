// src/lib/discovery-search-area.ts
// Where a saved search is asking for businesses — read from the search's own words.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A search for "plumbers in the UK" was answered by US Google. Serper defaults to `gl=us` when no
// country is sent, and nothing in discovery sent one, so the only thing pointing a search at the UK
// was the word "UK" inside the query — which Google treats as a keyword, not a location. US
// businesses that mention the UK, and US places that share a UK name (Kent WA, Durham NC), came
// back as leads. The scorer could not catch them either: it was shown the profile, never the
// search, so it had no idea a location had been asked for.
//
// This module answers one question deterministically — which country does the search name? — so
// the worker can send it to the search provider (`gl`) and to the scorer.
//
// ── Why deterministic, not a model call ──────────────────────────────────────
// It runs on every run and decides where money is spent. A lookup table is free, cannot drift
// between runs, and is inspectable when it gets one wrong. The scorer still judges each candidate
// with the search's own words in front of it, so a place this table does not know is not lost —
// it is only not sent to the search provider.
//
// ── Bias ────────────────────────────────────────────────────────────────────
// When the search names TWO OR MORE countries, no country is sent. Pinning a "UK and Ireland"
// search to one of them would silently hide the other; unpinned is how every search ran before.

export interface SearchArea {
    /** ISO 3166-1 alpha-2, lowercase — the value Serper takes as `gl`. */
    country: string;
    /** Plain-English name, for the scorer's prompt and the run log. */
    countryName: string;
    /** The words in the search that decided it, for the run log. */
    matched: string;
}

interface CountryEntry {
    code: string;
    name: string;
    /** Phrases matched case-insensitively on word boundaries. */
    aliases: string[];
    /** Phrases matched CASE-SENSITIVELY — for short forms that collide with ordinary words ("US"). */
    exactCase?: string[];
    /** Country-code TLDs that place a business here. Used by isForeignDomain. */
    tlds: string[];
}

/**
 * The countries a search can be pinned to.
 *
 * ⚠️ Country NAMES only, never adjectives: "American diner in London", "Irish pub in Leeds" and
 * "French bakery" describe a style, not a location, and would pin the search to the wrong
 * country. Likewise no "America" ("Latin America").
 *
 * ⚠️ Only countries with an unambiguous name are listed. "Georgia" (country or US state) and
 * "Jersey" (Crown dependency or New Jersey) are deliberately absent: guessing wrong pins the
 * whole run to the wrong country, which is worse than not pinning it.
 */
const COUNTRIES: CountryEntry[] = [
    {
        code: 'gb', name: 'United Kingdom',
        aliases: ['uk', 'u.k.', 'united kingdom', 'great britain', 'britain', 'england', 'scotland', 'wales',
            'northern ireland'],
        tlds: ['uk'],
    },
    { code: 'ie', name: 'Ireland', aliases: ['ireland', 'republic of ireland', 'eire'], tlds: ['ie'] },
    {
        code: 'us', name: 'United States',
        aliases: ['usa', 'u.s.a.', 'u.s.', 'united states', 'united states of america'],
        exactCase: ['US'],
        tlds: ['us'],
    },
    { code: 'ca', name: 'Canada', aliases: ['canada'], tlds: ['ca'] },
    { code: 'au', name: 'Australia', aliases: ['australia'], tlds: ['au'] },
    { code: 'nz', name: 'New Zealand', aliases: ['new zealand', 'nz'], tlds: ['nz'] },
    { code: 'za', name: 'South Africa', aliases: ['south africa'], tlds: ['za'] },
    { code: 'in', name: 'India', aliases: ['india'], tlds: ['in'] },
    { code: 'sg', name: 'Singapore', aliases: ['singapore'], tlds: ['sg'] },
    { code: 'ae', name: 'United Arab Emirates', aliases: ['uae', 'united arab emirates', 'dubai', 'abu dhabi'], tlds: ['ae'] },
    { code: 'fr', name: 'France', aliases: ['france'], tlds: ['fr'] },
    { code: 'de', name: 'Germany', aliases: ['germany'], tlds: ['de'] },
    { code: 'es', name: 'Spain', aliases: ['spain'], tlds: ['es'] },
    { code: 'it', name: 'Italy', aliases: ['italy'], tlds: ['it'] },
    { code: 'nl', name: 'Netherlands', aliases: ['netherlands', 'holland'], tlds: ['nl'] },
    { code: 'pt', name: 'Portugal', aliases: ['portugal'], tlds: ['pt'] },
    { code: 'be', name: 'Belgium', aliases: ['belgium'], tlds: ['be'] },
    { code: 'se', name: 'Sweden', aliases: ['sweden'], tlds: ['se'] },
    { code: 'dk', name: 'Denmark', aliases: ['denmark'], tlds: ['dk'] },
    { code: 'no', name: 'Norway', aliases: ['norway'], tlds: ['no'] },
    { code: 'ch', name: 'Switzerland', aliases: ['switzerland'], tlds: ['ch'] },
    { code: 'at', name: 'Austria', aliases: ['austria'], tlds: ['at'] },
    { code: 'pl', name: 'Poland', aliases: ['poland'], tlds: ['pl'] },
];

/**
 * UK places that name the UK without saying so — "dentists in Kent", "cafés in Manchester".
 *
 * ⚠️ Consulted ONLY when no country is named outright. Several of these exist in the US too
 * (Durham, Cambridge, Birmingham, Kent); "Kent, Washington" names its country and wins. With no
 * country in the text, the UK reading is the right one for this product, and a US search that
 * means Durham NC has to say so — exactly as a person would.
 */
const UK_PLACES: string[] = [
    // Regions. Bare compass names ("south east") are absent: "south east Asia" is not Kent.
    'east anglia', 'midlands', 'west midlands', 'east midlands', 'yorkshire', 'home counties', 'the cotswolds', 'cotswolds',
    'greater london', 'greater manchester', 'merseyside', 'tyne and wear', 'west country',
    // Counties
    'bedfordshire', 'berkshire', 'buckinghamshire', 'cambridgeshire', 'cheshire', 'cornwall',
    'cumbria', 'derbyshire', 'devon', 'dorset', 'county durham', 'east sussex', 'west sussex', 'sussex',
    'essex', 'gloucestershire', 'hampshire', 'herefordshire', 'hertfordshire', 'isle of wight',
    'kent', 'lancashire', 'leicestershire', 'lincolnshire', 'norfolk', 'northamptonshire',
    'northumberland', 'nottinghamshire', 'oxfordshire', 'rutland', 'shropshire', 'somerset',
    'staffordshire', 'suffolk', 'surrey', 'warwickshire', 'wiltshire', 'worcestershire',
    // Cities
    'london', 'manchester', 'birmingham', 'leeds', 'liverpool', 'sheffield', 'bristol',
    'newcastle upon tyne', 'nottingham', 'leicester', 'southampton', 'portsmouth', 'brighton',
    'edinburgh', 'glasgow', 'aberdeen', 'dundee', 'cardiff', 'swansea', 'belfast', 'oxford',
    'cambridge', 'exeter', 'plymouth', 'norwich', 'coventry', 'milton keynes', 'stoke-on-trent',
    'bournemouth', 'canterbury',
    // ⚠️ Absent on purpose: York (inside "New York"), Bath, Reading and Derby (ordinary words —
    // "bath fitters", "reading glasses", "derby shoes"). Each would pin an unrelated search to the UK.
];

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary test that also works for phrases ending in punctuation ("u.k."). */
function phraseRe(phrase: string, flags: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase)}(?![\\p{L}\\p{N}])`, `${flags}u`);
}

function firstMatch(text: string, phrases: string[], caseSensitive: boolean): string | null {
    // Longest first, so "northern ireland" claims the text before "ireland" can.
    const sorted = [...phrases].sort((a, b) => b.length - a.length);
    for (const p of sorted) {
        const m = text.match(phraseRe(p, caseSensitive ? '' : 'i'));
        if (m) return m[0];
    }
    return null;
}

/**
 * The country a search names, or null when it names none (or more than one).
 *
 * @param texts everything the user wrote that describes the search — the idea, plus the area a
 *              territory sweep was approved for. Nulls are ignored.
 */
export function resolveSearchArea(texts: Array<string | null | undefined>): SearchArea | null {
    let text = texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).join(' \n ');
    if (!text) return null;

    // "Northern Ireland" is the UK, not Ireland. Strip the claimed phrase before testing the rest,
    // or a NI search would read as naming two countries and be left unpinned.
    const hits: Array<{ entry: CountryEntry; matched: string }> = [];
    for (const entry of COUNTRIES) {
        const matched = firstMatch(text, entry.aliases, false)
            ?? (entry.exactCase ? firstMatch(text, entry.exactCase, true) : null);
        if (!matched) continue;
        hits.push({ entry, matched });
        if (entry.code === 'gb') text = text.replace(phraseRe('northern ireland', 'gi'), ' ');
    }

    if (hits.length === 1) {
        const { entry, matched } = hits[0];
        return { country: entry.code, countryName: entry.name, matched };
    }
    if (hits.length > 1) return null;

    const ukPlace = firstMatch(text, UK_PLACES, false);
    if (ukPlace) return { country: 'gb', countryName: 'United Kingdom', matched: ukPlace };
    return null;
}

/**
 * True when a domain's country-code TLD places the business in a DIFFERENT country from the one
 * the search asked for — `smithplumbing.com.au` on a UK search.
 *
 * ⚠️ Only TLDs belonging to a country in the table above count. Generic TLDs (.com, .net, .org)
 * say nothing about where a business is, and vanity ccTLDs (.io, .co, .ai, .me) are used
 * worldwide — neither is ever treated as foreign. False here only means "the domain does not
 * settle it"; the scorer still reads the snippet.
 */
export function isForeignDomain(domain: string | null | undefined, area: SearchArea | null): string | null {
    if (!domain || !area) return null;
    const tld = domain.toLowerCase().replace(/\.$/, '').split('.').pop() ?? '';
    const owner = COUNTRIES.find((c) => c.tlds.includes(tld));
    if (!owner || owner.code === area.country) return null;
    return owner.name;
}
