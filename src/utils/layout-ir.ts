// src/utils/layout-ir.ts — what the assistant returns when it designs, and the two things we
// compile that into.
//
// ── The problem this solves ─────────────────────────────────────────────────────────────────────
// The drafting model has only ever returned prose. Everything about how a draft LOOKS — where a
// picture goes, what is a pull quote, which sentence is the call to action, whether two things sit
// side by side — was thrown away at the model boundary and then asked of the author again, by hand,
// in whichever editor they happened to be in. So the assistant wrote and the human designed, in two
// separate passes, which is exactly the split the Studio exists to close.
//
// The IR is the missing half: an ordered list of INTENT nodes ("this is a heading", "a picture of a
// team stand-up belongs here", "this is the action I want them to take") that one validator hardens
// and two compilers turn into the two shapes the product already renders:
//
//     model → LayoutIr → irToDesignBlocks  → newsletter_issues.design  → table-based email HTML
//                      → irToBlogMarkdown  → blog_posts.body_markdown  → the sanitised snapshot
//
// ── ⚠️ THE MODEL EMITS INTENT, NEVER MARKUP ─────────────────────────────────────────────────────
// Not HTML, not inline styles, not colours, not widths. Three reasons, in order of how expensive
// they are to learn the hard way:
//   1. SECURITY. A published blog post renders on the CUSTOMER'S OWN DOMAIN, and the sanitiser
//      allowlist in markdown-render.ts is the control that makes that safe. Model-authored markup
//      would either be stripped (so the Studio preview lies about what publishes) or allowed
//      through (so an injected instruction in a knowledge-base document becomes script on somebody
//      else's site). Intent nodes cannot express either.
//   2. BRAND. Colour is not the model's decision — it is the organisation's, resolved from its
//      brand kit (src/utils/brand-theme.ts). A model that picks hex codes overrides the one thing
//      the customer actually configured.
//   3. EMAIL. What makes email HTML correct — nested tables, inline styles, Outlook conditionals —
//      is not something to have a language model reproduce from memory once per draft.
//
// ── ⚠️ THE IR IS A TRANSPORT, NOT A STORE ───────────────────────────────────────────────────────
// Nothing persists a LayoutIr. It exists between the model reply and the compiler, and then it is
// gone. A newsletter's truth stays `design` (with body_markdown derived from it — see
// newsletter-design.ts), a blog post's truth stays body_markdown. Storing the IR as well would make
// a third source of truth for the same words, and the first thing that happens to a third source of
// truth is that it disagrees with the other two.
//
// ── Why the vocabulary is this small ────────────────────────────────────────────────────────────
// Seven node kinds, and every one of them compiles HONESTLY to BOTH surfaces. A node that only
// works in email (a spacer) teaches the model to produce layouts the blog silently drops; a node
// that only works on the blog (a code fence) does the same in reverse. Anything either surface
// cannot express is not in the language.

import { safeHref, MAX_BLOCKS, MAX_TEXT_CHARS, type DesignBlock, type DesignTheme, type SimpleBlock } from './newsletter-design';
import { themedButtonColours } from './brand-theme';

export const LAYOUT_IR_VERSION = 1;

/**
 * How many nodes a draft may contain.
 *
 * Well below MAX_BLOCKS (120) on purpose: this is a bound on what a MODEL produces in one reply,
 * and an email with sixty sections is not a layout, it is a runaway generation.
 */
export const MAX_NODES = 60;

export const MAX_PROSE_CHARS = 6_000;
export const MAX_HEADING_CHARS = 200;
export const MAX_QUOTE_CHARS = 1_000;
export const MAX_ATTRIBUTION_CHARS = 120;
export const MAX_LABEL_CHARS = 60;
export const MAX_ALT_CHARS = 300;
export const MAX_CAPTION_CHARS = 300;
/** The picture search the author (or a later resolver) runs. Not a prompt, a query. */
export const MAX_QUERY_CHARS = 120;

export type IrLevel = 1 | 2 | 3;

export interface IrHeading { kind: 'heading'; text: string; level: IrLevel }
/** Ordinary Markdown: paragraphs, lists, emphasis, links. NOT HTML — see the header. */
export interface IrProse { kind: 'prose'; markdown: string }
export interface IrQuote { kind: 'quote'; text: string; attribution: string }
/**
 * A picture the draft WANTS, described rather than chosen.
 *
 * ⚠️ There is no assetId here and there must not be: the model cannot see the media library, and a
 * model-invented id would point at another organisation's picture. `query` is what to search for;
 * `alt` is what the picture is of, and is the only thing a subscriber whose client blocks images
 * ever gets, so it is required rather than decorative.
 */
export interface IrImage { kind: 'image'; alt: string; caption: string; query: string }
export interface IrButton { kind: 'button'; label: string; href: string }
export interface IrDivider { kind: 'divider' }
/** Exactly two columns of flat nodes. Nesting is refused, not flattened — see normalise. */
export interface IrColumns { kind: 'columns'; columns: [IrSimpleNode[], IrSimpleNode[]] }

export type IrSimpleNode = IrHeading | IrProse | IrQuote | IrImage | IrButton | IrDivider;
export type IrNode = IrSimpleNode | IrColumns;

export interface LayoutIr {
    version: number;
    nodes: IrNode[];
}

// ── Normalisation ───────────────────────────────────────────────────────────────────────────────
//
// ⚠️ Everything below runs on a language model's output, which is untrusted input in the ordinary
// sense AND may be steering from a document somebody uploaded. Nothing is trusted, nothing throws,
// and anything unrecognised is DROPPED rather than coerced: a node we do not understand is a node
// we cannot render honestly, and a half-understood layout is worse than one section fewer.

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').slice(0, max).trim();

const level = (v: unknown): IrLevel => {
    const n = Number(v);
    return n === 1 || n === 3 ? n : 2;
};

function normaliseSimpleNode(raw: unknown): IrSimpleNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const n = raw as Record<string, unknown>;
    switch (n.kind) {
        case 'heading': {
            const text = str(n.text, MAX_HEADING_CHARS);
            return text ? { kind: 'heading', text, level: level(n.level) } : null;
        }
        case 'prose': {
            const markdown = str(n.markdown, MAX_PROSE_CHARS);
            return markdown ? { kind: 'prose', markdown } : null;
        }
        case 'quote': {
            const text = str(n.text, MAX_QUOTE_CHARS);
            return text ? { kind: 'quote', text, attribution: str(n.attribution, MAX_ATTRIBUTION_CHARS) } : null;
        }
        case 'image': {
            // ⚠️ No alt, no picture. A slot with no alt text is one the author has to describe later
            // anyway, and an image block that reaches an inbox with an empty alt is invisible to the
            // people who most need it.
            const alt = str(n.alt, MAX_ALT_CHARS);
            return alt
                ? { kind: 'image', alt, caption: str(n.caption, MAX_CAPTION_CHARS), query: str(n.query, MAX_QUERY_CHARS) }
                : null;
        }
        case 'button': {
            const label = str(n.label, MAX_LABEL_CHARS);
            // safeHref is the same gate a hand-typed button goes through: http(s)/mailto only, a
            // bare domain gets https://, and anything else becomes ''. A model that invents a URL
            // is common; a model that invents a javascript: one must not be a live link.
            return label ? { kind: 'button', label, href: safeHref(n.href) } : null;
        }
        case 'divider':
            return { kind: 'divider' };
        default:
            return null;
    }
}

function normaliseNode(raw: unknown): IrNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const n = raw as Record<string, unknown>;
    if (n.kind !== 'columns') return normaliseSimpleNode(raw);

    // ⚠️ Columns hold FLAT lists. A nested columns node is dropped rather than unwrapped: both
    // renderers assume two levels (the email's stacking rule, and the blog editor's flat-block
    // assumption that the AI-rewrite toolbar depends on), and silently promoting a nested layout
    // produces something the author never asked for and cannot drag apart.
    const cols = Array.isArray(n.columns) ? n.columns : [];
    const left = (Array.isArray(cols[0]) ? cols[0] : []).map(normaliseSimpleNode).filter(Boolean) as IrSimpleNode[];
    const right = (Array.isArray(cols[1]) ? cols[1] : []).map(normaliseSimpleNode).filter(Boolean) as IrSimpleNode[];
    // One empty side is not a two-column layout; it is a column, and a column is just the page.
    if (!left.length || !right.length) return null;
    return { kind: 'columns', columns: [left, right] };
}

/**
 * A model reply, hardened into a layout — or null when there is nothing usable in it.
 *
 * ⚠️ Null is a real answer and every caller must handle it by falling back to the prose path.
 * A drafting run that produced words but no valid layout has still produced words, and refusing
 * the whole draft over its structure would turn a cosmetic failure into a lost generation the
 * customer pays for twice.
 */
export function normaliseLayoutIr(raw: unknown): LayoutIr | null {
    const list = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).nodes))
            ? (raw as { nodes: unknown[] }).nodes
            : null;
    if (!list) return null;

    const nodes = list.slice(0, MAX_NODES).map(normaliseNode).filter(Boolean) as IrNode[];
    if (!nodes.length) return null;

    // A layout that is one paragraph is not a layout — it is the prose path with extra steps, and
    // letting it through means a designed issue whose design does nothing but lose the author the
    // plain Markdown box they were used to.
    const meaningful = nodes.length > 1 || nodes[0].kind === 'columns';
    return meaningful ? { version: LAYOUT_IR_VERSION, nodes } : null;
}

// ── Turning a described picture into a real one ─────────────────────────────────────────────────

/**
 * How a compiler learns which asset a described picture became.
 *
 * ⚠️ THE MODEL STILL NEVER SUPPLIES AN ID. The IR carries a description; the CALLER resolves it
 * against the media library or a stock search and hands the answer back through here. Keeping the
 * two apart is what stops an invented id — and it keeps this module free of any database.
 *
 * `assetFor` is called once per image node, in document order, and may return null: an unresolved
 * picture is normal (nothing was found, the search is off, the org has no stock provider) and each
 * compiler has its own honest way of saying so.
 */
export interface CompileOptions {
    assetFor?: (image: IrImage, index: number) => number | null | undefined;
}

/** Walks image nodes in document order so both compilers number them identically. */
function assetResolver(opts?: CompileOptions) {
    let index = 0;
    return (image: IrImage): number | null => {
        const id = opts?.assetFor?.(image, index);
        index += 1;
        return typeof id === 'number' && Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
    };
}

// ── Compiler 1: the newsletter ──────────────────────────────────────────────────────────────────

let seq = 0;
const uid = () => `ir_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** A quote, as Markdown. Both compilers use this, so the two surfaces quote identically. */
function quoteMarkdown(node: IrQuote): string {
    const body = node.text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    return node.attribution ? `${body}\n>\n> — ${node.attribution}` : body;
}

function simpleToDesignBlock(node: IrSimpleNode, theme: DesignTheme, assetId: number | null): SimpleBlock | null {
    switch (node.kind) {
        case 'heading':
            return { id: uid(), type: 'heading', text: node.text, level: node.level, align: 'left' };
        case 'prose':
            return { id: uid(), type: 'text', markdown: node.markdown.slice(0, MAX_TEXT_CHARS), align: 'left' };
        case 'quote':
            // The email has no quote block, and inventing one would mean a new block type in stored
            // designs. A blockquote in a text block renders as a blockquote — markdown-render and
            // the canvas both already draw one.
            return { id: uid(), type: 'text', markdown: quoteMarkdown(node), align: 'left' };
        case 'image':
            // ⚠️ An UNRESOLVED picture stays an empty slot — the alt text and caption are already
            // written and the author fills it from the media picker. That is not a broken block:
            // an image block with no asset is skipped by the email renderer, so an unfilled slot
            // cannot ship a broken picture to a subscriber.
            return {
                id: uid(), type: 'image', assetId, baseAssetId: null,
                alt: node.alt, href: '', align: 'center', width: 100, caption: node.caption, overlays: [],
            };
        case 'button':
            return {
                id: uid(), type: 'button', label: node.label, href: node.href, align: 'center',
                ...themedButtonColours(theme.accent),
            };
        case 'divider':
            return { id: uid(), type: 'divider' };
        default:
            return null;
    }
}

/**
 * A layout, as newsletter design blocks in the organisation's own theme.
 *
 * ⚠️ The result still has to go through `normaliseDesign` before it is stored — that is the gate
 * every design passes, whoever authored it, and this compiler is not exempt from it just because
 * the input was already normalised once.
 */
export function irToDesignBlocks(ir: LayoutIr, theme: DesignTheme, opts?: CompileOptions): DesignBlock[] {
    const resolve = assetResolver(opts);
    const one = (n: IrSimpleNode) => simpleToDesignBlock(n, theme, n.kind === 'image' ? resolve(n) : null);
    const blocks: DesignBlock[] = [];
    for (const node of ir.nodes) {
        if (blocks.length >= MAX_BLOCKS) break;
        if (node.kind === 'columns') {
            const left = node.columns[0].map(one).filter(Boolean) as SimpleBlock[];
            const right = node.columns[1].map(one).filter(Boolean) as SimpleBlock[];
            if (left.length && right.length) blocks.push({ id: uid(), type: 'columns', columns: [left, right] });
            continue;
        }
        const block = one(node);
        if (block) blocks.push(block);
    }
    return blocks;
}

// ── Compiler 2: the blog ────────────────────────────────────────────────────────────────────────

/** A directive attribute value. The parser reads `key="a b"`, so a quote inside would end it. */
const attrValue = (v: string) => v.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();

function simpleToMarkdown(node: IrSimpleNode, assetId: number | null): string {
    switch (node.kind) {
        case 'heading':
            return `${'#'.repeat(node.level)} ${node.text}`;
        case 'prose':
            return node.markdown;
        case 'quote':
            return quoteMarkdown(node);
        case 'image': {
            // ⚠️ An UNRESOLVED picture is DROPPED, and that asymmetry with the newsletter is
            // deliberate. The blog's picture syntax names a real row in blog_post_assets; there is
            // no placeholder form, and inventing one would mean a directive the sanitiser allowlist
            // has to accept and the published snapshot could leak as literal text on a customer's
            // domain. The intent is not lost — `mediaIntents()` hands it back for the media picker.
            if (!assetId) return '';
            const attrs = [`asset=${assetId}`, 'type=image'];
            if (node.alt) attrs.push(`alt="${attrValue(node.alt)}"`);
            if (node.caption) attrs.push(`caption="${attrValue(node.caption)}"`);
            return `:::media{${attrs.join(' ')}}`;
        }
        case 'button':
            // A call to action with nowhere to go is not a call to action. With a link it is an
            // ordinary Markdown link on its own line, which is what a blog CTA is.
            return node.href ? `[${node.label}](${node.href})` : '';
        case 'divider':
            return '---';
        default:
            return '';
    }
}

/**
 * A layout, as blog Markdown — using the `::::columns` directives from
 * src/public/marked-bms-directives.js for side-by-side sections.
 *
 * ⚠️ The directive parser is ONE artifact run twice (browser and server). Emitting a directive
 * shape it does not tokenise gives an author literal `::::columns{cols=2}` text in their post, so
 * the fences here must stay exactly four colons for the container and three for each column.
 */
export function irToBlogMarkdown(ir: LayoutIr, opts?: CompileOptions): string {
    const resolve = assetResolver(opts);
    const one = (n: IrSimpleNode) => simpleToMarkdown(n, n.kind === 'image' ? resolve(n) : null);
    const parts: string[] = [];
    for (const node of ir.nodes) {
        if (node.kind === 'columns') {
            const side = (list: IrSimpleNode[]) => list.map(one).filter(Boolean).join('\n\n');
            const left = side(node.columns[0]);
            const right = side(node.columns[1]);
            // Both sides can empty out here even though the IR refused an empty one — a column of
            // nothing but pictures compiles to nothing. Falling back to the surviving side keeps
            // the author's words rather than dropping a whole section to preserve a shape.
            if (left && right) parts.push(`::::columns{cols=2}\n:::column\n${left}\n:::\n:::column\n${right}\n:::\n::::`);
            else if (left || right) parts.push(left || right);
            continue;
        }
        const md = one(node);
        if (md) parts.push(md);
    }
    return parts.join('\n\n').trim();
}

/**
 * Neutralise every link destination in a piece of Markdown that the brief never supplied.
 *
 * ⚠️ WHY THIS IS NOT JUST `[text](url)`. What reaches a published page as a live link was measured
 * against the real renderer (marked + GFM + sanitize-html), not assumed — and GFM autolinks far more
 * than markup:
 *
 *     [text](url)          → anchor          ✗ must be grounded
 *     ![alt](url)          → img             ✗ must be grounded (hotlinks somebody else's server)
 *     <https://…>          → anchor          ✗
 *     bare https://…       → anchor          ✗  ← GFM autolinks it with no markup at all
 *     bare www.…           → anchor          ✗  ← and this
 *     [text][ref]          → anchor          ✗  (the definition carries the URL)
 *     [text](mailto:…)     → anchor          ✗  (an invented address is still a wrong link)
 *     bare example.com/x   → plain text      ✓ safe, left alone
 *     `code span`          → plain text      ✓ safe, and MUST be left alone
 *     ```fenced```         → plain text      ✓ safe, and MUST be left alone
 *
 * The last two are why this cannot be a naive regex over the whole string: a URL in a code sample is
 * documentation, not a link, and rewriting it corrupts the example the author is trying to show.
 *
 * Grounded links are untouched. Ungrounded ones lose the LINK and keep the WORDS — "see the pricing
 * page" survives as a sentence, it just stops pointing somewhere that does not exist. An image is
 * removed outright, because there is no text under it to keep.
 */
export function groundMarkdownLinks(markdown: string, suppliedText: string): { markdown: string; removed: number } {
    const source = String(markdown ?? '');
    if (!source) return { markdown: '', removed: 0 };
    const supplied = String(suppliedText ?? '');
    let removed = 0;

    const ok = (url: string) => {
        const u = url.trim().replace(/[.,;:!?)\]]+$/, '');
        return !u || supplied.includes(u);
    };

    // ── Pass 1: reference definitions, over the whole document ──────────────────────────────────
    // `[g]: https://…` on its own line. Collected first because the usages that point at them are
    // scattered, and a definition left behind is a live link with no visible markup.
    const deadRefs = new Set<string>();
    let body = source.replace(/^[ ]{0,3}\[([^\]\n]+)\]:[ \t]*(\S+)([ \t]+["'(][^\n]*)?[ \t]*$/gm, (whole, label, url) => {
        if (ok(url)) return whole;
        deadRefs.add(String(label).toLowerCase());
        removed += 1;
        return '\u0000DEADREF\u0000';   // marked for removal once the line joins are settled
    });

    // ── Pass 2: everything else, but ONLY outside code ──────────────────────────────────────────
    // Fenced blocks first, then inline spans inside what is left. Both are returned verbatim.
    const FENCE = /(^|\n)([ ]{0,3})(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*|$)/g;
    const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`)*\1/g;

    const clean = (text: string): string => text
        // Images: no text to keep, so the whole construct goes, with one leading space if present.
        .replace(/ ?!\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+["'(][^)]*)?\)/g, (whole, _alt, url) => {
            if (ok(url)) return whole;
            removed += 1;
            return '';
        })
        // Inline links: keep the words, drop the destination.
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:[ \t]+["'(][^)]*)?\)/g, (whole, text, url) => {
            if (ok(url)) return whole;
            removed += 1;
            return String(text);
        })
        // Reference usages whose definition just died: `[text][g]`, `[g][]`, and the shortcut `[g]`.
        .replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (whole, text, label) => {
            const ref = String(label || text).toLowerCase();
            return deadRefs.has(ref) ? String(text) : whole;
        })
        .replace(/\[([^\]]+)\](?!\(|\[|:)/g, (whole, text) => (deadRefs.has(String(text).toLowerCase()) ? String(text) : whole))
        // Autolinks and bare URLs — GFM turns both into anchors with no markup at all. Nothing to
        // keep, so they go along with one leading space; trailing punctuation is left to the sentence.
        .replace(/ ?<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/g, (whole, url) => {
            if (ok(url)) return whole;
            removed += 1;
            return '';
        })
        .replace(/ ?\b(?:https?:\/\/|www\.)[^\s<>()\[\]]+/g, (whole) => {
            if (ok(whole)) return whole;
            removed += 1;
            return '';
        });

    // Walk the document, handing only the non-code stretches to `clean`.
    const outside = (text: string, re: RegExp, fn: (t: string) => string): string => {
        let out = '';
        let last = 0;
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
            out += fn(text.slice(last, m.index)) + m[0];
            last = m.index + m[0].length;
        }
        return out + fn(text.slice(last));
    };

    body = outside(body, FENCE, (chunk) => outside(chunk, INLINE_CODE, clean));

    // Drop the marked-out definition lines, and the blank line each one leaves behind.
    body = body.replace(/\n?\u0000DEADREF\u0000/g, '').replace(/\n{3,}/g, '\n\n');

    return { markdown: body, removed };
}

/**
 * Strip button links the brief never supplied.
 *
 * ⚠️ MODELS INVENT URLS, and this one does: asked to draft a newsletter about a physio clinic's new
 * running session, Haiku returned a button pointing at
 * `https://willowbrookphysio.com/running-clinic` — a plausible, well-formed, entirely fictional
 * page. safeHref cannot help here; the URL is perfectly safe, it just does not exist. Sent to a
 * list, it is a dead call to action in every inbox, and the customer finds out from a subscriber.
 *
 * The rule is the one the drafting prompt already applies to statistics and prices: if the brief
 * did not supply it, do not write it. The exact URL must appear in the text the human gave us.
 * Matching on the HOST instead would accept an invented path on a real domain, which is precisely
 * the failure above.
 *
 * ⚠️ The button SURVIVES, with an empty href. The assistant proposing the call to action and the
 * human supplying its destination is the right division of labour — and an empty href renders in
 * the Studio as a button with an empty URL field, which is visibly unfinished, whereas dropping
 * the block leaves the author with no idea it was ever suggested. `stripped` names them so the
 * caller can say so in the draft warnings.
 */
export function groundLinks(
    ir: LayoutIr,
    suppliedText: string,
): { ir: LayoutIr; stripped: string[]; unlinked: number } {
    const supplied = String(suppliedText ?? '');
    const stripped: string[] = [];
    let unlinked = 0;

    const prose = (md: string): string => {
        const out = groundMarkdownLinks(md, supplied);
        unlinked += out.removed;
        return out.markdown;
    };

    const ground = (n: IrSimpleNode): IrSimpleNode => {
        switch (n.kind) {
            case 'button':
                if (!n.href || supplied.includes(n.href)) return n;
                stripped.push(n.label);
                return { ...n, href: '' };
            // ⚠️ The prose carries links too, and they are the DANGEROUS half: a button with a dead
            // href is visibly unfinished in the Studio, whereas an invented link inside a paragraph
            // publishes silently — on a blog, onto the customer's own domain.
            case 'prose':
                return { ...n, markdown: prose(n.markdown) };
            // A quote is plain text that becomes Markdown on compile, so GFM autolinks a bare URL in
            // it exactly as it would in a paragraph.
            case 'quote':
                return { ...n, text: prose(n.text) };
            default:
                return n;
        }
    };
    const node = (n: IrNode): IrNode => (n.kind === 'columns'
        ? { ...n, columns: [n.columns[0].map(ground), n.columns[1].map(ground)] as typeof n.columns }
        : ground(n));
    return { ir: { ...ir, nodes: ir.nodes.map(node) }, stripped, unlinked };
}

/**
 * Every picture the layout asked for, in order.
 *
 * The blog compiler cannot place these (see simpleToMarkdown), and the newsletter compiler turns
 * them into empty slots. Either way the description the model wrote is worth keeping: it is the
 * search query for the media picker and the alt text once something is chosen.
 */
export function mediaIntents(ir: LayoutIr): IrImage[] {
    const out: IrImage[] = [];
    const visit = (nodes: IrNode[]) => {
        for (const n of nodes) {
            if (n.kind === 'columns') { visit(n.columns[0]); visit(n.columns[1]); }
            else if (n.kind === 'image') out.push(n);
        }
    };
    visit(ir.nodes);
    return out;
}

// ── The prompt ──────────────────────────────────────────────────────────────────────────────────

/**
 * How much a surface wants pictures. The two want opposite things, and one shared line cannot serve
 * both — measured live: with the sparing wording a 600-word blog post asked for NO pictures at all,
 * which makes the whole sourcing path dead code on the surface that most needs it.
 *
 * · `sparing` — EMAIL. Around 40% of business recipients have images blocked by default, every
 *   picture is weight in an inbox, and an image-heavy email is a deliverability finding of its own.
 * · `encouraged` — BLOG. A long-form post on a customer's own domain with no pictures at all reads
 *   as unfinished, and here a picture can actually be sourced and placed (blog-media-source.ts).
 */
export type ImagePolicy = 'sparing' | 'encouraged';

const IMAGE_RULES: Record<ImagePolicy, string> = {
    sparing: '- Ask for a picture only where one genuinely adds something, and never more than two.',
    encouraged: [
        '- A long piece earns pictures: ask for one near the top and one or two more where a',
        '  picture would SHOW something the words are describing. Two or three in total, no more.',
        '- Each picture\'s "query" is what gets typed into a stock-photo search, so make it two',
        "  to four concrete visual words ('physiotherapist with patient', not 'the cost of admin').",
    ].join('\n'),
};

/**
 * The schema, as the model is told it.
 *
 * ⚠️ Kept in the SAME file as the validator on purpose. The pair that always drifts is "what we
 * asked for" and "what we accept"; when they part company the symptom is a model doing as it was
 * told and a validator dropping the result, which looks exactly like the model ignoring us.
 * tests/layout-ir.test.ts asserts every kind named here is a kind the validator keeps.
 */
export function layoutIrPromptBlock(opts: { images?: ImagePolicy } = {}): string {
    return [
        'LAYOUT',
        'As well as the copy, return a "layout" array describing how the draft should be SET OUT.',
        'Each item is one of:',
        '  {"kind":"heading","text":"…","level":1|2|3}',
        '  {"kind":"prose","markdown":"…"}            — paragraphs, lists, links, bold/italic',
        '  {"kind":"quote","text":"…","attribution":"…"}',
        '  {"kind":"image","alt":"what the picture shows","caption":"","query":"two or three words to search stock photos for"}',
        '  {"kind":"button","label":"…","href":"https://…"}',
        '  {"kind":"divider"}',
        '  {"kind":"columns","columns":[[…],[…]]}     — two side-by-side lists of the items above',
        'Rules:',
        '- Describe intent only. No HTML, no CSS, no colours, no fonts, no widths — the layout is',
        '  rendered in the organisation\'s own brand colours and anything you specify is discarded.',
        '- Never invent an image id or an image URL. Describe the picture; somebody chooses it.',
        '- Only use a button for a link that appears IN THE BRIEF. Never invent a URL — a made-up',
        '  address is a dead link for every reader. If you want a button and have no link, still write',
        '  the button and leave "href" empty; somebody will fill it in.',
        IMAGE_RULES[opts.images ?? 'sparing'],
        '- Use columns sparingly, and never inside another columns item.',
        `- At most ${MAX_NODES} items.`,
        '- The prose in the layout IS the draft. Do not write the same words twice.',
    ].join('\n');
}
