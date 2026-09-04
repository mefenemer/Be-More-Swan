// src/utils/blog-interactive-brief.ts
// The brief for an INTERACTIVE blog draft — Blog Studio's "Ask your assistant to draft" — carried
// from generate-blog.ts to the process-blog-jobs worker across a queue row.
//
// WHY A CODEC RATHER THAN COLUMNS: the interactive path drafts into a blog_posts row that already
// exists (the post open in the editor), so the only thing the job has to carry is the author's
// topic/keywords. `content_generation_jobs.context_prompt` is the one free-text channel on that
// table, and adding columns for this would mean a migration applied by hand to two databases before
// the code that reads them can ship — for two short strings a human typed into two inputs.
//
// ⚠️ THE DISCRIMINATOR IS `result_blog_post_id`, NOT THIS ENVELOPE. A job whose result_blog_post_id
// is already set when it is claimed is drafting into an existing post; everything else ideates a
// topic and inserts its own row. `trigger_type` cannot be used for this — campaign orders enqueue
// blog jobs as 'on_demand' too, and they DO want the autopilot path. This envelope only says what
// to write; it never decides which path runs, so a malformed one degrades to "no steer" rather
// than sending a job down the wrong branch.

/** How much of an author's typing is carried. Long enough for a real brief, short enough to bound the row. */
const MAX_FIELD = 500;

export type InteractiveBlogBrief = {
    topic: string;
    keywords?: string;
    notes?: string;
    tone?: string;
};

function clip(value: unknown): string {
    return typeof value === 'string' ? value.trim().slice(0, MAX_FIELD) : '';
}

/** Pack a brief for `content_generation_jobs.context_prompt`. */
export function encodeInteractiveBrief(brief: InteractiveBlogBrief): string {
    return JSON.stringify({
        // Versioned from the first row so a later shape change can be told apart from this one
        // rather than guessed at by which keys happen to be present.
        v: 1,
        topic: clip(brief.topic),
        keywords: clip(brief.keywords),
        notes: clip(brief.notes),
        tone: clip(brief.tone),
    });
}

/**
 * Read a brief back. Returns null for anything that isn't one — including an autopilot job's plain
 * prose context_prompt, which is exactly what this must not mistake for a brief.
 *
 * Never throws: the caller is a queue worker whose job row is already committed, and a brief it
 * cannot read is a draft with less steer, not a failed draft.
 */
export function decodeInteractiveBrief(raw: string | null | undefined): InteractiveBlogBrief | null {
    if (!raw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.v !== 1) return null;
    const topic = clip(obj.topic);
    if (!topic) return null;
    return {
        topic,
        keywords: clip(obj.keywords) || undefined,
        notes: clip(obj.notes) || undefined,
        tone: clip(obj.tone) || undefined,
    };
}
