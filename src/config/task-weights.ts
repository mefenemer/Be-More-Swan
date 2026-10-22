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
    x_link_post: 10,
} as const;

/** What one charge bought — logged on every task_ledger row so a disputed count can be explained. */
export type WorkKind = keyof typeof TASK_WEIGHTS;

/** Kinds that are AI-generated media — the per-assistant autonomous media cap counts these. */
export const MEDIA_KINDS: readonly WorkKind[] = ['ai_image', 'ai_video', 'ai_music', 'ai_music_shared'];

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
    x_link_post: 'X posts with a link',
};
