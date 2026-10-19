// netlify/functions/admin-partners.ts
//
// Admin → Revenue → Partners (docs/affiliate-partner-programme-plan.md §4.5): the affiliate partner
// programme's rates, applications and partners. Partners earn CASH; customers who refer a friend
// stay on the token track and never appear here.
//
//   GET                                                   → { settings, programmeRates, partners, now }
//   POST { action: 'rates', partnerId: number|null, changes: [...] }
//        changes = { op:'create', period } | { op:'update', id, period } | { op:'delete', id }
//        period  = { rateBps, durationMonths|null, startsOn, endsOn|null, label? } — a date is 'YYYY-MM-DD'
//                  (midnight UK) or an exact ISO instant; on an update, a field not sent is kept
//        All changes are checked together (partner-rate-periods.ts validatePeriodChanges) and saved
//        in one transaction, so "end the current rate and start a new one" is a single edit.
//   POST { action: 'settings', holdingDays, minPayoutPence }
//   POST { action: 'decide', partnerId, decision: 'approve'|'reject'|'suspend'|'reinstate', note? }
//   POST { action: 'create', email, note? }               → an existing BMS user becomes an approved partner
//   POST { action: 'resend_invite', partnerId }          → a fresh account link for an approved applicant with no account
//   GET  ?view=ledger[&status=]                           → { ledger }    (newest 200)
//   GET  ?view=payouts                                    → { preview, batches }
//   GET  ?export=wise_bank|wise_email|paypal&batchId=N    → a payment file (CSV) — decrypts payout details, audited
//   POST { action: 'void', commissionId, reason } | { action: 'bonus', partnerId, amountPence, note }
//   POST { action: 'create_batch' } | { action: 'mark_paid', batchId } | { action: 'cancel_batch', batchId }
//   POST { action: 'partner_code', partnerId, code | null }  → a memorable partner code on / changed / off
//   POST { action: 'erase_application', partnerId }      → delete an application with no account and no commission
//
// Cookie: aura_session; role must clear `manage_partners` (billing_admin and above). Every write is
// in the admin audit log. Dates are UK calendar days: a period "from 1 December" starts at midnight
// UK time (ukMidnightUtc).

import { notifyPayoutSent } from '../../src/utils/partner-notify';
import jwt from 'jsonwebtoken';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { partnerProgrammeSettings, partnerRatePeriods, partners, users } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { ukMidnightUtc, validatePeriodChanges, type PeriodChange, type RatePeriod } from '../../src/utils/partner-rate-periods';
import { listPartnersWithNumbers } from '../../src/utils/partner-ops';
import { sendApprovalEmail } from '../../src/utils/partner-applications';
import { setPartnerCode } from '../../src/utils/invite-codes';
import { deleteApplicantOnly } from '../../src/utils/partner-erasure';
import { addBonus, voidCommission, batchLines, buildExport, cancelBatch, createBatch, listBatches, listLedger, markBatchPaid, markExported, previewPayout, type ExportFormat } from '../../src/utils/partner-payout-batches';

const jwtSecret = process.env.JWT_SECRET;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const DECISIONS: Record<string, { from: string[]; to: string; label: string }> = {
    approve:   { from: ['applied', 'rejected'], to: 'approved',  label: 'approved' },
    reject:    { from: ['applied'],             to: 'rejected',  label: 'rejected' },
    suspend:   { from: ['approved'],            to: 'suspended', label: 'suspended' },
    reinstate: { from: ['suspended'],           to: 'approved',  label: 'reinstated' },
};

type RawPeriod = { rateBps?: unknown; durationMonths?: unknown; startsOn?: unknown; endsOn?: unknown; label?: unknown };

/**
 * A date from the admin screen: 'YYYY-MM-DD' = midnight UK time that day; a full ISO timestamp =
 * that exact instant (how the screen sends back a date it is NOT changing, so an untouched date can
 * never drift by an hour through a day round-trip). undefined = not sent; null / '' = no date.
 */
function parseWhen(v: unknown): Date | null | undefined | 'invalid' {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (typeof v !== 'string') return 'invalid';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return ukMidnightUtc(v) ?? 'invalid';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(v) ? 'invalid' : d;
}

/**
 * A period as the admin screen sends it → the stored shape, or an error in plain words. On an
 * update, a field that is not sent keeps its current value (`existing`).
 */
function parsePeriod(raw: RawPeriod, partnerId: number | null, existing?: RatePeriod & { label: string | null }):
    { period: Omit<RatePeriod, 'id'>; label: string | null } | { error: string } {
    const start = parseWhen(raw.startsOn);
    const end = parseWhen(raw.endsOn);
    if (start === 'invalid' || end === 'invalid') return { error: 'One of the dates is not a real date.' };
    const startsAt = start === undefined ? existing?.startsAt ?? null : start;
    if (!startsAt) return { error: 'Choose a start date.' };
    const endsAt = end === undefined ? existing?.endsAt ?? null : end;
    const rateBps = raw.rateBps === undefined && existing ? existing.rateBps : Number(raw.rateBps);
    const durationMonths = raw.durationMonths === undefined && existing ? existing.durationMonths
        : (raw.durationMonths == null || raw.durationMonths === '' ? null : Number(raw.durationMonths));
    const label = raw.label === undefined && existing ? existing.label
        : (typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 60) : null);
    return { period: { partnerId, rateBps, durationMonths, startsAt, endsAt }, label };
}

export default withLambda(async (event) => {
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });

    // ── Auth ────────────────────────────────────────────────────────────────────────────────
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
    const denied = requirePermission(admin?.role, 'manage_partners');
    if (denied) return denied;

    const ip = getAdminIp(event.headers as Record<string, string | undefined>);
    const ua = event.headers['user-agent'] || undefined;
    const audit = (action: 'partner_rates_change' | 'partner_settings_update' | 'partner_decision' | 'partner_create' | 'partner_ledger_change' | 'partner_payout' | 'partner_code_change',
        targetId: number | string, previousState: Record<string, unknown> | undefined, newState: Record<string, unknown>) =>
        insertAdminAuditLog({ adminId, action, targetType: 'partner', targetId, previousState, newState, ipAddress: ip, userAgent: ua });

    // ── Ledger / payouts reads, and payment files ───────────────────────────────────────────
    const qp = event.queryStringParameters || {};
    if (event.httpMethod === 'GET' && qp.view === 'ledger') {
        return json(200, { ledger: await listLedger(db, qp.status || null) });
    }
    if (event.httpMethod === 'GET' && qp.view === 'payouts') {
        return json(200, { preview: await previewPayout(db), batches: await listBatches(db) });
    }
    if (event.httpMethod === 'GET' && qp.export) {
        const format = String(qp.export) as ExportFormat;
        const batchId = Number(qp.batchId);
        if (!['wise_bank', 'wise_email', 'paypal'].includes(format) || !Number.isInteger(batchId)) return json(400, { error: 'Invalid export.' });
        const [batch] = await listBatches(db).then((b) => b.filter((x) => x.id === batchId));
        if (!batch || batch.status === 'cancelled') return json(404, { error: 'That payout run does not exist.' });
        const lines = await batchLines(db, batchId);   // decrypts payout details from the vault
        const file = buildExport(format, batchId, lines);
        await markExported(db, batchId);
        await audit('partner_payout', batchId, undefined, { exported: format, rows: file.included, totalPence: file.totalPence });
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bms-partners-${format}-run-${batchId}.csv"`, 'Cache-Control': 'no-store' },
            body: file.csv,
        };
    }

    // ── Read ────────────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const [settings] = await db.select().from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
        const periods = await db.select().from(partnerRatePeriods).orderBy(asc(partnerRatePeriods.startsAt));
        const rows = await listPartnersWithNumbers(db);   // shared with the Partner Ops chat
        const shape = (p: typeof periods[number]) => ({
            id: p.id, partnerId: p.partnerId, rateBps: p.rateBps, durationMonths: p.durationMonths,
            startsAt: p.startsAt, endsAt: p.endsAt, label: p.label,
        });
        return json(200, {
            now: new Date().toISOString(),
            settings: settings ? { holdingDays: settings.holdingDays, minPayoutPence: settings.minPayoutPence, currency: settings.currency, updatedAt: settings.updatedAt } : null,
            programmeRates: periods.filter((p) => p.partnerId === null).map(shape),
            partners: rows.map((r) => ({
                id: r.id, userId: r.user_id, status: r.status, application: r.application ?? {},
                decisionNote: r.decision_note, decidedAt: r.decided_at, createdAt: r.created_at,
                name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null, email: r.email ?? null,
                referralCode: r.referral_code ?? null, partnerCode: r.promo_code ?? null,
                hasAccount: !!r.has_account, invitedAt: r.invited_at ?? null, inviteExpiresAt: r.invite_expires_at ?? null,
                payoutMethod: r.payout_method, payoutDisplay: r.has_payout_details ? r.payout_display : null, hasPayoutDetails: !!r.has_payout_details,
                referrals: r.referrals, paying: r.paying,
                pendingPence: r.pending_pence, payablePence: r.payable_pence, paidPence: r.paid_pence,
                rates: periods.filter((p) => p.partnerId === r.id).map(shape),
            })),
        });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    let body: Record<string, any>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

    // ── Rates ───────────────────────────────────────────────────────────────────────────────
    if (body.action === 'rates') {
        const partnerId = body.partnerId == null ? null : Number(body.partnerId);
        if (partnerId !== null) {
            const [p] = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1);
            if (!p) return json(404, { error: 'That partner no longer exists.' });
        }
        if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 10) return json(400, { error: 'Nothing to change.' });

        const scope = partnerId === null ? isNull(partnerRatePeriods.partnerId) : eq(partnerRatePeriods.partnerId, partnerId);
        const current = await db.select().from(partnerRatePeriods).where(scope);
        const changes: PeriodChange[] = [];
        const labels = new Map<number, string | null>();     // change index → label
        for (const [i, raw] of (body.changes as Array<Record<string, any>>).entries()) {
            if (raw.op === 'delete') { changes.push({ op: 'delete', id: Number(raw.id) }); continue; }
            if (raw.op !== 'create' && raw.op !== 'update') return json(400, { error: 'Invalid change.' });
            const existing = raw.op === 'update' ? current.find((p) => p.id === Number(raw.id)) : undefined;
            if (raw.op === 'update' && !existing) return json(409, { error: 'That rate period no longer exists. Reload to see the latest.' });
            const parsed = parsePeriod(raw.period ?? {}, partnerId, existing);
            if ('error' in parsed) return json(400, { error: parsed.error });
            labels.set(i, parsed.label);
            changes.push(raw.op === 'create' ? { op: 'create', period: parsed.period } : { op: 'update', id: Number(raw.id), period: parsed.period });
        }

        try {
            const saved = await db.transaction(async (tx) => {
                // One rate edit at a time, everywhere: two admins ending the same period at once
                // must not both pass validation against the same starting state.
                await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('partner_rate_periods'))`);
                const before = await tx.select().from(partnerRatePeriods).where(scope);
                const errors = validatePeriodChanges(before, changes, new Date());
                if (errors.length) throw Object.assign(new Error(errors.join(' ')), { status: 400 });

                const now = new Date();
                for (const [i, ch] of changes.entries()) {
                    if (ch.op === 'delete') {
                        await tx.delete(partnerRatePeriods).where(eq(partnerRatePeriods.id, ch.id));
                    } else if (ch.op === 'update') {
                        await tx.update(partnerRatePeriods)
                            .set({ rateBps: ch.period.rateBps, durationMonths: ch.period.durationMonths, startsAt: ch.period.startsAt, endsAt: ch.period.endsAt, label: labels.get(i) ?? null, updatedAt: now })
                            .where(eq(partnerRatePeriods.id, ch.id));
                    } else {
                        await tx.insert(partnerRatePeriods).values({ ...ch.period, label: labels.get(i) ?? null, createdBy: adminId });
                    }
                }
                const after = await tx.select().from(partnerRatePeriods).where(scope);
                return { before, after };
            });
            await audit('partner_rates_change', partnerId ?? 'programme', { periods: saved.before }, { periods: saved.after });
            return json(200, { ok: true });
        } catch (err) {
            const e = err as Error & { status?: number };
            if (e.status === 400) return json(400, { error: e.message });
            throw err;
        }
    }

    // ── Programme settings ──────────────────────────────────────────────────────────────────
    if (body.action === 'settings') {
        const holdingDays = Number(body.holdingDays);
        const minPayoutPence = Number(body.minPayoutPence);
        if (!Number.isInteger(holdingDays) || holdingDays < 0 || holdingDays > 365) return json(400, { error: 'The holding period must be 0–365 days.' });
        if (!Number.isInteger(minPayoutPence) || minPayoutPence < 0 || minPayoutPence > 10_000_00) return json(400, { error: 'The minimum payout must be between £0 and £10,000.' });
        const [before] = await db.select().from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
        await db.insert(partnerProgrammeSettings)
            .values({ id: 1, holdingDays, minPayoutPence, updatedBy: adminId })
            .onConflictDoUpdate({ target: partnerProgrammeSettings.id, set: { holdingDays, minPayoutPence, updatedBy: adminId, updatedAt: new Date() } });
        await audit('partner_settings_update', 'programme', before ? { holdingDays: before.holdingDays, minPayoutPence: before.minPayoutPence } : undefined, { holdingDays, minPayoutPence });
        return json(200, { ok: true });
    }

    // ── Approve / reject / suspend / reinstate ──────────────────────────────────────────────
    if (body.action === 'decide') {
        const rule = DECISIONS[String(body.decision)];
        if (!rule) return json(400, { error: 'Invalid decision.' });
        const partnerId = Number(body.partnerId);
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
        const [before] = await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1);
        if (!before) return json(404, { error: 'That partner no longer exists.' });
        if (!rule.from.includes(before.status)) {
            return json(409, { error: `This partner is ${before.status}, so they cannot be ${rule.label}. Reload to see the latest.` });
        }
        // Conditional on the status read above, so two admins deciding at once cannot both win.
        const updated = await db.update(partners)
            .set({ status: rule.to, decidedBy: adminId, decidedAt: new Date(), decisionNote: note, updatedAt: new Date() })
            .where(and(eq(partners.id, partnerId), eq(partners.status, before.status)))
            .returning({ id: partners.id });
        if (!updated.length) return json(409, { error: 'Someone else changed this partner a moment ago. Reload to see the latest.' });
        await audit('partner_decision', partnerId, { status: before.status }, { status: rule.to, note });
        // Approving tells them: a welcome if they have an account, a private account link if not.
        // Best-effort — the approval stands, and "Resend account link" is there if the email failed.
        let emailed: Awaited<ReturnType<typeof sendApprovalEmail>> | null = null;
        if (rule.to === 'approved' && before.status !== 'suspended') {
            emailed = await sendApprovalEmail(db, partnerId).catch((err) => { console.error('[admin-partners] approval email failed', err); return null; });
        }
        return json(200, { ok: true, status: rule.to, emailed });
    }

    // ── Erase an application (no account, never earned) — a privacy request, or tidying up ────
    if (body.action === 'erase_application') {
        const partnerId = Number(body.partnerId);
        const ok = await deleteApplicantOnly(db, partnerId);
        if (!ok) return json(409, { error: 'Only an application with no account and no commission can be erased here. For a partner with an account, use GDPR erasure on their user.' });
        await audit('partner_decision', partnerId, undefined, { erasedApplication: true });
        return json(200, { ok: true });
    }

    // ── Partner code (invite-codes.ts): on / change / off ───────────────────────────────────
    if (body.action === 'partner_code') {
        const partnerId = Number(body.partnerId);
        const [before] = await db.select({ status: partners.status, promoCode: partners.promoCode }).from(partners).where(eq(partners.id, partnerId)).limit(1);
        if (!before) return json(404, { error: 'That partner no longer exists.' });
        if (body.code && before.status !== 'approved') return json(409, { error: 'Only an approved partner can have a partner code.' });
        const r = await setPartnerCode(db, partnerId, body.code ? String(body.code) : null);
        if (!r.ok) return json(400, { error: r.error });
        await audit('partner_code_change', partnerId, { code: before.promoCode }, { code: r.code });
        return json(200, { ok: true, code: r.code });
    }

    // ── Ledger: cancel a commission, add a bonus ────────────────────────────────────────────
    if (body.action === 'void') {
        const commissionId = Number(body.commissionId);
        const r = await voidCommission(db, commissionId, String(body.reason || ''));
        if (!r.ok) return json(409, { error: r.error });
        await audit('partner_ledger_change', commissionId, undefined, { voided: true, reason: String(body.reason || '').slice(0, 200) });
        return json(200, { ok: true });
    }
    if (body.action === 'bonus') {
        const partnerId = Number(body.partnerId);
        const r = await addBonus(db, partnerId, Number(body.amountPence), String(body.note || ''), adminId);
        if (!r.ok) return json(400, { error: r.error });
        await audit('partner_ledger_change', partnerId, undefined, { bonusPence: Number(body.amountPence), note: String(body.note || '').slice(0, 200), commissionId: r.id });
        return json(200, { ok: true, id: r.id });
    }

    // ── Payout runs ─────────────────────────────────────────────────────────────────────────
    if (body.action === 'create_batch') {
        const r = await createBatch(db, adminId);
        if (!r.ok) return json(409, { error: r.error });
        await audit('partner_payout', r.batchId, undefined, { created: true, totalPence: r.totalPence, partners: r.partnerCount });
        return json(200, r);
    }
    if (body.action === 'mark_paid' || body.action === 'cancel_batch') {
        const batchId = Number(body.batchId);
        const r = body.action === 'mark_paid' ? await markBatchPaid(db, batchId, adminId) : await cancelBatch(db, batchId);
        if (!r.ok) return json(409, { error: r.error });
        await audit('partner_payout', batchId, undefined, { [body.action === 'mark_paid' ? 'paid' : 'cancelled']: true });
        // Paid: tell each partner their payout is on its way (in-app + email; never throws).
        const notified = body.action === 'mark_paid' ? await notifyPayoutSent(db, batchId) : 0;
        return json(200, { ok: true, notified });
    }

    // ── Resend the account link (approved, no account yet) ──────────────────────────────────
    if (body.action === 'resend_invite') {
        const partnerId = Number(body.partnerId);
        const [p] = await db.select({ status: partners.status, userId: partners.userId, applicantEmail: partners.applicantEmail }).from(partners).where(eq(partners.id, partnerId)).limit(1);
        if (!p) return json(404, { error: 'That partner no longer exists.' });
        if (p.status !== 'approved' || p.userId || !p.applicantEmail) return json(409, { error: 'Only an approved partner who has not created their account yet can be sent a new link.' });
        const emailed = await sendApprovalEmail(db, partnerId);
        await audit('partner_decision', partnerId, undefined, { resentAccountLink: true, to: emailed.to });
        return json(200, { ok: true, emailed });
    }

    // ── Add an existing user as a partner ───────────────────────────────────────────────────
    if (body.action === 'create') {
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!email) return json(400, { error: 'Enter the email address of their Be More Swan account.' });
        const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (!user) return json(404, { error: 'No Be More Swan account uses that email address. They need an account first.' });
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
        const inserted = await db.insert(partners)
            .values({ userId: user.id, status: 'approved', decidedBy: adminId, decidedAt: new Date(), decisionNote: note, application: { addedByAdmin: true } })
            .onConflictDoNothing()
            .returning({ id: partners.id });
        if (!inserted.length) return json(409, { error: 'That person is already on the partner list.' });
        await audit('partner_create', inserted[0].id, undefined, { userId: user.id, status: 'approved', note });
        const emailed = await sendApprovalEmail(db, inserted[0].id).catch((err) => { console.error('[admin-partners] welcome email failed', err); return null; });
        return json(200, { ok: true, id: inserted[0].id, emailed });
    }

    return json(400, { error: 'Unknown action.' });
});
