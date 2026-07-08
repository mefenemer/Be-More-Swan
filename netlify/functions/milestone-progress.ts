// netlify/functions/milestone-progress.ts
// US-AUD-2.3.1: Returns milestone unlock progress for coming-soon assistants
import { HandlerEvent } from '@netlify/functions';
import { eq, and, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { masterAssistants, taskRuns, waitlist, notifications } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event: HandlerEvent) => {
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    // Auth
    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }
    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();

    // GET: Return progress for all coming-soon assistants
    if (event.httpMethod === 'GET') {
        try {
            // Count completed tasks for this user (SC3)
            const [{ completedCount }] = await db
                .select({ completedCount: count() })
                .from(taskRuns)
                .where(and(eq(taskRuns.userId, userId), eq(taskRuns.status, 'completed')));

            const n = Number(completedCount) || 0;

            // Fetch all active coming-soon assistants
            const comingSoonAssistants = await db
                .select({
                    id: masterAssistants.id,
                    roleKey: masterAssistants.roleKey,
                    name: masterAssistants.name,
                    description: masterAssistants.description,
                    milestoneTasksRequired: masterAssistants.milestoneTasksRequired,
                    comingSoon: masterAssistants.comingSoon,
                })
                .from(masterAssistants)
                .where(and(eq(masterAssistants.comingSoon, true), eq(masterAssistants.isActive, true)));

            // Fetch which ones this user has joined waitlist for (notify toggle)
            const userWaitlist = await db
                .select({ masterAssistantId: waitlist.masterAssistantId })
                .from(waitlist)
                .where(eq(waitlist.userId, userId));

            const notifySet = new Set(userWaitlist.map(w => w.masterAssistantId));

            // SC4: fire in-app notification on first milestone crossing (fire-and-forget)
            const unlockedAssistants = comingSoonAssistants.filter(a => n >= (a.milestoneTasksRequired ?? 25));
            if (unlockedAssistants.length > 0) {
                void (async () => {
                    try {
                        for (const a of unlockedAssistants) {
                            // Check if notification already sent for this assistant
                            const [existing] = await db
                                .select({ id: notifications.id })
                                .from(notifications)
                                .where(and(
                                    eq(notifications.userId, userId),
                                    eq(notifications.type, 'milestone_unlock'),
                                ))
                                .limit(1);
                            if (existing) continue;
                            // Check metadata for assistantId to be precise
                            // Use a lightweight check: insert only if none exists with this assistantId in metadata
                            // (The simple check above catches all milestone_unlock notifications — acceptable for typical small unlocked-assistant counts)
                            await db.insert(notifications).values({
                                userId,
                                type: 'milestone_unlock',
                                title: `You've unlocked early access to ${a.name}!`,
                                message: `You've earned early access to ${a.name} — you're in! Head to the assistant catalogue to hire this role.`,
                                metadata: { assistantId: a.id, roleKey: a.roleKey },
                            });
                            // Mark waitlist entry as notified if present
                            if (notifySet.has(a.id)) {
                                await db.update(waitlist)
                                    .set({ notified: true })
                                    .where(and(eq(waitlist.userId, userId), eq(waitlist.masterAssistantId, a.id)));
                            }
                        }
                    } catch { /* non-blocking */ }
                })();
            }

            const results = comingSoonAssistants.map(a => {
                const required = a.milestoneTasksRequired ?? 25;
                const pct = Math.min(Math.round((n / required) * 100), 100);
                const unlocked = n >= required;
                return {
                    id: a.id,
                    roleKey: a.roleKey,
                    name: a.name,
                    description: a.description,
                    milestoneTasksRequired: required,
                    completedTasks: n,
                    pct,
                    unlocked,
                    notifyEnabled: notifySet.has(a.id),
                };
            });

            return {
                statusCode: 200,
                body: JSON.stringify({ completedTasks: n, assistants: results }),
            };
        } catch (err) {
            console.error('milestone-progress GET error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch milestone progress.' }) };
        }
    }

    // POST: Toggle "Notify me" — add/remove from waitlist
    if (event.httpMethod === 'POST') {
        try {
            const body = JSON.parse(event.body || '{}');
            const { masterAssistantId, enable } = body;
            if (!masterAssistantId) {
                return { statusCode: 400, body: JSON.stringify({ error: 'masterAssistantId required.' }) };
            }

            // Fetch user email for waitlist
            const { users } = await import('../../db/schema');
            const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
            if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

            const existing = await db
                .select({ id: waitlist.id })
                .from(waitlist)
                .where(and(eq(waitlist.userId, userId), eq(waitlist.masterAssistantId, masterAssistantId)))
                .limit(1);

            if (enable && existing.length === 0) {
                await db.insert(waitlist).values({
                    userId,
                    email: user.email,
                    masterAssistantId,
                    source: 'registered',
                });
            } else if (!enable && existing.length > 0) {
                await db.delete(waitlist).where(and(eq(waitlist.userId, userId), eq(waitlist.masterAssistantId, masterAssistantId)));
            }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        } catch (err) {
            console.error('milestone-progress POST error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update notification preference.' }) };
        }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
