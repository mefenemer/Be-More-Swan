// src/lib/robots.ts
// A robots.txt courtesy check for the lead crawler.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Contact enrichment reads strangers' websites — up to four pages per prospect, on our schedule,
// for a company that never asked to hear from us. Nothing in the product read robots.txt, which is
// the one signal a site owner has for saying "not this". The volume was never the problem (a handful
// of page reads per lead); being unable to say we honour the standard was.
//
// ⚠️ NOT a security control and not a rate limiter. It answers one question — "has this site asked
// crawlers to stay out of this path?" — and it FAILS OPEN on every uncertainty: no robots.txt, an
// unparseable one, a timeout, a 500. A site that cannot tell us its rules has not set any, and
// treating an unreachable robots.txt as "deny everything" would silently switch enrichment off for
// exactly the sites whose servers are flaky.
//
// ── The subset of the standard we implement ──────────────────────────────────
// `User-agent` grouping, `Disallow`, `Allow`, and longest-match-wins between the two (the de facto
// Google rule). Deliberately NOT implemented:
//   • `Crawl-delay` — we make at most four sequential requests to a host inside one lead's budget
//     and never revisit unprompted, so there is nothing for a delay to pace.
//   • wildcards beyond a leading path match and a trailing `$` — the long tail of pattern syntax is
//     where robots parsers grow bugs, and a parser that is wrong is worse than one that is narrow.
// Anything we do not understand is ignored, which biases towards fetching. That bias is stated
// rather than accidental: this is politeness, and an over-eager reading of a directive we
// half-parsed could refuse a page the owner explicitly allowed.

import { safeFetchText, USER_AGENTS } from '../utils/safe-fetch';

/** robots.txt is small by convention; anything larger is not a rules file we should be reading. */
const MAX_BYTES = 64 * 1024;

/** One host, one short attempt. Enrichment's own per-lead budget is the real ceiling. */
const TIMEOUT_MS = 3000;

/**
 * The token we match `User-agent:` groups against, lowercased.
 *
 * The product name without the version, because that is what a site owner would type into their own
 * robots.txt after seeing us in their logs — matching on the full `BeMoreSwan-LeadDiscovery/1.0`
 * string would mean their rule stopped working the day we bumped a version number.
 */
const OUR_TOKEN = 'bemoreswan-leaddiscovery';

interface Rule { path: string; allow: boolean }

/**
 * Parsed rules per host for the life of this process.
 *
 * A discovery run enriches a batch of leads and each lead reads several paths on one host, so
 * without this the same robots.txt would be fetched four times per prospect. Bounded by the number
 * of distinct hosts a single invocation touches, which is the batch size — a function instance is
 * short-lived, so there is no eviction policy to get wrong.
 *
 * `null` means "fetched, and there are no rules for us" — cached just as firmly as a rule set, so a
 * site with no robots.txt is not re-fetched on every path.
 */
const cache = new Map<string, Rule[] | null>();

/**
 * Extract the rules that apply to us.
 *
 * Group selection follows the standard: if any group names us specifically, ONLY that group applies
 * and the `*` group is ignored entirely. Otherwise the `*` group applies. A site that has written
 * rules for us has taken the trouble to be specific, and folding the generic rules back in would
 * override what they actually said.
 */
export function parseRobots(text: string): Rule[] {
    const specific: Rule[] = [];
    const wildcard: Rule[] = [];
    let matched: 'none' | 'specific' | 'wildcard' = 'none';

    for (const rawLine of text.split(/\r?\n/)) {
        // Comments run to end of line, and a directive is `field: value`.
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        if (field === 'user-agent') {
            const token = value.toLowerCase();
            // ⚠️ Consecutive User-agent lines form ONE group ("User-agent: a" / "User-agent: b" /
            // "Disallow: /x" applies to both), which is why this sets the target rather than
            // resetting it — and why a specific match is sticky for the group that follows.
            if (token === OUR_TOKEN) matched = 'specific';
            else if (token === '*' && matched !== 'specific') matched = 'wildcard';
            else if (matched !== 'specific') matched = 'none';
            continue;
        }

        if (field !== 'disallow' && field !== 'allow') continue;
        if (matched === 'none') continue;

        // `Disallow:` with an empty value means "nothing is disallowed" — it is the standard's way of
        // allowing everything, and treating it as a path would block the entire site.
        if (field === 'disallow' && !value) continue;

        const rule: Rule = { path: value, allow: field === 'allow' };
        if (matched === 'specific') specific.push(rule); else wildcard.push(rule);
    }

    return specific.length ? specific : wildcard;
}

/**
 * Does a rule set permit this path? Longest matching rule wins; a tie goes to Allow.
 *
 * The tie-break matters: `Allow: /contact` alongside `Disallow: /contact` is a site owner carving out
 * an exception, and resolving it the other way would ignore the more specific intent.
 */
export function robotsAllowsPath(rules: Rule[] | null, path: string): boolean {
    if (!rules || !rules.length) return true;

    let best: Rule | null = null;
    for (const rule of rules) {
        const pattern = rule.path;
        if (!pattern) continue;

        // A trailing `$` anchors the match to the end of the path — the one wildcard form common
        // enough to be worth supporting (`Disallow: /*.pdf$`).
        const anchored = pattern.endsWith('$');
        const body = anchored ? pattern.slice(0, -1) : pattern;
        // A leading `*` or an internal one is treated as a literal prefix up to the wildcard: we
        // match what we understand and ignore the rest, which biases towards fetching.
        const prefix = body.split('*')[0];

        const hit = anchored && !body.includes('*') ? path === body : path.startsWith(prefix);
        if (!hit) continue;

        if (!best || prefix.length > best.path.length || (prefix.length === best.path.length && rule.allow)) {
            best = { path: prefix, allow: rule.allow };
        }
    }
    return best ? best.allow : true;
}

/**
 * Fetch (once per host) and cache the rules that apply to us.
 *
 * Never throws: every failure resolves to null, which robotsAllowsPath reads as "no rules".
 */
async function rulesFor(host: string): Promise<Rule[] | null> {
    if (cache.has(host)) return cache.get(host) ?? null;

    let rules: Rule[] | null = null;
    try {
        const { body } = await safeFetchText(`https://${host}/robots.txt`, {
            timeoutMs: TIMEOUT_MS,
            maxBytes: MAX_BYTES,
            userAgent: USER_AGENTS.leadDiscovery,
        });
        const parsed = parseRobots(body);
        rules = parsed.length ? parsed : null;
    } catch {
        // No robots.txt, a redirect loop, a timeout, an HTML 404 page — all mean the same thing to
        // us: this site has not told us to stay out. Logged nowhere on purpose; a missing robots.txt
        // is the common case and would drown the discovery logs.
        rules = null;
    }
    cache.set(host, rules);
    return rules;
}

/**
 * May the lead crawler fetch this path on this host?
 *
 * Fails open, including on our own bugs — an exception here must never stop enrichment, which is a
 * paid feature doing legitimate work. The check is a courtesy we owe the site owner, not a gate on
 * our own correctness.
 */
export async function robotsAllows(host: string, path: string): Promise<boolean> {
    try {
        return robotsAllowsPath(await rulesFor(host), path || '/');
    } catch {
        return true;
    }
}

/** Test seam: the cache is process-wide, and a test that ran second would read the first's answers. */
export function _resetRobotsCache(): void {
    cache.clear();
}
