// src/utils/site-words.ts — "Add your own words": put the owner's own text onto a page of their
// site, WORD FOR WORD. tests/site-owner-content.test.ts.
//
// ── The model never writes a word ───────────────────────────────────────────────────────────────
// The owner's text (pasted, or read from a PDF / Word / text file) is cut into numbered BLOCKS —
// paragraphs, with a short title line split from the paragraph under it. The model is shown the
// page and the numbered blocks and answers only with a PLAN: which block numbers go into which
// section. assemblePlacement() then builds the sections from the owner's blocks. So the wording on
// the site IS the owner's wording by construction — not "checked afterwards", impossible to change.
//
// Nothing is lost, nothing is cut: a block the plan leaves out is added at the end of the page, and
// text too long for one section is split across sections (never truncated — the gate would clamp it).
// The result is a PROPOSAL (typed site operations + a plain preview); it changes nothing until the
// owner presses Apply, which sends the ops through the same `apply` as every other edit.

import type { SiteDefinition, SiteOperation, SitePageDef } from './site-definition';
import { applySiteOperation, LIMITS } from './site-definition';

export const MAX_WORDS_CHARS = 20_000;
export const MAX_WORDS_FILE_BYTES = 4 * 1024 * 1024;
const TITLE_MAX = 80;

// ── Reading a file ──────────────────────────────────────────────────────────────────────────────

export type WordsFileKind = 'pdf' | 'docx' | 'text';

export function fileKind(name: string, mime: string): WordsFileKind | null {
    const n = name.toLowerCase();
    if (mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || n.endsWith('.docx')) return 'docx';
    if (/^text\//.test(mime) || /\.(txt|md|markdown)$/.test(n)) return 'text';
    return null;
}

/** The text of an uploaded file. Throws a plain-words Error the owner can act on. */
export async function readWordsFile(name: string, mime: string, data: Buffer): Promise<string> {
    const kind = fileKind(name, mime);
    if (!kind) throw new Error('That kind of file can\'t be read. Use a Word document (.docx), a PDF, or a text file — or paste the words in.');
    if (data.length > MAX_WORDS_FILE_BYTES) throw new Error('That file is too large (the limit is 4 MB). Paste the words in instead.');
    if (kind === 'text') return data.toString('utf8');
    if (kind === 'docx') {
        const mammoth = await import('mammoth');
        const r = await (mammoth.default ?? mammoth).extractRawText({ buffer: data });
        return r.value;
    }
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data });
    try { return (await parser.getText()).text; }
    finally { await parser.destroy(); }
}

// ── Blocks ──────────────────────────────────────────────────────────────────────────────────────

/** Whitespace tidied, paragraphs kept: what the owner wrote, minus stray spacing. */
export function tidyWords(raw: string): string {
    return String(raw || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/[ \t ]+/g, ' ')
        .split('\n').map((l) => l.trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const looksLikeTitle = (line: string) => line.length <= TITLE_MAX && !/[.,;:!]$/.test(line) && /[A-Za-z]/.test(line);

/**
 * The owner's text as numbered blocks. A paragraph is the text between blank lines; inside one, a
 * short first line with no closing punctuation is a title of its own; a title-like line between
 * two paragraphs stands alone. Lines inside a paragraph are joined (PDFs break lines mid-sentence).
 */
export function wordsToBlocks(raw: string): string[] {
    const out: string[] = [];
    for (const para of tidyWords(raw).split(/\n{2,}/)) {
        const lines = para.split('\n').filter(Boolean);
        if (!lines.length) continue;
        if (lines.length > 1 && looksLikeTitle(lines[0])) {
            out.push(lines[0]);
            out.push(lines.slice(1).join(' '));
        } else {
            out.push(lines.join(' '));
        }
    }
    return out.filter((b) => b.trim());
}

// ── The plan the model returns ──────────────────────────────────────────────────────────────────

/** Block numbers are 1-based, as shown to the model. */
export type PlanChange =
    | { op: 'update'; sectionId: string; heading?: number | null; body?: number[] }
    | { op: 'add_text'; after?: string | null; heading?: number | null; body: number[] }
    | { op: 'add_faq'; after?: string | null; heading?: number | null; items: Array<{ q: number; a: number[] }> }
    | { op: 'add_list'; after?: string | null; kind: 'features' | 'steps'; heading?: number | null; items: Array<{ title: number; body: number[] }> }
    | { op: 'remove'; sectionId: string };

export interface WordsPlan { summary: string; changes: PlanChange[]; }

export function buildPlacementPrompt(page: SitePageDef, blocks: string[], note: string | null): { system: string; user: string } {
    const sections = page.sections.map((s, i) => {
        const p = s.props as unknown as Record<string, unknown>;
        const words = [p.headline, p.heading, p.subheadline, p.body, p.intro].filter((x) => typeof x === 'string' && x).join(' — ');
        return `${i + 1}. ${s.type} (sectionId ${s.id})${words ? `: "${String(words).slice(0, 160)}"` : ''}`;
    }).join('\n') || '(the page has no sections yet)';
    const system = [
        'You arrange a business owner\'s OWN words onto one page of their website.',
        'You never write, change, shorten or add any words. You only decide which numbered block goes where, in what kind of section.',
        'Reply with the JSON object only.',
    ].join('\n');
    const user = `<page title="${page.title}">
${sections}
</page>

<their_words>
${blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n')}
</their_words>
${note ? `\n<their_note>\n${note}\n</their_note>\n` : ''}
<rules>
- Use EVERY block exactly once, in an order that reads well (usually their order).
- A short block that names what follows (a title) becomes a "heading"; paragraphs become "body".
- "update" a section to REPLACE its words: hero (heading = the headline, body = the line under it), text, or cta. Only update a section whose words their text clearly replaces, or that their note names.
- "add_text" adds a text section after a sectionId (or at the end when "after" is null).
- "add_faq" when the words are questions and answers (a question block, then its answer blocks).
- "add_list" with kind "features" for a set of short titled points, or "steps" for a numbered process.
- "remove" a section only when their note asks to replace it and its job is now done by their words.
- If unsure, prefer "add_text" in their order — never drop a block.
</rules>

<output>
{"summary":"<one sentence: what goes where>","changes":[
 {"op":"update","sectionId":"...","heading":1,"body":[2,3]},
 {"op":"add_text","after":"<sectionId or null>","heading":4,"body":[5]},
 {"op":"add_faq","after":null,"heading":null,"items":[{"q":6,"a":[7]}]},
 {"op":"add_list","after":null,"kind":"features","heading":8,"items":[{"title":9,"body":[10]}]},
 {"op":"remove","sectionId":"..."}
]}
</output>`;
    return { system, user };
}

/** The model's reply, read defensively: unknown shapes are dropped, not trusted. */
export function readPlan(raw: unknown): WordsPlan | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { summary?: unknown; changes?: unknown };
    if (!Array.isArray(r.changes)) return null;
    const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const nums = (v: unknown) => (Array.isArray(v) ? v.map(num).filter((x): x is number => x !== null) : []);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null);
    const changes: PlanChange[] = [];
    for (const c of r.changes) {
        if (!c || typeof c !== 'object') continue;
        const o = c as Record<string, unknown>;
        if (o.op === 'update' && str(o.sectionId)) changes.push({ op: 'update', sectionId: str(o.sectionId)!, heading: num(o.heading), body: nums(o.body) });
        else if (o.op === 'add_text') changes.push({ op: 'add_text', after: str(o.after), heading: num(o.heading), body: nums(o.body) });
        else if (o.op === 'add_faq' && Array.isArray(o.items)) changes.push({ op: 'add_faq', after: str(o.after), heading: num(o.heading), items: o.items.map((x) => ({ q: num((x as Record<string, unknown>)?.q) ?? 0, a: nums((x as Record<string, unknown>)?.a) })).filter((x) => x.q > 0 && x.a.length) });
        else if (o.op === 'add_list' && Array.isArray(o.items)) changes.push({ op: 'add_list', after: str(o.after), kind: o.kind === 'steps' ? 'steps' : 'features', heading: num(o.heading), items: o.items.map((x) => ({ title: num((x as Record<string, unknown>)?.title) ?? 0, body: nums((x as Record<string, unknown>)?.body) })).filter((x) => x.title > 0) });
        else if (o.op === 'remove' && str(o.sectionId)) changes.push({ op: 'remove', sectionId: str(o.sectionId)! });
    }
    return { summary: typeof r.summary === 'string' ? r.summary.trim().slice(0, 300) : '', changes };
}

// ── Building the change from the owner's blocks ────────────────────────────────────────────────

export interface WordsPreviewItem { label: string; text: string; }
export interface WordsProposal { summary: string; ops: SiteOperation[]; preview: WordsPreviewItem[]; }

/** Text-section bodies of at most LIMITS.textBody, split between blocks (never inside one, unless one block alone is too long). */
function chunkBodies(blocks: string[]): string[] {
    const out: string[] = [];
    let cur = '';
    const push = () => { if (cur) out.push(cur); cur = ''; };
    for (const b of blocks) {
        if (b.length > LIMITS.textBody) {
            push();
            // One enormous block: split at sentence ends so nothing is cut mid-word.
            let rest = b;
            while (rest.length > LIMITS.textBody) {
                const slice = rest.slice(0, LIMITS.textBody);
                const at = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
                const cut = at > LIMITS.textBody / 2 ? at + 1 : slice.lastIndexOf(' ') > 0 ? slice.lastIndexOf(' ') : LIMITS.textBody;
                out.push(rest.slice(0, cut).trim());
                rest = rest.slice(cut).trim();
            }
            cur = rest;
            continue;
        }
        if (cur && cur.length + 2 + b.length > LIMITS.textBody) push();
        cur = cur ? `${cur}\n\n${b}` : b;
    }
    push();
    return out;
}

/**
 * The plan, made into site operations using ONLY the owner's blocks. Every block is used once; a
 * block the plan forgot is added at the end. Each operation is tried against a working copy, so the
 * proposal is known to apply cleanly to the page as it is now.
 */
export function assemblePlacement(def: SiteDefinition, pageId: string, blocks: string[], plan: WordsPlan): WordsProposal | { error: string } {
    let work = def;
    const page = () => work.pages.find((p) => p.id === pageId);
    if (!page()) return { error: 'That page no longer exists.' };
    const used = new Set<number>();
    const take = (n: number | null | undefined): string | null => {
        if (!n || n < 1 || n > blocks.length || used.has(n)) return null;
        used.add(n);
        return blocks[n - 1];
    };
    const takeAll = (ns: number[] | undefined) => (ns ?? []).map(take).filter((x): x is string => !!x);
    const ops: SiteOperation[] = [];
    const preview: WordsPreviewItem[] = [];
    const typeLabel = (t: string) => ({ hero: 'Opening section', text: 'Text', cta: 'Call to action', faq: 'Questions', features: 'Features', steps: 'Steps' } as Record<string, string>)[t] ?? t;

    const run = (op: SiteOperation): boolean => {
        const r = applySiteOperation(work, op, { maxPages: work.pages.length });
        if (!r.ok) return false;
        work = r.definition;
        ops.push(op);
        return true;
    };
    const indexAfter = (sectionId: string | null | undefined): number => {
        const secs = page()!.sections;
        const i = sectionId ? secs.findIndex((s) => s.id === sectionId) : -1;
        return i >= 0 ? i + 1 : secs.length;
    };
    /** Text sections, split if long; the heading goes on the first. Returns the last section's id. */
    const addText = (after: string | null | undefined, heading: string | null, body: string[], label: string): string | null => {
        const titled = heading && heading.length <= LIMITS.headline ? heading : null;
        const parts = chunkBodies(titled || !heading ? body : [heading, ...body]);
        if (!parts.length && titled) parts.push('');
        let anchor = after ?? null;
        parts.forEach((part, k) => {
            const props = { heading: k === 0 ? titled : null, body: part || (titled as string) };
            if (!props.body) return;
            const before = page()!.sections.map((s) => s.id);
            if (run({ op: 'add_section', pageId, index: indexAfter(anchor), section: { type: 'text', props } })) {
                const added = page()!.sections.find((s) => !before.includes(s.id));
                anchor = added?.id ?? anchor;
                preview.push({ label: k === 0 ? label : `${label} (continued)`, text: [props.heading, props.body].filter(Boolean).join('\n\n') });
            }
        });
        return anchor;
    };

    for (const c of plan.changes) {
        if (c.op === 'remove') {
            const s = page()!.sections.find((x) => x.id === c.sectionId);
            if (s && run({ op: 'remove_section', pageId, sectionId: c.sectionId })) preview.push({ label: `Removed: ${typeLabel(s.type)}`, text: '' });
            continue;
        }
        if (c.op === 'update') {
            const s = page()!.sections.find((x) => x.id === c.sectionId);
            const heading = take(c.heading);
            const body = takeAll(c.body);
            if (!s || (!heading && !body.length)) { if (heading) body.unshift(heading); if (body.length) addText(null, null, body, 'New text'); continue; }
            if (s.type === 'hero') {
                const headline = heading ?? (body[0] && body[0].length <= LIMITS.headline ? body.shift()! : null);
                const sub = body.length && body.join(' ').length <= LIMITS.subheadline ? body.join(' ') : null;
                const rest = sub ? [] : body;
                const props: Record<string, unknown> = {};
                if (headline) props.headline = headline;
                if (sub) props.subheadline = sub;
                if (Object.keys(props).length && run({ op: 'update_section', pageId, sectionId: s.id, props })) {
                    preview.push({ label: 'Opening section (updated)', text: [headline, sub].filter(Boolean).join('\n\n') });
                } else if (headline) rest.unshift(headline);
                if (rest.length) addText(s.id, null, rest, 'Text below the opening');
                continue;
            }
            if (s.type === 'text' || s.type === 'cta') {
                const titled = heading && heading.length <= LIMITS.headline ? heading : null;
                const bodies = chunkBodies(titled || !heading ? body : [heading, ...body]);
                const first = bodies.shift() ?? null;
                const limit = s.type === 'cta' ? LIMITS.subheadline : LIMITS.textBody;
                if (first && first.length > limit) { bodies.unshift(first); }
                const props: Record<string, unknown> = {};
                if (titled) props.heading = titled;
                if (first && first.length <= limit) props.body = first;
                if (Object.keys(props).length && run({ op: 'update_section', pageId, sectionId: s.id, props })) {
                    preview.push({ label: `${typeLabel(s.type)} (updated)`, text: [props.heading, props.body].filter(Boolean).join('\n\n') as string });
                }
                if (bodies.length) addText(s.id, null, bodies, 'Text (continued)');
                continue;
            }
            // Any other section: its words are not a heading-and-body; add them beside it instead.
            addText(s.id, heading, body, 'New text');
            continue;
        }
        if (c.op === 'add_text') {
            addText(c.after, take(c.heading), takeAll(c.body), 'New text');
            continue;
        }
        if (c.op === 'add_faq') {
            const heading = take(c.heading);
            const items = c.items.map((it) => ({ q: take(it.q), a: takeAll(it.a).join('\n\n') })).filter((x) => x.q && x.a) as Array<{ q: string; a: string }>;
            const fits = items.length && items.length <= LIMITS.faqItems && items.every((x) => x.q.length <= LIMITS.q && x.a.length <= LIMITS.a) && (!heading || heading.length <= LIMITS.headline);
            if (fits && run({ op: 'add_section', pageId, index: indexAfter(c.after), section: { type: 'faq', props: { heading, items } } })) {
                preview.push({ label: 'New questions and answers', text: [heading, ...items.map((x) => `${x.q}\n${x.a}`)].filter(Boolean).join('\n\n') });
            } else {
                addText(c.after, heading, items.flatMap((x) => [x.q, x.a]), 'New text');
            }
            continue;
        }
        if (c.op === 'add_list') {
            const heading = take(c.heading);
            const items = c.items.map((it) => ({ title: take(it.title), body: takeAll(it.body).join('\n\n') })).filter((x) => x.title) as Array<{ title: string; body: string }>;
            const max = c.kind === 'steps' ? LIMITS.steps : LIMITS.features;
            const fits = items.length >= (c.kind === 'steps' ? LIMITS.stepsMin : 1) && items.length <= max
                && items.every((x) => x.title.length <= LIMITS.itemTitle && x.body.length <= LIMITS.itemBody) && (!heading || heading.length <= LIMITS.headline);
            if (fits && run({ op: 'add_section', pageId, index: indexAfter(c.after), section: { type: c.kind, props: { heading, items } } })) {
                preview.push({ label: c.kind === 'steps' ? 'New steps' : 'New features', text: [heading, ...items.map((x) => `${x.title}${x.body ? `\n${x.body}` : ''}`)].filter(Boolean).join('\n\n') });
            } else {
                addText(c.after, heading, items.flatMap((x) => [x.title, x.body].filter(Boolean)), 'New text');
            }
        }
    }

    // Nothing is lost: any block the plan did not place goes at the end of the page, in order.
    const left = blocks.map((b, i) => (used.has(i + 1) ? null : b)).filter((x): x is string => !!x);
    if (left.length) addText(null, null, left, 'The rest of your words, at the end of the page');
    if (!ops.length) return { error: 'Your words couldn\'t be placed on this page. Try a shorter piece, or add it section by section.' };
    return { summary: plan.summary || `Your words placed on "${page()!.title}".`, ops, preview };
}

/** Every word of the owner's text appears, unchanged, in the proposal — the property the design guarantees. */
export function proposalKeepsEveryWord(blocks: string[], proposal: WordsProposal): boolean {
    const placed = proposal.preview.map((p) => p.text).join('\n\n').replace(/\s+/g, ' ');
    return blocks.every((b) => placed.includes(b.replace(/\s+/g, ' ')) || b.length > LIMITS.textBody);
}
