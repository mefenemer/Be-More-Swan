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
//   GET    ?view=stripe         → what is REALLY in Stripe: every coupon + code, who is on a discount,
//                                 and which codes this screen does not know about yet
//   POST   { action: 'import' } → record those codes here (nothing is changed in Stripe)
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
import { billingCoupons, masterPlans, users } from '../../db/schema';
import { annualAmountGbp, annualLookupKey } from '../../src/utils/stripe-price';
import { requirePermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { validateCouponInput, stripeCouponParams, stripePromotionCodeParams, describeCoupon, planStripeImport, type StripeCouponLite, type StripePromoCodeLite } from '../../src/utils/coupon-rules';

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

    // ── What is really in Stripe ────────────────────────────────────────────────────────────
    // Read server-side on purpose: the live key never leaves Netlify, and the admin sees the same
    // account checkout uses.
    async function readStripe() {
        const s = stripe!;
        const coupons: StripeCouponLite[] = [];
        for await (const c of s.coupons.list({ limit: 100 })) {
            coupons.push({
                id: c.id, name: c.name ?? null, percent_off: c.percent_off ?? null, amount_off: c.amount_off ?? null,
                currency: c.currency ?? null, duration: c.duration, duration_in_months: c.duration_in_months ?? null,
                max_redemptions: c.max_redemptions ?? null, redeem_by: c.redeem_by ?? null, valid: c.valid, times_redeemed: c.times_redeemed,
            });
        }
        const codes: StripePromoCodeLite[] = [];
        for await (const p of s.promotionCodes.list({ limit: 100 })) {
            const c = p.promotion?.coupon;
            codes.push({
                id: p.id, code: p.code, active: p.active, couponId: typeof c === 'string' ? c : c?.id ?? null,
                max_redemptions: p.max_redemptions ?? null, expires_at: p.expires_at ?? null, created: p.created, times_redeemed: p.times_redeemed,
            });
        }
        return { coupons, codes };
    }

    if (event.httpMethod === 'GET' && event.queryStringParameters?.view === 'stripe') {
        try {
            const { coupons, codes } = await readStripe();
            // Who is on a discount right now — every subscription carrying one, any status.
            const onDiscount: Array<Record<string, unknown>> = [];
            // Annual subscribers, and whether each is on the CURRENT yearly price on its plan's own
            // product (stripe-price.ts resolveAnnualPriceId). Older annual prices charged the unrounded
            // sum (e.g. £278.40 against an advertised £276) on a separate "(Annual)" product that
            // reconciliation cannot place — those stay as they are until moved.
            const annual: Array<Record<string, unknown>> = [];
            const planRows = await db.select({ tierKey: masterPlans.tierKey, name: masterPlans.name, monthlyPriceGbp: masterPlans.monthlyPriceGbp, stripeProductId: masterPlans.stripeProductId }).from(masterPlans);
            for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer', 'data.discounts'] })) {
                const item = sub.items.data[0];
                if (item?.price?.recurring?.interval === 'year' && ['active', 'trialing', 'past_due'].includes(sub.status)) {
                    const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product?.id ?? null;
                    const plan = planRows.find((p) => p.stripeProductId && p.stripeProductId === productId)
                        ?? planRows.find((p) => p.tierKey && item.price.lookup_key?.startsWith(`${p.tierKey}_annual_gbp_`));
                    const expectedKey = plan?.tierKey ? annualLookupKey(plan.tierKey, annualAmountGbp(plan.monthlyPriceGbp) * 100) : null;
                    const cust = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
                    annual.push({
                        customer: typeof cust === 'string' ? cust : ('email' in cust && cust.email) ? cust.email : cust.id,
                        subscriptionId: sub.id, status: sub.status,
                        plan: plan?.name ?? null,
                        chargedGbp: (item.price.unit_amount ?? 0) / 100,
                        advertisedGbp: plan ? annualAmountGbp(plan.monthlyPriceGbp) : null,
                        onCurrentPrice: !!expectedKey && item.price.lookup_key === expectedKey && productId === plan?.stripeProductId,
                        renews: item.current_period_end ? new Date(item.current_period_end * 1000) : null,
                    });
                }
                for (const d of sub.discounts || []) {
                    if (typeof d === 'string') continue;
                    const cust = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
                    const coupon = d.source?.coupon;
                    const couponId = typeof coupon === 'string' ? coupon : coupon?.id ?? null;
                    const promoId = typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code?.id ?? null;
                    onDiscount.push({
                        customer: typeof cust === 'string' ? cust : ('email' in cust && cust.email) ? cust.email : cust.id,
                        subscriptionId: sub.id, status: sub.status,
                        couponId, code: codes.find((p) => p.id === promoId)?.code ?? null,
                        start: d.start ? new Date(d.start * 1000) : null, end: d.end ? new Date(d.end * 1000) : null,
                    });
                }
            }
            const known = await db.select({ id: billingCoupons.stripePromotionCodeId }).from(billingCoupons).where(eq(billingCoupons.livemode, livemode));
            const plan = planStripeImport(coupons, codes, new Set(known.map((k) => k.id)));
            return json(200, {
                livemode,
                coupons: coupons.map((c) => ({
                    ...c, summary: describeCoupon({ percentOff: c.percent_off, amountOffPence: c.amount_off, duration: c.duration, durationInMonths: c.duration_in_months }),
                    codes: codes.filter((p) => p.couponId === c.id).map((p) => ({ code: p.code, active: p.active, timesRedeemed: p.times_redeemed })),
                })),
                onDiscount,
                annual,
                toImport: plan.rows.map((r) => ({ code: r.code, name: r.name, isActive: r.isActive })),
                noCode: plan.noCode.map((c) => ({ id: c.id, name: c.name })),
            });
        } catch (err) {
            return json(502, { error: stripeMessage(err) });
        }
    }

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

    // ── Import codes that exist in Stripe but not here (changes nothing in Stripe) ─────────────
    if (event.httpMethod === 'POST' && body.action === 'import') {
        let plan;
        try {
            const { coupons, codes } = await readStripe();
            const known = await db.select({ id: billingCoupons.stripePromotionCodeId }).from(billingCoupons).where(eq(billingCoupons.livemode, livemode));
            plan = planStripeImport(coupons, codes, new Set(known.map((k) => k.id)));
        } catch (err) {
            return json(502, { error: stripeMessage(err) });
        }
        const imported: string[] = [];
        for (const r of plan.rows) {
            // A deleted row may hold the same code; the unique index only covers live rows, and a
            // code clash with a LIVE row means two Stripe codes share text — report, never overwrite.
            const [clash] = await db.select({ id: billingCoupons.id }).from(billingCoupons)
                .where(and(notDeleted, sql`upper(${billingCoupons.code}) = ${r.code}`)).limit(1);
            if (clash) continue;
            await db.insert(billingCoupons).values({ ...r, livemode, createdBy: null });
            imported.push(r.code);
        }
        if (imported.length) {
            await insertAdminAuditLog({
                adminId, action: 'coupon_create', targetType: 'coupon',
                newState: { importedFromStripe: imported, livemode }, ipAddress: ip, userAgent: ua,
            });
        }
        return json(200, { imported, skipped: plan.rows.length - imported.length, noCode: plan.noCode.length });
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
