// src/utils/blog-ai-assisted.ts
// Single source of truth for "was this blog post machine-drafted?" — the flag behind the AI
// transparency badge on the widget, the server-rendered permalink and the syndicated copies
// (EU AI Act Art. 50).
//
// It used to be derived, at read time, from `blog_posts.provenance_content_id`. That column is
// stamped by publishBlogPost() on EVERY publish, human-authored ones included, so a post the
// customer typed by hand in the Studio went out badged as AI-written on their own domain.
//
// The write side was wrong in the other direction: it read `jobId || blueprintId || isAutonomous`,
// none of which the INTERACTIVE "generate with AI" path sets — that path only ever wrote
// body_markdown — so an assistant-drafted post recorded itself as 'human-authored'.
//
// Both surfaces now go through isAiAssisted(), and generateBlogBody() stamps `generation_reason` so
// there is something durable to read. No new column: `generation_reason` already means "how this
// content came to exist" and is null on every hand-authored post.
//
// Deliberately dependency-free so the read paths (widget-api, blog-page) can import it without
// pulling in blog-publish's transitive graph.

/**
 * The ONE AI transparency sentence shared by every blog surface (EU AI Act Art. 50), so a reader
 * sees the same claim wherever the post reaches them: the embeddable widget, the server-rendered
 * permalink (/b/:key/:slug) and the syndicated copies on WordPress/Ghost/Hashnode/Dev.to. Each
 * surface supplies its own presentation (badge pill, italic paragraph); only the wording lives here.
 *
 * It lives in this module rather than src/config/compliance.ts because blog-seo.ts is deliberately
 * dependency-free (it backs a public lambda) and compliance.ts reaches platform-config. compliance.ts
 * re-exports it as DISCLOSURE.blogAiNotice so it stays discoverable from the canonical home.
 *
 * Suppressed per-workspace by widget_configs.badge_enabled.
 */
export const BLOG_AI_NOTICE = 'This post was created with AI assistance and reviewed by a human.';

/** The `generation_reason` written when the assistant drafts a body from the Blog Studio. */
export const ASSISTANT_DRAFT_REASON = 'assistant_draft';

/** The subset of a blog_posts row that carries machine-drafting provenance. */
export interface AiAssistedFields {
    jobId?: string | null;
    blueprintId?: number | null;
    isAutonomous?: boolean | null;
    generationReason?: string | null;
}

/**
 * True when any part of the post's body was machine-drafted.
 *
 * Any generation_reason at all counts — autopilot writes 'autopilot_schedule', the interactive
 * Studio path writes 'assistant_draft', and a hand-authored post has none. Reading the column's
 * PRESENCE rather than matching known values keeps a future generation route disclosed by default:
 * forgetting to add it here would under-disclose, which is the failure that matters.
 */
export function isAiAssisted(post: AiAssistedFields): boolean {
    return !!(post.jobId || post.blueprintId || post.isAutonomous || post.generationReason);
}
