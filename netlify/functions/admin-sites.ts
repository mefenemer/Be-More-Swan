// netlify/functions/admin-sites.ts
// Admin ▸ Trust ▸ Hosted Sites — every website we host on bemoreswan.site, the reports against them,
// and the power to take one offline. docs/website-assistant-plan.md §7 (abuse controls).
//
//   GET  ?filter=reported|all          → { sites: [{ id, slug, url, status, workspace, publishedAt,
//                                          suspendedReason, openReports, reports: [...] }] }
//   POST { action: 'suspend', siteId, reason }   — take it offline now (reason required; the owner
//                                                  sees it on their Website tab)
//   POST { action: 'restore', siteId }           — lift the suspension; the site comes back as it was
//                                                  (live if it had a published version, else a draft)
//   POST { action: 'close_report', reportId, outcome: 'dismissed'|'actioned' }
//
// Suspension serves a plain "This site is unavailable" (410) from site-serve.ts at once — there is
// no cache in front of it to wait for. Gated on `platform_config` (rank 3), like the music library:
// a decision that changes what the outside world sees. Every change is audit-logged.

import jwt from 'jsonwebtoken';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { organisations, siteReports, sites, users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { getAdminIp, insertAdminAuditLog } from '../../src/utils/admin-audit';
import { REPORT_REASONS, siteOrigin } from '../../src/utils/site-hosting';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function requireAdmin(event: { headers: Record<string, string | undefined> }): Promise<{ id: number } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: userId } : null;
}

export default withLambda(async (event) => {
    const admin = await requireAdmin(event as { headers: Record<string, string | undefined> });
    if (!admin) return json(403, { error: 'Not allowed.' });
    const db = getDb();
    const ip = getAdminIp(event.headers as Record<string, string | undefined>);

    if (event.httpMethod === 'GET') {
        const filter = event.queryStringParameters?.filter === 'all' ? 'all' : 'reported';
        const openCounts = db.select({ siteId: siteReports.siteId, n: sql<number>`count(*)::int`.as('n') })
            .from(siteReports).where(eq(siteReports.status, 'open')).groupBy(siteReports.siteId).as('open_counts');
        const rows = await db.select({
            id: sites.id, slug: sites.slug, status: sites.status, publishedAt: sites.publishedAt, publishedVersion: sites.publishedVersion,
            suspendedReason: sites.suspendedReason, suspendedAt: sites.suspendedAt, workspace: organisations.name, orgId: sites.organisationId,
            openReports: sql<number>`COALESCE(${openCounts.n}, 0)`,
        }).from(sites)
            .innerJoin(organisations, eq(organisations.id, sites.organisationId))
            .leftJoin(openCounts, eq(openCounts.siteId, sites.id))
            .where(filter === 'all'
                ? or(isNotNull(sites.publishedVersion), eq(sites.status, 'suspended'))
                : or(sql`${openCounts.n} > 0`, eq(sites.status, 'suspended')))
            .orderBy(desc(sql`COALESCE(${openCounts.n}, 0)`), desc(sites.publishedAt))
            .limit(500);
        const ids = rows.map((r) => r.id);
        const reports = ids.length
            ? await db.select().from(siteReports).where(inArray(siteReports.siteId, ids)).orderBy(desc(siteReports.createdAt)).limit(1000)
            : [];
        return json(200, {
            reasons: REPORT_REASONS,
            sites: rows.map((r) => ({
                ...r, url: r.slug ? siteOrigin(r.slug) : null,
                reports: reports.filter((x) => x.siteId === r.id).slice(0, 20).map((x) => ({
                    id: x.id, reason: x.reason, details: x.details, reporterEmail: x.reporterEmail, status: x.status, createdAt: x.createdAt,
                })),
            })),
        });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    if (action === 'close_report') {
        const reportId = Number(body.reportId);
        const outcome = body.outcome === 'actioned' ? 'actioned' : 'dismissed';
        const [row] = await db.update(siteReports).set({ status: outcome, reviewedBy: admin.id, reviewedAt: new Date() })
            .where(and(eq(siteReports.id, reportId), eq(siteReports.status, 'open'))).returning({ id: siteReports.id, siteId: siteReports.siteId });
        if (!row) return json(404, { error: 'That report is already closed.' });
        void insertAdminAuditLog({ adminId: admin.id, action: 'hosted_site_moderation', targetType: 'site_report', targetId: String(row.id), newState: { status: outcome, siteId: row.siteId }, ipAddress: ip });
        return json(200, { ok: true });
    }

    const siteId = Number(body.siteId);
    const [site] = Number.isInteger(siteId) ? await db.select().from(sites).where(eq(sites.id, siteId)).limit(1) : [];
    if (!site) return json(404, { error: 'Site not found.' });

    if (action === 'suspend') {
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
        if (!reason) return json(400, { error: 'Give a reason — the owner sees it.' });
        await db.update(sites).set({ status: 'suspended', suspendedAt: new Date(), suspendedReason: reason, updatedAt: new Date() }).where(eq(sites.id, site.id));
        await db.update(siteReports).set({ status: 'actioned', reviewedBy: admin.id, reviewedAt: new Date() })
            .where(and(eq(siteReports.siteId, site.id), eq(siteReports.status, 'open')));
        void insertAdminAuditLog({
            adminId: admin.id, action: 'hosted_site_moderation', targetType: 'site', targetId: String(site.id),
            previousState: { status: site.status }, newState: { status: 'suspended', slug: site.slug }, reason, ipAddress: ip,
        });
        return json(200, { ok: true });
    }

    if (action === 'restore') {
        if (site.status !== 'suspended') return json(400, { error: 'That site is not suspended.' });
        const status = site.publishedVersion != null ? 'published' : 'draft';
        await db.update(sites).set({ status, suspendedAt: null, suspendedReason: null, updatedAt: new Date() }).where(eq(sites.id, site.id));
        void insertAdminAuditLog({
            adminId: admin.id, action: 'hosted_site_moderation', targetType: 'site', targetId: String(site.id),
            previousState: { status: 'suspended', reason: site.suspendedReason }, newState: { status, slug: site.slug }, ipAddress: ip,
        });
        return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
});
