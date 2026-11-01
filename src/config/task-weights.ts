// src/config/task-weights.ts
// How many tasks each finished piece of work costs — the single source of truth for the monthly
// task allowance (see docs/task-metering.md).
//
// A task is one finished piece of work. Most work is 1. The few outputs that cost us real money per
// item are weighted so one allowance can cover them without a second meter: an AI video or music
// track (~20–30p of provider cost each) and an X post carrying a link (X bills ~$0.20 for one).
// A plain X text post costs nothing extra — it is part of the social post's own task.
//
// Chat messages and editing helpers are NOT here: they never cost tasks, only a daily fair-use
// limit (src/utils/fair-use.ts).
//
// Changing a weight changes what customers are charged — update pricing.html, faq.html, the terms
// and the "What Counts as a Task" help article in the same change.

export const TASK_WEIGHTS = {
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
} as const;

/**
 * AI video by length (owner, 2026-11-01): 4 tasks a second, because the models bill by the second
 * and a 10 s Kling 3.0 Pro clip costs us about twice a 5 s one (docs/ai-video-bakeoff-2026-11-01.md).
 *
 * ⚠️ OFF until the notice the terms require has run (clause 5.2: weights change on at least 30 days'
 * notice). Netlify env AI_VIDEO_PRICED_BY_SECOND=on switches it on — staging only until then; with it
 * unset every clip is TASK_WEIGHTS.ai_video, as the terms and pricing page say today. Switching it on
 * for production goes with the copy in docs/ai-video-per-second-pricing.md.
 */
export const AI_VIDEO_TASKS_PER_SECOND = 4;

export function videoPricedBySecond(): boolean {
    return process.env.AI_VIDEO_PRICED_BY_SECOND === 'on';
}

/** Tasks for one AI clip of `seconds` (the BILLED length). Flat TASK_WEIGHTS.ai_video while per-second pricing is off. */
export function aiVideoTasks(seconds: number | null | undefined): number {
    if (!videoPricedBySecond() || !seconds || !(seconds > 0)) return TASK_WEIGHTS.ai_video;
    return Math.ceil(seconds) * AI_VIDEO_TASKS_PER_SECOND;
}

/** How a model-facing or generated line states the AI clip price, matching aiVideoTasks. */
export function aiVideoPriceText(): string {
    return videoPricedBySecond()
        ? `${AI_VIDEO_TASKS_PER_SECOND} tasks a second of clip (${aiVideoTasks(5)} for 5 seconds, ${aiVideoTasks(10)} for 10)`
        : `${TASK_WEIGHTS.ai_video} tasks each`;
}

/** What one charge bought — logged on every task_ledger row so a disputed count can be explained. */
export type WorkKind = keyof typeof TASK_WEIGHTS;

/** Kinds that are AI-generated media — the per-assistant autonomous media cap counts these. */
export const MEDIA_KINDS: readonly WorkKind[] = ['ai_image', 'ai_video', 'ai_music', 'ai_music_shared', 'ai_voiceover'];

export function taskWeight(kind: WorkKind): number {
    return TASK_WEIGHTS[kind];
}

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
};
