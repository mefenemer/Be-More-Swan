// tests/newsletter-design.test.ts
// The Newsletter Design Studio: the block model, the two renderers, and the promises the UI makes
// about them.
//
// ⚠️ THE THREE THINGS THAT GO WRONG WITH A DESIGN FEATURE, and what this file guards:
//
//  1. TWO SOURCES OF TRUTH. A design holds prose and so does body_markdown. If they are allowed to
//     disagree, the text part of the email, the word count, the assistant and every existing
//     reader of body_markdown are all describing a different email from the one being sent. The
//     rule is one-directional — design → markdown on save, markdown → design only through
//     applyProseToDesign — and it is asserted here.
//
//  2. AN IMAGE URL THAT EXPIRES. Everywhere else an asset resolves to a presigned R2 URL good for
//     ten minutes. An email is rendered once and read for years. A design must never embed one.
//
//  3. A DESIGN THAT ARRIVED FROM A BROWSER. It is stored as jsonb and interpolated into email
//     HTML: an unvalidated colour is a style injection and an unvalidated href is a phishing link
//     in somebody else's subscribers' inboxes.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    applyProseToDesign, blocksFromMarkdown, collectAssetIds, designToHtml, designToMarkdown,
    findingsHtmlHint, isEmptyDesign, normaliseDesign, safeHref, DEFAULT_THEME,
    type NewsletterDesign,
} from '../src/utils/newsletter-design';
import { designFromTemplate, NEWSLETTER_TEMPLATES } from '../src/config/newsletter-templates';
import {
    DEFAULT_PURPOSE, NEWSLETTER_PURPOSES, findPurpose, purposeOrDefault, purposePromptBlock,
} from '../src/config/newsletter-purposes';
import { newsletterMediaUrl, signAssetId, verifyAssetSignature } from '../src/utils/newsletter-media-url';
import { normaliseSendAt } from '../src/utils/newsletter-chat-draft';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    try {
        const out = fn();
        if (out instanceof Promise) return out.then(() => { passed++; console.log(`  ✓ ${name}`); })
            .catch((err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
    return Promise.resolve();
}

const DESIGN = read('src/utils/newsletter-design.ts');
const RENDER = read('src/utils/newsletter-render.ts');
const ISSUES = read('netlify/functions/newsletter-issues.ts');
const SEQ = read('netlify/functions/newsletter-sequences.ts');
const MEDIA_FN = read('netlify/functions/newsletter-media.ts');
const DESIGNER = read('src/components/newsletter-designer.js');
const UI = read('newsletter.js');
const TOML = read('netlify.toml');
const SQL = read('db/newsletter-design.sql');

const RENDER_OPTS = {
    renderMarkdown: async (md: string) => `<p>${md}</p>`,
    imageUrl: (id: number) => `https://app.example.com/api/newsletter/media?a=${id}&s=abc`,
};

const design = (blocks: unknown[]): NewsletterDesign =>
    normaliseDesign({ version: 1, template: 'custom', theme: DEFAULT_THEME, blocks }) as NewsletterDesign;

async function main() {
console.log('\nNewsletter design\n');

// ── 1. One source of truth ──────────────────────────────────────────────────

await check('the design is authoritative and the markdown is derived — never the other way', () => {
    assert.match(DESIGN, /WHEN A DESIGN EXISTS, THE DESIGN IS AUTHORITATIVE AND body_markdown IS DERIVED FROM IT/);
    // The write path has to actually do it, in both places an email can be written.
    const update = ISSUES.slice(landmark(ISSUES, "if (action === 'update')"), landmark(ISSUES, "if (action === 'generate')"));
    assert.match(update, /patch\.bodyMarkdown = scrubMergeTags\(designToMarkdown\(design\)/);
    assert.match(SEQ, /const rawBody = design \? designToMarkdown\(design\)/);
});

await check('the prose mirror carries every word a reader would see', () => {
    const d = design([
        { type: 'heading', text: 'Autumn hours', level: 2, align: 'left' },
        { type: 'text', markdown: 'We are open later on Thursdays.', align: 'left' },
        { type: 'button', label: 'Book a table', href: 'https://acme.test/book', align: 'center' },
        { type: 'image', assetId: 7, alt: 'The new terrace', caption: '', align: 'center', width: 100 },
        { type: 'spacer', size: 24 },
    ]);
    const md = designToMarkdown(d);
    assert.match(md, /## Autumn hours/);
    assert.match(md, /open later on Thursdays/);
    // ⚠️ A button is a call to action and the text part has no buttons. Dropping it would delete
    // the whole point of the email for anyone reading in plain text.
    assert.match(md, /\[Book a table\]\(https:\/\/acme\.test\/book\)/);
    // ⚠️ And the alt text counts as words, because it is literally what an image-blocked reader
    // gets — the word count must not flatter a design that is mostly pictures.
    assert.match(md, /The new terrace/);
    // A spacer is not words.
    assert.ok(!/spacer/i.test(md));
});

await check('a rewrite keeps the pictures and buttons exactly where they were', () => {
    // The promise the UI makes in so many words. If this breaks, somebody who spent ten minutes
    // placing photographs loses them by asking for warmer copy, and never presses the button again.
    const before = design([
        { type: 'text', markdown: 'Old opening.', align: 'left' },
        { type: 'image', assetId: 3, alt: 'a', align: 'center', width: 100 },
        { type: 'text', markdown: 'Old middle.', align: 'left' },
        { type: 'button', label: 'Go', href: 'https://a.test', align: 'center' },
    ]);
    const after = applyProseToDesign(before, 'New opening.\n\nNew middle.\n\nA third paragraph.');
    const types = after.blocks.map((b) => b.type);
    assert.deepStrictEqual(types, ['text', 'image', 'text', 'button', 'text'],
        'the image and the button keep their positions, and the extra paragraph lands at the end');
    assert.strictEqual((after.blocks[0] as { markdown: string }).markdown, 'New opening.');
    assert.strictEqual((after.blocks[2] as { markdown: string }).markdown, 'New middle.');
    // The ids are preserved so the editor's selection does not jump under the author's cursor.
    assert.strictEqual(after.blocks[0].id, before.blocks[0].id);
    assert.strictEqual(after.blocks[1].id, before.blocks[1].id);
});

await check('a shorter rewrite removes the paragraphs it replaced, not the layout', () => {
    const before = design([
        { type: 'text', markdown: 'One.', align: 'left' },
        { type: 'text', markdown: 'Two.', align: 'left' },
        { type: 'image', assetId: 9, alt: 'a', align: 'center', width: 100 },
    ]);
    const after = applyProseToDesign(before, 'Just the one now.');
    assert.deepStrictEqual(after.blocks.map((b) => b.type), ['text', 'image']);
});

await check('converting Markdown to blocks keeps the author\'s words', () => {
    const blocks = blocksFromMarkdown('# Title\n\nFirst para.\nStill first.\n\n---\n\n## Next\n\nSecond para.');
    assert.deepStrictEqual(blocks.map((b) => b.type), ['heading', 'text', 'divider', 'heading', 'text']);
    assert.strictEqual((blocks[1] as { markdown: string }).markdown, 'First para.\nStill first.');
});

await check('the browser converts by the same three rules, and says why it has its own copy', () => {
    // ⚠️ A knowing duplicate: a sequence step has no row to update until it is saved, so the
    // conversion has to be possible client-side. A step designed in the browser and re-opened after
    // a save must not rearrange itself.
    assert.match(UI, /A knowing duplicate of blocksFromMarkdown/);
    const client = UI.slice(landmark(UI, 'function blocksFromMarkdownClient'), landmark(UI, 'async function seqGenerate'));
    assert.match(client, /#\{1,3\}/, 'headings');
    assert.match(client, /---\|/, 'horizontal rules');
    assert.match(client, /type: 'text'/, 'paragraph groups');
});

// ── 2. Image URLs that do not expire ────────────────────────────────────────

await check('a design never embeds a presigned URL, and says why', () => {
    assert.match(RENDER, /Image URLs are resolved to the signed, permanent/i);
    assert.ok(!/presignR2Get/.test(DESIGN), 'the design module must not be able to mint one');
    assert.ok(!/presignR2Get/.test(RENDER), 'nor the renderer');
    // The renderer resolves through the signed route, and only through it.
    assert.match(RENDER, /newsletterMediaUrl\(baseUrl, assetId\)/);
});

await check('an image with no origin to resolve against is dropped, not rendered broken', async () => {
    const html = await designToHtml(
        design([{ type: 'image', assetId: 4, alt: 'x', align: 'center', width: 100 }]),
        { ...RENDER_OPTS, imageUrl: () => null },
    );
    assert.ok(!/<img/.test(html), 'a relative or missing src is a broken image in every client');
});

await check('approving a designed issue with pictures refuses rather than sending them missing', () => {
    const approve = ISSUES.slice(landmark(ISSUES, "if (action === 'approve')"), landmark(ISSUES, "if (action === 'send')"));
    assert.match(approve, /approveDesign && !baseUrl/);
    assert.match(approve, /the pictures would be missing/);
    // ⚠️ The same guard on a sequence step, which is worse: it sends unattended for months.
    assert.match(SEQ, /the pictures would be missing/);
});

await check('the media route is signed, public by necessity, and never 500s an <img>', () => {
    assert.match(MEDIA_FN, /WHY IT IS UNAUTHENTICATED, AND WHY THAT IS SAFE/);
    assert.match(MEDIA_FN, /if \(!signed\) return pixel\(\);/);
    // ⚠️ Signature check BEFORE the database: this is fetched once per recipient per open.
    const sigAt = MEDIA_FN.indexOf('verifyAssetSignature');
    const dbAt = MEDIA_FN.indexOf('getDb()');
    assert.ok(sigAt > 0 && sigAt < dbAt, 'an unsigned request must not cost a query');
    // A missing image is a transparent pixel, never a broken-image icon in fifteen hundred inboxes.
    assert.match(MEDIA_FN, /NOT a 404, and not an error page/);
    assert.match(TOML, /from = "\/api\/newsletter\/media"/);
});

await check('the signature is stable, unguessable and constant-time to check', () => {
    const secret = 'test-secret-for-signing';
    const a = signAssetId(42, secret);
    assert.strictEqual(a, signAssetId(42, secret), 'stable — a re-render must produce the same URL');
    assert.notStrictEqual(a, signAssetId(43, secret), 'and per-asset');
    assert.strictEqual(a.length, 16);
    assert.ok(verifyAssetSignature(42, a, secret));
    assert.ok(!verifyAssetSignature(43, a, secret), 'the id is part of what is signed');
    assert.ok(!verifyAssetSignature(42, 'x', secret), 'a length mismatch must be false, not a throw');
    assert.match(newsletterMediaUrl('https://app.example.com/', 42, secret), /^https:\/\/app\.example\.com\/api\/newsletter\/media\?a=42&s=[0-9a-f]{16}$/);
});

// ── 3. A design that arrived from a browser ─────────────────────────────────

await check('colours are validated, because they land inside a style attribute', () => {
    const d = normaliseDesign({
        blocks: [{ type: 'button', label: 'Go', href: 'https://a.test', background: 'red;} body{display:none' }],
        theme: { accent: 'javascript:alert(1)', fontFamily: 'x; content: url(evil)' },
    }) as NewsletterDesign;
    assert.strictEqual((d.blocks[0] as { background: string }).background, DEFAULT_THEME.accent);
    assert.strictEqual(d.theme.accent, DEFAULT_THEME.accent);
    // ⚠️ The font is an ALLOW-LIST, not a pattern: it is a whole CSS value, not a hex code.
    assert.strictEqual(d.theme.fontFamily, DEFAULT_THEME.fontFamily);
});

await check('a link is http(s) or mailto, and a bad one degrades instead of refusing the save', () => {
    assert.strictEqual(safeHref('javascript:alert(1)'), '');
    assert.strictEqual(safeHref('data:text/html,<script>'), '');
    assert.strictEqual(safeHref('https://acme.test/x'), 'https://acme.test/x');
    assert.strictEqual(safeHref('mailto:hi@acme.test'), 'mailto:hi@acme.test');
    // A bare domain is what people type, and refusing it teaches nothing about safety.
    assert.strictEqual(safeHref('acme.test/book'), 'https://acme.test/book');
    assert.match(DESIGN, /Returns '' rather than throwing/);
});

await check('text is escaped on the way into the email', async () => {
    const html = await designToHtml(design([
        { type: 'heading', text: '<script>alert(1)</script>', level: 2, align: 'left' },
        { type: 'button', label: '"><b>x', href: 'https://a.test', align: 'center' },
    ]), RENDER_OPTS);
    assert.ok(!/<script>/.test(html));
    assert.ok(!/"><b>/.test(html));
});

await check('columns cannot nest, and an empty block is dropped rather than rendered as a gap', () => {
    const d = normaliseDesign({
        blocks: [
            { type: 'text', markdown: '   ' },
            { type: 'heading', text: '' },
            {
                type: 'columns',
                columns: [[{ type: 'columns', columns: [[], []] }, { type: 'text', markdown: 'left' }], [{ type: 'text', markdown: 'right' }]],
            },
        ],
    }) as NewsletterDesign;
    assert.strictEqual(d.blocks.length, 1, 'the blank text and the empty heading are gone');
    const cols = d.blocks[0] as { type: string; columns: { type: string }[][] };
    assert.strictEqual(cols.type, 'columns');
    assert.deepStrictEqual(cols.columns[0].map((b) => b.type), ['text'], 'the nested column pair is refused');
});

await check('an empty design is the same as no design', () => {
    assert.strictEqual(normaliseDesign({ blocks: [] }), null);
    assert.strictEqual(normaliseDesign(null), null);
    assert.ok(isEmptyDesign(null));
    assert.strictEqual(designToMarkdown(null), '');
});

// ── 4. Email HTML that survives Outlook ─────────────────────────────────────

await check('every block renders as a table row with inline styles', async () => {
    const html = await designToHtml(design([
        { type: 'text', markdown: 'hello', align: 'left' },
        { type: 'button', label: 'Go', href: 'https://a.test', align: 'center' },
    ]), RENDER_OPTS);
    assert.match(html, /<table role="presentation"/);
    assert.match(html, /<tr><td style="padding:0 0 16px;">/);
    // ⚠️ A button is a table, not a padded <a>: Outlook ignores padding on an inline element and
    // renders the button as underlined blue text at exactly the moment it matters most.
    const button = html.slice(html.indexOf('Go') - 400, html.indexOf('Go'));
    assert.match(button, /<table role="presentation"/);
    assert.ok(!/class="/.test(html.replace(/class="bms-col"/g, '')), 'no stylesheet dependency except the column stack');
});

await check('the one stylesheet in the shell is only there to stack columns on a phone', () => {
    assert.match(RENDER, /td\.bms-col\{display:block !important/);
    assert.match(RENDER, /The ONLY thing this stylesheet is load-bearing for/);
});

await check('a plain Markdown issue is not restyled by a feature it does not use', () => {
    // ⚠️ Every issue ever sent used the pre-Studio shell. DEFAULT_THEME is what a NEW design starts
    // from; DEFAULT_THEME_SHELL is what an undesigned issue keeps.
    assert.match(RENDER, /DEFAULT_THEME_SHELL/);
    assert.match(RENDER, /a plain Markdown issue must not silently change appearance/);
});

await check('the findings hint reports the pictures and links a draft has, before there is a snapshot', () => {
    const hint = findingsHtmlHint(design([
        { type: 'image', assetId: 1, alt: 'a', align: 'center', width: 100 },
        { type: 'image', assetId: 2, alt: 'b', href: 'https://a.test', align: 'center', width: 100 },
        { type: 'button', label: 'Go', href: 'https://b.test', align: 'center' },
        { type: 'text', markdown: 'see [this](https://c.test) and [that](https://d.test)', align: 'left' },
    ]));
    assert.strictEqual((hint.match(/<img>/g) || []).length, 2);
    assert.strictEqual((hint.match(/<a href/g) || []).length, 4);
    // ⚠️ The browser builds the SAME string, or the live panel disagrees with the one after reload.
    assert.match(UI, /function designHtmlHint/);
    assert.match(ISSUES, /findingsHtmlHint\(normaliseDesign\(issue\.design\)\)/);
});

await check('collectAssetIds finds pictures inside columns too', () => {
    const ids = collectAssetIds(design([
        { type: 'image', assetId: 5, alt: '', align: 'center', width: 100 },
        { type: 'columns', columns: [[{ type: 'image', assetId: 6, alt: '', align: 'center', width: 100 }], []] },
    ]));
    assert.deepStrictEqual(ids.sort(), [5, 6]);
});

// ── 5. Text and stickers over a picture ─────────────────────────────────────

await check('an overlay is baked into the image, never positioned in the markup', () => {
    assert.match(DESIGN, /Why an image overlay is BAKED and never positioned in the markup/i);
    assert.match(DESIGN, /Absolute positioning is unsupported in\n\/\/ Outlook/);
    assert.match(DESIGNER, /TEXT AND STICKERS ON AN IMAGE ARE BAKED INTO A NEW PICTURE, not positioned in the markup/);
    // The flattening is the social composer's, unchanged — one baker, one geometry.
    assert.match(DESIGNER, /window\.ImageOverlayEditor\.bake/);
    // ⚠️ And it always starts from the CLEAN original, or editing the wording twice stacks two
    // copies of it into the picture.
    assert.match(DESIGNER, /var base = e\.block\.baseAssetId \|\| e\.block\.assetId;/);
    assert.match(DESIGNER, /patch\(blockId, \{ assetId: asset\.id, baseAssetId: base, overlays: overlays \}\)/);
});

await check('the canvas is fed a same-origin data URL, or the bake would throw', () => {
    // canvas.toBlob() raises SecurityError on a cross-origin image, and R2 presigned URLs are
    // cross-origin. get-post-image fetches the bytes server-side for exactly this reason.
    assert.match(DESIGNER, /get-post-image\?assetId=/);
    const gpi = read('netlify/functions/get-post-image.ts');
    assert.match(gpi, /THE assetId FORM EXISTS FOR THE NEWSLETTER DESIGN STUDIO/);
    assert.match(gpi, /eq\(contentAssets\.organisationId, orgId\)/, 'and it is org-scoped like everything else here');
});

await check('choosing a different picture clears the overlays rather than re-applying them blind', () => {
    assert.match(DESIGNER, /A fresh upload REPLACES the picture and clears the overlays/);
    assert.match(DESIGNER, /patch\(blockId, \{ assetId: aid, baseAssetId: aid, overlays: \[\] \}\)/);
});

await check('the alt text is presented as the thing image-blocked readers actually get', () => {
    assert.match(DESIGNER, /a third of people will never see/);
    assert.match(DESIGNER, /if the picture carries words, put those words here too/);
});

// ── 6. Templates and purposes ───────────────────────────────────────────────

await check('every template builds something, and every purpose points at a real one', () => {
    for (const t of NEWSLETTER_TEMPLATES) {
        const d = normaliseDesign(designFromTemplate(t.key));
        assert.ok(d && d.blocks.length, `${t.key} produced nothing`);
        assert.strictEqual(d.template, t.key);
    }
    const keys = NEWSLETTER_TEMPLATES.map((t) => t.key);
    for (const p of NEWSLETTER_PURPOSES) {
        assert.ok(keys.includes(p.defaultTemplate), `${p.key} points at a template that does not exist`);
    }
});

await check('template placeholder copy is impossible to send by accident', () => {
    // ⚠️ Deliberately obvious. Filler that reads like English is how a template's own words end up
    // in somebody's inbox.
    const md = designToMarkdown(normaliseDesign(designFromTemplate('announcement')));
    assert.match(md, /Say the news in six words|Replace this|Start writing/);
});

await check('an unknown purpose degrades instead of breaking a write', () => {
    assert.strictEqual(purposeOrDefault('a_purpose_from_the_future'), DEFAULT_PURPOSE);
    assert.strictEqual(purposeOrDefault(undefined), DEFAULT_PURPOSE);
    assert.strictEqual(findPurpose(null).key, DEFAULT_PURPOSE);
    // ⚠️ Which is only safe because there is no CHECK constraint on the column.
    assert.ok(!/purpose_check/.test(SQL));
    assert.match(SQL, /NOT a CHECK constraint/);
});

await check('a purpose changes the brief, and the ordinary newsletter adds nothing', () => {
    assert.strictEqual(purposePromptBlock('newsletter'), '', 'the default must not pad every prompt');
    const policy = purposePromptBlock('policy_change');
    assert.match(policy, /WHAT THIS EMAIL IS: Terms or policy change/);
    assert.match(policy, /takes effect/);
    // ⚠️ The two purposes where invention is not a style problem but a legal one.
    assert.match(findPurpose('policy_change').promptGuidance, /never invent a date, a price or a clause/i);
    assert.match(findPurpose('offer').promptGuidance, /Never invent a discount, a deadline/i);
    assert.match(findPurpose('incident').promptGuidance, /do NOT use "some users may have experienced"/i);
    // And it reaches the model.
    assert.match(read('src/utils/newsletter-generate.ts'), /purposeBlock \? `\\n\\n\$\{purposeBlock\}`/);
});

// ── 7. The scenarios the sequence deliberately does NOT try to be ───────────

await check('a one-off announcement is an issue with a purpose, not a one-step drip', () => {
    // ⚠️ A welcome series has a trigger — somebody confirmed — so it can run itself. "We are
    // changing our terms on the 1st" has no trigger: it is one email, to a list, on a date. A
    // second manually-fired sequence engine for that would be an issue with extra steps, and the
    // reasoning is written where somebody would go to build one.
    const html = read('newsletter.html');
    assert.match(html, /Deliberately not "one sequence per scenario"/);
    assert.match(html, /it is an ISSUE with a purpose/);
});

await check('a welcome email has everything an issue has', () => {
    // ⚠️ It was the one email in the product with no preview, no layout, no pictures and no
    // assistant — sent unattended to people who have just met the business.
    assert.match(SEQ, /A WELCOME EMAIL IS AN EMAIL/);
    for (const action of ["'generate'", "'refine'", "'preview'", "'template'"]) {
        assert.ok(SEQ.includes(`action === ${action}`), `the step editor needs ${action}`);
    }
    assert.match(SEQ, /design,\n            renderedPayload: rendered,/, 'and the design is stored on the step');
    assert.match(read('db/newsletter-design.sql'), /newsletter_sequence_steps ADD COLUMN IF NOT EXISTS design/);
});

await check('a welcome email is briefed as a welcome email, not as an issue', () => {
    const gen = read('src/utils/newsletter-generate.ts');
    assert.match(gen, /A WELCOME EMAIL IS NOT AN ISSUE/);
    // ⚠️ Sent unattended months from now: nothing time-bound may go in it.
    assert.match(gen, /it must contain NOTHING time-bound/);
    assert.match(gen, /do NOT introduce the/, 'and step three must not re-introduce the business');
});

// ── 8. Scheduling from chat ─────────────────────────────────────────────────

await check('a proposed send time is a wall clock, validated, with no timezone on it', () => {
    assert.strictEqual(normaliseSendAt('2026-09-01T09:00'), '2026-09-01T09:00');
    assert.strictEqual(normaliseSendAt('2026-02-31T09:00'), null, 'the right shape is not a real date');
    assert.strictEqual(normaliseSendAt('2026-09-01T09:00:00Z'), null, 'a zone is exactly what must not arrive');
    assert.strictEqual(normaliseSendAt('next Tuesday'), null);
    assert.strictEqual(normaliseSendAt(null), null);
    assert.match(read('src/utils/newsletter-chat-draft.ts'), /Deliberately zone-LESS/);
});

await check('the card schedules only when the schedule button was the one pressed', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /scheduleFor: schedule \? sendAt : null/);
    assert.match(reg, /A PROPOSAL, NOT A SCHEDULE|Scheduling is the decision to email real people/);
});

await check('a member who cannot approve still ends up with their draft', () => {
    // ⚠️ Two calls on purpose: creating is member-allowed and approving is owner/admin. A combined
    // endpoint would lose the draft on a 403, which is the worst outcome — the issue is written.
    const cs = read('src/components/chat-session.js');
    assert.match(cs, /TWO CALLS, DELIBERATELY/);
    assert.match(cs, /respond\(\{ ok: true, deduped: data\.deduped === true, scheduleError: err\.message \}\)/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /Saved to your Issues tab, but not scheduled/);
});

// ── 9. The Studio's promises ────────────────────────────────────────────────

await check('a revision is offered, never written over the draft', () => {
    assert.match(ISSUES, /RETURNS, DOES NOT SAVE/);
    assert.match(read('src/utils/newsletter-generate.ts'), /IT DOES NOT WRITE TO THE DATABASE/);
    assert.match(UI, /THE REVISION IS OFFERED, NOT APPLIED/);
    // An empty revision must never be able to wipe a draft.
    assert.match(read('src/utils/newsletter-generate.ts'), /An empty body is a FAILURE, not an empty revision/);
});

await check('the assistant is called by its name everywhere it is asked to do something', () => {
    // ⚠️ "The assistant" is nobody: the user hired this colleague and named it themselves.
    assert.match(UI, /function applyAssistantNaming/);
    const html = read('newsletter.html');
    assert.ok((html.match(/data-nl-assistant=/g) || []).length >= 3);
    assert.match(UI, /data-nl-assistant/);
    // And the Studio is told who it is on the way in, which is also what gives new issues an owner.
    const assistants = read('assistants.js');
    assert.match(assistants, /window\._newsletterAssistantId = data\.id;/);
    assert.match(UI, /assistantId: state\.assistant\.id \|\| undefined/);
});

await check('the Newsletter Assistant\'s Overview shows its list, not a follower chart', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    const entry = reg.slice(landmark(reg, 'newsletter_editor: {'), landmark(reg, 'blog_writer: {'));
    assert.match(entry, /audienceSource: 'newsletter_list'/);
    const assistants = read('assistants.js');
    assert.match(assistants, /_audienceSource === 'newsletter_list'/);
    assert.match(assistants, /function _fetchAndRenderNewsletterList/);
    // ⚠️ "Not confirmed" is the row that only exists here: invisible everywhere else, routinely a
    // third of sign-ups on a double opt-in list, and the only one the tenant can act on.
    assert.match(assistants, /Not confirmed/);
    // An empty list is an instruction, not a report of zero.
    assert.match(assistants, /Nobody on your list yet/);
    assert.match(read('netlify/functions/audience-contacts.ts'), /countsOnly === '1'/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
