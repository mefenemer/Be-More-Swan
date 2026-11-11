// src/config/task-weights.ts
// What each kind of work is, and the pure rules for reading a cost — no database here, so anything can
// import it (see docs/task-metering.md).
//
// ⚠️ The numbers customers are charged live in the DATABASE (db/z-task-costs.sql), and a super admin
// changes them in Admin → Money → Task costs. Read them with getTaskCosts() from src/utils/task-costs.ts.
// DEFAULT_TASK_COSTS below is only what metering falls back to when the database cannot be read at all:
// editing it does not change what anyone is charged while the table is there.
//
// A task is one finished piece of work. Most work is 1. The few outputs that cost us real money per
// item are weighted so one allowance can cover them without a second meter: an AI video or music
// track (~20–30p of provider cost each) and an X post carrying a link (X bills ~$0.20 for one).
// A plain X text post costs nothing extra — it is part of the social post's own task.

import { switchedOn } from './dated-switch';

export const DEFAULT_TASK_WEIGHTS = {
    social_post: 1,
    blog_article: 1,
    lead_search: 1,
    email_issue: 1,
    email_campaign: 1,
    outreach_email: 1,
    site_audit: 1,
    site_draft: 1,
    site_words: 1,
    ai_image: 1,
    ai_video: 20,
    ai_music: 20,
    // A track the user marks as shareable keeps today's 3:5 discount against a private one.
    ai_music_shared: 12,
    // A voiceover (Video Producer plan, Phase 2, decided 2026-10-31: 1 per video). Costs us cents.
    ai_voiceover: 1,
    x_link_post: 10,
    // The Business Mentor's background work (docs/business-mentor-plan.md §2.1, decided: 1 task each).
    mentor_research: 1,
    mentor_strategy: 1,
    mentor_review: 1,
    // "Draft the words" for a printed flyer (docs/brand-designer-flyers-plan.md §3.7). Drawing the pages is free.
    flyer_words: 1,
    // Taking the background out of a picture in the design editor (owner, 2026-11-06): a paid AI call per picture.
    background_removal: 1,
    // The Video Producer reviewing the owner's own footage (owner decision D-F1, 2026-11-09): frames
    // read by AI plus the sound transcribed. Charged once per review that analyses a new video;
    // suggesting again from the same analysis is free (src/utils/footage-review.ts).
    footage_review: 2,
    // Behind basicWorkCharged below (docs/basic-work-charging.md).
    chat_messages: 1,
    editing_helper: 1,
    design_round: 1,
    finished_design: 1,
} as const;

/** What one charge bought — logged on every task_ledger row so a disputed count can be explained. */
export type WorkKind = keyof typeof DEFAULT_TASK_WEIGHTS;

/** Every number a super admin can set: a weight per kind of work, and the two rates. */
export interface TaskCosts {
    weights: Record<WorkKind, number>;
    /** AI video by length: tasks for each second, once per-second pricing is on. */
    videoTasksPerSecond: number;
    /** Chat costs one task (weights.chat_messages) per this many delivered messages. */
    chatMessagesPerTask: number;
}

export const DEFAULT_TASK_COSTS: TaskCosts = {
    weights: { ...DEFAULT_TASK_WEIGHTS },
    videoTasksPerSecond: 4,
    chatMessagesPerTask: 10,
};

/**
 * Chat, editing helpers, free design rounds and finished designs start costing tasks on this switch
 * (owner, 2026-11-06). Terms 5.4 promise they do not, so it needs 30 days' notice first.
 * Netlify env BASIC_WORK_CHARGED_FROM: 'on', or the date it starts (src/config/dated-switch.ts). Unset = free.
 */
export function basicWorkCharged(now: Date = new Date()): boolean {
    return switchedOn(process.env.BASIC_WORK_CHARGED_FROM, now);
}

/**
 * AI video by length (owner, 2026-11-01): priced per second, because the models bill by the second
 * and a 10 s Kling 3.0 Pro clip costs us about twice a 5 s one (docs/ai-video-bakeoff-2026-11-01.md).
 *
 * Netlify env AI_VIDEO_PRICED_BY_SECOND: 'on', or the date it starts (src/config/dated-switch.ts).
 * Production is set to 2026-12-03, the date in the 30 days' notice sent 2026-11-02 (terms 5.2 /
 * 20.2); staging is 'on'. Unset, or before the date, every clip is the flat ai_video weight.
 */
export function videoPricedBySecond(now: Date = new Date()): boolean {
    return switchedOn(process.env.AI_VIDEO_PRICED_BY_SECOND, now);
}

/** Tasks for one AI clip of `seconds` (the BILLED length). The flat ai_video weight while per-second pricing is off. */
export function aiVideoTasks(seconds: number | null | undefined, costs: TaskCosts): number {
    if (!videoPricedBySecond() || !seconds || !(seconds > 0)) return costs.weights.ai_video;
    return Math.ceil(seconds) * costs.videoTasksPerSecond;
}

/** How a model-facing or generated line states the AI clip price, matching aiVideoTasks. */
export function aiVideoPriceText(costs: TaskCosts): string {
    return videoPricedBySecond()
        ? `${costs.videoTasksPerSecond} tasks a second of clip (${aiVideoTasks(5, costs)} for 5 seconds, ${aiVideoTasks(10, costs)} for 10)`
        : `${costs.weights.ai_video} tasks each`;
}

/** Kinds that are AI-generated media — the per-assistant autonomous media cap counts these. */
export const MEDIA_KINDS: readonly WorkKind[] = ['ai_image', 'ai_video', 'ai_music', 'ai_music_shared', 'ai_voiceover'];

/** Customer-facing label for a usage breakdown row. */
export const WORK_KIND_LABELS: Record<WorkKind, string> = {
    social_post: 'Social posts',
    blog_article: 'Blog articles',
    lead_search: 'Lead searches',
    email_issue: 'Email issues',
    email_campaign: 'Email flows',
    outreach_email: 'Outreach emails',
    site_audit: 'Website audits',
    site_draft: 'Website drafts',
    site_words: 'Website copy',
    ai_image: 'AI images',
    ai_video: 'AI videos',
    ai_music: 'AI music',
    ai_music_shared: 'AI music (shared)',
    ai_voiceover: 'AI voiceovers',
    x_link_post: 'X posts with a link',
    mentor_research: 'Business Mentor research',
    mentor_strategy: 'Business Mentor plan drafts',
    mentor_review: 'Business Mentor weekly reviews',
    flyer_words: 'Flyer words',
    background_removal: 'Background removals',
    footage_review: 'Footage reviews',
    // No "every 10 messages" here: how often chat is charged is now a setting (chat_messages_per_task).
    chat_messages: 'Chat',
    editing_helper: 'Editing helpers',
    design_round: 'Design rounds',
    finished_design: 'Finished designs',
};

// ── The costs a super admin can change (Admin → Money → Task costs) ─────────────────────────────

/** One row per number in the table: every WorkKind, plus the two rates. */
export type CostKey = WorkKind | 'ai_video_per_second' | 'chat_messages_per_task';

export const COST_KEYS: readonly CostKey[] = [...(Object.keys(DEFAULT_TASK_WEIGHTS) as WorkKind[]), 'ai_video_per_second', 'chat_messages_per_task'];

export const COST_KEY_LABELS: Record<CostKey, string> = {
    ...WORK_KIND_LABELS,
    ai_video: 'AI video (any length)',
    ai_video_per_second: 'AI video (by length)',
    chat_messages: 'Chat (each charge)',
    chat_messages_per_task: 'How often chat is charged',
};

export function isCostKey(key: unknown): key is CostKey {
    return typeof key === 'string' && (COST_KEYS as readonly string[]).includes(key);
}

/** The value a key holds in a set of costs. */
export function costValue(costs: TaskCosts, key: CostKey): number {
    if (key === 'ai_video_per_second') return costs.videoTasksPerSecond;
    if (key === 'chat_messages_per_task') return costs.chatMessagesPerTask;
    return costs.weights[key];
}

/** The lowest value a key may be set to. Zero tasks = free; zero messages between charges would divide by nothing. */
export function minCost(key: CostKey): number {
    return key === 'chat_messages_per_task' ? 1 : 0;
}
export const MAX_COST = 1000;

/** Does moving this key from `from` to `to` cost the customer more? More messages per charge costs them less. */
export function isCostRise(key: CostKey, from: number, to: number): boolean {
    return key === 'chat_messages_per_task' ? to < from : to > from;
}

/** A cost in customer words: "1 task", "no tasks", "4 tasks a second", "every 10 messages". */
export function formatCost(key: CostKey, value: number): string {
    if (key === 'chat_messages_per_task') return `every ${value} message${value === 1 ? '' : 's'}`;
    if (value === 0) return 'no tasks';
    const tasks = `${value} task${value === 1 ? '' : 's'}`;
    return key === 'ai_video_per_second' ? `${tasks} a second` : tasks;
}
