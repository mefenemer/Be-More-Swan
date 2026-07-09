// netlify/functions/purge-archived-assistants.ts
// Issue #191 — Safe Archiving grace period: an archived assistant can be reinstated for
// scheduled_deletion_at (archived_at + 14 days). Past that deadline it's hard-deleted here,
// along with every row that references it (aiAssistants' child tables are ON DELETE CASCADE),
// as spelled out in the archive notification (manage-assistant.ts). Scheduled via netlify.toml:
// runs daily. Mirrors netlify/functions/archive-cleanup.ts.

import { and, eq, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, adminAuditLog } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async () => {
    const db = getDb();
    const now = new Date();

    const expired = await db
        .select({ id: aiAssistants.id, organisationId: aiAssistants.organisationId })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.lifecycleStatus, 'archived'),
            lt(aiAssistants.scheduledDeletionAt, now),
        ))
        .limit(500);

    if (!expired.length) {
        return { statusCode: 200, body: JSON.stringify({ deleted: 0 }) };
    }

    const ids = expired.map(a => a.id);
    await db.delete(aiAssistants).where(inArray(aiAssistants.id, ids));

    const summary: Record<number, number> = {};
    for (const a of expired) {
        const org = a.organisationId ?? 0;
        summary[org] = (summary[org] ?? 0) + 1;
    }

    await db.insert(adminAuditLog).values({
        adminId: null,
        action: 'assistant_archive_purge',
        targetType: 'ai_assistants',
        targetId: null,
        newState: { deletedByOrg: summary, deletedCount: ids.length },
        ipAddress: 'scheduled',
    }).catch(() => {});

    console.log(`[purge-archived-assistants] deleted=${ids.length} assistants past their 14-day reinstate window`);
    return { statusCode: 200, body: JSON.stringify({ deleted: ids.length }) };
});
