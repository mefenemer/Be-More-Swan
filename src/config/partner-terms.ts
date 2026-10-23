// src/config/partner-terms.ts
// The current Partner Terms (partner-terms.html). Bump PARTNER_TERMS_VERSION when the page changes in
// a way partners must accept: their Partner page then asks every partner to accept again
// (partner-hub.ts accept_terms), and partners.terms_version records who has.
export const PARTNER_TERMS_VERSION = '1.1';   // 1.1: commission is after a cost deduction (3.2, 3.3)
export const PARTNER_TERMS_UPDATED = '22 October 2026';

/**
 * Has this partner accepted the Terms in force now? Until they have, commission still builds up but
 * is left out of payout runs (partner-payout-batches.ts) and the Partner Assistant won't draft
 * promotion (partner-assistant.ts). Admin-added partners start with none accepted, so this covers
 * them too. Legal review 2026-10-23 (H1): no payout or promotion without a contract.
 */
export function hasAcceptedCurrentTerms(termsVersion: string | null | undefined): boolean {
    return termsVersion === PARTNER_TERMS_VERSION;
}
