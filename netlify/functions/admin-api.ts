// admin-api.ts  (US6, US8, US9, US13)
// Secure admin-only REST API for the Admin Workspace.
// All endpoints require a valid session AND users.role IN ('admin','super_admin').
//
// GET  /admin-api?resource=dashboard                          → KPIs + subscription tier breakdown
// GET  /admin-api?resource=users[&q=&page=]                  → paginated user list
// GET  /admin-api?resource=user&id=N                         → single user detail
// PATCH /admin-api?resource=user&id=N                        → edit user (status, role, name)
// DELETE /admin-api?resource=user&id=N                       → delete user account
// POST  /admin-api?resource=send-login-link&id=N             → email passwordless link to user (US6 Sc2)
// GET  /admin-api?resource=tickets[&status=&category=&page=] → support ticket list
// GET  /admin-api?resource=admins                            → list of admin users (for assignment dropdown)
// GET  /admin-api?resource=catalog                           → master assistants list
// PATCH /admin-api?resource=catalog&id=N                     → toggle comingSoon / isActive
// GET  /admin-api?resource=analytics[&from=ISO&to=ISO]       → sign-up counts + date filter (US9)
// GET  /admin-api?resource=logs[&page=]                      → paginated audit log (US6 Sc3)
// GET  /admin-api?resource=model-config                      → AI model config rows (US13)
// POST  /admin-api?resource=model-config                     → create new model config slot
// PATCH /admin-api?resource=model-config&id=N                → update a model config slot

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { Resend } from 'resend';
import { eq, ilike, desc, and, or, count, gte, lte, sql, inArray } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import {
    users, userProfiles, plans, aiAssistants,
    supportTickets, masterAssistants, waitlist,
    leads, auditLogs, notifications, aiModelConfig,
    gdprErasureLog, adminAuditLog, aiUsageLog, aiModelPricing,
    organisations, billingReconciliationLog, masterPlans, platformConfig, featureFlags,
    billingOverrides, payments, assistantVersions,
    agentAnomalies, agentAnomalyThresholds, taskRuns,
    legalHolds, jwtBlocklist, stripeDisputes, storageUsage, helpArticles,
    rewardAudits, userOrganisations, assistantFeatures,
} from '../../db/schema';
import { ASSISTANT_FEATURES, isAssistantFeatureKey } from '../../src/config/assistant-features';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { resolveEnvironment, runWithEnvironment } from '../../src/utils/env-context';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { isAdminRole, hasPermission, requirePermission } from '../../src/utils/rbac';
import { checkImpersonationBlock } from '../../src/utils/impersonation-guard';
import { SPECIAL_CATEGORY_CLAUSE } from './get-dpa-content';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@bemoreswan.com';

const jwtSecret = process.env.JWT_SECRET;
const PAGE_SIZE = 25;

// ── Auth helper — returns userId or null; enforces admin role ─────────────────
async function requireAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) { console.log('[admin-api] FAIL: JWT_SECRET not set'); return null; }
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) { console.log('[admin-api] FAIL: no aura_session cookie. Cookies present:', event.headers.cookie || '(none)'); return null; }
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch (e) { console.log('[admin-api] FAIL: JWT verify error:', (e as any)?.message); return null; }

    console.log('[admin-api] JWT valid, userId:', userId);

    const db = getDb();
    let row: { role: string } | undefined;
    try {
        const rows = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        row = rows[0];
    } catch (e: any) {
        console.log('[admin-api] FAIL: DB query error:', e.message);
        return null;
    }

    if (!row) { console.log('[admin-api] FAIL: user not found in DB for userId:', userId); return null; }
    console.log('[admin-api] user role:', row.role);
    if (!isAdminRole(row.role)) { console.log('[admin-api] FAIL: role not admin. Got:', row.role); return null; }
    return userId;
}

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(db: any, adminId: number, action: string, resource: string, resourceId: string | number, newState?: any) {
    try {
        await db.insert(auditLogs).values({
            userId: adminId,
            actionType: action,
            resourceType: resource,
            resourceId: String(resourceId),
            newState: newState ?? null,
        });
    } catch { /* non-blocking */ }
}

export const handler: Handler = async (event) => {
    const adminId = await requireAdmin(event);
    if (!adminId) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Access denied. Admin role required.' }) };
    }

    const qs = event.queryStringParameters || {};
    const resource = qs.resource || '';
    const authDb = getDb(); // live — auth/role resolution always reads production

    // Resolve admin role once for permission checks throughout this request
    const [_adminRoleRow] = await authDb.select({ role: users.role }).from(users).where(eq(users.id, adminId)).limit(1);
    const adminRole = _adminRoleRow?.role ?? null;

    // Epic: Superadmin Environment Management — US2/US3.
    // Resolve Live vs Sandbox for this request. Only super_admins may operate in
    // sandbox; a missing/malformed X-Environment header, a non-super-admin, or an
    // unprovisioned sandbox all fall back to live (AC 3.3). Every data query below
    // runs on the env-routed connection (db/client.ts).
    const env = resolveEnvironment(event.headers, { allowSandbox: adminRole === 'super_admin' });

    return runWithEnvironment(env, async () => {
    const db = getDb();

    try {
        // ── GET: dashboard KPIs (US6 Sc4) ────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'dashboard') {
            const [totalUsers]      = await db.select({ c: count() }).from(users);
            const [pendingUsers]    = await db.select({ c: count() }).from(users).where(eq(users.status, 'pending_verification'));
            const [activeAssistants]= await db.select({ c: count() }).from(aiAssistants).where(eq(aiAssistants.isActive, true));
            const [pausedAssistants]= await db.select({ c: count() }).from(aiAssistants).where(eq(aiAssistants.isActive, false));
            const [activePlans]     = await db.select({ c: count() }).from(plans).where(eq(plans.status, 'active'));
            const [openTickets]     = await db.select({ c: count() }).from(supportTickets).where(eq(supportTickets.status, 'open'));

            // Subscription tier breakdown (US6 Sc4)
            const tierBreakdown = await db
                .select({ planName: plans.planName, c: count() })
                .from(plans)
                .where(eq(plans.status, 'active'))
                .groupBy(plans.planName)
                .orderBy(desc(count()));

            // Waitlist totals per coming-soon assistant
            const waitlistCounts = await db
                .select({ masterAssistantId: waitlist.masterAssistantId, c: count() })
                .from(waitlist)
                .groupBy(waitlist.masterAssistantId);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    totalUsers: totalUsers.c,
                    pendingUsers: pendingUsers.c,
                    activeUsers: Number(totalUsers.c) - Number(pendingUsers.c),
                    activeAssistants: activeAssistants.c,
                    pausedAssistants: pausedAssistants.c,
                    activePlans: activePlans.c,
                    openTickets: openTickets.c,
                    tierBreakdown,
                    waitlistCounts,
                }),
            };
        }

        // ── GET: storage stats (AC15+AC16 STOR-1.1.2) ───────────────────────
        if (event.httpMethod === 'GET' && resource === 'storage-stats') {
            // Top-10 orgs by storage consumption
            const topOrgs = await db.execute<{
                organisation_id: number; org_name: string;
                used_bytes: number; storage_limit_bytes: number | null;
            }>(sql`
                SELECT su.organisation_id, o.name AS org_name,
                       su.used_bytes, mp.storage_limit_bytes
                FROM storage_usage su
                JOIN organisations o ON o.id = su.organisation_id
                LEFT JOIN plans p ON p.organisation_id = su.organisation_id AND p.status = 'active'
                LEFT JOIN master_plans mp ON mp.id = p.master_plan_id
                ORDER BY su.used_bytes DESC
                LIMIT 10
            `);
            const totalBytesRows = await db.execute<{ totalBytes: string }>(
                sql`SELECT COALESCE(SUM(used_bytes), 0)::bigint AS "totalBytes" FROM storage_usage`
            );
            const totalBytes = Number(totalBytesRows[0]?.totalBytes ?? 0);

            // AC16: estimated monthly GBP cost at £0.015/GB
            const totalGb = totalBytes / 1_073_741_824;
            const estimatedCostGbp = (totalGb * 0.015).toFixed(2);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topOrgs: [...topOrgs], totalBytes, estimatedCostGbp }),
            };
        }

        // ── GET: user list ────────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'users') {
            const page = Math.max(0, parseInt(qs.page || '0'));
            const q = (qs.q || '').trim();

            const baseCondition = q
                ? or(ilike(users.email, `%${q}%`), ilike(users.firstName, `%${q}%`), ilike(users.lastName, `%${q}%`))
                : undefined;

            const rows = await db
                .select({
                    id: users.id,
                    firstName: users.firstName,
                    lastName: users.lastName,
                    email: users.email,
                    status: users.status,
                    role: users.role,
                    createdAt: users.createdAt,
                    planName: plans.planName,
                    planStatus: plans.status,
                })
                .from(users)
                .leftJoin(plans, and(eq(plans.userId, users.id), eq(plans.status, 'active')))
                .where(baseCondition)
                .orderBy(desc(users.createdAt))
                .limit(PAGE_SIZE)
                .offset(page * PAGE_SIZE);

            const [{ c: total }] = await db.select({ c: count() }).from(users).where(baseCondition);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ users: rows, total, page, pageSize: PAGE_SIZE }),
            };
        }

        // ── GET: assistants by org (for Blueprint Inspector assistant selector) ─
        if (event.httpMethod === 'GET' && resource === 'assistants') {
            const orgId = parseInt(qs.orgId || '');
            if (!orgId) return { statusCode: 400, body: JSON.stringify({ error: 'orgId required.' }) };
            const rows = await db
                .select({ id: aiAssistants.id, name: aiAssistants.name })
                .from(aiAssistants)
                .where(eq(aiAssistants.organisationId, orgId))
                .orderBy(aiAssistants.name);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
        }

        // ── GET: organisations list (for Blueprint Inspector org selector) ───
        if (event.httpMethod === 'GET' && resource === 'organisations') {
            const rows = await db
                .select({ id: organisations.id, name: organisations.name })
                .from(organisations)
                .orderBy(organisations.name);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
        }

        // ── GET: single user detail ───────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'user') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [row] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
            if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

            const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, uid)).limit(1);
            const [plan] = await db.select().from(plans).where(and(eq(plans.userId, uid), eq(plans.status, 'active'))).limit(1);
            const assistantsList = await db.select({ id: aiAssistants.id, name: aiAssistants.name, isActive: aiAssistants.isActive, provisioningStatus: aiAssistants.provisioningStatus }).from(aiAssistants).where(eq(aiAssistants.userId, uid));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: row, profile, plan, assistants: assistantsList }),
            };
        }

        // ── PATCH: update user ────────────────────────────────────────────────
        if (event.httpMethod === 'PATCH' && resource === 'user') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const allowed = ['status', 'role', 'firstName', 'lastName'];
            const updates: Record<string, any> = { updatedAt: new Date() };
            for (const f of allowed) {
                if (body[f] !== undefined) updates[f] = body[f];
            }

            const [updated] = await db.update(users).set(updates).where(eq(users.id, uid)).returning();
            await audit(db, adminId, 'UPDATE', 'users', uid, updates);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: updated }),
            };
        }

        // ── DELETE: remove user (US-GAP-2.1.2: Admin Hard-Delete with Audit Trail) ──
        if (event.httpMethod === 'DELETE' && resource === 'user') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };
            // SC2: Self-delete guard (already implemented — reaffirmed here)
            if (uid === adminId) return { statusCode: 400, body: JSON.stringify({ error: 'Cannot delete your own account via admin API.' }) };

            // Fetch user details before deletion (needed for email + GDPR log)
            const [targetUser] = await db.select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
                .from(users).where(eq(users.id, uid)).limit(1);

            // Hard delete — cascades to all related records via FK onDelete: 'cascade'
            await db.delete(users).where(eq(users.id, uid));

            // SC1a: Audit log with actionType='DELETE_USER' and the admin's userId
            await audit(db, adminId, 'DELETE_USER', 'users', uid);

            // SC3: GDPR Erasure Log — anonymised record (email hash only, no plaintext)
            if (targetUser?.email) {
                const emailHash = crypto.createHash('sha256').update(targetUser.email.toLowerCase()).digest('hex');
                await db.insert(gdprErasureLog).values({
                    emailHash,
                    requesterType: 'admin',
                    requestedBy: adminId,
                }).catch(err => console.warn('[admin-api] GDPR erasure log insert failed (non-blocking):', err));

                // SC1b: Confirmation email to the deleted user
                await sendMagicLinkEmail({
                    to: targetUser.email,
                    subject: 'Your Be More Swan account has been removed',
                    html: `
                        <div style="font-family:sans-serif;padding:24px;max-width:500px">
                            <h2>Account Removed</h2>
                            <p>Hi ${[targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') || 'there'},</p>
                            <p>Your Be More Swan account has been permanently removed by a platform administrator.</p>
                            <p>All your data has been deleted in accordance with our <a href="https://bemoreswan.com/privacy.html">Privacy Policy</a>.</p>
                            <p>If you believe this was a mistake, please contact us at <a href="mailto:hello@bemoreswan.com">hello@bemoreswan.com</a>.</p>
                        </div>
                    `,
                }).catch(err => console.warn('[admin-api] Delete notification email failed (non-blocking):', err));
            }

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true }),
            };
        }

        // ── GET: support tickets ──────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'tickets') {
            const page = Math.max(0, parseInt(qs.page || '0'));
            const statusFilter = qs.status;
            const categoryFilter = qs.category;

            let condition: any;
            if (statusFilter && categoryFilter) {
                condition = and(eq(supportTickets.status, statusFilter), eq(supportTickets.category, categoryFilter));
            } else if (statusFilter) {
                condition = eq(supportTickets.status, statusFilter);
            } else if (categoryFilter) {
                condition = eq(supportTickets.category, categoryFilter);
            }

            const rows = await db
                .select({
                    id: supportTickets.id,
                    subject: supportTickets.subject,
                    category: supportTickets.category,
                    status: supportTickets.status,
                    priority: supportTickets.priority,
                    assignedTo: supportTickets.assignedTo,
                    createdAt: supportTickets.createdAt,
                    updatedAt: supportTickets.updatedAt,
                    slaBreachedAt: supportTickets.slaBreachedAt,
                    userEmail: users.email,
                    userFirstName: users.firstName,
                    userLastName: users.lastName,
                })
                .from(supportTickets)
                .innerJoin(users, eq(users.id, supportTickets.userId))
                .where(condition)
                .orderBy(desc(supportTickets.createdAt))
                .limit(PAGE_SIZE)
                .offset(page * PAGE_SIZE);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tickets: rows }),
            };
        }

        // ── GET: assistant catalog (admin view) ───────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'catalog') {
            const rows = await db.select().from(masterAssistants).orderBy(masterAssistants.id);
            const wlCounts = await db
                .select({ masterAssistantId: waitlist.masterAssistantId, c: count() })
                .from(waitlist)
                .groupBy(waitlist.masterAssistantId);
            const cmap = Object.fromEntries(wlCounts.map(r => [r.masterAssistantId, r.c]));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ catalog: rows.map(r => ({ ...r, waitlistCount: cmap[r.id] ?? 0 })) }),
            };
        }

        // ── PATCH: catalog toggle ─────────────────────────────────────────────
        if (event.httpMethod === 'PATCH' && resource === 'catalog') {
            const id = parseInt(qs.id || '');
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const allowed = ['comingSoon', 'isActive', 'name', 'description', 'category'];
            const updates: Record<string, any> = {};
            for (const f of allowed) { if (body[f] !== undefined) updates[f] = body[f]; }

            const [updated] = await db.update(masterAssistants).set(updates).where(eq(masterAssistants.id, id)).returning();
            await audit(db, adminId, 'UPDATE', 'master_assistants', id, updates);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assistant: updated }),
            };
        }

        // ── Assistant feature capabilities (per assistant TYPE) ───────────────
        // The matrix behind the admin "Assistant Features" page. Feature keys are the SoT in
        // src/config/assistant-features.ts; enabled state is stored per (type, key).
        if (resource === 'assistant-features') {
            const permErr = requirePermission(adminRole, 'feature_flags');
            if (permErr) return permErr;

            if (event.httpMethod === 'GET') {
                const assistants = await db
                    .select({
                        id: masterAssistants.id,
                        name: masterAssistants.name,
                        roleKey: masterAssistants.roleKey,
                        lifecycleState: masterAssistants.lifecycleState,
                    })
                    .from(masterAssistants)
                    .orderBy(masterAssistants.name);

                const rows = await db
                    .select({
                        masterAssistantId: assistantFeatures.masterAssistantId,
                        featureKey: assistantFeatures.featureKey,
                        enabled: assistantFeatures.enabled,
                    })
                    .from(assistantFeatures);

                const byAssistant = new Map<number, Record<string, boolean>>();
                for (const r of rows) {
                    const m = byAssistant.get(r.masterAssistantId) || {};
                    m[r.featureKey] = r.enabled;
                    byAssistant.set(r.masterAssistantId, m);
                }

                // Absent row = disabled — backfill every known feature key so the UI renders a
                // full grid without guessing.
                const result = assistants.map(a => ({
                    ...a,
                    features: Object.fromEntries(
                        ASSISTANT_FEATURES.map(f => [f.key, byAssistant.get(a.id)?.[f.key] ?? false]),
                    ),
                }));

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ features: ASSISTANT_FEATURES, assistants: result }),
                };
            }

            if (event.httpMethod === 'PATCH') {
                const id = parseInt(qs.id || '');
                if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

                const body = JSON.parse(event.body || '{}');
                const { featureKey, enabled } = body;
                if (!isAssistantFeatureKey(featureKey)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown featureKey.' }) };
                }
                if (typeof enabled !== 'boolean') {
                    return { statusCode: 400, body: JSON.stringify({ error: 'enabled (boolean) required.' }) };
                }

                await db.insert(assistantFeatures)
                    .values({ masterAssistantId: id, featureKey, enabled, updatedBy: adminId })
                    .onConflictDoUpdate({
                        target: [assistantFeatures.masterAssistantId, assistantFeatures.featureKey],
                        set: { enabled, updatedBy: adminId, updatedAt: new Date() },
                    });
                await audit(db, adminId, 'UPDATE', 'assistant_features', `${id}:${featureKey}`, { enabled });

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true }),
                };
            }
        }

        // ── POST: send passwordless login link to user (US6 Sc2) ─────────────
        if (event.httpMethod === 'POST' && resource === 'send-login-link') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [targetUser] = await db
                .select({ id: users.id, email: users.email, firstName: users.firstName })
                .from(users).where(eq(users.id, uid)).limit(1);
            if (!targetUser) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
            if (!targetUser.email) return { statusCode: 400, body: JSON.stringify({ error: 'User has no email address.' }) };

            // Generate a single-use token valid for 24 h
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            await db.update(users)
                .set({ verificationToken: token, tokenExpiresAt: expiresAt, updatedAt: new Date() })
                .where(eq(users.id, uid));

            const loginUrl = `${process.env.BASE_URL || 'https://bemoreswan.com'}/verify.html?token=${token}`;

            if (process.env.RESEND_API_KEY) {
                await resend.emails.send({
                    from: FROM_EMAIL,
                    to: targetUser.email,
                    subject: 'Your Be More Swan Login Link',
                    html: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#111827;padding:24px 32px">
    <span style="color:#10b981;font-size:22px;font-weight:800">Be More Swan</span>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 12px;color:#111827">Admin-sent login link</h2>
    <p style="color:#6b7280;font-size:15px;line-height:1.6">Hi ${targetUser.firstName || 'there'},<br><br>
      An Be More Swan admin has sent you a one-click login link. Click below to access your account — this link expires in 24 hours.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${loginUrl}" style="display:inline-block;background:#10b981;color:#fff;font-weight:700;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none">Log in to Be More Swan</a>
    </div>
    <p style="margin:0;color:#9ca3af;font-size:13px">If you did not expect this email, you can safely ignore it.</p>
  </div>
</div>`,
                });
            }

            await audit(db, adminId, 'SEND_LOGIN_LINK', 'users', uid);
            // US-ADM-1.1.1: write structured audit log row
            await insertAdminAuditLog({
                adminId, action: 'password_reset',
                targetType: 'user', targetId: uid,
                newState: { magicLinkSent: true, email: targetUser.email },
                ipAddress: getAdminIp(event.headers),
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, expiresAt }),
            };
        }

        // ── POST: Lock / Unlock account — US-ADM-1.1.1 ───────────────────────
        if (event.httpMethod === 'POST' && resource === 'lock-account') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const { action: lockAction, reason: lockReason } = body; // action: 'lock' | 'unlock'
            if (!['lock', 'unlock'].includes(lockAction)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'action must be "lock" or "unlock".' }) };
            }
            if (!lockReason?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'A reason is required.' }) };
            }

            const [targetUser] = await db
                .select({ id: users.id, email: users.email, firstName: users.firstName, status: users.status })
                .from(users).where(eq(users.id, uid)).limit(1);
            if (!targetUser) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

            const newStatus = lockAction === 'lock' ? 'locked' : 'active';
            const prevStatus = targetUser.status;

            await db.update(users)
                .set({ status: newStatus, updatedAt: new Date() })
                .where(eq(users.id, uid));

            await insertAdminAuditLog({
                adminId,
                action: lockAction === 'lock' ? 'account_lock' : 'account_unlock',
                targetType: 'user', targetId: uid,
                previousState: { status: prevStatus },
                newState: { status: newStatus },
                reason: lockReason,
                ipAddress: getAdminIp(event.headers),
            });

            // Invalidate all active JWTs for the user by adding to blocklist
            if (lockAction === 'lock') {
                await db.insert(jwtBlocklist).values({
                    userId: uid,
                    blockType: 'userId',
                    reason: 'admin_revoke',
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // JWT max lifetime
                }).catch(() => {});
            }

            // Notify the user by email
            if (targetUser.email && resend && lockAction === 'lock') {
                await resend.emails.send({
                    from: FROM_EMAIL,
                    to: targetUser.email,
                    subject: 'Your Be More Swan account has been temporarily locked',
                    html: `<p>Hi ${targetUser.firstName || 'there'},</p>
                           <p>Your account has been temporarily locked. Please contact support at <a href="mailto:support@bemoreswan.com">support@bemoreswan.com</a> for assistance.</p>`,
                }).catch(() => {});
            }

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, status: newStatus }),
            };
        }

        // ── POST: Initiate email address change — US-ADM-1.1.1 ───────────────
        // Requires billing_admin or above. Sends double-opt-in confirmation links.
        if (event.httpMethod === 'POST' && resource === 'email-change') {
            const impersonationErr = checkImpersonationBlock(event);
            if (impersonationErr) return impersonationErr;
            const permErr = requirePermission(adminRole, 'email_change');
            if (permErr) return permErr;

            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const { newEmail, reason: changeReason } = body;
            if (!newEmail?.includes('@')) return { statusCode: 400, body: JSON.stringify({ error: 'Valid newEmail required.' }) };
            if (!changeReason?.trim()) return { statusCode: 400, body: JSON.stringify({ error: 'A reason is required.' }) };

            const [targetUser] = await db
                .select({ id: users.id, email: users.email, firstName: users.firstName })
                .from(users).where(eq(users.id, uid)).limit(1);
            if (!targetUser) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

            // Check new email not already in use
            const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail.toLowerCase())).limit(1);
            if (existing) return { statusCode: 409, body: JSON.stringify({ error: 'New email address is already in use.' }) };

            // Generate a confirmation token (24h TTL), store in verificationToken along with new email encoded
            // Format: "emailchange:{newEmail}:{adminId}"
            const confirmToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const pendingPayload = Buffer.from(JSON.stringify({ newEmail: newEmail.toLowerCase(), adminId, reason: changeReason })).toString('base64');

            await db.update(users)
                .set({
                    verificationToken: `emailchange:${pendingPayload}:${confirmToken}`,
                    tokenExpiresAt: expiresAt,
                    updatedAt: new Date(),
                })
                .where(eq(users.id, uid));

            const SITE_URL = process.env.BASE_URL || 'https://bemoreswan.com';
            const confirmUrl = `${SITE_URL}/.netlify/functions/confirm-email-change?token=${confirmToken}&uid=${uid}`;

            if (resend) {
                // Email to new address (must click to confirm)
                await resend.emails.send({
                    from: FROM_EMAIL,
                    to: newEmail,
                    subject: 'Confirm your new Be More Swan email address',
                    html: `<p>An admin has requested your Be More Swan account (${targetUser.email}) be updated to this address.</p>
                           <p><a href="${confirmUrl}">Click here to confirm this change</a> (expires in 24 hours).</p>
                           <p>If you did not expect this, ignore this email.</p>`,
                }).catch(() => {});

                // Notification to old address
                await resend.emails.send({
                    from: FROM_EMAIL,
                    to: targetUser.email,
                    subject: 'Email address change requested on your Be More Swan account',
                    html: `<p>Hi ${targetUser.firstName || 'there'},</p>
                           <p>An administrator has requested your account email be changed to <strong>${newEmail}</strong>.</p>
                           <p>This change will take effect once confirmed from the new address. If you did not authorise this, contact support immediately.</p>`,
                }).catch(() => {});
            }

            await insertAdminAuditLog({
                adminId, action: 'email_change',
                targetType: 'user', targetId: uid,
                previousState: { email: targetUser.email },
                newState: { pendingEmail: newEmail.toLowerCase(), status: 'pending_confirmation' },
                reason: changeReason,
                ipAddress: getAdminIp(event.headers),
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Confirmation emails sent. Change pending double-opt-in.' }),
            };
        }

        // ── GET: admins list — for ticket assignment dropdown (US7 Sc2) ───────
        if (event.httpMethod === 'GET' && resource === 'admins') {
            const adminUsers = await db
                .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role })
                .from(users)
                .where(or(eq(users.role, 'admin'), eq(users.role, 'super_admin')))
                .orderBy(users.firstName);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admins: adminUsers }),
            };
        }

        // ── GET: paginated audit log (US6 Sc3) ────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'logs') {
            const page = Math.max(0, parseInt(qs.page || '0'));

            const rows = await db
                .select({
                    id: auditLogs.id,
                    actionType: auditLogs.actionType,
                    resourceType: auditLogs.resourceType,
                    resourceId: auditLogs.resourceId,
                    newState: auditLogs.newState,
                    createdAt: auditLogs.createdAt,
                    adminId: auditLogs.userId,
                    adminEmail: users.email,
                    adminFirstName: users.firstName,
                    adminLastName: users.lastName,
                })
                .from(auditLogs)
                .leftJoin(users, eq(users.id, auditLogs.userId))
                .orderBy(desc(auditLogs.createdAt))
                .limit(PAGE_SIZE)
                .offset(page * PAGE_SIZE);

            const [{ c: total }] = await db.select({ c: count() }).from(auditLogs);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ logs: rows, total, page, pageSize: PAGE_SIZE }),
            };
        }

        // ── GET: security-abuse — workspaces flagged for billing review (US3 AC3.3) ──
        // Same Stripe card fingerprint active on ≥2 workspaces ⇒ possible account-splitting.
        // Superadmin-only (this exposes cross-workspace billing linkage).
        if (event.httpMethod === 'GET' && resource === 'security-abuse') {
            if (adminRole !== 'super_admin') {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Superadmin access required.' }) };
            }
            const rows = await db
                .select({
                    id: organisations.id,
                    name: organisations.name,
                    slug: organisations.slug,
                    cardFingerprint: organisations.cardFingerprint,
                    createdAt: organisations.createdAt,
                    ownerEmail: users.email,
                })
                .from(organisations)
                .leftJoin(userOrganisations, and(eq(userOrganisations.organisationId, organisations.id), eq(userOrganisations.role, 'owner')))
                .leftJoin(users, eq(users.id, userOrganisations.userId))
                .where(eq(organisations.billingReviewRequired, true))
                .orderBy(desc(organisations.cardFingerprint), desc(organisations.createdAt));

            // Group by fingerprint so the UI can show each shared-card cluster together.
            const groupsMap = new Map();
            for (const r of rows) {
                const key = r.cardFingerprint || 'unknown';
                if (!groupsMap.has(key)) groupsMap.set(key, []);
                groupsMap.get(key).push(r);
            }
            const groups = Array.from(groupsMap.entries()).map(([fingerprint, workspaces]) => ({ fingerprint, workspaces }));

            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups, total: rows.length }) };
        }

        // ── GET: analytics — sign-up counts per role (US9, with date filter US9 Sc3) ──
        if (event.httpMethod === 'GET' && resource === 'analytics') {
            // Optional date range
            const fromDate = qs.from ? new Date(qs.from) : null;
            const toDate   = qs.to   ? new Date(qs.to)   : null;

            const dateCondition = (col: any) => {
                if (fromDate && toDate) return and(gte(col, fromDate), lte(col, toDate));
                if (fromDate) return gte(col, fromDate);
                if (toDate)   return lte(col, toDate);
                return undefined;
            };

            // Count ai_assistants grouped by role (live sign-ups)
            const byRole = await db
                .select({ role: aiAssistants.aiAssistantJobRole, c: count() })
                .from(aiAssistants)
                .where(dateCondition(aiAssistants.createdAt))
                .groupBy(aiAssistants.aiAssistantJobRole)
                .orderBy(desc(count()));

            // Raw leads (pre-registration interest)
            const leadsByRole = await db
                .select({ role: leads.opportunityReason, c: count() })
                .from(leads)
                .where(dateCondition(leads.createdAt))
                .groupBy(leads.opportunityReason)
                .orderBy(desc(count()));

            // Waitlist entries per master assistant
            const waitlistByRole = await db
                .select({ masterAssistantId: waitlist.masterAssistantId, c: count() })
                .from(waitlist)
                .groupBy(waitlist.masterAssistantId);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ byRole, leadsByRole, waitlistByRole }),
            };
        }

        // ── GET: AI model config (US13) ───────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'model-config') {
            const rows = await db.select().from(aiModelConfig).orderBy(aiModelConfig.slot);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: rows }),
            };
        }

        // ── POST: create new model config slot (US13) ────────────────────────
        if (event.httpMethod === 'POST' && resource === 'model-config') {
            const body = JSON.parse(event.body || '{}');
            const { slot, provider, model, monthlyBudgetCents } = body;
            if (!slot || !model) return { statusCode: 400, body: JSON.stringify({ error: 'slot and model are required.' }) };

            const [created] = await db.insert(aiModelConfig).values({
                slot,
                provider: provider || 'openai',
                model,
                isActive: true,
                monthlyBudgetCents: monthlyBudgetCents ?? null,
                updatedBy: adminId,
            }).returning();

            await audit(db, adminId, 'CREATE', 'ai_model_config', created.id, { slot, model, provider });

            return {
                statusCode: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: created }),
            };
        }

        // ── PATCH: update model config slot (US13) ────────────────────────────
        if (event.httpMethod === 'PATCH' && resource === 'model-config') {
            const id = parseInt(qs.id || '');
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const allowed = ['provider', 'model', 'isActive', 'monthlyBudgetCents'];
            const updates: Record<string, any> = { updatedAt: new Date(), updatedBy: adminId };
            for (const f of allowed) { if (body[f] !== undefined) updates[f] = body[f]; }

            const [updated] = await db.update(aiModelConfig).set(updates).where(eq(aiModelConfig.id, id)).returning();
            await audit(db, adminId, 'UPDATE', 'ai_model_config', id, updates);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: updated }),
            };
        }

        // ── GET / POST / PATCH: Feature Flags — US-ADM-4.2.1 ────────────────────
        if (resource === 'feature-flags') {
            const permErr = requirePermission(adminRole, 'feature_flags');
            if (permErr) return permErr;
            if (event.httpMethod === 'GET') {
                // List all flags with rollout impact for the currently-configured percentage
                const flags = await db
                    .select()
                    .from(featureFlags)
                    .orderBy(featureFlags.key);

                // Count active workspaces for impact preview
                const [{ total }] = await db
                    .select({ total: count() })
                    .from(plans)
                    .where(eq(plans.status, 'active'));

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ flags, totalActiveWorkspaces: total }),
                };
            }

            if (event.httpMethod === 'POST') {
                // Create a new feature flag
                const body = JSON.parse(event.body || '{}');
                const { key: flagKey, description, enabled = false, rolloutPercentage = 0,
                        allowedWorkspaceIds = [], allowedTiers = [] } = body;

                if (!flagKey) return { statusCode: 400, body: JSON.stringify({ error: 'key required.' }) };

                await db.insert(featureFlags).values({
                    key: flagKey,
                    description: description || null,
                    enabled,
                    rolloutPercentage,
                    allowedWorkspaceIds: allowedWorkspaceIds.length ? allowedWorkspaceIds : null,
                    allowedTiers: allowedTiers.length ? allowedTiers : null,
                    updatedBy: adminId,
                });

                await insertAdminAuditLog({
                    adminId, action: 'feature_flag_toggle',
                    targetType: 'feature_flag', targetId: flagKey,
                    previousState: null as any,
                    newState: { enabled, rolloutPercentage, allowedWorkspaceIds, allowedTiers },
                    ipAddress: getAdminIp(event.headers),
                });

                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
            }

            if (event.httpMethod === 'PATCH') {
                // Update an existing flag
                const flagKey = qs.key;
                if (!flagKey) return { statusCode: 400, body: JSON.stringify({ error: 'key query param required.' }) };

                const body = JSON.parse(event.body || '{}');

                // Read previous state for audit log
                const [prev] = await db.select().from(featureFlags).where(eq(featureFlags.key, flagKey)).limit(1);
                if (!prev) return { statusCode: 404, body: JSON.stringify({ error: 'Flag not found.' }) };

                const patch: Partial<typeof prev> = {};
                if (body.enabled           !== undefined) patch.enabled           = body.enabled;
                if (body.rolloutPercentage !== undefined) patch.rolloutPercentage = body.rolloutPercentage;
                if (body.allowedWorkspaceIds !== undefined) patch.allowedWorkspaceIds = body.allowedWorkspaceIds ?? null;
                if (body.allowedTiers      !== undefined) patch.allowedTiers      = body.allowedTiers ?? null;
                if (body.description       !== undefined) patch.description       = body.description;
                patch.updatedBy = adminId;
                patch.updatedAt = new Date();

                await db.update(featureFlags).set(patch).where(eq(featureFlags.key, flagKey));

                await insertAdminAuditLog({
                    adminId, action: 'feature_flag_toggle',
                    targetType: 'feature_flag', targetId: flagKey,
                    previousState: { enabled: prev.enabled, rolloutPercentage: prev.rolloutPercentage,
                                     allowedWorkspaceIds: prev.allowedWorkspaceIds, allowedTiers: prev.allowedTiers },
                    newState: { ...patch },
                    ipAddress: getAdminIp(event.headers),
                });

                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
            }
        }

        // ── GET: rollout impact preview for a proposed percentage ─────────────────
        if (event.httpMethod === 'GET' && resource === 'feature-flag-impact') {
            const { flagKey, rolloutPercentage } = qs;
            if (!flagKey || rolloutPercentage === undefined) {
                return { statusCode: 400, body: JSON.stringify({ error: 'flagKey and rolloutPercentage required.' }) };
            }
            const { estimateRolloutImpact } = await import('../../src/utils/feature-flags');
            const impact = await estimateRolloutImpact(flagKey, parseInt(rolloutPercentage));
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(impact) };
        }

        // ── GET / POST: Platform Kill Switches — US-ADM-3.2.1 ───────────────────
        if (resource === 'platform-config') {
            const permErr = requirePermission(adminRole, 'platform_config');
            if (permErr) return permErr;

            if (event.httpMethod === 'GET') {
                const rows = await db.select().from(platformConfig).orderBy(platformConfig.key);
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: rows }) };
            }

            if (event.httpMethod === 'POST') {
                const body = JSON.parse(event.body || '{}');
                const { key: cfgKey, reason: cfgReason } = body;
                let cfgValue = body.value;
                if (cfgKey === 'maintenance_message' && typeof cfgValue === 'string') {
                    cfgValue = cfgValue.replace(/<[^>]*>/g, '');
                }
                if (!cfgKey || cfgValue === undefined) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'key and value required.' }) };
                }
                if (!cfgReason?.trim()) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'A reason is mandatory for kill switch changes.' }) };
                }

                // Read previous value for audit log
                const [prev] = await db.select({ value: platformConfig.value }).from(platformConfig).where(eq(platformConfig.key, cfgKey)).limit(1);

                await db.insert(platformConfig)
                    .values({ key: cfgKey, value: cfgValue, updatedBy: adminId, reason: cfgReason, updatedAt: new Date() })
                    .onConflictDoUpdate({
                        target: platformConfig.key,
                        set: { value: cfgValue, updatedBy: adminId, reason: cfgReason, updatedAt: new Date() },
                    });

                await insertAdminAuditLog({
                    adminId,
                    action: 'kill_switch_toggle',
                    targetType: 'platform_config',
                    targetId: cfgKey,
                    previousState: { value: prev?.value ?? null },
                    newState: { value: cfgValue },
                    reason: cfgReason,
                    ipAddress: getAdminIp(event.headers),
                });

                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
            }
        }

        // ── Gamification settings (US4.1) + reward audit/reporting (US4.2) ──────
        if (resource === 'gamification-config') {
            const permErr = requirePermission(adminRole, 'platform_config');
            if (permErr) return permErr;

            const KEYS = { mult: 'gamification.time_multipliers', miles: 'gamification.milestones', paused: 'gamification.rewards_paused' };

            if (event.httpMethod === 'GET') {
                const rows = await db.select().from(platformConfig).where(inArray(platformConfig.key, [KEYS.mult, KEYS.miles, KEYS.paused]));
                const map: Record<string, any> = Object.fromEntries(rows.map(r => [r.key, r.value]));
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    timeMultipliers: map[KEYS.mult] ?? { leads_generated: 3, content_drafted: 5, tasks_completed: 2 },
                    milestones:      map[KEYS.miles] ?? { leads_for_token: 100, hours_for_beta: 50 },
                    rewardsPaused:   map[KEYS.paused] === true,
                }) };
            }

            if (event.httpMethod === 'POST') {
                const body = JSON.parse(event.body || '{}');
                const upsert = async (key: string, value: unknown) => {
                    const [prev] = await db.select({ value: platformConfig.value }).from(platformConfig).where(eq(platformConfig.key, key)).limit(1);
                    await db.insert(platformConfig)
                        .values({ key, value, updatedBy: adminId, updatedAt: new Date() })
                        .onConflictDoUpdate({ target: platformConfig.key, set: { value, updatedBy: adminId, updatedAt: new Date() } });
                    await insertAdminAuditLog({ adminId, action: 'gamification_config_update', targetType: 'platform_config', targetId: key,
                        previousState: { value: prev?.value ?? null }, newState: { value }, ipAddress: getAdminIp(event.headers) });
                };
                if (body.timeMultipliers) await upsert(KEYS.mult, body.timeMultipliers);
                if (body.milestones)      await upsert(KEYS.miles, body.milestones);
                if (typeof body.rewardsPaused === 'boolean') await upsert(KEYS.paused, body.rewardsPaused); // AC4.2.3 emergency stop
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
            }
        }

        if (resource === 'reward-audits' && event.httpMethod === 'GET') {
            const permErr = requirePermission(adminRole, 'platform_config');
            if (permErr) return permErr;
            const audits = await db.select().from(rewardAudits).orderBy(desc(rewardAudits.createdAt)).limit(200);
            const [tokenGrants] = await db.select({ c: count() }).from(rewardAudits).where(eq(rewardAudits.rewardType, 'referral_token'));
            const [betaGrants]  = await db.select({ c: count() }).from(rewardAudits).where(eq(rewardAudits.rewardType, 'beta_access'));
            const [paidSubs]    = await db.select({ c: count() }).from(plans).where(eq(plans.status, 'active'));
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                audits,
                summary: { milestoneTokens: Number(tokenGrants.c), betaUnlocks: Number(betaGrants.c), paidSubscriptions: Number(paidSubs.c) },
            }) };
        }

        // ── GET / POST: Billing Reconciliation — US-ADM-2.3.1 ───────────────────
        if (resource === 'reconciliation') {
            if (event.httpMethod === 'GET') {
                // Latest reconciliation run + mismatch list
                const [latestRun] = await db
                    .select()
                    .from(billingReconciliationLog)
                    .orderBy(desc(billingReconciliationLog.runAt))
                    .limit(1);

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ run: latestRun || null }),
                };
            }

            if (event.httpMethod === 'POST') {
                // Sync DB plan to match Stripe tier — action: 'sync_to_stripe'
                const body = JSON.parse(event.body || '{}');
                const { planId, newTierKey, stripeSubscriptionId, reason } = body;

                if (!planId || !newTierKey) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'planId and newTierKey required.' }) };
                }

                // Look up new masterPlanId for the tierKey
                const [masterPlan] = await db
                    .select({ id: masterPlans.id, name: masterPlans.name, monthlyPriceGbp: masterPlans.monthlyPriceGbp })
                    .from(masterPlans)
                    .where(eq(masterPlans.tierKey, newTierKey))
                    .limit(1);

                if (!masterPlan) {
                    return { statusCode: 404, body: JSON.stringify({ error: `Master plan not found for tierKey: ${newTierKey}` }) };
                }

                // Read previous state for audit log
                const [prevPlan] = await db
                    .select({ masterPlanId: plans.masterPlanId, planName: plans.planName })
                    .from(plans)
                    .where(eq(plans.id, planId))
                    .limit(1);

                await db.update(plans)
                    .set({ masterPlanId: masterPlan.id, planName: masterPlan.name, updatedAt: new Date() })
                    .where(eq(plans.id, planId));

                await insertAdminAuditLog({
                    adminId,
                    action: 'tier_change',
                    targetType: 'subscription',
                    targetId: planId,
                    previousState: { masterPlanId: prevPlan?.masterPlanId, planName: prevPlan?.planName },
                    newState: { masterPlanId: masterPlan.id, planName: masterPlan.name, tierKey: newTierKey },
                    reason: reason || 'reconciliation_sync',
                    ipAddress: getAdminIp(event.headers),
                    metadata: { stripeSubscriptionId },
                });

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true }),
                };
            }
        }

        // ── GET: COGS Dashboard — US-ADM-3.1.1 ──────────────────────────────────
        // Returns: platform total cost (current month), top-20 workspaces by cost,
        // per-workspace MRR vs cost for margin calculation, model distribution,
        // and 30-day daily spend.
        if (event.httpMethod === 'GET' && resource === 'cogs-dashboard') {
            const cogsPermErr = requirePermission(adminRole, 'view_cogs');
            if (cogsPermErr) return cogsPermErr;

            const now = new Date();
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

            // (1) Platform total COGS this month
            const [totRow] = await db
                .select({ total: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)` })
                .from(aiUsageLog)
                .where(gte(aiUsageLog.createdAt, monthStart));
            const platformTotalUsd = parseFloat(totRow?.total || '0');

            // (2) Top 20 workspaces by spend this month
            const topWorkspaces = await db
                .select({
                    workspaceId: aiUsageLog.workspaceId,
                    totalCostUsd: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)`,
                    orgName: organisations.name,
                })
                .from(aiUsageLog)
                .leftJoin(organisations, eq(organisations.id, aiUsageLog.workspaceId))
                .where(gte(aiUsageLog.createdAt, monthStart))
                .groupBy(aiUsageLog.workspaceId, organisations.name)
                .orderBy(sql`SUM(cost_usd::numeric) DESC`)
                .limit(20);

            // US-I18N-2.1 SC7: load exchange rates from platform_config (manually set by superadmin)
            const [fxRow] = await db.select({ value: platformConfig.value })
                .from(platformConfig).where(eq(platformConfig.key, 'fx_rates_to_gbp')).limit(1);
            const fxRates: Record<string, number> = (fxRow?.value as any) || { USD: 0.787, EUR: 0.853, AUD: 0.512, CAD: 0.574 };

            // Attach active plan MRR for margin column, normalised to GBP
            const workspaceIds = topWorkspaces.map(w => w.workspaceId).filter(Boolean) as number[];
            let planMrrMap: Record<number, { amount: number; currency: string }> = {};
            if (workspaceIds.length > 0) {
                const planRows = await db
                    .select({ orgId: plans.organisationId, monthlyPriceGbp: masterPlans.monthlyPriceGbp })
                    .from(plans)
                    .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                    .where(and(eq(plans.status, 'active'), sql`plans.organisation_id = ANY(${workspaceIds})`));
                planRows.forEach(p => {
                    if (p.orgId) planMrrMap[p.orgId] = { amount: parseFloat(String(p.monthlyPriceGbp || '0')), currency: 'GBP' };
                });
            }

            const workspacesWithMargin = topWorkspaces.map(w => {
                const costUsd = parseFloat(w.totalCostUsd);
                const plan = w.workspaceId ? planMrrMap[w.workspaceId] : null;
                const mrrRaw = plan?.amount || 0;
                const planCurrency = plan?.currency || 'GBP';
                // Normalise MRR to GBP for platform-level reporting
                const mrrGbp = planCurrency === 'GBP' ? mrrRaw : mrrRaw * (fxRates[planCurrency] || 1);
                const mrrUsd = mrrGbp / (fxRates.USD || 0.787); // convert GBP→USD for margin vs costUsd
                const marginPct = mrrUsd > 0 ? Math.round(((mrrUsd - costUsd) / mrrUsd) * 100) : null;
                const highlight = mrrUsd > 0 && costUsd >= mrrUsd ? 'red'
                    : mrrUsd > 0 && costUsd >= mrrUsd * 0.8 ? 'amber' : null;
                return { ...w, costUsd, mrrGbp, mrrRaw, planCurrency, marginPct, highlight };
            });

            // (3) Model distribution (all time, last 30 days)
            const modelDist = await db
                .select({
                    model: aiUsageLog.model,
                    callCount: count(),
                    totalCostUsd: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)`,
                })
                .from(aiUsageLog)
                .where(gte(aiUsageLog.createdAt, thirtyDaysAgo))
                .groupBy(aiUsageLog.model)
                .orderBy(sql`SUM(cost_usd::numeric) DESC`);

            // (4) 30-day daily spend sparkline
            const dailySpend = await db
                .select({
                    day: sql<string>`DATE(created_at)`,
                    totalCostUsd: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)`,
                })
                .from(aiUsageLog)
                .where(gte(aiUsageLog.createdAt, thirtyDaysAgo))
                .groupBy(sql`DATE(created_at)`)
                .orderBy(sql`DATE(created_at)`);

            // (5) US-GDPR-4.2.2: Data category breakdown — unnest the array, count per category
            const dataCategoryRows = await db.execute(sql`
                SELECT
                    category,
                    COUNT(*) AS call_count
                FROM ai_usage_log, unnest(data_categories) AS category
                WHERE created_at >= ${thirtyDaysAgo}
                GROUP BY category
                ORDER BY call_count DESC
            `);

            const totalCallsLast30d = await db
                .select({ total: count() })
                .from(aiUsageLog)
                .where(gte(aiUsageLog.createdAt, thirtyDaysAgo));
            const totalCalls = Number(totalCallsLast30d[0]?.total ?? 0);

            // Count of special_category_suspected calls — should be near zero
            const specialCatRows = await db.execute(sql`
                SELECT COUNT(*) AS cnt
                FROM ai_usage_log
                WHERE created_at >= ${thirtyDaysAgo}
                  AND 'special_category_suspected' = ANY(data_categories)
            `);
            const specialCatCount = Number((specialCatRows[0] as any)?.cnt ?? 0);

            // 30-day daily trend for special_category_suspected
            const specialCatTrend = await db.execute(sql`
                SELECT DATE(created_at) AS day, COUNT(*) AS cnt
                FROM ai_usage_log
                WHERE created_at >= ${thirtyDaysAgo}
                  AND 'special_category_suspected' = ANY(data_categories)
                GROUP BY DATE(created_at)
                ORDER BY day
            `);

            // Alert if special_category_suspected > 1% of calls in the last 30 days
            const specialCatAlertThreshold = Math.max(1, Math.floor(totalCalls * 0.01));
            const specialCatAlert = specialCatCount > specialCatAlertThreshold
                ? { triggered: true, count: specialCatCount, threshold: specialCatAlertThreshold }
                : { triggered: false };

            const dataCategoryBreakdown = {
                totalCalls,
                byCategory: ([...dataCategoryRows] as any[]).map(r => ({
                    category: r.category,
                    callCount: Number(r.call_count),
                    pct: totalCalls > 0 ? +((Number(r.call_count) / totalCalls) * 100).toFixed(1) : 0,
                })),
                specialCategoryCount: specialCatCount,
                specialCategoryTrend: ([...specialCatTrend] as any[]).map(r => ({ day: r.day, count: Number(r.cnt) })),
                alert: specialCatAlert,
            };

            const platformTotalGbp = +(platformTotalUsd * (fxRates.USD ?? 0.787)).toFixed(2);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    platformTotalGbp,
                    topWorkspaces: workspacesWithMargin,
                    modelDist,
                    dailySpend,
                    dataCategoryBreakdown,
                    monthStart: monthStart.toISOString(),
                    fxRates,
                }),
            };
        }

        // ── GET: cogs-workspace-detail — US-ADM-3.1.1 ───────────────────────────
        // Drill-down for a single workspace: per-assistant cost, per-task-type cost,
        // hourly usage heatmap (last 7 days).
        if (event.httpMethod === 'GET' && resource === 'cogs-workspace-detail') {
            const permErr = requirePermission(adminRole, 'platform_config');
            if (permErr) return permErr;

            const orgId = qs.orgId ? parseInt(qs.orgId, 10) : null;
            if (!orgId) return { statusCode: 400, body: JSON.stringify({ error: 'orgId is required.' }) };

            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            const [assistantCosts, taskTypeCosts, hourlyHeatmap] = await Promise.all([
                // Per-assistant cost breakdown
                db.select({
                    assistantId: aiUsageLog.assistantId,
                    totalCostUsd: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)`,
                    callCount: sql<string>`COUNT(*)`,
                })
                    .from(aiUsageLog)
                    .where(eq(aiUsageLog.workspaceId, orgId))
                    .groupBy(aiUsageLog.assistantId)
                    .orderBy(sql`SUM(cost_usd::numeric) DESC`)
                    .limit(20),

                // Per-task-type cost breakdown (via taskRuns join)
                db.select({
                    taskType: taskRuns.taskType,
                    totalCostUsd: sql<string>`COALESCE(SUM(${aiUsageLog.costUsd}::numeric), 0)`,
                    callCount: sql<string>`COUNT(${aiUsageLog.id})`,
                })
                    .from(aiUsageLog)
                    .innerJoin(taskRuns, eq(aiUsageLog.taskRunId, taskRuns.id))
                    .where(eq(aiUsageLog.workspaceId, orgId))
                    .groupBy(taskRuns.taskType)
                    .orderBy(sql`SUM(${aiUsageLog.costUsd}::numeric) DESC`)
                    .limit(20),

                // Hourly usage heatmap — last 7 days
                db.select({
                    hour: sql<string>`DATE_TRUNC('hour', ${aiUsageLog.createdAt})`,
                    totalCostUsd: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)`,
                    callCount: sql<string>`COUNT(*)`,
                })
                    .from(aiUsageLog)
                    .where(and(eq(aiUsageLog.workspaceId, orgId), gte(aiUsageLog.createdAt, sevenDaysAgo)))
                    .groupBy(sql`DATE_TRUNC('hour', ${aiUsageLog.createdAt})`)
                    .orderBy(sql`DATE_TRUNC('hour', ${aiUsageLog.createdAt})`),
            ]);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orgId, assistantCosts, taskTypeCosts, hourlyHeatmap }),
            };
        }

        // ── GET: admin action audit log — US-ADM-5.1.1 ──────────────────────────
        // Paginated, filterable viewer of admin_audit_log rows.
        // Superadmin-only (other roles see 403).
        if (event.httpMethod === 'GET' && resource === 'admin-audit-log') {
            const permErr = requirePermission(adminRole, 'view_audit_log');
            if (permErr) return permErr;

            const page         = Math.max(0, parseInt(qs.page || '0'));
            const filterAdmin  = qs.adminId ? parseInt(qs.adminId) : null;
            const filterAction = qs.action || null;
            const filterTarget = qs.targetType || null;
            const fromDate     = qs.from ? new Date(qs.from) : null;
            const toDate       = qs.to   ? new Date(qs.to)   : null;
            const filterReason = qs.reason ? qs.reason.trim() : null;

            const conditions: any[] = [];
            if (filterAdmin)  conditions.push(eq(adminAuditLog.adminId, filterAdmin));
            if (filterAction) conditions.push(eq(adminAuditLog.action, filterAction));
            if (filterTarget) conditions.push(eq(adminAuditLog.targetType, filterTarget));
            if (fromDate)     conditions.push(gte(adminAuditLog.createdAt, fromDate));
            if (toDate)       conditions.push(lte(adminAuditLog.createdAt, toDate));
            if (filterReason) conditions.push(ilike(adminAuditLog.reason, `%${filterReason}%`));

            const where = conditions.length ? and(...conditions) : undefined;

            const rows = await db
                .select({
                    id:            adminAuditLog.id,
                    action:        adminAuditLog.action,
                    targetType:    adminAuditLog.targetType,
                    targetId:      adminAuditLog.targetId,
                    previousState: adminAuditLog.previousState,
                    newState:      adminAuditLog.newState,
                    reason:        adminAuditLog.reason,
                    metadata:      adminAuditLog.metadata,
                    ipAddress:     adminAuditLog.ipAddress,
                    createdAt:     adminAuditLog.createdAt,
                    adminId:       adminAuditLog.adminId,
                    adminEmail:    users.email,
                    adminFirstName: users.firstName,
                    adminLastName:  users.lastName,
                })
                .from(adminAuditLog)
                .leftJoin(users, eq(users.id, adminAuditLog.adminId))
                .where(where)
                .orderBy(desc(adminAuditLog.createdAt))
                .limit(50)
                .offset(page * 50);

            const [{ c: total }] = await db.select({ c: count() }).from(adminAuditLog).where(where);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ logs: rows, total, page, pageSize: 50 }),
            };
        }

        // ── US-ADM-5.2.1: List admins ─────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'admins-list') {
            const permErr = requirePermission(adminRole, 'manage_admin_roles');
            if (permErr) return permErr;

            const adminList = await db
                .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role, createdAt: users.createdAt, status: users.status })
                .from(users)
                .where(inArray(users.role, ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent']))
                .orderBy(users.createdAt);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admins: adminList }),
            };
        }

        // ── US-ADM-5.2.1: Request admin role change (initiator) ────────────────
        // POST ?resource=request-role-change  { targetUserId, newRole, reason }
        // For super_admin promotion: stored as a pending request requiring 4-eyes approval.
        // For lesser promotions: applied immediately (still requires super_admin caller).
        if (event.httpMethod === 'POST' && resource === 'request-role-change') {
            const permErr = requirePermission(adminRole, 'manage_admin_roles');
            if (permErr) return permErr;

            const body = JSON.parse(event.body || '{}');
            const { targetUserId, newRole, reason: roleReason } = body;
            if (!targetUserId || !newRole || !roleReason?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId, newRole, and reason are required.' }) };
            }

            const VALID_ADMIN_ROLES = ['support_agent', 'billing_admin', 'platform_admin', 'super_admin', 'user'];
            if (!VALID_ADMIN_ROLES.includes(newRole)) {
                return { statusCode: 400, body: JSON.stringify({ error: `newRole must be one of: ${VALID_ADMIN_ROLES.join(', ')}` }) };
            }

            const [targetUser] = await db
                .select({ id: users.id, email: users.email, role: users.role })
                .from(users).where(eq(users.id, targetUserId)).limit(1);
            if (!targetUser) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

            // 4-eyes: super_admin promotion requires a second super_admin to approve
            if (newRole === 'super_admin') {
                const requestId = crypto.randomUUID();
                const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                // Store as platform config entry (keyed by request ID)
                await db.insert(platformConfig)
                    .values({
                        key:   `pending_role_change:${requestId}`,
                        value: JSON.stringify({
                            requestId,
                            targetUserId,
                            targetEmail: targetUser.email,
                            newRole,
                            previousRole: targetUser.role,
                            reason: roleReason,
                            initiatorId: adminId,
                            expiresAt,
                        }),
                    })
                    .onConflictDoUpdate({ target: platformConfig.key, set: { value: platformConfig.value, updatedAt: new Date() } });

                // Notify all other super_admins to approve
                const otherSuperAdmins = await db.select({ id: users.id }).from(users)
                    .where(and(eq(users.role, 'super_admin'), sql`${users.id} != ${adminId}`));
                for (const sa of otherSuperAdmins) {
                    await db.insert(notifications).values({
                        userId: sa.id,
                        type: 'system',
                        title: '🔐 Super Admin Promotion Requires Your Approval',
                        message: `A request to promote ${targetUser.email} to super_admin has been initiated. Your approval is required within 24 hours. Request ID: ${requestId}`,
                        metadata: { requestId, targetEmail: targetUser.email, initiatorId: adminId, expiresAt },
                    }).catch(() => {});
                }

                await insertAdminAuditLog({
                    adminId, action: 'admin_role_change',
                    targetType: 'user', targetId: targetUserId,
                    previousState: { role: targetUser.role },
                    newState: { pendingRole: newRole, requestId, status: 'pending_approval' },
                    reason: roleReason,
                    ipAddress: getAdminIp(event.headers),
                });

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, pending: true, requestId, message: 'Promotion to super_admin requires approval from a second super_admin within 24 hours.' }),
                };
            }

            // Non-super_admin role changes: apply immediately
            await db.update(users).set({ role: newRole, updatedAt: new Date() }).where(eq(users.id, targetUserId));

            await insertAdminAuditLog({
                adminId, action: 'admin_role_change',
                targetType: 'user', targetId: targetUserId,
                previousState: { role: targetUser.role },
                newState: { role: newRole },
                reason: roleReason,
                ipAddress: getAdminIp(event.headers),
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, pending: false, newRole }),
            };
        }

        // ── US-ADM-5.2.1: Approve super_admin promotion (4-eyes) ──────────────
        // POST ?resource=approve-role-change  { requestId }
        if (event.httpMethod === 'POST' && resource === 'approve-role-change') {
            // Only super_admin can approve
            if (!hasPermission(adminRole, 'manage_admin_roles')) {
                return { statusCode: 403, body: JSON.stringify({ error: 'Only super_admins can approve role promotions.' }) };
            }

            const body = JSON.parse(event.body || '{}');
            const { requestId } = body;
            if (!requestId) return { statusCode: 400, body: JSON.stringify({ error: 'requestId required.' }) };

            const [configRow] = await db
                .select({ value: platformConfig.value })
                .from(platformConfig)
                .where(eq(platformConfig.key, `pending_role_change:${requestId}`))
                .limit(1);

            if (!configRow) return { statusCode: 404, body: JSON.stringify({ error: 'Pending role change request not found.' }) };

            let pendingReq: any;
            try { pendingReq = JSON.parse(configRow.value as string); } catch {
                return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse pending request.' }) };
            }

            // Check expiry
            if (new Date(pendingReq.expiresAt) < new Date()) {
                await db.delete(platformConfig).where(eq(platformConfig.key, `pending_role_change:${requestId}`));
                return { statusCode: 410, body: JSON.stringify({ error: 'This approval request has expired (24-hour window).' }) };
            }

            // Prevent the initiator from approving their own request
            if (pendingReq.initiatorId === adminId) {
                return { statusCode: 403, body: JSON.stringify({ error: 'The initiator cannot approve their own super_admin promotion request.' }) };
            }

            // Apply the role change
            await db.update(users)
                .set({ role: pendingReq.newRole, updatedAt: new Date() })
                .where(eq(users.id, pendingReq.targetUserId));

            // Remove the pending config entry
            await db.delete(platformConfig).where(eq(platformConfig.key, `pending_role_change:${requestId}`));

            await insertAdminAuditLog({
                adminId, action: 'admin_role_change',
                targetType: 'user', targetId: pendingReq.targetUserId,
                previousState: { role: pendingReq.previousRole },
                newState: { role: pendingReq.newRole, approvedBy: adminId, initiatedBy: pendingReq.initiatorId },
                reason: `4-eyes approval of request ${requestId}: ${pendingReq.reason}`,
                ipAddress: getAdminIp(event.headers),
                metadata: { requestId, initiatorId: pendingReq.initiatorId, approverId: adminId },
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, targetEmail: pendingReq.targetEmail, newRole: pendingReq.newRole }),
            };
        }

        // ── GET: Dunning Queue — workspaces with plan.status='past_due' ─────────
        // US-ADM-2.2.1
        if (event.httpMethod === 'GET' && resource === 'dunning-queue') {
            const rows = await db
                .select({
                    planId:              plans.id,
                    userId:              plans.userId,
                    organisationId:      plans.organisationId,
                    planName:            plans.planName,
                    status:              plans.status,
                    gracePeriodEndsAt:   plans.gracePeriodEndsAt,
                    stripeCustomerId:    plans.stripeCustomerId,
                    stripeSubscriptionId: plans.stripeSubscriptionId,
                    updatedAt:           plans.updatedAt,
                    userEmail:           users.email,
                    userFirstName:       users.firstName,
                    orgName:             organisations.name,
                })
                .from(plans)
                .leftJoin(users, eq(plans.userId, users.id))
                .leftJoin(organisations, eq(plans.organisationId, organisations.id))
                .where(eq(plans.status, 'past_due'))
                .orderBy(plans.updatedAt); // oldest first = most overdue

            // Calculate days overdue from updatedAt (when status was last changed to past_due)
            const now = Date.now();
            const enriched = rows.map(r => ({
                ...r,
                daysOverdue: r.updatedAt
                    ? Math.floor((now - new Date(r.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
                    : 0,
            }));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ queue: enriched }),
            };
        }

        // ── POST: dunning-override — mark payment arranged offline ───────────
        // US-ADM-2.2.1
        if (event.httpMethod === 'POST' && resource === 'dunning-override') {
            const body = JSON.parse(event.body || '{}');
            const { planId, reason: dunningReason } = body;
            if (!planId || !dunningReason?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'planId and reason required.' }) };
            }

            const [plan] = await db.select({ id: plans.id, userId: plans.userId, status: plans.status })
                .from(plans).where(eq(plans.id, planId)).limit(1);
            if (!plan) return { statusCode: 404, body: JSON.stringify({ error: 'Plan not found.' }) };
            if (plan.status !== 'past_due') {
                return { statusCode: 400, body: JSON.stringify({ error: 'Plan is not in past_due status.' }) };
            }

            // Set grace period: suppress dunning for 14 days
            const graceEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
            await db.update(plans)
                .set({ gracePeriodEndsAt: graceEnd, updatedAt: new Date() })
                .where(eq(plans.id, planId));

            await db.insert(billingOverrides).values({
                workspaceId: null,
                adminId,
                action: 'dunning_override',
                reason: dunningReason,
                metadata: { planId, graceEnd: graceEnd.toISOString() },
            });

            await insertAdminAuditLog({
                adminId,
                action: 'dunning_override',
                targetType: 'user',
                targetId: plan.userId!,
                previousState: { status: 'past_due' },
                newState: { gracePeriodEndsAt: graceEnd.toISOString(), dunningSupressed: true },
                reason: dunningReason,
                ipAddress: getAdminIp(event.headers),
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, graceEnd: graceEnd.toISOString() }),
            };
        }

        // ── GET: Disputes tab — US-ADM-2.2.1 ─────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'disputes') {
            const permErr = requirePermission(adminRole, 'view_billing_history');
            if (permErr) return permErr;

            const rows = await db
                .select({
                    id: stripeDisputes.id,
                    stripeDisputeId: stripeDisputes.stripeDisputeId,
                    stripeChargeId: stripeDisputes.stripeChargeId,
                    userId: stripeDisputes.userId,
                    organisationId: stripeDisputes.organisationId,
                    amount: stripeDisputes.amount,
                    currency: stripeDisputes.currency,
                    reason: stripeDisputes.reason,
                    status: stripeDisputes.status,
                    evidenceDeadline: stripeDisputes.evidenceDeadline,
                    createdAt: stripeDisputes.createdAt,
                    userEmail: users.email,
                    orgName: organisations.name,
                })
                .from(stripeDisputes)
                .leftJoin(users, eq(users.id, stripeDisputes.userId))
                .leftJoin(organisations, eq(organisations.id, stripeDisputes.organisationId))
                .orderBy(desc(stripeDisputes.createdAt))
                .limit(100);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ disputes: rows }),
            };
        }

        // ── US-SALES-1.1 Part 5: Sales Pipeline ──────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'sales-pipeline') {
            const denied = requirePermission(adminRole, 'view_billing_history');
            if (denied) return denied;

            const leadType = event.queryStringParameters?.leadType || '';
            const priority = event.queryStringParameters?.priority || '';
            const status   = event.queryStringParameters?.status || '';
            const search   = event.queryStringParameters?.search || '';

            const conditions: any[] = [];
            if (leadType) conditions.push(eq(leads.leadType, leadType));
            if (priority) conditions.push(eq(leads.priority, priority));
            if (status)   conditions.push(eq(leads.status, status));
            if (search)   conditions.push(
                or(ilike(leads.email, `%${search}%`), ilike(leads.name, `%${search}%`))
            );

            const rows = await db.select({
                id: leads.id,
                email: leads.email,
                name: leads.name,
                leadType: leads.leadType,
                source: leads.source,
                opportunityReason: leads.opportunityReason,
                priority: leads.priority,
                status: leads.status,
                salesNotes: leads.salesNotes,
                company: leads.company,
                useCase: leads.useCase,
                createdAt: leads.createdAt,
                lastContactedAt: leads.lastContactedAt,
            })
            .from(leads)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(leads.createdAt))
            .limit(200);

            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leads: rows }) };
        }

        if (event.httpMethod === 'POST' && resource === 'lead-status') {
            const denied = requirePermission(adminRole, 'view_billing_history');
            if (denied) return denied;
            const body = JSON.parse(event.body || '{}');
            const { leadId, status: newStatus } = body;
            if (!leadId || !newStatus) return { statusCode: 400, body: JSON.stringify({ error: 'leadId and status required.' }) };
            const updates: Record<string, any> = { status: newStatus, updatedAt: new Date() };
            if (newStatus === 'converted') updates.resolvedAt = new Date();
            if (newStatus === 'contacted') updates.lastContactedAt = new Date();
            await db.update(leads).set(updates).where(eq(leads.id, leadId));
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
        }

        if (event.httpMethod === 'POST' && resource === 'lead-notes') {
            const denied = requirePermission(adminRole, 'view_billing_history');
            if (denied) return denied;
            const body = JSON.parse(event.body || '{}');
            const { leadId, salesNotes } = body;
            if (!leadId) return { statusCode: 400, body: JSON.stringify({ error: 'leadId required.' }) };
            await db.update(leads).set({ salesNotes: salesNotes ?? null, updatedAt: new Date() }).where(eq(leads.id, leadId));
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
        }

        // ── US-ADM-4.1.1: Assistant lifecycle state transition ────────────────
        // POST ?resource=assistant-lifecycle&id=N  { newState, changeNote }
        if (event.httpMethod === 'POST' && resource === 'assistant-lifecycle') {
            const uid2 = parseInt(qs.id || '');
            if (!uid2) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const { newState, changeNote } = body;

            const VALID_TRANSITIONS: Record<string, string[]> = {
                draft:       ['review'],
                review:      ['beta', 'draft'],
                beta:        ['live', 'review'],
                live:        ['deprecated'],
                deprecated:  ['archived', 'live'],
                archived:    [],
            };

            const [assistant] = await db
                .select({ id: masterAssistants.id, name: masterAssistants.name, lifecycleState: masterAssistants.lifecycleState })
                .from(masterAssistants).where(eq(masterAssistants.id, uid2)).limit(1);
            if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

            const allowed = VALID_TRANSITIONS[assistant.lifecycleState] ?? [];
            if (!allowed.includes(newState)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: `Invalid transition: ${assistant.lifecycleState} → ${newState}. Valid next states: [${allowed.join(', ') || 'none'}]`,
                    }),
                };
            }
            if (!changeNote?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'A changelog note is required for all lifecycle transitions.' }) };
            }

            await db.update(masterAssistants)
                .set({ lifecycleState: newState, updatedAt: new Date() })
                .where(eq(masterAssistants.id, uid2));

            await insertAdminAuditLog({
                adminId, action: 'assistant_state_change',
                targetType: 'assistant', targetId: uid2,
                previousState: { lifecycleState: assistant.lifecycleState },
                newState: { lifecycleState: newState },
                reason: changeNote,
                ipAddress: getAdminIp(event.headers),
                metadata: { assistantName: assistant.name },
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, previousState: assistant.lifecycleState, newState }),
            };
        }

        // ── US-ADM-4.1.1: Bulk publish (beta → live) ─────────────────────────
        // POST ?resource=assistant-bulk-publish  { assistants: [{id, changeNote}] }
        if (event.httpMethod === 'POST' && resource === 'assistant-bulk-publish') {
            const body = JSON.parse(event.body || '{}');
            const items: { id: number; changeNote: string }[] = body.assistants || [];

            if (!items.length) {
                return { statusCode: 400, body: JSON.stringify({ error: 'assistants array required.' }) };
            }
            for (const item of items) {
                if (!item.changeNote?.trim()) {
                    return { statusCode: 400, body: JSON.stringify({ error: `changeNote required for each assistant. Missing on id=${item.id}` }) };
                }
            }

            const ids = items.map(i => i.id);
            // Verify all are in 'beta' state
            const rows = await db.select({ id: masterAssistants.id, lifecycleState: masterAssistants.lifecycleState, name: masterAssistants.name })
                .from(masterAssistants).where(and(eq(masterAssistants.lifecycleState, 'beta'), inArray(masterAssistants.id, ids)));

            if (rows.length !== ids.length) {
                const foundIds = rows.map(r => r.id);
                const notBeta  = ids.filter(i => !foundIds.includes(i));
                return { statusCode: 400, body: JSON.stringify({ error: `These assistants are not in beta state: [${notBeta.join(', ')}]` }) };
            }

            // Transition all to live in one update
            await db.update(masterAssistants)
                .set({ lifecycleState: 'live', updatedAt: new Date() })
                .where(inArray(masterAssistants.id, ids));

            // Write audit log per assistant
            for (const item of items) {
                const assistant = rows.find(r => r.id === item.id)!;
                await insertAdminAuditLog({
                    adminId, action: 'assistant_state_change',
                    targetType: 'assistant', targetId: item.id,
                    previousState: { lifecycleState: 'beta' },
                    newState: { lifecycleState: 'live' },
                    reason: item.changeNote,
                    ipAddress: getAdminIp(event.headers),
                    metadata: { bulkPublish: true, assistantName: assistant.name },
                });
            }

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, published: ids.length }),
            };
        }

        // ── US-ADM-4.1.1: List assistant versions ────────────────────────────
        // GET ?resource=assistant-versions&id=N
        if (event.httpMethod === 'GET' && resource === 'assistant-versions') {
            const uid2 = parseInt(qs.id || '');
            if (!uid2) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const versions = await db
                .select({
                    id: assistantVersions.id,
                    versionNumber: assistantVersions.versionNumber,
                    systemPrompt: assistantVersions.systemPrompt,
                    config: assistantVersions.config,
                    changeNote: assistantVersions.changeNote,
                    createdAt: assistantVersions.createdAt,
                    createdByEmail: users.email,
                })
                .from(assistantVersions)
                .leftJoin(users, eq(assistantVersions.createdBy, users.id))
                .where(eq(assistantVersions.assistantId, uid2))
                .orderBy(desc(assistantVersions.versionNumber));

            const [assistant] = await db
                .select({ currentVersionId: masterAssistants.currentVersionId, lifecycleState: masterAssistants.lifecycleState })
                .from(masterAssistants).where(eq(masterAssistants.id, uid2)).limit(1);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ versions, currentVersionId: assistant?.currentVersionId }),
            };
        }

        // ── US-ADM-4.1.1: Save new assistant version (edit prompt/config) ────
        // POST ?resource=assistant-versions&id=N  { systemPrompt, config, changeNote }
        if (event.httpMethod === 'POST' && resource === 'assistant-versions') {
            const uid2 = parseInt(qs.id || '');
            if (!uid2) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const { systemPrompt, config: vConfig, changeNote } = body;
            if (!changeNote?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'changeNote required.' }) };
            }

            // Get next version number
            const [latest] = await db
                .select({ max: sql<number>`max(${assistantVersions.versionNumber})` })
                .from(assistantVersions)
                .where(eq(assistantVersions.assistantId, uid2));
            const nextVersion = (latest?.max ?? 0) + 1;

            // US-GDPR-1.2.1 SC3: Auto-append special-category refusal clause to every
            // master assistant system prompt so it is always present regardless of what
            // the admin writes above it.
            const clauseMarker = '<!-- special-category-clause -->';
            let finalPrompt: string | null = systemPrompt ?? null;
            if (finalPrompt && !finalPrompt.includes(clauseMarker)) {
                finalPrompt = `${finalPrompt}\n\n${clauseMarker}\n${SPECIAL_CATEGORY_CLAUSE}`;
            } else if (!finalPrompt) {
                finalPrompt = `${clauseMarker}\n${SPECIAL_CATEGORY_CLAUSE}`;
            }

            const [newVersion] = await db.insert(assistantVersions).values({
                assistantId: uid2,
                versionNumber: nextVersion,
                systemPrompt: finalPrompt,
                config: vConfig ?? null,
                createdBy: adminId,
                changeNote,
            }).returning({ id: assistantVersions.id });

            await db.update(masterAssistants)
                .set({ currentVersionId: newVersion.id, specialCategoryClauseEnabled: true, updatedAt: new Date() })
                .where(eq(masterAssistants.id, uid2));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, versionId: newVersion.id, versionNumber: nextVersion }),
            };
        }

        // ── US-ADM-4.1.1: Rollback to a previous version ─────────────────────
        // POST ?resource=assistant-rollback&id=N  { versionId, reason }
        if (event.httpMethod === 'POST' && resource === 'assistant-rollback') {
            const uid2 = parseInt(qs.id || '');
            if (!uid2) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const { versionId, reason: rollbackReason } = body;
            if (!versionId || !rollbackReason?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'versionId and reason required.' }) };
            }

            // Load the target version
            const [targetVersion] = await db
                .select()
                .from(assistantVersions)
                .where(and(eq(assistantVersions.id, versionId), eq(assistantVersions.assistantId, uid2)))
                .limit(1);
            if (!targetVersion) return { statusCode: 404, body: JSON.stringify({ error: 'Version not found for this assistant.' }) };

            // Get next version number
            const [latest] = await db
                .select({ max: sql<number>`max(${assistantVersions.versionNumber})` })
                .from(assistantVersions)
                .where(eq(assistantVersions.assistantId, uid2));
            const nextVersion = (latest?.max ?? 0) + 1;

            // Insert new version row (copy of old) — rollbacks create a new row, never modify history
            const [rollbackVersion] = await db.insert(assistantVersions).values({
                assistantId: uid2,
                versionNumber: nextVersion,
                systemPrompt: targetVersion.systemPrompt,
                config: targetVersion.config,
                createdBy: adminId,
                changeNote: `Rollback to v${targetVersion.versionNumber}: ${rollbackReason}`,
            }).returning({ id: assistantVersions.id });

            await db.update(masterAssistants)
                .set({ currentVersionId: rollbackVersion.id, updatedAt: new Date() })
                .where(eq(masterAssistants.id, uid2));

            await insertAdminAuditLog({
                adminId, action: 'assistant_state_change',
                targetType: 'assistant', targetId: uid2,
                previousState: { versionId },
                newState: { rolledBackToVersion: targetVersion.versionNumber, newVersionId: rollbackVersion.id },
                reason: rollbackReason,
                ipAddress: getAdminIp(event.headers),
            });

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, newVersionId: rollbackVersion.id, versionNumber: nextVersion }),
            };
        }

        // US-GOV-3.1.1: Compliance dashboard — assistants missing or with non-compliant disclosure
        // GET /admin-api?resource=disclosure-compliance[&missing=true]
        if (event.httpMethod === 'GET' && resource === 'disclosure-compliance') {
            const missingOnly = qs.missing === 'true';
            const rows = await db
                .select({
                    id: aiAssistants.id,
                    name: aiAssistants.name,
                    userId: aiAssistants.userId,
                    isActive: aiAssistants.isActive,
                    provisioningStatus: aiAssistants.provisioningStatus,
                    disclosureText: aiAssistants.disclosureText,
                    createdAt: aiAssistants.createdAt,
                })
                .from(aiAssistants)
                .orderBy(aiAssistants.createdAt);

            const results = missingOnly
                ? rows.filter(r => !r.disclosureText?.trim())
                : rows.map(r => ({ ...r, disclosureConfigured: !!r.disclosureText?.trim() }));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    total: rows.length,
                    missing: rows.filter(r => !r.disclosureText?.trim()).length,
                    results,
                }),
            };
        }

        // ── US-GOV-4.2.1: Agent anomalies — cross-workspace view ──────────────────
        if (event.httpMethod === 'GET' && resource === 'agent-anomalies') {
            const permErr = requirePermission(adminRole, 'view_audit_log');
            if (permErr) return permErr;

            const page = Math.max(0, parseInt(qs.page || '0'));
            const anomalyRows = await db
                .select({
                    id:                  agentAnomalies.id,
                    taskRunId:           agentAnomalies.taskRunId,
                    assistantId:         agentAnomalies.assistantId,
                    organisationId:      agentAnomalies.organisationId,
                    anomalyType:         agentAnomalies.anomalyType,
                    status:              agentAnomalies.status,
                    toolCallExcerpt:     agentAnomalies.toolCallExcerpt,
                    detectedAt:          agentAnomalies.detectedAt,
                    resumedAt:           agentAnomalies.resumedAt,
                    resumedBy:           agentAnomalies.resumedBy,
                    terminatedAt:        agentAnomalies.terminatedAt,
                    workspaceName:       organisations.name,
                })
                .from(agentAnomalies)
                .leftJoin(organisations, eq(organisations.id, agentAnomalies.organisationId))
                .orderBy(desc(agentAnomalies.detectedAt))
                .limit(50)
                .offset(page * 50);

            const [{ c: total }] = await db.select({ c: count() }).from(agentAnomalies);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anomalies: anomalyRows, total, page, pageSize: 50 }),
            };
        }

        // ── US-GOV-4.2.1: Configure anomaly thresholds (GET + POST) ──────────────
        if (event.httpMethod === 'GET' && resource === 'anomaly-thresholds') {
            const rows = await db.select().from(agentAnomalyThresholds).orderBy(agentAnomalyThresholds.organisationId);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ thresholds: rows }),
            };
        }

        if (event.httpMethod === 'POST' && resource === 'anomaly-thresholds') {
            const permErr = requirePermission(adminRole, 'platform_config');
            if (permErr) return permErr;

            const body = JSON.parse(event.body || '{}');
            const { organisationId, loopDetectionLimit, toolRateMultiplier, errorRatePercent, consecutiveRateLimitHits, justification } = body;

            if (organisationId && !justification?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'justification is required for workspace overrides.' }) };
            }

            const [row] = await db.insert(agentAnomalyThresholds).values({
                organisationId: organisationId ?? null,
                loopDetectionLimit: loopDetectionLimit ?? 5,
                toolRateMultiplier: toolRateMultiplier ?? 2,
                errorRatePercent: errorRatePercent ?? 20,
                consecutiveRateLimitHits: consecutiveRateLimitHits ?? 3,
                justification: justification?.trim() ?? null,
                createdBy: adminId,
            }).returning();

            await audit(db, adminId, 'UPDATE', 'agent_anomaly_thresholds', row.id, { organisationId, loopDetectionLimit, errorRatePercent });

            return {
                statusCode: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold: row }),
            };
        }

        // ── US-GOV-4.2.2: Legal holds — place and lift ────────────────────────────
        if (resource === 'legal-holds') {
            const permErr = requirePermission(adminRole, 'platform_config');
            if (permErr) return permErr;

            if (event.httpMethod === 'GET') {
                const rows = await db.select({
                    id:             legalHolds.id,
                    organisationId: legalHolds.organisationId,
                    reason:         legalHolds.reason,
                    isActive:       legalHolds.isActive,
                    placedAt:       legalHolds.placedAt,
                    liftedAt:       legalHolds.liftedAt,
                    orgName:        organisations.name,
                }).from(legalHolds)
                  .leftJoin(organisations, eq(organisations.id, legalHolds.organisationId))
                  .orderBy(desc(legalHolds.placedAt));
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holds: rows }) };
            }

            if (event.httpMethod === 'POST') {
                const body = JSON.parse(event.body || '{}');
                const { organisationId, reason } = body;
                if (!organisationId || !reason?.trim()) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'organisationId and reason are required.' }) };
                }
                const [hold] = await db.insert(legalHolds).values({
                    organisationId, reason: reason.trim(), placedBy: adminId,
                }).returning();
                await audit(db, adminId, 'UPDATE', 'legal_holds', hold.id, { organisationId, reason });
                return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hold }) };
            }

            // PATCH ?id=N  { lift: true }
            if (event.httpMethod === 'PATCH') {
                const holdId = parseInt(qs.id || '');
                if (!holdId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };
                const [lifted] = await db.update(legalHolds)
                    .set(withUpdatedAt({ isActive: false, liftedAt: new Date(), liftedBy: adminId }))
                    .where(eq(legalHolds.id, holdId))
                    .returning();
                if (!lifted) return { statusCode: 404, body: JSON.stringify({ error: 'Hold not found.' }) };
                await audit(db, adminId, 'UPDATE', 'legal_holds', holdId, { liftedAt: lifted.liftedAt });
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hold: lifted }) };
            }
        }

        // ── GET: ropa-export — US-GDPR-4.2.2 Article 30 RoPA export ────────────
        if (event.httpMethod === 'GET' && resource === 'ropa-export') {
            const permErr = requirePermission(adminRole, 'view_cogs');
            if (permErr) return permErr;

            const from = event.queryStringParameters?.from;
            const to   = event.queryStringParameters?.to;
            const periodStart = from ? new Date(from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })();
            const periodEnd   = to   ? new Date(to)   : new Date();

            // Category breakdown
            const catRows = await db.execute(sql`
                SELECT category, COUNT(*) AS call_count
                FROM ai_usage_log, unnest(data_categories) AS category
                WHERE created_at >= ${periodStart} AND created_at <= ${periodEnd}
                GROUP BY category ORDER BY call_count DESC
            `);
            const totalRes = await db.select({ total: count() }).from(aiUsageLog)
                .where(and(gte(aiUsageLog.createdAt, periodStart), lte(aiUsageLog.createdAt, periodEnd)));
            const totalCalls = Number(totalRes[0]?.total ?? 0);

            const specialRes = await db.execute(sql`
                SELECT COUNT(*) AS cnt FROM ai_usage_log
                WHERE created_at >= ${periodStart} AND created_at <= ${periodEnd}
                  AND 'special_category_suspected' = ANY(data_categories)
            `);
            const specialCount = Number((specialRes[0] as any)?.cnt ?? 0);

            // Pseudonymised log: userId hashed, no email
            const logRows = await db.select({
                id: aiUsageLog.id,
                model: aiUsageLog.model,
                inputTokens: aiUsageLog.inputTokens,
                outputTokens: aiUsageLog.outputTokens,
                dataCategories: aiUsageLog.dataCategories,
                createdAt: aiUsageLog.createdAt,
            }).from(aiUsageLog)
              .where(and(gte(aiUsageLog.createdAt, periodStart), lte(aiUsageLog.createdAt, periodEnd)))
              .limit(10000);

            const byCategory = (catRows as any[]).map(r => ({
                category: r.category,
                callCount: Number(r.call_count),
                pct: totalCalls > 0 ? +((Number(r.call_count) / totalCalls) * 100).toFixed(1) : 0,
            }));

            const report = {
                meta: {
                    exportedAt: new Date().toISOString(),
                    exportedByAdminId: adminId,
                    periodStart: periodStart.toISOString(),
                    periodEnd: periodEnd.toISOString(),
                    reportType: 'Article30_RoPA_LLM_Transfer_Log',
                },
                summary: {
                    totalLlmCalls: totalCalls,
                    byDataCategory: byCategory,
                    specialCategorySuspectedCount: specialCount,
                    zeroSpecialCategoryTransferred: specialCount === 0,
                },
                pseudonymisedLog: logRows,
            };

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Disposition': `attachment; filename="aura-ropa-article30-${new Date().toISOString().slice(0,10)}.json"`,
                } as Record<string, string>,
                body: JSON.stringify(report, null, 2),
            };
        }

        // ── US-SMM-3.3.2: Publishing Pipeline resources ───────────────────────
        if (event.httpMethod === 'GET' && resource === 'publish-pipeline-stats') {
            const now = new Date();
            const ago24h = new Date(now.getTime() - 86_400_000);
            const ago7d  = new Date(now.getTime() - 7 * 86_400_000);
            const [pub24h] = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM scheduled_posts WHERE platform='instagram' AND status='published' AND published_at >= ${ago24h}`);
            const [pub7d]  = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM scheduled_posts WHERE platform='instagram' AND status='published' AND published_at >= ${ago7d}`);
            const [queue]  = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM scheduled_posts WHERE platform='instagram' AND status='scheduled' AND publish_date <= now()`);
            const [failed] = await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM scheduled_posts WHERE platform='instagram' AND status='failed'`);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                published24h: pub24h?.c ?? 0,
                published7d:  pub7d?.c ?? 0,
                queueDepth:   queue?.c ?? 0,
                failedCount:  failed?.c ?? 0,
            }) };
        }

        if (event.httpMethod === 'GET' && resource === 'publish-cron-log') {
            const { publishCronLog } = await import('../../db/schema');
            const rows = await db.select().from(publishCronLog).orderBy(desc(publishCronLog.tickAt)).limit(20);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
        }

        if (event.httpMethod === 'GET' && resource === 'rate-limit-states') {
            const rows = await db.execute<{ organisation_id: number; platform: string; rate_limited_until: string; name: string }>(sql`
                SELECT r.organisation_id, r.platform, r.rate_limited_until, o.name
                FROM rate_limit_states r
                JOIN organisations o ON o.id = r.organisation_id
                WHERE r.rate_limited_until > now()
                ORDER BY r.rate_limited_until DESC
            `);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([...rows].map(r => ({
                organisationId: r.organisation_id,
                organisationName: r.name,
                platform: r.platform,
                rateLimitedUntil: r.rate_limited_until,
            }))) };
        }

        if (event.httpMethod === 'GET' && resource === 'expiring-tokens') {
            const in14d = new Date(Date.now() + 14 * 86_400_000);
            const rows = await db.execute<{ id: number; organisation_id: number; external_user_id: string; token_expires_at: string; name: string }>(sql`
                SELECT sc.id, sc.organisation_id, sc.external_user_id, sc.token_expires_at, o.name
                FROM system_connections sc
                JOIN organisations o ON o.id = sc.organisation_id
                WHERE sc.service_name = 'instagram'
                  AND sc.status = 'active'
                  AND sc.token_expires_at < ${in14d}
                ORDER BY sc.token_expires_at ASC
            `);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([...rows].map(r => ({
                id: r.id,
                organisationId: r.organisation_id,
                organisationName: r.name,
                externalUserId: r.external_user_id,
                tokenExpiresAt: r.token_expires_at,
            }))) };
        }

        if (event.httpMethod === 'GET' && resource === 'failed-posts') {
            const platform = event.queryStringParameters?.platform ?? 'instagram';
            const rows = await db.execute<{ id: number; publish_date: string; attempt_count: number; failure_reason: unknown; organisation_id: number }>(
                sql`SELECT id, publish_date, attempt_count, failure_reason, organisation_id
                 FROM scheduled_posts
                 WHERE platform = ${platform} AND status = 'failed'
                 ORDER BY updated_at DESC
                 LIMIT 50`
            );
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
        }

        if (event.httpMethod === 'POST' && resource === 'retry-post') {
            const postId = event.queryStringParameters?.postId;
            if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'postId required' }) };
            await db.execute(sql`UPDATE scheduled_posts SET status = 'scheduled', attempt_count = 0, retry_at = NULL, failure_reason = NULL, updated_at = now() WHERE id = ${parseInt(postId)} AND status = 'failed'`);
            await insertAdminAuditLog({ adminId, action: 'retry_failed_post', targetType: 'scheduled_posts', targetId: postId });
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
        }

        // ── US-HELP-1.3.1: Help Articles (AC14–AC17) ─────────────────────────
        if (resource === 'help-articles-seed') {
            const SEED_ARTICLES = [
                { category: 'Getting Started', sortOrder: 10, title: 'What is Be More Swan?' },
                { category: 'Getting Started', sortOrder: 20, title: 'Your Dashboard Overview' },
                { category: 'Getting Started', sortOrder: 30, title: 'Setting Up Your First Assistant' },
                { category: 'Your Assistants', sortOrder: 10, title: 'How Lead Scoring Works (And How to Trust It)' },
                { category: 'Your Assistants', sortOrder: 20, title: 'Setting Up Lead Scoring: Simple Mode vs. Advanced Mode' },
                { category: 'Lead Management', sortOrder: 10, title: "Why Is My Lead Stuck in 'Pending Merge'?" },
                { category: 'Lead Management', sortOrder: 20, title: 'Understanding Email Verification' },
                { category: 'Lead Management', sortOrder: 30, title: 'How Automated Data Enrichment Works' },
                { category: 'Lead Management', sortOrder: 40, title: 'Exporting Leads: CRM Sync vs. CSV Download' },
                { category: 'Integrations & Connections', sortOrder: 10, title: 'Connecting Apps & Integrations' },
                { category: 'Billing & Your Plan', sortOrder: 10, title: 'Billing & Your Plan' },
                { category: 'Troubleshooting & Quick Fixes', sortOrder: 10, title: 'Common Issues: Symptoms, Causes & Fixes' },
            ];
            const existing = await db.select({ id: helpArticles.id, title: helpArticles.title }).from(helpArticles);
            const existingTitles = new Set(existing.map(r => r.title));
            const preview = SEED_ARTICLES.map(a => ({
                title: a.title,
                category: a.category,
                action: existingTitles.has(a.title) ? 'update' : 'insert',
            }));
            const archiveCandidate = existing.find(r => r.title === 'Troubleshooting' && !SEED_ARTICLES.find(s => s.title === r.title));
            if (archiveCandidate) preview.push({ title: 'Troubleshooting', category: '—', action: 'archive' });

            if (event.httpMethod === 'GET') {
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preview }) };
            }
            if (event.httpMethod === 'POST') {
                // Execute the seed SQL file via DB raw queries — articles are upserted by title
                const fs = await import('fs');
                const path = await import('path');
                const sqlPath = path.join(process.cwd(), 'db', 'seed-help-articles.sql');
                const sql = fs.readFileSync(sqlPath, 'utf8');
                await db.execute(sql as any);
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, applied: SEED_ARTICLES.length }) };
            }
        }

        if (resource === 'help-articles') {
            if (event.httpMethod === 'GET') {
                const rows = await db
                    .select()
                    .from(helpArticles)
                    .orderBy(helpArticles.category, helpArticles.sortOrder);
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articles: rows }) };
            }
            if (event.httpMethod === 'PATCH') {
                const articleId = event.queryStringParameters?.id;
                if (!articleId) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
                let body: { is_published?: boolean };
                try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
                if (typeof body.is_published !== 'boolean') return { statusCode: 400, body: JSON.stringify({ error: 'is_published (boolean) required' }) };
                const [updated] = await db.update(helpArticles)
                    .set({ isPublished: body.is_published, updatedAt: new Date() })
                    .where(eq(helpArticles.id, articleId))
                    .returning({ id: helpArticles.id, isPublished: helpArticles.isPublished, updatedAt: helpArticles.updatedAt });
                if (!updated) return { statusCode: 404, body: JSON.stringify({ error: 'Article not found' }) };
                return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, article: updated }) };
            }
        }

        return { statusCode: 404, body: JSON.stringify({ error: `Unknown resource: ${resource}` }) };

    } catch (err: any) {
        console.error('[admin-api] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
    });
};
