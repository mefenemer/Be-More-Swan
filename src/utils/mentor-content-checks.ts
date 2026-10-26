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

import { and, eq, inArray } from 'drizzle-orm';
import { goals } from '../../db/schema';
import { connectionDisplayName, getGoalMetric } from '../config/goal-metrics';
import { CTA_LABELS, CTA_ROLES, type CtaKind, type ResolvedCta } from '../config/call-to-action';
import { ctaChoiceFromContext, resolveCta } from './call-to-action';
import { loadIntroOffer, summariseIntroOffer } from './intro-offer';
import { loadBusinessKnowledge } from './business-knowledge';
import { connectedServices } from './goal-connections';
import type { MentorSnapshotData } from './mentor-snapshot';

type Db = any;

export const MAX_KNOWLEDGE_DOCS = 3;
export const KNOWLEDGE_EXCERPT_CHARS = 600;

export interface ContentCheckInputs {
    /** Active Social / Blog / Email assistants: what they were set to invite, and what that resolved to. */
    ctas: Array<{ name: string; chosen: CtaKind; resolved: ResolvedCta }>;
    /** The recorded free trial / intro offer, summarised; null when none is recorded. */
    offer: string | null;
    /** Active assistants' active goals. */
    goals: Array<{ assistant: string; label: string; metricKey: string }>;
    services: string[];
    /** Brand Knowledge documents, cut short, for the model's contradiction check. */
    knowledge: Array<{ name: string; excerpt: string }>;
    /** Whether a plan is approved (the model compares Brand Knowledge against it too). */
    hasApprovedPlan: boolean;
}

export interface ContentFinding { text: string; where: string }

/** Pure: the checks code can decide on its own. */
export function contentFindings(i: Pick<ContentCheckInputs, 'ctas' | 'offer' | 'goals' | 'services'>): ContentFinding[] {
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
        out.push({
            text: `Your offer (${i.offer.replace(/\.$/, '')}) is recorded, but none of your content assistants uses it as its call to action.`,
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
    return out;
}

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
    if (i.knowledge.length && (i.offer || i.hasApprovedPlan)) {
        lines.push('BRAND KNOWLEDGE (excerpts; the owner\'s documents every assistant drafts from). Compare them with the recorded offer'
            + `${i.hasApprovedPlan ? ' and the approved plan' : ''}. ONLY if one clearly contradicts it — a different offer, price, length of trial or audience — say which document and what differs, and that they can fix it under Brand Knowledge. If they agree or you can't tell, say nothing about them.`);
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
        const [ctas, intro, goalRows, services, knowledge] = await Promise.all([
            Promise.all(ctaTeam.map(async (t) => ({
                name: t.name, chosen: ctaChoiceFromContext(t.setup).kind, resolved: await resolveCta(db, orgId, t.setup),
            }))),
            loadIntroOffer(db, orgId),
            activeIds.length
                ? db.select({ assistantId: goals.assistantId, title: goals.title, metricKey: goals.metricKey }).from(goals)
                    .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true), inArray(goals.assistantId, activeIds)))
                : Promise.resolve([]),
            connectedServices(db, orgId),
            loadBusinessKnowledge(db, orgId).catch(() => null),
        ]);
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
        };
    } catch (err) {
        console.error('[mentor-content-checks] could not read (non-fatal)', err instanceof Error ? err.message : err);
        return null;
    }
}
