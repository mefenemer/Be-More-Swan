// src/utils/site-draft-media.ts — placeholder pictures and videos for the Website Assistant's first
// draft (owner, 2026-11-06): stock or AI-made, as they chose. PURE: no database, no network; the
// sourcing is site-draft-media-run.ts and the save is site-store.ts runSiteDraft.
//
// Rules:
//   · an imported site never comes through here (site-import-store.ts has its own worker);
//   · media reaches a site only as a library asset (content_assets), through update_section, so
//     verifySiteAssets and the gate see it like any picture the owner chose;
//   · the owner's own library pictures are never replaced;
//   · a template's layout stays: only its hotlinked sample pictures are swapped.

import { TASK_WEIGHTS } from '../config/task-weights';
import { applySiteOperation, type Section, type SiteDefinition } from './site-definition';

export const DRAFT_MEDIA_SOURCES = ['stock', 'ai', 'none'] as const;
export type DraftMediaSource = typeof DRAFT_MEDIA_SOURCES[number];
export interface DraftMediaChoice { images: DraftMediaSource; videos: DraftMediaSource }
export const NO_DRAFT_MEDIA: DraftMediaChoice = { images: 'none', videos: 'none' };

/** Most media one draft adds. AI is lower because it spends tasks; these make the stated cost a ceiling. */
export const DRAFT_MEDIA_CAPS = { stockImages: 8, aiImages: 4, stockVideos: 2, aiVideos: 1 } as const;

/** What the set-up questions, the Website tab and the chat card offer, and what the AI options cost. */
export interface DraftMediaOptions {
    images: { aiAllowed: boolean; aiWhyNot: string | null; aiTasksEach: number; aiMax: number; stockMax: number };
    videos: { aiAllowed: boolean; aiWhyNot: string | null; aiTasksEach: number; aiMax: number; stockMax: number };
    /** Their set-up answers, if any. */
    answers: { images: DraftMediaSource | null; videos: DraftMediaSource | null };
}

export function cleanDraftMediaSource(v: unknown): DraftMediaSource | null {
    return (DRAFT_MEDIA_SOURCES as readonly unknown[]).includes(v) ? v as DraftMediaSource : null;
}

export function wantsDraftMedia(c: DraftMediaChoice | null | undefined): boolean {
    return !!c && (c.images !== 'none' || c.videos !== 'none');
}

/**
 * What this draft will do: their choice on the button or card, else their set-up answer, else nothing.
 * Asking outright for AI the workspace can't have is refused (the buttons don't offer it); an old
 * set-up answer that no longer applies just falls back to no media.
 */
export function resolveDraftMedia(given: unknown, options: DraftMediaOptions): { choice: DraftMediaChoice } | { error: string } {
    const g = (given && typeof given === 'object' ? given : {}) as { images?: unknown; videos?: unknown };
    const images = cleanDraftMediaSource(g.images);
    const videos = cleanDraftMediaSource(g.videos);
    if (images === 'ai' && !options.images.aiAllowed) return { error: options.images.aiWhyNot || 'AI pictures aren\'t available on your workspace.' };
    if (videos === 'ai' && !options.videos.aiAllowed) return { error: options.videos.aiWhyNot || 'AI video isn\'t available on your workspace.' };
    const answer = (kind: 'images' | 'videos'): DraftMediaSource => {
        const a = options.answers[kind];
        return a === 'ai' && !options[kind].aiAllowed ? 'none' : a ?? 'none';
    };
    return { choice: { images: images ?? answer('images'), videos: videos ?? answer('videos') } };
}

/** The most this choice can cost in tasks on top of writing the draft. Stock is free. */
export function draftMediaMaxTasks(c: DraftMediaChoice, o: DraftMediaOptions): number {
    return (c.images === 'ai' ? o.images.aiTasksEach * o.images.aiMax : 0) + (c.videos === 'ai' ? o.videos.aiTasksEach * o.videos.aiMax : 0);
}

/** The costs in words, read by the model so it quotes the same numbers as the card. Built from the live weights. */
export function draftMediaPromptLine(o: DraftMediaOptions): string {
    const s = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
    return [
        `Placeholder pictures and videos for a whole-site draft: stock is free. AI pictures: ${o.images.aiAllowed ? `${s(o.images.aiTasksEach)} each, ${o.images.aiMax} at most` : `not available (${o.images.aiWhyNot})`}.`,
        `AI video: ${o.videos.aiAllowed ? `${s(o.videos.aiTasksEach)} for ${o.videos.aiMax === 1 ? 'one clip' : `each of ${o.videos.aiMax} clips`}` : `not available (${o.videos.aiWhyNot})`}.`,
        `Their set-up answers: pictures ${o.answers.images ?? 'not answered'}, videos ${o.answers.videos ?? 'not answered'}.`,
    ].join(' ');
}

export const AI_IMAGE_TASKS = TASK_WEIGHTS.ai_image;

// ── The notes the draft leaves on the site row ───────────────────────────────────────────────────
// sites.draft_note has always meant "the draft failed". These two don't, and every reader must ask
// draftNoteIsFailure rather than treat any note as a failure.
export const DRAFT_NOTE_READY = 'Your draft is ready.';
export const DRAFT_NOTE_ADDING_MEDIA = 'Your words are written. Adding your pictures and videos now.';
export const DRAFT_NOTE_MEDIA_STOPPED = `${DRAFT_NOTE_READY} Its pictures and videos didn't finish, so add your own with Choose picture, or try again.`;

export function draftNoteIsFailure(note: string | null | undefined): boolean {
    return !!note && note !== DRAFT_NOTE_ADDING_MEDIA && !note.startsWith(DRAFT_NOTE_READY);
}

// ── Where media can go ───────────────────────────────────────────────────────────────────────────
export interface MediaSlot { pageId: string; sectionId: string; type: 'hero' | 'text'; page: string; about: string }

const NO_MEDIA_PAGE = /(^|-)(privacy|terms|cookies?|legal|accessibility)(-|$)/;

function aboutSection(s: Section): string {
    const p = s.props as unknown as Record<string, unknown>;
    const bits = s.type === 'hero' ? [p.headline, p.subheadline] : [p.heading, p.body];
    return bits.filter((x) => typeof x === 'string' && x).join(' — ').replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * The hero and text sections that may take a picture, spread across the pages: each page's first,
 * then each page's second, and so on, with the home page first, so a capped run reaches every page.
 * `onlyReplace` (a template): only swaps a hotlinked sample, adding no picture its layout doesn't have.
 */
export function mediaSlots(def: SiteDefinition, opts: { onlyReplace?: boolean } = {}): MediaSlot[] {
    const perPage = def.pages.filter((pg) => !NO_MEDIA_PAGE.test(pg.slug)).map((pg) => pg.sections.flatMap((s): MediaSlot[] => {
        if (s.type !== 'hero' && s.type !== 'text') return [];
        const image = (s.props as { image?: { assetId?: number | null } | null }).image;
        if (image?.assetId) return [];   // the owner's own
        if (opts.onlyReplace && !image) return [];
        return [{ pageId: pg.id, sectionId: s.id, type: s.type, page: pg.title, about: aboutSection(s) }];
    }));
    const out: MediaSlot[] = [];
    for (let i = 0; perPage.some((l) => l[i]); i++) for (const l of perPage) if (l[i]) out.push(l[i]);
    return out;
}

// ── What goes in each place ──────────────────────────────────────────────────────────────────────
export interface MediaSpot { sectionId: string; query: string; scene: string; alt: string }

export interface MediaPlanBrief { name: string; industry: string | null; description: string | null; request: string | null }

export function buildMediaPlanPrompt(brief: MediaPlanBrief, slots: MediaSlot[]): { system: string; user: string } {
    const facts = [`Business: ${brief.name}`, brief.industry ? `Industry: ${brief.industry}` : '', brief.description ? `What they do: ${brief.description.slice(0, 500)}` : ''].filter(Boolean).join('\n');
    const list = slots.map((s) => ({ sectionId: s.sectionId, page: s.page, kind: s.type, says: s.about }));
    return {
        system: 'You choose placeholder pictures for a small business\'s website, which is already written. You never change its words. Reply with JSON only.',
        user: [
            `<business>\n${facts}\n</business>`,
            brief.request ? `<request>\n${brief.request.slice(0, 500)}\n</request>` : '',
            `<sections>\n${JSON.stringify(list)}\n</sections>`,
            `<rules>
- Give every section one picture that suits what it says and this kind of business. Make them differ from each other.
- "query": a 2 to 5 word stock photo search, about things a camera can see (e.g. "florist arranging wedding bouquet").
- "scene": one or two sentences describing a photograph to make: subject, setting, light. No words, signs, logos or real, named people.
- "alt": a short description of the picture for a screen reader, in plain British English. Say what it shows, and claim nothing about this business.
- Reply: {"media":[{"sectionId":"","query":"","scene":"","alt":""}]}
</rules>`,
        ].filter(Boolean).join('\n\n'),
    };
}

/** A plan that needs no model: used for any section the model's reply missed, or when it failed. */
export function fallbackSpot(slot: MediaSlot, brief: MediaPlanBrief): MediaSpot {
    const subject = (brief.industry || brief.description || brief.name || 'small business').replace(/\s+/g, ' ').trim().slice(0, 60);
    const heading = slot.about.split(' — ')[0].slice(0, 80);
    return {
        sectionId: slot.sectionId,
        query: subject,
        scene: `A natural, well-lit photograph for a website about ${subject}${slot.type === 'text' && heading ? `, suiting the heading "${heading}"` : ''}. No words, signs or logos.`,
        alt: `A picture to do with ${subject}`,
    };
}

/** One spot per section, in slot order: the model's where it gave a usable one, otherwise the fallback. */
export function cleanMediaPlan(raw: unknown, slots: MediaSlot[], brief: MediaPlanBrief): MediaSpot[] {
    const given = new Map<string, Record<string, unknown>>();
    const list = raw && typeof raw === 'object' ? (raw as { media?: unknown }).media : null;
    if (Array.isArray(list)) for (const m of list) if (m && typeof m === 'object') given.set(String((m as { sectionId?: unknown }).sectionId), m as Record<string, unknown>);
    const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    return slots.map((slot) => {
        const base = fallbackSpot(slot, brief);
        const g = given.get(slot.sectionId);
        if (!g) return base;
        return { sectionId: slot.sectionId, query: clip(g.query, 100) || base.query, scene: clip(g.scene, 600) || base.scene, alt: clip(g.alt, 140) || base.alt };
    });
}

// ── Putting it on the site ───────────────────────────────────────────────────────────────────────
export interface MediaPlacement { sectionId: string; assetId: number; alt: string }

/**
 * Put each asset in its section, through the one gate. A section since removed is skipped. A hero with
 * a picture on it uses the cover layout unless the writer chose side by side. Text sections alternate
 * sides. Whether an asset is drawn as a video is set from the asset itself on save (markVideos).
 */
export function placeMedia(def: SiteDefinition, placements: MediaPlacement[], maxPages?: number): SiteDefinition {
    let out = def;
    let side: 'left' | 'right' = 'right';
    for (const m of placements) {
        const page = out.pages.find((pg) => pg.sections.some((s) => s.id === m.sectionId));
        const section = page?.sections.find((s) => s.id === m.sectionId);
        if (!page || !section || (section.type !== 'hero' && section.type !== 'text')) continue;
        const image = { url: '', assetId: m.assetId, alt: m.alt };
        const props: Record<string, unknown> = { image };
        if (section.type === 'hero') { if (section.props.layout !== 'split') props.layout = 'cover'; }
        else { props.imageSide = side; side = side === 'right' ? 'left' : 'right'; }
        const r = applySiteOperation(out, { op: 'update_section', pageId: page.id, sectionId: section.id, props }, { maxPages });
        if (r.ok) out = r.definition;
    }
    return out;
}
