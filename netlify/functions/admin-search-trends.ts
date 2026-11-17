// netlify/functions/admin-search-trends.ts
// Admin ▸ System ▸ Search trends (docs/google-trends-plan.md §5 Phase 1): every shared Google Trends term,
// how many workspaces track it, whether its weekly refresh is healthy, and what DataForSEO has cost.
// Shared data only — never which workspace tracks what (src/utils/search-trends-admin.ts).
//
//   GET                                 → { setUp, providerConfigured, providerCheck, totals, spend, terms }
//                                         providerCheck = a FREE DataForSEO call: is the login actually accepted?
//   POST { action: 'run_now' }          → wakes search-trends-background now (collect + post what is due)
//   POST { action: 'retry', termId }    → clears a term's error/backoff and marks it due
//
// Until db/z-search-trends.sql is applied every read answers { setUp: false }. Gated on `platform_config`;
// writes are refused during impersonation.

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { checkProvider, dataForSeoProvider } from '../../src/lib/trends-provider';
import { dispatchSearchTrends } from '../../src/utils/search-trends';
import { loadAdminTrends, retryTrendTerm } from '../../src/utils/search-trends-admin';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

async function requireAdmin(event: { headers: Record<string, string | undefined> }): Promise<{ id: number; impersonating: boolean } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let tok: { userId: number; scope?: string };
    try { tok = jwt.verify(match[1], secret) as { userId: number; scope?: string }; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, tok.userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: tok.userId, impersonating: tok.scope === 'impersonate' } : null;
}

function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

export default withLambda(async (event) => {
    const headers = event.headers as Record<string, string | undefined>;
    const admin = await requireAdmin({ headers });
    if (!admin) return json(403, { error: 'You need the platform_config permission for this page.' });
    const db = getDb();
    try {
        if (event.httpMethod === 'GET') {
            const provider = dataForSeoProvider();
            const [view, providerCheck] = await Promise.all([loadAdminTrends(db, !!provider), checkProvider(provider)]);
            return json(200, { ...view, providerCheck });
        }
        if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
        if (admin.impersonating) return json(403, { error: 'Action blocked during impersonation session.' });
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON.' }); }

        if (body.action === 'run_now') {
            const out = await dispatchSearchTrends(db, resolveBaseUrl(headers), process.env.CRON_TRIGGER_SECRET);
            await insertAdminAuditLog({ adminId: admin.id, action: 'search_trends_run', targetType: 'search_trends', targetId: 'refresh', newState: out, ipAddress: getAdminIp(headers), userAgent: headers['user-agent'] });
            return json(200, { ok: true, ...out });
        }
        if (body.action === 'retry') {
            const termId = Number(body.termId);
            if (!Number.isInteger(termId) || termId <= 0) return json(400, { error: 'termId is required.' });
            const done = await retryTrendTerm(db, termId);
            if (!done) return json(404, { error: 'Term not found.' });
            await insertAdminAuditLog({ adminId: admin.id, action: 'search_trends_retry', targetType: 'search_trend_term', targetId: String(termId), newState: { retried: true }, ipAddress: getAdminIp(headers), userAgent: headers['user-agent'] });
            return json(200, { ok: true });
        }
        return json(400, { error: 'Unknown action.' });
    } catch (err) {
        if (isMissingTable(err)) return json(200, { setUp: false });
        console.error('[admin-search-trends]', err);
        return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
});
