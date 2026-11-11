// src/utils/pillar-profiles.ts
// Which assistants keep their themes as content_pillars rows, and how each one names and stores them
// (docs/pillar-records-plan.md §7). Pure.
//
// The rows are the same for every role; the role decides:
//   · the onboarding_context key the names are DERIVED back to (readers and the set-up wizard read it),
//     and its shape: Social keeps an array (content_pillars); Blog and Email keep comma-joined TEXT,
//     because their wizard field and every reader treat blogTopics / newsletterTopics as text;
//   · how many can be switched on;
//   · the word customers read. ⚠️ Blog and Email say "topic", never "pillar": a "pillar article" is a
//     long-form blog post in the Campaign Orchestrator (draft_blog_pillar, campaign-vocab.ts).

export interface PillarProfile {
    roleKey: string;
    contextKey: 'content_pillars' | 'blogTopics' | 'newsletterTopics';
    /** Derived value is text ("A, B, C") rather than an array. */
    asText: boolean;
    maxActive: number;
    noun: 'pillar' | 'topic';
    nounPlural: 'pillars' | 'topics';
    /** How far back drafting balances, and Results counts. */
    balanceDays: number;
}

export const PILLAR_PROFILES: Readonly<Record<string, PillarProfile>> = {
    social_media_manager: { roleKey: 'social_media_manager', contextKey: 'content_pillars', asText: false, maxActive: 5, noun: 'pillar', nounPlural: 'pillars', balanceDays: 60 },
    // A blog posts weekly at most and a newsletter less, so they balance over a longer window.
    blog_writer: { roleKey: 'blog_writer', contextKey: 'blogTopics', asText: true, maxActive: 8, noun: 'topic', nounPlural: 'topics', balanceDays: 90 },
    newsletter_editor: { roleKey: 'newsletter_editor', contextKey: 'newsletterTopics', asText: true, maxActive: 8, noun: 'topic', nounPlural: 'topics', balanceDays: 90 },
};

export const SOCIAL_PILLAR_PROFILE = PILLAR_PROFILES.social_media_manager;

/** The role's profile, or null for a role that has no pillars or topics. */
export function pillarProfileFor(roleKey: string | null | undefined): PillarProfile | null {
    return (roleKey && PILLAR_PROFILES[roleKey]) || null;
}

/** The value written to onboarding_context[profile.contextKey] for these active names. */
export function derivedContextValue(profile: PillarProfile, names: string[]): string[] | string {
    return profile.asText ? names.join(', ') : names;
}

/** "pillar" / "topic", capitalised when asked. */
export function nounFor(profile: PillarProfile, opts?: { plural?: boolean; capital?: boolean }): string {
    const w = opts?.plural ? profile.nounPlural : profile.noun;
    return opts?.capital ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}
