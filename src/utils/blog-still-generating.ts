// src/utils/blog-still-generating.ts
// "This blog post is an autopilot draft that is still being WRITTEN" — as a query condition.
//
// process-blog-jobs inserts the post row with only its title, then drafts the body into it over the
// next 30–60s. Until the body lands, the row is a title-only "draft" that opens onto an empty page,
// so anything a person reads — the Blogs list, the Review Queue, the assistant card's "Awaiting
// Human Review" count — must leave it out. It appears the moment the body is saved.
//
// Every arm narrows it, and each one protects something the author should see:
//   - job_id set          → only autopilot rows. An author's own blank post, or one Blog Studio is
//                           drafting into, is never stamped with a job and always stays visible.
//   - pending_approval    → never a post past review.
//   - btrim(body) = ''    → ⚠️ body_markdown is NOT NULL DEFAULT '', so IS NULL would match nothing.
//   - job still running   → an author who clears every word of a FINISHED autopilot draft must not
//                           watch it vanish.
//
// Same shape as process-blog-jobs' EMPTY_AUTOPILOT_DRAFT, which cleans up the rows a killed attempt
// leaves behind; this one only hides the rows a live attempt is still filling.

import { sql, type SQL } from 'drizzle-orm';
import { blogPosts } from '../../db/schema';

/** A WHERE condition that keeps every blog post EXCEPT an autopilot draft still being written. */
export function notStillGenerating(): SQL {
    return sql`NOT (${blogPosts.jobId} IS NOT NULL
                    AND ${blogPosts.status} = 'pending_approval'
                    AND btrim(${blogPosts.bodyMarkdown}) = ''
                    AND EXISTS (SELECT 1 FROM content_generation_jobs j
                                WHERE j.job_id = ${blogPosts.jobId}
                                  AND j.status IN ('queued', 'processing')))`;
}
