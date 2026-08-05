// netlify/functions/draft-horizon-fill.ts
// US-SMM-2.4.1 (+ Posting Schedule): Hourly job — for each active Social Media Manager assistant,
// fill any uncovered posting slots inside its draft horizon by enqueuing generation jobs, each
// stamped with the exact target_publish_date derived from the assistant's frequency / days / times.
//
// Schedule: "0 * * * *"  (hourly, on the hour). Was daily at 06:00 — see netlify.toml for why it
// moved. Safe at this cadence because enqueueScheduleGapFill counts in-flight jobs as coverage, so
// re-running fills only genuine deficits.
// The jobs land in content_generation_jobs; process-content-jobs.ts turns each into a dated draft
// in the Review Queue. This function no longer enqueues opaque task runs — it directly tops up the
// generation queue so the user always has content N days ahead.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { enqueueScheduleGapFill, GAP_FILL_ATTENTION_REASONS } from '../../src/utils/schedule-gap-fill';
import { SMM_ROLE_KEYS } from '../../src/constants/roles';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
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
    // Every reason enqueueScheduleGapFill can return. The tally used to ignore any reason missing
    // from this object (`skipped[result.reason] !== undefined`), so adding a reason to the helper
    // without adding it here silently dropped it — the counter would read all-zeroes and look
    // healthy. Keep this list exhaustive; the test asserts it matches the union.
    const skipped: Record<string, number> = {
        on_demand: 0, unrecognised_cadence: 0, no_slot_in_horizon: 0,
        no_blueprint: 0, blocking_gaps: 0, fully_covered: 0, empty_library_skipped: 0,
    };
    // Assistants that will never draft again until a human changes something. The user gets an
    // in-app notification (see notifyUnreadableCadence); this is the operator's copy — a run that
    // quietly does nothing for a tenant should be legible in the invocation log without a DB query.
    const needsAttention: { assistantId: number; organisationId: number; reason: string }[] = [];

    for (const assistant of smmAssistants) {
        try {
            const result = await enqueueScheduleGapFill(db, assistant, now);
            jobsEnqueued += result.enqueued;
            if (result.reason && result.reason !== 'ok' && skipped[result.reason] !== undefined) {
                skipped[result.reason]++;
            }
            if (result.reason && GAP_FILL_ATTENTION_REASONS.has(result.reason)) {
                needsAttention.push({
                    assistantId: assistant.id,
                    organisationId: assistant.organisationId,
                    reason: result.reason,
                });
                console.warn(
                    `draft-horizon-fill: assistant ${assistant.id} (org ${assistant.organisationId}) ` +
                    `enqueued nothing — ${result.reason}. It has drafted no scheduled posts and will not ` +
                    `until its posting_frequency is set to a value the cadence parser understands.`,
                );
            }
        } catch (err) {
            console.error(`draft-horizon-fill: assistant ${assistant.id} failed`, err);
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ran: true, assistantsChecked: smmAssistants.length, jobsEnqueued, skipped, needsAttention,
        }),
    };
});
