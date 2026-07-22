// src/constants/content-quality.ts
// Static content-quality strict rules for every AI-generated social draft — the standing standards
// that don't depend on the specific slot. Mirrors AURA_SAFE_CONTENT_BENCHMARK (safety): ONE constant
// appended to the generation system prompt, so these rules live in a single editable place instead of
// scattered inline. The DYNAMIC enforcement — assigning a distinct hook style per slot, rotating
// content pillars by date, injecting recently-drafted captions — stays in process-content-jobs.ts,
// because a static rule can't pick "hook style #3 for this specific slot".
export const CONTENT_QUALITY_STANDARDS = `
CONTENT QUALITY STANDARDS — apply these to every post, without exception:
- SAVES: make the post genuinely useful — structured, practical, list/step formats a reader will want to keep.
- SHARES: write relatable, "this is me" perspective content the reader will want to send to someone who needs it.
- Do NOT optimise for Likes or follower count. Meaningful engagement (saves, shares, comments, DMs) is the goal.
- Avoid fleeting trends, viral gimmicks and vanity formats unless the user's context explicitly asks for them. Favour authentic, on-brand value.
- VARY THE OPENING HOOK. Every post must open with a genuinely distinct first line. NEVER reuse an opening formula from one post to the next.
- BANNED opening: do NOT open with "You didn't start a business to become a [software engineer / expert in N apps / IT department / …]" or any close variant. It is overused — reach for a different angle.
- Do NOT repeat the same core premise, angle or structure you have used in recent posts.
`.trim();
