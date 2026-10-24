// src/constants/platform-craft.ts
// How an expert social media manager writes for EACH platform — the craft the drafting prompt lacked.
//
// Prompt audit, 2026-10-24 (owner: "assistants need to be experts in their role"): the social prompt
// opened "You are an expert social media copywriter" and then taught only what to avoid. The same
// caption shape went to every platform — nine hashtags on a LinkedIn post, nothing about what shows
// before "…more" on Instagram or "see more" on LinkedIn, which is where a post is won or lost.
//
// This is writing craft only. The owner's own per-platform toggles (hashtag counts, carousels, links
// in the first comment) are platform-strategy-brief.ts, and they win where the two overlap.

const CRAFT: Record<string, string> = {
    instagram: 'INSTAGRAM — only about the first 125 characters show before "…more", so the first line must work on its own and make them tap. The caption supports the picture: say what the picture can\'t. Short paragraphs with line breaks. 3–5 specific hashtags (the place, the niche, the brand) — never generic ones like #business or #love.',
    linkedin: 'LINKEDIN — only the first two lines (about 200 characters) show before "see more": make them a specific claim, tension or moment, never a greeting. Write as a person in the business sharing what they have learned, in short paragraphs with white space. No emoji bullets, no "I\'m thrilled to announce". At most 3 hashtags, at the very end.',
    facebook: 'FACEBOOK — conversational and local, like talking to customers who already know you. Shorter than LinkedIn. A genuine question or a clear next step works well; hashtags are optional (0–2).',
    x: 'X — one idea, said sharply, under 280 characters including everything. No preamble, no thread unless asked, at most 1–2 hashtags or none.',
    threads: 'THREADS — casual, conversational and short; it rewards replies, so leave room for one. No hashtag walls.',
};

/** The craft lines for the platforms this post is for, or '' when none are known. Pure. */
export function platformCraftBlock(platforms: readonly string[]): string {
    const lines = [...new Set(platforms.map((p) => (p === 'twitter' ? 'x' : String(p).toLowerCase())))]
        .map((p) => CRAFT[p]).filter(Boolean);
    return lines.length ? `PLATFORM CRAFT — write it the way an expert does on ${lines.length > 1 ? 'each of these platforms' : 'this platform'} (the owner's own platform strategy, where given, wins):\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}
