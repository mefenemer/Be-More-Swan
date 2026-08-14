// src/utils/current-date-prompt.ts
// Tells the model what day it is.
//
// Nothing in the generation path ever stated the date, so every prompt asked a model to write
// "today's" post with no idea when today was. A model with no date in context falls back to the
// densest year in its training data — which is why drafts kept dating themselves 2025: captions
// saying "in 2025", "this year", seasonal hooks for the wrong season, and "as of" lines a year out.
// There is no model setting that fixes this; the date has to be in the prompt.
//
// This is the DYNAMIC counterpart to the static prompt constants (CONTENT_QUALITY_STANDARDS,
// AURA_SAFE_CONTENT_BENCHMARK) — same idea of one editable place, but it must be a function
// because the answer changes every day, so it lives in utils/ beside the other prompt builders
// (blueprint-prompt.ts, platform-strategy-brief.ts, operational-setup.ts) rather than constants/.
//
// Two dates matter and they are NOT the same one. Drafts are generated ahead of their slot
// (draft-horizon-fill.ts stamps target_publish_date days or weeks out), so a post written today
// is READ on its publish date. "This week", "right now" and any seasonal framing belong to the
// publish date; only genuine "as of" statements belong to today. Callers with a slot should pass
// it — a post drafted on 30 December for a 4 January slot otherwise opens with the wrong year.

/** IANA zone used when the caller has none, or supplies one Intl rejects. */
const FALLBACK_TIMEZONE = 'UTC';

export interface CurrentDateOptions {
    /** The slot this content is scheduled for. Omit/null for on-demand work with no slot. */
    publishDate?: Date | string | null;
    /** IANA tz id (e.g. 'Europe/London'). Anything Intl rejects degrades to UTC. */
    timezone?: string | null;
    /** Test seam — the current instant. Defaults to now. */
    now?: Date;
}

/**
 * Resolve a usable IANA zone. An invalid id makes Intl throw a RangeError, and posting_timezone
 * is user-editable free text on onboarding_context, so a typo there must not take down a draft
 * over a formatting nicety — degrade to UTC instead.
 */
function safeTimezone(timezone: string | null | undefined): string {
    const tz = (timezone ?? '').trim();
    if (!tz) return FALLBACK_TIMEZONE;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date());
        return tz;
    } catch {
        return FALLBACK_TIMEZONE;
    }
}

/** 'Thursday, 13 August 2026' — spelled out, because an ambiguous 08/13 reads differently per locale. */
function formatLongDate(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone,
    }).format(date);
}

/**
 * The year IN THE TARGET ZONE, not the server's. Late on 31 December in London the UTC year has
 * already rolled over (and vice versa west of Greenwich) — getFullYear() would state the wrong
 * one on exactly the day the year is most likely to end up in the copy.
 */
function yearIn(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone }).format(date);
}

function toDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A prompt block stating today's date, the current year, and (when known) the date the content
 * publishes. Inject it into the system prompt of anything that writes dated copy.
 *
 * Deliberately explicit about the failure mode rather than just stating a date: a bare
 * "Today is <date>" line still leaves the model free to write "2025" further down, because it
 * never connects the stated date to the year it is about to type. Naming the wrong-year habit
 * is what stops it.
 */
export function currentDatePromptBlock(opts: CurrentDateOptions = {}): string {
    const tz = safeTimezone(opts.timezone);
    const now = opts.now ?? new Date();
    const publishDate = toDate(opts.publishDate);

    const year = yearIn(now, tz);
    const lines = [
        'CURRENT DATE — your training data ends before today, so you MUST use the dates below and never assume the year:',
        `- Today's date is ${formatLongDate(now, tz)} (${tz}).`,
        `- The current year is ${year}. Whenever you write "this year", a copyright line, an "as of" date, a trend reference or a year in a title, it is ${year} — never an earlier year from your training data.`,
    ];

    if (publishDate) {
        // Only worth saying when it is actually a different day; on a same-day slot the extra
        // line just restates today and dilutes the block.
        const publishDay = formatLongDate(publishDate, tz);
        if (publishDay !== formatLongDate(now, tz)) {
            lines.push(
                `- This content is scheduled to publish on ${publishDay}. Write it to be read on that date: "today", "this week", "right now" and any seasonal, holiday or weather reference must fit ${publishDay}, not the date you are writing on.`,
            );
        }
    }

    lines.push('- Do NOT state a specific date or year that is not given to you here or in the provided context.');

    return lines.join('\n');
}
