// src/utils/partner-disputes.ts
// Partner Terms 4.3: a dispute that closes in our favour ('won', or an issuer inquiry closed as 'warning_closed')
// puts the partner's commission back — but only when no OTHER dispute on the same charge still threatens the money.
// Pure, so every case is tested (tests/partner-disputes.test.ts). Used by netlify/functions/stripe-webhook.ts.

/**
 * Statuses of a sibling dispute that do NOT block reinstating:
 *   won / warning_closed — closed in our favour;
 *   prevented            — stopped by a prevention refund: the money went back, so the refund (counted when the
 *                          commission is recomputed) already brings it to ~£0; blocking would leave it voided for good,
 *                          because a prevented dispute never sends a close event (review of #826).
 * Anything else (needs_response, under_review, warning_needs_response, warning_under_review, lost) blocks.
 */
const NON_BLOCKING = new Set(['won', 'warning_closed', 'prevented']);

export function otherDisputeBlocksReinstate(disputesOnCharge: Array<{ id: string; status: string }>, closingDisputeId: string): boolean {
    return disputesOnCharge.some((d) => d.id !== closingDisputeId && !NON_BLOCKING.has(d.status));
}
