// netlify/functions/blog-horizon-fill.ts
// Blog Autopilot: daily job — for each active Blog Writer assistant, fill any uncovered publishing
// slots inside its draft horizon by enqueuing generation jobs, each stamped with the exact
// target_publish_date derived from the assistant's frequency / days / times.
//
// Schedule: "0 5 * * *"  (05:00 UTC daily)
// Deliberately an hour ahead of draft-horizon-fill's 06:00 so the two top-ups don't contend for the
// same Neon compute window — long-form generation is the heavier of the two.
//
// The jobs land in content_generation_jobs with content_type='blog'; process-blog-jobs.ts turns
// each into a dated draft in the Blogs tab. This is the long-form mirror of draft-horizon-fill.ts.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { enqueueBlogGapFill } from '../../src/utils/blog-gap-fill';
import { BLOG_WRITER_ROLE_KEYS } from '../../src/constants/roles';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Core top-up pass, exported so staging can drive it over HTTP (see run-blog-jobs.ts). */
export async function fillBlogHorizons(now: Date = new Date()) {
    const db = getDb();

    const writers = await db
        .select({
            id: aiAssistants.id,
            userId: aiAssistants.userId,
            organisationId: aiAssistants.organisationId,
            name: aiAssistants.name,
            onboardingContext: aiAssistants.onboardingContext,
            draftHorizonDays: aiAssistants.draftHorizonDays,
        })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(aiAssistants.isActive, true),
            inArray(masterAssistants.roleKey, BLOG_WRITER_ROLE_KEYS),
        ));

    let jobsEnqueued = 0;
    const skipped: Record<string, number> = { on_demand: 0, fully_covered: 0 };

    for (const assistant of writers) {
        try {
            const result = await enqueueBlogGapFill(db, assistant, now);
            jobsEnqueued += result.enqueued;
            if (result.reason && result.reason !== 'ok' && skipped[result.reason] !== undefined) {
                skipped[result.reason]++;
            }
        } catch (err) {
            console.error(`blog-horizon-fill: assistant ${assistant.id} failed`, err);
        }
    }

    return { assistantsChecked: writers.length, jobsEnqueued, skipped };
}

export default withLambda(async (event) => {
    // Allow both scheduled invocations and manual POST for testing (mirrors draft-horizon-fill).
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const result = await fillBlogHorizons();

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, ...result }),
    };
});
