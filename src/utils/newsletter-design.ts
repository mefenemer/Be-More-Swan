// src/utils/newsletter-design.ts
// The Newsletter Design Studio's data model, and the two renderers that turn it into an email.
//
// ── What a design is ────────────────────────────────────────────────────────────────────────────
// An ordered list of blocks plus a theme. `newsletter_issues.design` holds it; NULL means the issue
// is plain Markdown, which is what every issue was before this existed and what the assistant still
// writes by default. Nothing here is required to send an issue.
//
// ── The one rule that keeps this from becoming two sources of truth ─────────────────────────────
// ⚠️ WHEN A DESIGN EXISTS, THE DESIGN IS AUTHORITATIVE AND body_markdown IS DERIVED FROM IT
// (designToMarkdown, run on every save). The prose lives in the design's text blocks; the markdown
// column is a mirror kept for the four things that must keep working unchanged:
//   · the plain-text part of the email (a third of recipients read it, and every filter reads it)
//   · the word-count and structure findings (src/utils/deliverability.ts)
//   · the assistant, which drafts and rewrites PROSE and knows nothing about layout
//   · every existing query, export and hand-off that reads body_markdown
// The reverse direction — markdown back into a layout — is `applyProseToDesign`, and it is
// deliberately the only way copy re-enters a design, because it is the only place the "your
// pictures stay where they are" promise is implemented.
//
// ── Why tables and inline styles ────────────────────────────────────────────────────────────────
// Because it is 2026 and Outlook still renders with Word. Flexbox, grid, and <style> blocks are all
// either stripped or ignored somewhere that matters, and a layout that only holds together in
// Gmail's web client is a layout most business recipients never see. Every block below emits a
// table row with inline styles, and the two-column block collapses by using tables that stack.
//
// ── Why an image overlay is BAKED and never positioned in the markup ────────────────────────────
// Text over a picture is the one thing email cannot do. Absolute positioning is unsupported in
// Outlook, and the ~40% of recipients whose client blocks images by default would see the caption
// floating over grey nothing. So the editor flattens the text and stickers into the image itself
// (src/components/image-overlay-editor.js, canvas) and stores the result as a new asset; the block
// keeps `baseAssetId` so a second edit composites onto the clean original rather than onto a
// picture that already has words on it. The alt text carries the overlay wording for the people
// who never see the picture — that part is not optional.

import { escapeHtml } from './email-template';

export const DESIGN_VERSION = 1;

// Caps. Generous, but a design is user input that reaches a renderer and a mail server.
export const MAX_BLOCKS = 120;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_OVERLAYS = 12;

export type BlockAlign = 'left' | 'center' | 'right';

export interface OverlayData {
    id?: string;
    text: string;
    x: number;
    y: number;
    fontFamily?: string;
    fontSizePct?: number;
    color?: string;
    boxStroke?: string | null;
    boxFill?: string | null;
    boxOpacity?: number;
}

export interface HeadingBlock { id: string; type: 'heading'; text: string; level: 1 | 2 | 3; align: BlockAlign }
export interface TextBlock { id: string; type: 'text'; markdown: string; align: BlockAlign }
export interface ImageBlock {
    id: string;
    type: 'image';
    /** The asset actually shown — the baked one, once overlays exist. */
    assetId: number | null;
    /** ⚠️ The clean, pre-bake original. A re-edit composites onto THIS, never onto assetId. */
    baseAssetId: number | null;
    alt: string;
    /** Optional click-through. */
    href: string;
    align: BlockAlign;
    /** Percentage of the content column, 25–100. */
    width: number;
    caption: string;
    /** Kept so the editor can reopen with the user's text and stickers exactly where they left them. */
    overlays: OverlayData[];
}
export interface ButtonBlock {
    id: string; type: 'button'; label: string; href: string; align: BlockAlign;
    background: string; color: string;
}
export interface DividerBlock { id: string; type: 'divider' }
export interface SpacerBlock { id: string; type: 'spacer'; size: number }
export interface ColumnsBlock {
    id: string; type: 'columns';
    /** Exactly two, each a flat list — nesting columns inside columns is refused, not clamped. */
    columns: [SimpleBlock[], SimpleBlock[]];
}

export type SimpleBlock = HeadingBlock | TextBlock | ImageBlock | ButtonBlock | DividerBlock | SpacerBlock;
export type DesignBlock = SimpleBlock | ColumnsBlock;

export interface DesignTheme {
    /** Links, buttons and rules. */
    accent: string;
    /** Behind the card. */
    background: string;
    /** The card itself. */
    cardBackground: string;
    text: string;
    fontFamily: string;
    /** Rounded card, or square edges. */
    rounded: boolean;
}

export interface NewsletterDesign {
    version: number;
    /** Which template it started from. Informational — nothing branches on it after creation. */
    template: string;
    theme: DesignTheme;
    blocks: DesignBlock[];
}

export const DEFAULT_THEME: DesignTheme = {
    accent: '#059669',
    background: '#f6f7f9',
    cardBackground: '#ffffff',
    text: '#111827',
    fontFamily: `-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`,
    rounded: true,
};

// ── Normalisation ───────────────────────────────────────────────────────────
//
// ⚠️ Everything below runs on data that arrived from a browser. A design is stored as jsonb and
// rendered into an email — an unvalidated colour is a CSS injection into a mail client, and an
// unvalidated href is a phishing link somebody else's subscribers click.

const HEX = /^#[0-9a-fA-F]{6}$/;
const uid = () => `b_${Math.random().toString(36).slice(2, 10)}`;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v : '').slice(0, max);
const colour = (v: unknown, fallback: string) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback);
const align = (v: unknown): BlockAlign => (v === 'center' || v === 'right' ? v : 'left');
const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * http(s) or mailto only, and never javascript: or data:.
 *
 * ⚠️ Returns '' rather than throwing. A bad href on one button must not refuse to save an issue
 * somebody has spent twenty minutes on — it renders as plain text instead, which the author can see.
 */
export function safeHref(v: unknown): string {
    const s = str(v, 2048).trim();
    if (!s) return '';
    if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
    // A bare domain typed into the field is the overwhelmingly common case, and refusing it teaches
    // people to paste "http://" by hand rather than teaching them anything about safety.
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
    return '';
}

function normaliseOverlay(raw: unknown): OverlayData | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const text = str(o.text, 400);
    if (!text.trim()) return null;
    return {
        id: str(o.id, 40) || uid(),
        text,
        x: num(o.x, 0, 1, 0.5),
        y: num(o.y, 0, 1, 0.5),
        fontFamily: str(o.fontFamily, 60) || 'Arial',
        fontSizePct: num(o.fontSizePct, 0.01, 0.5, 0.07),
        color: colour(o.color, '#ffffff'),
        boxStroke: o.boxStroke == null ? null : colour(o.boxStroke, '#000000'),
        boxFill: o.boxFill == null ? null : colour(o.boxFill, '#000000'),
        boxOpacity: num(o.boxOpacity, 0, 1, 0.5),
    };
}

function normaliseSimple(raw: unknown): SimpleBlock | null {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as Record<string, unknown>;
    const id = str(b.id, 40) || uid();
    switch (b.type) {
        case 'heading': {
            const text = str(b.text, 300);
            if (!text.trim()) return null;
            return { id, type: 'heading', text, level: (num(b.level, 1, 3, 2) as 1 | 2 | 3), align: align(b.align) };
        }
        case 'text': {
            const markdown = str(b.markdown, MAX_TEXT_CHARS);
            // An empty paragraph is not content, and a design full of them is what you get from a
            // user pressing "add text" while thinking. Dropped rather than rendered as a gap.
            if (!markdown.trim()) return null;
            return { id, type: 'text', markdown, align: align(b.align) };
        }
        case 'image': {
            const assetId = Number(b.assetId);
            const baseAssetId = Number(b.baseAssetId);
            const overlays = Array.isArray(b.overlays)
                ? b.overlays.slice(0, MAX_OVERLAYS).map(normaliseOverlay).filter(Boolean) as OverlayData[]
                : [];
            return {
                id, type: 'image',
                assetId: Number.isFinite(assetId) && assetId > 0 ? assetId : null,
                baseAssetId: Number.isFinite(baseAssetId) && baseAssetId > 0 ? baseAssetId : null,
                alt: str(b.alt, 300),
                href: safeHref(b.href),
                align: align(b.align) === 'left' ? 'center' : align(b.align),
                width: num(b.width, 25, 100, 100),
                caption: str(b.caption, 300),
                overlays,
            };
        }
        case 'button': {
            const label = str(b.label, 80);
            if (!label.trim()) return null;
            return {
                id, type: 'button', label, href: safeHref(b.href), align: align(b.align) === 'left' ? 'center' : align(b.align),
                background: colour(b.background, DEFAULT_THEME.accent),
                color: colour(b.color, '#ffffff'),
            };
        }
        case 'divider':
            return { id, type: 'divider' };
        case 'spacer':
            return { id, type: 'spacer', size: num(b.size, 4, 96, 24) };
        default:
            return null;
    }
}

function normaliseBlock(raw: unknown): DesignBlock | null {
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'columns') {
        const b = raw as Record<string, unknown>;
        const cols = Array.isArray(b.columns) ? b.columns : [];
        // ⚠️ One level only. Columns inside columns produce a table nest that Outlook renders as a
        // single unreadable strip, and there is no legitimate email layout that needs it.
        const left = (Array.isArray(cols[0]) ? cols[0] : []).map(normaliseSimple).filter(Boolean) as SimpleBlock[];
        const right = (Array.isArray(cols[1]) ? cols[1] : []).map(normaliseSimple).filter(Boolean) as SimpleBlock[];
        if (!left.length && !right.length) return null;
        return { id: str(b.id, 40) || uid(), type: 'columns', columns: [left, right] };
    }
    return normaliseSimple(raw);
}

/**
 * Validate and clamp a design that arrived from a browser. Returns null for "no design", which is
 * a first-class state — an issue with no layout is a plain Markdown issue.
 */
export function normaliseDesign(raw: unknown): NewsletterDesign | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    const blocks = (Array.isArray(d.blocks) ? d.blocks : [])
        .slice(0, MAX_BLOCKS)
        .map(normaliseBlock)
        .filter(Boolean) as DesignBlock[];
    if (!blocks.length) return null;
    const t = (d.theme && typeof d.theme === 'object' ? d.theme : {}) as Record<string, unknown>;
    return {
        version: DESIGN_VERSION,
        template: str(d.template, 40) || 'custom',
        theme: {
            accent: colour(t.accent, DEFAULT_THEME.accent),
            background: colour(t.background, DEFAULT_THEME.background),
            cardBackground: colour(t.cardBackground, DEFAULT_THEME.cardBackground),
            text: colour(t.text, DEFAULT_THEME.text),
            // Not a colour: an allow-list, because this string lands inside a style attribute.
            fontFamily: FONT_STACKS.includes(str(t.fontFamily, 200)) ? str(t.fontFamily, 200) : DEFAULT_THEME.fontFamily,
            rounded: t.rounded !== false,
        },
        blocks,
    };
}

/** The font stacks the picker offers. ⚠️ An allow-list: this value is interpolated into `style=`. */
export const FONT_STACKS = [
    `-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`,
    `Georgia,'Times New Roman',serif`,
    `'Trebuchet MS',Verdana,sans-serif`,
    `'Courier New',Courier,monospace`,
];

export const FONT_LABELS: Record<string, string> = {
    [FONT_STACKS[0]]: 'System sans',
    [FONT_STACKS[1]]: 'Serif',
    [FONT_STACKS[2]]: 'Rounded sans',
    [FONT_STACKS[3]]: 'Typewriter',
};

export function isEmptyDesign(design: NewsletterDesign | null | undefined): boolean {
    return !design || !Array.isArray(design.blocks) || design.blocks.length === 0;
}

/** Every content asset a design references, deduped — for resolving URLs in one query. */
export function collectAssetIds(design: NewsletterDesign | null | undefined): number[] {
    const out = new Set<number>();
    const walk = (blocks: DesignBlock[]) => {
        for (const b of blocks) {
            if (b.type === 'columns') { walk(b.columns[0]); walk(b.columns[1]); continue; }
            if (b.type === 'image' && b.assetId) out.add(b.assetId);
        }
    };
    walk(design?.blocks || []);
    return [...out];
}

// ── design → markdown (the prose mirror) ────────────────────────────────────

function blockToMarkdown(b: DesignBlock): string {
    switch (b.type) {
        case 'heading':
            return `${'#'.repeat(b.level)} ${b.text}`;
        case 'text':
            return b.markdown.trim();
        case 'button':
            // A button IS a link, and the text part of the email has no buttons. Rendered as one so
            // a plain-text reader can still act on it — dropping it would delete the call to action
            // for everyone whose client shows text only.
            return b.href ? `[${b.label}](${b.href})` : b.label;
        case 'image':
            // ⚠️ The alt text, not a placeholder. It is the only thing a text reader gets, and the
            // word count is honest about it: a picture with no alt contributes nothing, which is
            // exactly what it contributes to the reader.
            return b.caption.trim() || b.alt.trim() || '';
        case 'divider':
            return '---';
        case 'spacer':
            return '';
        case 'columns':
            return [...b.columns[0], ...b.columns[1]].map(blockToMarkdown).filter(Boolean).join('\n\n');
        default:
            return '';
    }
}

/**
 * The prose mirror written back to body_markdown on every design save.
 *
 * ⚠️ This is what the deliverability findings count, what the text part is built from and what the
 * assistant is shown as "the current copy". If a block's words do not appear here, they do not
 * exist as far as the rest of the product is concerned.
 */
export function designToMarkdown(design: NewsletterDesign | null | undefined): string {
    if (isEmptyDesign(design)) return '';
    return (design as NewsletterDesign).blocks
        .map(blockToMarkdown)
        .filter((s) => s.trim())
        .join('\n\n')
        .trim();
}

// ── markdown → design (starting a layout, and re-flowing an assistant rewrite) ──────────────────

/** Blocks that carry words. The ones a rewrite replaces; everything else is layout and survives. */
const PROSE_TYPES = new Set(['heading', 'text']);

/**
 * Parse Markdown prose into heading and text blocks.
 *
 * Deliberately shallow: headings, horizontal rules and paragraph groups. It is not a Markdown
 * parser — the text blocks keep their Markdown and are rendered by the real one at send time, so
 * lists, bold, links and quotes all still work inside a block. What this splits on is what a person
 * would call "a section".
 */
export function blocksFromMarkdown(markdown: string): SimpleBlock[] {
    const src = String(markdown || '').replace(/\r\n/g, '\n');
    const out: SimpleBlock[] = [];
    let buffer: string[] = [];

    const flush = () => {
        const text = buffer.join('\n').trim();
        buffer = [];
        if (text) out.push({ id: uid(), type: 'text', markdown: text, align: 'left' });
    };

    for (const line of src.split('\n')) {
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
            flush();
            out.push({
                id: uid(), type: 'heading', text: heading[2].trim(),
                level: heading[1].length as 1 | 2 | 3, align: 'left',
            });
            continue;
        }
        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); out.push({ id: uid(), type: 'divider' }); continue; }
        // A blank line only ends a paragraph when we are not inside a fenced or indented block; the
        // simple rule below is right for the prose a newsletter actually contains.
        if (!line.trim() && buffer.length) { flush(); continue; }
        if (line.trim() || buffer.length) buffer.push(line);
    }
    flush();
    return out.slice(0, MAX_BLOCKS);
}

/**
 * Put newly-written copy into an existing layout, keeping the pictures and buttons where they are.
 *
 * ⚠️ THE PROMISE THIS IMPLEMENTS, and why it is not just "replace the blocks": someone who has
 * spent ten minutes placing three photographs and a button asks the assistant to make the copy
 * warmer. If that rewrite dropped their layout, they would never press the button a second time.
 *
 * The rule, in full, because it has to be explainable in one sentence in the UI: the nth paragraph
 * of new copy replaces the nth paragraph of old copy; anything that is not a paragraph — an image,
 * a button, a divider, a spacer, a column pair — stays exactly where it is; extra new paragraphs
 * are appended; old paragraphs with no replacement are removed.
 */
export function applyProseToDesign(design: NewsletterDesign, markdown: string): NewsletterDesign {
    const incoming = blocksFromMarkdown(markdown);
    const out: DesignBlock[] = [];
    let i = 0;

    for (const block of design.blocks) {
        if (!PROSE_TYPES.has(block.type)) { out.push(block); continue; }
        const next = incoming[i++];
        // Keep the OLD block's id: the editor's selection, and any pending scroll position, are
        // keyed on it, and a rewrite that silently reseats the cursor reads as a crash.
        if (next) out.push({ ...next, id: block.id });
    }
    for (; i < incoming.length; i++) out.push(incoming[i]);

    return { ...design, blocks: out.slice(0, MAX_BLOCKS) };
}

// ── design → email HTML ─────────────────────────────────────────────────────

export interface RenderDesignOptions {
    /** Markdown → sanitised HTML. Injected so this module never imports the ESM-only `marked`. */
    renderMarkdown: (md: string) => Promise<string>;
    /** assetId → an absolute, durable URL. Missing ids render as nothing, never as a broken box. */
    imageUrl: (assetId: number) => string | null;
}

const alignStyle = (a: BlockAlign) => `text-align:${a};`;

async function renderSimple(b: SimpleBlock, theme: DesignTheme, opts: RenderDesignOptions): Promise<string> {
    switch (b.type) {
        case 'heading': {
            const size = b.level === 1 ? 26 : b.level === 2 ? 21 : 17;
            return `<h${b.level} style="margin:0 0 12px;font-family:${theme.fontFamily};font-size:${size}px;line-height:1.3;font-weight:700;color:${theme.text};${alignStyle(b.align)}">${escapeHtml(b.text)}</h${b.level}>`;
        }
        case 'text': {
            const html = await opts.renderMarkdown(b.markdown);
            return `<div style="font-family:${theme.fontFamily};font-size:16px;line-height:1.6;color:${theme.text};${alignStyle(b.align)}">${html}</div>`;
        }
        case 'image': {
            const url = b.assetId ? opts.imageUrl(b.assetId) : null;
            // ⚠️ An asset the tenant deleted between designing and approving renders as NOTHING, not
            // as a broken image icon in fifteen hundred inboxes.
            if (!url) return '';
            const img = `<img src="${escapeHtml(url)}" alt="${escapeHtml(b.alt)}" width="${Math.round(6 * b.width)}" style="display:block;border:0;outline:none;text-decoration:none;width:${b.width}%;max-width:100%;height:auto;border-radius:${theme.rounded ? '8px' : '0'};margin:${b.align === 'center' ? '0 auto' : b.align === 'right' ? '0 0 0 auto' : '0'};">`;
            const linked = b.href ? `<a href="${escapeHtml(b.href)}" target="_blank" style="text-decoration:none;">${img}</a>` : img;
            const caption = b.caption.trim()
                ? `<div style="margin-top:6px;font-family:${theme.fontFamily};font-size:13px;line-height:1.5;color:#6b7280;${alignStyle(b.align)}">${escapeHtml(b.caption)}</div>`
                : '';
            return `<div style="${alignStyle(b.align)}">${linked}${caption}</div>`;
        }
        case 'button': {
            // A table, not a styled <a>: Outlook ignores padding on an inline element, which turns a
            // button into underlined blue text at exactly the moment it matters most.
            const inner = `<a href="${escapeHtml(b.href || '#')}" target="_blank" style="display:inline-block;padding:12px 26px;font-family:${theme.fontFamily};font-size:16px;font-weight:700;line-height:1;color:${b.color};text-decoration:none;border-radius:8px;background:${b.background};">${escapeHtml(b.label)}</a>`;
            return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:${b.align === 'center' ? '0 auto' : b.align === 'right' ? '0 0 0 auto' : '0'};"><tr><td style="${alignStyle(b.align)}">${inner}</td></tr></table>`;
        }
        case 'divider':
            return `<hr style="border:0;border-top:1px solid #e5e7eb;margin:0;">`;
        case 'spacer':
            // A cell with a height, not a margin: margins on empty divs collapse differently in
            // every client, and this is the one block whose entire job is to be a specific height.
            return `<div style="line-height:${b.size}px;height:${b.size}px;font-size:1px;">&nbsp;</div>`;
        default:
            return '';
    }
}

async function renderBlock(b: DesignBlock, theme: DesignTheme, opts: RenderDesignOptions): Promise<string> {
    if (b.type !== 'columns') return renderSimple(b, theme, opts);
    const [left, right] = await Promise.all([
        Promise.all(b.columns[0].map((c) => renderSimple(c, theme, opts))),
        Promise.all(b.columns[1].map((c) => renderSimple(c, theme, opts))),
    ]);
    const cell = (parts: string[]) =>
        `<td class="bms-col" width="50%" valign="top" style="width:50%;padding:0 8px;">${parts.filter(Boolean).join('<div style="height:12px;line-height:12px;font-size:1px;">&nbsp;</div>')}</td>`;
    // ⚠️ The stacking on narrow screens comes from the media query in the shell (renderIssueSnapshot),
    // which most mobile clients honour. Where it is ignored, two 50% cells still fit — a design that
    // is unreadable rather than merely cramped on a phone is not a trade worth making.
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr>${cell(left)}${cell(right)}</tr></table>`;
}

/**
 * The design as the body of an email. Returned WITHOUT the shell — renderIssueSnapshot wraps it,
 * so a designed issue and a Markdown one share one outer template, one preheader and one footer
 * cell.
 */
export async function designToHtml(
    design: NewsletterDesign,
    opts: RenderDesignOptions,
): Promise<string> {
    const rows = await Promise.all(design.blocks.map(async (b) => {
        const html = await renderBlock(b, design.theme, opts);
        if (!html) return '';
        // Vertical rhythm lives on the row, not on the block, so a block used inside a column does
        // not carry a margin that only makes sense at the top level.
        const gap = b.type === 'spacer' ? 0 : 16;
        return `<tr><td style="padding:0 0 ${gap}px;">${html}</td></tr>`;
    }));
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${rows.filter(Boolean).join('')}</table>`;
}

/**
 * A stand-in for the rendered HTML, good enough for the "before you send" findings.
 *
 * ⚠️ WHY NOT RENDER THE REAL THING. The findings run on every keystroke in the browser and on every
 * issue GET on the server; the real renderer is async, pulls in `marked`, and resolves image URLs.
 * The only two things contentFindings() reads out of the HTML are how many <img> and how many <a>
 * there are, so this produces exactly those and nothing else. The browser builds the same string
 * from the same blocks, which is why the panel does not change when you reload the page.
 */
export function findingsHtmlHint(design: NewsletterDesign | null | undefined): string {
    if (isEmptyDesign(design)) return '';
    let images = 0;
    let links = 0;
    const walk = (blocks: DesignBlock[]) => {
        for (const b of blocks) {
            if (b.type === 'columns') { walk(b.columns[0]); walk(b.columns[1]); continue; }
            if (b.type === 'image') { if (b.assetId) images++; if (b.href) links++; continue; }
            if (b.type === 'button') { if (b.href) links++; continue; }
            // Markdown links inside a text block count too — they are links in the sent email.
            if (b.type === 'text') links += (b.markdown.match(/\]\(\s*(https?:|mailto:)/gi) || []).length;
        }
    };
    walk((design as NewsletterDesign).blocks);
    return '<img>'.repeat(images) + '<a href="#"></a>'.repeat(links);
}

/**
 * The plain-text part of a designed email.
 *
 * ⚠️ NOT the prose mirror, and not htmlToPlainText either — both are wrong here for opposite
 * reasons. The mirror is Markdown, and "# Autumn hours" with a hash on the front is what a
 * text/plain reader would actually see. Stripping the HTML instead loses every <img>, and with it
 * the alt text, which is the only thing that picture was ever going to say to the ~40% whose client
 * blocks images. So: take the mirror (which keeps alt text) and flatten the few marks a newsletter
 * actually uses, matching what htmlToPlainText produces for an undesigned issue.
 */
export function designToPlainText(design: NewsletterDesign | null | undefined): string {
    return designToMarkdown(design)
        .replace(/^#{1,6}\s+/gm, '')                       // headings are just lines
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')  // links carry their URL, as email does
        .replace(/^\s*[-*]\s+/gm, '· ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
        .replace(/^>\s?/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
