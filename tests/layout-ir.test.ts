// tests/layout-ir.test.ts
// The layout IR: what the assistant returns when it designs, and the two things we compile it into.
//
// ⚠️ THE FOUR FAULTS THIS FILE EXISTS TO CATCH:
//
//  1. MARKUP FROM A MODEL. The IR's whole premise is that the model emits INTENT — no HTML, no
//     colours, no ids. A published blog post renders on the customer's own domain and the sanitiser
//     allowlist is the control that makes that safe; a validator that lets a node through with a
//     model-authored href or an invented asset id hands that control away.
//
//  2. A LAYOUT THAT EATS A DRAFT. Structure is cosmetic and copy is not. Every path where the
//     layout is missing, malformed or unusable must still produce the draft the customer paid for,
//     by falling back to the prose the model wrote.
//
//  3. AN OVERWRITTEN DESIGN. An issue the author has already laid out must never be re-designed by
//     a regeneration — their pictures and buttons are choices, and applyProseToDesign exists so the
//     new copy flows into them instead.
//
//  4. TWO SOURCES OF TRUTH. When a design exists it is authoritative and body_markdown is derived
//     from it. A generation path that writes a design and its own separate prose has just created
//     the disagreement the whole Studio is built to avoid.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    LAYOUT_IR_VERSION, MAX_NODES, groundLinks, groundMarkdownLinks, irToBlogMarkdown,
    irToDesignBlocks, layoutIrPromptBlock, mediaIntents, normaliseLayoutIr,
    type IrImage, type LayoutIr,
} from '../src/utils/layout-ir';
import { MAX_SOURCED_IMAGES, sourceBlogImages } from '../src/utils/blog-media-source';
import {
    DEFAULT_THEME, designToMarkdown, normaliseDesign,
    type ButtonBlock, type ColumnsBlock, type ImageBlock, type NewsletterDesign, type TextBlock,
} from '../src/utils/newsletter-design';
import { renderMarkdown } from '../src/utils/markdown-render';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const codeOnly = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    try {
        const out = fn();
        if (out instanceof Promise) {
            return out.then(() => { passed++; console.log(`  ✓ ${name}`); })
                .catch((err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
        }
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
    return Promise.resolve();
}

const IR = read('src/utils/layout-ir.ts');
const GEN = read('src/utils/newsletter-generate.ts');
const UI = read('newsletter.js');

const ir = (nodes: unknown[]): LayoutIr => normaliseLayoutIr(nodes) as LayoutIr;

async function main() {
console.log('\nLayout IR\n');

// ── 1. The validator, on output from a language model ───────────────────────

await check('a node kind we do not understand is dropped, never coerced', () => {
    const out = ir([
        { kind: 'heading', text: 'Real', level: 2 },
        { kind: 'video', src: 'https://example.com/x.mp4' },
        { kind: 'html', html: '<script>alert(1)</script>' },
        { kind: 'prose', markdown: 'Also real.' },
    ]);
    assert.strictEqual(out.nodes.length, 2);
    assert.deepStrictEqual(out.nodes.map((n) => n.kind), ['heading', 'prose']);
});

await check('an invented image id or URL never survives — a picture is DESCRIBED', () => {
    const out = ir([
        { kind: 'image', alt: 'A team stand-up', caption: 'Monday', query: 'team meeting', assetId: 41, src: 'https://evil.example/x.png' },
        { kind: 'prose', markdown: 'x' },
    ]);
    const img = out.nodes[0] as unknown as Record<string, unknown>;
    assert.strictEqual(img.assetId, undefined, 'an assetId came through the validator');
    assert.strictEqual(img.src, undefined, 'a src came through the validator');
    assert.strictEqual(img.alt, 'A team stand-up');
});

await check('a picture with no alt text is dropped', () => {
    // The one thing an image-blocking client shows, and ~40% of business recipients are one.
    assert.strictEqual(normaliseLayoutIr([{ kind: 'image', alt: '', query: 'sunset' }]), null);
});

await check('a button href goes through the same gate a typed one does', () => {
    const out = ir([
        { kind: 'button', label: 'Click', href: 'javascript:alert(1)' },
        { kind: 'button', label: 'Bare', href: 'example.com/pricing' },
        { kind: 'button', label: 'Fine', href: 'https://example.com' },
    ]);
    const hrefs = out.nodes.map((n) => (n as { href: string }).href);
    assert.deepStrictEqual(hrefs, ['', 'https://example.com/pricing', 'https://example.com']);
});

await check('columns are two flat lists — nested layouts are refused, not unwrapped', () => {
    const nested = ir([
        {
            kind: 'columns',
            columns: [
                [{ kind: 'prose', markdown: 'left' }, { kind: 'columns', columns: [[], []] }],
                [{ kind: 'prose', markdown: 'right' }],
            ],
        },
        { kind: 'prose', markdown: 'after' },
    ]);
    const cols = nested.nodes[0] as { columns: unknown[][] };
    assert.strictEqual(cols.columns[0].length, 1, 'the nested columns node was kept');
    // One empty side is not a two-column layout; it is a column, which is just the page.
    assert.strictEqual(normaliseLayoutIr([{ kind: 'columns', columns: [[{ kind: 'prose', markdown: 'x' }], []] }]), null);
});

await check('one paragraph is not a layout', () => {
    // Letting it through gives a "designed" issue whose design does nothing but take away the
    // plain Markdown box the author was used to.
    assert.strictEqual(normaliseLayoutIr([{ kind: 'prose', markdown: 'Just a sentence.' }]), null);
    assert.strictEqual(normaliseLayoutIr([]), null);
    assert.strictEqual(normaliseLayoutIr(null), null);
    assert.strictEqual(normaliseLayoutIr('nodes'), null);
    assert.ok(normaliseLayoutIr({ nodes: [{ kind: 'heading', text: 'a', level: 2 }, { kind: 'prose', markdown: 'b' }] }));
});

await check('a runaway generation is capped, not accepted', () => {
    const many = Array.from({ length: MAX_NODES + 40 }, (_, i) => ({ kind: 'prose', markdown: `p${i}` }));
    assert.strictEqual(ir(many).nodes.length, MAX_NODES);
    const long = ir([{ kind: 'prose', markdown: 'x'.repeat(50_000) }, { kind: 'divider' }]);
    assert.ok((long.nodes[0] as { markdown: string }).markdown.length <= 6_000);
});

// ── 2. Compiler → newsletter design ─────────────────────────────────────────

await check('every kind compiles to the block the email renderer already knows', () => {
    const blocks = irToDesignBlocks(ir([
        { kind: 'heading', text: 'Hello', level: 2 },
        { kind: 'prose', markdown: 'Words.' },
        { kind: 'quote', text: 'It worked.', attribution: 'A customer' },
        { kind: 'image', alt: 'A desk', caption: 'Ours', query: 'desk' },
        { kind: 'button', label: 'Read it', href: 'https://example.com' },
        { kind: 'divider' },
    ]), DEFAULT_THEME);
    assert.deepStrictEqual(blocks.map((b) => b.type), ['heading', 'text', 'text', 'image', 'button', 'divider']);
    // A quote has no block of its own — it is a blockquote in a text block, which both the canvas
    // and the email renderer already draw.
    assert.match((blocks[2] as TextBlock).markdown, /^> It worked\.\n>\n> — A customer$/);
    // ⚠️ An empty slot, not a picture: the author fills it from the media picker, and until they do
    // the renderer skips it rather than shipping a broken image.
    assert.strictEqual((blocks[3] as ImageBlock).assetId, null);
    assert.strictEqual((blocks[3] as ImageBlock).alt, 'A desk');
    assert.strictEqual((blocks[4] as ButtonBlock).href, 'https://example.com');
});

await check('a compiled button is painted in the theme, not in a colour the model chose', () => {
    const theme = { ...DEFAULT_THEME, accent: '#1d4ed8' };
    const blocks = irToDesignBlocks(ir([
        { kind: 'button', label: 'Go', href: 'https://example.com', background: '#ff0000', color: '#00ff00' },
        { kind: 'prose', markdown: 'x' },
    ]), theme);
    const button = blocks[0] as ButtonBlock;
    assert.strictEqual(button.background, '#1d4ed8');
    assert.strictEqual(button.color, '#ffffff');
});

await check('a compiled layout survives normaliseDesign — the gate every design passes', () => {
    const design = normaliseDesign({
        version: 1, template: 'assistant', theme: DEFAULT_THEME,
        blocks: irToDesignBlocks(ir([
            { kind: 'heading', text: 'A', level: 2 },
            { kind: 'columns', columns: [[{ kind: 'prose', markdown: 'left' }], [{ kind: 'image', alt: 'A chart', query: 'chart' }]] },
            { kind: 'button', label: 'Go', href: 'https://example.com' },
        ]), DEFAULT_THEME),
    }) as NewsletterDesign;
    assert.ok(design, 'the compiled design did not survive validation');
    assert.deepStrictEqual(design.blocks.map((b) => b.type), ['heading', 'columns', 'button']);
    const cols = design.blocks[1] as ColumnsBlock;
    assert.strictEqual(cols.columns[0].length, 1);
    assert.strictEqual(cols.columns[1][0].type, 'image');
    // And the derived prose mirror is real Markdown, which is what the text part of the email,
    // the word count and the assistant all read.
    assert.match(designToMarkdown(design), /left/);
});

// ── 3. Compiler → blog Markdown ─────────────────────────────────────────────

await check('the blog compiler emits Markdown the real parser tokenises', async () => {
    const md = irToBlogMarkdown(ir([
        { kind: 'heading', text: 'The title', level: 1 },
        { kind: 'prose', markdown: 'An **opening** line.' },
        { kind: 'quote', text: 'Quoted.', attribution: 'Someone' },
        { kind: 'columns', columns: [[{ kind: 'prose', markdown: 'Left side.' }], [{ kind: 'prose', markdown: 'Right side.' }]] },
        { kind: 'button', label: 'Read the post', href: 'https://example.com/post' },
        { kind: 'divider' },
    ]));
    assert.match(md, /^# The title$/m);
    assert.match(md, /^> Quoted\.$/m);
    assert.match(md, /\[Read the post\]\(https:\/\/example\.com\/post\)/);

    // ⚠️ The real pipeline — marked + the shared directive tokenizer + sanitize-html. If the fence
    // shape is wrong the author gets literal "::::columns{cols=2}" text in their published post,
    // which is exactly the failure a string assertion on the Markdown would miss.
    const html = await renderMarkdown(md);
    assert.match(html, /class="bms-columns"/);
    assert.strictEqual(html.includes('::::columns'), false, 'the directive was published as literal text');
    assert.match(html, /Left side\./);
    assert.match(html, /Right side\./);
});

await check('a picture is dropped from blog Markdown rather than faked, and kept as an intent', () => {
    // ⚠️ The one asymmetry between the compilers. The blog's picture syntax names a real row in
    // blog_post_assets; there is no placeholder form, and inventing one would mean a directive the
    // sanitiser has to accept and the published snapshot could leak as literal text.
    const layout = ir([
        { kind: 'prose', markdown: 'Before.' },
        { kind: 'image', alt: 'A chart', caption: 'Q3', query: 'bar chart' },
        { kind: 'columns', columns: [[{ kind: 'image', alt: 'Nested', query: 'x' }], [{ kind: 'prose', markdown: 'Side.' }]] },
        { kind: 'prose', markdown: 'After.' },
    ]);
    const md = irToBlogMarkdown(layout);
    assert.strictEqual(md.includes('asset://'), false);
    assert.strictEqual(md.includes(':::media'), false);
    assert.match(md, /Before\./);
    assert.match(md, /After\./);
    // A column that compiled to nothing must not swallow the words beside it.
    assert.match(md, /Side\./);
    // The description is not lost — it is the search query and the alt text for the picker.
    assert.deepStrictEqual(mediaIntents(layout).map((m) => m.alt), ['A chart', 'Nested']);
});

await check('a button link the brief never supplied is stripped, and the button kept', () => {
    // ⚠️ A REAL failure, caught by running the actual drafting prompt: Haiku returned a button
    // pointing at https://willowbrookphysio.com/running-clinic — well-formed, plausible, fictional.
    // safeHref cannot help; the URL is perfectly safe, it just does not exist.
    const layout = ir([
        { kind: 'button', label: 'Book a session', href: 'https://invented.example/clinic' },
        { kind: 'button', label: 'Read the post', href: 'https://real.example/post' },
        { kind: 'columns', columns: [
            [{ kind: 'button', label: 'Nested', href: 'https://invented.example/x' }],
            [{ kind: 'prose', markdown: 'side' }],
        ] },
    ]);
    const out = groundLinks(layout, 'Please link to https://real.example/post in the email.');
    assert.strictEqual((out.ir.nodes[0] as { href: string }).href, '');
    assert.strictEqual((out.ir.nodes[1] as { href: string }).href, 'https://real.example/post');
    const nested = (out.ir.nodes[2] as { columns: { href?: string }[][] }).columns[0][0];
    assert.strictEqual(nested.href, '');
    // ⚠️ The buttons SURVIVE — the assistant proposes the call to action, the human supplies the
    // destination. Dropping them would leave the author unaware one was ever suggested.
    assert.deepStrictEqual(out.ir.nodes.map((n) => n.kind), ['button', 'button', 'columns']);
    assert.deepStrictEqual(out.stripped, ['Book a session', 'Nested']);
});

await check('the reviewer is told when a button has no address yet', () => {
    const gen = GEN.slice(landmark(GEN, 'export async function generateIssueBody'), landmark(GEN, '// ── Making an existing draft better'));
    assert.match(gen, /groundLinks\(scrubbed\.ir, suppliedLinks\)/);
    assert.match(gen, /had no link to point at/);
    // The grounded layout is what compiles — not the one that still has the invented link on it.
    assert.match(gen, /irToDesignBlocks\(grounded\.ir, theme\)/);
    assert.match(layoutIrPromptBlock(), /Never invent a URL/);
});

await check('a call to action with nowhere to go is not published as one', () => {
    const md = irToBlogMarkdown(ir([
        { kind: 'prose', markdown: 'Body.' },
        { kind: 'button', label: 'Sign up', href: 'javascript:alert(1)' },
    ]));
    assert.strictEqual(md.includes('Sign up'), false);
});

// ── 4. The prompt and the validator must not drift apart ────────────────────

await check('every kind the prompt asks for is a kind the validator keeps', () => {
    // ⚠️ The pair that always drifts. When they part company the symptom is a model doing exactly
    // as it was told and a validator dropping the result, which reads as the model ignoring us.
    const prompt = layoutIrPromptBlock();
    const kinds = [...prompt.matchAll(/"kind":"([a-z|]+)"/g)].map((m) => m[1]);
    assert.ok(kinds.length >= 7, `the prompt names only ${kinds.length} kinds`);
    for (const kind of kinds) {
        const sample: Record<string, unknown> = { kind };
        if (kind === 'heading') Object.assign(sample, { text: 'x', level: 2 });
        if (kind === 'prose') Object.assign(sample, { markdown: 'x' });
        if (kind === 'quote') Object.assign(sample, { text: 'x' });
        if (kind === 'image') Object.assign(sample, { alt: 'x' });
        if (kind === 'button') Object.assign(sample, { label: 'x', href: 'https://example.com' });
        if (kind === 'columns') Object.assign(sample, {
            columns: [[{ kind: 'prose', markdown: 'l' }], [{ kind: 'prose', markdown: 'r' }]],
        });
        const out = normaliseLayoutIr([sample, { kind: 'divider' }]);
        assert.ok(out && out.nodes.some((n) => n.kind === kind), `the validator drops "${kind}", which the prompt asks for`);
    }
    // And it must keep telling the model the things that are not its decision.
    assert.match(prompt, /No HTML/);
    assert.match(prompt, /Never invent an image id/);
});

await check('the IR is a transport, not a store', () => {
    // Nothing persists a LayoutIr — a newsletter's truth is `design`, a blog post's is
    // body_markdown, and a third copy of the same words would be a third thing to disagree.
    assert.match(IR, /THE IR IS A TRANSPORT, NOT A STORE/);
    assert.strictEqual(codeOnly(read('db/schema.ts')).includes('layoutIr'), false);
    assert.strictEqual(LAYOUT_IR_VERSION, 1);
});

// ── 5. The drafting path ────────────────────────────────────────────────────

await check('the drafter asks for a layout AND keeps a way back to plain Markdown', () => {
    assert.match(GEN, /"layout"\s+— the email itself/);
    // ⚠️ The escape hatch is load-bearing: a model that cannot produce the schema must still hand
    // back a usable draft rather than nothing.
    assert.match(GEN, /ONLY if you cannot produce a layout/);
    assert.match(GEN, /layoutIrPromptBlock\(\)/);
    const gen = GEN.slice(landmark(GEN, 'export async function generateIssueBody'), landmark(GEN, '// ── Making an existing draft better'));
    assert.match(gen, /if \(!design && !bodyRaw\) throw new Error/);
    assert.match(gen, /salvageStringField\(raw, 'bodyMarkdown'\)/);
});

await check('a layout never overwrites a design the author already has', () => {
    const gen = GEN.slice(landmark(GEN, 'export async function generateIssueBody'), landmark(GEN, '// ── Making an existing draft better'));
    assert.match(gen, /const layout = issue\.design \? null : normaliseLayoutIr\(parsed\?\.layout\)/);
    // The other half of the promise: the handler re-flows new copy into an existing layout.
    const fn = read('netlify/functions/newsletter-issues.ts');
    const action = fn.slice(landmark(fn, "if (action === 'generate')"), landmark(fn, "if (action === 'refine')"));
    assert.match(action, /applyProseToDesign\(design, result\.bodyMarkdown\)/);
});

await check('a designed draft derives its prose and writes both in one statement', () => {
    const gen = GEN.slice(landmark(GEN, 'export async function generateIssueBody'), landmark(GEN, '// ── Making an existing draft better'));
    // ⚠️ The design is authoritative and body_markdown is derived from it — never written twice.
    assert.match(gen, /const bodyText = design\s*\n\s*\? designToMarkdown\(design\)/);
    assert.match(gen, /\.\.\.\(design \? \{ design \} : \{\}\)/);
    // Through the gate, like every other design.
    assert.match(gen, /design = normaliseDesign\(\{ version: 1, template: 'assistant'/);
    // The organisation's colours, from the one resolver.
    assert.match(gen, /loadBrandNewsletterTheme\(db, organisationId\)/);
});

await check('the words inside a layout are scrubbed for merge tags like any other copy', () => {
    assert.match(GEN, /function scrubLayoutIr/);
    const scrub = GEN.slice(landmark(GEN, 'function scrubLayoutIr'), landmark(GEN, 'The "read the full post" link'));
    for (const field of ['text', 'markdown', 'attribution', 'alt', 'label']) {
        assert.ok(scrub.includes(`${field}: clean(`), `scrubLayoutIr skips ${field}`);
    }
});

await check('a source link becomes a BLOCK, because a line of Markdown would be erased', () => {
    assert.match(GEN, /function withSourceLinkBlock/);
    const fn = GEN.slice(landmark(GEN, 'function withSourceLinkBlock'), landmark(GEN, 'export async function generateIssueBody'));
    assert.match(fn, /type: 'button'/);
    assert.match(fn, /if \(prose\.includes\(link\.url\)\) return blocks;/);
});

await check('the browser mounts a canvas for a layout it did not have before', () => {
    const gen = UI.slice(landmark(UI, "action: 'generate', id: state.current.id"), landmark(UI, 'renderWarnings(res.warnings)'));
    assert.match(gen, /if \(state\.designer\) state\.designer\.setDesign\(res\.design\);/);
    assert.match(gen, /else if \(state\.current\) mountDesign\(state\.current\);/);
});

// ── 5b. Pictures the drafter asked for, once something has resolved them ────

await check('a resolved picture becomes a directive the real parser renders', async () => {
    const layout = ir([
        { kind: 'prose', markdown: 'Before.' },
        { kind: 'image', alt: 'A bar chart of Q3 revenue', caption: 'Q3', query: 'bar chart' },
        { kind: 'prose', markdown: 'After.' },
    ]);
    const md = irToBlogMarkdown(layout, { assetFor: () => 42 });
    assert.match(md, /^:::media\{asset=42 type=image alt="A bar chart of Q3 revenue" caption="Q3"\}$/m);

    // ⚠️ Through marked + the shared tokenizer + sanitize-html, exactly as publish does. The
    // snapshot must come out src-less — widget-api resolves a fresh URL per read, and a baked-in
    // presigned src is a picture that 404s hours after publish.
    const html = await renderMarkdown(md);
    assert.match(html, /data-bms-asset="42"/);
    assert.strictEqual(html.includes(':::media'), false, 'the directive was published as literal text');
    assert.strictEqual(/<img[^>]*\ssrc=/.test(html), false, 'a src was baked into the snapshot');
    assert.match(html, /alt="A bar chart of Q3 revenue"/);
});

await check('an unresolved picture is dropped, and the words around it are not', () => {
    const layout = ir([
        { kind: 'prose', markdown: 'Before.' },
        { kind: 'image', alt: 'A chart', query: 'chart' },
        { kind: 'prose', markdown: 'After.' },
    ]);
    const md = irToBlogMarkdown(layout, { assetFor: () => null });
    assert.strictEqual(md.includes(':::media'), false);
    assert.match(md, /Before\.[\s\S]*After\./);
});

await check('pictures are numbered in document order, including inside a column', () => {
    // The caller maps resolved assets back by index, so a compiler that counts differently from
    // mediaIntents() hangs the wrong picture under the wrong paragraph.
    const layout = ir([
        { kind: 'image', alt: 'One', query: 'a' },
        { kind: 'columns', columns: [
            [{ kind: 'image', alt: 'Two', query: 'b' }],
            [{ kind: 'prose', markdown: 'side' }],
        ] },
        { kind: 'image', alt: 'Three', query: 'c' },
    ]);
    assert.deepStrictEqual(mediaIntents(layout).map((m) => m.alt), ['One', 'Two', 'Three']);
    const seen: Array<[string, number]> = [];
    irToBlogMarkdown(layout, { assetFor: (image: IrImage, i: number) => { seen.push([image.alt, i]); return i + 1; } });
    assert.deepStrictEqual(seen, [['One', 0], ['Two', 1], ['Three', 2]]);

    // The newsletter compiler counts identically — same options, same order.
    const blocks = irToDesignBlocks(layout, DEFAULT_THEME, { assetFor: (_i, n) => n + 10 });
    const ids: number[] = [];
    const walk = (list: unknown[]) => list.forEach((b) => {
        const block = b as { type: string; assetId?: number | null; columns?: unknown[][] };
        if (block.type === 'image') ids.push(block.assetId as number);
        if (block.type === 'columns') block.columns!.forEach(walk);
    });
    walk(blocks);
    assert.deepStrictEqual(ids, [10, 11, 12]);
});

await check('a model-supplied id still cannot reach a directive', () => {
    // ⚠️ The invariant the whole assetFor indirection exists to keep: ids come from the CALLER,
    // which resolved them against this organisation's own media, never from the reply.
    const layout = ir([
        { kind: 'image', alt: 'A chart', query: 'chart', asset: 99, assetId: 99 },
        { kind: 'prose', markdown: 'x' },
    ]);
    const md = irToBlogMarkdown(layout, { assetFor: () => null });
    assert.strictEqual(md.includes('99'), false);
});

// ── 5c. Sourcing them ───────────────────────────────────────────────────────

await check('a deployment with no stock provider sources nothing, and says so quietly', async () => {
    // ⚠️ Never an error. A picture is not worth failing a draft over — the body is a model call the
    // customer has already paid for, and on the autopilot path it is a job whose retry redrafts the
    // whole post.
    const key = process.env.PEXELS_API_KEY;
    delete process.env.PEXELS_API_KEY;
    try {
        const stub = { select() { throw new Error('the database must not be touched'); } };
        const out = await sourceBlogImages(stub as never, {
            blogPostId: 1, organisationId: 1, userId: 1, queries: ['a', 'b'],
        });
        assert.deepStrictEqual(out, [null, null]);
    } finally {
        if (key !== undefined) process.env.PEXELS_API_KEY = key;
    }
});

await check('the blog drafter compiles the layout, and keeps its way back to Markdown', () => {
    const gen = read('src/utils/blog-generate.ts');
    assert.match(gen, /If you cannot produce a layout, return the post as plain Markdown/);
    // ⚠️ The truncation headroom. Structured output on a 1,200-word post loses the WHOLE object.
    assert.match(gen, /max_tokens: 6000/);
    // Plain Markdown is used exactly as before layouts existed …
    assert.match(gen, /\} else \{\s*\n\s*\/\/ Plain Markdown/);
    // ⚠️ The raw reply is used as the draft, but grounded first — see the prose-link checks above.
    assert.match(gen, /bodyMarkdown = ground\.markdown;/);
    // … but a JSON object with no layout in it must NEVER be persisted as a body.
    assert.match(gen, /\} else if \(parsed\) \{/);
    assert.match(gen, /throw new Error\('The draft came back in a form we could not read/);
    // Invented links are refused here too — on a blog they are a 404 on the customer's own domain.
    assert.match(gen, /groundLinks\(layout, brief\)/);
});

await check('the blog prompt states a length, because layouts made drafts shorter', () => {
    // ⚠️ MEASURED, not guessed. Asking for a layout instead of a wall of Markdown produced ~30%
    // shorter posts on the same brief (mean 773 words against 1,101, two runs each): the model kept
    // the same number of sections and thinned every one. Without a stated length, adding layouts
    // would have quietly downgraded every blog post the product writes. Deleting this line is a
    // silent content regression, which is why it is pinned here.
    const gen = read('src/utils/blog-generate.ts');
    assert.match(gen, /Write 900–1,200 words in total/);
    assert.match(gen, /not a sentence under a heading/);
    // The email side must NOT inherit it — an inbox wants 200–400 words.
    assert.strictEqual(read('src/utils/newsletter-generate.ts').includes('900–1,200'), false);
});

await check('pictures are encouraged on a blog and rationed in an inbox', () => {
    // Measured too: with the sparing wording a 600-word blog post asked for NO pictures at all,
    // which made the whole sourcing path dead code on the surface that most needs it.
    const blog = layoutIrPromptBlock({ images: 'encouraged' });
    const email = layoutIrPromptBlock();
    assert.match(blog, /A long piece earns pictures/);
    assert.match(blog, /concrete visual words/);
    assert.match(email, /only where one genuinely adds something/);
    assert.strictEqual(email.includes('A long piece earns pictures'), false);
    assert.match(read('src/utils/blog-generate.ts'), /layoutIrPromptBlock\(\{ images: 'encouraged' \}\)/);
});

await check('a redraft does not pile a second set of stock photographs onto a post', () => {
    const gen = read('src/utils/blog-generate.ts');
    const block = gen.slice(landmark(gen, 'const wanted = mediaIntents'), landmark(gen, 'bodyMarkdown = irToBlogMarkdown'));
    assert.match(block, /\.from\(blogPostAssets\)/);
    assert.match(block, /if \(!existingMedia\) \{/);
    // The drafter's own words are the search, so no model call is spent re-deriving them.
    assert.match(block, /queries: wanted\.map\(\(m\) => m\.query \|\| m\.alt\)/);
    assert.match(block, new RegExp(`slice\\(0, MAX_SOURCED_IMAGES\\)`));
    assert.ok(MAX_SOURCED_IMAGES <= 3, 'a post that opens with six stock photographs reads like a content farm');
});

await check('stock search accepts keywords instead of deriving them with a model call', () => {
    const pexels = read('src/utils/pexels.ts');
    assert.match(pexels, /const keywords = given\?\.trim\(\) \|\| await generateImageKeywords\(context\)/);
    // Both searches, so stock video gets the same treatment when the blog reaches for it.
    assert.strictEqual((pexels.match(/given\?\.trim\(\) \|\| await generateImageKeywords/g) || []).length, 2);
    // And the blog can now mint a stock VIDEO, not only a photograph (plan §4 Phase 5.2).
    const media = read('netlify/functions/blog-media.ts');
    assert.match(media, /body\.pexelsType === 'video' \? 'video' : 'image'/);
    assert.match(media, /assetType: pexelsType/);
});

// ── 5d. Links the brief never supplied ──────────────────────────────────────

await check('every shape that becomes a live link is grounded — measured, not assumed', async () => {
    // ⚠️ THE LIST IS DERIVED FROM THE REAL RENDERER. GFM autolinks far more than markup: a bare
    // https:// or www. in a paragraph becomes an anchor with no syntax at all, and a reference
    // definition carries its URL somewhere else entirely. Each case below was checked against
    // renderMarkdown to confirm it reaches the page as a link BEFORE grounding was written for it.
    const supplied = 'Please link to https://real.example/post in the article.';
    const ungrounded: Array<[string, string]> = [
        ['inline link', '[our pricing](https://invented.example/pricing)'],
        ['inline image', 'Text. ![a chart](https://invented.example/c.png) More.'],
        ['autolink', 'See <https://invented.example/x> today.'],
        ['bare url', 'See https://invented.example/x for more.'],
        ['bare www', 'See www.invented.example/x for more.'],
        ['reference link', 'See [the guide][g].\n\n[g]: https://invented.example/g'],
        ['mailto', '[email us](mailto:nobody@invented.example)'],
        ['inside a list', '- one\n- see [x](https://invented.example/y)\n- three'],
    ];
    for (const [name, md] of ungrounded) {
        const out = groundMarkdownLinks(md, supplied);
        assert.ok(out.removed >= 1, `${name}: nothing was removed`);
        const html = await renderMarkdown(out.markdown);
        const live = (html.match(/<a\s/g) || []).length + (html.match(/<img\s/g) || []).length;
        assert.strictEqual(live, 0, `${name}: still publishes a live link — ${html}`);
        assert.strictEqual(html.includes('invented.example'), false, `${name}: the address survived`);
    }
});

await check('a link the human DID supply is left exactly alone', async () => {
    const supplied = 'Please link to https://real.example/post in the article.';
    for (const md of ['[the post](https://real.example/post)', 'Read https://real.example/post now.']) {
        const out = groundMarkdownLinks(md, supplied);
        assert.strictEqual(out.removed, 0);
        assert.strictEqual(out.markdown, md);
        const html = await renderMarkdown(out.markdown);
        assert.ok((html.match(/<a\s/g) || []).length >= 1, 'a supplied link was destroyed');
    }
});

await check('code is documentation, not a link — and must survive untouched', async () => {
    // ⚠️ The reason this cannot be a naive regex over the whole string. A URL in a code sample is
    // the thing the author is trying to SHOW; rewriting it corrupts the example, and it was never
    // a link in the first place.
    for (const md of ['Call `https://invented.example/api` from your app.', '```\ncurl https://invented.example/api\n```']) {
        const out = groundMarkdownLinks(md, 'nothing supplied');
        assert.strictEqual(out.removed, 0, 'grounding reached inside code');
        assert.strictEqual(out.markdown, md);
        const html = await renderMarkdown(out.markdown);
        assert.strictEqual((html.match(/<a\s/g) || []).length, 0, 'code became a link');
        assert.ok(html.includes('invented.example'), 'the code sample lost its text');
    }
});

await check('the words survive the link — a sentence is not deleted to kill a URL', () => {
    const out = groundMarkdownLinks('Read [our pricing page](https://invented.example/p) before you decide.', '');
    assert.match(out.markdown, /Read our pricing page before you decide\./);
});

await check('prose and quotes inside a layout are grounded, not just buttons', () => {
    // The dangerous half: a button with a dead href is visibly unfinished in the Studio, whereas an
    // invented link inside a paragraph publishes silently onto the customer's own domain.
    const layout = ir([
        { kind: 'prose', markdown: 'See [our guide](https://invented.example/g) for more.' },
        { kind: 'quote', text: 'Everything is at https://invented.example/all', attribution: 'Someone' },
        { kind: 'columns', columns: [
            [{ kind: 'prose', markdown: 'Nested [link](https://invented.example/n).' }],
            [{ kind: 'prose', markdown: 'Kept: [real](https://real.example/post).' }],
        ] },
    ]);
    const out = groundLinks(layout, 'https://real.example/post');
    assert.strictEqual(out.unlinked, 3);
    assert.match((out.ir.nodes[0] as { markdown: string }).markdown, /See our guide for more\./);
    assert.strictEqual((out.ir.nodes[1] as { text: string }).text.includes('invented.example'), false);
    const cols = out.ir.nodes[2] as { columns: Array<Array<{ markdown: string }>> };
    assert.strictEqual(cols.columns[0][0].markdown.includes('invented.example'), false);
    assert.match(cols.columns[1][0].markdown, /\[real\]\(https:\/\/real\.example\/post\)/);
});

await check('every path that writes prose grounds it — including the fallbacks', () => {
    // ⚠️ The fallback is where this matters MOST: it is what runs when the model could not produce
    // a layout, which is exactly when it is struggling and most likely to invent.
    const blog = read('src/utils/blog-generate.ts');
    assert.match(blog, /const ground = groundMarkdownLinks\(raw, brief\)/);
    assert.match(blog, /ungroundedLinks = ground\.removed/);

    const nl = read('src/utils/newsletter-generate.ts');
    // The issue: layout and fallback share ONE definition of what a supplied link is.
    assert.match(nl, /const suppliedLinks = \[brief, opts\.sourceLink\?\.url \?\? ''\]\.join/);
    assert.match(nl, /groundLinks\(scrubbed\.ir, suppliedLinks\)/);
    assert.match(nl, /groundMarkdownLinks\(bodyRaw, suppliedLinks\)/);
    // The welcome sequence, against its own brief.
    assert.match(nl, /groundMarkdownLinks\(bodyRaw, seqBrief\)/);
    // ⚠️ A REVISION is allowed to keep the links the author already had — the copy being revised is
    // itself the allow-list — and allowed to invent none.
    assert.match(nl, /groundMarkdownLinks\(bodyRaw, issue\.bodyMarkdown \|\| ''\)/);
    // And the reviewer is told, in words, on all three.
    assert.match(nl, /export const UNGROUNDED_LINK_WARNING/);
    assert.strictEqual((nl.match(/UNGROUNDED_LINK_WARNING/g) || []).length, 3);
});

// ── 6. The welcome sequence ─────────────────────────────────────────────────

await check('a welcome email is designed like any other — unless the step already has a layout', () => {
    const draft = GEN.slice(landmark(GEN, 'export async function draftSequenceEmail'), GEN.length);
    assert.match(draft, /const wantsLayout = opts\.allowLayout !== false;/);
    assert.match(draft, /layoutIrPromptBlock\(\)/);
    // ⚠️ The escape hatch survives here too.
    assert.match(draft, /only if you cannot produce a layout/i);
    // Structure costs tokens; the headroom is only bought for the run that wants it.
    assert.match(draft, /max_tokens: wantsLayout \? 2400 : 1600/);
    // Same three steps as an issue: scrub the words, refuse invented links, build in the org colours.
    assert.match(draft, /scrubLayoutIr\(layout, customKeys\)/);
    assert.match(draft, /groundLinks\(scrubbed\.ir, seqBrief\)/);
    assert.match(draft, /loadBrandNewsletterTheme\(db, organisationId\)/);
    assert.match(draft, /design = normaliseDesign\(\{/);
    // And the prose is derived from the design rather than written twice.
    assert.match(draft, /bodyMarkdown: design \? designToMarkdown\(design\) : body\.text/);
});

await check('the step editor stops deleting the author\'s pictures', () => {
    // ⚠️ A REAL bug found while wiring this: the issue editor has re-flowed new copy into a layout
    // since the Studio shipped, but the sequence editor rebuilt the step's blocks from the Markdown
    // IN THE BROWSER — which threw away every picture and button in a welcome email, on both the
    // draft path and the "use this version" path.
    const seq = read('netlify/functions/newsletter-sequences.ts');
    const generate = seq.slice(landmark(seq, "if (action === 'generate')"), landmark(seq, "if (action === 'refine')"));
    assert.match(generate, /const existingDesign = normaliseDesign\(body\.design\)/);
    assert.match(generate, /allowLayout: !existingDesign/);
    assert.match(generate, /applyProseToDesign\(existingDesign, result\.bodyMarkdown\)/);

    const refine = seq.slice(landmark(seq, "if (action === 'refine')"), landmark(seq, "if (action === 'preview')"));
    assert.match(refine, /applyProseToDesign\(existingDesign, result\.bodyMarkdown\)/);

    // The browser must no longer build its own answer on either path.
    const code = codeOnly(UI);
    assert.strictEqual(code.includes('blocksFromMarkdownClient(res.bodyMarkdown'), false);
    assert.strictEqual(code.includes('blocksFromMarkdownClient(r.bodyMarkdown'), false);
    // It is still the right tool for the one job it was written for: converting what the author
    // typed, for a step that has no row on the server yet.
    assert.match(code, /blocks: blocksFromMarkdownClient\(md\)/);
});

await check('the step editor sends its layout up and mounts a new one', () => {
    // ⚠️ Bounded by the NEXT function, not by a line that also appears earlier in the file — a
    // start after the end is an empty slice and a silently green assertion.
    const start = landmark(UI, "action: 'generate',\n          stepNumber:");
    const gen = UI.slice(start, landmark(UI, 'async function seqImprove', start));
    assert.match(gen, /design: \(seqState\.designer && seqState\.designer\.getDesign\(\)\) \|\| seqState\.editing\.design \|\| null/);
    assert.match(gen, /else mountSeqDesign\(res\.design\);/);
    assert.match(gen, /seqState\.editing\.design = res\.design;/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
