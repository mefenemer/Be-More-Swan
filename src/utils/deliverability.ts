// src/utils/deliverability.ts
// Whether this is likely to arrive, said only where we actually know something.
//
// ⚠️ THERE IS NO SPAM SCORE HERE, AND THERE MUST NOT BE ONE. A number between 0 and 10 implies a
// model of what the receiving filter will do, and we have no such model — Gmail's filter is not
// SpamAssassin, it is not public, and it weighs sender reputation far more heavily than anything
// visible in the message. A made-up score would be acted on: somebody would rewrite good copy to
// move a number that means nothing. So this module produces NAMED, EXPLAINED findings, each of
// which a person can agree or disagree with, and no total.
//
// Three things we genuinely know, and they are the three that matter most for a small sender:
//   1. What the gatekeepers have PUBLISHED as their limits (complaint and bounce rates).
//   2. How old the sending domain is, and therefore how much volume is reasonable today.
//   3. Structural facts about the message itself — is there text, are there more links than words.

// ⚠️ Section 3 (the message itself) LIVES IN src/public/newsletter-findings.js, not here. The
// browser has to recompute those findings as the author types — "there are only 0 words of text"
// is worse than useless if it only updates on reload — and a hand-written browser copy of this
// logic drifts. Plain .js, UMD-ish, imported here and <script>-loaded there: one implementation,
// two runtimes. Same pattern as src/public/marked-bms-directives.js.
export type { Finding, FindingSeverity } from '../public/newsletter-findings.js';
export { contentFindings, severityRank, countWords } from '../public/newsletter-findings.js';

import type { Finding } from '../public/newsletter-findings.js';

// ── 1. List health ──────────────────────────────────────────────────────────
//
// ⚠️ These are the thresholds Gmail and Yahoo PUBLISHED for bulk senders in 2024, not numbers we
// invented. Quoting somebody else's published line is the difference between "we think this looks
// high" and "this is above the level at which Gmail says it will start filtering you".

/** Gmail's stated ceiling. Above this, filtering is explicitly on the table. */
export const COMPLAINT_RATE_LIMIT = 0.003;      // 0.3%
/** Gmail's stated target — the level to actually aim for. */
export const COMPLAINT_RATE_TARGET = 0.001;     // 0.1%
/** Not a published figure: the point at which a list is clearly stale enough to act on. */
export const BOUNCE_RATE_WARN = 0.02;           // 2%
export const BOUNCE_RATE_SEVERE = 0.05;         // 5%
/** Below this, a rate is one or two people and means nothing. */
export const MIN_SAMPLE_FOR_RATES = 200;

export interface ListHealthInput {
    delivered: number;
    bounced: number;
    complained: number;
}

export function listHealthFindings(input: ListHealthInput): Finding[] {
    const out: Finding[] = [];
    const total = Math.max(0, input.delivered) + Math.max(0, input.bounced);
    if (total < MIN_SAMPLE_FOR_RATES) {
        // ⚠️ Said plainly rather than shown as 0%. Two bounces out of thirty is 6.7%, which would
        // read as a crisis and is actually two bounces.
        return [{
            code: 'too_few_to_judge',
            severity: 'note',
            message: `Not enough has been sent yet to judge these rates — they start meaning something after about ${MIN_SAMPLE_FOR_RATES} emails.`,
        }];
    }

    const complaintRate = input.complained / total;
    const bounceRate = input.bounced / total;

    if (complaintRate > COMPLAINT_RATE_LIMIT) {
        out.push({
            code: 'complaints_over_limit',
            severity: 'blocker',
            message: `${(complaintRate * 100).toFixed(2)}% of recent emails were marked as spam. Gmail's published limit for bulk senders is 0.3%, and above it they say they will start filtering. Stop sending to anyone who has not opened in a long while, and check where these addresses came from.`,
        });
    } else if (complaintRate > COMPLAINT_RATE_TARGET) {
        out.push({
            code: 'complaints_over_target',
            severity: 'warning',
            message: `${(complaintRate * 100).toFixed(2)}% of recent emails were marked as spam. Gmail asks bulk senders to stay under 0.1%; you are under their 0.3% limit but above the level they aim for.`,
        });
    }

    if (bounceRate > BOUNCE_RATE_SEVERE) {
        out.push({
            code: 'bounces_severe',
            severity: 'blocker',
            message: `${(bounceRate * 100).toFixed(1)}% of recent emails bounced. A rate this high usually means a bought or very old list, and continuing to send from this domain will damage it for your ordinary email too.`,
        });
    } else if (bounceRate > BOUNCE_RATE_WARN) {
        out.push({
            code: 'bounces_high',
            severity: 'warning',
            message: `${(bounceRate * 100).toFixed(1)}% of recent emails bounced. Above about 2% is worth investigating — usually addresses that have been on the list a long time.`,
        });
    }

    if (!out.length) {
        out.push({
            code: 'healthy',
            severity: 'note',
            message: `${(complaintRate * 100).toFixed(2)}% marked as spam and ${(bounceRate * 100).toFixed(1)}% bounced — both comfortably inside what the big providers ask for.`,
        });
    }
    return out;
}

// ── 2. Warm-up ──────────────────────────────────────────────────────────────

/**
 * How much it is reasonable to send from a domain this old, today.
 *
 * ⚠️ GUIDANCE, NOT A RULE, and nothing enforces it. A brand-new sending domain has no reputation,
 * and a first send of ten thousand looks exactly like a spammer who has just bought a domain — the
 * providers throttle or bin it, and the damage lands on the domain rather than on the campaign. The
 * curve below is the ordinary industry shape (start small, roughly double every couple of days,
 * full volume in two to three weeks); it is advice a tenant can overrule, because their list may
 * genuinely be engaged and we cannot see that from here.
 */
export const WARMUP_START = 200;
export const WARMUP_FULL_DAYS = 21;

export function warmupLimitFor(verifiedAt: Date | null | undefined, now = new Date()): number | null {
    if (!verifiedAt) return WARMUP_START;
    const days = Math.floor((now.getTime() - verifiedAt.getTime()) / (24 * 60 * 60 * 1000));
    if (days >= WARMUP_FULL_DAYS) return null;              // no ceiling worth stating any more
    if (days <= 0) return WARMUP_START;
    // Doubling every two days from the starting figure.
    return Math.round(WARMUP_START * Math.pow(2, days / 2));
}

export function warmupFinding(args: {
    verifiedAt: Date | null | undefined;
    recipientCount: number;
    now?: Date;
}): Finding | null {
    const limit = warmupLimitFor(args.verifiedAt, args.now);
    if (limit === null || args.recipientCount <= limit) return null;
    const days = args.verifiedAt
        ? Math.max(0, Math.floor(((args.now ?? new Date()).getTime() - args.verifiedAt.getTime()) / 86400000))
        : 0;
    return {
        code: 'warmup_exceeded',
        severity: 'warning',
        message: `This would send ${args.recipientCount.toLocaleString()} emails from a domain verified ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}. A new domain has no reputation yet, so around ${limit.toLocaleString()} is a safer maximum for today — a first send much larger than that looks like a domain somebody has just bought, and the providers act accordingly. Sending in a few smaller batches over the next fortnight protects the domain your ordinary email uses too.`,
    };
}

// ── 3. The message itself ───────────────────────────────────────────────────
//
// See the re-export at the top of this file: contentFindings() and severityRank() are defined in
// src/public/newsletter-findings.js so the Studio can run them live in the browser. Everything
// that made them what they are — no score, no trigger-word list — is documented there.
