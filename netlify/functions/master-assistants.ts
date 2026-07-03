// master-assistants.ts
// GET    — public endpoint, no auth required
//          Returns the full master assistant catalog with waitlist counts.
//          Logged-in callers also receive their own waitlist entries (for button state).
//
// PATCH  ?id=N — admin/internal: update a master assistant's fields.
//          When comingSoon transitions true→false, fans out in-app "new_role_availability"
//          notifications to every user who has notifyAvailability=true.
//
// GET query params:
//   ?category=Marketing+%26+Sales   (optional filter)
//   ?q=keyword                       (optional search)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, ilike, or, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { getDb } from '../../db/client';
import { masterAssistants, waitlist, userProfiles, notifications, organisations, userOrganisations } from '../../db/schema';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@bemoreswan.com';

const jwtSecret = process.env.JWT_SECRET;

// ── PATCH: update master assistant (admin) ────────────────────────────────────
async function handlePatch(event: any): Promise<any> {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // Require auth for writes
    const cookieHeader = event.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
    if (!cookieMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let adminId: number;
    try {
        adminId = (jwt.verify(cookieMatch[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const id = parseInt(event.queryStringParameters?.id || '');
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    let body: Record<string, any> = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const db = getDb();

    // Fetch current record
    const [existing] = await db
        .select()
        .from(masterAssistants)
        .where(eq(masterAssistants.id, id))
        .limit(1);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Master assistant not found.' }) };

    // Build update payload (only allow safe fields)
    const allowedFields = ['name', 'description', 'category', 'iconKey', 'iconColor', 'comingSoon', 'isActive', 'riskClassification', 'lifecycleState', 'specialCategoryClauseEnabled'];
    const updates: Record<string, any> = {};
    for (const f of allowedFields) {
        if (body[f] !== undefined) updates[f] = body[f];
    }

    if (Object.keys(updates).length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No valid fields to update.' }) };
    }

    const [updated] = await db
        .update(masterAssistants)
        .set(updates)
        .where(eq(masterAssistants.id, id))
        .returning();

    // ── New role launch notification fan-out ──────────────────────────────────
    // Trigger: comingSoon was true and is now being set to false.
    const launchingNow = existing.comingSoon === true && updates.comingSoon === false;
    let notifiedCount = 0;

    if (launchingNow) {
        try {
            // Find all user profiles opted in to New Role Availability in-app alerts. The
            // canonical store is in_app_preferences.new_role_availability (account settings →
            // Notification Preferences); fall back to the legacy notify_availability column
            // when the user has no stored in-app prefs yet. Mirrors resolveInAppPrefs so the
            // creation gate agrees with the read-time filter in notifications.ts. (Errs
            // permissive — the read filter hides any over-creation; it must never under-create.)
            const profiles = await db
                .select({ userId: userProfiles.userId })
                .from(userProfiles)
                .where(sql`COALESCE((${userProfiles.inAppPreferences} ->> 'new_role_availability')::boolean, ${userProfiles.notifyAvailability}) = true`);

            if (profiles.length > 0) {
                const notifRows = profiles.map(p => ({
                    userId: p.userId,
                    title: `New Role Available: ${updated.name}`,
                    message: `${updated.name} is now available to hire. Visit the Assistant Catalog to get started.`,
                    type: 'new_role_availability',
                    isRead: false,
                }));

                // Insert in batches of 100 to stay under DB limits
                for (let i = 0; i < notifRows.length; i += 100) {
                    await db.insert(notifications).values(notifRows.slice(i, i + 100));
                }
                notifiedCount = notifRows.length;
            }

            // Also mark waitlist entries for this assistant as notified
            await db
                .update(waitlist)
                .set({ notified: true })
                .where(eq(waitlist.masterAssistantId, id));

            // ── US11: Send personalised Resend email to every waitlist entry ──────
            if (process.env.RESEND_API_KEY) {
                const waitlistEntries = await db
                    .select({ email: waitlist.email })
                    .from(waitlist)
                    .where(eq(waitlist.masterAssistantId, id));

                for (const entry of waitlistEntries) {
                    try {
                        await resend.emails.send({
                            from: FROM_EMAIL,
                            to: entry.email,
                            subject: `${updated.name} is now Live on Be More Swan!`,
                            html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="background:#111827;padding:28px 32px;text-align:center">
      <span style="color:#10b981;font-size:28px;font-weight:800;letter-spacing:-1px">Be More Swan</span>
      <span style="color:#fff;font-size:28px;font-weight:800;letter-spacing:-1px">-Assist</span>
    </div>
    <div style="padding:32px">
      <div style="width:56px;height:56px;background:#d1fae5;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;text-align:center;line-height:56px">🎉</div>
      <h1 style="margin:0 0 12px;font-size:24px;font-weight:800;color:#111827;text-align:center">
        ${updated.name} is now Live!
      </h1>
      <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.7;text-align:center">
        The role you've been waiting for is ready. Hire your ${updated.name} today and put AI to work for your business.
      </p>
      <div style="text-align:center;margin-bottom:32px">
        <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/assistants.html"
           style="display:inline-block;background:#10b981;color:#fff;font-weight:700;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none">
          View ${updated.name} &rarr;
        </a>
      </div>
      <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center">
        You're receiving this because you joined the waitlist for ${updated.name}.<br>
        <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/workspace.html" style="color:#10b981;text-decoration:none">Manage preferences</a>
      </p>
    </div>
  </div>
</body>
</html>`,
                        });
                    } catch (emailErr) {
                        console.warn(`[master-assistants] Waitlist email failed for ${entry.email}:`, emailErr);
                    }
                }
            }
        } catch (fanOutErr) {
            // Non-blocking — update already applied; log and continue
            console.error('[master-assistants] Fan-out error (non-blocking):', fanOutErr);
        }
    }

    // US-GOV-1.1.1: Reclassification to high_risk — notify workspace_admin users (30-day grace period notice)
    const reclassifiedToHighRisk = updates.riskClassification === 'high_risk' &&
        existing.riskClassification !== 'high_risk';
    if (reclassifiedToHighRisk) {
        try {
            const { users: usersTable } = await import('../../db/schema');
            const admins = await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.role as any, 'workspace_admin'));
            // Notify workspace admins in batches; message includes 30-day grace period
            if (admins.length > 0) {
                const reclassNotifs = admins.map(a => ({
                    userId: a.id,
                    type: 'risk_reclassification',
                    title: `High-Risk Reclassification: ${updated.name}`,
                    message: `${updated.name} has been reclassified as High Risk under the EU AI Act. EU-market workspaces have a 30-day grace period before enforcement begins. A conformity assessment must be submitted to continue EU deployment.`,
                    isRead: false,
                }));
                for (let i = 0; i < reclassNotifs.length; i += 100) {
                    await db.insert(notifications).values(reclassNotifs.slice(i, i + 100));
                }
            }
        } catch (reclassErr) {
            console.error('[master-assistants] Reclassification notification error (non-blocking):', reclassErr);
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: updated, notifiedCount }),
    };
}

export const handler: Handler = async (event) => {
    if (event.httpMethod === 'PATCH') return handlePatch(event);
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // Try to decode session (optional — guests still get catalog)
    let callerId: number | null = null;
    const cookieHeader = event.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
    if (cookieMatch && jwtSecret) {
        try {
            const decoded = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number };
            callerId = decoded.userId;
        } catch {
            // invalid session — treat as guest
        }
    }

    try {
        const db = getDb();

        // Fetch all active master assistants
        const rows = await db
            .select()
            .from(masterAssistants)
            .where(eq(masterAssistants.isActive, true))
            .orderBy(masterAssistants.id);

        // Fetch waitlist entries for these assistants
        const waitlistRows = await db
            .select()
            .from(waitlist);

        // Group waitlist counts per masterAssistantId
        const countMap: Record<number, number> = {};
        const userSet: Set<number> = new Set();

        for (const w of waitlistRows) {
            countMap[w.masterAssistantId] = (countMap[w.masterAssistantId] || 0) + 1;
            if (callerId && w.userId === callerId) {
                userSet.add(w.masterAssistantId);
            }
            // Also check by email is handled client-side for guests
        }

        // Apply search / category filters (server-side for clean API)
        const qParam = (event.queryStringParameters?.q || '').trim().toLowerCase();
        const catParam = (event.queryStringParameters?.category || '').trim();

        let filtered = rows;
        if (qParam) {
            filtered = filtered.filter(r =>
                r.name.toLowerCase().includes(qParam) ||
                (r.description || '').toLowerCase().includes(qParam) ||
                r.category.toLowerCase().includes(qParam)
            );
        }
        if (catParam && catParam !== 'All Roles') {
            filtered = filtered.filter(r => r.category === catParam);
        }

        // AC3.1.2: pre-release ('beta' lifecycle) assistants are visible only to orgs that
        // unlocked Beta access via the 50-hours milestone. Everything else is unchanged.
        let betaAccess = false;
        if (callerId) {
            const [orgRow] = await db.select({ beta: organisations.betaAccess })
                .from(userOrganisations)
                .leftJoin(organisations, eq(userOrganisations.organisationId, organisations.id))
                .where(eq(userOrganisations.userId, callerId)).limit(1);
            betaAccess = orgRow?.beta ?? false;
        }
        filtered = filtered.filter(r => r.lifecycleState !== 'beta' || betaAccess);

        const assistants = filtered.map(r => ({
            id: r.id,
            roleKey: r.roleKey,
            name: r.name,
            description: r.description,
            category: r.category,
            iconKey: r.iconKey,
            iconColor: r.iconColor,
            comingSoon: r.comingSoon,
            beta: r.lifecycleState === 'beta', // UI can badge these as Beta Program early access
            waitlistCount: countMap[r.id] || 0,
            onWaitlist: callerId ? userSet.has(r.id) : false,
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistants }),
        };
    } catch (err: any) {
        console.error('master-assistants error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load catalog.' }) };
    }
};
