// netlify/functions/admin-sar-export.ts
//
// US-ADM-1.3.1: GDPR Subject Access Request (SAR) Data Export
//
// POST /.netlify/functions/admin-sar-export
//   Body: { targetUserId: number }
//   Cookie: aura_session (must be billing_admin, platform_admin, or super_admin)
//
// Packages all personal data for a user, stores it in dataExportRequests with a
// 72-hour signed download token, then notifies the requesting admin.
//
// The actual file download is served by sar-download.ts.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, userProfiles, plans, payments, invoices,
    aiAssistants, taskRuns, workspaceAssets, contentAssets,
    supportTickets, auditLogs, dataExportRequests, notifications,
    userNotifications, onboardingDrafts, scheduledPosts,
    gdprErasureLog, tosAcceptances, dpaAcceptances, userOrganisations,
} from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';

const jwtSecret = process.env.JWT_SECRET;
const BASE_URL  = process.env.BASE_URL || 'https://bemoreswan.com';

const ALLOWED_ROLES = ['billing_admin', 'platform_admin', 'super_admin'];

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── 1. Authenticate admin ──────────────────────────────────────────────
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        const tok = jwt.verify(match[1], jwtSecret) as any;
        if (tok.scope === 'impersonate') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Action blocked during impersonation session.' }) };
        }
        adminId = tok.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [adminUser] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, adminId))
        .limit(1);

    if (!adminUser || !ALLOWED_ROLES.includes(adminUser.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: `Requires one of: ${ALLOWED_ROLES.join(', ')}.` }) };
    }

    // ── 2. Validate request ────────────────────────────────────────────────
    let body: { targetUserId?: number };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const { targetUserId } = body;
    if (!targetUserId) return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId required.' }) };

    // ── 3. Load all user data ──────────────────────────────────────────────
    const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);

    if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

    const [profile]   = await db.select().from(userProfiles).where(eq(userProfiles.userId, targetUserId)).limit(1);
    const userPlans   = await db.select().from(plans).where(eq(plans.userId, targetUserId));
    const userPayments = await db.select().from(payments).where(eq(payments.userId, targetUserId));
    const userInvoices = await db.select().from(invoices).where(eq(invoices.userId, targetUserId));
    const assistants  = await db.select().from(aiAssistants).where(eq(aiAssistants.userId, targetUserId));
    const tasks       = await db.select().from(taskRuns).where(eq(taskRuns.userId, targetUserId));
    const assets      = await db.select().from(workspaceAssets).where(eq(workspaceAssets.uploaderId, targetUserId));
    const content     = await db.select().from(contentAssets).where(eq(contentAssets.userId, targetUserId));
    const tickets     = await db.select().from(supportTickets).where(eq(supportTickets.userId, targetUserId));
    const auditEntries = await db.select().from(auditLogs).where(eq(auditLogs.userId, targetUserId));
    const drafts      = await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.userId, targetUserId));
    const scheduled   = await db.select().from(scheduledPosts).where(eq(scheduledPosts.userId, targetUserId));
    const notifs      = await db.select().from(notifications).where(eq(notifications.userId, targetUserId));
    const erasures    = await db.select().from(gdprErasureLog).where(eq(gdprErasureLog.requestedBy, adminId));
    const tosRecords  = await db.select().from(tosAcceptances).where(eq(tosAcceptances.userId, targetUserId));
    // Resolve the target user's org memberships from the junction (not the deprecated users.organisationId).
    const targetOrgs = await db
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, targetUserId));
    const targetOrgIds = targetOrgs.map(o => o.organisationId);
    const dpaRecords  = targetOrgIds.length
        ? await db.select().from(dpaAcceptances).where(inArray(dpaAcceptances.organisationId, targetOrgIds))
        : [];

    // ── 4. Build the SAR package ───────────────────────────────────────────
    const sarData = {
        exportGeneratedAt: new Date().toISOString(),
        exportRequestedBy: `admin#${adminId}`,
        subject: {
            id:          user.id,
            email:       user.email,
            firstName:   user.firstName,
            lastName:    user.lastName,
            role:        user.role,
            status:      user.status,
            createdAt:   user.createdAt,
            updatedAt:   user.updatedAt,
        },
        profile:           profile ?? null,
        subscriptions:     userPlans,
        payments:          userPayments,
        invoices:          userInvoices,
        aiAssistants:      assistants,
        taskRuns:          tasks.map(t => ({
            id: t.id, taskType: t.taskType, status: t.status,
            createdAt: t.createdAt, completedAt: t.completedAt,
        })),
        workspaceAssets:   assets.map(a => ({ id: a.id, name: a.name, type: a.assetType, createdAt: a.createdAt })),
        contentAssets:     content.map(c => ({ id: c.id, title: c.name, status: c.status, createdAt: c.createdAt })),
        scheduledPosts:    scheduled,
        supportTickets:    tickets,
        onboardingDrafts:  drafts,
        notifications:     notifs,
        auditLog:          auditEntries,
        gdprErasureLog:    erasures,
        consentLog: {
            tosAcceptances: tosRecords.map(r => ({
                version:    r.version,
                acceptedAt: r.acceptedAt,
                ipAddress:  r.ipAddress,
                userAgent:  r.userAgent,
            })),
            dpaAcceptances: dpaRecords.map(r => ({
                version:    r.version,
                acceptedAt: r.acceptedAt,
                ipAddress:  r.ipAddress,
                userAgent:  r.userAgent,
                email:      r.email,
            })),
        },
    };

    // ── 5. Store in dataExportRequests with 72h expiry ─────────────────────
    const downloadToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Store the SAR JSON in downloadUrl column (repurposed as data store — no S3 required)
    const [exportRow] = await db.insert(dataExportRequests).values({
        userId:        targetUserId,
        downloadToken,
        downloadUrl:   JSON.stringify(sarData),  // stored as JSON string
        expiresAt,
        status:        'ready',
    }).returning({ id: dataExportRequests.id });

    const downloadUrl = `${BASE_URL}/.netlify/functions/sar-download?token=${downloadToken}`;

    // ── 6. Notify the requesting admin ────────────────────────────────────
    await db.insert(notifications).values({
        userId:  adminId,
        type:    'system',
        title:   `📦 SAR Export Ready — ${user.email}`,
        message: `The Subject Access Request data package for ${user.email} is ready. Download it within 72 hours.`,
        metadata: { downloadUrl, expiresAt: expiresAt.toISOString(), targetUserId },
    });

    // ── 7. Write audit log ────────────────────────────────────────────────
    await insertAdminAuditLog({
        adminId,
        action:    'sar_export',
        targetType:'user',
        targetId:   targetUserId,
        previousState: null as any,
        newState:  { downloadToken, expiresAt: expiresAt.toISOString() },
        reason:    'GDPR Subject Access Request',
        ipAddress: getAdminIp(event.headers),
        metadata:  { exportRowId: exportRow?.id },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success:     true,
            downloadUrl,
            expiresAt:   expiresAt.toISOString(),
            message:     'SAR package ready. You have been notified via in-app notification.',
        }),
    };
};
