// plan-prices.js — fills plan prices from master data (get-plans → master_plans).
//
// No page writes a plan price into its own markup (owner, 2026-10-19): a hardcoded "£79" outlived
// the move to £69 on five surfaces. Mark the spot instead and this fills it:
//
//   <span data-plan-price="buster"></span>          → "£69" (monthly, from master data)
//   <span data-plan-prices-ready hidden>…</span>    → shown only once every price inside it is
//                                                     known, so a sentence never reads "Plans are or a month"
//
// Runs on load; pages that render HTML later call window.PlanPrices.fill(container) after it.
(function () {
    let _plans = null;

    function load() {
        if (!_plans) {
            _plans = fetch('/.netlify/functions/get-plans')
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => (d && Array.isArray(d.plans) ? d.plans : []))
                .catch(() => []);
        }
        return _plans;
    }

    function format(amount) {
        return '£' + Number(amount).toLocaleString('en-GB', { maximumFractionDigits: 2 });
    }

    async function fill(root) {
        const scope = root || document;
        const plans = await load();
        const byTier = {};
        plans.forEach((p) => { if (p && p.tierKey) byTier[p.tierKey] = p; });
        scope.querySelectorAll('[data-plan-price]').forEach((el) => {
            const plan = byTier[el.getAttribute('data-plan-price')];
            if (plan && Number(plan.monthlyPriceGbp) > 0) el.textContent = format(plan.monthlyPriceGbp);
        });
        scope.querySelectorAll('[data-plan-prices-ready]').forEach((el) => {
            const inner = Array.from(el.querySelectorAll('[data-plan-price]'));
            const known = inner.every((x) => Number(byTier[x.getAttribute('data-plan-price')]?.monthlyPriceGbp) > 0);
            if (known) { el.hidden = false; el.style.display = ''; }
        });
    }

    window.PlanPrices = { load, fill, format };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fill());
    else fill();
})();
