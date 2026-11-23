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
//   POST { action: 'onboarding', mark }       → 'link_copied' | 'dismissed' | 'reopened' (the first-week card,
//                                               docs/partner-onboarding-plan.md §2)
//   POST { action: 'invite_profile_submit', headline, quote, photo: <base64 JPEG> | 'keep' | null }
//                                             → their own invite page, sent for review (plan §3.3)
//   POST { action: 'invite_profile_withdraw' } → take back what's waiting for review
//   POST { action: 'weekly_nudge', on: boolean } → the Monday summary from their assistant on / off (plan §3.5)
//
// Reads are the signed-in user's own partner row only. Writes are blocked during admin
// impersonation (an admin must never change where someone else is paid). Customers are never named
// to the partner (partner-ops.ts partnerHubSummary).

import jwt from 'jsonwebtoken';
import { and, asc, eq, gt, or, isNull, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { masterPlans, organisations, partnerProgrammeSettings, partnerRatePeriods, partners, userOrganisations, users } from '../../db/schema';
import { partnerHubSummary } from '../../src/utils/partner-ops';
import { resolvePeriodAt } from '../../src/utils/partner-rate-periods';
import { ensureReferralCode } from '../../src/utils/referral-code';
import { resolveImpersonation } from '../../src/utils/impersonation';
import { PARTNER_TERMS_UPDATED, PARTNER_TERMS_VERSION } from '../../src/config/partner-terms';
import { checkRateLimit } from '../../src/utils/rate-limit';
import { PAGE_MARKS, buildChecklist, checklistFolded, startersFor, welcomeGreeting, type OnboardingMarks, type PageMark } from '../../src/utils/partner-onboarding';
import {
    checkJpeg, deletePhoto, inviteProfileState, newPhotoKey, orphanedKeys, photoUrl, putPhoto, validateInviteText, type InviteProfile,
} from '../../src/utils/partner-invite-profile';
import { sendEmail } from '../../src/utils/email';
import { ASK_PROMPTS } from '../../src/utils/partner-weekly-nudge';
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
    // An impersonating admin sees the CUSTOMER's Partner page (read-only), as requireTenant does for
    // the rest of the workspace. Until this, aura_session alone decided the user, so the admin got their
    // own (non-existent) partner row and the page said "This page is for Be More Swan partners".
    const imp = await resolveImpersonation(db, event.headers.cookie, userId);
    if (imp) { userId = imp.impersonatingUserId; impersonating = true; }
    const [p] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);

    if (event.httpMethod === 'GET') {
        if (!p || p.status === 'rejected') return json(200, { partner: null, impersonating });
        // 'ended' (Terms 7.1/7.2) still sees what it earned and where it's paid, but no invite link.
        const live = p.status === 'approved' || p.status === 'suspended' || p.status === 'ended';
        // Never mint a code while impersonating: a GET must stay a read.
        const code = live && p.status !== 'ended'
            ? impersonating ? await readReferralCode(db, userId) : await ensureReferralCode(db, userId)
            : null;
        const periods = await db.select().from(partnerRatePeriods).where(or(isNull(partnerRatePeriods.partnerId), eq(partnerRatePeriods.partnerId, p.id)));
        const now = new Date();
        const current = resolvePeriodAt(periods, p.id, now);
        const [settings] = await db.select().from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
        const { stats, commissions } = live ? await partnerHubSummary(db, p.id) : { stats: null, commissions: [] };
        const [u] = await db.select({ email: users.email, firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1);
        const termsAccepted = p.termsVersion === PARTNER_TERMS_VERSION;
        // The first-week card and the Partner Assistant's opening words (docs/partner-onboarding-plan.md §2).
        // Built from data, never a model call (owner decision D2). Not for 'ended' partners — no link, no assistant.
        let onboarding: Record<string, unknown> | null = null;
        if (p.status === 'approved' || p.status === 'suspended') {
            const marks = (p.onboarding || {}) as OnboardingMarks;
            const steps = buildChecklist({ termsAccepted, payoutSet: !!(p.payoutDetailsConfirmedAt && p.payoutDisplay), marks, stats, invitePageLive: !!p.inviteProfile });
            const [plan] = await db.select({ price: masterPlans.monthlyPriceGbp }).from(masterPlans)
                .where(and(eq(masterPlans.isActive, true), gt(masterPlans.monthlyPriceGbp, sql`0`))).orderBy(asc(masterPlans.monthlyPriceGbp)).limit(1);
            const [org] = await db.select({ name: organisations.name }).from(userOrganisations)
                .innerJoin(organisations, eq(organisations.id, userOrganisations.organisationId))
                .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.role, 'owner')))
                .orderBy(asc(userOrganisations.organisationId)).limit(1);   // their OWN business, never one they only work in
            onboarding = {
                steps, folded: checklistFolded(steps, marks), starters: startersFor(steps, stats),
                // The Monday summary: on unless they turned it off; the questions its link may open the chat with.
                weeklyNudge: !marks.weekly_nudge_off_at, askPrompts: ASK_PROMPTS,
                greeting: welcomeGreeting({
                    firstName: u?.firstName ?? null, businessName: org?.name ?? null, steps,
                    terms: current ? { rateBps: current.rateBps, costDeductionBps: current.costDeductionBps, durationMonths: current.durationMonths } : null,
                    planPriceGbp: plan ? Number(plan.price) : null,
                }),
            };
        }
        // Their own invite page: what's live, what's waiting, and the admin's note if it was sent back.
        const invitePage = live && p.status !== 'ended' ? {
            state: inviteProfileState(p),
            live: p.inviteProfile ? { headline: p.inviteProfile.headline, quote: p.inviteProfile.quote, photoUrl: photoUrl(p.id, p.inviteProfile.photoKey) } : null,
            pending: p.inviteProfilePending ? { headline: p.inviteProfilePending.headline, quote: p.inviteProfilePending.quote, photoUrl: photoUrl(p.id, p.inviteProfilePending.photoKey), submittedAt: p.inviteProfilePending.submittedAt } : null,
            note: p.inviteProfileNote ?? null,
        } : null;
        return json(200, {
            onboarding, invitePage,
            partner: { id: p.id, status: p.status, since: p.decidedAt ?? p.createdAt, accountEmail: u?.email ?? null, firstName: u?.firstName ?? null },
            // Partner Terms (partner-terms.html): has this partner accepted the CURRENT version?
            partnerTerms: { accepted: termsAccepted, version: PARTNER_TERMS_VERSION, updated: PARTNER_TERMS_UPDATED },
            link: code ? {
                code, inviteUrl: `${baseUrl()}/invite/${code}`, signupUrl: `${baseUrl()}/register.html?ref=${code}`,
                // A memorable partner code, if an admin has set one (invite-codes.ts) — works like the link.
                partnerCode: p.status === 'approved' ? p.promoCode : null,
            } : null,
            terms: current ? {
                rateBps: current.rateBps, costDeductionBps: current.costDeductionBps, durationMonths: current.durationMonths,
                special: current.partnerId === p.id, specialUntil: current.partnerId === p.id ? current.endsAt : null,
            } : null,
            stats, commissions: commissions.map((c) => ({
                id: c.id, kind: c.kind, status: c.status, amountPence: c.commission_pence, rateBps: c.rate_bps, costDeductionBps: c.cost_deduction_bps ?? 0,
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
    if (!p || !['approved', 'suspended', 'ended'].includes(p.status)) return json(403, { error: 'This is only for approved partners.' });
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
    if (body.action === 'onboarding') {
        const mark = String(body.mark || '') as PageMark;
        if (!(PAGE_MARKS as readonly string[]).includes(mark)) return json(400, { error: 'Unknown step.' });
        // jsonb in place, so a mark the assistant wrote at the same moment (first_draft_at) is never lost.
        // link_copied keeps its FIRST time; reopened clears the fold.
        if (mark === 'link_copied') {
            await db.update(partners).set({ onboarding: sql`${partners.onboarding} || jsonb_build_object('link_copied_at', COALESCE(${partners.onboarding}->>'link_copied_at', ${new Date().toISOString()}::text))` }).where(eq(partners.id, p.id));
        } else if (mark === 'dismissed') {
            await db.update(partners).set({ onboarding: sql`${partners.onboarding} || jsonb_build_object('dismissed_at', ${new Date().toISOString()}::text)` }).where(eq(partners.id, p.id));
        } else {
            await db.update(partners).set({ onboarding: sql`${partners.onboarding} - 'dismissed_at'` }).where(eq(partners.id, p.id));
        }
        return json(200, { ok: true });
    }
    if (body.action === 'weekly_nudge') {
        const on = body.on === true;
        await db.update(partners).set({ onboarding: on
            ? sql`${partners.onboarding} - 'weekly_nudge_off_at'`
            : sql`${partners.onboarding} || jsonb_build_object('weekly_nudge_off_at', ${new Date().toISOString()}::text)` }).where(eq(partners.id, p.id));
        return json(200, { ok: true, on });
    }
    if (body.action === 'invite_profile_submit' || body.action === 'invite_profile_withdraw') {
        if (p.status !== 'approved') return json(403, { error: 'Your invite page can be changed while your partnership is active.' });
        // The page carries their words under our name: the Terms (5.1–5.3) come first.
        if (p.termsVersion !== PARTNER_TERMS_VERSION) return json(403, { error: 'Please accept the Partner Terms first — step 1 of your first-week list.' });
        const pending = p.inviteProfilePending as InviteProfile | null;
        const liveKey = (p.inviteProfile as InviteProfile | null)?.photoKey ?? null;
        // Saves are conditional on what was read: if an admin approved (or sent back) a moment ago, the photo
        // that just went live must not be deleted as "old" (review of #815).
        const unchanged = and(eq(partners.id, p.id),
            sql`${partners.inviteProfilePending}::text IS NOT DISTINCT FROM ${pending ? JSON.stringify(pending) : null}::jsonb::text`,
            sql`${partners.inviteProfile}::text IS NOT DISTINCT FROM ${p.inviteProfile ? JSON.stringify(p.inviteProfile) : null}::jsonb::text`);
        const changedMeanwhile = json(409, { error: 'Your invite page was just reviewed. Reload the page to see the latest, then try again.' });
        if (body.action === 'invite_profile_withdraw') {
            const done = await db.update(partners).set({ inviteProfilePending: null, inviteProfileNote: null, updatedAt: new Date() }).where(unchanged).returning({ id: partners.id });
            if (!done.length) return changedMeanwhile;
            for (const k of orphanedKeys([pending?.photoKey], [liveKey])) await deletePhoto(k);
            return json(200, { ok: true });
        }
        const text = validateInviteText(body);
        if (!text.ok) return json(400, { error: text.error });
        const { allowed } = await checkRateLimit(db, 'partner_invite_profile', `partner:${p.id}`, { maxAttempts: 10, windowSecs: 86_400 });
        if (!allowed) return json(429, { error: 'You’ve sent your invite page a few times today — please try again tomorrow.' });
        // Photo: a new one (uploaded now), 'keep' (whatever is waiting, else what's live), or null (none).
        let photoKey: string | null = null;
        if (body.photo === 'keep') photoKey = pending?.photoKey ?? liveKey;
        else if (body.photo) {
            const jpeg = checkJpeg(body.photo);
            if (!jpeg.ok) return json(400, { error: jpeg.error });
            photoKey = newPhotoKey(p.id);
            const stored = await putPhoto(photoKey, jpeg.bytes).catch((err) => { console.error('[partner-hub] photo upload failed', err); return false; });
            if (!stored) return json(503, { error: 'Your photo could not be saved just now. Please try again, or send it without a photo.' });
        }
        const next: InviteProfile = { headline: text.headline, quote: text.quote, photoKey, submittedAt: new Date().toISOString() };
        const saved = await db.update(partners).set({ inviteProfilePending: next, inviteProfileNote: null, updatedAt: new Date() }).where(unchanged).returning({ id: partners.id });
        if (!saved.length) {
            if (body.photo && body.photo !== 'keep' && photoKey) await deletePhoto(photoKey);   // the upload nobody will point at
            return changedMeanwhile;
        }
        for (const k of orphanedKeys([pending?.photoKey], [photoKey, liveKey])) await deletePhoto(k);
        // A heads-up for whoever reviews partners (same inbox as new applications).
        const [who] = await db.select({ firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        const name = [who?.firstName, who?.lastName].filter(Boolean).join(' ') || who?.email || `Partner #${p.id}`;
        const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
        await sendEmail({
            to: process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com',
            subject: `🖼️ Invite page to review: ${name}`,
            html: `<p style="margin:0 0 12px;"><strong>${esc(name)}</strong> sent their invite page for review.</p><p style="margin:0 0 8px;"><strong>Headline:</strong> ${esc(next.headline)}</p><p style="margin:0 0 8px;"><strong>Their words:</strong> ${esc(next.quote || '—')}</p><p style="margin:0 0 8px;"><strong>Photo:</strong> ${photoKey ? 'yes' : 'none'}</p><p style="margin:16px 0 0;"><a href="${baseUrl()}/admin.html?view=partners">Review it in Admin → Money → Partners</a>.</p>`,
            text: `${name} sent their invite page for review.\nHeadline: ${next.headline}\nTheir words: ${next.quote || '—'}\nPhoto: ${photoKey ? 'yes' : 'none'}\nReview: ${baseUrl()}/admin.html?view=partners`,
        }).catch((err) => console.error('[partner-hub] review alert failed (non-blocking):', err));
        return json(200, { ok: true, state: 'waiting' });
    }
    if (body.action === 'cancel_payout_change') {
        await cancelPayoutChange(db, p.id);
        return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action.' });
});

async function readReferralCode(db: ReturnType<typeof getDb>, userId: number): Promise<string | null> {
    const [u] = await db.select({ code: users.referralCode }).from(users).where(eq(users.id, userId)).limit(1);
    return u?.code ?? null;
}
