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

import { and, asc, count, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { aiAssistants, discussionWatches, discussions, goals, masterAssistants, masterPlans, mentorJobs, orgIntroOffer, orgOfferProfile, orgProducts, organisations, plans } from '../../db/schema';
import { MENTOR_ROLE_KEY } from './mentor-provision';
import { SEAT_OCCUPYING_STATUSES, takesASeat } from './assistant-capacity';
import { resolveAssistantLimit } from './release-paused-limit';
import { loadProposalState, renderProposalState } from './mentor-proposals';
import { recommendHires, renderHireRecommendation } from './mentor-hire';
import { renderSetupFields } from './setup-field';
import { CTA_ROLES } from '../config/call-to-action';
import { getGoalMetric } from '../config/goal-metrics';
import { statusOf, type AssistantStatus } from './assistant-go-live';
import { loadNextPlan } from './next-plan';
import { loadStrategyDocs, renderStrategyForMentor, type StrategyDoc } from './strategy-documents';
import { playbookFor, renderPlaybookForMentor } from '../config/mentor-playbooks';
import { loadCommitments, renderCommitmentsForMentor } from './mentor-commitments';
import { loadTrackRecord, renderTrackRecordForMentor } from './mentor-outcomes';
import { loadCustomers, renderCustomersForMentor } from './mentor-customers';
import { TEAM_FEATURES } from '../config/team-features';
import { isDiscussionSource, sourceInfo } from '../config/discussion-sites';
import { loadSiteDirectoryGaps } from './site-directory-store';

type Db = any;

const MAX_PRODUCTS = 8;
const MAX_GOALS = 12;
const MAX_RESEARCH = 5;

export interface MentorSnapshotData {
    business: { description: string | null; industry: string | null; website: string | null; targetAudience?: string | null };
    /** id = the org_products row, so a removal card can name it (fixtures may leave it out). */
    products: Array<{ id?: number; name: string; hasPrice: boolean }>;
    productCount: number;
    offerKinds: string[] | null;          // null = the question hasn't been answered
    introOfferAnswered: boolean;
    /** A free trial / intro offer is recorded (not just "we don't have one"). Optional for older fixtures. */
    introOfferHas?: boolean;
    /** roleKey and setup (its set-up answers) are read for set-up cards and hiring advice. */
    team: Array<{ id: number; name: string; role: string; state: TeamState; roleKey?: string | null; setup?: Record<string, unknown> | null }>;
    /** The assistant catalogue with each role's status (only `live` ones are recommended, mentor-hire.ts). */
    catalogue?: Array<{ roleKey: string; name: string; description: string | null; status: AssistantStatus }>;
    /** id = the goals row, so a goal card can name it (fixtures may leave it out). */
    goals: Array<{ id?: number; assistant: string; label: string; latest: number | null; target: number; targetDate: Date; status: string; metricKey?: string | null }>;
    /** The live plan, to cross-check pause reasons: `status` null = no active or past-due plan; `freeSlots` null = unlimited. */
    plan: { status: 'active' | 'past_due' | null; freeSlots: number | null; nextPlanName?: string | null };
    /** Phase 2: its strategy documents (null = the table isn't there yet; undefined = not read). */
    strategyDocs?: StrategyDoc[] | null;
    /** Phase 2: its last research answers, with their links — the only sourced facts it may quote. */
    research?: Array<{ question: string; answer: string; sources: string[] }>;
    /**
     * Each Lead Generator's Discussions tab, as counts — never the threads or the drafts. null = the
     * tables aren't there (unknown, not "not set up"); undefined = not read (older fixtures).
     */
    discussions?: Array<{ assistantId: number; topics: string[]; sites: string[]; enabled: boolean; newCount: number; repliedCount: number; lastScannedAt: Date | null }> | null;
    /**
     * What the website lacks, from the site page directory (src/utils/site-directory.ts directoryGaps):
     * no contact/about page, Business Information products no page names. Empty = none found or the
     * site hasn't been read; undefined = not read (older fixtures).
     */
    websiteGaps?: string[];
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

/** One line of the Mentor page's "Set-up checklist" (§14), and the gap the prompt names when it isn't done. */
export interface ChecklistItem {
    key: 'description' | 'products' | 'offer' | 'website' | 'industry' | 'intro_offer' | 'offer_cta';
    label: string;
    done: boolean;
    optional: boolean;
    /** Why it matters, shown under an unticked item. */
    why: string;
    /** The Business Information tab that holds the field (window._bizinfoInitialTab). */
    tab: 'profile' | 'products';
    /** The prompt's wording for the gap (BUSINESS INFORMATION GAPS). */
    gap: string;
}

/**
 * Pure: the set-up checklist, most important first. The prompt's gaps and the page's checklist are
 * both read from this, so the Mentor never raises a gap the page shows as done (or the reverse).
 */
export function setupChecklist(d: MentorSnapshotData): ChecklistItem[] {
    const priced = d.products.some((p) => p.hasPrice);
    return [
        { key: 'description', label: 'Business description', done: !!d.business.description?.trim(), optional: false, tab: 'profile',
            why: 'Every assistant writes from it.',
            gap: 'Business description is empty (Business Information) — every assistant writes from it.' },
        { key: 'products', label: 'Products & Services', done: d.productCount > 0 && priced, optional: false, tab: 'products',
            why: d.productCount === 0 ? 'None of your assistants can mention what you sell or its price until this is filled in.' : 'Nothing has a price yet, so no assistant can quote one.',
            gap: d.productCount === 0
                ? 'Products & Services is empty (Business Information ▸ Products & Services) — no assistant can mention what they sell or its price.'
                : 'No product or service has a price yet (Business Information ▸ Products & Services).' },
        { key: 'offer', label: 'What your business offers', done: !!d.offerKinds?.length, optional: false, tab: 'products',
            why: 'Decides which details your assistants ask for and use.',
            gap: '"What does your business offer?" hasn\'t been answered (Business Information).' },
        { key: 'website', label: 'Website', done: !!d.business.website?.trim(), optional: false, tab: 'profile',
            why: 'Assistants link to it and read it for your details.',
            gap: 'No website address (Business Information).' },
        { key: 'industry', label: 'Industry', done: !!d.business.industry?.trim(), optional: false, tab: 'profile',
            why: 'Helps your assistants write for your kind of business.',
            gap: 'No industry set (Business Information).' },
        { key: 'intro_offer', label: 'Free trial or intro offer', done: d.introOfferAnswered, optional: true, tab: 'products',
            why: 'Optional. Used in outreach and posts when you have one.',
            gap: 'The free trial / intro offer question hasn\'t been answered (optional).' },
        ...offerCtaItem(d),
    ];
}

/**
 * Pure: "Your offer as a call to action" — only when an offer is recorded and a Social, Blog or Email
 * assistant is active (the review's content check raises the same gap, so the page must show it too).
 * Done when at least one of them invites people to take the offer.
 */
function offerCtaItem(d: MentorSnapshotData): ChecklistItem[] {
    const content = d.team.filter((t) => t.state === 'active' && (CTA_ROLES as readonly string[]).includes(t.roleKey ?? ''));
    if (!d.introOfferHas || !content.length) return [];
    return [{ key: 'offer_cta', label: 'Your offer as a call to action', done: content.some((t) => t.setup?.ctaOffer === 'intro_offer'), optional: true, tab: 'products',
        why: 'Your free trial or intro offer is recorded, but no content assistant asks people to take it. Set it under Calls to action.',
        gap: 'The free trial / intro offer is recorded but no content assistant uses it as its call to action (Business Information ▸ Products & Services ▸ Calls to action).' }];
}

/** Pure: the Business Information gaps, most important first. */
export function businessGaps(d: MentorSnapshotData): string[] {
    return setupChecklist(d).filter((i) => !i.done).map((i) => i.gap);
}

/**
 * Pure: what the model must know to describe a goal honestly — what its number counts (staging, 27 Oct:
 * "Find 300 Leads" read 16 while the Results tab said 101 leads, and the review asked the owner to find
 * out why; the goal counts leads approved for outreach, the tab counts leads found), and whether its date
 * has passed unmet (the same review called a goal due a month earlier "0 of 1 by 30 September").
 */
export function goalNotes(g: { latest: number | null; target: number; targetDate: Date; metricKey?: string | null }, now = new Date()): string {
    const out: string[] = [];
    const m = g.metricKey ? getGoalMetric(g.metricKey) : null;
    if (m?.description) out.push(`counts: ${m.description.replace(/\s+/g, ' ').trim().replace(/\.$/, '')}`);
    const daysPast = Math.floor((now.getTime() - g.targetDate.getTime()) / 86_400_000);
    if (daysPast >= 1 && (g.latest === null || g.latest < g.target)) {
        const day = g.targetDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' });
        out.push(`DATE PASSED ${daysPast} day${daysPast === 1 ? '' : 's'} ago, target not reached: call it "missed on ${day}" (never "by ${day}") and suggest moving the date or closing it on the assistant's Results tab`);
    }
    return out.length ? ` — ${out.join('; ')}` : '';
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
        const shown = d.products.map((p) => `${p.id ? `#${p.id} ` : ''}${p.name}${p.hasPrice ? '' : ' (no price)'}`).join('; ');
        lines.push('', `PRODUCTS & SERVICES (${d.productCount}): ${shown}${d.productCount > d.products.length ? '; …' : ''}`);
    }

    lines.push('', 'YOUR TEAM (other assistants in this workspace):');
    if (!others.length) {
        lines.push('- None. You are the only assistant here. Never propose changes to, or hand work to, an assistant; give do-it-yourself steps and say once which assistant would help.');
    } else {
        lines.push(...others.map((t) => `- ${t.name} (${t.role}): ${describeState(t.state, d.plan)}`));
        if (!active.length) lines.push('- None of them is active right now: no team suggestions until one is.');
    }

    if (active.length) {
        lines.push('', 'SET-UP ANSWERS OF ACTIVE ASSISTANTS (what each was told at set-up; you may propose changing one with a card):');
        for (const t of active) {
            const fields = t.roleKey ? renderSetupFields(t.roleKey, t.setup ?? null) : [];
            lines.push(`- ${t.name} (${t.role}, assistantId ${t.id})${fields.length ? ':' : ': no set-up answers you can change from chat.'}`);
            lines.push(...fields);
        }
    }

    lines.push(...renderTeamFeatures(d));

    lines.push('', ...renderHireRecommendation(recommendHires(d)));

    lines.push('', 'GOALS:');
    if (!d.goals.length) lines.push('- No goals are set yet.');
    else lines.push(...d.goals.map((g) => {
        const latest = g.latest === null ? 'not measured yet (unknown — never treat as 0)' : String(g.latest);
        return `- ${g.id ? `#${g.id} ` : ''}${g.assistant}: ${g.label} — now ${latest}, target ${g.target} by ${g.targetDate.toISOString().slice(0, 10)} (${g.status.replace(/_/g, ' ')})${goalNotes(g)}`;
    }));

    if (d.websiteGaps?.length) {
        lines.push('', 'WEBSITE GAPS (from the pages read off their website — Business Information ▸ Website Pages; suggest the page, never write it yourself):');
        lines.push(...d.websiteGaps.map((g) => `- ${g}`));
    }

    if (d.strategyDocs !== undefined) lines.push('', ...renderStrategyForMentor(d.strategyDocs));
    lines.push('', ...renderPlaybookForMentor(playbookFor(d.offerKinds)));
    if (d.research?.length) {
        lines.push('', 'YOUR RESEARCH (looked up with web search; you may quote these, with their links):');
        for (const r of d.research) lines.push(`- Q: ${r.question}\n  A: ${r.answer.replace(/\s*\n+\s*/g, ' ').slice(0, 500)}\n  Sources: ${r.sources.join(' ; ')}`);
    }

    lines.push('</workspace>');
    return lines.join('\n');
}

/** Reads the workspace (org-scoped throughout) and renders the block. Throws on a DB error; the caller catches. */
/**
 * Newer features of the roles on this team (src/config/team-features.ts), and where each Lead Generator's
 * Discussions tab stands. Empty when no one on the team has a listed feature. Pure.
 */
export function renderTeamFeatures(d: MentorSnapshotData): string[] {
    const others = d.team.filter((t) => t.state !== 'archived');
    const roles = [...new Set(others.map((t) => t.roleKey).filter((k): k is string => !!k && !!TEAM_FEATURES[k]?.length))];
    if (!roles.length) return [];
    const out = ['', 'WHAT YOUR TEAM CAN DO (newer features — suggest one only when it fits a goal or gap; only for an ACTIVE assistant, otherwise say what resuming it would add; the user sets it up there, you have no card for it):'];
    for (const k of roles) {
        const names = others.filter((t) => t.roleKey === k).map((t) => t.name).join(', ');
        for (const f of TEAM_FEATURES[k]) out.push(`- ${names} — ${f.name} (new ${f.since}): ${f.text}`);
    }
    for (const t of others.filter((x) => x.roleKey === 'lead_qualifier')) {
        if (d.discussions === undefined) continue;
        if (d.discussions === null) { out.push(`- ${t.name}'s Discussions: can't be read just now — ask, never assume it isn't set up.`); continue; }
        const w = d.discussions.find((x) => x.assistantId === t.id);
        if (!w || !w.topics.length) { out.push(`- ${t.name}'s Discussions: not set up yet (no topics).`); continue; }
        const last = w.lastScannedAt ? `last scan ${w.lastScannedAt.toISOString().slice(0, 10)}` : 'never scanned yet';
        out.push(`- ${t.name}'s Discussions: watching ${w.topics.map((x) => `"${x}"`).join(', ')} on ${w.sites.join(', ') || 'no sites'}; daily scan ${w.enabled ? 'on' : 'off'}; ${last}; ${w.newCount} new thread${w.newCount === 1 ? '' : 's'} waiting for a reply, ${w.repliedCount} replied.`);
    }
    return out;
}

export async function buildMentorSnapshot(db: Db, orgId: number, userId: number): Promise<string> {
    return (await buildMentorSnapshotParts(db, orgId, userId)).text;
}

/** Pure: does the user's message ask about their customers? Then the customers block is read (§12.1: on request). */
export function asksAboutCustomers(typed: string | null | undefined): boolean {
    return /\b(customers?|clients?|buyers?|reviews?|deals?|won|lost|churn|repeat business|gone quiet|check[- ]?in)\b/i.test(String(typed ?? ''));
}

/**
 * The block and the data it was rendered from (the chat route fills the hire card from the same data).
 * Phase 3: its own commitments and track record every turn; the customers block only when asked
 * (`withCustomers`) — the weekly review always reads it.
 */
export async function buildMentorSnapshotParts(db: Db, orgId: number, userId: number, opts: { withCustomers?: boolean } = {}): Promise<{ text: string; data: MentorSnapshotData }> {
    const [data, proposals, commitments, record, customers] = await Promise.all([
        loadMentorSnapshotData(db, orgId, userId), loadProposalState(db, orgId),
        loadCommitments(db, orgId, userId).catch((err: unknown) => { console.error('[mentor-snapshot] commitments unreadable (non-fatal)', err instanceof Error ? err.message : err); return null; }),
        loadTrackRecord(db, orgId).catch(() => null),
        opts.withCustomers ? loadCustomers(db, orgId).catch((err: unknown) => { console.error('[mentor-snapshot] customers unreadable (non-fatal)', err instanceof Error ? err.message : err); return null; }) : Promise.resolve(undefined),
    ]);
    const extra = [
        ...renderCommitmentsForMentor(commitments, userId),
        ...renderTrackRecordForMentor(record),
        ...(customers === undefined ? [] : renderCustomersForMentor(customers)),
    ];
    return { text: [renderMentorSnapshot(data), renderProposalState(proposals), ...extra].join('\n'), data };
}

/** The workspace as the Mentor sees it (org-scoped throughout). Also feeds the Mentor page's checklist (mentor.ts). */
export async function loadMentorSnapshotData(db: Db, orgId: number, userId: number): Promise<MentorSnapshotData> {
    const [org] = await db.select({
        description: organisations.businessDescription, industry: organisations.industry, website: organisations.websiteUrl,
        targetAudience: organisations.targetAudience,
    }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

    // Optional tables (applied by their own SQL files): a missing one reads as "not answered".
    const optional = async <T>(q: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await q(); } catch (err: any) {
            const code = err?.code ?? err?.cause?.code;
            if (code === '42P01' || code === '42703') return fallback;
            throw err;
        }
    };

    // ACTIVE rows only, in the business's order — the list every other assistant drafts from
    // (org-products.ts loadOrgProducts). Unfiltered, an archived product showed up here with no
    // details behind it, and the Mentor told the owner they sold it.
    const products: Array<{ id: number; name: string; price: string | null }> = await optional(() => db
        .select({ id: orgProducts.id, name: orgProducts.name, price: orgProducts.price }).from(orgProducts)
        .where(and(eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active')))
        .orderBy(asc(orgProducts.sortOrder), asc(orgProducts.id)), []);
    const [offer] = await optional(() => db.select({ offers: orgOfferProfile.offers }).from(orgOfferProfile)
        .where(eq(orgOfferProfile.organisationId, orgId)).limit(1), [] as Array<{ offers: string[] }>);
    const [intro] = await optional(() => db.select({ offer: orgIntroOffer.offer }).from(orgIntroOffer)
        .where(eq(orgIntroOffer.organisationId, orgId)).limit(1), [] as Array<{ offer: unknown }>);

    const team = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, role: masterAssistants.name, roleKey: masterAssistants.roleKey,
        setup: aiAssistants.onboardingContext,
        lifecycleStatus: aiAssistants.lifecycleStatus, provisioningStatus: aiAssistants.provisioningStatus,
    }).from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            sql`coalesce(${aiAssistants.configuration} ->> 'type', '') <> ${MENTOR_ROLE_KEY}`,
            sql`coalesce(${aiAssistants.provisioningStatus}, '') NOT IN ('pending', 'pending_payment')`,
        ));

    const goalRows = await db.select({
        id: goals.id, assistant: aiAssistants.name, title: goals.title, metricKey: goals.metricKey, latest: goals.latestValue,
        target: goals.targetValue, targetDate: goals.targetDate, status: goals.status,
    }).from(goals)
        .innerJoin(aiAssistants, eq(goals.assistantId, aiAssistants.id))
        .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true), ne(aiAssistants.lifecycleStatus, 'archived')))
        .limit(MAX_GOALS);

    // The live plan, the same resolution the hire gate and the downgrade use (release-paused-limit.ts).
    const [planRow] = await db.select({ status: plans.status, tierKey: masterPlans.tierKey, monthlyPriceGbp: masterPlans.monthlyPriceGbp }).from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
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
    // Full plan: the next one up names the upgrade (the same query as check-capacity.ts).
    const nextPlan = planRow && freeSlots === 0
        ? await loadNextPlan(db, { monthlyPriceGbp: planRow.monthlyPriceGbp, tierKey: planRow.tierKey }).catch(() => null)
        : null;

    // The catalogue, for "who to hire next" (only Live roles are recommended — mentor-hire.ts).
    const catalogue = await db.select({
        roleKey: masterAssistants.roleKey, name: masterAssistants.name, description: masterAssistants.description,
        isActive: masterAssistants.isActive, comingSoon: masterAssistants.comingSoon, lifecycleState: masterAssistants.lifecycleState,
    }).from(masterAssistants).where(eq(masterAssistants.isActive, true));

    // Phase 2 (db/z-business-mentor-phase-2.sql): its documents and its answered research. A missing
    // table reads as "not available" — never as "no documents".
    const strategyDocs = await loadStrategyDocs(db, orgId).catch((err: unknown) => {
        console.error('[mentor-snapshot] strategy documents unreadable (non-fatal)', err instanceof Error ? err.message : err);
        return null;
    });
    const researchRows: any[] = await optional(() => db.select({ input: mentorJobs.input, result: mentorJobs.result }).from(mentorJobs)
        .where(and(eq(mentorJobs.organisationId, orgId), eq(mentorJobs.kind, 'research'), eq(mentorJobs.status, 'done')))
        .orderBy(sql`${mentorJobs.createdAt} DESC`).limit(MAX_RESEARCH), []);
    const research = researchRows.flatMap((r) => {
        const res = r.result as { outcome?: string; answer?: string; sources?: Array<{ url?: string }> } | null;
        if (res?.outcome !== 'answered' || !res.answer) return [];
        return [{ question: String((r.input as { question?: unknown })?.question ?? ''), answer: res.answer, sources: (res.sources ?? []).map((x) => String(x.url ?? '')).filter(Boolean) }];
    });

    // The Lead Generators' Discussions tabs, as counts (db/z-discussions.sql). Only the watch and a
    // count per status are read — the threads and drafted replies stay the Lead Generator's.
    const leadIds = team.filter((t: any) => t.roleKey === 'lead_qualifier').map((t: any) => t.id as number);
    const discussionState = !leadIds.length ? [] : await optional(async () => {
        const [watches, counts] = await Promise.all([
            db.select({ assistantId: discussionWatches.aiAssistantId, topics: discussionWatches.topics, sites: discussionWatches.sites, enabled: discussionWatches.enabled, lastScannedAt: discussionWatches.lastScannedAt })
                .from(discussionWatches).where(and(eq(discussionWatches.organisationId, orgId), inArray(discussionWatches.aiAssistantId, leadIds))),
            db.select({ assistantId: discussions.aiAssistantId, status: discussions.status, n: count() }).from(discussions)
                .where(and(eq(discussions.organisationId, orgId), inArray(discussions.aiAssistantId, leadIds)))
                .groupBy(discussions.aiAssistantId, discussions.status),
        ]);
        const n = (id: number, status: string) => Number((counts as any[]).find((c) => c.assistantId === id && c.status === status)?.n ?? 0);
        return (watches as any[]).map((w) => ({
            assistantId: w.assistantId, topics: (w.topics ?? []) as string[], enabled: !!w.enabled,
            sites: ((w.sites ?? []) as string[]).filter(isDiscussionSource).map((x) => sourceInfo(x).label),
            newCount: n(w.assistantId, 'new'), repliedCount: n(w.assistantId, 'replied'),
            lastScannedAt: w.lastScannedAt ? new Date(w.lastScannedAt) : null,
        }));
    }, null as MentorSnapshotData['discussions']);

    // The site page directory's gaps (site-directory-store.ts). Never throws.
    const websiteGaps = await loadSiteDirectoryGaps(db, orgId);

    return {
        strategyDocs,
        research,
        discussions: discussionState,
        websiteGaps,
        plan: { status: (planRow?.status as 'active' | 'past_due' | undefined) ?? null, freeSlots, nextPlanName: nextPlan?.name ?? null },
        catalogue: catalogue.filter((c: any) => c.roleKey).map((c: any) => ({
            roleKey: c.roleKey, name: c.name, description: c.description ?? null,
            status: statusOf({ isActive: !!c.isActive, comingSoon: !!c.comingSoon, lifecycleState: c.lifecycleState ?? '' }),
        })),
        business: { description: org?.description ?? null, industry: org?.industry ?? null, website: org?.website ?? null, targetAudience: org?.targetAudience ?? null },
        products: products.slice(0, MAX_PRODUCTS).map((p) => ({ id: p.id, name: p.name, hasPrice: !!p.price?.trim() })),
        productCount: products.length,
        offerKinds: offer ? (offer.offers ?? []) : null,
        introOfferAnswered: !!intro,
        introOfferHas: (intro?.offer as { has?: unknown } | null)?.has === true,
        team: team.map((t: any) => ({
            id: t.id, name: t.name || t.role || 'Assistant', role: t.role || 'Assistant',
            state: teamState(t.lifecycleStatus, t.provisioningStatus),
            roleKey: t.roleKey ?? null, setup: (t.setup as Record<string, unknown> | null) ?? null,
        })),
        goals: goalRows.map((g: any) => ({
            id: g.id, assistant: g.assistant || 'An assistant', label: g.title || g.metricKey,
            latest: g.latest === null || g.latest === undefined ? null : Number(g.latest),
            target: Number(g.target), targetDate: new Date(g.targetDate), status: g.status || 'pending', metricKey: g.metricKey ?? null,
        })),
    };
}
