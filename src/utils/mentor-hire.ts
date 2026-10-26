// src/utils/mentor-hire.ts
// "Who to hire next" (docs/business-mentor-plan.md §3.5, §14). ONE pure function, read by:
//   - the Mentor's prompt (<workspace> WHO TO HIRE NEXT) and its `mentor_hire_recommendation` card,
//     which the server fills from here so the reasons can't be invented;
//   - the "Recommended next" panel on the Mentor's Overview tab and the "Recommended" badge in the
//     assistant catalogue (both via netlify/functions/mentor.ts).
//
// Rules:
//   - Only roles that are Live in the catalogue (assistant-go-live.ts statusOf), never one already on
//     the team (paused counts as on the team — resuming is the answer there, not a second hire), never
//     the Mentor itself.
//   - Every pick has a reason built from the workspace (a missing website, a Products & Services list,
//     the size of the team). A role with no reason from the workspace is only offered to a workspace
//     with nobody hired yet, and then from its catalogue description.
//   - An established team gets a pick only when there is a clear gap (§13.2 point 3).
//   - It respects the plan's assistant limit: with no free slot it says the next hire needs an upgrade
//     (the next plan from src/utils/next-plan.ts, as check-capacity.ts), or a swap on the top plan.
//   - It hires nothing.

import type { MentorSnapshotData } from './mentor-snapshot';

export const MAX_PICKS = 3;

export interface HirePick {
    roleKey: string;
    name: string;
    reason: string;
    /** true = the reason comes from this workspace; false = from the catalogue description only. */
    grounded: boolean;
}

export interface HireRecommendation {
    picks: HirePick[];
    /** One line for the card's "Why?": the figures the picks are based on. */
    why: string;
    capacity: {
        /** null = unlimited. */
        freeSlots: number | null;
        needsUpgrade: boolean;
        nextPlanName: string | null;
        /** Plain words for the card and the panel. */
        note: string;
    };
}

/** How strongly the workspace points at a role (higher first), and why. null = nothing in the workspace points at it. */
type Signal = { score: number; reason: string } | null;

const has = (d: MentorSnapshotData, roleKey: string) => d.team.some((t) => t.roleKey === roleKey && t.state !== 'archived');
const activeCount = (d: MentorSnapshotData) => d.team.filter((t) => t.state === 'active').length;

function productPhrase(d: MentorSnapshotData): string | null {
    if (!d.products.length) return null;
    const names = d.products.slice(0, 2).map((p) => p.name).join(' and ');
    return d.productCount > 2 ? `${names} and ${d.productCount - 2} more` : names;
}

/** What the workspace says about each role it knows how to judge. Roles not listed get no signal. */
const SIGNALS: Record<string, (d: MentorSnapshotData) => Signal> = {
    website_assistant: (d) => (!d.business.website?.trim()
        ? { score: 90, reason: 'There\'s no website address in Business Information. A Website Assistant builds and publishes a site for you.' }
        : null),
    social_media_manager: (d) => {
        const p = productPhrase(d);
        return { score: p ? 70 : 55, reason: p
            ? `Nobody posts on social media for you yet. It would draft posts about ${p} for you to approve.`
            : 'Nobody posts on social media for you yet. It drafts posts in your voice for you to approve.' };
    },
    newsletter_editor: (d) => ({ score: d.productCount ? 50 : 35, reason: d.productCount
        ? `No one emails your customers yet. An Email Marketing Assistant would keep them hearing about your ${d.productCount === 1 ? 'product' : 'products and services'}.`
        : 'No one emails your customers yet. An Email Marketing Assistant drafts newsletters for you to approve.' }),
    blog_writer: (d) => (d.business.website?.trim()
        ? { score: 45, reason: `You have a website (${d.business.website!.trim()}) but nobody writes articles for it here. Articles help people find you in search.` }
        : null),
    mystery_shopper: (d) => (d.business.website?.trim()
        ? { score: 40, reason: `It would check ${d.business.website!.trim()} each week, the way a customer sees it, and suggest fixes.` }
        : null),
    lead_qualifier: (d) => (d.offerKinds?.some((k) => /service|consult|b2b|trade/i.test(k))
        ? { score: 42, reason: 'You offer services, and nobody is finding new customers for you yet. A Lead Generator finds businesses that fit and drafts the first email.' }
        : null),
    campaign_orchestrator: (d) => (activeCount(d) >= 2
        ? { score: 38, reason: `You have ${activeCount(d)} active assistants. A Campaign Assistant plans work across them towards one goal.` }
        : null),
};

/**
 * Pure: the recommendation. `catalogue` = roles with their catalogue status; only `live` ones are
 * considered.
 */
export function recommendHires(d: MentorSnapshotData): HireRecommendation {
    const nobodyHired = !d.team.some((t) => t.state !== 'archived');
    const candidates = (d.catalogue ?? []).filter((c) => c.status === 'live' && c.roleKey !== 'business_mentor' && !has(d, c.roleKey));

    const scored = candidates.map((c) => {
        const s = SIGNALS[c.roleKey]?.(d) ?? null;
        return s
            ? { pick: { roleKey: c.roleKey, name: c.name, reason: s.reason, grounded: true }, score: s.score }
            : { pick: { roleKey: c.roleKey, name: c.name, reason: c.description?.trim() || `${c.name} is available to hire.`, grounded: false }, score: 0 };
    });
    // An established team: only clear gaps. Nobody hired yet: grounded first, then the catalogue's own words.
    const pool = nobodyHired ? scored : scored.filter((s) => s.pick.grounded);
    const picks = pool.sort((a, b) => b.score - a.score).slice(0, MAX_PICKS).map((s) => s.pick);

    const free = d.plan.freeSlots;
    const noPlan = d.plan.status === null;
    const needsUpgrade = !noPlan && free !== null && free <= 0;
    const nextPlanName = needsUpgrade ? d.plan.nextPlanName ?? null : null;
    const note = noPlan
        ? 'You need a plan to hire an assistant — see My Account ▸ Billing & Subscription.'
        : needsUpgrade
            ? (nextPlanName
                ? `Your plan's assistant slots are all used, so hiring another needs the ${nextPlanName} plan, or swapping one you have. It's your call.`
                : 'Your plan\'s assistant slots are all used, so hiring another means swapping one you have.')
            : free === null
                ? 'Your plan has room for more assistants.'
                : `Your plan has ${free} free assistant ${free === 1 ? 'slot' : 'slots'}${nobodyHired ? ', included in what you pay' : ''}.`;

    const facts: string[] = [];
    facts.push(nobodyHired ? 'no assistants hired yet' : `${activeCount(d)} active ${activeCount(d) === 1 ? 'assistant' : 'assistants'}`);
    if (!d.business.website?.trim()) facts.push('no website address');
    if (d.productCount) facts.push(`${d.productCount} in Products & Services`);
    facts.push(noPlan ? 'no plan' : free === null ? 'unlimited assistant slots' : `${Math.max(0, free)} free ${free === 1 ? 'slot' : 'slots'}`);

    return {
        picks,
        why: `Based on your workspace: ${facts.join(', ')}.`,
        capacity: { freeSlots: free, needsUpgrade, nextPlanName, note },
    };
}

/** Pure: the prompt's lines, so what the Mentor says matches the card and the page. */
export function renderHireRecommendation(r: HireRecommendation): string[] {
    const lines = ['WHO TO HIRE NEXT (the same list as "Recommended next" on your Overview tab):'];
    if (!r.picks.length) lines.push('- No clear gap for another assistant right now: don\'t recommend hiring unless the user asks.');
    else lines.push(...r.picks.map((p, i) => `${i + 1}. ${p.name} — ${p.reason}`));
    lines.push(`- ${r.capacity.note}`);
    return lines;
}
