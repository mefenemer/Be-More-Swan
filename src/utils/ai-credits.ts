// src/utils/ai-credits.ts
// AI generation credit accounting (Epic 2, US4).
//
// Model (see db/ai-credits.sql):
//   balance — spendable credits.  held — credits reserved by in-flight jobs.
//   A generation HOLDS credits at submit (balance→held), then SETTLES on completion:
//     success → held released and recorded as a debit in ai_credit_ledger (credits spent).
//     failure → held returned to balance, NO ledger entry (US4 AC: never deduct on failure).
//
// Monthly allowance ROLLS OVER (top-up, not reset): on the first credit op of a new UTC month
// the active plan's master_plans.features.monthly_ai_credits is ADDED to the existing balance,
// so unused credits carry forward. (Decided 2026-06-24.)
//
// All mutating ops are atomic single-statement UPDATEs (race-free, mirrors atomic-cap-check.ts).

import { getDb } from '../../db/client';
import { sql } from 'drizzle-orm';
import { getPeriodStart } from './atomic-cap-check';

type Db = ReturnType<typeof getDb>;

// Per-generation credit costs (Epic 2): Flux 2 image = 1, Hailuo 2.3 video = 5.
export const IMAGE_CREDIT_COST = 1;
export const VIDEO_CREDIT_COST = 5;
// Video generation is restricted to premium tiers (decided 2026-06-24). Image generation
// is available on any paid tier with credits.
export const VIDEO_TIERS = ['saver', 'employee'] as const;
export function tierCanGenerateVideo(tierKey: string | null | undefined): boolean {
    return !!tierKey && (VIDEO_TIERS as readonly string[]).includes(tierKey);
}

export function creditCostFor(mediaType: 'image' | 'video'): number {
    return mediaType === 'video' ? VIDEO_CREDIT_COST : IMAGE_CREDIT_COST;
}

export interface CreditBalance {
    balance: number;   // spendable
    held: number;      // reserved by in-flight jobs
}

function ymd(d: Date): string {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC) for DATE columns
}

/** The active plan's monthly AI credit allowance for an org (0 if none / not configured). */
export async function monthlyAllowance(db: Db, orgId: number): Promise<number> {
    // Plan Features: a "new subscribers only" change freezes existing subscribers in
    // plans.feature_overrides — when that snapshot exists its features map is authoritative,
    // otherwise read the live master_plans.features (matches effectiveFeatures() in plan-features.ts).
    const rows = await db.execute<{ monthly_ai_credits: unknown }>(sql`
        SELECT CASE WHEN p.feature_overrides IS NOT NULL
                    THEN p.feature_overrides -> 'features' ->> 'monthly_ai_credits'
                    ELSE mp.features ->> 'monthly_ai_credits' END AS monthly_ai_credits
        FROM plans p
        JOIN master_plans mp ON mp.id = p.master_plan_id
        WHERE p.organisation_id = ${orgId} AND p.status = 'active'
        ORDER BY p.started_at
        LIMIT 1
    `);
    const raw = rows[0]?.monthly_ai_credits;
    const n = raw == null ? 0 : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Ensure the org has a balance row and that the current month's allowance has been granted.
 * Idempotent within a period: re-grants only when last_granted_period is null or older than
 * the current UTC month. Resets autonomous_used at the same time. Returns nothing.
 */
export async function ensureMonthlyGrant(db: Db, orgId: number): Promise<void> {
    const period = ymd(getPeriodStart());

    // Create the row if missing (no grant yet — grant happens in the UPDATE below).
    await db.execute(sql`
        INSERT INTO ai_credit_balance (organisation_id, balance, held)
        VALUES (${orgId}, 0, 0)
        ON CONFLICT (organisation_id) DO NOTHING
    `);

    // Only proceed to grant if this period hasn't been granted yet.
    const due = await db.execute<{ organisation_id: number }>(sql`
        SELECT organisation_id FROM ai_credit_balance
        WHERE organisation_id = ${orgId}
          AND (last_granted_period IS NULL OR last_granted_period < ${period}::date)
    `);
    if (!due[0]) return;

    const allowance = await monthlyAllowance(db, orgId);

    // ROLLOVER: ADD this month's allowance to the existing balance (unused credits carry over);
    // reset the autonomous-spend window for the new period.
    const updated = await db.execute<{ balance: number }>(sql`
        UPDATE ai_credit_balance
        SET balance = balance + ${allowance},
            last_granted_period = ${period}::date,
            autonomous_period_start = ${period}::date,
            autonomous_used = 0,
            updated_at = now()
        WHERE organisation_id = ${orgId}
          AND (last_granted_period IS NULL OR last_granted_period < ${period}::date)
        RETURNING balance
    `);

    // Ledger the grant (only when an UPDATE actually applied and a positive allowance was granted).
    if (updated[0] && allowance > 0) {
        await db.execute(sql`
            INSERT INTO ai_credit_ledger (organisation_id, user_id, delta, reason, balance_after)
            VALUES (${orgId}, NULL, ${allowance}, 'monthly_grant', ${updated[0].balance})
        `);
    }
}

/** Current spendable balance + held credits for an org (applies the monthly grant first). */
export async function getBalance(db: Db, orgId: number): Promise<CreditBalance> {
    await ensureMonthlyGrant(db, orgId);
    const rows = await db.execute<{ balance: number; held: number }>(sql`
        SELECT balance, held FROM ai_credit_balance WHERE organisation_id = ${orgId}
    `);
    return { balance: rows[0]?.balance ?? 0, held: rows[0]?.held ?? 0 };
}

/**
 * Atomically reserve `amount` credits for a generation job (balance → held).
 * Returns { ok:false } when the balance is insufficient (US4 AC: disable/refuse generation).
 */
export async function holdCredits(db: Db, params: {
    orgId: number;
    amount: number;
}): Promise<{ ok: boolean; balance: number }> {
    await ensureMonthlyGrant(db, params.orgId);
    const rows = await db.execute<{ balance: number }>(sql`
        UPDATE ai_credit_balance
        SET balance = balance - ${params.amount}, held = held + ${params.amount}, updated_at = now()
        WHERE organisation_id = ${params.orgId} AND balance >= ${params.amount}
        RETURNING balance
    `);
    if (rows[0]) return { ok: true, balance: rows[0].balance };
    const cur = await getBalance(db, params.orgId);
    return { ok: false, balance: cur.balance };
}

/**
 * Atomically reserve credits for an AUTONOMOUS (assistant-driven) generation, enforcing both the
 * spendable balance AND the per-period autonomous cap (US5 credit-threshold protection). Returns
 * { ok:false, reason } when blocked. autonomous_used is incremented on successful settle.
 */
export async function holdAutonomousCredits(db: Db, params: {
    orgId: number;
    amount: number;
    monthlyCap: number;
}): Promise<{ ok: boolean; balance: number; reason?: 'insufficient_balance' | 'cap_reached' }> {
    await ensureMonthlyGrant(db, params.orgId);
    const rows = await db.execute<{ balance: number }>(sql`
        UPDATE ai_credit_balance
        SET balance = balance - ${params.amount}, held = held + ${params.amount}, updated_at = now()
        WHERE organisation_id = ${params.orgId}
          AND balance >= ${params.amount}
          AND autonomous_used + held + ${params.amount} <= ${params.monthlyCap}
        RETURNING balance
    `);
    if (rows[0]) return { ok: true, balance: rows[0].balance };

    // Distinguish why it failed for clearer logging.
    const cur = await db.execute<{ balance: number; held: number; autonomous_used: number }>(sql`
        SELECT balance, held, autonomous_used FROM ai_credit_balance WHERE organisation_id = ${params.orgId}
    `);
    const row = cur[0];
    const reason: 'insufficient_balance' | 'cap_reached' =
        row && row.balance < params.amount ? 'insufficient_balance' : 'cap_reached';
    return { ok: false, balance: row?.balance ?? 0, reason };
}

/**
 * Settle a previously-held amount once a job finishes.
 *   success=true  → consume the hold and record a debit in the ledger (credits spent).
 *   success=false → return the hold to the spendable balance (no ledger entry, no charge).
 */
export async function settleHold(db: Db, params: {
    orgId: number;
    amount: number;
    success: boolean;
    mediaType: 'image' | 'video';
    userId?: number | null;
    jobId?: number | null;
    isAutonomous?: boolean;
}): Promise<void> {
    if (params.success) {
        const rows = await db.execute<{ balance: number }>(sql`
            UPDATE ai_credit_balance
            SET held = GREATEST(held - ${params.amount}, 0),
                autonomous_used = autonomous_used + ${params.isAutonomous ? params.amount : 0},
                updated_at = now()
            WHERE organisation_id = ${params.orgId}
            RETURNING balance
        `);
        const reason = params.mediaType === 'video' ? 'video_generation' : 'image_generation';
        await db.execute(sql`
            INSERT INTO ai_credit_ledger (organisation_id, user_id, delta, reason, job_id, balance_after, is_autonomous)
            VALUES (${params.orgId}, ${params.userId ?? null}, ${-params.amount}, ${reason},
                    ${params.jobId ?? null}, ${rows[0]?.balance ?? null}, ${!!params.isAutonomous})
        `);
    } else {
        // Refund the hold — credits never left the spendable pool economically.
        await db.execute(sql`
            UPDATE ai_credit_balance
            SET balance = balance + ${params.amount}, held = GREATEST(held - ${params.amount}, 0), updated_at = now()
            WHERE organisation_id = ${params.orgId}
        `);
    }
}

// ── X (Twitter) posting credits (Phase 1) ────────────────────────────────────────────────────────
// A SEPARATE budget from the image/video pool above (Option A): X posts never touch `balance`.
// Instead x_used counts spend within the current UTC month against the plan's monthly_x_credits
// ceiling, RESET (not rolled over) each month so per-tier exposure is fixed. A text post costs 1;
// a post containing any URL costs 13 — mirroring X's ~$0.015 vs ~$0.20 per-request pricing (the
// "link penalty"). See db/x-post-credits.sql.
export const X_TEXT_COST = 1;
export const X_LINK_COST = 13;

// A post "contains a link" if the exact text we send to X has a URL — X applies its link penalty
// to any post carrying one. Matches http(s)://, www., and bare domains on common TLDs.
const X_URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|uk|ai|app|dev|me|xyz|link|shop|store|biz|info|news|blog|social|gg|ly)\b/i;
export function xPostHasLink(text: string): boolean {
    return X_URL_RE.test(text || '');
}
export function xPostCost(text: string): number {
    return xPostHasLink(text) ? X_LINK_COST : X_TEXT_COST;
}

/** The active plan's monthly X-post allowance for an org (0 if none / not configured). */
export async function monthlyXAllowance(db: Db, orgId: number): Promise<number> {
    // Mirrors monthlyAllowance(): honour a frozen feature_overrides snapshot, else live features.
    const rows = await db.execute<{ monthly_x_credits: unknown }>(sql`
        SELECT CASE WHEN p.feature_overrides IS NOT NULL
                    THEN p.feature_overrides -> 'features' ->> 'monthly_x_credits'
                    ELSE mp.features ->> 'monthly_x_credits' END AS monthly_x_credits
        FROM plans p
        JOIN master_plans mp ON mp.id = p.master_plan_id
        WHERE p.organisation_id = ${orgId} AND p.status = 'active'
        ORDER BY p.started_at
        LIMIT 1
    `);
    const raw = rows[0]?.monthly_x_credits;
    const n = raw == null ? 0 : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// New UTC month → reconcile the PURCHASED bonus actually consumed last month, then reset x_used.
// (Deferred accounting: during the month x_used just counts total spend and the cap is
// allowance + x_bonus; the bonus-vs-included split is settled here at rollover.) consumed-from-bonus
// = max(x_used - allowance, 0), floored at 0 against x_bonus. Purchased credits carry over; the
// included allowance does not. `allowance` is passed so callers don't double-fetch it.
async function ensureXPeriod(db: Db, orgId: number, allowance: number): Promise<void> {
    const period = ymd(getPeriodStart());
    await db.execute(sql`
        INSERT INTO ai_credit_balance (organisation_id, balance, held, x_used, x_bonus, x_period_start)
        VALUES (${orgId}, 0, 0, 0, 0, ${period}::date)
        ON CONFLICT (organisation_id) DO NOTHING
    `);
    await db.execute(sql`
        UPDATE ai_credit_balance
        SET x_bonus = GREATEST(x_bonus - GREATEST(x_used - ${allowance}, 0), 0),
            x_used = 0,
            x_period_start = ${period}::date,
            updated_at = now()
        WHERE organisation_id = ${orgId}
          AND (x_period_start IS NULL OR x_period_start < ${period}::date)
    `);
}

export interface XUsage { used: number; allowance: number; bonus: number; remaining: number; }

/** Current-month X usage for an org (applies the monthly reset first). remaining spans allowance + bonus. */
export async function getXUsage(db: Db, orgId: number): Promise<XUsage> {
    const allowance = await monthlyXAllowance(db, orgId);
    await ensureXPeriod(db, orgId, allowance);
    const rows = await db.execute<{ x_used: number; x_bonus: number }>(sql`
        SELECT x_used, x_bonus FROM ai_credit_balance WHERE organisation_id = ${orgId}
    `);
    const used = rows[0]?.x_used ?? 0;
    const bonus = rows[0]?.x_bonus ?? 0;
    return { used, allowance, bonus, remaining: Math.max((allowance + bonus) - used, 0) };
}

/**
 * Atomically reserve `amount` X credits within the month's allowance PLUS any purchased bonus
 * (x_used += amount, capped at allowance + x_bonus). Returns { ok:false } when the combined cap
 * would be exceeded — the caller PAUSES the post (no API request, no spend). Race-safe single UPDATE.
 */
export async function holdXCredits(db: Db, params: { orgId: number; amount: number }): Promise<{ ok: boolean; used: number; allowance: number }> {
    const allowance = await monthlyXAllowance(db, params.orgId);
    await ensureXPeriod(db, params.orgId, allowance);
    const rows = await db.execute<{ x_used: number }>(sql`
        UPDATE ai_credit_balance
        SET x_used = x_used + ${params.amount}, updated_at = now()
        WHERE organisation_id = ${params.orgId}
          AND x_used + ${params.amount} <= ${allowance} + x_bonus
        RETURNING x_used
    `);
    if (rows[0]) return { ok: true, used: rows[0].x_used, allowance };
    const cur = await getXUsage(db, params.orgId);
    return { ok: false, used: cur.used, allowance };
}

/**
 * Settle a held X charge after the publish attempt.
 *   success=true  → keep the spend and record a debit in ai_credit_ledger.
 *   success=false → refund (x_used -= amount); a failed post is never charged (mirrors settleHold).
 */
export async function settleXHold(db: Db, params: {
    orgId: number; amount: number; success: boolean; hasLink: boolean; userId?: number | null;
}): Promise<void> {
    if (params.success) {
        // balance_after / job_id are image/video concepts — leave them null for X debits so the
        // ledger column semantics stay clean; the reason + delta + timestamp are the X audit trail.
        await db.execute(sql`
            INSERT INTO ai_credit_ledger (organisation_id, user_id, delta, reason, balance_after)
            VALUES (${params.orgId}, ${params.userId ?? null}, ${-params.amount},
                    ${params.hasLink ? 'x_post_link' : 'x_post_text'}, NULL)
        `);
    } else {
        await db.execute(sql`
            UPDATE ai_credit_balance
            SET x_used = GREATEST(x_used - ${params.amount}, 0), updated_at = now()
            WHERE organisation_id = ${params.orgId}
        `);
    }
}

// ── X credit booster packs (Phase 2) ───────────────────────────────────────────────────────────
// Self-serve top-up: purchased credits land in x_bonus (persistent, consumed after the monthly
// allowance). Priced ~£0.02/credit (raw X cost ≈ £0.012/credit) for margin; bulk packs discount.
// `id` is the stable key sent to Stripe metadata — never renumber existing packs.
export interface XCreditPack { id: string; credits: number; priceGbpMinor: number; label: string; }
export const X_CREDIT_PACKS: XCreditPack[] = [
    { id: 'x_small',  credits: 500,  priceGbpMinor: 1200, label: '500 X credits' },
    { id: 'x_medium', credits: 1500, priceGbpMinor: 3000, label: '1,500 X credits' },
    { id: 'x_large',  credits: 5000, priceGbpMinor: 9000, label: '5,000 X credits' },
];
export function xCreditPack(id: string): XCreditPack | undefined {
    return X_CREDIT_PACKS.find(p => p.id === id);
}

/**
 * Grant purchased X credits to an org (called from the Stripe webhook on a completed pack checkout).
 * Adds to the persistent x_bonus pool and ledgers the purchase. Idempotent-safe to the extent the
 * caller dedupes on the Stripe event; this itself always applies the grant.
 */
export async function grantXCredits(db: Db, params: { orgId: number; credits: number; userId?: number | null }): Promise<void> {
    const allowance = await monthlyXAllowance(db, params.orgId);
    await ensureXPeriod(db, params.orgId, allowance); // ensure the row exists + period is current
    // Balance bump + ledger entry in ONE atomic statement (data-modifying CTE), so a mid-grant
    // failure can never leave the balance credited without a ledger record (or vice versa).
    await db.execute(sql`
        WITH bump AS (
            UPDATE ai_credit_balance
            SET x_bonus = x_bonus + ${params.credits}, updated_at = now()
            WHERE organisation_id = ${params.orgId}
            RETURNING organisation_id
        )
        INSERT INTO ai_credit_ledger (organisation_id, user_id, delta, reason, balance_after)
        SELECT ${params.orgId}, ${params.userId ?? null}, ${params.credits}, 'x_credit_purchase', NULL
        FROM bump
    `);
}

/** Admin credit grant/deduction (Epic 2, US4 admin tooling). Positive = grant, negative = deduct. */
export async function adminAdjust(db: Db, params: {
    orgId: number;
    delta: number;
    userId?: number | null;
}): Promise<number> {
    await ensureMonthlyGrant(db, params.orgId);
    const rows = await db.execute<{ balance: number }>(sql`
        UPDATE ai_credit_balance
        SET balance = GREATEST(balance + ${params.delta}, 0), updated_at = now()
        WHERE organisation_id = ${params.orgId}
        RETURNING balance
    `);
    const balanceAfter = rows[0]?.balance ?? 0;
    await db.execute(sql`
        INSERT INTO ai_credit_ledger (organisation_id, user_id, delta, reason, balance_after)
        VALUES (${params.orgId}, ${params.userId ?? null}, ${params.delta}, 'admin_adjustment', ${balanceAfter})
    `);
    return balanceAfter;
}
