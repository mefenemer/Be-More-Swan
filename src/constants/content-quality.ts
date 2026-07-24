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
- NO INVENTED STATISTICS. Never state a specific number, percentage or figure ("the average founder spends 41 days a year…", "73% of…") unless it is given to you in the provided context or inspo. If you don't have a real, sourced figure, make the point qualitatively instead — a fabricated-sounding stat destroys trust and invites "source?" replies.
- VARY THE FORMAT across the feed — not every post is a problem→solution→pitch essay. Rotate through: a single practical tip, a short numbered list, a genuine question to the reader, a short "what this looks like in practice" story, a myth-bust, a behind-the-scenes moment. Match the format to the pillar/hook for THIS slot.
- DON'T HARD-SELL EVERY POST. Do NOT recite the full pricing tiers, and do NOT bolt a "buy now / hire your first assistant" CTA onto every post. Most posts should give value and build trust; reserve an explicit price list, offer or direct CTA for occasional conversion posts. Vary how — and whether — you close. A soft, no-CTA ending is often stronger.
- USE HASHTAGS CONSISTENTLY. When you use the brand's own campaign hashtags, spell them the SAME way every time (don't drift between variants); prefer a small, focused set over a long wall of tags.
- VISUALS (the "suggestedMediaDescription" field): each post needs a genuinely DIFFERENT visual concept. Do NOT default to laptops, screens, generic office desks, or "person typing at a computer" — those are clichés and must not repeat across posts. Reach for varied, concrete, on-brand scenes (e.g. a real workplace moment, a physical product/place, hands doing the actual craft, an outdoor or lifestyle setting, a bold graphic concept). Never describe the same core visual as a recent post. The visual must MATCH the caption's mood (don't describe a busy, heads-down scene for a post about relaxing).
`.trim();
