// src/config/mentor-playbooks/2026-10-25-services.ts
// DRAFT playbook for businesses that sell SERVICES (offer kind 'services'), drafted 2026-10-25 for the
// owner's review (docs/business-mentor-plan.md §4.6). ⚠️ `reviewed: null`: the Mentor will NOT use it
// until the owner checks every point and its source and sets `reviewed` to their name and the date.
// A change after review is a new dated file, never an edit here.
//
// Sources are official pages only (GOV.UK, the Small Business Commissioner, ONS, Google's own help).
// Points marked `judgement: true` are general good practice with no source — the reviewer's call.
import type { Playbook } from './index';

const OSBC = { title: 'Office of the Small Business Commissioner — late payment', url: 'https://www.smallbusinesscommissioner.gov.uk/?p=49437' };
const GOOGLE_LOCAL = { title: 'Google Business Profile Help — how to improve your local ranking', url: 'https://support.google.com/business/answer/7091?hl=en' };
const ONS_SURVIVAL = { title: 'ONS — five-year business survival rate', url: 'https://www.ons.gov.uk/explore-local-statistics/indicators/business-survival-five-year' };
const VAT = { title: 'GOV.UK — VAT registration', url: 'https://www.gov.uk/vat-registration' };

export const SERVICES_PLAYBOOK_2026_10_25: Playbook = {
    kind: 'services',
    title: 'Running a small service business',
    dated: '2026-10-25',
    reviewed: null,
    whatGoodLooksLike: [
        { text: 'A clear service list with what is included and a price (or a "from" price) for each, so a customer can decide without a call.', sources: [], judgement: true },
        { text: 'Customers can find you locally: a complete, accurate Google Business Profile, because Google ranks local results on relevance, distance and prominence, and reviews count towards prominence.', sources: [GOOGLE_LOCAL] },
        { text: 'You are paid on time: terms agreed in writing before the work, and invoices chased promptly. Late payment is one of the most common cash-flow problems for small UK firms.', sources: [OSBC] },
    ],
    first90Days: [
        { text: 'Weeks 1–2: write down who your best customer is and the one or two services you most want to sell; fill in Products & Services with prices.', sources: [], judgement: true },
        { text: 'Weeks 2–4: complete your Google Business Profile and ask your first happy customers for a review.', sources: [GOOGLE_LOCAL] },
        { text: 'Month 2: pick one or two channels where your customers already are and post or email on a steady schedule rather than everywhere at once.', sources: [], judgement: true },
        { text: 'Month 3: look at where your enquiries actually came from, and put more effort into what worked.', sources: [], judgement: true },
    ],
    commonMistakes: [
        { text: 'Starting work without agreed payment terms, then chasing money later.', sources: [OSBC] },
        { text: 'Pricing by the hour without counting travel, admin and quoting time, so busy weeks still don’t pay.', sources: [], judgement: true },
        { text: 'Losing track of turnover against the VAT registration threshold — check the current figure on GOV.UK, and speak to an accountant.', sources: [VAT] },
    ],
    measures: [
        { text: 'Enquiries a week, and where each came from.', sources: [], judgement: true },
        { text: 'How many enquiries become paid jobs.', sources: [], judgement: true },
        { text: 'Money owed to you and how many days it is overdue.', sources: [OSBC] },
        { text: 'Staying power: many new UK businesses don’t reach five years, so watch cash, not just sales.', sources: [ONS_SURVIVAL] },
    ],
};
