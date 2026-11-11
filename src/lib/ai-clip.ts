// src/lib/ai-clip.ts
// An AI clip on its own (docs/video-producer-footage-and-ai-plan.md §5.1–5.2, Phase 5; built 2026-11-11):
// describe a clip, pick a style, a length and a shape → see its first frame (1 task, an AI picture) →
// "Make the clip" animates THAT picture (the AI clip price, by length). Under the hood it is a one-scene
// Video Producer project (brief.clip), so holds, refunds, the stuck sweep and Results already work.
//
// A style is a prompt preset. Every style uses the configured image-to-video model for now: the
// 2026-11-01 bake-off put Kling 3.0 Pro first in four styles of five (docs/ai-video-bakeoff-2026-11-01.md);
// a model per style waits for its round 2.
//
// Safety (§6): fictional people only — a request for a real, famous or look-alike person is refused,
// and so is a realistic child. The workspace's own moderation runs as well (video-projects.ts).
//
// PURE: no database, no network. Tested in tests/video-ai-clip.test.ts.

export const CLIP_STYLES = ['realistic', 'cinematic', 'animated3d', 'cartoon2d', 'product'] as const;
export type ClipStyle = typeof CLIP_STYLES[number];
export const isClipStyle = (v: unknown): v is ClipStyle => typeof v === 'string' && (CLIP_STYLES as readonly string[]).includes(v);

export const CLIP_STYLE_LABELS: Record<ClipStyle, string> = {
    realistic: 'Realistic', cinematic: 'Cinematic', animated3d: '3D animated', cartoon2d: '2D cartoon', product: 'Product close-up',
};
export const CLIP_STYLE_HINTS: Record<ClipStyle, string> = {
    realistic: 'People, places and everyday scenes — made-up people only',
    cinematic: 'Landscapes, atmosphere, openers',
    animated3d: 'Friendly explainers and mascots',
    cartoon2d: 'Playful, illustrated brands',
    product: 'Textures, food and materials — never your own product',
};
const STYLE_PROMPT: Record<ClipStyle, string> = {
    realistic: 'photorealistic, natural light, true-to-life detail; any people are fictional',
    cinematic: 'cinematic, wide establishing shot, dramatic light, film look, smooth camera move',
    animated3d: 'stylised 3D animation, soft rounded shapes, bright friendly colours, studio lighting',
    cartoon2d: 'flat 2D cartoon illustration, clean outlines, bold simple colours',
    product: 'macro close-up, shallow depth of field, rich texture, studio lighting',
};

/**
 * "With sound" (plan §5.3 / Phase 6): ambient sound made with the picture, no speech. Off by default — a
 * voiceover or music usually goes over it. Kling 3 charges 50% more for it (bake-off round 1), so the
 * clip's tasks are 1.5×, rounded up. Only offered while the model in use can make it (clipSoundAvailable).
 */
export const CLIP_SOUND_PRICE = 1.5;
export const clipTasksWithSound = (tasks: number, sound: boolean) => (sound ? Math.ceil(tasks * CLIP_SOUND_PRICE) : tasks);
/** What the motion prompt adds when the clip has sound: ambience, never voices (no speech in v1). */
export const CLIP_SOUND_PROMPT = 'Natural ambient sound that fits the scene; no speech, no singing, no music.';

/** Seconds a clip can be. The model bills by the second, so the button shows the price for the length. */
export const CLIP_LENGTHS = [5, 10] as const;
export type ClipLength = typeof CLIP_LENGTHS[number];
export const isClipLength = (v: unknown): v is ClipLength => (CLIP_LENGTHS as readonly number[]).includes(Number(v));

/** What to picture: the person's words with the style's look. No words or signs in it (they come out misspelt). Pure. */
export function clipPrompt(style: ClipStyle, description: string): string {
    const d = description.replace(/\s+/g, ' ').trim().slice(0, 400);
    return `${d}. ${STYLE_PROMPT[style]}. No words, letters, logos or signs anywhere in the picture.`;
}

/**
 * The scene's planned length, so the model is asked for exactly `seconds`: aiClipSeconds adds a 0.3 s
 * margin and rounds up (video-producer.ts), so 4.7 → 5 and 9.7 → 10. Pure.
 */
export const clipTargetS = (seconds: ClipLength) => Math.round((seconds - 0.3) * 10) / 10;

const LIKENESS = /\b(look(?:s|ing)?[- ]alike|lookalike|looks like|resembl\w*|celebrit\w*|famous|deep ?fake|real person|impersonat\w*)\b/i;
const CHILD = /\b(child|children|kid|kids|baby|babies|toddler|infant|boy|girl|teen|teenager|schoolchild\w*|pupil)s?\b/i;

/** Why this clip can't be made, or null. Pure. */
export function clipRefusal(style: ClipStyle, description: string): string | null {
    const d = description.trim();
    if (d.length < 8) return 'Say a little more about what the clip should show.';
    if (LIKENESS.test(d)) return 'AI clips only show made-up people — never a real, famous or look-alike person. Describe the scene without naming or comparing to anyone.';
    if (style === 'realistic' && CHILD.test(d)) return 'Realistic AI clips can’t show children. Try the 3D animated or 2D cartoon style, or leave children out.';
    return null;
}
