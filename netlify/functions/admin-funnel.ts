// netlify/functions/admin-funnel.ts — Admin → Analytics → Growth funnel.
//
//   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → { range, setUp: { visits, sources }, stages, bySource, views }
//
// Visits come from the cookieless counter (site_visit_counts); the rest is a cohort of accounts
// created in the range (src/utils/growth-funnel.ts says how to read it). Stages:
//   · Confirmed email — users.status has left 'pending_verification'.
//   · Hired an assistant — any assistant in one of their workspaces other than the Business Mentor
//     (every workspace has one; it never takes a seat).
//   · Approved first content — a post approved, scheduled or published, a blog article published, or
//     a newsletter sent, in one of their workspaces. Posts carry no approval time, so this is "ever".
//   · Paid — a completed payment above £0 (a beta plan or a £0 trial invoice is not paid).
// Customer accounts only (role 'user'). Any admin role may read it, like the rest of Analytics.
//
// Until db/z-growth-funnel.sql is applied, visits are 0 and every sign-up's source is unknown, and
// `setUp` says which table is missing so the card can say so.

import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';
import { buildFunnel, funnelRange, type CohortRow, type VisitRow } from '../../src/utils/growth-funnel';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<boolean> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return false;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return false; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return isAdminRole(row?.role);
}

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : ((res as { rows?: T[] })?.rows ?? [])) as T[];

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
    if (!(await requireAdmin(event))) return json(403, { error: 'Admins only.' });
    const db = getDb();

    const [{ today }] = rowsOf<{ today: string }>(await db.execute(sql`SELECT ((now() AT TIME ZONE 'Europe/London')::date)::text AS today`));
    const qs = event.queryStringParameters || {};
    const range = funnelRange(qs.from, qs.to, today);

    const [tables] = rowsOf<{ visits: boolean; sources: boolean }>(await db.execute(sql`
        SELECT to_regclass('public.site_visit_counts') IS NOT NULL AS visits,
               to_regclass('public.signup_sources')   IS NOT NULL AS sources`));

    const visits: VisitRow[] = tables.visits
        ? rowsOf<VisitRow>(await db.execute(sql`
            SELECT source, SUM(entries)::int AS entries, SUM(views)::int AS views
              FROM site_visit_counts
             WHERE day BETWEEN ${range.from}::date AND ${range.to}::date
             GROUP BY source`))
        : [];

    // Dates go in as text and are cast in SQL (a JS Date in raw sql`` is the known trap).
    const sourceCol = tables.sources ? sql`ss.source` : sql`NULL::text`;
    const sourceJoin = tables.sources ? sql`LEFT JOIN signup_sources ss ON ss.user_id = u.id` : sql``;
    const cohort = rowsOf<CohortRow>(await db.execute(sql`
        WITH cohort AS (
            SELECT u.id, u.status, ${sourceCol} AS source
              FROM users u ${sourceJoin}
             WHERE u.role = 'user'
               AND (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date BETWEEN ${range.from}::date AND ${range.to}::date
        ),
        orgs AS (
            SELECT c.id AS user_id, uo.organisation_id FROM cohort c JOIN user_organisations uo ON uo.user_id = c.id
        )
        SELECT c.source,
               (c.status <> 'pending_verification') AS confirmed,
               EXISTS (SELECT 1 FROM ai_assistants a JOIN orgs o ON o.organisation_id = a.organisation_id
                        WHERE o.user_id = c.id AND coalesce(a.configuration ->> 'type', '') <> 'business_mentor') AS hired,
               (EXISTS (SELECT 1 FROM scheduled_posts sp JOIN orgs o ON o.organisation_id = sp.organisation_id
                         WHERE o.user_id = c.id AND sp.status IN ('approved', 'scheduled', 'publishing', 'published'))
                OR EXISTS (SELECT 1 FROM blog_posts bp JOIN orgs o ON o.organisation_id = bp.organisation_id
                            WHERE o.user_id = c.id AND bp.published_at IS NOT NULL)
                OR EXISTS (SELECT 1 FROM newsletter_issues ni JOIN orgs o ON o.organisation_id = ni.organisation_id
                            WHERE o.user_id = c.id AND ni.sent_at IS NOT NULL)) AS approved,
               EXISTS (SELECT 1 FROM payments p
                        WHERE p.status = 'completed' AND p.amount > 0
                          AND (p.user_id = c.id OR p.organisation_id IN (SELECT o.organisation_id FROM orgs o WHERE o.user_id = c.id))) AS paid
          FROM cohort c`));

    return json(200, { range, setUp: tables, ...buildFunnel(visits, cohort) });
});
