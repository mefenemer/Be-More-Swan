// netlify/functions/admin-coupons.ts
//
// Admin → Revenue → Coupons. Every coupon is created in Stripe AND recorded in billing_coupons, so
// the admin portal can list, edit and delete them without anyone opening the Stripe dashboard.
// Checkout keeps asking Stripe whether a code is valid (validate-promo.ts) — Stripe is the
// authority on redemption; this table is our record of what exists and who made it.
//
//   GET                         → { coupons: [...], livemode }
//   POST   { name, code, discountType, discountValue, duration, durationInMonths?, maxRedemptions?, redeemBy?, notes? }
//   PATCH  { id, name?, notes?, isActive? }   — the only things Stripe lets change after creation
//   DELETE ?id=                 → deactivates the code, deletes the coupon in Stripe, keeps our row
//
// Cookie: aura_session; role must clear `manage_coupons` (billing_admin and above).
//
// ⚠️ STRIPE_SECRET_KEY directly, never the admin sandbox toggle: a coupon has to exist in the same
// Stripe account the customer checkout uses (create-subscription.ts reads STRIPE_SECRET_KEY), or
// the code an admin just made would be "not found" at checkout.

import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { billingCoupons, users } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { validateCouponInput, stripeCouponParams, stripePromotionCodeParams, describeCoupon } from '../../src/utils/coupon-rules';

const jwtSecret = process.env.JWT_SECRET;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2026-05-27.dahlia' }) : null;
const livemode = !!stripeKey && !stripeKey.startsWith('sk_test_');

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** A Stripe error's own message is written for developers; say what happened instead. */
function stripeMessage(err: unknown): string {
    const e = err as { type?: string; code?: string; message?: string };
    if (e?.code === 'resource_already_exists' || /already exists/i.test(e?.message || '')) {
        return 'That code is already in use in Stripe. Choose a different code.';
    }
    return `Stripe refused the request: ${String(e?.message || 'unknown error').slice(0, 200)}`;
}

export default withLambda(async (event) => {
    // Live-only, like every other billing admin action: a coupon made "in sandbox" would still be
    // made in the live Stripe account, which is exactly what the operator believed they avoided.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return json(400, { error: 'Coupons are not available in Sandbox mode.' });
    }
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });

    // ── Auth ────────────────────────────────────────────────────────────────────────────────
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
    const denied = requirePermission(admin?.role, 'manage_coupons');
    if (denied) return denied;
    if (!stripe) return json(503, { error: 'Stripe is not configured on this deployment.' });

    const ip = getAdminIp(event.headers as Record<string, string | undefined>);
    const ua = event.headers['user-agent'] || undefined;
    const notDeleted = and(isNull(billingCoupons.deletedAt), eq(billingCoupons.livemode, livemode));

    // ── List ────────────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const rows = await db.select().from(billingCoupons).where(notDeleted).orderBy(desc(billingCoupons.createdAt));
        // Redemptions live in Stripe. One list call, not one retrieve per coupon.
        const redeemed = new Map<string, number>();
        let stripeError: string | null = null;
        try {
            for await (const c of stripe.coupons.list({ limit: 100 })) redeemed.set(c.id, c.times_redeemed);
        } catch (err) {
            stripeError = 'Could not read redemption counts from Stripe just now.';
            console.error('[admin-coupons] coupons.list failed', err);
        }
        return json(200, {
            livemode,
            stripeError,
            coupons: rows.map((r) => ({
                ...r,
                percentOff: r.percentOff != null ? Number(r.percentOff) : null,
                summary: describeCoupon({ percentOff: r.percentOff, amountOffPence: r.amountOffPence, duration: r.duration, durationInMonths: r.durationInMonths }),
                timesRedeemed: redeemed.get(r.stripeCouponId) ?? null,
                expired: r.redeemBy ? r.redeemBy.getTime() < Date.now() : false,
            })),
        });
    }

    let body: Record<string, unknown> = {};
    if (event.body) {
        try { body = JSON.parse(event.body); } catch { return json(400, { error: 'Invalid JSON.' }); }
    }

    // ── Create ──────────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        const v = validateCouponInput(body);
        if (!v.ok) return json(400, { error: v.error });
        const c = v.value;

        const [clash] = await db.select({ id: billingCoupons.id }).from(billingCoupons)
            .where(and(notDeleted, sql`upper(${billingCoupons.code}) = ${c.code}`)).limit(1);
        if (clash) return json(409, { error: `There is already a coupon with the code ${c.code}.` });

        // Two Stripe calls. If the second fails, the first is undone, so Stripe never holds a coupon
        // with no code and no row here — an orphan nobody could see or delete from this screen.
        let coupon: Stripe.Coupon;
        try {
            coupon = await stripe.coupons.create(stripeCouponParams(c));
        } catch (err) {
            return json(502, { error: stripeMessage(err) });
        }
        let promo: Stripe.PromotionCode;
        try {
            promo = await stripe.promotionCodes.create(stripePromotionCodeParams(c, coupon.id));
        } catch (err) {
            await stripe.coupons.del(coupon.id).catch((e) => console.error('[admin-coupons] rollback of coupon failed', coupon.id, e));
            return json(502, { error: stripeMessage(err) });
        }

        const [row] = await db.insert(billingCoupons).values({
            name: c.name, code: c.code, notes: c.notes,
            percentOff: c.percentOff != null ? String(c.percentOff) : null,
            amountOffPence: c.amountOffPence,
            duration: c.duration, durationInMonths: c.durationInMonths,
            maxRedemptions: c.maxRedemptions, redeemBy: c.redeemBy,
            stripeCouponId: coupon.id, stripePromotionCodeId: promo.id,
            livemode, createdBy: adminId,
        }).returning();

        await insertAdminAuditLog({
            adminId, action: 'coupon_create', targetType: 'coupon', targetId: row.id,
            newState: { code: c.code, summary: describeCoupon(c), stripeCouponId: coupon.id, livemode },
            ipAddress: ip, userAgent: ua,
        });
        return json(201, { coupon: row });
    }

    const id = Number(event.httpMethod === 'DELETE' ? event.queryStringParameters?.id : body.id);
    if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
    const [existing] = await db.select().from(billingCoupons).where(and(eq(billingCoupons.id, id), notDeleted)).limit(1);
    if (!existing) return json(404, { error: 'Coupon not found.' });

    // ── Edit: name, notes, active ───────────────────────────────────────────────────────────
    if (event.httpMethod === 'PATCH') {
        const patch: Partial<typeof billingCoupons.$inferInsert> = {};
        if (body.name !== undefined) {
            const name = String(body.name).trim();
            if (!name || name.length > 40) return json(400, { error: 'The name must be 1–40 characters.' });
            patch.name = name;
        }
        if (body.notes !== undefined) patch.notes = String(body.notes ?? '').trim() || null;
        if (body.isActive !== undefined) patch.isActive = body.isActive === true;
        if (Object.keys(patch).length === 0) return json(400, { error: 'Nothing to change.' });

        try {
            if (patch.name !== undefined && patch.name !== existing.name) {
                await stripe.coupons.update(existing.stripeCouponId, { name: patch.name });
            }
            if (patch.isActive !== undefined && patch.isActive !== existing.isActive) {
                await stripe.promotionCodes.update(existing.stripePromotionCodeId, { active: patch.isActive });
            }
        } catch (err) {
            return json(502, { error: stripeMessage(err) });
        }

        const [row] = await db.update(billingCoupons).set({ ...patch, updatedAt: new Date() })
            .where(eq(billingCoupons.id, id)).returning();
        await insertAdminAuditLog({
            adminId, action: 'coupon_update', targetType: 'coupon', targetId: id,
            previousState: { name: existing.name, notes: existing.notes, isActive: existing.isActive },
            newState: { name: row.name, notes: row.notes, isActive: row.isActive },
            ipAddress: ip, userAgent: ua,
        });
        return json(200, { coupon: row });
    }

    // ── Delete ──────────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
        // Deactivate the code first: if the coupon delete then fails, nobody new can use it anyway.
        try {
            await stripe.promotionCodes.update(existing.stripePromotionCodeId, { active: false });
            await stripe.coupons.del(existing.stripeCouponId);
        } catch (err) {
            const e = err as { code?: string };
            // Already gone in Stripe (deleted from the dashboard) — finish the job here.
            if (e?.code !== 'resource_missing') return json(502, { error: stripeMessage(err) });
        }
        await db.update(billingCoupons).set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(billingCoupons.id, id));
        await insertAdminAuditLog({
            adminId, action: 'coupon_delete', targetType: 'coupon', targetId: id,
            previousState: { code: existing.code, isActive: existing.isActive, stripeCouponId: existing.stripeCouponId },
            ipAddress: ip, userAgent: ua,
        });
        return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed.' });
});
