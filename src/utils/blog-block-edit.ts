// src/utils/blog-block-edit.ts — the chat's blog_block_edit card: ONE block of an article (a paragraph,
// a heading, a list) replaced by the assistant's proposed version, never the rest. Used by
// netlify/functions/blog-block-edit.ts when the article isn't open in the Blog Studio; when it is,
// the studio's editor does the same through MarkdownEditor.replaceBlockText. tests/blog-block-edit.test.ts.

/** Whitespace-blind: the chat may quote the block back with different spacing or line breaks. */
const flat = (s: string) => String(s || '').replace(/\s+/g, ' ').trim();

/** Blocks are separated by blank lines — as the editor splits them (outside code fences). */
export function splitBlocks(md: string): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    let fence = false;
    for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        if (!fence && line.trim() === '') { if (cur.length) { out.push(cur.join('\n')); cur = []; } continue; }
        cur.push(line);
    }
    if (cur.length) out.push(cur.join('\n'));
    return out;
}

/**
 * The article with the block that IS `find` (or, failing that, the one block containing it) replaced.
 * null when `find` is not in exactly one block — nothing is changed rather than the wrong part.
 */
export function replaceBlock(md: string, find: string, replace: string): string | null {
    const needle = flat(find);
    const next = String(replace || '').trim();
    if (!needle || !next) return null;
    const blocks = splitBlocks(md);
    let idx = blocks.map((b, i) => (flat(b) === needle ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 1) {
        blocks[idx[0]] = next;
        return blocks.join('\n\n');
    }
    // Part of a block: matched whitespace-blind but replaced in place, so the rest of it keeps its own
    // line breaks (flattening the block would turn a list into one long line).
    const part = new RegExp(needle.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    idx = blocks.map((b, i) => (part.test(b) ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== 1) return null;
    blocks[idx[0]] = blocks[idx[0]].replace(part, () => next).trim();
    return blocks.join('\n\n');
}

export const BLOG_BLOCK_EDIT_TYPE = 'blog_block_edit';
const MAX_BLOCK_CHARS = 6000;   // the card shows at most this much (disruptive-ui-registry.js)

export interface BlogBlockEditCard { type: typeof BLOG_BLOCK_EDIT_TYPE; postId: number; find: string; replace: string; summary: string | null }

/** The model's blog_block_edit card, checked and rebuilt — the only fields that reach the transcript. */
export function blogBlockEditFromUiElement(uiElement: unknown): BlogBlockEditCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== BLOG_BLOCK_EDIT_TYPE) return null;
    const postId = Number(String(ui.postId ?? '').replace(/^#/, ''));
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const find = str(ui.find, MAX_BLOCK_CHARS);
    const replace = str(ui.replace, MAX_BLOCK_CHARS);
    if (!Number.isInteger(postId) || postId <= 0 || !find || !replace) return null;
    return { type: BLOG_BLOCK_EDIT_TYPE, postId, find, replace, summary: str(ui.summary, 300) || null };
}
