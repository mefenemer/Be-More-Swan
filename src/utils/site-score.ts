// src/utils/site-score.ts — the Mystery Shopper's scores, computed in CODE.
//
// docs/mystery-shopper-plan.md §3.1. The obvious design — ask the model for "clarity_score: 0-100" —
// is the one this file exists to avoid: a model asked for a number twice about an unchanged page
// answers 61 and then 70, and a weekly score that moves on its own destroys the "watch it climb"
// story the first time a founder re-runs it.
//
// So a score is a weighted sum over two kinds of check, and nothing else:
//   · DETERMINISTIC checks — read straight off the SitePage (site-extract.ts). Same page, same result.
//   · RUBRIC questions — fixed yes/no questions a model answers at temperature 0, each with quoted
//     evidence. The model answers questions; it never picks the number.
// Same answers in any order → same score, always (tests/site-score.test.ts pins this).
//
// Evidence is GROUNDED: a quote that is not on the page is not evidence (`isGrounded`). An answer
// with ungrounded evidence is dropped (counts as not answered), and so is a suggested fix whose
// "current text" the page does not contain — the same "pick only from what is there" rule
// brand-extract.ts applies to colours.

import { classifyCta, normaliseText, type SitePage } from './site-extract';

export type Lens = 'clarity' | 'compete' | 'ai';

export const LENS_LABEL: Record<Lens, string> = {
    clarity: 'First impression',
    compete: 'Against competitors',
    ai: 'AI search readiness',
};

/** Overall = weighted lenses. With no competitors the compete weight is shared out pro rata. */
export const LENS_WEIGHT: Record<Lens, number> = { clarity: 0.45, compete: 0.30, ai: 0.25 };

export type CheckResult = 'pass' | 'fail' | 'na';

export interface CheckOutcome {
    id: string;
    lens: Lens;
    weight: number;
    result: CheckResult;
    /**
     * What is WRONG when this fails, in plain English — the score tooltip and the summary list
     * failures, so every label (code check and rubric alike) is written as the failure.
     */
    label: string;
    source: 'check' | 'rubric';
}

interface Ctx {
    page: SitePage;
    competitors: SitePage[];
}

interface DeterministicCheck {
    id: string;
    lens: Lens;
    weight: number;
    label: string;
    test(ctx: Ctx): CheckResult;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const QUANTIFIED = /\d[\d,.]*\s?(%|x\b|×|hours?|hrs?|days?|weeks?|minutes?|mins?|reviews?|clients?|customers?|businesses|projects|years?|\/\s?5|★|£|\$|€|k\b)/i;
const RISK_REVERSAL = /\b(free trial|cancel any ?time|money[- ]back|guarantee|no contract|no obligation|free consultation|free (call|quote|audit))\b/i;
/**
 * schema.org types that describe the PAGE, not the business. Everything else counts as saying what
 * the business is — a whitelist would miss most of them: schema.org has hundreds of trade-specific
 * subtypes (Plumber, Dentist, Bakery, AccountingService…) and a plumber using `Plumber` is doing it
 * exactly right.
 */
const NON_ENTITY_TYPES = new Set([
    'WebPage', 'WebSite', 'WebPageElement', 'SiteNavigationElement', 'WPHeader', 'WPFooter', 'BreadcrumbList', 'ListItem',
    'ItemList', 'ImageObject', 'VideoObject', 'MediaObject', 'SearchAction', 'ReadAction', 'EntryPoint', 'PropertyValueSpecification',
    'FAQPage', 'Question', 'Answer', 'QAPage', 'AboutPage', 'ContactPage', 'CollectionPage', 'PostalAddress', 'GeoCoordinates',
    'ContactPoint', 'OpeningHoursSpecification', 'AggregateRating', 'Rating', 'Review', 'Offer', 'AggregateOffer',
    'PriceSpecification', 'UnitPriceSpecification', 'Article', 'BlogPosting', 'NewsArticle', 'CreativeWork', 'Thing',
]);

const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Competitor pages we could actually read. A blank competitor is never held against the user. */
const readable = (ctx: Ctx) => ctx.competitors.filter((c) => !c.thin);

export const DETERMINISTIC_CHECKS: readonly DeterministicCheck[] = [
    // ── First impression ──
    { id: 'one_h1', lens: 'clarity', weight: 2, label: 'The page doesn\'t have exactly one main headline (H1)',
        test: ({ page }) => (page.hero.h1.length === 1 ? 'pass' : 'fail') },
    { id: 'h1_length', lens: 'clarity', weight: 2, label: 'The headline isn\'t 3–14 words — too short to say anything, or too long to take in at a glance',
        test: ({ page }) => {
            const h = page.hero.h1[0];
            if (!h) return 'na';
            const n = words(h);
            return n >= 3 && n <= 14 ? 'pass' : 'fail';
        } },
    { id: 'has_subheadline', lens: 'clarity', weight: 1, label: 'There is no supporting line under the headline',
        test: ({ page }) => (page.hero.h1.length ? (page.hero.subheadline ? 'pass' : 'fail') : 'na') },
    { id: 'has_primary_cta', lens: 'clarity', weight: 3, label: 'There is no clear button near the top of the page',
        test: ({ page }) => (page.hero.primaryCtas.length ? 'pass' : 'fail') },
    { id: 'cta_outcome', lens: 'clarity', weight: 3, label: 'The top button says "Learn more" or "Submit" instead of what the visitor gets ("Book a call")',
        test: ({ page }) => {
            if (!page.hero.primaryCtas.length) return 'na';
            return page.hero.primaryCtas.some((c) => classifyCta(c.text) === 'outcome') ? 'pass' : 'fail';
        } },
    { id: 'proof_present', lens: 'clarity', weight: 2, label: 'There is no proof on the page — no reviews, testimonials or case studies',
        test: ({ page }) => (page.structure.proofSnippets.length ? 'pass' : 'fail') },
    { id: 'proof_quantified', lens: 'clarity', weight: 2, label: 'None of the proof has a number in it ("saved 14 hours a week", "4.9 from 312 reviews")',
        test: ({ page }) => {
            if (!page.structure.proofSnippets.length) return 'na';
            return page.structure.proofSnippets.some((p) => QUANTIFIED.test(p)) ? 'pass' : 'fail';
        } },
    { id: 'risk_reversal', lens: 'clarity', weight: 2, label: 'A buyer can\'t see a price, a guarantee, a free trial or any other low-risk first step',
        test: ({ page }) => (page.structure.pricingSignals.length || RISK_REVERSAL.test(page.bodyExcerpt) ? 'pass' : 'fail') },

    // ── AI search readiness ──
    { id: 'title_ok', lens: 'ai', weight: 2, label: 'The page title isn\'t 10–65 characters',
        test: ({ page }) => {
            const t = page.seo.title ?? '';
            return t.length >= 10 && t.length <= 65 ? 'pass' : 'fail';
        } },
    { id: 'description_ok', lens: 'ai', weight: 2, label: 'The search description is missing, or not 50–170 characters',
        test: ({ page }) => {
            const d = page.seo.description ?? '';
            return d.length >= 50 && d.length <= 170 ? 'pass' : 'fail';
        } },
    { id: 'schema_present', lens: 'ai', weight: 2, label: 'The page has no structured data (schema.org) for machines to read',
        test: ({ page }) => (page.seo.schemaTypes.length ? 'pass' : 'fail') },
    { id: 'schema_entity', lens: 'ai', weight: 2, label: 'Nothing in the structured data says what kind of business this is (Organization, LocalBusiness, Service…)',
        test: ({ page }) => (page.seo.schemaTypes.some((t) => !NON_ENTITY_TYPES.has(t)) ? 'pass' : 'fail') },
    { id: 'faq_present', lens: 'ai', weight: 2, label: 'The page doesn\'t answer buyers\' questions in a question-and-answer format',
        test: ({ page }) => (page.structure.faqQuestions.length >= 3 || page.seo.schemaTypes.includes('FAQPage') ? 'pass' : 'fail') },
    { id: 'indexable', lens: 'ai', weight: 3, label: 'The page is hidden from search engines ("noindex")',
        test: ({ page }) => (page.seo.noindex ? 'fail' : 'pass') },
    { id: 'https', lens: 'ai', weight: 1, label: 'The page isn\'t served securely (no https)',
        test: ({ page }) => (page.https ? 'pass' : 'fail') },
    { id: 'mobile_viewport', lens: 'ai', weight: 1, label: 'The page isn\'t set up for phones (no viewport tag)',
        test: ({ page }) => (page.seo.hasViewport ? 'pass' : 'fail') },
    { id: 'images_alt', lens: 'ai', weight: 1, label: 'More than one image in five has no description (alt text)',
        test: ({ page }) => {
            const n = page.structure.imageCount;
            if (!n) return 'na';
            return page.structure.imagesMissingAlt / n <= 0.2 ? 'pass' : 'fail';
        } },
    { id: 'lang_set', lens: 'ai', weight: 1, label: 'The page doesn\'t declare its language',
        test: ({ page }) => (page.seo.lang ? 'pass' : 'fail') },

    // ── Against competitors (relative; n/a with no readable competitor) ──
    { id: 'proof_vs', lens: 'compete', weight: 2, label: 'You show less proof than a typical competitor',
        test: (ctx) => {
            const c = readable(ctx);
            if (!c.length) return 'na';
            return ctx.page.structure.proofSnippets.length >= median(c.map((x) => x.structure.proofSnippets.length)) ? 'pass' : 'fail';
        } },
    { id: 'pricing_vs', lens: 'compete', weight: 2, label: 'Competitors show prices or a guarantee and you don\'t',
        test: (ctx) => {
            const c = readable(ctx);
            if (!c.length) return 'na';
            const theyDo = c.some((x) => x.structure.pricingSignals.length);
            if (!theyDo) return 'na';
            return ctx.page.structure.pricingSignals.length ? 'pass' : 'fail';
        } },
    { id: 'schema_vs', lens: 'compete', weight: 1, label: 'Competitors give machines structured data and you don\'t',
        test: (ctx) => {
            const c = readable(ctx);
            if (!c.length || !c.some((x) => x.seo.schemaTypes.length)) return 'na';
            return ctx.page.seo.schemaTypes.length ? 'pass' : 'fail';
        } },
    { id: 'faq_vs', lens: 'compete', weight: 1, label: 'Competitors answer buyers\' questions on the page and you don\'t',
        test: (ctx) => {
            const c = readable(ctx);
            if (!c.length || !c.some((x) => x.structure.faqQuestions.length >= 3)) return 'na';
            return ctx.page.structure.faqQuestions.length >= 3 ? 'pass' : 'fail';
        } },
    { id: 'cta_vs', lens: 'compete', weight: 2, label: 'Competitors\' top buttons promise an outcome and yours doesn\'t',
        test: (ctx) => {
            const c = readable(ctx);
            const theyDo = c.some((x) => x.hero.primaryCtas.some((b) => classifyCta(b.text) === 'outcome'));
            if (!theyDo) return 'na';
            return ctx.page.hero.primaryCtas.some((b) => classifyCta(b.text) === 'outcome') ? 'pass' : 'fail';
        } },
];

// ── Rubric (answered by a model, scored here) ──────────────────────────────────────────────

export interface RubricQuestion {
    id: string;
    lens: Lens;
    weight: number;
    /** Put to the model verbatim. */
    question: string;
    /** The answer that is GOOD for the business. Some questions are phrased so "no" is good. */
    goodAnswer: boolean;
    /** Shown when the answer is the bad one. */
    label: string;
}

export const RUBRIC: readonly RubricQuestion[] = [
    // First impression — the 5-second sceptic
    { id: 'says_what', lens: 'clarity', weight: 3, goodAnswer: true,
        question: 'Reading only the headline and the line under it, can you say what this business sells?',
        label: 'The headline doesn\'t say what you sell' },
    { id: 'says_who', lens: 'clarity', weight: 3, goodAnswer: true,
        question: 'Reading only the headline and the line under it, can you say who it is for?',
        label: 'The headline doesn\'t say who it is for' },
    { id: 'says_outcome', lens: 'clarity', weight: 2, goodAnswer: true,
        question: 'Does the top of the page promise a concrete result for the buyer (time, money, a specific outcome), not just a process?',
        label: 'The top of the page describes what you do, not what the buyer gets' },
    { id: 'h1_generic', lens: 'clarity', weight: 2, goodAnswer: false,
        question: 'Could a competitor in a different field paste this headline onto their own site without changing a word?',
        label: 'The headline is generic — any business could use it' },
    { id: 'jargon', lens: 'clarity', weight: 1, goodAnswer: false,
        question: 'Does the top of the page rely on buzzwords (e.g. "synergy", "solutions", "empowering", "innovative") in place of plain words?',
        label: 'Buzzwords stand in for plain words at the top of the page' },
    { id: 'cta_fits_goal', lens: 'clarity', weight: 2, goodAnswer: true,
        question: 'Does the main button lead toward the action the business wants (given in the brief), rather than somewhere else?',
        label: 'The main button doesn\'t lead to the action you want visitors to take' },

    // Against competitors — the comparison buyer
    { id: 'clearer_promise', lens: 'compete', weight: 3, goodAnswer: true,
        question: 'Side by side with the competitors, is this business\'s promise at least as clear and specific as the clearest competitor\'s?',
        label: 'A competitor makes a clearer promise' },
    { id: 'feels_safer', lens: 'compete', weight: 2, goodAnswer: true,
        question: 'Would a cautious buyer feel at least as safe choosing this business as the safest-looking competitor (proof, guarantees, visible prices)?',
        label: 'A competitor looks like the safer choice' },
    { id: 'distinct', lens: 'compete', weight: 2, goodAnswer: true,
        question: 'Does this business claim something specific that none of the competitors claim?',
        label: 'Nothing on the page sets you apart from the competitors' },

    // AI search readiness — how an AI assistant is likely to read it (a simulation, plan §3.2)
    { id: 'category_clear', lens: 'ai', weight: 3, goodAnswer: true,
        question: 'From the title, headline and first paragraph alone, could an AI assistant name the category of business in a few words?',
        label: 'An AI assistant would struggle to say what category you are in' },
    { id: 'audience_place_clear', lens: 'ai', weight: 2, goodAnswer: true,
        question: 'Does the page state who it serves and where (a location, or that it serves customers remotely)?',
        label: 'The page doesn\'t say who you serve and where' },
    { id: 'citable_facts', lens: 'ai', weight: 2, goodAnswer: true,
        question: 'Does the page contain concrete, checkable facts an AI could quote (numbers, named methods, years, credentials)?',
        label: 'There are few concrete facts an AI could quote' },
    { id: 'answers_questions', lens: 'ai', weight: 2, goodAnswer: true,
        question: 'Does the page directly answer the questions a buyer would ask an AI about this kind of business (price, process, timescale, fit)?',
        label: 'The page doesn\'t answer the questions buyers ask' },
];

export function rubricFor(lens: Lens): RubricQuestion[] {
    return RUBRIC.filter((q) => q.lens === lens);
}

export interface RubricAnswer {
    id: string;
    yes: boolean;
    /** Quoted text from the page. Empty is allowed (some answers are about absence). */
    evidence: string;
}

/**
 * Turn whatever a model returned into trusted answers: known ids only, a real boolean, first answer
 * per id wins, and evidence must be on the page. Returns how many were dropped so the run can log it.
 */
export function sanitiseRubricAnswers(raw: unknown, lens: Lens, page: SitePage): { answers: RubricAnswer[]; dropped: number } {
    const known = new Set(rubricFor(lens).map((q) => q.id));
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { answers?: unknown }).answers) ? (raw as { answers: unknown[] }).answers : []);
    const answers: RubricAnswer[] = [];
    let dropped = 0;
    const seen = new Set<string>();
    for (const item of list) {
        if (!item || typeof item !== 'object') { dropped++; continue; }
        const { id, yes, evidence } = item as Record<string, unknown>;
        if (typeof id !== 'string' || !known.has(id) || seen.has(id) || typeof yes !== 'boolean') { dropped++; continue; }
        const ev = typeof evidence === 'string' ? evidence.trim() : '';
        if (ev && !isGrounded(ev, page)) { dropped++; continue; }
        seen.add(id);
        answers.push({ id, yes, evidence: ev });
    }
    return { answers, dropped };
}

// ── Grounding ───────────────────────────────────────────────────────────────────────────────

/** All the text the model was shown, normalised once per page. */
const corpusCache = new WeakMap<SitePage, string>();
function corpus(page: SitePage): string {
    let c = corpusCache.get(page);
    if (c === undefined) {
        c = normaliseText([
            page.seo.title, page.seo.description, page.seo.ogTitle,
            ...page.hero.h1, page.hero.subheadline,
            ...page.hero.primaryCtas.map((x) => x.text),
            ...page.structure.h2, ...page.structure.h3,
            ...page.structure.ctas.map((x) => x.text),
            ...page.structure.pricingSignals, ...page.structure.proofSnippets, ...page.structure.faqQuestions,
            page.bodyExcerpt,
        ].filter(Boolean).join('\n'));
        corpusCache.set(page, c);
    }
    return c;
}

/**
 * Is this quote really on the page? Case, whitespace, curly quotes and a trailing ellipsis are
 * forgiven; anything else is not. Quotes under 3 characters prove nothing and are refused.
 */
export function isGrounded(quote: string, page: SitePage): boolean {
    const q = normaliseText(quote).replace(/^["']|["']$/g, '').replace(/(\.\.\.|…)$/, '').trim();
    if (q.length < 3) return false;
    return corpus(page).includes(q);
}

export interface SuggestedFix {
    lens: Lens;
    location: string;
    problem: string;
    currentText: string;
    suggestedText: string;
}

// The names pageForPrompt (site-audit-prompts.ts) gives the page's parts. A model asked for "where
// on the page" sometimes answers with one — "pricingAndGuarantees / Proof section" reached a customer.
const FIELD_WORDS: Record<string, string> = {
    url: 'Page address', title: 'Page title', searchDescription: 'Search description',
    structuredDataTypes: 'Search data', headline: 'Headline', subheadline: 'Subheadline',
    topButtons: 'Top button', sectionHeadings: 'Section heading', subHeadings: 'Subheading',
    otherButtons: 'Button', pricingAndGuarantees: 'Pricing', proof: 'Testimonials',
    questionsAnswered: 'FAQ', forms: 'Form', text: 'Page text',
};
/** "pricingAndGuarantees / Proof section" → "Pricing / Proof section": field names become words. */
export function plainLocation(location: string): string {
    return location.replace(/\b[a-z]+(?:[A-Z][a-z]*)+\b|\b(?:proof|text|forms|url|title|headline|subheadline)\b(?=\s*(?:\/|$))/g,
        (w) => FIELD_WORDS[w] ?? w.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (_, c) => ` ${c.toLowerCase()}`))
        .replace(/\s+/g, ' ').trim();
}

/** Keep only fixes that quote real page text and actually propose something different. */
export function groundFixes(raw: unknown, lens: Lens, page: SitePage): { fixes: SuggestedFix[]; dropped: number } {
    const list = Array.isArray(raw) ? raw : [];
    const fixes: SuggestedFix[] = [];
    let dropped = 0;
    for (const item of list) {
        const f = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
        const fix: SuggestedFix = {
            lens,
            location: plainLocation(str('location')).slice(0, 80),
            problem: str('problem').slice(0, 400),
            currentText: str('currentText').slice(0, 400),
            suggestedText: str('suggestedText').slice(0, 600),
        };
        const ok = fix.problem && fix.suggestedText && fix.currentText &&
            isGrounded(fix.currentText, page) &&
            normaliseText(fix.currentText) !== normaliseText(fix.suggestedText);
        if (ok) fixes.push(fix); else dropped++;
    }
    return { fixes, dropped };
}

// ── The score ───────────────────────────────────────────────────────────────────────────────

export interface LensScore {
    lens: Lens;
    /** 0–100, or null when nothing in this lens applied (e.g. no competitors). */
    score: number | null;
    /** True when the rubric for this lens went unanswered and only code checks counted. */
    partial: boolean;
}

export interface AuditScore {
    overall: number | null;
    lenses: Record<Lens, LensScore>;
    outcomes: CheckOutcome[];
    /** Failed outcomes, heaviest first — what the score tooltip and the summary prompt list. */
    failures: CheckOutcome[];
}

export function runDeterministicChecks(page: SitePage, competitors: SitePage[] = []): CheckOutcome[] {
    const ctx: Ctx = { page, competitors };
    return DETERMINISTIC_CHECKS.map((c) => ({
        id: c.id, lens: c.lens, weight: c.weight, label: c.label, source: 'check' as const,
        result: page.thin ? 'na' : c.test(ctx),
    }));
}

/**
 * The whole score. `answers` holds the sanitised rubric answers per lens; a lens missing from it
 * (model call failed) scores on code checks alone and is flagged `partial`.
 *
 * A thin page (nothing server-rendered to read) scores null everywhere — "we couldn't read it" is
 * the finding, and a number would pretend otherwise.
 */
export function scoreAudit(
    page: SitePage,
    competitors: SitePage[],
    answers: Partial<Record<Lens, RubricAnswer[]>>,
): AuditScore {
    const hasCompetitors = competitors.some((c) => !c.thin);
    const outcomes: CheckOutcome[] = runDeterministicChecks(page, competitors);

    for (const q of RUBRIC) {
        if (q.lens === 'compete' && !hasCompetitors) {
            outcomes.push({ id: q.id, lens: q.lens, weight: q.weight, label: q.label, source: 'rubric', result: 'na' });
            continue;
        }
        const a = answers[q.lens]?.find((x) => x.id === q.id);
        const result: CheckResult = page.thin || !a ? 'na' : (a.yes === q.goodAnswer ? 'pass' : 'fail');
        outcomes.push({ id: q.id, lens: q.lens, weight: q.weight, label: q.label, source: 'rubric', result });
    }

    const lensScore = (lens: Lens): LensScore => {
        const applicable = outcomes.filter((o) => o.lens === lens && o.result !== 'na');
        const total = applicable.reduce((s, o) => s + o.weight, 0);
        const got = applicable.filter((o) => o.result === 'pass').reduce((s, o) => s + o.weight, 0);
        const rubricApplies = !(lens === 'compete' && !hasCompetitors);
        return {
            lens,
            score: total ? Math.round((got / total) * 100) : null,
            partial: rubricApplies && !page.thin && !answers[lens],
        };
    };
    const lenses: Record<Lens, LensScore> = { clarity: lensScore('clarity'), compete: lensScore('compete'), ai: lensScore('ai') };

    let weightSum = 0;
    let acc = 0;
    for (const lens of Object.keys(LENS_WEIGHT) as Lens[]) {
        const s = lenses[lens].score;
        if (s === null) continue;
        weightSum += LENS_WEIGHT[lens];
        acc += LENS_WEIGHT[lens] * s;
    }
    const overall = weightSum ? Math.round(acc / weightSum) : null;

    const failures = outcomes
        .filter((o) => o.result === 'fail')
        .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

    return { overall, lenses, outcomes, failures };
}

/**
 * The public taster's score (plan §4.7): homepage only, first-impression lens only. Same machinery,
 * so a taster score and a hired score for the same page and answers agree on that lens.
 */
export function scoreTaster(page: SitePage, clarityAnswers: RubricAnswer[] | undefined): LensScore & { failures: CheckOutcome[] } {
    const full = scoreAudit(page, [], clarityAnswers ? { clarity: clarityAnswers } : {});
    return { ...full.lenses.clarity, failures: full.failures.filter((f) => f.lens === 'clarity') };
}
