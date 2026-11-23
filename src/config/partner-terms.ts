// src/config/partner-terms.ts
// The current Partner Terms (partner-terms.html). Bump PARTNER_TERMS_VERSION when the page changes in
// a way partners must accept: their Partner page then asks every partner to accept again
// (partner-hub.ts accept_terms), and partners.terms_version records who has.
// 1.1: commission is after a cost deduction (3.2, 3.3).
// 1.2: legal review 2026-10-23 — ad label first + international rules (5.1, 5.3, 5.5), 30 days' notice
//      of changes (3.3, 8.1), clawback as a debt (4.3), tax (4.5), immediate ending + 7.4, data roles
//      (9.3), liability cap + indemnity (10), courts carve-out (11). docs/legal/partner-terms-v1.2-changes.md
// 1.3: launch contract, before the first partner (no partners had accepted 1.2): commission on
//      Subscription Payments only + fixed deduction (3.2), caps 24 months / 40% / 20% (3.5), customers
//      are ours (6.3), closure run-off (7.2), sub-minimum balance paid on ending (7.3), staying active
//      (7.5). docs/legal/partner-terms-v1.3-activity-draft.md
//      Also 4.2: payment through Wise to a US bank account or a euro bank account (IBAN), converted to US dollars
//      or euros at Wise's rate on the day (owner requests 2026-11-23). docs/legal/partner-terms-v1.3-changes.md
export const PARTNER_TERMS_VERSION = '1.3';
export const PARTNER_TERMS_UPDATED = '23 November 2026';
/**
 * When the current version took effect (ISO date). Terms 8.1: a partner who has not accepted it 60 days
 * after this is treated as leaving (7.1) and keeps the 7.4(a) run-off — partner-activity.ts endDeclinedChanges.
 * Bump with the version: the date the new version's notice period ended.
 */
export const PARTNER_TERMS_EFFECTIVE = '2026-11-23';
export const DECLINED_CHANGE_DAYS = 60;

/**
 * Has this partner accepted the Terms in force now? Until they have, commission still builds up but
 * is left out of payout runs (partner-payout-batches.ts) and the Partner Assistant won't draft
 * promotion (partner-assistant.ts). Admin-added partners start with none accepted, so this covers
 * them too. Legal review 2026-10-23 (H1): no payout or promotion without a contract.
 */
export function hasAcceptedCurrentTerms(termsVersion: string | null | undefined): boolean {
    return termsVersion === PARTNER_TERMS_VERSION;
}
