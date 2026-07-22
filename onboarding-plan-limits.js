// onboarding-plan-limits.js
// Single source of truth for the plan limits the onboarding wizards enforce in the UI.
//
// These limits used to be a hardcoded `{ tierKey: { maxApps, maxSteps } }` map copy-pasted into
// four onboarding pages and keyed off sessionStorage.aura_tier. Two problems with that:
//
//   1. The map was ordered by the OLD plan ordering (buster as the entry plan), so after the plans
//      were re-ordered it gated the £99 plan harder than the £29 one.
//   2. A hardcoded map can't see plans.featureOverrides — the per-subscription snapshot that
//      grandfathers an existing subscriber onto their previous limits when a plan's limits are
//      reduced. A grandfathered customer would keep their real limit server-side but still hit
//      the tightened gate in the wizard.
//
// check-capacity resolves both (it reads master_plans through effectiveLimit, which prefers the
// per-subscription snapshot), so ask it rather than guessing. The sessionStorage tier is kept only
// as the pre-fetch fallback, so the wizard is never blocked waiting on the network.

(function () {
    // Mirrors master_plans.app_connection_limit / the published pricing cards. Only used until
    // check-capacity answers — the live column wins whenever it's reachable.
    const MAX_APPS_BY_TIER  = { saver: 4, buster: 10, employee: 15 };
    // Workflow-step ceilings have no master_plans column, so they stay tier-keyed — but off the
    // tier check-capacity reports, not whatever sessionStorage happens to hold. Ordered entry → top.
    const MAX_STEPS_BY_TIER = { saver: 1, buster: 4, employee: 5 };
    // Used when the tier is unknown AND check-capacity is unreachable. Entry-plan limits, so a
    // failure never silently over-grants.
    const FALLBACK = { maxApps: 2, maxSteps: 1, tierKey: null };

    let _cache = null;

    /** Synchronous best guess from a tier key — the pre-fetch value the wizards start from. */
    window.planLimitsForTier = function (tierKey) {
        if (!tierKey || !(tierKey in MAX_STEPS_BY_TIER)) return { ...FALLBACK };
        return { maxApps: MAX_APPS_BY_TIER[tierKey], maxSteps: MAX_STEPS_BY_TIER[tierKey], tierKey };
    };

    /**
     * The real limits for the signed-in workspace, from check-capacity (override-aware).
     * Falls back to `fallbackTierKey`'s static limits if the call fails, so onboarding still works
     * offline / logged out. Cached for the page — limits don't change mid-wizard.
     */
    window.getOnboardingPlanLimits = async function (fallbackTierKey) {
        if (_cache) return _cache;
        try {
            const res = await fetch('/.netlify/functions/check-capacity');
            if (res.ok) {
                const cap = await res.json();
                _cache = {
                    // null from check-capacity means UNLIMITED — keep it unlimited rather than
                    // letting `null` collapse to 0 and lock the user out of every integration.
                    maxApps: cap.appConnectionLimit == null ? Infinity : cap.appConnectionLimit,
                    maxSteps: MAX_STEPS_BY_TIER[cap.tierKey] ?? FALLBACK.maxSteps,
                    tierKey: cap.tierKey || null,
                };
                return _cache;
            }
        } catch { /* fall through to the static fallback */ }
        return window.planLimitsForTier(fallbackTierKey);
    };
})();
