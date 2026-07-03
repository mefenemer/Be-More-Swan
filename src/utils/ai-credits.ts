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
// is available on any paid tier with credits (trial has 0 credits, so it's image-gated too).
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
    const rows = await db.execute<{ monthly_ai_credits: unknown }>(sql`
        SELECT mp.features ->> 'monthly_ai_credits' AS monthly_ai_credits
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
