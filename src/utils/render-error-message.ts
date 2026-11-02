// src/utils/render-error-message.ts
//
// What a customer is told when a video render failed (post_render_jobs.error_message → the Review
// Queue's red "couldn't be rendered" banner, via get-social-drafts).
//
// ⚠️ error_message is written for US. The render worker stores whatever Remotion threw, and Remotion
// writes for developers: on a Lambda timeout it is "The main function timed out after 299999ms. The
// following chunks are missing … Logs for chunk 0: https://eu-west-2.console.aws.amazon.com/
// cloudwatch/… Consider increasing the timeout of your function." That went to customers verbatim —
// our AWS region, the function name and a console link, cut off mid-sentence at 500 characters
// (SWAN-6, 2026-11-01). The raw text stays in the table for diagnosis; this is the only thing that
// turns it into a sentence for the person looking at the post.
//
// Messages our own worker writes are already plain sentences, so they pass through unchanged. Every
// other message is mapped by what went wrong, never echoed.

const TRY_AGAIN = 'Try the render again — if it keeps happening, tell us and we’ll look into it.';

/** Sentences render-post-video-background.ts and src/lib/remotion-lambda.ts write themselves. */
const OWN_SENTENCES = new Set([
    'The user who queued this render no longer exists.',
    'Video rendering is not configured in this environment.',
    'Media storage is not configured.',
    'The post no longer exists.',
    'The post no longer has media to render.',
    'The post’s video could not be read.',
    'The render finished but produced no file.',
    'The render took too long and was abandoned.',
    'The render failed unexpectedly.',
    'The video renderer was busy and could not finish. Try the render again in a few minutes.',
]);

export function customerRenderError(raw: string | null | undefined): string | null {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    if (OWN_SENTENCES.has(text)) return text;
    if (/timed? ?out|timeout/i.test(text)) return `Your video took too long to render, so it wasn’t finished. ${TRY_AGAIN}`;
    if (/concurrency|rate ?exceeded|too ?many ?requests/i.test(text)) {
        return 'The video renderer was busy and could not finish. Try the render again in a few minutes.';
    }
    return `Something went wrong while rendering your video. ${TRY_AGAIN}`;
}
