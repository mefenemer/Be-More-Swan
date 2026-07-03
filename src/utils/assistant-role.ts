// assistant-role.ts — resolve an assistant (org-scoped) to its role for the
// connection-policy guard (see connection-map.ts). Kept separate from connection-map.ts
// so that module stays DB-free and unit-testable.

import { and, eq, sql } from 'drizzle-orm';
import { aiAssistants } from '../../db/schema';
import type { AssistantRole } from './connection-map';

// Returns { role, roleKey } or null when the id is missing / not in the org.
// `db` is a drizzle instance (getDb()/tx); typed loosely to avoid import cycles.
export async function resolveAssistantRole(
    db: any,
    orgId: number | null | undefined,
    assistantId: number,
): Promise<AssistantRole | null> {
    if (!orgId || !Number.isFinite(assistantId)) return null;
    const [a] = await db.select({
        role: aiAssistants.aiAssistantJobRole,
        roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
    }).from(aiAssistants).where(and(
        eq(aiAssistants.id, assistantId),
        eq(aiAssistants.organisationId, orgId),
    )).limit(1);
    return a ?? null;
}
