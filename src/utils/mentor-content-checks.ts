// src/utils/mentor-content-checks.ts — the weekly review's content checks (docs/business-mentor-plan.md §6.1).
//
// On the weekly review only (no schedule of its own), the Mentor checks saved set-up against what the
// workspace says elsewhere. Two kinds of check:
//   - Found in CODE (deterministic, free): a call to action that was chosen but can't be used, an offer
//     recorded that no content assistant promotes, a goal whose platform isn't connected. These are
//     written into the review even when there's "not enough data yet" — no model call, nothing charged.
//   - Judged by the MODEL, on the paid review only: whether a Brand Knowledge document contradicts the
//     recorded offer or the approved plan. It is given short excerpts and told to name the document.
//
// Findings are words, never edits: each says where the user fixes it. Only ACTIVE assistants are checked.
// Never throws.

import { and, eq, gte, inArray } from 'drizzle-orm';
import { blogPosts, goals, orgProducts, scheduledPosts } from '../../db/schema';
import { LIST_GAP_DAYS, LIST_PRODUCT_RANGE, isListPiece, isListSearchTerm } from './top-lists';
import { connectionDisplayName, getGoalMetric } from '../config/goal-metrics';
import { CTA_LABELS, CTA_ROLES, type CtaKind, type ResolvedCta } from '../config/call-to-action';
import { ctaChoiceFromContext, resolveCta } from './call-to-action';
import { loadIntroOffer, summariseIntroOffer } from './intro-offer';
import { loadBusinessKnowledge } from './business-knowledge';
import { connectedServices } from './goal-connections';
import type { MentorSnapshotData } from './mentor-snapshot';
import { loadOrgTrends, monthList, type OrgTrend } from './search-trends-read';

type Db = any;

export const MAX_KNOWLEDGE_DOCS = 3;
export const KNOWLEDGE_EXCERPT_CHARS = 600;

export interface ContentCheckInputs {
    /**
     * Active Social / Blog / Email assistants: what they were set to invite, and what that resolved to.
     * `incentive` is the Social wizard's "Incentive or offer" answer — a detail INSIDE posts, not the call
     * to action. Staging, 27 Oct: the Mentor suggested changing Marvin's incentive to the free trial, then
     * the next review said no assistant used the trial as its call to action — both true, never explained.
     */
    ctas: Array<{ name: string; chosen: CtaKind; resolved: ResolvedCta; incentive?: string | null }>;
    /** The recorded free trial / intro offer, summarised; null when none is recorded. */
    offer: string | null;
    /** Active assistants' active goals. */
    goals: Array<{ assistant: string; label: string; metricKey: string }>;
    services: string[];
    /** Brand Knowledge documents, cut short, for the model's contradiction check. */
    knowledge: Array<{ name: string; excerpt: string }>;
    /** Whether a plan is approved (the model compares Brand Knowledge against it too). */
    hasApprovedPlan: boolean;
    /**
     * Google Trends seasons for the approved tracked terms (docs/google-trends-plan.md Phase 2): each
     * term's peak months last year and how many months until the next one. Optional: older callers and
     * fixtures leave it out.
     */
    seasons?: Array<{ term: string; peakMonths: number[]; monthsAway: number }>;
    /** Suggested search terms still waiting for the owner's OK. */
    pendingTerms?: number;
    /**
     * Top lists Phase 3 (plan §3): whether to suggest a list piece. Absent = no check (older callers).
     * `listedRecently` = a published blog article or post in the last LIST_GAP_DAYS days was a list.
     */
    lists?: { blogWriters: Array<{ id: number; name: string }>; listedRecently: boolean; productCount: number; listTerms: string[] };
}

/** A season is worth flagging when it starts in 1–2 months: early enough to write for it, close enough to act. */
export const SEASON_LEAD_MONTHS = [1, 2];

export interface ContentFinding { text: string; where: string }

/** Pure: the checks code can decide on its own. */
export function contentFindings(i: Pick<ContentCheckInputs, 'ctas' | 'offer' | 'goals' | 'services' | 'seasons' | 'pendingTerms' | 'lists'>): ContentFinding[] {
    const out: ContentFinding[] = [];
    for (const c of i.ctas) {
        if (c.chosen !== 'own' && c.resolved.kind === 'own' && c.resolved.unusable) {
            out.push({
                text: `${c.name} is set to invite people to ${CTA_LABELS[c.chosen].toLowerCase()}, but ${c.resolved.unusable.charAt(0).toLowerCase()}${c.resolved.unusable.slice(1).replace(/\s*—.*$/, '').replace(/\.?$/, '.')} Until that's fixed it uses its own call to action.`,
                where: 'Business Information ▸ Products & Services ▸ Calls to action',
            });
        }
    }
    if (i.offer && i.ctas.length && i.ctas.every((c) => c.chosen === 'own')) {
        const mention = i.ctas.filter((c) => c.incentive?.trim()).map((c) => c.name);
        const also = mention.length
            ? ` ${listNames(mention)} ${mention.length === 1 ? 'mentions an offer in its' : 'mention an offer in their'} "Incentive or offer" answer, but that only adds a detail to posts — it doesn't change what they ask people to do.`
            : '';
        out.push({
            text: `Your offer (${i.offer.replace(/\.$/, '')}) is recorded, but none of your content assistants uses it as its call to action.${also}`,
            where: 'Business Information ▸ Products & Services ▸ Calls to action',
        });
    }
    const services = new Set(i.services.map((s) => s.toLowerCase()));
    for (const g of i.goals) {
        const m = getGoalMetric(g.metricKey);
        if (!m || m.source !== 'connection' || !m.connectionService) continue;
        if (services.has(m.connectionService.toLowerCase())) continue;
        const platform = connectionDisplayName(m.connectionService) ?? m.connectionService;
        out.push({
            text: `${g.assistant}'s goal "${g.label}" can't be measured: ${platform} isn't connected.`,
            where: `Connections (connect ${platform}), or change the goal on ${g.assistant}'s Results tab`,
        });
    }
    // Google Trends: a busy season about to start. Last year's pattern, never a forecast or a count.
    for (const s of i.seasons ?? []) {
        if (!SEASON_LEAD_MONTHS.includes(s.monthsAway) || !s.peakMonths.length) continue;
        out.push({
            text: `Searches for "${s.term.replace(/["<>]/g, '')}" usually peak in ${monthList(s.peakMonths)} (Google Trends, last year) — that starts in about ${s.monthsAway} month${s.monthsAway === 1 ? '' : 's'}. Articles and posts published a few weeks before a busy spell tend to be found.`,
            where: 'your Blog Writer\'s chat (ask for an article on it), or Business Information ▸ What People Search',
        });
    }
    // Top lists: nothing published lately has been a list, and there is a Blog Writer to write one.
    // Only on a gap — a workspace already publishing lists is never nagged — with the best reason first.
    const l = i.lists;
    if (l && l.blogWriters.length && !l.listedRecently) {
        const term = l.listTerms[0]?.replace(/["<>]/g, '');
        const why = term
            ? `People search "${term}", and a list article answers that search directly.`
            : l.productCount >= LIST_PRODUCT_RANGE
                ? `You have ${l.productCount} products and services, so a "Top ${Math.min(l.productCount, 7)}" of them is an easy one to start with.`
                : 'A numbered "Top 5"-style piece is one of the formats people save and come back to.';
        out.push({
            text: `Nothing you've published in the last ${LIST_GAP_DAYS} days has been a list. ${why}`,
            where: `${l.blogWriters[0].name}'s Blog Studio (Type of article: Top list)`,
        });
    }
    if (i.pendingTerms && i.pendingTerms > 0) {
        out.push({
            text: `${i.pendingTerms} suggested search term${i.pendingTerms === 1 ? ' is' : 's are'} waiting for your OK, so ${i.pendingTerms === 1 ? 'it isn\'t' : 'they aren\'t'} being tracked yet.`,
            where: 'Business Information ▸ What People Search',
        });
    }
    return out;
}

const listNames = (n: string[]) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

/** Pure: the findings as one review section's text, or null when there are none. */
export function contentFindingsText(findings: ContentFinding[]): string | null {
    if (!findings.length) return null;
    return findings.map((f) => `${f.text} (Fix it on ${f.where}.)`).join(' ');
}

/** Pure: the block for the paid review's prompt. */
export function renderContentChecksForMentor(i: ContentCheckInputs | null): string[] {
    if (!i) return [];
    const lines = ['CONTENT CHECKS (already found in code — mention each under "What needs attention", in your own words, with where to fix it; never claim you changed anything):'];
    const found = contentFindings(i);
    lines.push(...(found.length ? found.map((f) => `- ${f.text} Fix: ${f.where}.`) : ['- None found.']));
    if (i.offer) lines.push('- NOTE: the Social set-up answer "Incentive or offer" is NOT the call to action. Never suggest changing it to make the offer the call to action, and never count a change to it as fixing that; the only place that sets it is Business Information ▸ Products & Services ▸ Calls to action (there is no card for it — point them there).');
    if (i.knowledge.length && (i.offer || i.hasApprovedPlan)) {
        lines.push('BRAND KNOWLEDGE (excerpts; the owner\'s documents every assistant drafts from). Compare them with the recorded offer'
            + `${i.hasApprovedPlan ? ' and the approved plan' : ''}. ONLY if one clearly contradicts it — a different offer, price, length of trial or audience — say which document and what differs, and that they can fix it in Business Information ▸ Brand Assets (also "Your brand" in any assistant\'s settings). If they agree or you can't tell, say nothing about them.`);
        if (i.offer) lines.push(`Recorded offer: ${i.offer}`);
        for (const k of i.knowledge) lines.push(`- "${k.name}": ${k.excerpt}`);
    }
    return lines;
}

/** Read everything the checks need. Null on any failure: the review goes ahead without them. */
export async function loadContentChecks(db: Db, orgId: number, data: MentorSnapshotData): Promise<ContentCheckInputs | null> {
    try {
        const active = data.team.filter((t) => t.state === 'active');
        const ctaTeam = active.filter((t) => (CTA_ROLES as readonly string[]).includes(t.roleKey ?? ''));
        const activeIds = active.map((t) => t.id);
        const since = new Date(Date.now() - LIST_GAP_DAYS * 24 * 60 * 60 * 1000);
        const [ctas, intro, goalRows, services, knowledge, trends, recentBlogs, recentPosts, productRows] = await Promise.all([
            Promise.all(ctaTeam.map(async (t) => ({
                name: t.name, chosen: ctaChoiceFromContext(t.setup).kind, resolved: await resolveCta(db, orgId, t.setup),
                incentive: typeof t.setup?.incentive === 'string' ? t.setup.incentive : null,
            }))),
            loadIntroOffer(db, orgId),
            activeIds.length
                ? db.select({ assistantId: goals.assistantId, title: goals.title, metricKey: goals.metricKey }).from(goals)
                    .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true), inArray(goals.assistantId, activeIds)))
                : Promise.resolve([]),
            connectedServices(db, orgId),
            loadBusinessKnowledge(db, orgId).catch(() => null),
            loadOrgTrends(db, orgId).catch(() => [] as OrgTrend[]),
            // What went out lately, to tell whether any of it was a list. Capped: a busy workspace
            // only needs one list found, and the check must never be the slow part of a review.
            db.select({ body: blogPosts.bodyMarkdown }).from(blogPosts)
                .where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.status, 'published'), gte(blogPosts.publishedAt, since)))
                .limit(40).catch(() => []),
            db.select({ caption: scheduledPosts.caption }).from(scheduledPosts)
                .where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'published'), gte(scheduledPosts.publishedAt, since)))
                .limit(80).catch(() => []),
            db.select({ id: orgProducts.id }).from(orgProducts)
                .where(and(eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active'))).limit(50).catch(() => []),
        ]);
        const blogWriters = active.filter((t) => t.roleKey === 'blog_writer').map((t) => ({ id: t.id, name: t.name }));
        const names = new Map(active.map((t) => [t.id, t.name]));
        return {
            ctas,
            offer: intro && intro.has ? summariseIntroOffer({ ...intro, url: null }) : null,
            goals: (goalRows as Array<{ assistantId: number; title: string | null; metricKey: string }>).map((g) => ({
                assistant: names.get(g.assistantId) ?? 'An assistant', label: g.title || getGoalMetric(g.metricKey)?.label || g.metricKey, metricKey: g.metricKey,
            })),
            services,
            knowledge: (knowledge?.documents ?? []).slice(0, MAX_KNOWLEDGE_DOCS).map((d) => ({
                name: d.name, excerpt: d.text.replace(/\s+/g, ' ').trim().slice(0, KNOWLEDGE_EXCERPT_CHARS),
            })),
            hasApprovedPlan: !!knowledge?.strategy,
            seasons: trends.filter((t) => t.approved && t.status === 'ok' && t.nextPeak)
                .map((t) => ({ term: t.term, peakMonths: t.peakMonths, monthsAway: t.nextPeak!.monthsAway })),
            pendingTerms: trends.filter((t) => !t.approved).length,
            lists: {
                blogWriters,
                listedRecently: (recentBlogs as Array<{ body: string | null }>).some((b) => isListPiece(b.body ?? ''))
                    || (recentPosts as Array<{ caption: string | null }>).some((p) => isListPiece(p.caption ?? '')),
                productCount: (productRows as unknown[]).length,
                listTerms: trends.filter((t) => t.approved && isListSearchTerm(t.term)).map((t) => t.term),
            },
        };
    } catch (err) {
        console.error('[mentor-content-checks] could not read (non-fatal)', err instanceof Error ? err.message : err);
        return null;
    }
}
