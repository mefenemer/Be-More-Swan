// src/utils/site-draft.ts — the Website Assistant's first draft of a whole site, and the starter it
// begins from. docs/website-assistant-plan.md §5.3. PURE: no database, no network.
//
// The model writes a site DEFINITION (JSON), never HTML, and its reply goes straight through the one
// gate (normaliseSiteDefinition) — so a draft can only ever contain sections the renderer knows.
// The theme is NOT the model's: colours, font and logo come from the workspace brand kit.
//
// Honesty rules the prompt states and `placeholdersIn` lets later steps enforce:
//   · no invented testimonials, reviews, prices, numbers, awards, years or guarantees — where a page
//     needs one, the draft writes a [placeholder] the owner fills in;
//   · step 3's publish refuses a page that still has a [placeholder] on it.

import { AURA_SAFE_CONTENT_BENCHMARK } from '../constants/safety-benchmark';
import { SPECIAL_CATEGORY_RULE } from '../constants/special-category-rule';
import type { BrandKit } from './brand-kit';
import { currentDatePromptBlock } from './current-date-prompt';
import {
    applySiteOperation, cleanHref, DEFAULT_THEME, LIMITS, normaliseSiteDefinition, sectionAllowed, type BusinessType, type SectionType, type SiteDefinition, type SiteTheme,
} from './site-definition';

export interface BusinessFacts {
    name: string;
    industry: string | null;
    description: string | null;
    audience: string | null;
    websiteUrl: string | null;
    email: string | null;
}

export interface DraftBrief {
    business: BusinessFacts;
    /** loadProductsBlock output — the only prices and offers the draft may state. */
    productsBlock: string | null;
    /** The user's Rules for this assistant (loadAssistantRulesBlock). */
    rulesBlock: string | null;
    /** Set-up answers: what visitors should do, the pages they want, how it should feel. */
    goal: string | null;
    pagesWanted: string | null;
    style: string | null;
    /** What they asked for just now, in their words (the button's text box or the chat card). */
    request: string | null;
    maxPages: number;
}

/** The brand kit as a site theme. A neutral default where the workspace has none. */
export function themeFromBrandKit(kit: Partial<BrandKit> | null | undefined): SiteTheme {
    const logo = cleanHref(kit?.logoUrl ?? '');
    const { definition } = normaliseSiteDefinition({ theme: {
        primaryColor: kit?.primaryColor, textColor: kit?.textColor, backgroundColor: kit?.backgroundColor,
        font: 'sans', radius: 'medium', logoUrl: logo && logo.startsWith('https://') ? logo : null,
    } });
    return definition.theme ?? DEFAULT_THEME;
}

/**
 * The site a new hire starts with before any AI draft: a home page and a contact page, written from
 * what the workspace already knows. Honest and plain — it says only what is on the profile.
 */
export function starterSite(business: BusinessFacts, theme: SiteTheme): SiteDefinition {
    const contactBody = business.email
        ? `Email us at ${business.email} and we will get back to you.`
        : 'Tell us how to reach you and we will get back to you. [Add your email address or phone number]';
    return normaliseSiteDefinition({
        theme,
        settings: { siteName: business.name, description: business.description?.slice(0, LIMITS.description) ?? null, businessType: 'Organization', email: business.email },
        pages: [
            { title: 'Home', slug: '', sections: [
                { type: 'hero', props: { layout: 'centered', headline: business.name, subheadline: business.description?.slice(0, LIMITS.subheadline) ?? '[One sentence on who you help and how]',
                    primaryCta: { label: 'Get in touch', href: '/contact' } } },
            ] },
            { title: 'Contact', slug: 'contact', sections: [{ type: 'text', props: { heading: 'Get in touch', body: contactBody } }] },
        ],
    }).definition;
}

/** Every [placeholder] still in the site, with where it is — what the owner must fill in before publishing. */
export function placeholdersIn(def: SiteDefinition): Array<{ pageId: string; pageTitle: string; sectionId: string | null; text: string }> {
    const out: Array<{ pageId: string; pageTitle: string; sectionId: string | null; text: string }> = [];
    const scan = (value: unknown, pageId: string, pageTitle: string, sectionId: string | null) => {
        if (typeof value === 'string') {
            for (const m of value.matchAll(/\[[^\][]{1,60}\]/g)) out.push({ pageId, pageTitle, sectionId, text: m[0] });
        } else if (Array.isArray(value)) value.forEach((v) => scan(v, pageId, pageTitle, sectionId));
        else if (value && typeof value === 'object') Object.values(value).forEach((v) => scan(v, pageId, pageTitle, sectionId));
    };
    for (const p of def.pages) {
        scan([p.title, p.seo], p.id, p.title, null);
        for (const s of p.sections) scan(s.props, p.id, p.title, s.id);
    }
    scan([def.settings, def.footer], def.pages[0]?.id ?? '', 'Site details', null);
    return out;
}

const SECTION_SCHEMA = `Section types and their props (use ONLY these; any other type or prop is discarded):
- "hero": { "layout": "centered" | "split" | "banner", "eyebrow": short label or null, "headline": max ${LIMITS.headline} chars, "subheadline": max ${LIMITS.subheadline} chars, "primaryCta": { "label", "href" } or null, "secondaryCta": { "label", "href" } or null }
- "features": { "heading", "intro", "items": [ { "title", "body" } ] }  (1–${LIMITS.features} items)
- "steps": { "heading", "intro", "items": [ { "title", "body" } ] }  (${LIMITS.stepsMin}–${LIMITS.steps} steps)
- "text": { "heading", "body" }  (body: paragraphs separated by a blank line)
- "faq": { "heading", "items": [ { "q", "a" } ] }  (1–${LIMITS.faqItems})
- "testimonials": { "heading", "items": [ { "quote", "name", "detail" } ] }
- "cta": { "heading", "body", "button": { "label", "href" } }
- "contact": { "heading", "intro", "askPhone": true | false, "buttonLabel" }  (an enquiry form — put one on the contact page)
Links ("href") may only be "/" (home), "/<slug>" of a page in this site, "#<section-id>", "mailto:…", "tel:…" or an https address.`;

/** The business facts every draft is written from (what they told us, and nothing else). */
export function draftFacts(brief: DraftBrief): string {
    const b = brief.business;
    return [
        `Business name: ${b.name}`,
        b.industry ? `Industry: ${b.industry}` : '',
        b.description ? `What they do (their words): ${b.description}` : '',
        b.audience ? `Who they serve (their words): ${b.audience}` : '',
        b.websiteUrl ? `Their current website: ${b.websiteUrl}` : '',
        b.email ? `Contact email: ${b.email}` : '',
        brief.goal ? `What a visitor should do: ${brief.goal}` : '',
        brief.pagesWanted ? `Pages they want: ${brief.pagesWanted}` : '',
        brief.style ? `How the site should feel: ${brief.style}` : '',
    ].filter(Boolean).join('\n');
}

export function buildDraftPrompt(brief: DraftBrief): { system: string; user: string } {
    const facts = draftFacts(brief);

    const system = [
        'You are the Website Assistant: you write a small business\'s website as structured content that a renderer turns into pages. You never write HTML, CSS or code.',
        currentDatePromptBlock(),
        SPECIAL_CATEGORY_RULE,
        AURA_SAFE_CONTENT_BENCHMARK,
    ].join('\n\n');

    const user = [
        `<business>\n${facts}\n</business>`,
        brief.productsBlock ?? '',
        brief.rulesBlock ? `${brief.rulesBlock}\nEvery word of the site must follow these rules.` : '',
        brief.request ? `<request>\n${brief.request}\n</request>` : '',
        `<rules>
- Write a complete site of at most ${brief.maxPages} page${brief.maxPages === 1 ? '' : 's'}. The first page is the home page (slug ""). Give every other page a short lowercase slug.
- The home page opens with a hero whose headline says what the business does and who it is for, in plain words — no slogans a competitor could use. Its main button leads to the action a visitor should take.
- Plain British English. Short sentences. No jargon, no hype.
- NEVER invent facts: no testimonials, reviews, customer names, prices, numbers, years, awards, guarantees or results that are not in the business details or products above. Where a page genuinely needs one, write a clear placeholder in square brackets — e.g. "[number] customers since [year]", or a testimonials section whose items are "[A customer's words]" with name "[Customer name]" — for the owner to fill in.
- Answer the questions buyers ask (price, process, timescale, who it suits) in a "faq" section where you can do so from the facts above.
- Every page gets an seo.title (max ${LIMITS.seoTitle} chars) and seo.description (max ${LIMITS.seoDescription} chars).
- Reply with the JSON object only.
</rules>`,
        SECTION_SCHEMA,
        `<output>
{"settings":{"siteName":"","description":"","businessType":"Organization | LocalBusiness | ProfessionalService | Store","locality":"<town or null>"},
 "pages":[{"title":"Home","slug":"","seo":{"title":"","description":""},"sections":[{"type":"hero","props":{}}]}]}
</output>`,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

/**
 * The model's reply, made into a site: through the gate, with OUR theme, footer and credit-bearing
 * settings kept. Null when the reply has no usable page (the caller keeps the current draft).
 */
export function siteFromDraftReply(raw: unknown, current: SiteDefinition, maxPages: number): { definition: SiteDefinition; warnings: string[] } | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { settings?: Record<string, unknown>; pages?: unknown };
    if (!Array.isArray(r.pages) || !r.pages.length) return null;
    const settings = { ...current.settings, ...(r.settings ?? {}) } as Record<string, unknown>;
    const types: BusinessType[] = ['Organization', 'LocalBusiness', 'ProfessionalService', 'Store'];
    if (!types.includes(settings.businessType as BusinessType)) settings.businessType = current.settings.businessType;
    // The email and phone are facts the model must not change; they come from the current site.
    settings.email = current.settings.email;
    settings.phone = current.settings.phone;
    // What the website does is the owner's choice (Details ▸ What your website does), never the draft's.
    settings.features = current.settings.features;
    // Prices are the owner's alone: a draft never puts things up for sale (step 3c), nor lists them;
    // and the pictures in a gallery, or the reviews quoted, are the owner's choice, never a draft's.
    const DRAFT_NEVER = ['products', 'menu', 'gallery', 'reviews'];
    const pages = (r.pages as unknown[]).map((pg) => {
        if (!pg || typeof pg !== 'object') return pg;
        const o = pg as { sections?: unknown };
        // …and a kind of section whose feature they switched off is never drafted.
        const keep = (x: unknown) => !!x && typeof x === 'object' && !DRAFT_NEVER.includes(String((x as { type?: unknown }).type))
            && sectionAllowed(current.settings, String((x as { type?: unknown }).type) as SectionType);
        return Array.isArray(o.sections) ? { ...o, sections: o.sections.filter(keep) } : pg;
    });
    const result = normaliseSiteDefinition({ theme: current.theme, settings, nav: [], pages, footer: current.footer, structure: current.structure }, { maxPages });
    if (!result.definition.pages.some((p) => p.sections.length)) return null;
    // A one-page site stays one page: a draft written as several pages is combined, each page's first
    // section becoming its menu entry (the same operation as the editor's "Combine into one page").
    if (current.structure === 'one_page' && result.definition.pages.length > 1) {
        const combined = applySiteOperation(result.definition, { op: 'combine_pages' }, { maxPages });
        if (combined.ok) return { definition: combined.definition, warnings: [...result.warnings, ...combined.warnings] };
    }
    return result;
}
