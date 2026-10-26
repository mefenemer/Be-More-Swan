// src/utils/plan-moves.ts
//
// Admin → Revenue → Plan moves: move customers between plans in bulk (owner, 2026-10-19).
//   · every move starts at the customer's next renewal — no mid-month charge or refund;
//   · a price RISE starts at the first renewal at least 30 days away (Terms 6.6);
//   · every customer is emailed (plan_move_scheduled): old plan, new plan, new price, start date and
//     what happens to their coupon, so nobody is misinformed about what they will pay;
//   · coupons carry across (schedulePlanChange keeps the subscription's discounts);
//   · the customer's own choice wins: an upgrade or downgrade they make cancels a pending move.
//
// The Stripe subscription schedule does the switch; plan_moves is our record. The pure rules
// (who can move, the email's coupon sentence) are exported for tests; the rest talks to Stripe/DB.

import type Stripe from 'stripe';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterPlans, organisations, planMoves, plans, users } from '../../db/schema';
import { DISCOUNT_EXPANDS, couponOf, summariseDiscount, type VoucherSummary } from './billing-doc';
import { annualAmountGbp } from './stripe-price';
import { FREE_PLAN_TYPES } from '../config/beta-plan';
import {
    addIntervals, earliestStart, moveDirection, periodsBeforeChange, schedulePlanChange,
    type BillingInterval, type MoveDirection,
} from './plan-change-schedule';
import { sendTemplatedEmail } from './email';
import { takesASeat } from './assistant-capacity';

type Db = ReturnType<typeof getDb>;

/** Most customers one batch may move — every row costs several Stripe calls. */
export const MAX_BATCH = 200;

// ── Pure rules ─────────────────────────────────────────────────────────────────────────────────

export function gbp(pence: number): string {
    const pounds = pence / 100;
    return '£' + pounds.toLocaleString('en-GB', { minimumFractionDigits: Number.isInteger(pounds) ? 0 : 2, maximumFractionDigits: 2 });
}

export function priceLabel(pence: number, interval: BillingInterval): string {
    return `${gbp(pence)} a ${interval === 'year' ? 'year' : 'month'}`;
}

export function longDate(d: Date): string {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

/** The target plan's price on the customer's interval, in pence. */
export function targetAmountPence(monthlyPriceGbp: string | number, interval: BillingInterval): number {
    return interval === 'year' ? annualAmountGbp(monthlyPriceGbp) * 100 : Math.round(Number(monthlyPriceGbp) * 100);
}

export interface MoveFacts {
    planType: string | null;
    planStatus: string | null;
    stripeSubscriptionId: string | null;
    hasScheduledMove: boolean;
    sameTier: boolean;
    samePrice: boolean;
    /** From Stripe; null when not read (e.g. no subscription). */
    stripeStatus?: string | null;
    cancelAtPeriodEnd?: boolean;
    stripeHasSchedule?: boolean;
}

/** Why this customer cannot be moved, in words an admin acts on — or null when they can. */
export function skipReason(f: MoveFacts): string | null {
    if (f.planType && (FREE_PLAN_TYPES as readonly string[]).includes(f.planType)) {
        return 'On a free beta or trial plan — there is no paid subscription to move.';
    }
    if (!f.stripeSubscriptionId) return 'No Stripe subscription on record — change this one with Override Subscription.';
    if (f.hasScheduledMove) return 'A plan move is already scheduled — cancel it first.';
    if (f.planStatus === 'downgrading') return 'They have already scheduled their own downgrade.';
    if (f.planStatus === 'cancelling' || f.cancelAtPeriodEnd) return 'Their subscription is set to cancel at the end of the period.';
    if (f.planStatus === 'past_due' || f.stripeStatus === 'past_due' || f.stripeStatus === 'unpaid') return 'A payment is overdue.';
    if (f.planStatus !== 'active') return `Plan status is "${f.planStatus ?? 'unknown'}", not active.`;
    if (f.stripeStatus && !['active', 'trialing'].includes(f.stripeStatus)) return `Stripe says the subscription is ${f.stripeStatus}.`;
    if (f.stripeHasSchedule) return 'Stripe already has a scheduled change on this subscription.';
    if (f.sameTier && f.samePrice) return 'Already on that plan at its current price.';
    return null;
}

/**
 * The email's coupon sentence (and the preview's), so a customer on a discount is told exactly what
 * they will pay — never the list price when a coupon will still apply, never a discount that ends.
 *   discount   — the subscription's discount, summarised at the NEW price (summariseDiscount), or null
 *   appliesToNewPlan — false when the coupon is limited to products that exclude the new plan
 */
export function discountLine(args: {
    discount: VoucherSummary | null;
    appliesToNewPlan: boolean;
    effectiveAt: Date;
    interval: BillingInterval;
    newPlanName: string;
}): string {
    const d = args.discount;
    if (!d) return 'You have no discount on your subscription, so this is the price you will pay.';
    const name = d.codes[0] ?? d.name ?? 'your';
    if (!args.appliesToNewPlan) {
        return `Your ${name} discount does not apply to ${args.newPlanName}, so it stops when the new plan starts and you will pay the full price.`;
    }
    if (d.endsAt && new Date(d.endsAt).getTime() <= args.effectiveAt.getTime()) {
        return `Your ${name} discount (${d.label}) ends on ${longDate(new Date(d.endsAt))}, before the new plan starts, so you will pay the full price.`;
    }
    const until = d.endsAt ? ` until ${longDate(new Date(d.endsAt))}` : '';
    const pay = Math.round(d.netAmount * 100);
    return `Your ${name} discount (${d.label}) carries on${until}, so you will pay ${priceLabel(pay, args.interval)} while it lasts.`;
}

// ── Preview ────────────────────────────────────────────────────────────────────────────────────

export interface MovePreviewRow {
    organisationId: number;
    workspace: string;
    ownerEmail: string | null;
    planId: number;
    fromPlanName: string | null;
    fromAmountPence: number | null;
    interval: BillingInterval;
    toAmountPence: number;
    direction: MoveDirection;
    /** Estimate from the period end; the run uses Stripe's own date. */
    effectiveAt: string | null;
    discountLine: string | null;
    assistantsToPause: number;
    skipReason: string | null;
}

interface Candidate {
    planId: number; organisationId: number; userId: number | null; planType: string | null; status: string | null;
    masterPlanId: number | null; stripeSubscriptionId: string | null; workspace: string; fromPlanName: string | null;
}

async function loadCandidates(db: Db, sel: { fromMasterPlanId?: number | null; organisationIds?: number[] | null }): Promise<Candidate[]> {
    const conds = [inArray(plans.status, ['active', 'downgrading', 'cancelling', 'past_due'])];
    if (sel.fromMasterPlanId) conds.push(eq(plans.masterPlanId, sel.fromMasterPlanId));
    if (sel.organisationIds?.length) conds.push(inArray(plans.organisationId, sel.organisationIds));
    if (!sel.fromMasterPlanId && !sel.organisationIds?.length) return [];
    const rows = await db
        .select({
            planId: plans.id, organisationId: plans.organisationId, userId: plans.userId, planType: plans.planType,
            status: plans.status, masterPlanId: plans.masterPlanId, stripeSubscriptionId: plans.stripeSubscriptionId,
            workspace: organisations.name, fromPlanName: masterPlans.name,
        })
        .from(plans)
        .leftJoin(organisations, eq(organisations.id, plans.organisationId))
        .leftJoin(masterPlans, eq(masterPlans.id, plans.masterPlanId))
        .where(and(...conds))
        .limit(MAX_BATCH + 1);
    return rows.filter((r) => r.organisationId != null) as Candidate[];
}

type TargetPlan = typeof masterPlans.$inferSelect;

async function previewOne(db: Db, stripe: Stripe, c: Candidate, target: TargetPlan, now: Date, scheduledOrgs: Set<number>): Promise<MovePreviewRow> {
    const [owner] = c.userId
        ? await db.select({ email: users.email }).from(users).where(eq(users.id, c.userId)).limit(1)
        : [];
    const row: MovePreviewRow = {
        organisationId: c.organisationId, workspace: c.workspace, ownerEmail: owner?.email ?? null, planId: c.planId,
        fromPlanName: c.fromPlanName, fromAmountPence: null, interval: 'month',
        toAmountPence: targetAmountPence(target.monthlyPriceGbp, 'month'), direction: 'same',
        effectiveAt: null, discountLine: null, assistantsToPause: 0, skipReason: null,
    };
    const facts: MoveFacts = {
        planType: c.planType, planStatus: c.status, stripeSubscriptionId: c.stripeSubscriptionId,
        hasScheduledMove: scheduledOrgs.has(c.organisationId), sameTier: c.masterPlanId === target.id, samePrice: false,
    };

    let sub: Stripe.Subscription | null = null;
    if (c.stripeSubscriptionId && !skipReason({ ...facts, samePrice: false, sameTier: false })) {
        try {
            sub = await stripe.subscriptions.retrieve(c.stripeSubscriptionId, {
                expand: ['items', ...DISCOUNT_EXPANDS, 'discounts.source.coupon.applies_to'],
            });
        } catch (err) {
            row.skipReason = `Stripe could not find the subscription (${String((err as Error).message).slice(0, 80)}).`;
            return row;
        }
    }
    if (sub) {
        const item = sub.items.data[0];
        row.interval = item?.price?.recurring?.interval === 'year' ? 'year' : 'month';
        row.fromAmountPence = item?.price?.unit_amount ?? null;
        row.toAmountPence = targetAmountPence(target.monthlyPriceGbp, row.interval);
        row.direction = moveDirection(row.fromAmountPence, row.toAmountPence);
        Object.assign(facts, {
            samePrice: row.fromAmountPence === row.toAmountPence,
            stripeStatus: sub.status, cancelAtPeriodEnd: !!sub.cancel_at_period_end,
            stripeHasSchedule: typeof sub.schedule === 'string' || !!sub.schedule,
        });
        const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;
        if (periodEnd) {
            const k = periodsBeforeChange(periodEnd, row.interval, earliestStart(row.direction, now));
            const effective = addIntervals(periodEnd, row.interval, k - 1);
            row.effectiveAt = effective.toISOString();
            const discounts = (sub.discounts || []).filter((d) => typeof d === 'object');
            const summary = summariseDiscount(discounts as any[], row.toAmountPence, 'gbp');
            const products = discounts.map((d) => couponOf(d)?.applies_to?.products).find((p) => Array.isArray(p)) as string[] | undefined;
            row.discountLine = discountLine({
                discount: summary, effectiveAt: effective, interval: row.interval, newPlanName: target.name,
                appliesToNewPlan: !products || !target.stripeProductId || products.includes(target.stripeProductId),
            });
        }
    }
    row.skipReason = skipReason(facts);

    // Assistants over the new plan's limit pause when it starts (stripe-webhook.ts, oldest first).
    if (!row.skipReason && target.assistantLimit != null && c.userId) {
        const active = await db.select({ id: aiAssistants.id }).from(aiAssistants)
            .where(and(eq(aiAssistants.userId, c.userId), eq(aiAssistants.isActive, true), isNull(aiAssistants.archivedAt), takesASeat()));
        const [org] = await db.select({ bonus: organisations.bonusAssistants }).from(organisations).where(eq(organisations.id, c.organisationId)).limit(1);
        row.assistantsToPause = Math.max(0, active.length - (target.assistantLimit + (org?.bonus ?? 0)));
    }
    return row;
}

export async function previewMoves(db: Db, stripe: Stripe, sel: {
    fromMasterPlanId?: number | null; organisationIds?: number[] | null; toMasterPlanId: number; now?: Date;
}): Promise<{ target: TargetPlan; rows: MovePreviewRow[]; truncated: boolean }> {
    const [target] = await db.select().from(masterPlans).where(eq(masterPlans.id, sel.toMasterPlanId)).limit(1);
    if (!target) throw new Error('That plan does not exist.');
    if (!target.isActive || target.isContactSales || ['trial', 'beta'].includes(target.tierKey)) {
        throw new Error(`${target.name} is not a plan customers can be moved onto (inactive, contact-sales, trial or beta).`);
    }
    const candidates = await loadCandidates(db, sel);
    const truncated = candidates.length > MAX_BATCH;
    const scheduled = await db.select({ organisationId: planMoves.organisationId }).from(planMoves).where(eq(planMoves.status, 'scheduled'));
    const scheduledOrgs = new Set(scheduled.map((s) => s.organisationId));
    const now = sel.now ?? new Date();
    const rows: MovePreviewRow[] = [];
    for (const c of candidates.slice(0, MAX_BATCH)) rows.push(await previewOne(db, stripe, c, target, now, scheduledOrgs));
    return { target, rows, truncated };
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

export interface RunResult { scheduled: number; skipped: Array<{ organisationId: number; reason: string }>; failed: Array<{ organisationId: number; error: string }>; batchId: string }

export async function runMoves(db: Db, stripe: Stripe, args: {
    fromMasterPlanId?: number | null; organisationIds: number[]; toMasterPlanId: number;
    adminId: number; livemode: boolean; baseUrl: string; batchId: string;
}): Promise<RunResult> {
    // Re-check everything at run time: the preview may be minutes old.
    const { target, rows } = await previewMoves(db, stripe, {
        fromMasterPlanId: args.fromMasterPlanId, organisationIds: args.organisationIds, toMasterPlanId: args.toMasterPlanId,
    });
    const chosen = new Set(args.organisationIds);
    const result: RunResult = { scheduled: 0, skipped: [], failed: [], batchId: args.batchId };

    for (const r of rows) {
        if (!chosen.has(r.organisationId)) continue;
        if (r.skipReason) { result.skipped.push({ organisationId: r.organisationId, reason: r.skipReason }); continue; }
        const [cand] = await db.select({ sub: plans.stripeSubscriptionId, masterPlanId: plans.masterPlanId, userId: plans.userId })
            .from(plans).where(eq(plans.id, r.planId)).limit(1);
        if (!cand?.sub) { result.skipped.push({ organisationId: r.organisationId, reason: 'No Stripe subscription on record.' }); continue; }

        // The row first — its id travels in the new phase's metadata so the webhook can finish it.
        // The partial unique index refuses a second scheduled move for the same workspace.
        let moveId: number;
        try {
            const [ins] = await db.insert(planMoves).values({
                batchId: args.batchId, organisationId: r.organisationId, planId: r.planId,
                fromMasterPlanId: cand.masterPlanId, toMasterPlanId: target.id,
                fromAmountPence: r.fromAmountPence, toAmountPence: r.toAmountPence, billingInterval: r.interval,
                direction: r.direction, effectiveAt: r.effectiveAt ? new Date(r.effectiveAt) : new Date(),
                stripeSubscriptionId: cand.sub, status: 'scheduled', discountLine: r.discountLine,
                livemode: args.livemode, createdBy: args.adminId,
            }).returning({ id: planMoves.id });
            moveId = ins.id;
        } catch {
            result.skipped.push({ organisationId: r.organisationId, reason: 'A plan move is already scheduled.' });
            continue;
        }

        try {
            const change = await schedulePlanChange(stripe, {
                subscriptionId: cand.sub,
                target,
                notBefore: earliestStart(r.direction, new Date()),
                phaseMetadata: { masterPlanId: String(target.id), tier: target.tierKey, planMoveId: String(moveId) },
                scheduleMetadata: { planMoveId: String(moveId), planMoveBatch: args.batchId },
            });
            // Stripe's own start date wins over the preview's estimate.
            await db.update(planMoves)
                .set({ stripeScheduleId: change.scheduleId, effectiveAt: change.effectiveAt, updatedAt: new Date() })
                .where(eq(planMoves.id, moveId));
            result.scheduled++;

            const sent = r.ownerEmail ? await sendTemplatedEmail({
                triggerKey: 'plan_move_scheduled',
                to: r.ownerEmail,
                vars: await emailVars(db, cand.userId, r, target, change.effectiveAt, args.baseUrl),
            }).catch((err) => { console.error('[plan-moves] email failed', r.organisationId, err); return null; }) : null;
            if (sent) await db.update(planMoves).set({ emailSentAt: new Date() }).where(eq(planMoves.id, moveId));
        } catch (err) {
            const msg = String((err as Error)?.message ?? err).slice(0, 300);
            await db.update(planMoves).set({ status: 'failed', error: msg, updatedAt: new Date() }).where(eq(planMoves.id, moveId));
            result.failed.push({ organisationId: r.organisationId, error: msg });
        }
    }
    return result;
}

async function emailVars(db: Db, userId: number | null, r: MovePreviewRow, target: TargetPlan, effectiveAt: Date, baseUrl: string) {
    const [u] = userId ? await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1) : [];
    const diff = r.fromAmountPence != null ? r.toAmountPence - r.fromAmountPence : 0;
    const per = r.interval === 'year' ? 'a year' : 'a month';
    const priceChange = r.fromAmountPence == null || diff === 0
        ? 'Your price stays the same.'
        : diff < 0
            ? `That is ${gbp(-diff)} ${per} less than you pay now.`
            : `That is ${gbp(diff)} ${per} more than you pay now. We are telling you at least 30 days before it starts, as our Terms promise.`;
    const assistants = r.assistantsToPause > 0
        ? `${target.name} includes fewer assistants than you have running, so ${r.assistantsToPause} of them will be paused when it starts, beginning with the ones you set up first. Nothing is deleted.`
        : '';
    return {
        user: { first_name: u?.firstName ?? '' },
        workspace: { name: r.workspace },
        plan_move: {
            from_plan: r.fromPlanName ?? 'your current plan',
            to_plan: target.name,
            new_price: priceLabel(r.toAmountPence, r.interval),
            starts_on: longDate(effectiveAt),
            price_change_line: priceChange,
            discount_line: r.discountLine ?? '',
            assistants_line: assistants,
        },
        link: { action_url: `${baseUrl}/billing.html` },
    };
}

// ── Cancel / finish ────────────────────────────────────────────────────────────────────────────

/**
 * Cancel scheduled moves (by id, or every one for a workspace). Releases each Stripe schedule.
 * `notify`: email the customer that the change is off — for an admin cancel of a move they were
 * already told about; never for a customer's own change (they made it, and know).
 */
export async function cancelMoves(db: Db, stripe: Stripe | null, where: { ids?: number[]; organisationId?: number }, by: number | null, reason: string, notify = false): Promise<number> {
    const conds = [eq(planMoves.status, 'scheduled')];
    if (where.ids?.length) conds.push(inArray(planMoves.id, where.ids));
    if (where.organisationId) conds.push(eq(planMoves.organisationId, where.organisationId));
    if (!where.ids?.length && !where.organisationId) return 0;
    const moves = await db.select().from(planMoves).where(and(...conds));
    for (const m of moves) {
        if (stripe && m.stripeScheduleId) {
            await stripe.subscriptionSchedules.release(m.stripeScheduleId).catch((err) => {
                console.warn('[plan-moves] schedule release failed (may already be released):', (err as Error)?.message);
            });
        }
        await db.update(planMoves)
            .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: by, error: reason, updatedAt: new Date() })
            .where(eq(planMoves.id, m.id));
        if (notify && m.emailSentAt) await sendCancelledEmail(db, m).catch((err) => console.error('[plan-moves] cancel email failed', m.id, err));
    }
    return moves.length;
}

async function sendCancelledEmail(db: Db, m: typeof planMoves.$inferSelect): Promise<void> {
    const [row] = await db.select({ email: users.email, firstName: users.firstName, workspace: organisations.name })
        .from(plans)
        .leftJoin(users, eq(users.id, plans.userId))
        .leftJoin(organisations, eq(organisations.id, plans.organisationId))
        .where(eq(plans.organisationId, m.organisationId))
        .limit(1);
    if (!row?.email) return;
    const [from] = m.fromMasterPlanId ? await db.select({ name: masterPlans.name }).from(masterPlans).where(eq(masterPlans.id, m.fromMasterPlanId)).limit(1) : [];
    const [to] = await db.select({ name: masterPlans.name }).from(masterPlans).where(eq(masterPlans.id, m.toMasterPlanId)).limit(1);
    await sendTemplatedEmail({
        triggerKey: 'plan_move_cancelled',
        to: row.email,
        vars: {
            user: { first_name: row.firstName ?? '' },
            workspace: { name: row.workspace ?? '' },
            plan_move: {
                from_plan: from?.name ?? 'your current plan',
                to_plan: to?.name ?? 'the new plan',
                starts_on: longDate(m.effectiveAt),
                current_price: m.fromAmountPence != null ? priceLabel(m.fromAmountPence, m.billingInterval as BillingInterval) : '',
            },
        },
    });
}

/** For billing-upgrade / billing-downgrade: the customer's own change wins over a pending move. */
export async function cancelMovesForCustomerChange(db: Db, organisationId: number): Promise<void> {
    try {
        await cancelMoves(db, null, { organisationId }, null, 'Cancelled because the customer changed their own plan.');
    } catch (err) {
        // The table may not exist yet on an environment that has not run db/z-plan-moves.sql.
        console.warn('[plan-moves] could not cancel pending moves (non-blocking):', (err as Error)?.message);
    }
}

/**
 * stripe-webhook.ts, customer.subscription.updated: the new phase of a plan move has started.
 * Switches the plans row and marks the move applied. Idempotent — a later update event carrying the
 * same planMoveId finds the move already applied and does nothing. Returns the new plan name, or null.
 */
export async function finishPlanMove(db: Db, sub: { id: string; metadata?: Record<string, string> | null }): Promise<string | null> {
    const moveId = Number(sub.metadata?.planMoveId);
    if (!Number.isInteger(moveId) || moveId <= 0) return null;
    const [move] = await db.select().from(planMoves).where(eq(planMoves.id, moveId)).limit(1);
    if (!move || move.status !== 'scheduled' || move.stripeSubscriptionId !== sub.id) return null;
    const [target] = await db.select({ id: masterPlans.id, name: masterPlans.name }).from(masterPlans).where(eq(masterPlans.id, move.toMasterPlanId)).limit(1);
    if (!target) return null;
    await db.update(plans)
        // A new tier is a fresh binding: drop any frozen "new subscribers only" snapshot, as a downgrade does.
        .set({ masterPlanId: target.id, planName: target.name, status: 'active', featureOverrides: null, updatedAt: new Date() })
        .where(eq(plans.stripeSubscriptionId, sub.id));
    await db.update(planMoves).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() }).where(eq(planMoves.id, move.id));
    return target.name;
}

export async function listMoves(db: Db) {
    return db.select({
        id: planMoves.id, batchId: planMoves.batchId, organisationId: planMoves.organisationId, workspace: organisations.name,
        toMasterPlanId: planMoves.toMasterPlanId, fromMasterPlanId: planMoves.fromMasterPlanId,
        fromAmountPence: planMoves.fromAmountPence, toAmountPence: planMoves.toAmountPence, billingInterval: planMoves.billingInterval,
        direction: planMoves.direction, effectiveAt: planMoves.effectiveAt, status: planMoves.status, error: planMoves.error,
        emailSentAt: planMoves.emailSentAt, createdAt: planMoves.createdAt, appliedAt: planMoves.appliedAt, cancelledAt: planMoves.cancelledAt,
        discountLine: planMoves.discountLine,
    })
        .from(planMoves)
        .leftJoin(organisations, eq(organisations.id, planMoves.organisationId))
        .orderBy(planMoves.createdAt);
}
