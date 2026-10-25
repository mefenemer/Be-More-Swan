// src/utils/mentor-snapshot.ts
// What the Business Mentor sees every turn (docs/business-mentor-plan.md §3.2, §12): the workspace's
// Business Information gaps, the whole team with each assistant's real state, every active goal, and
// which starting point applies (§13.4). Rendered as a <workspace> block for ROUTES.business_mentor.
//
// Every chat already gets the business identity, Products & Services, Brand Knowledge, plan and task
// balance, and team activity; this adds what only the Mentor needs. What it may read at all is
// src/config/mentor-data-inventory.ts — tests/mentor-data-inventory.test.ts keeps that list complete.
//
// Missing is not zero (§12.3): a paused or unhired assistant is described as such, never as idle.

import { and, count, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { aiAssistants, goals, masterAssistants, orgIntroOffer, orgOfferProfile, orgProducts, organisations, plans } from '../../db/schema';
import { MENTOR_ROLE_KEY } from './mentor-provision';
import { SEAT_OCCUPYING_STATUSES, takesASeat } from './assistant-capacity';
import { resolveAssistantLimit } from './release-paused-limit';

type Db = any;

const MAX_PRODUCTS = 8;
const MAX_GOALS = 12;

export interface MentorSnapshotData {
    business: { description: string | null; industry: string | null; website: string | null };
    products: Array<{ name: string; hasPrice: boolean }>;
    productCount: number;
    offerKinds: string[] | null;          // null = the question hasn't been answered
    introOfferAnswered: boolean;
    team: Array<{ id: number; name: string; role: string; state: TeamState }>;
    goals: Array<{ assistant: string; label: string; latest: number | null; target: number; targetDate: Date; status: string }>;
    /** The live plan, to cross-check pause reasons: `status` null = no active or past-due plan; `freeSlots` null = unlimited. */
    plan: { status: 'active' | 'past_due' | null; freeSlots: number | null };
}

export type TeamState = 'active' | 'paused_by_user' | 'paused_task_cap' | 'paused_payment' | 'paused_plan_limit' | 'setting_up' | 'archived';

/** Pure: an assistant row's state, in the words the Mentor needs (§3.12). */
export function teamState(lifecycleStatus: string | null, provisioningStatus: string | null): TeamState {
    if (lifecycleStatus === 'archived') return 'archived';
    if (provisioningStatus === 'paused_quota') return 'paused_task_cap';
    if (provisioningStatus === 'paused_payment') return 'paused_payment';
    if (provisioningStatus === 'paused_limit') return 'paused_plan_limit';
    if (lifecycleStatus === 'paused' || lifecycleStatus === 'system_paused') return 'paused_by_user';
    if (lifecycleStatus === 'working') return 'active';
    return 'setting_up';
}

const STATE_WORDS: Record<TeamState, string> = {
    active: 'active',
    paused_by_user: 'paused by the user — never hand work to it; you may explain what resuming would do',
    paused_task_cap: 'paused because the monthly task allowance ran out — it restarts on the 1st; propose no work for it',
    paused_payment: 'paused because of a payment problem — point to My Account ▸ Billing & Subscription; propose no work for it',
    paused_plan_limit: 'paused because the plan has fewer assistant slots than assistants — propose no work for it',
    setting_up: 'hired but not started yet — its set-up isn\'t finished',
    archived: 'archived — treat as not hired',
};

/**
 * Pure: how to describe one assistant's state, cross-checked against the live plan. A pause marker can
 * outlive its cause: on staging (2026-10-25) Felix still said "paused for plan slots" on an active plan
 * with 10 free slots, and the Mentor advised upgrading. A marker the plan contradicts is described as
 * out of date, and the Mentor sends the user to support rather than to a purchase.
 */
export function describeState(state: TeamState, plan: MentorSnapshotData['plan']): string {
    const slotsFree = plan.status !== null && (plan.freeSlots === null || plan.freeSlots > 0);
    if (state === 'paused_plan_limit' && slotsFree) {
        return 'marked as paused for plan slots, but the plan has free slots now, so the marker looks out of date. Never advise upgrading for it; suggest asking Be More Swan via Help & Support';
    }
    if (state === 'paused_payment' && plan.status === 'active') {
        return 'marked as paused for a payment problem, but the plan shows as active and paid, so the marker looks out of date. Never tell them to fix billing for it; suggest asking Be More Swan via Help & Support';
    }
    return STATE_WORDS[state];
}

/**
 * Pure: which opening applies (§13.4). Established = has a description AND (any hired assistant, paused
 * included, OR products). A paused team still means the business has been running here — the live test
 * on 2026-10-25 asked an established film company "established or new?" because all three of its
 * assistants were paused.
 */
export function startingPoint(d: MentorSnapshotData): 'established' | 'new' {
    const hasDescription = !!d.business.description?.trim();
    const hasTeam = d.team.some((t) => t.state !== 'archived');
    return hasDescription && (hasTeam || d.productCount > 0) ? 'established' : 'new';
}

/** Pure: the Business Information gaps, most important first. */
export function businessGaps(d: MentorSnapshotData): string[] {
    const gaps: string[] = [];
    if (!d.business.description?.trim()) gaps.push('Business description is empty (Business Information) — every assistant writes from it.');
    if (d.productCount === 0) gaps.push('Products & Services is empty (Business Information ▸ Products & Services) — no assistant can mention what they sell or its price.');
    else if (d.products.every((p) => !p.hasPrice)) gaps.push('No product or service has a price yet (Business Information ▸ Products & Services).');
    if (!d.offerKinds?.length) gaps.push('"What does your business offer?" hasn\'t been answered (Business Information).');
    if (!d.business.website?.trim()) gaps.push('No website address (Business Information).');
    if (!d.business.industry?.trim()) gaps.push('No industry set (Business Information).');
    if (!d.introOfferAnswered) gaps.push('The free trial / intro offer question hasn\'t been answered (optional).');
    return gaps;
}

/** Pure: the <workspace> block. */
export function renderMentorSnapshot(d: MentorSnapshotData): string {
    const point = startingPoint(d);
    const gaps = businessGaps(d);
    const others = d.team.filter((t) => t.state !== 'archived');
    const active = others.filter((t) => t.state === 'active');

    const lines: string[] = ['<workspace>'];
    lines.push(point === 'established'
        ? 'STARTING POINT: an established workspace. Open with a short health check from the figures below — never re-ask what is already filled in.'
        : 'STARTING POINT: a new or nearly empty workspace. Introduce yourself, ask whether this is an established business or a new idea (unless the set-up answer above says), then help fill the gaps.');

    lines.push('', 'BUSINESS INFORMATION GAPS:');
    lines.push(...(gaps.length ? gaps.map((g) => `- ${g}`) : ['- None: Business Information is filled in.']));

    if (d.productCount) {
        const shown = d.products.map((p) => `${p.name}${p.hasPrice ? '' : ' (no price)'}`).join('; ');
        lines.push('', `PRODUCTS & SERVICES (${d.productCount}): ${shown}${d.productCount > d.products.length ? '; …' : ''}`);
    }

    lines.push('', 'YOUR TEAM (other assistants in this workspace):');
    if (!others.length) {
        lines.push('- None. You are the only assistant here. Never propose changes to, or hand work to, an assistant; give do-it-yourself steps and say once which assistant would help.');
    } else {
        lines.push(...others.map((t) => `- ${t.name} (${t.role}): ${describeState(t.state, d.plan)}`));
        if (!active.length) lines.push('- None of them is active right now: no team suggestions until one is.');
    }

    lines.push('', 'GOALS:');
    if (!d.goals.length) lines.push('- No goals are set yet.');
    else lines.push(...d.goals.map((g) => {
        const latest = g.latest === null ? 'not measured yet (unknown — never treat as 0)' : String(g.latest);
        return `- ${g.assistant}: ${g.label} — now ${latest}, target ${g.target} by ${g.targetDate.toISOString().slice(0, 10)} (${g.status.replace(/_/g, ' ')})`;
    }));

    lines.push('</workspace>');
    return lines.join('\n');
}

/** Reads the workspace (org-scoped throughout) and renders the block. Throws on a DB error; the caller catches. */
export async function buildMentorSnapshot(db: Db, orgId: number, userId: number): Promise<string> {
    const [org] = await db.select({
        description: organisations.businessDescription, industry: organisations.industry, website: organisations.websiteUrl,
    }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

    // Optional tables (applied by their own SQL files): a missing one reads as "not answered".
    const optional = async <T>(q: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await q(); } catch (err: any) {
            const code = err?.code ?? err?.cause?.code;
            if (code === '42P01' || code === '42703') return fallback;
            throw err;
        }
    };

    const products: Array<{ name: string; price: string | null }> = await optional(() => db
        .select({ name: orgProducts.name, price: orgProducts.price }).from(orgProducts)
        .where(eq(orgProducts.organisationId, orgId)), []);
    const [offer] = await optional(() => db.select({ offers: orgOfferProfile.offers }).from(orgOfferProfile)
        .where(eq(orgOfferProfile.organisationId, orgId)).limit(1), [] as Array<{ offers: string[] }>);
    const [intro] = await optional(() => db.select({ one: sql<number>`1` }).from(orgIntroOffer)
        .where(eq(orgIntroOffer.organisationId, orgId)).limit(1), [] as Array<{ one: number }>);

    const team = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, role: masterAssistants.name,
        lifecycleStatus: aiAssistants.lifecycleStatus, provisioningStatus: aiAssistants.provisioningStatus,
    }).from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            sql`coalesce(${aiAssistants.configuration} ->> 'type', '') <> ${MENTOR_ROLE_KEY}`,
            sql`coalesce(${aiAssistants.provisioningStatus}, '') NOT IN ('pending', 'pending_payment')`,
        ));

    const goalRows = await db.select({
        assistant: aiAssistants.name, title: goals.title, metricKey: goals.metricKey, latest: goals.latestValue,
        target: goals.targetValue, targetDate: goals.targetDate, status: goals.status,
    }).from(goals)
        .innerJoin(aiAssistants, eq(goals.assistantId, aiAssistants.id))
        .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true), ne(aiAssistants.lifecycleStatus, 'archived')))
        .limit(MAX_GOALS);

    // The live plan, the same resolution the hire gate and the downgrade use (release-paused-limit.ts).
    const [planRow] = await db.select({ status: plans.status }).from(plans)
        .where(and(or(eq(plans.userId, userId), eq(plans.organisationId, orgId)), inArray(plans.status, ['active', 'past_due'])))
        .orderBy(plans.status).limit(1);
    let freeSlots: number | null = null;
    if (planRow) {
        const limit = await resolveAssistantLimit(db, userId, orgId);
        if (limit !== null) {
            const [{ value: used }] = await db.select({ value: count() }).from(aiAssistants).where(and(
                eq(aiAssistants.organisationId, orgId), inArray(aiAssistants.lifecycleStatus, [...SEAT_OCCUPYING_STATUSES]), takesASeat(),
            ));
            freeSlots = Math.max(0, limit - Number(used));
        }
    }

    return renderMentorSnapshot({
        plan: { status: (planRow?.status as 'active' | 'past_due' | undefined) ?? null, freeSlots },
        business: { description: org?.description ?? null, industry: org?.industry ?? null, website: org?.website ?? null },
        products: products.slice(0, MAX_PRODUCTS).map((p) => ({ name: p.name, hasPrice: !!p.price?.trim() })),
        productCount: products.length,
        offerKinds: offer ? (offer.offers ?? []) : null,
        introOfferAnswered: !!intro,
        team: team.map((t: any) => ({
            id: t.id, name: t.name || t.role || 'Assistant', role: t.role || 'Assistant',
            state: teamState(t.lifecycleStatus, t.provisioningStatus),
        })),
        goals: goalRows.map((g: any) => ({
            assistant: g.assistant || 'An assistant', label: g.title || g.metricKey,
            latest: g.latest === null || g.latest === undefined ? null : Number(g.latest),
            target: Number(g.target), targetDate: new Date(g.targetDate), status: g.status || 'pending',
        })),
    });
}
