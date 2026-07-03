// netlify/functions/draft-horizon-fill.ts
// US-SMM-2.4.1 (+ Posting Schedule): Daily job — for each active Social Media Manager assistant,
// fill any uncovered posting slots inside its draft horizon by enqueuing generation jobs, each
// stamped with the exact target_publish_date derived from the assistant's frequency / days / times.
//
// Schedule: "0 6 * * *"  (06:00 UTC daily)
// The jobs land in content_generation_jobs; process-content-jobs.ts turns each into a dated draft
// in the Review Queue. This function no longer enqueues opaque task runs — it directly tops up the
// generation queue so the user always has content N days ahead.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { enqueueScheduleGapFill } from '../../src/utils/schedule-gap-fill';
import { SMM_ROLE_KEYS } from '../../src/constants/roles';

export const handler: Handler = async (event) => {
    // Allow both scheduled invocations and manual POST for testing
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();

    // Find all active SMM assistants with their schedule + horizon settings
    const smmAssistants = await db
        .select({
            id: aiAssistants.id,
            userId: aiAssistants.userId,
            organisationId: aiAssistants.organisationId,
            name: aiAssistants.name,
            onboardingContext: aiAssistants.onboardingContext,
            draftHorizonDays: aiAssistants.draftHorizonDays,
            configuration: aiAssistants.configuration,
        })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(aiAssistants.isActive, true),
            inArray(masterAssistants.roleKey, SMM_ROLE_KEYS),
        ));

    const now = new Date();
    let jobsEnqueued = 0;
    const skipped: Record<string, number> = { on_demand: 0, no_blueprint: 0, blocking_gaps: 0, fully_covered: 0, empty_library_skipped: 0 };

    for (const assistant of smmAssistants) {
        try {
            const result = await enqueueScheduleGapFill(db, assistant, now);
            jobsEnqueued += result.enqueued;
            if (result.reason && result.reason !== 'ok' && skipped[result.reason] !== undefined) {
                skipped[result.reason]++;
            }
        } catch (err) {
            console.error(`draft-horizon-fill: assistant ${assistant.id} failed`, err);
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, assistantsChecked: smmAssistants.length, jobsEnqueued, skipped }),
    };
};
