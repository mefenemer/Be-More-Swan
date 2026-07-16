// netlify/functions/expire-pending-actions.ts
// US-GOV-4.1.2: Hourly scheduled job to cancel pending HITL actions past their 24h expiry.
// Schedule: '0 * * * *' (every hour)

import type { Handler } from '@netlify/functions';
import { and, eq, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { pendingActions } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { withLambda } from '@netlify/aws-lambda-compat';

async function runExpiry() {
    const db = getDb();
    const now = new Date();

    const expired = await db.update(pendingActions)
        .set({ status: 'expired' })
        .where(and(eq(pendingActions.status, 'pending'), lt(pendingActions.expiresAt, now)))
        .returning({ id: pendingActions.id, userId: pendingActions.userId, actionType: pendingActions.actionType, taskRunId: pendingActions.taskRunId, assistantId: pendingActions.assistantId });

    // Notify each deployer whose actions expired. Per-row copy differs (actionType/runId), so
    // one createNotification per expired action rather than a single fan-out.
    for (const a of expired) {
        await createNotification(db, 'action_expired', {
            userId: a.userId!,
            context: { action: { type: a.actionType }, run: { id: a.taskRunId } },
            metadata: { pendingActionId: a.id, assistantId: a.assistantId },
        });
    }

    console.log(`[expire-pending-actions] Expired ${expired.length} pending action(s).`);
    return { expired: expired.length };
}

export default withLambda(async () => {
    const result = await runExpiry();
    return { statusCode: 200, body: JSON.stringify(result) };
});
