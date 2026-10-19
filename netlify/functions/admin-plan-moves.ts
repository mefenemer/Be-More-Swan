// netlify/functions/admin-plan-moves.ts
//
// Admin → Revenue → Plan moves: move customers between plans in bulk (src/utils/plan-moves.ts).
//
//   GET                                   → { moves: [...], plans: [...], livemode }
//   POST { action: 'preview', fromMasterPlanId?, organisationIds?, toMasterPlanId }
//                                         → { target, rows: MovePreviewRow[], truncated }  (changes nothing)
//   POST { action: 'run', fromMasterPlanId?, organisationIds, toMasterPlanId, confirm: true }
//                                         → { scheduled, skipped, failed, batchId }
//   POST { action: 'cancel', ids?: number[], batchId?: string }  → { cancelled }
//
// Cookie: aura_session; role must clear `override_subscription` (billing_admin and above) — the same
// right as changing one customer's plan by hand. Every run and cancel is audit-logged.
//
// ⚠️ STRIPE_SECRET_KEY directly and live-only, like Coupons and Override Subscription: a move made
// "in sandbox" would still move real customers in the live Stripe account.

import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { masterPlans, planMoves, users } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { cancelMoves, listMoves, previewMoves, runMoves, MAX_BATCH } from '../../src/utils/plan-moves';

const jwtSecret = process.env.JWT_SECRET;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2026-05-27.dahlia' }) : null;
const livemode = !!stripeKey && !stripeKey.startsWith('sk_test_');

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function ids(v: unknown): number[] {
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

export default withLambda(async (event) => {
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return json(400, { error: 'Plan moves are not available in Sandbox mode.' });
    }
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });

    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return json(401, { error: 'Not authenticated.' });
    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number; scope?: string };
        if (tok.scope === 'impersonate') return json(403, { error: 'Action blocked during impersonation session.' });
        adminId = tok.userId;
    } catch {
        return json(401, { error: 'Invalid session.' });
    }
    const db = getDb();
    const [admin] = await db.select({ role: users.role }).from(users).where(eq(users.id, adminId)).limit(1);
    const denied = requirePermission(admin?.role, 'override_subscription');
    if (denied) return denied;

    const ip = getAdminIp(event.headers as Record<string, string | undefined>);
    const ua = event.headers['user-agent'] || undefined;

    try {
        if (event.httpMethod === 'GET') {
            const planRows = await db.select({
                id: masterPlans.id, tierKey: masterPlans.tierKey, name: masterPlans.name,
                monthlyPriceGbp: masterPlans.monthlyPriceGbp, isActive: masterPlans.isActive, isContactSales: masterPlans.isContactSales,
            }).from(masterPlans).orderBy(masterPlans.monthlyPriceGbp);
            const moves = await listMoves(db);
            return json(200, { moves: moves.reverse(), plans: planRows, livemode, maxBatch: MAX_BATCH });
        }

        if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
        if (!stripe) return json(503, { error: 'Stripe is not configured on this deployment.' });
        const body = JSON.parse(event.body || '{}');
        const action = String(body.action || '');
        const toMasterPlanId = Number(body.toMasterPlanId);
        const fromMasterPlanId = body.fromMasterPlanId ? Number(body.fromMasterPlanId) : null;
        const organisationIds = ids(body.organisationIds);

        if (action === 'preview') {
            if (!Number.isInteger(toMasterPlanId)) return json(400, { error: 'Choose the plan to move customers to.' });
            if (!fromMasterPlanId && !organisationIds.length) return json(400, { error: 'Choose the plan to move customers from, or pick customers.' });
            const preview = await previewMoves(db, stripe, { fromMasterPlanId, organisationIds, toMasterPlanId });
            return json(200, { target: { id: preview.target.id, name: preview.target.name }, rows: preview.rows, truncated: preview.truncated });
        }

        if (action === 'run') {
            if (body.confirm !== true) return json(400, { error: 'Confirm the move first.' });
            if (!Number.isInteger(toMasterPlanId)) return json(400, { error: 'Choose the plan to move customers to.' });
            if (!organisationIds.length) return json(400, { error: 'Tick at least one customer to move.' });
            if (organisationIds.length > MAX_BATCH) return json(400, { error: `At most ${MAX_BATCH} customers in one batch.` });
            const batchId = randomUUID();
            const result = await runMoves(db, stripe, {
                fromMasterPlanId, organisationIds, toMasterPlanId, adminId, livemode, batchId,
                baseUrl: process.env.BASE_URL || 'https://bemoreswan.com',
            });
            await insertAdminAuditLog({
                adminId, action: 'plan_move_run', targetType: 'plan_move_batch', targetId: batchId,
                newState: { toMasterPlanId, fromMasterPlanId, organisationIds, ...result, livemode }, ipAddress: ip, userAgent: ua,
            });
            return json(200, result);
        }

        if (action === 'cancel') {
            const moveIds = ids(body.ids);
            let toCancel = moveIds;
            if (!toCancel.length && typeof body.batchId === 'string' && body.batchId) {
                const rows = await db.select({ id: planMoves.id }).from(planMoves)
                    .where(and(eq(planMoves.batchId, body.batchId), eq(planMoves.status, 'scheduled')));
                toCancel = rows.map((r) => r.id);
            }
            if (!toCancel.length) return json(400, { error: 'Nothing scheduled to cancel.' });
            const cancelled = await cancelMoves(db, stripe, { ids: toCancel }, adminId, 'Cancelled by an admin.', true);
            await insertAdminAuditLog({
                adminId, action: 'plan_move_cancel', targetType: 'plan_move', targetId: toCancel.join(','),
                newState: { cancelled, ids: toCancel, livemode }, ipAddress: ip, userAgent: ua,
            });
            return json(200, { cancelled });
        }

        return json(400, { error: 'Unknown action.' });
    } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (/relation "plan_moves" does not exist/.test(msg)) {
            return json(503, { error: 'Plan moves are not set up on this environment yet (run db/z-plan-moves.sql).' });
        }
        console.error('[admin-plan-moves]', err);
        return json(500, { error: msg.slice(0, 300) });
    }
});
