// src/utils/partner-notify.ts
// Affiliate Partner Programme, step 9 — telling partners about money (docs/affiliate-partner-programme-plan.md §4.8).
//   • commission earned — from partner-ledger.ts when a customer payment records a commission;
//   • payout sent       — from admin-partners.ts when a payout run is marked paid.
// Each is an in-app notification (notify.ts, type 'referral_reward' so it shares that preference
// category, opening the Partner page) and an email. Best-effort: never throws — a notification
// failing must not fail a Stripe webhook or a payout run.

import { eq, sql } from 'drizzle-orm';
import { partners, users } from '../../db/schema';
import { createNotification } from './notify';
import { sendTemplatedEmail } from './email';

type Db = any;
const pounds = (p: number) => `£${(p / 100).toFixed(2)}`;
const ukDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const partnerPageUrl = () => `${(process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '')}/workspace.html?view=partner`;

async function partnerUser(db: Db, partnerId: number) {
    const [row] = await db.select({ userId: partners.userId, email: users.email, firstName: users.firstName, payoutDisplay: partners.payoutDisplay })
        .from(partners).innerJoin(users, eq(users.id, partners.userId)).where(eq(partners.id, partnerId)).limit(1);
    return row ?? null;
}

export async function notifyCommissionEarned(db: Db, partnerId: number, amountPence: number, readyOn: Date): Promise<void> {
    try {
        const who = await partnerUser(db, partnerId);
        if (!who?.userId) return;
        const vars = { partner: { amount: pounds(amountPence), ready_on: ukDate(readyOn) } };
        await createNotification(db, 'partner_commission_earned', { userId: who.userId, context: vars, metadata: { action: 'partner_page', amountPence } });
        if (who.email) await sendTemplatedEmail({ triggerKey: 'partner_commission_earned', to: who.email, vars: { ...vars, user: { first_name: who.firstName || '' }, link: { action_url: partnerPageUrl() } } });
    } catch (err) {
        console.error('[partner-notify] commission earned notification failed (non-blocking):', err);
    }
}

/** Every partner paid in a run, once it is marked paid. */
export async function notifyPayoutSent(db: Db, batchId: number): Promise<number> {
    let sent = 0;
    try {
        const rows = (await db.execute(sql`
            SELECT partner_id, SUM(commission_pence)::int AS amount FROM partner_commissions
             WHERE payout_batch_id = ${batchId} AND status = 'paid' GROUP BY partner_id`)) as Array<{ partner_id: number; amount: number }>;
        for (const r of rows) {
            if (!(Number(r.amount) > 0)) continue;
            const who = await partnerUser(db, r.partner_id);
            if (!who?.userId) continue;
            const vars = { partner: { amount: pounds(Number(r.amount)), payout_display: who.payoutDisplay || 'your payout account' } };
            await createNotification(db, 'partner_payout_sent', { userId: who.userId, context: vars, metadata: { action: 'partner_page', batchId } });
            if (who.email) await sendTemplatedEmail({ triggerKey: 'partner_payout_sent', to: who.email, vars: { ...vars, user: { first_name: who.firstName || '' }, link: { action_url: partnerPageUrl() } } });
            sent++;
        }
    } catch (err) {
        console.error('[partner-notify] payout sent notifications failed (non-blocking):', err);
    }
    return sent;
}
