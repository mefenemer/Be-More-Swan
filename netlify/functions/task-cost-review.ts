// task-cost-review.ts — a workspace's review and acceptance of a change to task costs.
//
//   GET  → { changes: [{ id, date, inForce, reason, summary }], mustAccept, canAccept }
//   POST { ids } → records the workspace owner's acceptance of those changes
//
// mustAccept: a change has started and this workspace has not accepted, so the prompt can't be dismissed.
// Only a workspace owner can accept (owner decision 2026-11-06). Everyone else sees nothing here: they
// have the notice, and it says the owner accepts. Rules: src/utils/task-cost-changes.ts.
//
// An admin viewing through impersonation sees no prompt and cannot accept for the customer.

import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { pseudonymiseIp } from '../../src/utils/ip-pseudonymise';
import { acceptChanges, changeSummary, longDate, unacceptedChanges } from '../../src/utils/task-cost-changes';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const NOTHING = { changes: [], mustAccept: false, canAccept: false };

export default withLambda(async (event) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        if (ctx.impersonation || ctx.role !== 'owner') return json(200, NOTHING);
        try {
            const today = new Date().toISOString().slice(0, 10);
            const open = await unacceptedChanges(db, ctx.organisationId);
            const changes = open.map((c) => ({
                id: c.id, date: longDate(c.effectiveDate), inForce: c.effectiveDate <= today, reason: c.reason, summary: changeSummary(c.items),
            }));
            return json(200, { changes, mustAccept: changes.some((c) => c.inForce), canAccept: changes.length > 0 });
        } catch (err) {
            // Never block the workspace on this: table not applied yet, or a database fault.
            console.error('[task-cost-review] read failed (non-fatal)', err instanceof Error ? err.message : err);
            return json(200, NOTHING);
        }
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const ctx = await requireTenant(event, db, { roles: ['owner'], mutates: true });
    if ('error' in ctx) return ctx.error;
    let body: { ids?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body.' }); }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return json(400, { error: 'Which change?' });
    const accepted = await acceptChanges(db, {
        organisationId: ctx.organisationId, userId: ctx.userId, ids,
        // Truncated, never stored whole — the privacy policy promises it (src/utils/ip-pseudonymise.ts).
        ipAddress: pseudonymiseIp(event.headers['x-forwarded-for']?.split(',')[0]?.trim() || event.headers['client-ip']),
        userAgent: event.headers['user-agent'] || null,
    });
    return json(200, { accepted });
});
