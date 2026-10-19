// src/utils/invite-codes.ts
// One answer to "who invited this person?" for every kind of code (docs/affiliate-partner-programme-plan.md §4.2):
//   • a referral code (users.referral_code, 8 characters) — every customer's refer-a-friend link and
//     every partner's /invite/<code> link;
//   • a partner code (partners.promo_code, e.g. SAMSWAN) — memorable, set by an admin, approved
//     partners only. Owner decision 2026-10-18: a BMS code, not a Stripe promotion code (see
//     db/z-affiliate-partner-codes.sql for why).
// Used by sign-up (register.ts), the invite page and "Invited by" lookups (invite-lookup.ts), the
// offer banner (get-referral-discount.ts) and the plan picker's "Have an invite code?" (referral-claim.ts).

import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { partners, plans, userReferrals, users } from '../../db/schema';
import { FREE_PLAN_TYPES } from '../config/beta-plan';

type Db = ReturnType<typeof getDb>;

export interface ResolvedInvite {
    referrerUserId: number;
    firstName: string | null;
    /** The code as it should be recorded (upper case). */
    code: string;
    /** Set when the code is a partner code; null for a referral code. */
    partnerId: number | null;
}

const clean = (raw: unknown) => (typeof raw === 'string' ? raw.trim().toUpperCase() : '');

/** A referral code, else an approved partner's partner code. Null when neither. */
export async function resolveInviteCode(db: Db, raw: unknown): Promise<ResolvedInvite | null> {
    const code = clean(raw);
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return null;
    const [owner] = await db.select({ id: users.id, firstName: users.firstName, pendingDeletion: users.pendingDeletion })
        .from(users).where(eq(users.referralCode, code)).limit(1);
    if (owner) return owner.pendingDeletion ? null : { referrerUserId: owner.id, firstName: owner.firstName, code, partnerId: null };
    const [p] = await db.select({ partnerId: partners.id, userId: partners.userId, firstName: users.firstName, pendingDeletion: users.pendingDeletion })
        .from(partners).innerJoin(users, eq(users.id, partners.userId))
        .where(and(sql`upper(${partners.promoCode}) = ${code}`, eq(partners.status, 'approved'))).limit(1);
    if (!p || !p.userId || p.pendingDeletion) return null;
    return { referrerUserId: p.userId, firstName: p.firstName, code, partnerId: p.partnerId };
}

/** 4–20 letters and digits, starting with a letter — easy to say on a podcast. */
export function validatePartnerCode(raw: unknown): { ok: true; code: string } | { ok: false; error: string } {
    const code = clean(raw);
    if (!/^[A-Z][A-Z0-9]{3,19}$/.test(code)) return { ok: false, error: 'A partner code is 4–20 letters and numbers, starting with a letter (e.g. SAMSWAN).' };
    return { ok: true, code };
}

/** Turn a partner's code on (or change it), or off with null. Unique across partner codes AND referral codes. */
export async function setPartnerCode(db: Db, partnerId: number, raw: unknown | null): Promise<{ ok: true; code: string | null } | { ok: false; error: string }> {
    if (raw === null || raw === '') {
        await db.update(partners).set({ promoCode: null, updatedAt: new Date() }).where(eq(partners.id, partnerId));
        return { ok: true, code: null };
    }
    const v = validatePartnerCode(raw);
    if (!v.ok) return v;
    const [taken] = await db.select({ id: users.id }).from(users).where(sql`upper(${users.referralCode}) = ${v.code}`).limit(1);
    const [other] = await db.select({ id: partners.id }).from(partners).where(sql`upper(${partners.promoCode}) = ${v.code} AND ${partners.id} <> ${partnerId}`).limit(1);
    if (taken || other) return { ok: false, error: `${v.code} is already in use. Choose another.` };
    try {
        await db.update(partners).set({ promoCode: v.code, updatedAt: new Date() }).where(eq(partners.id, partnerId));
    } catch {
        return { ok: false, error: `${v.code} is already in use. Choose another.` };
    }
    return { ok: true, code: v.code };
}

/**
 * "Have an invite code?" on the plan picker, for someone who signed up without one. Same rule as the
 * friend offer: only someone not already referred, who has never held a paid plan, and not their own
 * code. Writes the user_referrals row sign-up would have written; checkout then applies the offer
 * from it (referral-offer.ts findReferralOffer), never from what the browser sends.
 */
export async function claimLateReferral(db: Db, userId: number, raw: unknown): Promise<{ ok: true; firstName: string | null } | { ok: false; error: string }> {
    const invite = await resolveInviteCode(db, raw);
    if (!invite) return { ok: false, error: 'We don’t recognise that code. Check it and try again.' };
    if (invite.referrerUserId === userId) return { ok: false, error: 'That’s your own code — share it with others instead.' };
    const [already] = await db.select({ id: userReferrals.id }).from(userReferrals).where(eq(userReferrals.referredUserId, userId)).limit(1);
    if (already) return { ok: false, error: 'An invite code is already on your account.' };
    const [paid] = await db.select({ id: plans.id }).from(plans)
        .where(and(eq(plans.userId, userId), notInArray(plans.planType, [...FREE_PLAN_TYPES]))).limit(1);
    if (paid) return { ok: false, error: 'Invite codes are for new customers only.' };
    const inserted = await db.insert(userReferrals).values({ referrerId: invite.referrerUserId, referredUserId: userId, referralCode: invite.code, status: 'pending' })
        .onConflictDoNothing().returning({ id: userReferrals.id });
    if (!inserted.length) return { ok: false, error: 'An invite code is already on your account.' };
    return { ok: true, firstName: invite.firstName };
}

