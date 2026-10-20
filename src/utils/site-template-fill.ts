// src/utils/site-template-fill.ts — "write my site" on a site started from a template (owner,
// 2026-10-18: the template "forms the basis of the first draft"). Instead of drafting a new site, the
// model rewrites the WORDS of the sections that are there, for this business — the layout, the
// pictures, the design and every link stay exactly as the template (and the owner) left them.
//
// Pure: the prompt, and putting the reply back. site-store.ts runSiteDraft calls it when the site
// has settings.template; every change still goes through applySiteOperation (the one gate).

import { currentDatePromptBlock } from './current-date-prompt';
import { SPECIAL_CATEGORY_RULE } from '../constants/special-category-rule';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../constants/safety-benchmark';
import { applySiteOperation, type Section, type SiteDefinition } from './site-definition';
import { draftFacts, type DraftBrief } from './site-draft';

type Words = Record<string, unknown>;

/** The words of one section that a writer may change — never links, pictures, kinds or settings. */
export function wordsOf(s: Section): Words | null {
    const p = s.props as Record<string, any>;
    const items = (list: any[], keys: string[]) => (Array.isArray(list) ? list.map((x) => Object.fromEntries(keys.map((k) => [k, x?.[k] ?? '']))) : []);
    switch (s.type) {
        case 'hero': return { eyebrow: p.eyebrow ?? '', headline: p.headline, subheadline: p.subheadline ?? '', primaryButton: p.primaryCta?.label ?? null, secondaryButton: p.secondaryCta?.label ?? null };
        case 'text': return { heading: p.heading ?? '', body: p.body };
        case 'features': case 'steps': return { heading: p.heading ?? '', intro: p.intro ?? '', items: items(p.items, ['title', 'body']) };
        case 'faq': return { heading: p.heading ?? '', items: items(p.items, ['q', 'a']) };
        case 'cta': return { heading: p.heading ?? '', body: p.body ?? '', button: p.button?.label ?? '' };
        case 'contact': case 'booking': case 'hours': case 'reviews': case 'gallery': case 'signup': case 'social_feed': return { heading: p.heading ?? '', intro: p.intro ?? '' };
        default: return null;   // products, menu, testimonials: the owner's own, never rewritten
    }
}

/** The reply's words for one section, as props changes — only the keys it may change, and items by position. */
export function propsFromWords(s: Section, w: unknown): Record<string, unknown> | null {
    if (!w || typeof w !== 'object') return null;
    const o = w as Record<string, unknown>;
    const p = s.props as Record<string, any>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const out: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => { if (v !== undefined) out[k] = v; };
    switch (s.type) {
        case 'hero':
            set('eyebrow', str(o.eyebrow)); set('headline', str(o.headline)); set('subheadline', str(o.subheadline));
            if (p.primaryCta && str(o.primaryButton)) out.primaryCta = { ...p.primaryCta, label: o.primaryButton };
            if (p.secondaryCta && str(o.secondaryButton)) out.secondaryCta = { ...p.secondaryCta, label: o.secondaryButton };
            break;
        case 'text': set('heading', str(o.heading)); set('body', str(o.body)); break;
        case 'features': case 'steps': case 'faq': {
            set('heading', str(o.heading)); if (s.type !== 'faq') set('intro', str(o.intro));
            const keys = s.type === 'faq' ? ['q', 'a'] : ['title', 'body'];
            const given = Array.isArray(o.items) ? o.items : [];
            // The same items, in the same order: a writer changes the words, not how many there are.
            if (given.length) out.items = (p.items as any[]).map((it, i) => ({ ...it, ...Object.fromEntries(keys.map((k) => [k, str((given[i] as any)?.[k]) ?? it[k]])) }));
            break;
        }
        case 'cta':
            set('heading', str(o.heading)); set('body', str(o.body));
            if (p.button && str(o.button)) out.button = { ...p.button, label: o.button };
            break;
        case 'contact': case 'booking': case 'hours': case 'reviews': case 'gallery': case 'signup': case 'social_feed':
            set('heading', str(o.heading)); set('intro', str(o.intro)); break;
        default: return null;
    }
    return Object.keys(out).length ? out : null;
}

export function buildFillPrompt(brief: DraftBrief, def: SiteDefinition): { system: string; user: string } {
    const layout = def.pages.map((pg) => ({
        page: pg.id, title: pg.title,
        sections: pg.sections.map((s) => ({ id: s.id, type: s.type, words: wordsOf(s) })).filter((x) => x.words),
    }));
    const system = [
        'You are the Website Assistant. A small business picked a website template; you rewrite its words so they are about THIS business. You never change the layout, links or pictures, and you never write HTML.',
        currentDatePromptBlock(),
        SPECIAL_CATEGORY_RULE,
        AURA_SAFE_CONTENT_BENCHMARK,
    ].join('\n\n');
    const user = [
        `<business>\n${draftFacts(brief)}\n</business>`,
        brief.productsBlock ?? '',
        brief.rulesBlock ? `${brief.rulesBlock}\nEvery word of the site must follow these rules.` : '',
        brief.request ? `<request>\n${brief.request}\n</request>` : '',
        `<template>\n${JSON.stringify(layout)}\n</template>`,
        `<rules>
- Rewrite every section's "words" for this business. Keep the same keys, and the same number of items in every list.
- Keep the template's tone and roughly its length. Plain British English, short sentences, no hype.
- Where the template has a [placeholder], replace it with the real fact ONLY if it is in the business details or products above; otherwise keep a clear [placeholder] for the owner to fill in.
- NEVER invent facts: no prices, numbers, years, names, awards, guarantees or results that are not above.
- A button's words should say what happens when it is pressed (e.g. "Book a table").
- Also write each page's seo title (max 60 characters) and description (max 155), and a one-sentence site description.
- Reply with JSON only: {"sections":{"<section id>":{ …the same keys as its words… }},"seo":{"<page id>":{"title":"","description":""}},"description":""}
</rules>`,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

/**
 * The reply, put into the site section by section through the gate. A section the reply leaves out
 * or gets wrong keeps its template words (and says so in the count), never breaks the site.
 */
export function siteFromFillReply(raw: unknown, current: SiteDefinition, maxPages: number): { definition: SiteDefinition; changed: number; skipped: number } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { sections?: Record<string, unknown>; seo?: Record<string, { title?: unknown; description?: unknown }>; description?: unknown };
    let def = current;
    let changed = 0;
    let skipped = 0;
    for (const pg of current.pages) {
        for (const s of pg.sections) {
            const props = propsFromWords(s, r.sections?.[s.id]);
            if (!props) { if (wordsOf(s)) skipped++; continue; }
            const res = applySiteOperation(def, { op: 'update_section', pageId: pg.id, sectionId: s.id, props }, { maxPages });
            if (res.ok) { def = res.definition; changed++; } else skipped++;
        }
        const seo = r.seo?.[pg.id];
        if (seo && (typeof seo.title === 'string' || typeof seo.description === 'string')) {
            const res = applySiteOperation(def, { op: 'update_page', pageId: pg.id, seo: { title: typeof seo.title === 'string' ? seo.title : null, description: typeof seo.description === 'string' ? seo.description : null } }, { maxPages });
            if (res.ok) def = res.definition;
        }
    }
    if (typeof r.description === 'string' && r.description.trim()) {
        const res = applySiteOperation(def, { op: 'set_settings', settings: { description: r.description } }, { maxPages });
        if (res.ok) def = res.definition;
    }
    return { definition: def, changed, skipped };
}
