// src/utils/partner-ops-proposals.ts
// The Partner Ops chat's action cards (admin-partners-chat.ts). The chat never writes: it proposes,
// and the card's button sends EXACTLY the request the Partners screen's own buttons send to
// admin-partners.ts — the same server action, the same validation, the same audit row
// (memory assistant-gui-chat-parity).
//
// A proposal is checked here before it is offered, so the admin is not shown a card that is
// bound to fail; admin-partners.ts checks again when it is clicked (state may have moved on).
// Pure — the caller loads the periods and partners.

import { DEFAULT_COST_DEDUCTION_BPS, ukMidnightUtc, validatePeriodChanges, type PeriodChange, type RatePeriod } from './partner-rate-periods';
import { validatePartnerCode } from './invite-codes';

export interface PartnerLite { id: number; status: string; name: string | null; email: string | null; hasAccount?: boolean }

/** What the card's button POSTs to admin-partners.ts, verbatim. */
export type AdminPartnersRequest =
    | { action: 'decide'; partnerId: number; decision: 'approve' | 'reject' | 'suspend' | 'reinstate' | 'end'; note: string | null }
    | { action: 'rates'; partnerId: number | null; changes: Array<Record<string, unknown>> }
    | { action: 'settings'; holdingDays: number; minPayoutPence: number }
    | { action: 'create'; email: string; note: string | null }
    | { action: 'resend_invite'; partnerId: number }
    | { action: 'void'; commissionId: number; reason: string }
    | { action: 'bonus'; partnerId: number; amountPence: number; note: string }
    | { action: 'create_batch' }
    | { action: 'mark_paid'; batchId: number }
    | { action: 'cancel_batch'; batchId: number }
    | { action: 'partner_code'; partnerId: number; code: string | null }
    | { action: 'erase_application'; partnerId: number };

export interface ActionCard { kind: string; title: string; summary: string; request: AdminPartnersRequest }
export type ProposalResult = { card: ActionCard } | { error: string };

// A partner approved without an account gets a one-time sign-up link by email (partner-applications.ts).
const DECISION_FROM: Record<string, string[]> = {
    approve: ['applied', 'rejected', 'ended'], reject: ['applied'], suspend: ['approved'], reinstate: ['suspended'], end: ['approved', 'suspended'],
};
const pct = (bps: number) => `${bps / 100}%`;
const len = (m: number | null) => m == null ? 'for as long as the customer stays' : `for ${m} month${m === 1 ? '' : 's'} of each customer's payments`;
const who = (p: PartnerLite) => p.name || p.email || `partner #${p.id}`;
const ukDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

function toBps(ratePercent: unknown): number | null {
    const n = Number(ratePercent);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
}
/** Not given → the programme's newest deduction, so a new rate keeps the costs basis partners were told. */
function toDeductionBps(costDeductionPercent: unknown, periods: RatePeriod[]): number | null {
    if (costDeductionPercent == null || costDeductionPercent === '') {
        const latest = [...periods.filter((p) => p.partnerId === null)].sort((a, b) => +a.startsAt - +b.startsAt).pop();
        return latest?.costDeductionBps ?? DEFAULT_COST_DEDUCTION_BPS;
    }
    const n = Number(costDeductionPercent);
    return Number.isFinite(n) && n >= 0 && n < 100 ? Math.round(n * 100) : null;
}
const afterCosts = (bps: number) => bps > 0 ? ` of what each customer pays after a ${pct(bps)} cost deduction` : ' of what each customer pays';
function toMonths(m: unknown): number | null | 'invalid' {
    if (m == null) return null;
    const n = Number(m);
    return Number.isInteger(n) && n >= 1 && n <= 120 ? n : 'invalid';
}

/** Check rate changes the same way admin-partners.ts will, translating days to instants first. */
function checkRates(periods: RatePeriod[], partnerId: number | null, changes: Array<Record<string, any>>, now: Date): string[] {
    const scope = periods.filter((p) => (p.partnerId ?? null) === partnerId);
    const parsed: PeriodChange[] = changes.map((c) => {
        const ex = c.op === 'update' ? scope.find((p) => p.id === c.id) : undefined;
        const day = (v: unknown, keep: Date | null | undefined) => v === undefined ? keep ?? null : (v === null ? null : ukMidnightUtc(String(v)));
        return c.op === 'update'
            ? { op: 'update', id: c.id, period: { partnerId, rateBps: c.period.rateBps ?? ex!.rateBps, costDeductionBps: c.period.costDeductionBps ?? ex!.costDeductionBps, durationMonths: c.period.durationMonths === undefined ? ex!.durationMonths : c.period.durationMonths, startsAt: day(c.period.startsOn, ex?.startsAt)!, endsAt: day(c.period.endsOn, ex?.endsAt) } }
            : { op: 'create', period: { partnerId, rateBps: c.period.rateBps, costDeductionBps: c.period.costDeductionBps, durationMonths: c.period.durationMonths, startsAt: day(c.period.startsOn, null)!, endsAt: day(c.period.endsOn, null) } };
    });
    if (parsed.some((c) => c.op !== 'delete' && !c.period.startsAt)) return ['That is not a real date — use YYYY-MM-DD.'];
    return validatePeriodChanges(scope, parsed, now);
}

export function proposeDecision(partners: PartnerLite[], input: { partnerId: unknown; decision: unknown; note?: unknown }): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    const decision = String(input.decision) as 'approve' | 'reject' | 'suspend' | 'reinstate' | 'end';
    if (!DECISION_FROM[decision]) return { error: 'The decision must be approve, reject, suspend, reinstate or end.' };
    if (!DECISION_FROM[decision].includes(p.status)) return { error: `${who(p)} is ${p.status}, so they cannot be ${decision === 'reinstate' ? 'reinstated' : decision === 'end' ? 'ended' : decision + 'd'}.` };
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : null;
    const verb = { approve: 'Approve', reject: 'Reject', suspend: 'Suspend', reinstate: 'Reinstate', end: 'End the partnership with' }[decision];
    const effect = {
        approve: 'They start earning cash on customers who first pay from now on.',
        reject: 'Their application is turned down. They can be approved later.',
        suspend: 'They stop earning on new payments straight away. Commission already earned is kept.',
        reinstate: 'They start earning again on new payments.',
        end: 'They left, or we are ending it (Partner Terms 7.1 / 7.2). They stop earning on new payments, including from customers they introduced earlier. Their partner code stops working, and their invite link becomes an ordinary customer invite (free months, not cash). Commission they earned before today is still paid. They can be approved again later.',
    }[decision];
    return { card: { kind: 'decision', title: `${verb} ${who(p)}`, summary: effect + (note ? ` Reason: ${note}` : ''),
        request: { action: 'decide', partnerId: p.id, decision, note } } };
}

export function proposeProgrammeRate(periods: RatePeriod[], input: { ratePercent: unknown; costDeductionPercent?: unknown; durationMonths: unknown; startsOn: unknown }, now = new Date()): ProposalResult {
    const rateBps = toBps(input.ratePercent);
    const costDeductionBps = toDeductionBps(input.costDeductionPercent, periods);
    const durationMonths = toMonths(input.durationMonths);
    const startsOn = String(input.startsOn ?? '');
    if (rateBps === null) return { error: 'The rate must be between 0% and 100%.' };
    if (costDeductionBps === null) return { error: 'The cost deduction must be at least 0% and less than 100%.' };
    if (durationMonths === 'invalid') return { error: 'The length must be 1–120 months, or null for lifetime.' };
    if (!ukMidnightUtc(startsOn)) return { error: 'The start date must be a real date, YYYY-MM-DD.' };
    const latest = [...periods.filter((p) => p.partnerId === null)].sort((a, b) => +a.startsAt - +b.startsAt).pop();
    const changes: Array<Record<string, any>> = [];
    if (latest) changes.push({ op: 'update', id: latest.id, period: { endsOn: startsOn } });
    changes.push({ op: 'create', period: { rateBps, costDeductionBps, durationMonths, startsOn, endsOn: null, label: null } });
    const errors = checkRates(periods, null, changes, now);
    if (errors.length) return { error: errors.join(' ') };
    return { card: { kind: 'programme_rate', title: `Programme rate ${pct(rateBps)} from ${ukDate(startsOn)}`,
        summary: `New partner customers who first pay from ${ukDate(startsOn)} earn their partner ${pct(rateBps)}${afterCosts(costDeductionBps)}, ${len(durationMonths)}. The current rate ends that day; customers who already paid keep their rate.`,
        request: { action: 'rates', partnerId: null, changes } } };
}

export function proposeSpecialRate(periods: RatePeriod[], partners: PartnerLite[],
    input: { partnerId: unknown; ratePercent: unknown; costDeductionPercent?: unknown; durationMonths: unknown; startsOn: unknown; endsOn: unknown }, now = new Date()): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    const rateBps = toBps(input.ratePercent);
    const costDeductionBps = toDeductionBps(input.costDeductionPercent, periods);
    const durationMonths = toMonths(input.durationMonths);
    const startsOn = String(input.startsOn ?? '');
    const endsOn = input.endsOn == null || input.endsOn === '' ? null : String(input.endsOn);
    if (rateBps === null) return { error: 'The rate must be between 0% and 100%.' };
    if (costDeductionBps === null) return { error: 'The cost deduction must be at least 0% and less than 100%.' };
    if (durationMonths === 'invalid') return { error: 'The length must be 1–120 months, or null for lifetime.' };
    if (!ukMidnightUtc(startsOn) || (endsOn && !ukMidnightUtc(endsOn))) return { error: 'Dates must be real dates, YYYY-MM-DD.' };
    const changes = [{ op: 'create', period: { rateBps, costDeductionBps, durationMonths, startsOn, endsOn, label: null } }];
    const errors = checkRates(periods, p.id, changes, now);
    if (errors.length) return { error: errors.join(' ') };
    return { card: { kind: 'special_rate', title: `${pct(rateBps)} special rate for ${who(p)}`,
        summary: `Their new customers who first pay from ${ukDate(startsOn)}${endsOn ? ` until ${ukDate(endsOn)}` : ''} earn them ${pct(rateBps)}${afterCosts(costDeductionBps)}, ${len(durationMonths)}, instead of the programme rate.`,
        request: { action: 'rates', partnerId: p.id, changes } } };
}

export function proposeEndSpecialRate(periods: RatePeriod[], partners: PartnerLite[], input: { partnerId: unknown; periodId: unknown; endsOn: unknown }, now = new Date()): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    const period = periods.find((x) => x.id === Number(input.periodId) && x.partnerId === p.id);
    if (!period) return { error: `${who(p)} has no special rate #${input.periodId}.` };
    const endsOn = String(input.endsOn ?? '');
    if (!ukMidnightUtc(endsOn)) return { error: 'The end date must be a real date, YYYY-MM-DD.' };
    const changes = [{ op: 'update', id: period.id, period: { endsOn } }];
    const errors = checkRates(periods, p.id, changes, now);
    if (errors.length) return { error: errors.join(' ') };
    return { card: { kind: 'end_special_rate', title: `End ${who(p)}'s ${pct(period.rateBps)} special rate on ${ukDate(endsOn)}`,
        summary: 'From that day their new customers earn the programme rate. Customers who already paid keep the rate they got.',
        request: { action: 'rates', partnerId: p.id, changes } } };
}

export function proposePayoutRules(input: { holdingDays: unknown; minPayoutPounds: unknown }): ProposalResult {
    const holdingDays = Number(input.holdingDays);
    const pounds = Number(input.minPayoutPounds);
    if (!Number.isInteger(holdingDays) || holdingDays < 0 || holdingDays > 365) return { error: 'The holding period must be 0–365 days.' };
    if (!Number.isFinite(pounds) || pounds < 0 || pounds > 10_000) return { error: 'The minimum payout must be £0–£10,000.' };
    return { card: { kind: 'payout_rules', title: `Hold commission ${holdingDays} days, pay out from £${pounds}`,
        summary: 'Applies to new commissions. Balances under the minimum roll over to the next payout.',
        request: { action: 'settings', holdingDays, minPayoutPence: Math.round(pounds * 100) } } };
}

export function proposeAddPartner(partners: PartnerLite[], input: { email: unknown; note?: unknown }): ProposalResult {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'That is not an email address.' };
    if (partners.some((p) => (p.email || '').toLowerCase() === email)) return { error: `${email} is already on the partner list.` };
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : null;
    return { card: { kind: 'add_partner', title: `Add ${email} as a partner`,
        summary: 'They join approved, on the programme rate. They need a Be More Swan account with this email.',
        request: { action: 'create', email, note } } };
}

export function proposeResendInvite(partners: PartnerLite[], input: { partnerId: unknown }): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    if (p.status !== 'approved' || p.hasAccount) return { error: `${who(p)} ${p.hasAccount ? 'already has an account' : `is ${p.status}`}, so there is no account link to send.` };
    return { card: { kind: 'resend_invite', title: `Send ${who(p)} a new account link`,
        summary: 'Emails them a fresh private link to set up their partner account. Any earlier link stops working.',
        request: { action: 'resend_invite', partnerId: p.id } } };
}

// ── Ledger and payouts (partner-payout-batches.ts) ───────────────────────────────────────────

export interface LedgerLite { id: number; partnerId: number; status: string; amountPence: number; inBatch: boolean; who: string }
export interface BatchLite { id: number; status: string; totalPence: number; partnerCount: number }
const money = (p: number) => `£${(p / 100).toFixed(2)}`;

export function proposeVoidCommission(ledger: LedgerLite[], input: { commissionId: unknown; reason: unknown }): ProposalResult {
    const c = ledger.find((x) => x.id === Number(input.commissionId));
    if (!c) return { error: `There is no commission #${input.commissionId} in the recent ledger.` };
    const label: Record<string, string> = { paid: 'already paid', voided: 'already cancelled' };
    if (!['pending', 'payable'].includes(c.status)) return { error: `Commission #${c.id} is ${label[c.status] || c.status} — only waiting or ready-to-pay commission can be cancelled.` };
    if (c.inBatch) return { error: `Commission #${c.id} is already in a payout run — cancel the run first if it shouldn't be paid.` };
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
    if (!reason) return { error: 'A reason is needed — the partner sees it.' };
    return { card: { kind: 'void', title: `Cancel ${money(c.amountPence)} commission for ${c.who}`, summary: `It won't be paid. Reason shown to the partner: ${reason}`,
        request: { action: 'void', commissionId: c.id, reason } } };
}

export function proposeBonus(partners: PartnerLite[], input: { partnerId: unknown; amountPounds: unknown; note: unknown }): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    if (p.status !== 'approved' && p.status !== 'suspended') return { error: `${who(p)} is ${p.status}; bonuses are for approved partners.` };
    const amountPence = Math.round(Number(input.amountPounds) * 100);
    if (!Number.isInteger(amountPence) || amountPence <= 0 || amountPence > 1_000_000) return { error: 'A bonus must be between £0.01 and £10,000.' };
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    if (!note) return { error: 'A note is needed — the partner sees it as the reason.' };
    return { card: { kind: 'bonus', title: `${money(amountPence)} bonus for ${who(p)}`, summary: `Ready to pay straight away, in the next payout run. Note shown to them: ${note}`,
        request: { action: 'bonus', partnerId: p.id, amountPence, note } } };
}

export function proposeCreateBatch(preview: { lines: Array<{ due: boolean; amountPence: number }>; totalDuePence: number }): ProposalResult {
    const due = preview.lines.filter((l) => l.due);
    if (!due.length) return { error: 'Nobody is due a payout right now.' };
    return { card: { kind: 'create_batch', title: `Create a payout run: ${due.length} partner${due.length === 1 ? '' : 's'}, ${money(preview.totalDuePence)}`,
        summary: 'Sets their ready-to-pay commission aside for this run. Then download the payment files on the screen (Payouts) and pay them in Wise / PayPal.',
        request: { action: 'create_batch' } } };
}

export function proposeBatchStatus(batches: BatchLite[], input: { batchId: unknown }, to: 'mark_paid' | 'cancel_batch'): ProposalResult {
    const b = batches.find((x) => x.id === Number(input.batchId));
    if (!b) return { error: `There is no payout run #${input.batchId}.` };
    if (b.status !== 'draft' && b.status !== 'exported') return { error: `Run #${b.id} is ${b.status}.` };
    return to === 'mark_paid'
        ? { card: { kind: 'mark_paid', title: `Mark payout run #${b.id} paid (${money(b.totalPence)})`, summary: 'Only once the money has actually gone out in Wise / PayPal. Partners will see it as paid.', request: { action: 'mark_paid', batchId: b.id } } }
        : { card: { kind: 'cancel_batch', title: `Cancel payout run #${b.id}`, summary: 'Its commission goes back to ready-to-pay for the next run. If anyone in it has been paid, mark it paid instead.', request: { action: 'cancel_batch', batchId: b.id } } };
}

/** A memorable partner code on / changed (code) or off (null). Uniqueness is checked when it is saved. */
export function proposePartnerCode(partners: PartnerLite[], input: { partnerId: unknown; code: unknown }): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    if (input.code == null || input.code === '') {
        return { card: { kind: 'partner_code', title: `Turn off ${who(p)}'s partner code`, summary: 'It stops working straight away. Customers who already used it stay theirs; their invite link keeps working.', request: { action: 'partner_code', partnerId: p.id, code: null } } };
    }
    if (p.status !== 'approved') return { error: `${who(p)} is ${p.status}; only approved partners can have a partner code.` };
    const v = validatePartnerCode(input.code);
    if (!v.ok) return { error: v.error };
    return { card: { kind: 'partner_code', title: `Partner code ${v.code} for ${who(p)}`,
        summary: 'Works anywhere their link does — "Invited by" at sign-up, /invite/' + v.code + ', and "Have an invite code?" on the plan picker. New customers get the normal invite offer.',
        request: { action: 'partner_code', partnerId: p.id, code: v.code } } };
}

/** Delete an application with no account (a privacy request). The server refuses one with an account or commission. */
export function proposeEraseApplication(partners: PartnerLite[], input: { partnerId: unknown }): ProposalResult {
    const p = partners.find((x) => x.id === Number(input.partnerId));
    if (!p) return { error: `There is no partner #${input.partnerId}.` };
    if (p.hasAccount || (p.status !== 'applied' && p.status !== 'rejected')) return { error: `${who(p)} has an account or is a partner — use GDPR erasure on their user instead.` };
    return { card: { kind: 'erase_application', title: `Erase ${who(p)}'s application`, summary: 'Their name, email and answers are deleted for good. This cannot be undone.', request: { action: 'erase_application', partnerId: p.id } } };
}
