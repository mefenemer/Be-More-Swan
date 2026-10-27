// netlify/functions/notifications.ts
import { HandlerEvent } from '@netlify/functions';
import { eq, and, desc, isNull, inArray, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, notifications, userProfiles, aiAssistants } from '../../db/schema';
import { kindOf, categoryOf, priorityOf, isDismissibleType, resolvesOnClick } from '../../src/utils/notification-actions';
import { isInAppEnabledFor, resolveInAppPrefs, type AssistantOverrideMap } from '../../src/utils/notification-prefs';
import { withLambda } from '@netlify/aws-lambda-compat';

import { liveRoleLabel } from '../../src/utils/live-role-label';
import { readCombineCrossPosts, loadPostGroups, combineCrossPostNotes, expandCrossPostIds } from '../../src/utils/crosspost-view';
import { requireTenant } from '../../src/utils/tenant';
import { resolveImpersonation, impersonationWriteBlock } from '../../src/utils/impersonation';
import { openQuestionCount, unreadCount as teamUnreadCount } from '../../src/utils/team-messages';
const jwtSecret = process.env.JWT_SECRET;

// Notification "kind" classification (action vs info) lives in src/utils/notification-actions.ts
// as the single source of truth — imported here so the inbox/badge and the server-side
// auto-resolver agree on what counts as an "action". Unknown types default to 'info'.

export default withLambda(async (event: HandlerEvent) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Authenticate the User
    const rawCookieHeader = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookieHeader.split(';').map(c => {
            const [key, ...v] = c.trim().split('=');
            return [key, decodeURIComponent(v.join('='))];
        }).filter(([key]) => key !== '')
    );

    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    // An admin impersonating a customer sees THAT customer's notifications, read-only — the same
    // identity switch requireTenant makes. Before this, aura_session alone decided the user, so the
    // customer's inbox showed the admin's own rows (the staff-only "Quarterly Bias Review Due").
    const imp = await resolveImpersonation(db, event.headers.cookie, userId);
    if (imp) {
        const blocked = impersonationWriteBlock(event.httpMethod, imp);
        if (blocked) return blocked;
        userId = imp.impersonatingUserId;
    }

    try {
        // -------------------------------------------------------------
        // GET: Fetch all notifications for the user OR get unread count
        // -------------------------------------------------------------
        if (event.httpMethod === 'GET') {
            const { queryStringParameters } = event;
            // Resilient to deploy ordering: if db/notifications-categorization.sql hasn't been
            // applied yet, selecting the new columns throws — fall back to the legacy columns so
            // the panel keeps working (resolvedAt is simply absent until the migration lands).
            let allNotes: Array<typeof notifications.$inferSelect & { resolvedAt?: Date | null }>;
            try {
                allNotes = await db.select()
                    .from(notifications)
                    // Hide rows the user has dismissed (US3). isNull also throws pre-migration → fallback.
                    .where(and(eq(notifications.userId, userId), isNull(notifications.dismissedAt)))
                    // id as tiebreaker: rows created in the same transaction can share an identical
                    // createdAt (Postgres now() is transaction-time), so createdAt alone can't
                    // guarantee the most recently inserted notification sorts first.
                    .orderBy(desc(notifications.createdAt), desc(notifications.id));
            } catch {
                allNotes = await db.select({
                    id: notifications.id, userId: notifications.userId, type: notifications.type,
                    title: notifications.title, message: notifications.message, isRead: notifications.isRead,
                    readAt: notifications.readAt, metadata: notifications.metadata, createdAt: notifications.createdAt,
                }).from(notifications).where(eq(notifications.userId, userId))
                  .orderBy(desc(notifications.createdAt), desc(notifications.id)) as typeof allNotes;
            }

            // In-app delivery preferences: hide categories the user has switched off in the
            // bell (account settings → Notification Preferences). Locked categories
            // (account/security, billing) always pass via the gate. Single chokepoint —
            // applies regardless of which function created the row. Rows attributed to an
            // assistant (assistant_id column, or assistantId in metadata pre-migration)
            // additionally honour that assistant's per-user overrides. Defensive: if the
            // in_app_preferences / assistant_notif_prefs columns aren't migrated yet,
            // degrade to "all defaults on" / "no overrides".
            let inAppPrefs: Record<string, boolean>;
            let assistantOverrides: AssistantOverrideMap = null;
            try {
                const [prof] = await db.select({
                    inApp: userProfiles.inAppPreferences,
                    notifyAvailability: userProfiles.notifyAvailability,
                    assistantPrefs: userProfiles.assistantNotifPrefs,
                }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
                inAppPrefs = resolveInAppPrefs((prof?.inApp as Record<string, boolean>) ?? null, prof?.notifyAvailability ?? null);
                assistantOverrides = (prof?.assistantPrefs as AssistantOverrideMap) ?? null;
            } catch {
                // assistant_notif_prefs may predate in_app_preferences in some environments —
                // retry without it so the workspace-wide prefs still load.
                try {
                    const [prof] = await db.select({
                        inApp: userProfiles.inAppPreferences,
                        notifyAvailability: userProfiles.notifyAvailability,
                    }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
                    inAppPrefs = resolveInAppPrefs((prof?.inApp as Record<string, boolean>) ?? null, prof?.notifyAvailability ?? null);
                } catch {
                    inAppPrefs = resolveInAppPrefs(null, null);
                }
            }
            const assistantIdOf = (n: any): number | string | null =>
                n.assistantId ?? (n.metadata as any)?.assistantId ?? (n.metadata as any)?.assistant_id ?? null;
            allNotes = allNotes.filter(n => isInAppEnabledFor(inAppPrefs, assistantOverrides, assistantIdOf(n), n.type));

            // One cross-post, one notification (user preference, default on — crosspost-view.ts).
            // Done BEFORE the counts so the badge and the list agree about how many items there are.
            if (await readCombineCrossPosts(db, userId)) {
                allNotes = combineCrossPostNotes(allNotes, await loadPostGroups(db, allNotes));
            }

            // Counts for the ONE badge (the Notifications side-menu item and the bell show the same
            // numbers — notifications.js updateNotificationBadge). Two kinds, never mixed:
            //   needsYou = open actions (unresolved, read or not: reading an action does not do it)
            //            + Team questions to the person nobody has answered yet
            //   fyi      = unread updates + unread Team messages (open questions are not in it)
            // A notification is either action-kind or info-kind, and a Team message is either an open
            // question or not, so nothing is counted twice. actionCount keeps its old meaning (unread,
            // unresolved actions) for any caller still reading it.
            if (queryStringParameters && queryStringParameters.action === 'count') {
                const unread = allNotes.filter(n => !n.isRead).length;
                const openActions = allNotes.filter(n => !n.resolvedAt && kindOf(n.type) === 'action').length;
                const actionCount = allNotes.filter(n => !n.resolvedAt && !n.isRead && kindOf(n.type) === 'action').length;
                const updateUnread = allNotes.filter(n => !n.isRead && kindOf(n.type) !== 'action').length;
                // Team Chat lives in the workspace, not on the user row. Resolved the way team.ts does
                // (requireTenant), so the two never disagree. A failed read is no Team count, never a
                // failed badge.
                let teamQuestions = 0;
                let teamUnread = 0;
                try {
                    const ctx = await requireTenant(event, db);
                    if (!('error' in ctx)) {
                        [teamQuestions, teamUnread] = await Promise.all([
                            openQuestionCount(db, ctx.organisationId),
                            teamUnreadCount(db, ctx.organisationId, ctx.userId),
                        ]);
                    }
                } catch (err) {
                    console.warn('[notifications] Team counts unavailable:', err instanceof Error ? err.message : err);
                }
                const needsYou = openActions + teamQuestions;
                const fyi = updateUnread + teamUnread;
                const badgeCount = needsYou + fyi;
                // Type of the newest visible notification (allNotes is ordered newest-first).
                // When badgeCount rises, this is the item that just arrived — the client uses
                // it to decide which sound to play (Aurora chime for milestones / "assistant
                // ready to work", the Swan & Wand sound for everything else).
                const latestType = allNotes[0]?.type ?? null;
                return { statusCode: 200, body: JSON.stringify({
                    unreadCount: unread, actionCount, updateUnread, badgeCount, latestType,
                    needsYou, fyi, openActions, teamQuestions, teamUnread,
                }) };
            }

            // Actor identity: resolve each assistant-attributed notification to its assistant's
            // name + job role so the inbox can render "who" (avatar/name/colour) rather than a
            // generic system icon. account-level rows (assistantId null) stay system-attributed.
            // One batched lookup for all ids on the feed; names aren't sensitive and the ids are
            // already scoped to this user's own notifications. Defensive: if the assistant was
            // deleted (id no longer resolves), the row simply falls back to system attribution.
            // assistantIdOf may return a string (metadata) or number (column); normalise to a
            // positive integer id for the assistants lookup, or null when it isn't one.
            const numericAssistantId = (n: any): number | null => {
                const raw = assistantIdOf(n);
                const num = typeof raw === 'string' ? Number(raw) : raw;
                return typeof num === 'number' && Number.isInteger(num) && num > 0 ? num : null;
            };
            const actorIds = [...new Set(allNotes.map(numericAssistantId).filter((id): id is number => id !== null))];
            let actorById = new Map<number, { name: string; jobRole: string | null; avatarColor: string | null; avatarLetter: string | null }>();
            if (actorIds.length > 0) {
                try {
                    const rows = await db.select({
                        id: aiAssistants.id, name: aiAssistants.name, jobRole: liveRoleLabel,
                        // The user's chosen icon colour, so the inbox draws the same assistant in the
                        // same colour as the cards and the calendar. Null ⇒ automatic (id-derived).
                        avatarColor: sql<string | null>`(${aiAssistants.configuration} ->> 'avatarColor')`,
                        avatarLetter: sql<string | null>`(${aiAssistants.configuration} ->> 'avatarLetter')`,
                    }).from(aiAssistants).where(inArray(aiAssistants.id, actorIds));
                    actorById = new Map(rows.map(r => [r.id, { name: r.name, jobRole: r.jobRole, avatarColor: r.avatarColor, avatarLetter: r.avatarLetter }]));
                } catch { /* assistant lookup best-effort; degrade to system attribution */ }
            }

            // Annotate each notification with its category model (kind/category/priority/
            // dismissible/resolvesOnClick) so the client renders, sorts and resolves without
            // duplicating the classification. category etc. are derived from the canonical map
            // (authoritative even for rows inserted before the DB trigger backfill). `actor`
            // carries the assistant's identity (null ⇒ BMS system) for the actor-led card UI.
            const annotated = allNotes.map(n => {
                const aid = numericAssistantId(n);
                const asst = aid !== null ? actorById.get(aid) : null;
                return {
                    ...n,
                    kind: kindOf(n.type),
                    category: categoryOf(n.type),
                    priority: priorityOf(n.type),
                    isDismissible: isDismissibleType(n.type),
                    resolvesOnClick: resolvesOnClick(n.type),
                    actor: asst ? { assistantId: aid, name: asst.name, jobRole: asst.jobRole, avatarColor: asst.avatarColor, avatarLetter: asst.avatarLetter } : null,
                };
            });
            return { statusCode: 200, body: JSON.stringify({ notifications: annotated }) };
        }

        // -------------------------------------------------------------
        // PATCH: Mark a SINGLE notification as read
        // -------------------------------------------------------------
        if (event.httpMethod === 'PATCH') {
            const body = JSON.parse(event.body || '{}');
            const { notificationId } = body;

            if (!notificationId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing notificationId' }) };
            if (!Number.isInteger(Number(notificationId))) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid notificationId' }) };

            // A combined cross-post row carries the newest sibling's id; act on every platform's row.
            const targetIds = await readCombineCrossPosts(db, userId)
                ? await expandCrossPostIds(db, userId, [Number(notificationId)])
                : [Number(notificationId)];

            // US3 — Strict Dismissal Rules. dismiss:true hides the item, but ONLY if its type is
            // dismissible. critical_action is hardcoded non-dismissible (AC3.2): the X is hidden
            // client-side (AC3.3) AND the server refuses it here, so billing/legal alerts can't be
            // swiped away by a crafted request.
            if (body.dismiss === true) {
                const [row] = await db.select({ type: notifications.type })
                    .from(notifications)
                    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
                    .limit(1);
                if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
                if (!isDismissibleType(row.type)) {
                    return { statusCode: 403, body: JSON.stringify({ error: 'This notification cannot be dismissed.' }) };
                }
                await db.update(notifications)
                    .set({ dismissedAt: new Date() })
                    .where(and(inArray(notifications.id, targetIds), eq(notifications.userId, userId)));
                return { statusCode: 200, body: JSON.stringify({ success: true }) };
            }

            // resolved:true → mark the item Done (sets resolvedAt, the true "closed" signal) AND read.
            // Otherwise this is a read/unread toggle: isRead defaults to true (mark read); the Updates
            // tab also sends isRead:false to flip back to unread. resolvedAt is never cleared here.
            const resolved = body.resolved === true;
            const isRead = resolved ? true : (body.isRead === undefined ? true : !!body.isRead);

            const now = new Date();
            const setValues: Record<string, unknown> = { isRead, readAt: isRead ? now : null };
            if (resolved) setValues.resolvedAt = now;

            // Ensure the user owns this notification before updating
            await db.update(notifications)
                .set(setValues)
                .where(and(inArray(notifications.id, targetIds), eq(notifications.userId, userId)));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // -------------------------------------------------------------
        // PUT: Bulk action - Mark ALL as read
        // -------------------------------------------------------------
        if (event.httpMethod === 'PUT') {
            // Optional { ids: number[] } scopes the bulk-read to just those notifications (the client
            // sends the current tab's unread ids so the other tab is left alone). No ids ⇒ legacy
            // "mark absolutely everything read" for back-compat.
            const putBody = event.body ? JSON.parse(event.body) : {};
            const ids = Array.isArray(putBody.ids)
                ? putBody.ids.filter((n: unknown): n is number => Number.isInteger(n))
                : null;
            const conds = [eq(notifications.userId, userId), eq(notifications.isRead, false)];
            if (ids && ids.length) {
                // The tab's ids are the combined rows' ids; widen to their platform siblings.
                const scoped = await readCombineCrossPosts(db, userId) ? await expandCrossPostIds(db, userId, ids) : ids;
                conds.push(inArray(notifications.id, scoped));
            }

            await db.update(notifications).set({ isRead: true }).where(and(...conds));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error('Notifications API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
});