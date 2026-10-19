// netlify/functions/partner-hub.ts
// The partner's own Partner page in the workspace (partner-content.html) —
// docs/affiliate-partner-programme-plan.md §4.6.
//
//   GET → { partner: null }  (not a partner)
//       | { partner: { status, ... }, link, terms, stats, commissions, payout, payoutRules }
//   POST { action: 'payout_details', method, email? | accountName, sortCode, accountNumber }
//        → { pending: { display }, sentTo }   — a change waits for the emailed confirmation
//   POST { action: 'confirm_payout', token }  → { display }
//   POST { action: 'cancel_payout_change' }
//   POST { action: 'accept_terms' }           → records acceptance of the current Partner Terms
//
// Reads are the signed-in user's own partner row only. Writes are blocked during admin
// impersonation (an admin must never change where someone else is paid). Customers are never named
// to the partner (partner-ops.ts partnerHubSummary).

import jwt from 'jsonwebtoken';
import { eq, or, isNull } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { partnerProgrammeSettings, partnerRatePeriods, partners, users } from '../../db/schema';
import { partnerHubSummary } from '../../src/utils/partner-ops';
import { resolvePeriodAt } from '../../src/utils/partner-rate-periods';
import { ensureReferralCode } from '../../src/utils/referral-code';
import { PARTNER_TERMS_UPDATED, PARTNER_TERMS_VERSION } from '../../src/config/partner-terms';
import { checkRateLimit } from '../../src/utils/rate-limit';
import {
    PAYOUT_REQUEST_LIMIT, cancelPayoutChange, confirmPayoutChange, requestPayoutChange, validatePayoutDetails,
} from '../../src/utils/partner-payouts';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const baseUrl = () => (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');

export default withLambda(async (event) => {
    const secret = process.env.JWT_SECRET;
    if (!secret) return json(500, { error: 'Server misconfigured.' });
    const m = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!m) return json(401, { error: 'Not authenticated.' });
    let userId: number; let impersonating = false;
    try {
        const tok = jwt.verify(m[1], secret) as { userId: number; scope?: string };
        userId = tok.userId; impersonating = tok.scope === 'impersonate';
    } catch { return json(401, { error: 'Invalid session.' }); }

    const db = getDb();
    const [p] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);

    if (event.httpMethod === 'GET') {
        if (!p || p.status === 'rejected') return json(200, { partner: null });
        const live = p.status === 'approved' || p.status === 'suspended';
        const code = live ? await ensureReferralCode(db, userId) : null;
        const periods = await db.select().from(partnerRatePeriods).where(or(isNull(partnerRatePeriods.partnerId), eq(partnerRatePeriods.partnerId, p.id)));
        const now = new Date();
        const current = resolvePeriodAt(periods, p.id, now);
        const [settings] = await db.select().from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
        const { stats, commissions } = live ? await partnerHubSummary(db, p.id) : { stats: null, commissions: [] };
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        return json(200, {
            partner: { id: p.id, status: p.status, since: p.decidedAt ?? p.createdAt, accountEmail: u?.email ?? null },
            // Partner Terms (partner-terms.html): has this partner accepted the CURRENT version?
            partnerTerms: { accepted: p.termsVersion === PARTNER_TERMS_VERSION, version: PARTNER_TERMS_VERSION, updated: PARTNER_TERMS_UPDATED },
            link: code ? {
                code, inviteUrl: `${baseUrl()}/invite/${code}`, signupUrl: `${baseUrl()}/register.html?ref=${code}`,
                // A memorable partner code, if an admin has set one (invite-codes.ts) — works like the link.
                partnerCode: p.status === 'approved' ? p.promoCode : null,
            } : null,
            terms: current ? {
                rateBps: current.rateBps, durationMonths: current.durationMonths,
                special: current.partnerId === p.id, specialUntil: current.partnerId === p.id ? current.endsAt : null,
            } : null,
            stats, commissions: commissions.map((c) => ({
                id: c.id, kind: c.kind, status: c.status, amountPence: c.commission_pence, rateBps: c.rate_bps,
                availableAt: c.available_at, createdAt: c.created_at, paidAt: c.paid_at, voidReason: c.void_reason,
                customer: c.kind === 'invoice' && c.customer_no ? `Customer ${c.customer_no}` : null,
            })),
            payout: {
                method: p.payoutMethod, display: p.payoutDetailsConfirmedAt ? p.payoutDisplay : null, confirmedAt: p.payoutDetailsConfirmedAt,
                pending: p.payoutPendingTokenHash && p.payoutPendingExpiresAt && p.payoutPendingExpiresAt > now
                    ? { display: p.payoutPendingDisplay, expiresAt: p.payoutPendingExpiresAt } : null,
            },
            payoutRules: settings ? { holdingDays: settings.holdingDays, minPayoutPence: settings.minPayoutPence } : null,
        });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    if (impersonating) return json(403, { error: 'Action blocked during impersonation session.' });
    if (!p || (p.status !== 'approved' && p.status !== 'suspended')) return json(403, { error: 'This is only for approved partners.' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

    if (body.action === 'payout_details') {
        const checked = validatePayoutDetails(body);
        if (!checked.ok) return json(400, { error: checked.error });
        const { allowed } = await checkRateLimit(db, 'partner_payout_change', `user:${userId}`, PAYOUT_REQUEST_LIMIT);
        if (!allowed) return json(429, { error: 'You’ve changed your payout details a few times already — please try again in an hour.' });
        const r = await requestPayoutChange(db, p.id, checked.value);
        return json(200, { pending: { display: r.display }, sentTo: r.sentTo });
    }
    if (body.action === 'confirm_payout') {
        const r = await confirmPayoutChange(db, p.id, String(body.token || ''));
        return r.ok ? json(200, { display: r.display }) : json(400, { error: r.error });
    }
    if (body.action === 'accept_terms') {
        await db.update(partners).set({ termsVersion: PARTNER_TERMS_VERSION, termsAcceptedAt: new Date(), updatedAt: new Date() }).where(eq(partners.id, p.id));
        return json(200, { ok: true, version: PARTNER_TERMS_VERSION });
    }
    if (body.action === 'cancel_payout_change') {
        await cancelPayoutChange(db, p.id);
        return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action.' });
});
