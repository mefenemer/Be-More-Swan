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
    'companieshouse.gov.uk', 'dnb.com', 'bloomberg.com');

block('media',
    'bbc.co.uk', 'bbc.com', 'theguardian.com', 'nytimes.com', 'forbes.com', 'ft.com',
    'telegraph.co.uk', 'independent.co.uk', 'dailymail.co.uk', 'businessinsider.com',
    'techcrunch.com', 'wired.com', 'cnn.com', 'reuters.com', 'huffpost.com', 'vox.com',
    'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'wix.com');

block('reference',
    'wikipedia.org', 'wikimedia.org', 'quora.com', 'stackexchange.com', 'stackoverflow.com',
    'britannica.com', 'statista.com', 'researchgate.net', 'scribd.com', 'slideshare.net');

block('jobs',
    'indeed.com', 'indeed.co.uk', 'monster.com', 'totaljobs.com', 'reed.co.uk',
    'ziprecruiter.com', 'seek.com.au', 'workable.com', 'greenhouse.io', 'lever.co');

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

/** Convenience for logging/metrics: the built-in blocklist size, for a sanity check. */
export const BLOCKED_DOMAIN_COUNT = Object.keys(BLOCKED_DOMAINS).length;
