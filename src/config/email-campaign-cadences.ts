// src/config/email-campaign-cadences.ts
// The default shape of each kind of email campaign: how many emails, on which day, doing which job.
//
// ONE LIST, TWO READERS. The chat prompt (chat-orchestrator.ts, via campaignCadencePromptBlock) and
// the Email Studio's campaign builder (newsletter.js, served through the newsletter-issues GET) both
// start from these. They used to be two copies — prose in the prompt and nothing in the Studio — and
// two copies of a default is how the chat suggests Day 3 while the Studio suggests Day 2.
//
// Every value here is a SUGGESTION. The user changes days, adds and removes emails, in both places.
// "Day 1" is the day the reader enters the campaign.

import type { CampaignType } from '../utils/newsletter-campaign-chat-draft';

export interface CadenceStep {
    day: number;
    /** This email's one job, in a few words. Becomes CampaignEmail.role. */
    role: string;
}

export interface CampaignCadence {
    type: CampaignType;
    label: string;
    /** One line for the picker. */
    description: string;
    /** The outcome, phrased as something the reader has DONE. Prefills the goal field. */
    goal: string;
    /** Rules the drafting must keep for this kind — said to the model, shown to nobody. */
    note?: string;
    /** Whether "everyone who subscribes" is the natural audience — preselects the welcome path. */
    suggestsSubscribed?: boolean;
    steps: CadenceStep[];
}

export const CAMPAIGN_CADENCES: CampaignCadence[] = [
    {
        type: 'onboarding', label: 'Onboarding / welcome',
        description: 'Get a new subscriber or customer to their first real result.',
        goal: 'Gets their first real result from us.',
        suggestsSubscribed: true,
        steps: [
            { day: 1, role: 'Welcome and the one first step' },
            { day: 3, role: 'First value — one how-to' },
            { day: 7, role: 'Check-in on the common sticking point' },
            { day: 14, role: 'The next step' },
        ],
    },
    {
        type: 'renewal', label: 'Renewal reminders',
        description: 'Starts 30 days before the renewal date.',
        goal: 'Renews before the date.',
        note: 'Always say how to change or cancel — a renewal email that hides the way out costs trust.',
        steps: [
            { day: 1, role: '30 days before — heads-up and what they have had' },
            { day: 16, role: '14 days before — what they would lose' },
            { day: 23, role: '7 days before — plain reminder' },
            { day: 29, role: '1 day before — short final notice' },
        ],
    },
    {
        type: 'upgrade', label: 'Upgrade',
        description: 'Move people to a higher plan or the next product.',
        goal: 'Moves to the higher plan.',
        note: 'Mention an offer ONLY if one was given. A final "last chance" email only with a real deadline.',
        steps: [
            { day: 1, role: 'The gap, or what the next tier unlocks' },
            { day: 4, role: 'One concrete example of it in use' },
            { day: 8, role: 'The ask' },
        ],
    },
    {
        type: 'winback', label: 'Cancellation / win-back',
        description: 'Learn why people left, and bring back the ones who could return.',
        goal: 'Tells us why they left, or comes back.',
        note: 'No guilt, and never imply they are obliged to come back. A come-back offer ONLY if one was given.',
        steps: [
            { day: 1, role: 'Thanks, and one question about why they left' },
            { day: 7, role: 'The common reasons people leave, and what has changed' },
            { day: 21, role: 'The door is open' },
            { day: 45, role: 'Goodbye for now' },
        ],
    },
    {
        type: 'reengagement', label: 'Re-engagement',
        description: 'Wake up quiet subscribers, or let them go cleanly.',
        goal: 'Opens, clicks, or chooses to leave.',
        note: 'The last email says plainly that they can unsubscribe if this is no longer useful.',
        steps: [
            { day: 1, role: '"Still want these?"' },
            { day: 5, role: 'The best of what they missed' },
            { day: 12, role: 'Last check' },
        ],
    },
    {
        type: 'launch', label: 'Launch / event',
        description: 'Counted back from a fixed date.',
        goal: 'Registers, attends or buys on the day.',
        steps: [
            { day: 1, role: '14 days before — announcement' },
            { day: 8, role: '7 days before — details and the reason to go' },
            { day: 14, role: '1 day before — reminder' },
            { day: 16, role: '1 day after — thanks or next step' },
        ],
    },
    {
        type: 'custom', label: 'Something else',
        description: 'Your own process — one email for each point where the reader has to do something.',
        goal: '',
        steps: [
            { day: 1, role: 'Welcome and the first step' },
            { day: 4, role: 'The next step' },
            { day: 8, role: 'Wrap up' },
        ],
    },
];

export function cadenceFor(type: unknown): CampaignCadence {
    return CAMPAIGN_CADENCES.find((c) => c.type === type) ?? CAMPAIGN_CADENCES[CAMPAIGN_CADENCES.length - 1];
}

/** The CADENCES section of the chat prompt, built from the list above. */
export function campaignCadencePromptBlock(): string {
    const lines = CAMPAIGN_CADENCES.map((c) => {
        const steps = c.steps.map((s) => `Day ${s.day} ${s.role}`).join(' · ');
        return `  ${c.label.toUpperCase()} (goal: ${c.goal || 'whatever their process is for'}) — ${steps}.${c.note ? ` ${c.note}` : ''}`;
    });
    return [
        'CADENCES — the defaults you propose; all can be changed. "Day 1" is the day the reader enters ("as soon as they enter"). Keep at least one day between emails except when counting down to a fixed date. Never propose more than 7 emails.',
        ...lines,
        '  For CUSTOM, build it from their process: one email for each point where the reader has to DO something, plus a welcome and a close if they help; 3–5 emails, 2–4 days apart. Explain the shape in one sentence.',
    ].join('\n');
}
