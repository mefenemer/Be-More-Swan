// netlify/functions/admin-beta.ts
//
// Admin → Customers → Beta testers. Ending the beta, one workspace at a time.
//
//   GET                                        → { workspaces, tiers, coupons }
//   PUT  { organisationId, endsOn, offeredTierKey?, couponCode? }   — set or change the end date + offer
//   POST { organisationId, action: 'preview' | 'notice' | 'reminder' }
//   POST { organisationId, action: 'review_request' }   ask the owner for a review of Be More Swan
//        (platform_review_request email; the app then asks them once next time they open it —
//        src/utils/platform-reviews.ts). Refused if they already reviewed or said "don't ask again".
//
// Owner decisions (2026-10-13) this file enforces:
//   • the end date is per workspace; it is the notice period;
//   • ONLY an admin sends the notice and the reminder — nothing here runs on a timer;
//   • the notice can be sent once; after that, the reminder. A workspace whose notice was never sent
//     is never ended (end-beta-sweep checks noticeSentAt).
//
// Cookie: aura_session; role must clear `manage_beta` (billing_admin and above).

import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { betaEndings, billingCoupons, platformReviewAsks, platformReviews, users } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { renderTemplate, sendTemplatedEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { isMissingTable, recordRequest } from '../../src/utils/platform-reviews';
import { betaOfferFor, loadBetaWorkspaces, loadOfferableTiers, suggestTier, OFFERABLE_TIERS } from '../../src/utils/beta-ending';

const jwtSecret = process.env.JWT_SECRET;
const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => new Date().toISOString().slice(0, 10);

export default withLambda(async (event) => {
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return json(400, { error: 'Ending the beta is not available in Sandbox mode.' });
    }
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });
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
    const denied = requirePermission(admin?.role, 'manage_beta');
    if (denied) return denied;

    const baseUrl = resolveBaseUrl((event.headers || {}) as Record<string, string | undefined>) || 'https://bemoreswan.com';
    const ip = getAdminIp(event.headers as Record<string, string | undefined>);
    const ua = event.headers['user-agent'] || undefined;

    const [workspaces, tiers] = await Promise.all([loadBetaWorkspaces(db), loadOfferableTiers(db)]);

    if (event.httpMethod === 'GET') {
        const coupons = await db.select({ code: billingCoupons.code, name: billingCoupons.name, isActive: billingCoupons.isActive })
            .from(billingCoupons).where(isNull(billingCoupons.deletedAt));
        const rows = [];
        for (const ws of workspaces) {
            const offer = await betaOfferFor(db, ws, tiers, baseUrl);
            rows.push({
                ...ws,
                suggestedTierKey: suggestTier(ws.usage, tiers)?.tierKey ?? null,
                offer: offer && {
                    tierKey: offer.tierKey, planName: offer.planName, fullPriceGbp: offer.fullPriceGbp,
                    offerPriceGbp: offer.offerPriceGbp, couponCode: offer.coupon?.code ?? null,
                    couponProblem: offer.couponProblem, checkoutUrl: offer.checkoutUrl, fits: offer.fits,
                },
            });
        }
        return json(200, { workspaces: rows, tiers, coupons: coupons.filter((c) => c.isActive) });
    }

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const orgId = Number(body.organisationId);
    const ws = workspaces.find((w) => w.organisationId === orgId);
    if (!ws) return json(404, { error: 'That workspace is not on the beta.' });

    // ── Set the end date and the offer ──────────────────────────────────────────────────────
    if (event.httpMethod === 'PUT') {
        if (ws.ending?.endedAt) return json(409, { error: 'This beta has already ended.' });
        const endsOn = String(body.endsOn ?? '');
        if (!ISO_DATE.test(endsOn)) return json(400, { error: 'Choose an end date.' });
        if (endsOn <= todayIso()) return json(400, { error: 'The end date must be after today.' });
        const offeredTierKey = body.offeredTierKey ? String(body.offeredTierKey) : null;
        if (offeredTierKey && !(OFFERABLE_TIERS as readonly string[]).includes(offeredTierKey)) return json(400, { error: 'Unknown plan.' });
        const couponCode = String(body.couponCode ?? '').trim().toUpperCase() || null;
        const values = { endsOn, offeredTierKey, couponCode, updatedAt: new Date() };
        await db.insert(betaEndings).values({ organisationId: orgId, ...values })
            .onConflictDoUpdate({ target: betaEndings.organisationId, set: values });
        await insertAdminAuditLog({
            adminId, action: 'beta_ending_update', targetType: 'organisation', targetId: orgId,
            previousState: ws.ending ? { endsOn: ws.ending.endsOn, offeredTierKey: ws.ending.offeredTierKey, couponCode: ws.ending.couponCode } : undefined,
            newState: { endsOn, offeredTierKey, couponCode }, ipAddress: ip, userAgent: ua,
        });
        return json(200, { ok: true });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    const action = String(body.action || '');

    // ── Ask for a review — any beta workspace, ended or not, paid or not ─────────────────────
    if (action === 'review_request') {
        if (!ws.ownerUserId || !ws.ownerEmail) return json(400, { error: 'This workspace has no owner to ask.' });
        try {
            const [[done], [ask]] = await Promise.all([
                db.select({ id: platformReviews.id }).from(platformReviews).where(eq(platformReviews.userId, ws.ownerUserId)).limit(1),
                db.select().from(platformReviewAsks).where(eq(platformReviewAsks.userId, ws.ownerUserId)).limit(1),
            ]);
            if (done) return json(409, { error: 'They have already left a review.' });
            if (ask?.optedOutAt) return json(409, { error: 'They asked not to be asked for a review.' });
        } catch (err) {
            if (isMissingTable(err)) return json(503, { error: 'Apply db/z-platform-reviews.sql first.' });
            throw err;
        }
        const sent = await sendTemplatedEmail({
            triggerKey: 'platform_review_request', to: ws.ownerEmail,
            vars: {
                user: { first_name: ws.ownerFirstName || undefined },
                workspace: { name: ws.organisationName },
                link: { action_url: `${baseUrl}/workspace.html?review=1` },
            },
        });
        if (!sent) return json(502, { error: 'The email did not send — the template may be switched off in Comms.' });
        await recordRequest(db, ws.ownerUserId, adminId);
        await insertAdminAuditLog({
            adminId, action: 'platform_review_requested', targetType: 'organisation', targetId: orgId,
            newState: { to: ws.ownerEmail }, ipAddress: ip, userAgent: ua,
        });
        return json(200, { ok: true });
    }
    if (!['preview', 'notice', 'reminder'].includes(action)) return json(400, { error: 'Unknown action.' });
    if (!ws.ending?.endsOn) return json(400, { error: 'Set an end date first.' });
    if (ws.ending.endedAt) return json(409, { error: 'This beta has already ended.' });

    const offer = await betaOfferFor(db, ws, tiers, baseUrl);
    if (!offer) return json(400, { error: 'No plan to offer — check the plans in Master Data.' });
    const triggerKey = action === 'reminder' ? 'beta_ending_reminder' : 'beta_ending_notice';

    if (action === 'preview') {
        const rendered = await renderTemplate(triggerKey, offer.vars);
        if (!rendered) return json(500, { error: 'The email template is missing.' });
        return json(200, { to: ws.ownerEmail, subject: rendered.subject, html: rendered.html, couponProblem: offer.couponProblem });
    }

    if (!ws.ownerEmail) return json(400, { error: 'This workspace has no owner email to send to.' });
    if (action === 'notice' && ws.ending.noticeSentAt) return json(409, { error: 'The notice has already been sent. Send a reminder instead.' });
    if (action === 'reminder' && !ws.ending.noticeSentAt) return json(409, { error: 'Send the notice first.' });

    const sent = await sendTemplatedEmail({ triggerKey, to: ws.ownerEmail, vars: offer.vars });
    if (!sent) return json(502, { error: 'The email did not send — the template may be switched off in Comms.' });

    const now = new Date();
    await db.update(betaEndings)
        .set(action === 'notice' ? { noticeSentAt: now, noticeSentBy: adminId, updatedAt: now } : { reminderSentAt: now, reminderSentBy: adminId, updatedAt: now })
        .where(and(eq(betaEndings.organisationId, orgId)));
    await insertAdminAuditLog({
        adminId, action: action === 'notice' ? 'beta_notice_sent' : 'beta_reminder_sent', targetType: 'organisation', targetId: orgId,
        newState: { to: ws.ownerEmail, endsOn: ws.ending.endsOn, plan: offer.tierKey, coupon: offer.coupon?.code ?? null },
        ipAddress: ip, userAgent: ua,
    });
    return json(200, { ok: true, couponProblem: offer.couponProblem });
});
