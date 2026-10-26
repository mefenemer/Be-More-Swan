// src/config/mentor-playbooks/2026-10-25-products.ts
// DRAFT playbook for businesses that sell PRODUCTS (offer kind 'products'), drafted 2026-10-25 for the
// owner's review (docs/business-mentor-plan.md §4.6). ⚠️ `reviewed: null`: the Mentor will NOT use it
// until the owner checks every point and its source and sets `reviewed` to their name and the date.
// A change after review is a new dated file, never an edit here.
//
// Sources are official pages only (GOV.UK, ONS). Points marked `judgement: true` are general good practice
// with no source — the reviewer's call.
import type { Playbook } from './index';

const DISTANCE = { title: 'GOV.UK — online and distance selling for businesses', url: 'https://www.gov.uk/online-and-distance-selling-for-businesses' };
const CANCEL = { title: 'GOV.UK — online and distance selling: cancellations', url: 'https://www.gov.uk/online-and-distance-selling-for-businesses/cancellations' };
const ONS_SURVIVAL = { title: 'ONS — five-year business survival rate', url: 'https://www.ons.gov.uk/explore-local-statistics/indicators/business-survival-five-year' };
const VAT = { title: 'GOV.UK — VAT registration', url: 'https://www.gov.uk/vat-registration' };

export const PRODUCTS_PLAYBOOK_2026_10_25: Playbook = {
    kind: 'products',
    title: 'Selling products as a small business',
    dated: '2026-10-25',
    reviewed: null,
    whatGoodLooksLike: [
        { text: 'Every product listed with a clear photo, price and what makes it worth buying, so customers can decide on their own.', sources: [], judgement: true },
        { text: 'Selling online meets the distance-selling rules: the information customers must get before they buy, and their right to cancel.', sources: [DISTANCE] },
        { text: 'You know what each sale costs you to make, pack and deliver, so you know what it really earns (the break-even calculator on the Plan tab helps).', sources: [], judgement: true },
    ],
    first90Days: [
        { text: 'Weeks 1–2: choose the few products you most want to sell and fill in Products & Services with prices.', sources: [], judgement: true },
        { text: 'Weeks 2–4: check your returns and cancellation wording against GOV.UK’s guidance before you sell online.', sources: [CANCEL] },
        { text: 'Month 2: show the products where your customers already look, on a steady schedule.', sources: [], judgement: true },
        { text: 'Month 3: see which products and channels actually sold, and cut what didn’t.', sources: [], judgement: true },
    ],
    commonMistakes: [
        { text: 'Not telling online customers about their right to cancel — GOV.UK says they can then cancel for up to 12 months.', sources: [CANCEL] },
        { text: 'Pricing from the cost of the product alone, leaving out postage, packaging, fees and returns.', sources: [], judgement: true },
        { text: 'Losing track of turnover against the VAT registration threshold — check the current figure on GOV.UK, and speak to an accountant.', sources: [VAT] },
    ],
    measures: [
        { text: 'Orders a week and the average order value.', sources: [], judgement: true },
        { text: 'What each sale earns after its own costs.', sources: [], judgement: true },
        { text: 'Returns and cancellations, and why.', sources: [], judgement: true },
        { text: 'Staying power: many new UK businesses don’t reach five years, so watch cash, not just sales.', sources: [ONS_SURVIVAL] },
    ],
};
