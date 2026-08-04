// src/utils/connection-recovery.ts
// The inverse of the connection-failure blast radius.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// When an OAuth token could not be refreshed, three things happened at once
// (refresh-social-tokens.ts / refresh-meta-tokens.ts / publish-instagram.ts):
//
//   1. system_connections.status  → 'token_refresh_failed' | 'token_expired'
//   2. scheduled_posts.status     → 'paused'   (every 'scheduled' post on that connection)
//   3. ai_assistants.lifecycle    → 'system_paused'  (every 'working' assistant in scope)
//
// and the user was emailed "your scheduled posts have been paused and will resume once you
// reconnect". Only (1) was ever undone. Reconnecting set the connection active again and cleared
// the notification, and that was the whole of it: nothing in the codebase ever wrote
// scheduled_posts.status back to 'scheduled', and nothing ever lifted an assistant out of
// system_paused. Three writers set 'paused'; there were zero readers reversing it.
//
// So every connection breakage stranded its posts permanently. The posts stayed invisible to the
// publisher (which requires status='scheduled'), the assistant stayed halted, and the only symptom
// was silence — while the email had already promised the user it would fix itself.
//
// Call this from every path that brings a connection back to life. It is best-effort by design:
// a reconnect must never 500 because the cleanup half failed.

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, auditLogs, scheduledPosts, systemConnections } from '../../db/schema';
import { DEAD_CONNECTION_STATUSES } from '../config/connection-status';
import { transitionAssistantStatus } from './assistant-lifecycle';
import { CONNECTION_RESTORED_TYPES, resolveActionNotifications } from './notification-actions';

type Db = ReturnType<typeof getDb>;

/**
 * Reasons `systemPauseWorkingAssistants` is called with when a credential dies, minus the
 * `:serviceName` suffix. An assistant is only resumed when its most recent system-pause carries
 * one of these for the connection being restored — so an assistant halted for an unrelated
 * reason (budget, quota, a different dead platform) is left exactly where it is.
 */
export const CONNECTION_PAUSE_REASON_PREFIXES = ['token_refresh_failed:', 'token_expired:'] as const;

/** The reason string a credential failure on `serviceName` writes into the lifecycle audit row. */
export function connectionPauseReasons(serviceName: string): string[] {
    return CONNECTION_PAUSE_REASON_PREFIXES.map((p) => `${p}${serviceName}`);
}

export interface RestoreResult {
    postsResumed: number;
    assistantsResumed: number;
    notificationsCleared: number;
}

const EMPTY: RestoreResult = { postsResumed: 0, assistantsResumed: 0, notificationsCleared: 0 };

/**
 * Undo the side-effects a credential failure inflicted on one connection's dependents.
 *
 * Call AFTER the connection row itself is back to status='active' — the assistant-resume guard
 * reads current connection statuses to decide whether anything is still broken.
 *
 * @param connectionId    the system_connections row that was just restored
 * @param organisationId  its org
 * @param assistantId     its assistant when the connection is assistant-scoped, else null/undefined
 *                        for an org-pool connection (which serves every assistant in the org)
 * @param serviceName     'x' | 'linkedin' | 'instagram' | 'facebook' | …
 * @param userId          whose open "reconnect" action items to clear (optional)
 */
export async function restoreConnectionDependents(
    db: Db,
    opts: {
        connectionId: number;
        organisationId: number;
        assistantId?: number | null;
        serviceName: string;
        userId?: number | null;
    },
): Promise<RestoreResult> {
    const { connectionId, organisationId, assistantId, serviceName, userId } = opts;

    try {
        const postsResumed = await resumePausedPosts(db, connectionId);
        const assistantsResumed = await resumeSystemPausedAssistants(db, { organisationId, assistantId, serviceName });
        const notificationsCleared = userId
            ? await resolveActionNotifications(db, userId, [
                ...CONNECTION_RESTORED_TYPES,
                // refresh-social-tokens stamps a COMPUTED type (`${serviceName}_token_refresh_failed`)
                // so a reconnect clears one platform's prompt without touching another's. The computed
                // values were never added to the resolve list, so the card it raised stayed open
                // forever — see notification-actions.ts.
                `${serviceName}_token_refresh_failed`,
            ])
            : 0;

        if (postsResumed || assistantsResumed) {
            console.log(
                `[connection-recovery] conn ${connectionId} (${serviceName}) restored: ` +
                `${postsResumed} post(s) resumed, ${assistantsResumed} assistant(s) resumed`,
            );
        }

        return { postsResumed, assistantsResumed, notificationsCleared };
    } catch (err) {
        // Never break the reconnect itself. A failure here leaves the user exactly where they were
        // before this module existed, which is recoverable by hand; a thrown error loses the OAuth
        // callback and with it the freshly-minted token.
        console.error(`[connection-recovery] conn ${connectionId} (${serviceName}) restore failed:`, err);
        return EMPTY;
    }
}

/**
 * Put this connection's paused posts back in the publish queue.
 *
 * Only FUTURE slots. A paused post whose publish_date has already gone by is a missed slot, not a
 * recoverable one — resuming it would either fire stale content the moment the queue next runs or
 * land straight in the missed-post sweeper. Those are left paused deliberately.
 *
 * Scoping by connection_id is unambiguous: the only writers that put a scheduled_post into
 * 'paused' are the three credential-failure paths, all of which scope by this same connection.
 * (Billing suspension pauses `plans`, not posts, and quota/credit pauses use their own
 * `paused_quota` / `paused_credits` statuses.)
 */
async function resumePausedPosts(db: Db, connectionId: number): Promise<number> {
    const resumed = await db.update(scheduledPosts)
        .set({ status: 'scheduled', updatedAt: new Date() })
        .where(and(
            eq(scheduledPosts.connectionId, connectionId),
            eq(scheduledPosts.status, 'paused'),
            gt(scheduledPosts.publishDate, new Date()),
        ))
        .returning({ id: scheduledPosts.id });

    return resumed.length;
}

/**
 * Lift assistants back out of `system_paused` — but only the ones this connection put there, and
 * only when nothing else is still broken.
 *
 * Two guards, both necessary:
 *   • the assistant's most recent system-pause must name THIS service, so an assistant halted for
 *     an unrelated reason is not silently reactivated by a lucky reconnect elsewhere;
 *   • no other connection in scope may still be dead, so reconnecting X while Instagram is also
 *     down does not resume an assistant that is about to fail on its next Instagram post.
 *
 * Restores to 'working' because that is the only state `systemPauseWorkingAssistants` takes them
 * from (system_paused → working is a legal transition).
 */
async function resumeSystemPausedAssistants(
    db: Db,
    opts: { organisationId: number; assistantId?: number | null; serviceName: string },
): Promise<number> {
    const { organisationId, assistantId, serviceName } = opts;

    // Guard 2 — anything else still dead in scope blocks the resume. An assistant-scoped
    // connection is blocked by its own assistant's connections plus the org pool (assistant_id
    // NULL); an org-pool connection is blocked by anything dead in the org, since it serves all.
    const stillBroken = await db.select({ id: systemConnections.id })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            inArray(systemConnections.status, DEAD_CONNECTION_STATUSES),
            assistantId
                ? or(isNull(systemConnections.assistantId), eq(systemConnections.assistantId, assistantId))
                : undefined,
        ))
        .limit(1);

    if (stillBroken.length) {
        console.log(
            `[connection-recovery] org ${organisationId}: another connection is still dead — ` +
            `leaving assistants system_paused`,
        );
        return 0;
    }

    const conds = [
        eq(aiAssistants.organisationId, organisationId),
        eq(aiAssistants.lifecycleStatus, 'system_paused'),
    ];
    if (assistantId) conds.push(eq(aiAssistants.id, assistantId));

    const candidates = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(...conds));

    const wanted = new Set(connectionPauseReasons(serviceName));
    let resumed = 0;

    for (const a of candidates) {
        // Guard 1 — why was this one paused? transitionAssistantStatus records the reason on the
        // lifecycle audit row; the most recent one is the pause that is currently in force.
        const [lastPause] = await db.select({ newState: auditLogs.newState })
            .from(auditLogs)
            .where(and(
                eq(auditLogs.actionType, 'assistant_lifecycle_system_paused'),
                eq(auditLogs.resourceType, 'ai_assistants'),
                eq(auditLogs.resourceId, String(a.id)),
            ))
            .orderBy(desc(auditLogs.createdAt))
            .limit(1);

        const reason = (lastPause?.newState as { reason?: string } | null)?.reason;

        // No recorded reason → leave it alone. Rows predating the reason argument exist, and a
        // silent auto-resume of an assistant we cannot explain is worse than a manual click.
        if (!reason || !wanted.has(reason)) continue;

        const res = await transitionAssistantStatus(db, a.id, 'working', {
            reason: `connection_restored:${serviceName}`,
        });
        if (res.ok && !res.noop) resumed++;
    }

    return resumed;
}
