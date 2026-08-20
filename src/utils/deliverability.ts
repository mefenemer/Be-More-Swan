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

export type FindingSeverity = 'blocker' | 'warning' | 'note';

export interface Finding {
    code: string;
    severity: FindingSeverity;
    /** Written for the tenant. Says what is wrong AND why it matters. */
    message: string;
}

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

const WORDS = (s: string) => (String(s || '').trim().match(/\S+/g) || []).length;

/**
 * Structural findings about one issue. Explainable, individually arguable, and never totalled.
 *
 * ⚠️ NO TRIGGER-WORD LIST. "Free", "act now" and the rest are folklore from filters that were
 * retired a decade ago; modern filtering weighs sender reputation and engagement far above
 * vocabulary. A warning about the word "free" would make a tenant rewrite a perfectly good offer
 * for no benefit, which is worse than saying nothing.
 */
export function contentFindings(issue: {
    subject: string;
    text: string;
    html: string;
}): Finding[] {
    const out: Finding[] = [];
    const subject = String(issue.subject || '');
    const letters = subject.replace(/[^A-Za-z]/g, '');
    const capsRatio = letters ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;

    if (letters.length >= 8 && capsRatio > 0.6) {
        out.push({
            code: 'subject_shouting',
            severity: 'warning',
            message: 'The subject line is mostly capitals. It reads as shouting to a person and is one of the few surface features filters still weigh.',
        });
    }
    if (/[!?]{2,}/.test(subject)) {
        out.push({
            code: 'subject_punctuation',
            severity: 'warning',
            message: 'The subject line has repeated exclamation or question marks. One is emphasis; three is a pattern filters associate with bulk mail.',
        });
    }
    if (subject.trim().length > 90) {
        out.push({
            code: 'subject_long',
            severity: 'note',
            message: 'The subject line is long enough that most phones will cut it off. It will not hurt delivery, but the end of it will not be read.',
        });
    }
    if (!subject.trim()) {
        out.push({
            code: 'subject_missing',
            severity: 'blocker',
            message: 'There is no subject line.',
        });
    }

    const textWords = WORDS(issue.text);
    const images = (String(issue.html || '').match(/<img\b/gi) || []).length;
    const links = (String(issue.html || '').match(/<a\b[^>]*href=/gi) || []).length;

    if (textWords < 20) {
        out.push({
            code: 'thin_text',
            severity: 'warning',
            message: `There are only ${textWords} words of text. A message that is almost all pictures, or almost empty, is a shape filters treat with suspicion — and it reads as broken to anyone whose client blocks images.`,
        });
    }
    if (images >= 3 && textWords < images * 25) {
        out.push({
            code: 'image_heavy',
            severity: 'note',
            message: 'There is a lot of image compared to text. Anyone whose email client blocks images by default — which is most work accounts — will see very little.',
        });
    }
    if (links >= 10 && links > textWords / 25) {
        out.push({
            code: 'link_dense',
            severity: 'note',
            message: `There are ${links} links in a fairly short email. Link-heavy messages are more likely to be filtered, and readers click less when given more choices.`,
        });
    }
    return out;
}

/** Everything, in one call, for the surface that shows it. */
export function severityRank(f: Finding): number {
    return f.severity === 'blocker' ? 0 : f.severity === 'warning' ? 1 : 2;
}
