// netlify/functions/expire-pending-actions.ts
// US-GOV-4.1.2: Hourly scheduled job to cancel pending HITL actions past their 24h expiry.
// Schedule: '0 * * * *' (every hour)

import type { Handler } from '@netlify/functions';
import { and, eq, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { pendingActions, notifications } from '../../db/schema';

async function runExpiry() {
    const db = getDb();
    const now = new Date();

    const expired = await db.update(pendingActions)
        .set({ status: 'expired' })
        .where(and(eq(pendingActions.status, 'pending'), lt(pendingActions.expiresAt, now)))
        .returning({ id: pendingActions.id, userId: pendingActions.userId, actionType: pendingActions.actionType, taskRunId: pendingActions.taskRunId, assistantId: pendingActions.assistantId });

    if (expired.length > 0) {
        // Notify each deployer whose actions expired
        const notifValues = expired.map(a => ({
            userId: a.userId!,
            type: 'action_expired' as const,
            title: `Pending action expired: ${a.actionType}`,
            message: `The ${a.actionType} action for run #${a.taskRunId} was not approved within 24 hours and has been automatically cancelled.`,
            metadata: { pendingActionId: a.id, assistantId: a.assistantId },
        }));
        await db.insert(notifications).values(notifValues).catch(() => {});
    }

    console.log(`[expire-pending-actions] Expired ${expired.length} pending action(s).`);
    return { expired: expired.length };
}

export const handler: Handler = async () => {
    const result = await runExpiry();
    return { statusCode: 200, body: JSON.stringify(result) };
};
