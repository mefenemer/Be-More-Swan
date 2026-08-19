// src/utils/blog-chat-draft.ts
//
// The blog_post_draft wire shape — the long-form twin of social_post_draft, and deliberately
// NOT its twin in one respect: nothing here is saved by the server.
//
// A Blog Writer chat used to have no structured output at all (blog_writer fell through to
// defaultRoute), so a finished post existed only as prose in the transcript and the assistant
// correctly told the user to copy it out and re-create it in Blog Studio by hand. This module
// carries the draft from the model to a card the user can keep or throw away.
//
// Why the user presses the button instead of the orchestrator writing the row: a blog post is
// one long piece the author is going to publish under their own name on their own domain, and
// the whole point of the chat is iterating on it — three redrafts in a conversation would be
// three drafts in their Blogs tab if the turn saved by itself. The social route saves on the
// turn because a caption is small, slot-bound and already inside a review queue; a blog draft
// is neither. Keep/discard is the contract, and the card's copy states it.
//
// Kept free of DB/SDK imports so both the orchestrator and the tests can use it without
// booting a function.

/** uiElement.type carried by a chat-authored blog draft. */
export const BLOG_POST_DRAFT_TYPE = 'blog_post_draft';

/** blog_posts.title is unbounded, but a title longer than this is a body in the wrong field. */
export const MAX_TITLE_CHARS = 200;
/** ~10k words. The route's max_tokens caps this long before the clamp bites; belt and braces. */
export const MAX_BODY_CHARS = 60_000;
/** save-blog-draft clamps tags at 25; a model that emits more is guessing, not tagging. */
export const MAX_TAGS = 8;
export const MAX_TAG_CHARS = 40;

export interface BlogChatDraft {
    title: string;
    bodyMarkdown: string;
    tags: string[];
}

/**
 * The title for a draft whose `title` field is missing or blank.
 *
 * The role prompt asks for a single H1 as the body's first line (matching generateBlogBody, so a
 * chat draft and an autopilot draft have the same shape in the editor), which means the title is
 * nearly always recoverable from the body itself. blog_posts.title is NOT NULL and the Blogs list
 * renders it, so falling back beats refusing to save a post the user can plainly see.
 */
function deriveTitle(bodyMarkdown: string): string {
    const lines = bodyMarkdown.split('\n').map((l) => l.trim()).filter(Boolean);
    const h1 = lines.find((l) => /^#\s+\S/.test(l));
    const source = h1 ? h1.replace(/^#\s+/, '') : (lines[0] ?? '');
    // Strip the markdown a first line commonly carries so the tab shows words, not syntax.
    const cleaned = source.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim();
    return cleaned ? cleaned.slice(0, MAX_TITLE_CHARS) : 'Untitled draft';
}

function normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const tag = raw.trim().replace(/^#/, '').slice(0, MAX_TAG_CHARS);
        if (tag) seen.add(tag);
        if (seen.size >= MAX_TAGS) break;
    }
    return [...seen];
}

/**
 * Validate and normalise a blog_post_draft uiElement.
 *
 * Returns null for anything that is not a usable draft — wrong type, no body, a body that is
 * only whitespace. Null is what the orchestrator's claim guard tests against: a reply saying it
 * has written the post while this returns null is a reply about nothing, and the same class of
 * bug as the social route's unbacked "drafted!" claims (src/utils/chat-draft-claims.ts).
 *
 * Every field originates from an LLM response, so nothing is trusted: strings are typed-checked
 * and clamped here rather than at the (three) places that go on to use them.
 */
export function blogPostDraftFromUiElement(uiElement: unknown): BlogChatDraft | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== BLOG_POST_DRAFT_TYPE) return null;

    const bodyMarkdown = typeof ui.bodyMarkdown === 'string' ? ui.bodyMarkdown.trim().slice(0, MAX_BODY_CHARS) : '';
    if (!bodyMarkdown) return null;

    const rawTitle = typeof ui.title === 'string' ? ui.title.trim().slice(0, MAX_TITLE_CHARS) : '';
    return {
        title: rawTitle || deriveTitle(bodyMarkdown),
        bodyMarkdown,
        tags: normalizeTags(ui.tags),
    };
}
