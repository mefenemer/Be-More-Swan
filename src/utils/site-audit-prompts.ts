// src/utils/site-audit-prompts.ts — what the Mystery Shopper's model calls are asked, and how the
// summary they write is checked. docs/mystery-shopper-plan.md §4.4.
//
// PURE: no network, no database — tests/site-audit-pipeline.test.ts reads these strings directly.
//
// The models do two narrow jobs and never a third:
//   · LENS calls answer the fixed yes/no rubric (site-score.ts RUBRIC) with quoted evidence, and
//     suggest rewrites that quote the current text. They never produce a score.
//   · The SUMMARY call picks which of the already-grounded fixes matter most, explains why, writes a
//     2–3 sentence summary, and drafts hand-off briefs. It never writes a fix of its own — it can only
//     point at one by index — so nothing it says can introduce a quote the page doesn't contain.
//
// Every number in the summary must be one we gave it (`summaryNumbersAreKnown`); a summary that
// invents "conversion up 30%" is replaced by the plain one this file writes in code.

import { coveredBlock, sameIdea, type CoveredItem } from './site-audit-covered';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../constants/safety-benchmark';
import { SPECIAL_CATEGORY_RULE } from '../constants/special-category-rule';
import { currentDatePromptBlock } from './current-date-prompt';
import type { SitePage } from './site-extract';
import { LENS_LABEL, rubricFor, type AuditScore, type Lens, type SuggestedFix } from './site-score';

export interface AuditBrief {
    url: string;
    /** Who the site is for, in the business's words. */
    icp: string | null;
    /** What a visitor should do. */
    conversionGoal: string | null;
    /** loadProductsBlock output, or null — the only facts a rewrite may add beyond the page. */
    productsBlock: string | null;
    /**
     * The user's Rules for this assistant (loadAssistantRulesBlock), or null. Every rewrite must obey
     * them — "never mention prices" applies to suggested copy as much as to a chat reply. Optional so
     * the public taster, which has no assistant, needs none.
     */
    rulesBlock?: string | null;
}

/** Max suggested fixes per lens — the summary picks three across all lenses. */
export const FIXES_PER_LENS = 4;

/** The targets a hand-off may name. Each has a chat route that can take a brief. */
export const HANDOFF_TARGETS = ['social_media_manager', 'blog_writer', 'campaign_orchestrator'] as const;
export type HandoffTarget = typeof HANDOFF_TARGETS[number];

/** The page as the model sees it — the payload minus what only the code needs. */
export function pageForPrompt(page: SitePage, excerptChars = 3500): Record<string, unknown> {
    return {
        url: page.url,
        title: page.seo.title,
        searchDescription: page.seo.description,
        structuredDataTypes: page.seo.schemaTypes,
        headline: page.hero.h1,
        subheadline: page.hero.subheadline,
        topButtons: page.hero.primaryCtas.map((c) => c.text),
        sectionHeadings: page.structure.h2,
        subHeadings: page.structure.h3.slice(0, 12),
        otherButtons: page.structure.ctas.map((c) => c.text),
        pricingAndGuarantees: page.structure.pricingSignals,
        proof: page.structure.proofSnippets,
        questionsAnswered: page.structure.faqQuestions,
        forms: page.structure.formCount,
        text: page.bodyExcerpt.slice(0, excerptChars),
    };
}

const LENS_ROLE: Record<Lens, string> = {
    clarity: `You are a time-poor, sceptical buyer who matches the ideal customer below. You have just landed on this page and you give it five seconds before closing the tab. Judge only what is on the page.`,
    compete: `You are a buyer with budget in hand, comparing this business with its competitors in open browser tabs to decide who gets the work today. Judge only what is on the pages you are given.`,
    ai: `You are simulating how an AI assistant (the kind people ask "who should I hire for…?") would read this page when deciding whether it can recommend the business. You are NOT that assistant and you have not searched anything — judge only whether the page gives such a system what it needs: a clear category, who and where it serves, quotable facts and direct answers.`,
};

function systemPrompt(role: string): string {
    return [
        role,
        currentDatePromptBlock(),
        SPECIAL_CATEGORY_RULE,
        AURA_SAFE_CONTENT_BENCHMARK,
    ].join('\n\n');
}

function briefBlock(brief: AuditBrief): string {
    return [
        `<brief>`,
        `Website: ${brief.url}`,
        `Ideal customer: ${brief.icp?.trim() || '(not given — infer it from the page, and say so where it matters)'}`,
        `What a visitor should do: ${brief.conversionGoal?.trim() || '(not given)'}`,
        `</brief>`,
        brief.productsBlock ? `\n${brief.productsBlock}` : '',
        brief.rulesBlock ? `\n${brief.rulesBlock}\nEvery suggested rewrite and every hand-off brief must follow these rules.` : '',
    ].join('\n');
}

const EVIDENCE_RULES = `<rules>
- Answer every question with "yes": true or false. Do not skip any.
- "evidence" must be copied EXACTLY, character for character, from the page data — a headline, a button, a sentence. If the answer rests on something being ABSENT, leave evidence as "". Never paraphrase inside evidence: anything not found on the page is discarded.
- "currentText" in a fix must also be copied exactly from the page data. Fixes that quote text not on the page are discarded.
- "location" names the place in words the business owner uses — "Headline", "Top button", "Testimonials", "Pricing", "Footer". Never a field name from the page data (not "pricingAndGuarantees", "proof", "otherButtons").
- A quote ending in "…" was shortened by US to save space; the page shows it in full. Never say text is cut off, truncated or hidden because it ends in "…", and never suggest showing "the full quote". Never use a quote ending in "…" as "currentText" — you have not seen the rest of it, so any rewrite would invent words. Fixes that do are discarded.
- A testimonial or review is a real customer's own words. Never rewrite one or add a result they did not give; if proof is weak, suggest asking the customer for a specific result instead.
- "suggestedText" replaces "currentText" in the same place and must do the same job there. Never take a passage about one thing (a referral offer, a testimonial) and replace it with a message about something else — if the page is missing something, quote the nearest text it would sit beside and add to it, keeping what was there.
- "suggestedText" is the replacement, written for the ideal customer in plain British English. Use only facts that are on the page or in the products list. Where a better line needs a fact you don't have (a number of clients, a guarantee period), put a clear placeholder in square brackets, e.g. "[number] agencies", rather than inventing one.
- At most ${FIXES_PER_LENS} fixes, most important first. No fixes for things that are already fine.
- Reply with the JSON object only.
</rules>`;

function rubricBlock(lens: Lens): string {
    const lines = rubricFor(lens).map((q) => `- ${q.id}: ${q.question}`);
    return `<questions>\n${lines.join('\n')}\n</questions>`;
}

const LENS_OUTPUT = `<output>
{"answers":[{"id":"<question id>","yes":true,"evidence":"<exact quote or empty>"}],
 "fixes":[{"location":"<where on the page, e.g. Headline, Top button, Proof>","problem":"<why a buyer bounces, one sentence>","currentText":"<exact quote>","suggestedText":"<replacement>"}]}
</output>`;

export interface LensPrompt { system: string; user: string; }

export function buildLensPrompt(
    lens: Lens,
    brief: AuditBrief,
    page: SitePage,
    competitors: Array<{ page: SitePage; changes: string[] }> = [],
): LensPrompt {
    const parts = [briefBlock(brief), `<page>\n${JSON.stringify(pageForPrompt(page))}\n</page>`];
    if (lens === 'compete') {
        competitors.forEach((c, i) => {
            const changed = c.changes.length ? `\nChanged since our last look:\n- ${c.changes.join('\n- ')}` : '';
            parts.push(`<competitor n="${i + 1}">\n${JSON.stringify(pageForPrompt(c.page, 1200))}${changed}\n</competitor>`);
        });
    }
    parts.push(rubricBlock(lens), EVIDENCE_RULES, LENS_OUTPUT);
    return { system: systemPrompt(LENS_ROLE[lens]), user: parts.join('\n\n') };
}

// ── The summary ─────────────────────────────────────────────────────────────────────────────

export interface SummaryInput {
    brief: AuditBrief;
    score: AuditScore;
    previousScore: number | null;
    fixes: SuggestedFix[];
    competitorChanges: Array<{ url: string; changes: string[] }>;
    /** Ideas already suggested, briefed or written by the other assistants (site-audit-covered.ts). */
    covered?: CoveredItem[];
}

export function buildSummaryPrompt(input: SummaryInput): LensPrompt {
    const { score } = input;
    const lensLines = (Object.keys(score.lenses) as Lens[])
        .map((l) => `${LENS_LABEL[l]}: ${score.lenses[l].score ?? 'not scored'}`);
    const fixLines = input.fixes.map((f, i) =>
        `[${i}] (${LENS_LABEL[f.lens]}, ${f.location}) ${f.problem}\n    now: "${f.currentText}"\n    suggested: "${f.suggestedText}"`);
    const changes = input.competitorChanges
        .filter((c) => c.changes.length)
        .map((c) => `${c.url}:\n- ${c.changes.join('\n- ')}`);

    const user = [
        briefBlock(input.brief),
        `<scores>\nOverall: ${score.overall ?? 'not scored'}${input.previousScore !== null ? ` (last time: ${input.previousScore})` : ' (first check)'}\n${lensLines.join('\n')}\n</scores>`,
        `<failed_checks>\n${score.failures.slice(0, 10).map((f) => `- ${f.label}`).join('\n') || '(none)'}\n</failed_checks>`,
        `<suggested_fixes>\n${fixLines.join('\n') || '(none)'}\n</suggested_fixes>`,
        changes.length ? `<competitor_changes>\n${changes.join('\n')}\n</competitor_changes>` : '',
        coveredBlock(input.covered ?? []),
        `<rules>
- "summary": 2–3 short sentences to the business owner: where the site stands, what moved since last time, and the single most important thing to change. Calm and direct, no hype. Use ONLY the numbers given above — do not invent percentages, conversion rates or forecasts.
- "priorities": up to 3 of the suggested fixes, by their [index], most valuable first, each with one sentence on why it matters commercially and an impact of "high", "medium" or "low". You may not write new fixes.
- "handoffs": up to 2 briefs for other assistants who could help while the website is being changed. "target" is one of ${HANDOFF_TARGETS.map((t) => `"${t}"`).join(', ')}. "title" is a short button label; "brief" is 2–4 sentences the assistant can act on. Only include a hand-off if it genuinely helps AND says something new: never one that repeats or overlaps anything in <already_covered>. When everything useful is already covered, return "handoffs": [] — an empty list is the right answer then, not a reworded repeat.
- Reply with the JSON object only.
</rules>`,
        `<output>\n{"summary":"","priorities":[{"fix":0,"whyItMatters":"","impact":"high"}],"handoffs":[{"target":"blog_writer","title":"","brief":""}]}\n</output>`,
    ].filter(Boolean).join('\n\n');

    return {
        system: systemPrompt('You are the Mystery Shopper, a calm, commercially sharp assistant working for the owner of this website. You have read the site as a buyer would; now you tell the owner what matters most.'),
        user,
    };
}

export interface Priority { fix: number; whyItMatters: string; impact: 'high' | 'medium' | 'low'; }
export interface Handoff { target: HandoffTarget; title: string; brief: string; }
export interface SummaryOutput { summary: string; priorities: Priority[]; handoffs: Handoff[]; }

/** Numbers the summary is allowed to mention: the scores and the previous score, nothing else. */
export function allowedSummaryNumbers(score: AuditScore, previousScore: number | null): Set<number> {
    const n = new Set<number>([1, 2, 3, 5]);   // "the one change", "two buttons", "5 seconds" are prose, not claims
    if (score.overall !== null) n.add(score.overall);
    if (previousScore !== null) {
        n.add(previousScore);
        if (score.overall !== null) n.add(Math.abs(score.overall - previousScore));
    }
    for (const l of Object.values(score.lenses)) if (l.score !== null) n.add(l.score);
    return n;
}

export function summaryNumbersAreKnown(text: string, allowed: Set<number>): boolean {
    for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
        if (!allowed.has(Number(m[0]))) return false;
    }
    return true;
}

/** Validate the summary call. Anything unusable falls back to `fallbackSummary` — never an error. */
export function sanitiseSummary(raw: unknown, input: SummaryInput): SummaryOutput {
    const fallback = fallbackSummary(input);
    if (!raw || typeof raw !== 'object') return fallback;
    const r = raw as Record<string, unknown>;

    let summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, 600) : '';
    if (!summary || !summaryNumbersAreKnown(summary, allowedSummaryNumbers(input.score, input.previousScore))) {
        summary = fallback.summary;
    }

    const priorities: Priority[] = [];
    for (const p of Array.isArray(r.priorities) ? r.priorities : []) {
        const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
        const fix = Number(o.fix);
        if (!Number.isInteger(fix) || fix < 0 || fix >= input.fixes.length || priorities.some((x) => x.fix === fix)) continue;
        const impact = o.impact === 'high' || o.impact === 'low' ? o.impact : 'medium';
        const why = typeof o.whyItMatters === 'string' ? o.whyItMatters.trim().slice(0, 300) : '';
        priorities.push({ fix, impact, whyItMatters: why || input.fixes[fix].problem });
        if (priorities.length >= 3) break;
    }

    const handoffs: Handoff[] = [];
    for (const h of Array.isArray(r.handoffs) ? r.handoffs : []) {
        const o = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
        if (!HANDOFF_TARGETS.includes(o.target as HandoffTarget)) continue;
        const title = typeof o.title === 'string' ? o.title.trim().slice(0, 80) : '';
        const brief = typeof o.brief === 'string' ? o.brief.trim().slice(0, 800) : '';
        if (!title || !brief) continue;
        // The model was told what is already covered; this catches a repeat it wrote anyway.
        if ((input.covered ?? []).some((c) => c.target === o.target && sameIdea(c.text, title))) continue;
        handoffs.push({ target: o.target as HandoffTarget, title, brief });
        if (handoffs.length >= 2) break;
    }

    return {
        summary,
        priorities: priorities.length ? priorities : fallback.priorities,
        handoffs,
    };
}

const LENS_ORDER: Record<Lens, number> = { clarity: 0, compete: 1, ai: 2 };

/**
 * The summary written in code — used when the model's is missing, malformed or quotes a number we
 * didn't give it. Plain on purpose; it states only what the score already says.
 */
export function fallbackSummary(input: SummaryInput): SummaryOutput {
    const { score, previousScore } = input;
    const parts: string[] = [];
    if (score.overall === null) {
        parts.push('We couldn\'t score the page this time.');
    } else if (previousScore === null) {
        parts.push(`Your site scores ${score.overall} out of 100 on its first check.`);
    } else if (score.overall === previousScore) {
        parts.push(`Your site still scores ${score.overall} out of 100.`);
    } else {
        parts.push(`Your site scores ${score.overall} out of 100, ${score.overall > previousScore ? 'up' : 'down'} from ${previousScore}.`);
    }
    const top = score.failures[0];
    if (top) parts.push(`The most important thing to fix: ${top.label.charAt(0).toLowerCase()}${top.label.slice(1)}.`);

    // Without the model's judgement, take one fix per lens first, in lens order, then the rest.
    const order = input.fixes
        .map((f, i) => ({ f, i }))
        .sort((a, b) => LENS_ORDER[a.f.lens] - LENS_ORDER[b.f.lens] || a.i - b.i);
    const picked: number[] = [];
    for (const lens of ['clarity', 'compete', 'ai'] as Lens[]) {
        const first = order.find((x) => x.f.lens === lens);
        if (first) picked.push(first.i);
    }
    for (const x of order) if (picked.length < 3 && !picked.includes(x.i)) picked.push(x.i);

    return {
        summary: parts.join(' '),
        priorities: picked.slice(0, 3).map((i, n) => ({
            fix: i, impact: n === 0 ? 'high' : 'medium', whyItMatters: input.fixes[i].problem,
        })),
        handoffs: [],
    };
}
