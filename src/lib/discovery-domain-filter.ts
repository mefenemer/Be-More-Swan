// src/lib/discovery-domain-filter.ts
// Drops non-prospects out of the discovery pipeline BEFORE they reach the scorer.
//
// Why this exists: a live staging run (campaign 5, 2026-07-18) qualified tiktok.com,
// cvent.com, oxmaint.com (a maintenance-software blog) and blog.healthcarecouncil.com as
// hot/warm leads. The campaign was hunting corporate retreat venues; the SERP returned
// ARTICLES ABOUT venues, directories OF venues, and SaaS vendors selling to venues. The
// scoring LLM rewarded topical relevance and missed that none of them is a company you
// could sell to. No amount of contact enrichment fixes that — you cannot email tiktok.com.
//
// Deterministic and LLM-free on purpose: it runs before scoring, so every candidate it
// drops is also a candidate the scorer never pays tokens for.
//
// Bias: FALSE NEGATIVES OVER FALSE POSITIVES. Letting one directory through costs a
// wasted scoring slot; excluding a genuine prospect costs a real customer and is
// invisible. Heuristics below stay conservative for that reason, and every verdict
// carries a `reason` so a surprising drop can be traced.

export type ExclusionCategory =
    | 'social'        // social networks / UGC platforms
    | 'aggregator'    // directories, marketplaces, review and listing sites
    | 'media'         // news, magazines, publishers
    | 'reference'     // encyclopaedic / data platforms
    | 'jobs'          // job boards and recruitment
    | 'content_page'  // a blog post, guide, PDF or template — an article, not a company
    | 'non_company';  // infrastructure subdomains that aren't a sellable entity

export interface DomainVerdict {
    excluded: boolean;
    category: ExclusionCategory | null;
    /** Human-readable justification — surfaced in logs so drops are auditable. */
    reason: string;
}

const KEEP: DomainVerdict = { excluded: false, category: null, reason: '' };

/** Exact registrable domains that are never a prospect, whatever the campaign. */
const BLOCKED_DOMAINS: Record<string, ExclusionCategory> = {};

function block(category: ExclusionCategory, ...domains: string[]): void {
    for (const d of domains) BLOCKED_DOMAINS[d] = category;
}

block('social',
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com',
    'youtube.com', 'pinterest.com', 'reddit.com', 'tumblr.com', 'threads.net', 'snapchat.com',
    'whatsapp.com', 'telegram.org', 'discord.com', 'vimeo.com', 'flickr.com', 'nextdoor.com');

block('aggregator',
    // Reviews & local directories
    'yelp.com', 'tripadvisor.com', 'tripadvisor.co.uk', 'trustpilot.com', 'yell.com',
    'yellowpages.com', 'thomsonlocal.com', 'checkatrade.com', 'bark.com', 'thumbtack.com',
    'angi.com', 'houzz.com', 'glassdoor.com', 'g2.com', 'capterra.com', 'trustradius.com',
    'clutch.co', 'goodfirms.co', 'softwareadvice.com', 'getapp.com',
    // Travel / venue / event marketplaces — the exact class that polluted campaign 5
    'booking.com', 'expedia.com', 'airbnb.com', 'hotels.com', 'agoda.com', 'trivago.com',
    'kayak.com', 'lastminute.com', 'eventbrite.com', 'eventbrite.co.uk', 'cvent.com',
    'meetup.com', 'peerspace.com', 'tagvenue.com', 'hire-space.com', 'venuefinder.com',
    'weddingwire.com', 'theknot.com', 'hitched.co.uk', 'opentable.com', 'squaremeal.co.uk',
    // Business data
    'crunchbase.com', 'pitchbook.com', 'zoominfo.com', 'apollo.io', 'owler.com',
    'companieshouse.gov.uk', 'dnb.com', 'bloomberg.com',
    // Supplier/wholesale directories seen in the 2026-08-08 prod run.
    'salehoo.com', 'alibaba.com', 'faire.com', 'etsy.com',
    // Brand directories, added 2026-08-12 from the same run as countryandtownhouse.com below —
    // a curated index of British-made brands is a list OF prospects, never one itself.
    'makeitbritish.co.uk');

block('media',
    'bbc.co.uk', 'bbc.com', 'theguardian.com', 'nytimes.com', 'forbes.com', 'ft.com',
    'telegraph.co.uk', 'independent.co.uk', 'dailymail.co.uk', 'businessinsider.com',
    'techcrunch.com', 'wired.com', 'cnn.com', 'reuters.com', 'huffpost.com', 'vox.com',
    'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'wix.com',
    // Added 2026-08-08 from a real prod run in which NOT ONE of its 35 results was caught here —
    // the scorer did all the work, at full token cost, which is the opposite of the two-layer
    // design. huffpost.com was blocked while huffingtonpost.co.uk, the domain that actually
    // ranked, was not. Trade press first:
    'huffingtonpost.co.uk', 'digiday.com', 'marketingbrew.com', 'adweek.com', 'campaignlive.co.uk',
    'thedrum.com', 'marketingweek.com',
    // Podcast hosts. A discovery hit on an episode page can never be a prospect — the business
    // discussed is Case B, and the host itself sells nothing we target. `libsyn.com` covers the
    // per-show subdomains (feeds.libsyn.com, rossbolenpodcast.libsyn.com) via the suffix match.
    'podcasts.apple.com', 'anchor.fm', 'libsyn.com', 'buzzsprout.com', 'podbean.com',
    'soundcloud.com', 'spotify.com', 'captivate.fm', 'transistor.fm',
    // Lifestyle/consumer titles, added 2026-08-12. These reach the scorer through the front door:
    // a magazine's homepage carries no /blog path and no listicle title, so nothing upstream of
    // the LLM has an opinion about it. It scored 0 — correctly — for the price of a scoring slot,
    // which is exactly the cost this list exists to avoid paying twice.
    'countryandtownhouse.com');

block('reference',
    'wikipedia.org', 'wikimedia.org', 'quora.com', 'stackexchange.com', 'stackoverflow.com',
    'britannica.com', 'statista.com', 'researchgate.net', 'scribd.com', 'slideshare.net');

block('jobs',
    'indeed.com', 'indeed.co.uk', 'monster.com', 'totaljobs.com', 'reed.co.uk',
    'ziprecruiter.com', 'seek.com.au', 'workable.com', 'greenhouse.io', 'lever.co',
    // Also from the 2026-08-08 prod run — the startup-jobs boards the old list missed entirely.
    'startup.jobs', 'builtin.com', 'builtinnyc.com', 'wellfound.com', 'otta.com',
    'cwjobs.co.uk', 'jobsite.co.uk', 'glassdoor.co.uk');

// Subdomains that are a company's PUBLISHING or SUPPORT surface, not the company as a
// sellable entity. Caught blog.healthcarecouncil.com and members.hhnetwork.org on staging.
const NON_COMPANY_SUBDOMAINS = [
    'blog', 'news', 'help', 'support', 'docs', 'documentation', 'kb', 'wiki', 'forum',
    'community', 'members', 'careers', 'jobs', 'status', 'developer', 'developers', 'api',
];

// Title/URL markers that identify an ARTICLE ABOUT the target market rather than a company
// in it. Anchored to real staging titles: "[PDF] 2024 Sessions Prospectus",
// "The Guide to Employee Scheduling in Hospitality", "Hotel Preventive Maintenance
// Schedule Template (Ex…". Deliberately narrow — "guide" alone would nuke legitimate
// tour-guide businesses, so patterns require article-shaped phrasing.
const CONTENT_TITLE_PATTERNS: Array<[RegExp, string]> = [
    [/^\s*\[pdf\]/i,                          'title is a PDF document, not a company page'],
    [/\bthe guide to\b|\ba guide to\b/i,      'title reads as a how-to guide'],
    [/\btop\s*\d+\b|\bbest\s+\d+\b/i,         'title is a ranked listicle'],
    [/\b\d+\s+(?:best|top)\b/i,               'title is a ranked listicle'],
    [/\btemplate\b|\bchecklist\b|\bworksheet\b/i, 'title offers a downloadable template'],
    [/\bhow to\b/i,                           'title is a how-to article'],
    [/\bwhat is\b|\bwhy you should\b/i,       'title is an explainer article'],
    [/\bultimate guide\b|\bcomplete guide\b/i, 'title is a guide'],
    [/\bcase study\b|\bwhite ?paper\b/i,      'title is marketing collateral'],
    [/\bdirectory\b|\bdirectories\b/i,        'title is a directory listing'],
];

const CONTENT_PATH_PATTERNS: Array<[RegExp, string]> = [
    [/\/blog(?:\/|$)/i,        'URL is a blog post'],
    [/\/news(?:\/|$)/i,        'URL is a news item'],
    [/\/articles?(?:\/|$)/i,   'URL is an article'],
    [/\/resources?(?:\/|$)/i,  'URL is a resources page'],
    [/\/guides?(?:\/|$)/i,     'URL is a guide'],
    [/\/insights?(?:\/|$)/i,   'URL is an insights post'],
    [/\/case-stud/i,           'URL is a case study'],
    [/\.pdf(?:$|\?)/i,         'URL is a PDF'],
];

/** Strip a leading www. and lowercase. Mirrors normaliseDomain in discovery-search.ts. */
function bare(domain: string): string {
    return domain.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/**
 * Is `domain` the blocked domain itself, or a subdomain of it? Matching the registrable
 * domain means blog.medium.com and uk.tripadvisor.com are caught by one entry.
 */
function matchesBlocked(domain: string): ExclusionCategory | null {
    const host = bare(domain);
    for (const [blocked, category] of Object.entries(BLOCKED_DOMAINS)) {
        if (host === blocked || host.endsWith(`.${blocked}`)) return category;
    }
    return null;
}

/**
 * Decide whether a discovered candidate is a sellable company or pipeline noise.
 * Called per candidate before scoring; `excluded` candidates are dropped and never stored.
 */
export function classifyCandidate(input: {
    domain?: string | null;
    url?: string | null;
    title?: string | null;
}): DomainVerdict {
    const domain = input.domain ? bare(input.domain) : '';
    if (!domain) return { excluded: true, category: 'non_company', reason: 'no resolvable domain' };

    const blockedAs = matchesBlocked(domain);
    if (blockedAs) {
        return { excluded: true, category: blockedAs, reason: `${domain} is a known ${blockedAs} platform` };
    }

    // Publishing/support subdomains — the company may be real, but this page isn't it.
    const labels = domain.split('.');
    if (labels.length > 2 && NON_COMPANY_SUBDOMAINS.includes(labels[0])) {
        return { excluded: true, category: 'non_company', reason: `"${labels[0]}." is a publishing/support subdomain, not a company home` };
    }

    const title = (input.title ?? '').trim();
    for (const [re, reason] of CONTENT_TITLE_PATTERNS) {
        if (re.test(title)) return { excluded: true, category: 'content_page', reason };
    }

    const url = (input.url ?? '').trim();
    if (url) {
        let path = '';
        try { path = new URL(url.includes('://') ? url : `https://${url}`).pathname; } catch { path = ''; }
        for (const [re, reason] of CONTENT_PATH_PATTERNS) {
            if (re.test(path)) return { excluded: true, category: 'content_page', reason };
        }
    }

    return KEEP;
}

// ── Resolving a hit to the company it is actually about (Case A) ─────────────
//
// The worker treats a search result's DOMAIN as the prospect, so a hit on the wrong PAGE of a
// real company's site is thrown away with the rest of the noise: alofttrophyclub.com — an actual
// hotel — was dropped because it ranked on a "How to Host a Corporate Retreat" blog post, and
// blog./careers. subdomains are dropped wholesale. In both, the prospect is already in the URL.
//
// ⚠️ SCOPE: same company, wrong page. A hit on a THIRD PARTY that merely mentions a company
// (a job advert, a Trustpilot review) is a different problem — stripping linkedin.com/jobs/… to
// linkedin.com yields LinkedIn, not the employer. That needs entity extraction and is Case B in
// docs/discovery-candidate-resolution-plan.md. This function deliberately returns null for it.

export interface ResolvedCandidate {
    /** The domain to treat as the prospect. */
    domain: string;
    /** True when this differs from the hit's own domain, or the hit's page was discounted. */
    rewritten: boolean;
    /** Why, for the run log and for signals provenance. */
    reason: string;
}

/**
 * Decide what company a search hit is about, or null if it is not about one we can sell to.
 *
 * Replaces a bare `!classifyCandidate().excluded` test: same answer for everything that was
 * already kept or already dropped, plus a second chance for the two shapes where the company is
 * real and only the page is wrong.
 *
 * ⚠️ NEVER strips labels blindly. `foo.co.uk` reduced to its last two labels is `co.uk`, and
 * there is no public-suffix list in this codebase — a naive apex would corrupt most of the UK SMB
 * market we target. Only a leading label that is a KNOWN publishing subdomain is removed, which is
 * exactly the test classifyCandidate already applies.
 */
export function resolveCandidateDomain(input: {
    domain?: string | null;
    url?: string | null;
    title?: string | null;
}): ResolvedCandidate | null {
    const verdict = classifyCandidate(input);
    const domain = input.domain ? bare(input.domain) : '';

    if (!verdict.excluded) return { domain, rewritten: false, reason: '' };
    if (!domain) return null;

    // A publishing/support subdomain of a company that may itself be fine.
    if (verdict.category === 'non_company') {
        const labels = domain.split('.');
        if (labels.length > 2 && NON_COMPANY_SUBDOMAINS.includes(labels[0])) {
            const root = labels.slice(1).join('.');
            // Re-test the ROOT on its own. The original path and title belong to the article, not
            // to the company, so they are deliberately not passed: judging foo.com by the blog
            // post that surfaced it is the mistake being corrected. The domain rules still apply —
            // blog.medium.com must not become a lead for medium.com.
            if (classifyCandidate({ domain: root }).excluded) return null;
            return { domain: root, rewritten: true, reason: `rewritten from ${domain} (${labels[0]}. subdomain)` };
        }
        return null;
    }

    // An article, guide or PDF. The DOMAIN is not the problem here — the path or title is — so
    // the company stands or falls on its domain alone.
    if (verdict.category === 'content_page') {
        if (classifyCandidate({ domain }).excluded) return null;   // a Digiday article stays dropped
        return { domain, rewritten: true, reason: `kept ${domain}; the hit was a content page` };
    }

    // social / aggregator / media / reference / jobs — the company, if any, is named in the page
    // rather than the URL. Case B.
    return null;
}

/** Convenience for logging/metrics: the built-in blocklist size, for a sanity check. */
export const BLOCKED_DOMAIN_COUNT = Object.keys(BLOCKED_DOMAINS).length;

// ── What the QUERY GENERATOR must be told ────────────────────────────────────
//
// ⚠️ This filter used to run downstream of a prompt that actively ASKED for the things it
// drops. discovery-query-gen.ts described niche_scrape as "directories, maps, best X in Y
// style" and intent_signal as "hiring pages, recent press, public reviews" — so a live prod
// run duly produced `site:trustpilot.com OR site:g2.com`, `site:linkedin.com/jobs`,
// `inurl:careers OR inurl:jobs` and `best social media agencies UK ... directories`. Every
// result was then correctly discarded here or scored cold. We paid Serper for searches whose
// results could not possibly survive.
//
// Exporting the vocabulary means the prompt is BUILT from the same data that enforces it. A
// category added above reaches the generator on the next run with no second edit.

/**
 * Domains a query strategist actually reaches for, listed first when the prompt quotes examples.
 *
 * ⚠️ Without this the prompt sampled each category in declaration order and named yelp.com and
 * thomsonlocal.com while omitting g2.com and crunchbase.com — the ones the prod run genuinely
 * targeted (`site:trustpilot.com OR site:g2.com`, `site:linkedin.com/jobs`). Examples exist to
 * teach the rule, so they have to be the traps, not the alphabet. Anything here MUST also be in
 * BLOCKED_DOMAINS; a test asserts that, because naming a domain we then keep is worse than
 * silence.
 */
const PROMPT_PRIORITY_EXAMPLES: readonly string[] = [
    'linkedin.com', 'reddit.com', 'facebook.com', 'instagram.com', 'youtube.com',
    'trustpilot.com', 'g2.com', 'capterra.com', 'crunchbase.com', 'glassdoor.com', 'yelp.com',
    'medium.com', 'substack.com', 'forbes.com', 'techcrunch.com',
    'wikipedia.org', 'quora.com',
    'indeed.com', 'reed.co.uk', 'greenhouse.io',
];

/**
 * Blocked domains grouped by category — the generator quotes a sample of each as a prohibition.
 * Within each category the priority examples above come first, then declaration order.
 */
export function excludedDomainsByCategory(): Record<ExclusionCategory, string[]> {
    const out = {} as Record<ExclusionCategory, string[]>;
    for (const [domain, category] of Object.entries(BLOCKED_DOMAINS)) {
        (out[category] ||= []).push(domain);
    }
    for (const category of Object.keys(out) as ExclusionCategory[]) {
        out[category].sort((a, b) => {
            const ia = PROMPT_PRIORITY_EXAMPLES.indexOf(a);
            const ib = PROMPT_PRIORITY_EXAMPLES.indexOf(b);
            if (ia === -1 && ib === -1) return 0;   // both unranked: keep declaration order
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
        });
    }
    return out;
}

/** The curated examples, exported so a test can assert each one is genuinely blocked. */
export const PROMPT_EXAMPLE_DOMAINS: readonly string[] = PROMPT_PRIORITY_EXAMPLES;

/** Publishing/support subdomains that are never a company home (blog., careers., jobs., …). */
export const EXCLUDED_SUBDOMAINS: readonly string[] = NON_COMPANY_SUBDOMAINS;

/**
 * Plain-English shapes the title heuristics reject, for the prompt to avoid ASKING for.
 *
 * Written out rather than derived from CONTENT_TITLE_PATTERNS because a RegExp source is not
 * an instruction a model can follow — `/\btop\s*\d+\b/` means nothing to it, "a ranked
 * listicle such as Top 10 …" does.
 *
 * ⚠️ Pinned to the DISTINCT REASONS below, not to the pattern count: two patterns share the
 * reason 'title is a ranked listicle', so there are ten patterns and nine shapes. The test
 * compares against the deduplicated reasons, so adding a pattern with a genuinely new reason
 * fails until a phrase for it is added here.
 */
export const EXCLUDED_TITLE_SHAPES: readonly string[] = [
    'PDF documents',
    'guides ("The guide to …", "A guide to …")',
    'ranked listicles ("Top 10 …", "Best 5 …")',
    'downloadable templates, checklists or worksheets',
    'how-to articles',
    'explainers ("What is …", "Why you should …")',
    'ultimate/complete guides',
    'case studies and white papers',
    'directory and listing pages',
];

/** Distinct rejection reasons across the title heuristics — one per shape described above. */
export const CONTENT_TITLE_REASONS: readonly string[] =
    [...new Set(CONTENT_TITLE_PATTERNS.map(([, reason]) => reason))];
