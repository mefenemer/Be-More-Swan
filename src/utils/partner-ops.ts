// src/utils/partner-ops.ts
// Affiliate Partner Programme — the READ side shared by Admin → Revenue → Partners (admin-partners.ts)
// and its Partner Ops chat (admin-partners-chat.ts). One query per question, so the screen and the
// chat can never disagree about a partner's numbers.
//
// Everything here is read-only. Writes go through admin-partners.ts — the chat only PROPOSES them.
//
// ⚠️ Raw SQL binds integers only (days, limits, ids). Never bind a JS Date into a sql`` template
// (memory raw-sql-date-param-trap): every window is `now() - make_interval(days => N)` in SQL.
//
// ⚠️ BMS does not record logins. "Active customer" means AI actions in ai_usage_log (one row per
// model call made for that user) — the closest real measure of use there is.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;
type Row = Record<string, any>;

const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)) as unknown as Row[];
const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Every partner with their numbers (the Partners list on the admin screen). */
export async function listPartnersWithNumbers(db: Db): Promise<Row[]> {
    return rows(db, sql`
        SELECT p.id, p.user_id, p.status, p.application, p.decision_note, p.decided_at, p.created_at,
               p.promo_code, p.payout_method, p.payout_display, (p.payout_details_confirmed_at IS NOT NULL AND p.payout_display IS NOT NULL) AS has_payout_details,
               COALESCE(u.email, p.applicant_email) AS email,
               COALESCE(u.first_name, p.applicant_name) AS first_name,
               CASE WHEN u.id IS NULL THEN NULL ELSE u.last_name END AS last_name,
               u.referral_code, (p.user_id IS NOT NULL) AS has_account, p.invited_at, p.invite_expires_at,
               COALESCE(r.referrals, 0)::int AS referrals,
               COALESCE(r.paying, 0)::int AS paying,
               COALESCE(c.pending, 0)::int AS pending_pence,
               COALESCE(c.payable, 0)::int AS payable_pence,
               COALESCE(c.paid, 0)::int AS paid_pence
          FROM partners p
          LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN (SELECT partner_id, COUNT(*) AS referrals, COUNT(subscribed_at) AS paying
                       FROM partner_referrals GROUP BY partner_id) r ON r.partner_id = p.id
          LEFT JOIN (SELECT partner_id,
                            SUM(commission_pence) FILTER (WHERE status = 'pending') AS pending,
                            SUM(commission_pence) FILTER (WHERE status = 'payable') AS payable,
                            SUM(commission_pence) FILTER (WHERE status = 'paid') AS paid
                       FROM partner_commissions GROUP BY partner_id) c ON c.partner_id = p.id
         ORDER BY CASE p.status WHEN 'applied' THEN 0 WHEN 'approved' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END,
                  p.created_at DESC`);
}

/** One partner: who they referred and their recent ledger. */
export async function partnerDetail(db: Db, partnerId: number): Promise<{ referrals: Row[]; commissions: Row[] }> {
    const id = clampInt(partnerId, 1, 2_147_483_647, 0);
    const referrals = await rows(db, sql`
        SELECT pr.id, pr.source, pr.subscribed_at, pr.rate_bps, pr.duration_months, pr.created_at,
               ref.email AS customer_email, ur.status AS referral_status
          FROM partner_referrals pr
          JOIN user_referrals ur ON ur.id = pr.referral_id
          LEFT JOIN users ref ON ref.id = ur.referred_user_id
         WHERE pr.partner_id = ${id}
         ORDER BY pr.created_at DESC LIMIT 50`);
    const commissions = await rows(db, sql`
        SELECT id, kind, status, commission_pence, net_amount_pence, rate_bps, available_at, created_at, void_reason, note
          FROM partner_commissions WHERE partner_id = ${id}
         ORDER BY created_at DESC LIMIT 50`);
    return { referrals, commissions };
}

/** Partners ranked by commission earned (not voided) in the last N days, with new paying customers. */
export async function topReferrers(db: Db, days: unknown, limit: unknown = 5): Promise<Row[]> {
    const d = clampInt(days, 1, 730, 90);
    const n = clampInt(limit, 1, 50, 5);
    return rows(db, sql`
        SELECT p.id, p.status, u.email, u.first_name, u.last_name,
               COALESCE(SUM(c.commission_pence) FILTER (WHERE c.kind = 'invoice' AND c.status <> 'voided'), 0)::int AS earned_pence,
               COALESCE(SUM(c.net_amount_pence) FILTER (WHERE c.kind = 'invoice' AND c.status <> 'voided'), 0)::int AS revenue_pence,
               (SELECT COUNT(*) FROM partner_referrals pr
                 WHERE pr.partner_id = p.id AND pr.subscribed_at >= now() - make_interval(days => ${d}))::int AS new_paying
          FROM partners p
          LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN partner_commissions c ON c.partner_id = p.id AND c.created_at >= now() - make_interval(days => ${d})
         GROUP BY p.id, u.email, u.first_name, u.last_name
        HAVING COALESCE(SUM(c.commission_pence) FILTER (WHERE c.kind = 'invoice' AND c.status <> 'voided'), 0) > 0
         ORDER BY earned_pence DESC LIMIT ${n}`);
}

/**
 * Before a payout: what is ready to pay, per partner, and anything worth a second look.
 *   same_card_customers  — referred customers whose workspace uses the SAME card as the partner's
 *                          own workspace (Stripe card fingerprint): the strongest self-referral sign;
 *   same_domain_customers — referred customers on the partner's own email domain (public mail
 *                          providers excluded) — weaker, often a colleague;
 *   reversed_90d         — commissions voided or clawed back in 90 days (refunds, disputes);
 *   new_paying_7d        — customers who first paid in the last 7 days (a burst can be a coupon leak).
 */
export async function payoutAudit(db: Db, minPayoutPence: number): Promise<{ partners: Row[]; totalPayablePence: number }> {
    const min = clampInt(minPayoutPence, 0, 100_000_000, 5000);
    const list = await rows(db, sql`
        WITH payable AS (
            SELECT partner_id, SUM(commission_pence)::int AS payable_pence, COUNT(*)::int AS rows
              FROM partner_commissions WHERE status = 'payable' GROUP BY partner_id
        ),
        partner_ws AS (
            SELECT p.id AS partner_id, split_part(lower(u.email), '@', 2) AS domain,
                   (SELECT o.card_fingerprint FROM user_organisations uo JOIN organisations o ON o.id = uo.organisation_id
                     WHERE uo.user_id = p.user_id AND o.card_fingerprint IS NOT NULL LIMIT 1) AS card
              FROM partners p LEFT JOIN users u ON u.id = p.user_id
        ),
        customers AS (
            SELECT pr.partner_id, split_part(lower(ref.email), '@', 2) AS domain,
                   (SELECT o.card_fingerprint FROM user_organisations uo JOIN organisations o ON o.id = uo.organisation_id
                     WHERE uo.user_id = ur.referred_user_id AND o.card_fingerprint IS NOT NULL LIMIT 1) AS card,
                   pr.subscribed_at
              FROM partner_referrals pr
              JOIN user_referrals ur ON ur.id = pr.referral_id
              LEFT JOIN users ref ON ref.id = ur.referred_user_id
        )
        SELECT p.id, p.status, u.email, u.first_name, u.last_name,
               (p.payout_details_confirmed_at IS NOT NULL AND p.payout_display IS NOT NULL) AS has_payout_details,
               COALESCE(pa.payable_pence, 0) AS payable_pence,
               (SELECT COUNT(*) FROM customers c WHERE c.partner_id = p.id AND c.card IS NOT NULL AND c.card = w.card)::int AS same_card_customers,
               (SELECT COUNT(*) FROM customers c WHERE c.partner_id = p.id AND c.domain = w.domain
                  AND w.domain NOT IN ('gmail.com','googlemail.com','outlook.com','hotmail.com','hotmail.co.uk','live.com','live.co.uk',
                                       'yahoo.com','yahoo.co.uk','icloud.com','me.com','aol.com','protonmail.com','proton.me','btinternet.com','sky.com'))::int AS same_domain_customers,
               (SELECT COUNT(*) FROM partner_commissions x WHERE x.partner_id = p.id
                  AND (x.status = 'voided' OR x.kind = 'adjustment') AND x.created_at >= now() - make_interval(days => 90))::int AS reversed_90d,
               (SELECT COUNT(*) FROM customers c WHERE c.partner_id = p.id AND c.subscribed_at >= now() - make_interval(days => 7))::int AS new_paying_7d
          FROM partners p
          JOIN partner_ws w ON w.partner_id = p.id
          LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN payable pa ON pa.partner_id = p.id
         WHERE COALESCE(pa.payable_pence, 0) <> 0 OR p.status = 'approved'
         ORDER BY payable_pence DESC`);
    const totalPayablePence = list.reduce((s, r) => s + Number(r.payable_pence || 0), 0);
    return {
        totalPayablePence,
        partners: list.map((r) => ({ ...r, over_minimum: Number(r.payable_pence) >= min })),
    };
}

/**
 * Paying customers who are not partners yet, most active first — people worth inviting. Active =
 * AI actions in the last N days (logins are not recorded).
 */
export async function recruitmentCandidates(db: Db, days: unknown = 30, minActions: unknown = 15, limit: unknown = 10): Promise<Row[]> {
    const d = clampInt(days, 1, 365, 30);
    const min = clampInt(minActions, 0, 100_000, 15);
    const n = clampInt(limit, 1, 50, 10);
    return rows(db, sql`
        SELECT u.id AS user_id, u.email, u.first_name, u.last_name, o.name AS workspace,
               COUNT(a.id)::int AS ai_actions
          FROM users u
          JOIN user_organisations uo ON uo.user_id = u.id
          JOIN organisations o ON o.id = uo.organisation_id
          JOIN plans pl ON pl.organisation_id = o.id AND pl.status IN ('active', 'past_due')
                       AND pl.plan_type NOT IN ('beta', 'trial')
          JOIN ai_usage_log a ON a.user_id = u.id AND a.created_at >= now() - make_interval(days => ${d})
         WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.user_id = u.id)
           AND u.role NOT IN ('super_admin', 'platform_admin', 'billing_admin', 'support_agent')
         GROUP BY u.id, u.email, u.first_name, u.last_name, o.name
        HAVING COUNT(a.id) >= ${min}
         ORDER BY ai_actions DESC LIMIT ${n}`);
}

/**
 * A partner's own numbers, for their Partner page (partner-hub.ts). Customers are NEVER named to the
 * partner — "Customer 3", in the order they signed up — because the partner did not collect their
 * consent to be identified.
 *   signups  — people who registered with their code since they became a partner (user_referrals,
 *              any status but the token track's), whether or not they have paid yet;
 *   paying   — those whose first payment has locked a rate (partner_referrals.subscribed_at).
 */
export async function partnerHubSummary(db: Db, partnerId: number): Promise<{ stats: Row; commissions: Row[] }> {
    const id = clampInt(partnerId, 1, 2_147_483_647, 0);
    const [stats] = await rows(db, sql`
        SELECT
          (SELECT COALESCE(SUM(clicks), 0) FROM partner_link_stats WHERE partner_id = ${id}
             AND day >= (now() AT TIME ZONE 'Europe/London')::date - 6)::int AS clicks_7d,
          (SELECT COALESCE(SUM(clicks), 0) FROM partner_link_stats WHERE partner_id = ${id}
             AND day >= (now() AT TIME ZONE 'Europe/London')::date - 29)::int AS clicks_30d,
          (SELECT COALESCE(SUM(clicks), 0) FROM partner_link_stats WHERE partner_id = ${id})::int AS clicks_all,
          (SELECT COUNT(*) FROM user_referrals ur JOIN partners p ON p.id = ${id}
             WHERE ur.referrer_id = p.user_id AND ur.status IN ('pending', 'partner')
               AND ur.created_at >= COALESCE(p.decided_at, p.created_at))::int AS signups,
          (SELECT COUNT(*) FROM partner_referrals WHERE partner_id = ${id} AND subscribed_at IS NOT NULL)::int AS paying,
          (SELECT COALESCE(SUM(commission_pence), 0) FROM partner_commissions WHERE partner_id = ${id} AND status = 'pending')::int AS pending_pence,
          (SELECT COALESCE(SUM(commission_pence), 0) FROM partner_commissions WHERE partner_id = ${id} AND status = 'payable')::int AS payable_pence,
          (SELECT COALESCE(SUM(commission_pence), 0) FROM partner_commissions WHERE partner_id = ${id} AND status = 'paid')::int AS paid_pence,
          (SELECT MIN(available_at) FROM partner_commissions WHERE partner_id = ${id} AND status = 'pending') AS next_release_at`);
    const commissions = await rows(db, sql`
        SELECT c.id, c.kind, c.status, c.commission_pence, c.rate_bps, c.available_at, c.created_at, c.paid_at, c.void_reason,
               (SELECT COUNT(*) FROM partner_referrals x WHERE x.partner_id = ${id} AND x.id <= c.partner_referral_id)::int AS customer_no
          FROM partner_commissions c
         WHERE c.partner_id = ${id}
         ORDER BY c.created_at DESC LIMIT 25`);
    return { stats, commissions };
}
