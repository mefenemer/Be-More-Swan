// src/utils/autonomous-draft-brief.ts
//
// The slot choice and the brief for netlify/functions/autonomous-media-suggestions.ts — the daily
// cron that drafts a complete post (copy + image) into an empty slot.
//
// WHY THIS EXISTS (prod org 43, found 2026-10-18). That cron wrote its copy from two strings: the
// business NAME and the assistant's name. Nothing else reached the model — no description, audience,
// pillars, tone, core message or offer. "DMV Vital Roots", an emotional-state coaching practice, got
// 21 near-identical posts about a food / heritage wellness shop ("Your roots run deeper than you
// know. 🌿 … Stop by"), invented from the name alone, with no pillar recorded. And it filled the
// first day with NO post on it, so the days the owner chose not to post on (her schedule is
// weekdays only) were filled too — weekends got posts she never asked for.
//
// Now:
//   · the slot is one of the assistant's own posting slots (computeScheduleSlots — the same days,
//     times and timezone the scheduled path uses), so this cron can never add to the cadence, only
//     cover a slot the scheduled path has not filled yet;
//   · the brief carries the owner's own words, a least-used pillar (recorded on the post), the
//     voice rules, the date and the quality + safety blocks the scheduled path appends;
//   · with no brief at all there is no draft — a post invented from a name is worse than none.

import { computeScheduleSlots, resolvePostingSchedule } from '../config/posting-cadence';
import { parsePillars } from '../public/content-pillars.js';
import { voiceDirective } from './voice-profile';
import { currentDatePromptBlock } from './current-date-prompt';
import { CONTENT_QUALITY_STANDARDS } from '../constants/content-quality';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../constants/safety-benchmark';
import { safeSlice } from './text-safe';

type Ctx = Record<string, unknown>;

/** The organisation's own description of itself (organisations columns). */
export interface AutonomousOrgFacts {
    name: string | null;
    industry?: string | null;
    businessDescription?: string | null;
    targetAudience?: string | null;
    websiteUrl?: string | null;
}

function text(v: unknown, max = 1200): string {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t ? safeSlice(t, max) : '';
}

/** YYYY-MM-DD of an instant in the given IANA zone (UTC when the zone is unusable). */
export function localDateKey(d: Date, timeZone: string): string {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

/**
 * The first of the assistant's own posting slots inside the horizon whose day has nothing planned,
 * or null (on-demand cadence, nothing in the horizon, or every slot day already covered).
 * `plannedDates` are the publish dates of posts already planned in the window.
 */
export function pickAutonomousSlot(args: {
    onboardingContext: unknown;
    horizonDays: number;
    plannedDates: Date[];
    now?: Date;
}): Date | null {
    const schedule = resolvePostingSchedule((args.onboardingContext ?? {}) as Ctx);
    const slots = computeScheduleSlots({ schedule, horizonDays: args.horizonDays, now: args.now });
    const covered = new Set(args.plannedDates.map((d) => localDateKey(new Date(d), schedule.timezone)));
    return slots.find((s) => !covered.has(localDateKey(s, schedule.timezone))) ?? null;
}

/**
 * The pillar for this slot: one of those used least over the recent posts, spread by the slot's day
 * (the same rule process-content-jobs uses). Null when the owner has set no pillars.
 */
export function pickPillar(onboardingContext: unknown, usage: Record<string, number>, slot: Date): string | null {
    const pillars = parsePillars(((onboardingContext ?? {}) as Ctx).content_pillars);
    if (!pillars.length) return null;
    const count = (p: string) => usage[p] ?? 0;
    const least = Math.min(...pillars.map(count));
    const candidates = pillars.filter((p) => count(p) === least);
    const dayIndex = Math.floor(slot.getTime() / 86_400_000);
    return candidates[dayIndex % candidates.length];
}

/** The owner's own words about the business, as labelled brief lines. Empty when there are none. */
export function briefLines(org: AutonomousOrgFacts, onboardingContext: unknown): string[] {
    const c = (onboardingContext ?? {}) as Ctx;
    const lines: [string, string][] = [
        ['What the business does', text(org.businessDescription)],
        ['Industry', text(org.industry, 120)],
        ['Who the posts are for', text(c.target_audience) || text(org.targetAudience)],
        ['Core message', text(c.core_message)],
        ['Services and offers', text(c.service_offerings)],
        ['Incentive / offer', text(c.incentive, 600)],
        ['Call to action', text(c.cta, 300)],
        ['Website', text(org.websiteUrl, 200)],
    ];
    return lines.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
}

/**
 * Enough to write about THIS business rather than one guessed from its name: a description, a core
 * message, services, or pillars. Industry, audience, CTA and website alone are not.
 */
export function hasUsableBrief(org: AutonomousOrgFacts, onboardingContext: unknown): boolean {
    const c = (onboardingContext ?? {}) as Ctx;
    return Boolean(
        text(org.businessDescription) || text(c.core_message) || text(c.service_offerings)
        || parsePillars(c.content_pillars).length,
    );
}

/** The system prompt for one autonomous draft. */
export function buildAutonomousDraftSystem(args: {
    org: AutonomousOrgFacts;
    assistantName: string;
    platformLabel: string;
    onboardingContext: unknown;
    pillar: string | null;
    slot: Date;
}): string {
    const c = (args.onboardingContext ?? {}) as Ctx;
    const orgName = text(args.org.name, 200) || 'the business';
    const schedule = resolvePostingSchedule(c);
    const parts: string[] = [
        `You are ${args.assistantName}, the social media manager for "${orgName}". Write one ${args.platformLabel} post for this business.`,
        currentDatePromptBlock({ publishDate: args.slot, timezone: schedule.timezone }),
        [
            'ABOUT THE BUSINESS — in the owner\'s own words. Write ONLY about this business, its audience and what it offers.',
            'Never guess what the business does from its name, and never invent products, services, locations, prices or a shop to visit.',
            ...briefLines(args.org, c),
        ].join('\n'),
    ];
    if (args.pillar) {
        parts.push(`Content Pillar for THIS post — write it under this pillar: "${args.pillar}".`);
    }
    parts.push(voiceDirective(c.tone_of_voice, { surface: 'social', fallback: 'professional', voice: c.voice }));
    parts.push(CONTENT_QUALITY_STANDARDS);
    parts.push(AURA_SAFE_CONTENT_BENCHMARK);
    parts.push('Respond ONLY with minified JSON: {"caption": string, "hashtags": string (space-separated, 3-6 tags), "imagePrompt": string (a vivid photographic description for an AI image generator, no text/words in image)}. The visual rules above apply to "imagePrompt".');
    return parts.filter(Boolean).join('\n\n');
}
