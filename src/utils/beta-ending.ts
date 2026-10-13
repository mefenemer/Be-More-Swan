// src/utils/beta-ending.ts
// Ending the beta, one workspace at a time. Decided by the owner 2026-10-13:
//   • the end date is set PER WORKSPACE (that is the notice period) in Admin → Customers → Beta testers;
//   • only an admin sends the notice and the reminder — nothing emails a tester by itself;
//   • the offer is the founding-member coupon (30% off for 12 months, made on the Coupons screen),
//     on the SMALLEST plan that covers what the workspace actually used, which the admin can change;
//   • on the end date, if they have not subscribed: the beta plan expires, their assistants pause and
//     anything scheduled is held — nothing is deleted. The plan picker the product already shows to a
//     workspace with no plan (check-capacity `noPlan`) is how they carry on.
//   • the moment they subscribe, their assistants come back and whatever fell due while they were
//     paused returns to Review rather than all publishing at once.
//
// A workspace is NEVER ended unless its notice was sent (endDueBetas checks noticeSentAt).
//
// Table: beta_endings (db/z-beta-endings.sql). Pure helpers first; the DB functions never throw for a
// missing table — every caller in a publish path must keep publishing if this migration is absent.

import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, betaEndings, billingCoupons, blogPosts, masterPlans, newsletterIssues, organisations, plans, scheduledPosts, usageCounters, users,
} from '../../db/schema';
import { BETA_PLAN_TYPE } from './beta-testers';

type Db = ReturnType<typeof getDb>;

/** provisioningStatus stamped on an assistant paused because its workspace's beta ended. Only rows
 *  carrying it are switched back on — an assistant the user paused themselves is left alone. */
export const BETA_ENDED_PAUSE = 'paused_beta_ended';

/** The tiers a beta workspace can be offered, cheapest first. Not trial/beta/enterprise. */
export const OFFERABLE_TIERS = ['saver', 'buster', 'employee'] as const;

export interface TierLimits {
    tierKey: string; name: string; monthlyPriceGbp: number;
    assistantLimit: number | null; monthlyTaskLimit: number | null;
}
export interface BetaUsage { assistants: number; peakMonthlyTasks: number }

/**
 * The smallest plan that covers what the workspace actually used during beta. null limits mean
 * unlimited. Nothing fits (more than the top plan allows) → the top plan, flagged so the admin sees it.
 */
export function suggestTier(usage: BetaUsage, tiers: TierLimits[]): { tierKey: string; fits: boolean } | null {
    const ordered = OFFERABLE_TIERS.map((k) => tiers.find((t) => t.tierKey === k)).filter((t): t is TierLimits => !!t);
    if (!ordered.length) return null;
    const fits = (t: TierLimits) =>
        (t.assistantLimit == null || usage.assistants <= t.assistantLimit) &&
        (t.monthlyTaskLimit == null || usage.peakMonthlyTasks <= t.monthlyTaskLimit);
    const hit = ordered.find(fits);
    return hit ? { tierKey: hit.tierKey, fits: true } : { tierKey: ordered[ordered.length - 1].tierKey, fits: false };
}

/** "£20.30" from £29 and 30% off; amount-off coupons take pence. Never below £0. */
export function discountedPrice(priceGbp: number, coupon: { percentOff: number | null; amountOffPence: number | null } | null): number {
    if (!coupon) return priceGbp;
    const off = coupon.percentOff != null ? priceGbp * (coupon.percentOff / 100) : (coupon.amountOffPence ?? 0) / 100;
    return Math.max(0, Math.round((priceGbp - off) * 100) / 100);
}

export const gbp = (n: number) => `£${n.toFixed(2).replace(/\.00$/, '')}`;

/** Checkout with the offered plan selected and the founding code already applied. */
export function offerCheckoutUrl(baseUrl: string, tierKey: string, couponCode: string | null): string {
    const u = new URL('/checkout.html', baseUrl);
    u.searchParams.set('tier', tierKey);
    if (couponCode) u.searchParams.set('promo', couponCode);
    return u.toString();
}

/** "Friday 13 November 2026" — how the end date reads in an email. */
export function longDate(isoDate: string): string {
    // en-GB puts a comma after the weekday ("Friday, 13 November 2026"); a sentence reads better without.
    return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).replace(',', '');
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────

export interface BetaWorkspace {
    organisationId: number; organisationName: string;
    ownerUserId: number | null; ownerEmail: string | null; ownerFirstName: string | null;
    betaSince: Date | null; planStatus: string | null; hasPaidPlan: boolean;
    usage: BetaUsage;
    ending: typeof betaEndings.$inferSelect | null;
}

/** Every workspace that is, or was, on the beta plan — with its usage and its ending row, if any. */
export async function loadBetaWorkspaces(db: Db): Promise<BetaWorkspace[]> {
    const betaPlans = await db.select({
        organisationId: plans.organisationId, userId: plans.userId, status: plans.status, startedAt: plans.startedAt,
    }).from(plans).where(eq(plans.planType, BETA_PLAN_TYPE)).orderBy(desc(plans.startedAt));
    const byOrg = new Map<number, typeof betaPlans[number]>();
    for (const p of betaPlans) if (!byOrg.has(p.organisationId)) byOrg.set(p.organisationId, p);
    const orgIds = [...byOrg.keys()];
    if (!orgIds.length) return [];

    const [orgs, owners, assistantCounts, peaks, endings, paid] = await Promise.all([
        db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, orgIds)),
        db.select({ id: users.id, email: users.email, firstName: users.firstName }).from(users)
            .where(inArray(users.id, betaPlans.map((p) => p.userId).filter((x): x is number => x != null))),
        db.select({ orgId: aiAssistants.organisationId, n: sql<number>`count(*)::int` }).from(aiAssistants)
            .where(and(inArray(aiAssistants.organisationId, orgIds), ne(aiAssistants.lifecycleStatus, 'archived')))
            .groupBy(aiAssistants.organisationId),
        db.select({ orgId: usageCounters.organisationId, peak: sql<number>`max(${usageCounters.taskCount})::int` }).from(usageCounters)
            .where(inArray(usageCounters.organisationId, orgIds)).groupBy(usageCounters.organisationId),
        db.select().from(betaEndings).where(inArray(betaEndings.organisationId, orgIds)),
        db.select({ orgId: plans.organisationId }).from(plans)
            .where(and(inArray(plans.organisationId, orgIds), ne(plans.planType, BETA_PLAN_TYPE), inArray(plans.status, ['active', 'past_due', 'cancelling']))),
    ]);

    return orgIds.map((orgId) => {
        const p = byOrg.get(orgId)!;
        const owner = owners.find((u) => u.id === p.userId);
        return {
            organisationId: orgId,
            organisationName: orgs.find((o) => o.id === orgId)?.name ?? `Workspace #${orgId}`,
            ownerUserId: p.userId ?? null, ownerEmail: owner?.email ?? null, ownerFirstName: owner?.firstName ?? null,
            betaSince: p.startedAt ?? null, planStatus: p.status ?? null,
            hasPaidPlan: paid.some((x) => x.orgId === orgId),
            usage: {
                assistants: assistantCounts.find((a) => a.orgId === orgId)?.n ?? 0,
                peakMonthlyTasks: peaks.find((a) => a.orgId === orgId)?.peak ?? 0,
            },
            ending: endings.find((e) => e.organisationId === orgId) ?? null,
        };
    });
}

export async function loadOfferableTiers(db: Db): Promise<TierLimits[]> {
    const rows = await db.select({
        tierKey: masterPlans.tierKey, name: masterPlans.name, monthlyPriceGbp: masterPlans.monthlyPriceGbp,
        assistantLimit: masterPlans.assistantLimit, monthlyTaskLimit: masterPlans.monthlyTaskLimit,
    }).from(masterPlans).where(inArray(masterPlans.tierKey, [...OFFERABLE_TIERS]));
    return rows.map((r) => ({ ...r, tierKey: r.tierKey!, monthlyPriceGbp: Number(r.monthlyPriceGbp) }));
}

/**
 * Workspaces whose publishing is held: beta ended, not converted. Never throws — a publisher that
 * cannot read this keeps publishing (a missing migration must not stop every customer's posts).
 */
export async function heldOrganisationIds(db: Db): Promise<Set<number>> {
    try {
        const rows = await db.select({ id: betaEndings.organisationId }).from(betaEndings)
            .where(and(isNotNull(betaEndings.endedAt), isNull(betaEndings.convertedAt)));
        return new Set(rows.map((r) => r.id));
    } catch (err) {
        console.error('[beta-ending] could not read held workspaces — publishing is NOT held', err);
        return new Set();
    }
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────

/**
 * End one workspace's beta: expire the beta plan, pause its running assistants. Idempotent. Skips a
 * workspace that already has a paid plan (it converted before the date) and marks it converted.
 */
export async function endBetaFor(db: Db, organisationId: number, now = new Date()): Promise<'ended' | 'converted' | 'skipped'> {
    const [ending] = await db.select().from(betaEndings).where(eq(betaEndings.organisationId, organisationId)).limit(1);
    if (!ending || ending.endedAt || !ending.noticeSentAt) return 'skipped';

    const [paid] = await db.select({ id: plans.id }).from(plans).where(and(
        eq(plans.organisationId, organisationId), ne(plans.planType, BETA_PLAN_TYPE), inArray(plans.status, ['active', 'past_due', 'cancelling']),
    )).limit(1);
    if (paid) {
        await db.update(betaEndings).set({ convertedAt: now, updatedAt: now }).where(eq(betaEndings.id, ending.id));
        return 'converted';
    }

    await db.update(plans).set({ status: 'expired', expiresAt: now, updatedAt: now })
        .where(and(eq(plans.organisationId, organisationId), eq(plans.planType, BETA_PLAN_TYPE), eq(plans.status, 'active')));
    // Only assistants that are RUNNING are paused, and stamped so only they come back.
    await db.update(aiAssistants).set({ isActive: false, provisioningStatus: BETA_ENDED_PAUSE, updatedAt: now })
        .where(and(eq(aiAssistants.organisationId, organisationId), eq(aiAssistants.isActive, true)));
    await db.update(betaEndings).set({ endedAt: now, updatedAt: now }).where(eq(betaEndings.id, ending.id));
    return 'ended';
}

/**
 * Called wherever a paid plan row is written (create-subscription £0 path, stripe-webhook's two
 * new-subscription paths) and by the daily sweep as a backstop. Switches the paused assistants back
 * on and sends anything that fell due while paused back to Review. Never throws.
 */
export async function resumeAfterBetaConversion(db: Db, organisationId: number, now = new Date()): Promise<boolean> {
    try {
        const [ending] = await db.select().from(betaEndings).where(eq(betaEndings.organisationId, organisationId)).limit(1);
        if (!ending || !ending.endedAt || ending.convertedAt) return false;

        await db.update(aiAssistants).set({ isActive: true, provisioningStatus: 'complete', updatedAt: now })
            .where(and(eq(aiAssistants.organisationId, organisationId), eq(aiAssistants.provisioningStatus, BETA_ENDED_PAUSE)));
        // Due while paused → Review, so a month of held posts does not all go out in one tick.
        await db.update(scheduledPosts).set({ status: 'pending_approval', updatedAt: now })
            .where(and(eq(scheduledPosts.organisationId, organisationId), eq(scheduledPosts.status, 'scheduled'), lte(scheduledPosts.publishDate, now)));
        await db.update(blogPosts).set({ status: 'draft', updatedAt: now })
            .where(and(eq(blogPosts.organisationId, organisationId), eq(blogPosts.status, 'scheduled'), lte(blogPosts.publishDate, now)));
        await db.update(newsletterIssues).set({ status: 'approved', scheduledFor: null, updatedAt: now })
            .where(and(eq(newsletterIssues.organisationId, organisationId), eq(newsletterIssues.status, 'scheduled'), lte(newsletterIssues.scheduledFor, now)));
        await db.update(betaEndings).set({ convertedAt: now, updatedAt: now }).where(eq(betaEndings.id, ending.id));
        return true;
    } catch (err) {
        console.error('[beta-ending] resume after conversion failed (non-fatal)', organisationId, err);
        return false;
    }
}

// ── The offer, in words ───────────────────────────────────────────────────────────────────────────

export interface OfferCoupon { code: string; percentOff: number | null; amountOffPence: number | null; duration: string; durationInMonths: number | null }

/**
 * The one sentence every beta email carries. Built here, not in the template, because it depends on
 * whether a coupon is attached and how long it lasts — and a template cannot branch.
 */
export function offerLine(planName: string, fullPriceGbp: number, coupon: OfferCoupon | null): string {
    if (!coupon) return `You can carry on with ${planName} for ${gbp(fullPriceGbp)} a month — the link below takes you straight there.`;
    const price = gbp(discountedPrice(fullPriceGbp, coupon));
    const span = coupon.duration === 'forever' ? 'for as long as you stay subscribed'
        : coupon.duration === 'once' ? 'for your first month'
        : `for your first ${coupon.durationInMonths} month${coupon.durationInMonths === 1 ? '' : 's'}`;
    const then = coupon.duration === 'forever' ? '' : ` (then ${gbp(fullPriceGbp)})`;
    return `As a founding member, you can carry on with ${planName} for ${price} a month ${span}${then} — code ${coupon.code} is already applied at the link below.`;
}

// ── What one workspace's email says ───────────────────────────────────────────────────────────────

export interface BetaOffer {
    tierKey: string; planName: string; fullPriceGbp: number; offerPriceGbp: number;
    coupon: OfferCoupon | null; couponProblem: string | null; checkoutUrl: string; fits: boolean;
    vars: Record<string, Record<string, string>>;
}

/**
 * The plan, price, coupon and merge variables for one workspace. The admin's choice of plan wins over
 * the suggestion. A coupon code that no longer exists or is switched off is DROPPED from the offer and
 * reported (couponProblem) — an email promising a code that checkout will reject is worse than none.
 */
export async function betaOfferFor(db: Db, ws: BetaWorkspace, tiers: TierLimits[], baseUrl: string): Promise<BetaOffer | null> {
    const suggestion = suggestTier(ws.usage, tiers);
    const tierKey = ws.ending?.offeredTierKey || suggestion?.tierKey;
    const tier = tiers.find((t) => t.tierKey === tierKey);
    if (!tier) return null;

    let coupon: OfferCoupon | null = null;
    let couponProblem: string | null = null;
    const code = ws.ending?.couponCode?.trim().toUpperCase();
    if (code) {
        const [c] = await db.select().from(billingCoupons)
            .where(and(sql`upper(${billingCoupons.code}) = ${code}`, isNull(billingCoupons.deletedAt))).limit(1);
        if (!c) couponProblem = `Coupon ${code} is not on the Coupons screen, so it was left out of the offer.`;
        else if (!c.isActive) couponProblem = `Coupon ${code} is switched off, so it was left out of the offer.`;
        else if (c.redeemBy && c.redeemBy.getTime() < Date.now()) couponProblem = `Coupon ${code} has expired, so it was left out of the offer.`;
        else coupon = { code: c.code, percentOff: c.percentOff != null ? Number(c.percentOff) : null, amountOffPence: c.amountOffPence, duration: c.duration, durationInMonths: c.durationInMonths };
    }

    const checkoutUrl = offerCheckoutUrl(baseUrl, tier.tierKey, coupon?.code ?? null);
    const endsOn = ws.ending?.endsOn ? longDate(ws.ending.endsOn) : '';
    return {
        tierKey: tier.tierKey, planName: tier.name, fullPriceGbp: tier.monthlyPriceGbp,
        offerPriceGbp: discountedPrice(tier.monthlyPriceGbp, coupon), coupon, couponProblem, checkoutUrl,
        fits: ws.ending?.offeredTierKey ? true : (suggestion?.fits ?? true),
        vars: {
            user: { first_name: ws.ownerFirstName ?? '' },
            workspace: { name: ws.organisationName },
            beta: { ends_on: endsOn, plan_name: tier.name, offer_line: offerLine(tier.name, tier.monthlyPriceGbp, coupon) },
            link: { action_url: checkoutUrl },
        },
    };
}

// ── A beta workspace taking a paid plan ───────────────────────────────────────────────────────────
// The beta plan is an ACTIVE plan row, and plans_one_active_per_org_unique allows one per workspace.
// Before this, every paid path treated it as "already subscribed": create-subscription's double-charge
// guard sent a beta tester who clicked "Keep my assistants running" back to the dashboard without
// charging them, and the webhook's insert collided and backfilled Stripe ids onto the BETA row.

/** Is this active plan the free beta one — i.e. one a paid plan replaces rather than duplicates? */
export const isBetaPlanRow = (p: { planType?: string | null } | null | undefined) => p?.planType === BETA_PLAN_TYPE;

/**
 * Call immediately BEFORE inserting a paid plan row. Retires the active beta plan so the unique
 * index lets the paid one in. A no-op for a workspace that was never on the beta.
 */
export async function retireBetaPlanBeforePaid(db: Db, organisationId: number, now = new Date()): Promise<void> {
    await db.update(plans).set({ status: 'expired', expiresAt: now, updatedAt: now })
        .where(and(eq(plans.organisationId, organisationId), eq(plans.planType, BETA_PLAN_TYPE), eq(plans.status, 'active')));
}

/**
 * Call AFTER a paid plan row is written. Marks the workspace converted (so end-beta-sweep never ends
 * it) and, if its beta had already ended, switches its assistants back on. Never throws.
 */
export async function afterPaidPlanStarted(db: Db, organisationId: number, now = new Date()): Promise<void> {
    try {
        if (await resumeAfterBetaConversion(db, organisationId, now)) return;
        await db.update(betaEndings).set({ convertedAt: now, updatedAt: now })
            .where(and(eq(betaEndings.organisationId, organisationId), isNull(betaEndings.convertedAt)));
    } catch (err) {
        console.error('[beta-ending] afterPaidPlanStarted failed (non-fatal)', organisationId, err);
    }
}

/**
 * The SQL fragment the raw-SQL publishers append to their due-post query. Filtering in the query,
 * not after it, matters: the publishers take the OLDEST due rows in a fixed batch, so held rows
 * filtered out afterwards would fill every batch and stop everyone else's posts. Ids are integers
 * from our own table, so inlining them is safe.
 */
export function heldOrgsClause(held: Set<number>): string {
    const ids = [...held].map(Number).filter(Number.isInteger);
    return ids.length ? `AND organisation_id <> ALL(ARRAY[${ids.join(',')}]::int[])` : '';
}
