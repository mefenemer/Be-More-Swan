// src/constants/retired-setup-answers.ts
// Set-up answers the Social Media wizard USED to save and no longer asks (retired 2026-11-14).
//
// Each was saved once, at hire, with no way to edit it afterwards — and each had been replaced:
//   - content_source_detail       "Where should it look? (a Notion board…)" / "Any websites or feeds
//                                  to monitor?". Nothing can read those places, so drafting already
//                                  ignored it (operational-setup.ts). Chat, though, was handed it as a
//                                  rule it MUST obey: a customer's old weekday topic plan kept steering
//                                  chat drafts after her business changed (2026-11-14). Topics live in
//                                  "What I post about"; material to work from on Inspo / Your brand.
//   - trigger_schedule_frequency  A copy of the Posting Schedule's frequency, never updated after hire.
//   - trigger_timezone            A copy of the Posting Schedule's timezone, never updated after hire.
//                                  The blueprint preferred these stale copies over posting_*.
//
// Rows hired before the retirement may still hold them (wording backed up in
// retired_setup_answers — db/z-retire-social-setup-answers-2026-11-14.sql). Every reader that passes
// set-up answers on wholesale must drop these keys, so an old row can never steer a model again.
export const RETIRED_SETUP_ANSWER_KEYS = [
    'content_source_detail',
    'trigger_schedule_frequency',
    'trigger_timezone',
] as const;

const RETIRED = new Set<string>(RETIRED_SETUP_ANSWER_KEYS);

export function isRetiredSetupAnswer(key: string): boolean {
    return RETIRED.has(key);
}

/** A copy of the set-up answers without the retired keys. */
export function withoutRetiredSetupAnswers<T extends Record<string, unknown>>(ctx: T): T {
    const out = {} as Record<string, unknown>;
    for (const [k, v] of Object.entries(ctx)) if (!RETIRED.has(k)) out[k] = v;
    return out as T;
}
