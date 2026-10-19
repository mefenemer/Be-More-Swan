// src/utils/subscription-cancel-state.ts
//
// Keeps a plans row's 'cancelling' status in step with Stripe's own "cancel at the end of the
// period" flag, whichever side changed it.
//
// WHY (found 2026-10-19, prod org 43). billing-cancel.ts and cancellation-survey.ts set a plan to
// 'cancelling', but nothing ever set it back. A customer won back by removing the cancellation in
// the Stripe dashboard stayed 'cancelling' in our database, so Admin ▸ Override Subscription refused
// them ("No active Stripe subscription found") and the billing page still treated them as leaving.
// The reverse gap existed too: a cancellation made in Stripe's customer portal or dashboard never
// marked the plan 'cancelling' here.
//
// Only 'active' ↔ 'cancelling' moves. Every other status ('downgrading', 'past_due', 'cancelled'…)
// belongs to another flow and is left alone.

export interface SubscriptionCancelFacts {
    status: string;                    // Stripe subscription status
    cancel_at_period_end?: boolean | null;
    cancel_at?: number | null;         // a fixed cancellation date, which some Stripe flows set instead
}

/** True when Stripe has the subscription set to end. */
export function stripeWillCancel(sub: SubscriptionCancelFacts): boolean {
    return !!sub.cancel_at_period_end || (typeof sub.cancel_at === 'number' && sub.cancel_at > 0);
}

/** The status our plans row should move to, or null to leave it as it is. */
export function planStatusForCancelFlag(currentPlanStatus: string | null | undefined, sub: SubscriptionCancelFacts): 'active' | 'cancelling' | null {
    if (!['active', 'trialing'].includes(sub.status)) return null;
    const ending = stripeWillCancel(sub);
    if (currentPlanStatus === 'cancelling' && !ending) return 'active';
    if (currentPlanStatus === 'active' && ending) return 'cancelling';
    return null;
}
