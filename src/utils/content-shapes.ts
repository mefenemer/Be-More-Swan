// src/utils/content-shapes.ts
//
// What SHAPE a piece takes — separate from what it is about and how it sounds.
//
// ⚠️ Why this exists (user report, 2026-10-06): Be More Swan's social drafts and blog posts came out
// with "almost identical structure every time". Two causes, both in the prompts:
//   · social — CONTENT_QUALITY_STANDARDS told every post to be "structured, practical, list/step
//     formats", and the "vary the format" rule was a wish with nothing assigning a format, so every
//     slot made the same safe choice: hook → problem → three points → soft CTA.
//   · blog — the prompt hard-coded ONE structure for every article: "a short hook intro, 3–6 level-2
//     sections, and a brief conclusion", 900–1,200 words.
// People do not write like that. A real feed mixes a two-line thought, a story, a list, an opinion;
// a real blog mixes a guide, an essay, a true story, a teardown. So each slot is now ASSIGNED a shape
// — deterministically, the same way the hook style already is, so parallel drafts in one batch can't
// all pick the same one and nothing needs storing or migrating.
//
// Length is part of the shape on purpose: identical length is as recognisable as identical structure,
// and the blog's word target stays explicit per type (see the measured-length note in blog-generate.ts
// — without a stated target the model thins every section).

export interface PostShape {
    key: string;
    /** Shown on the assistant profile's Content mix setting. */
    label: string;
    summary: string;
    /** The instruction, written to the model. */
    brief: string;
}

// Social. A PRIME count (11) so a daily slot cycles through every shape rather than aliasing onto a
// few, and coprime with the 7 hook styles so hook and shape don't lock into the same pairs.
export const SOCIAL_POST_SHAPES: PostShape[] = [
    { key: 'one_thought', label: 'Short thought', summary: 'One idea in a few lines', brief: 'A SHORT THOUGHT — one idea in 1–3 sentences (under 280 characters for the main caption). No list, no headings, no setup. Say it and stop.' },
    { key: 'story', label: 'Story', summary: 'A real moment told as a story', brief: 'A TRUE-TO-LIFE STORY — a short first-person or customer moment told as a story: a scene, what happened, what changed. Flowing paragraphs, no bullet points. The lesson is implied or one line at the end, never a lecture.' },
    { key: 'list', label: 'List', summary: 'A saveable numbered list', brief: 'A SAVEABLE LIST — a numbered list of 3–7 genuinely useful, specific items with a one-line intro. This is the ONE shape where a list is the point.' },
    { key: 'opinion', label: 'Opinion', summary: 'A clear position, argued', brief: 'AN OPINION — take a clear position on something in this industry and argue it in 2–4 short paragraphs. Acknowledge the other side in a line, then hold your view. No list.' },
    { key: 'question', label: 'Question', summary: 'A conversation starter', brief: 'A CONVERSATION STARTER — a short, genuine question to the audience with just enough context (2–4 lines) to make it easy and tempting to answer. Ends on the question.' },
    { key: 'behind_scenes', label: 'Behind the scenes', summary: 'How the business really works', brief: 'BEHIND THE SCENES — show something real about how the business works day to day: a decision, a mistake, a process, a small win. Candid, specific, unpolished. No list.' },
    { key: 'deep_tip', label: 'One tip, in depth', summary: 'A single practical tip explained properly', brief: 'ONE TIP, PROPERLY — a single practical tip explained in depth: what to do, exactly how, and what it changes. Short paragraphs, no list, no "here are 5 ways".' },
    { key: 'myth', label: 'Myth-bust', summary: 'A common belief, taken apart', brief: 'A MYTH-BUST — state a common belief, then take it apart with reasoning or an example. Two parts: the myth, then the truth. Not a list.' },
    { key: 'before_after', label: 'Before / after', summary: 'A concrete contrast', brief: 'BEFORE / AFTER — a contrast between how something looked before and after a change. Can be two short blocks or two lines. Concrete details on both sides.' },
    { key: 'note_to_reader', label: 'Note to the reader', summary: 'A short personal letter', brief: 'A NOTE TO THE READER — written like a short personal note or letter to one specific kind of reader ("To the founder doing their books at midnight…"). Warm, direct, a few short paragraphs.' },
    { key: 'observation', label: 'Observation', summary: 'Something noticed, and why it matters', brief: 'AN OBSERVATION — something you noticed recently (a pattern, a conversation, a small moment) and why it matters. Loose and reflective, conversational paragraphs, no CTA.' },
];

/** Long, medium or short — rotated independently so a story isn't always the long one. */
const SOCIAL_LENGTHS = [
    'LENGTH: keep it short — the whole caption under about 60 words.',
    'LENGTH: medium — roughly 60–140 words.',
    'LENGTH: let it run long if the shape needs it — up to about 220 words, still easy to read on a phone.',
];

/**
 * The shape for one social slot. Deterministic from the slot's publish time, using the DAY (the hook
 * uses the hour), so daily slots rotate through every shape. On-demand jobs (no slot) get a random one.
 */
/**
 * The shapes an assistant may use: its Content mix setting (onboardingContext.allowed_post_shapes),
 * or every shape when unset. Unknown keys are ignored, and a list that names nothing we know falls
 * back to all of them — a setting must never leave a slot with no shape at all.
 */
export function allowedSocialShapes(allowed?: unknown): PostShape[] {
    if (!Array.isArray(allowed)) return SOCIAL_POST_SHAPES;
    const keys = new Set(allowed.map(String));
    const list = SOCIAL_POST_SHAPES.filter((s) => keys.has(s.key));
    return list.length ? list : SOCIAL_POST_SHAPES;
}

export function socialShapeFor(
    targetPublishDate: string | Date | null | undefined,
    allowed?: unknown,
): { shape: PostShape; length: string } {
    const shapes = allowedSocialShapes(allowed);
    const t = targetPublishDate ? new Date(targetPublishDate).getTime() : NaN;
    if (!Number.isFinite(t)) {
        const shape = shapes[Math.floor(Math.random() * shapes.length)];
        return { shape, length: SOCIAL_LENGTHS[Math.floor(Math.random() * SOCIAL_LENGTHS.length)] };
    }
    const day = Math.floor(t / 86_400_000);
    const hour = Math.floor(t / 3_600_000);
    // Hour within the day is added so two slots on the same day get different shapes.
    const shape = shapes[(day + (hour % 24)) % shapes.length];
    // A length that follows the shape where the shape fixes it; otherwise rotated on a different cycle.
    const length = shape.key === 'one_thought' || shape.key === 'question'
        ? SOCIAL_LENGTHS[0]
        : SOCIAL_LENGTHS[(day * 2 + hour) % SOCIAL_LENGTHS.length];
    return { shape, length };
}

/** The prompt line for a social slot's shape. */
export function socialShapeLine(targetPublishDate: string | Date | null | undefined, allowed?: unknown): string {
    const { shape, length } = socialShapeFor(targetPublishDate, allowed);
    return [
        `POST SHAPE for THIS post — ${shape.brief}`,
        length,
        'The shape decides the structure. Do NOT fall back on the default "hook → problem → three points → call to action" template, and do not use a list unless the shape above is a list. If the opening-hook style below fits awkwardly with this shape, keep the shape and adapt the hook.',
    ].join('\n');
}

// ── Blog ──────────────────────────────────────────────────────────────────────────────────────────

export interface ArticleType {
    key: string;
    label: string;
    summary: string;
    /** Structure + length, written to the model. Every type states its word range explicitly. */
    brief: string;
}

export const BLOG_ARTICLE_TYPES: ArticleType[] = [
    {
        key: 'guide',
        label: 'Practical guide',
        summary: 'Teaches the reader to do one thing',
        brief: 'A PRACTICAL GUIDE that teaches the reader to do one thing. A short intro saying what they will be able to do, then 4–6 level-2 sections in the order they would actually do it, each with real specifics and an example, and a short wrap-up. 1,000–1,300 words.',
    },
    {
        key: 'opinion',
        label: 'Opinion piece',
        summary: 'Argues one clear position',
        brief: 'AN OPINION PIECE / ESSAY arguing one clear position. Open with the claim or the moment that prompted it. Build the argument in flowing prose — 2–4 level-2 headings at most, or none — address the strongest counter-argument honestly, and end with where you stand. No bullet-point lists. 700–1,000 words.',
    },
    {
        key: 'story',
        label: 'True story',
        summary: 'A real situation, told as a narrative',
        brief: 'A TRUE STORY told as a narrative: a real (or clearly anonymised) situation from the business or a customer — the setting, what went wrong or what was at stake, what was tried, what happened. Chronological, scene-led, written like a story, with few or no headings. The lesson emerges from the story; state it in a short closing section at most. Use ONLY facts from the brief or business context — never invent names, numbers or events. 700–1,100 words.',
    },
    {
        key: 'list',
        label: 'List article',
        summary: 'Numbered items with real substance',
        brief: 'A LIST ARTICLE — a short intro, then 6–10 numbered items as level-2 headings, each with a paragraph or two of genuine substance (not one-liners), and a brief close. 900–1,200 words.',
    },
    {
        key: 'myth',
        label: 'Myth-busting',
        summary: 'Common beliefs, taken apart',
        brief: 'A MYTH-BUSTING piece. Open with the belief most readers hold. Then take apart 3–5 related myths, each as a level-2 heading stating the myth, followed by what is actually true and why. Close with what to do instead. 800–1,100 words.',
    },
    {
        key: 'qa',
        label: 'Questions answered',
        summary: 'Real customer questions, answered',
        brief: 'QUESTIONS ANSWERED — the real questions customers ask about this topic, each as a level-2 heading phrased the way a customer would ask it, answered directly in the first sentence and then explained. 6–9 questions. No long intro: one or two sentences, then straight into the first question. 800–1,200 words.',
    },
    {
        key: 'behind_scenes',
        label: 'Behind the scenes',
        summary: 'An honest look at how you work',
        brief: 'BEHIND THE SCENES — an honest look at how the business does something: a decision, a process, a change, a mistake and what was learned. First person ("we"/"I"), candid, specific. A few level-2 headings to pace it, mostly prose. 700–1,000 words.',
    },
    {
        key: 'comparison',
        label: 'Comparison',
        summary: 'Helps the reader choose between options',
        brief: 'A COMPARISON helping the reader choose between two or three options (approaches, tools, ways of working). Short intro on who this is for, a level-2 section per option with honest pros and cons, a section on how to decide, and a clear recommendation for each kind of reader. 900–1,200 words.',
    },
];

/**
 * The article type for a blog draft. `sequence` is how many posts this assistant has drafted before
 * this one, so consecutive posts always differ; rotating with a step coprime to the list length (3
 * over 8) means a reader sees guide → story → … rather than the list in order.
 */
export function blogArticleTypeFor(sequence: number, allowed?: unknown): ArticleType {
    const types = allowedArticleTypes(allowed);
    const n = types.length;
    // Step 3 is coprime with 8 (all types) but not with every subset — for a subset whose size is a
    // multiple of 3, step 1 keeps consecutive posts apart and still uses every allowed type.
    const step = n % 3 === 0 ? 1 : 3;
    const i = ((Math.floor(Math.max(0, sequence)) * step) % n + n) % n;
    return types[i];
}

/** The article types an assistant may use (onboardingContext.allowed_article_types), or all. */
export function allowedArticleTypes(allowed?: unknown): ArticleType[] {
    if (!Array.isArray(allowed)) return BLOG_ARTICLE_TYPES;
    const keys = new Set(allowed.map(String));
    const list = BLOG_ARTICLE_TYPES.filter((t) => keys.has(t.key));
    return list.length ? list : BLOG_ARTICLE_TYPES;
}

/** An article type by key — a type the author picked in Blog Studio. null for anything unknown. */
export function articleTypeByKey(key: unknown): ArticleType | null {
    return BLOG_ARTICLE_TYPES.find((t) => t.key === key) ?? null;
}

/** The prompt block for a blog draft's type. */
export function blogArticleTypeBlock(type: ArticleType): string {
    return [
        `ARTICLE TYPE for THIS post — ${type.brief}`,
        'Follow that structure rather than a default "intro → 3–6 sections → conclusion" template. ' +
        'If the title or the author notes clearly call for a different kind of piece (a "How to…" title wants a guide; ' +
        'notes telling a story want a story), write THAT kind instead — keeping its length — and still avoid the default template.',
    ].join('\n');
}
