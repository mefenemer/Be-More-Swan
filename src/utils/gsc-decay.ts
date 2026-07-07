// src/utils/gsc-decay.ts
// Pure helpers for the Google Search Console content-decay loop (US 5.1). Kept separate from the
// cron (ingest-gsc-metrics.ts) so the maths is unit-testable without a live GSC connection.

/** The GSC query window, offset by a lag because Search Console data trails ~2-3 days. */
export function gscDateRange(lookbackDays: number, lagDays: number, now: Date = new Date()): { startDate: string; endDate: string } {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() - lagDays);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - lookbackDays);
    return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * Match a page URL to the most specific GSC property that covers it. Handles both URL-prefix
 * properties (`https://blog.example.com/`) and domain properties (`sc-domain:example.com`);
 * prefers a URL-prefix match, and the longest one, over a domain match.
 */
export function matchProperty(pageUrl: string, properties: string[]): string | null {
    let host: string;
    try { host = new URL(pageUrl).host; } catch { return null; }

    let bestPrefix: string | null = null;
    let domainMatch: string | null = null;
    for (const prop of properties) {
        if (prop.startsWith('sc-domain:')) {
            const domain = prop.slice('sc-domain:'.length);
            if (host === domain || host.endsWith('.' + domain)) domainMatch = prop;
        } else if (pageUrl.startsWith(prop)) {
            if (!bestPrefix || prop.length > bestPrefix.length) bestPrefix = prop;
        }
    }
    return bestPrefix ?? domainMatch;
}

export interface DecayInput {
    /** The stored peak visibility (traffic_baseline), or null on first observation. */
    baseline: number | null;
    /** This window's metric (search impressions). */
    current: number;
    /** Ignore posts below this baseline — too little traffic for the ratio to mean anything. */
    minBaseline: number;
    /** Flag decay when current < baseline * decayRatio (e.g. 0.6 = a 40% drop from peak). */
    decayRatio: number;
}

export interface DecayResult {
    /** The baseline to persist — tracks the running peak. */
    newBaseline: number;
    /** True when the post has decayed enough to warrant an update ticket. */
    decayed: boolean;
}

export function evaluateDecay({ baseline, current, minBaseline, decayRatio }: DecayInput): DecayResult {
    if (baseline == null) return { newBaseline: current, decayed: false }; // first observation seeds the baseline
    const newBaseline = Math.max(baseline, current);
    const decayed = baseline >= minBaseline && current < baseline * decayRatio;
    return { newBaseline, decayed };
}
