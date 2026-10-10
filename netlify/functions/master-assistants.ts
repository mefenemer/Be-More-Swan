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
import { getDb } from '../../db/client';
import { masterAssistants, waitlist, organisations, userOrganisations, users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { announceRoleLaunch } from '../../src/utils/role-launch-notify';
import { createNotifications } from '../../src/utils/notify';
import { withLambda } from '@netlify/aws-lambda-compat';


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

    // ⚠️ This used to accept ANY signed-in user: a customer could launch or hide any role and trigger
    // the waitlist email blast. Admins only — the same permission that owns Admin ▸ Assistants.
    const [caller] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, adminId)).limit(1);
    if (!caller || !hasPermission(caller.role, 'assistant_catalog')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };
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

    if (launchingNow) notifiedCount = await announceRoleLaunch(db, { id: updated.id, name: updated.name });

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
                await createNotifications(db, 'risk_reclassification', admins.map(a => a.id), {
                    context: { assistant: { name: updated.name } },
                });
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

export default withLambda(async (event) => {
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

        // Fetch all active master assistants. Enabled (already-hireable) roles are
        // ordered ahead of comingSoon ones so the catalog doesn't interleave them by id.
        const rows = await db
            .select()
            .from(masterAssistants)
            .where(eq(masterAssistants.isActive, true))
            .orderBy(masterAssistants.comingSoon, masterAssistants.id);

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
            // Detail-page copy. This used to come from the hardcoded src/config/assistant-role-content.js,
            // which covered only 7 of the ~20 catalog roles and had drifted from the DB's description.
            // Serving it here makes the card and the detail page read the same row.
            tagline: r.tagline,
            keyFeatures: r.keyFeatures ?? [],
            // "Connects with" — external tools. Distinct from worksWith below, which is the
            // assistant-to-assistant fit ('standalone' and/or other role keys).
            integrations: r.integrations ?? [],
            worksWith: r.worksWith ?? [],
            video: r.video ?? null,
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
});
