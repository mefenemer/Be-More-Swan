// tests/site-owner-content.test.ts
// The Website Assistant: the owner's own pictures and words on their site.
//   1. "Choose picture" — library pictures (content_assets) instead of pasted web addresses.
//   2. "Add your own words" — the owner's text placed on a page WORD FOR WORD (site-words.ts).
//   3. Chat attachments — pictures and documents in the Website Assistant's chat (chat-attachments.ts).
//
// Run:  npx tsx tests/site-owner-content.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetIdsIn, normaliseSiteDefinition, withoutAssets } from '../src/utils/site-definition';
import { imageSrc, renderSitePage } from '../src/utils/site-render';
import { siteAssetUrl } from '../src/utils/site-hosting';
import { checkoutParams } from '../src/utils/site-shop';
import type { SiteRow } from '../src/utils/site-store';
import { assemblePlacement, buildPlacementPrompt, fileKind, proposalKeepsEveryWord, readPlan, readWordsFile, tidyWords, wordsToBlocks } from '../src/utils/site-words';
import { applySiteOperation, LIMITS } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };
const signed = (id: number) => `https://bemoreswan.com/api/newsletter/media?a=${id}&s=sig`;

async function main() {
    console.log('\nLibrary pictures');

    await check('a picture can be a library picture (assetId + description); it still needs its description', () => {
        const { definition: d, warnings } = normaliseSiteDefinition({
            theme: { logoAssetId: 12 },
            pages: [{ title: 'Home', slug: '', sections: [
                { type: 'hero', props: { headline: 'Coffee', image: { assetId: 5, alt: 'Our roastery' } } },
                { type: 'products', props: { items: [{ name: 'Beans', price: 999, image: { assetId: 6, alt: '' } }, { name: 'Mug', image: { assetId: '7', alt: 'A mug' } }] } },
            ] }],
        });
        const hero = d.pages[0].sections[0].props as { image: { assetId: number; url: string; alt: string } };
        assert.deepStrictEqual(hero.image, { url: '', alt: 'Our roastery', assetId: 5 });
        const items = (d.pages[0].sections[1].props as { items: Array<{ image: unknown }> }).items;
        assert.strictEqual(items[0].image, null, 'no description → left out');
        assert.ok(warnings.some((w) => /short description of what it shows/.test(w)));
        assert.deepStrictEqual(items[1].image, { url: '', alt: 'A mug', assetId: 7 });
        assert.strictEqual(d.theme.logoAssetId, 12);
        assert.deepStrictEqual(assetIdsIn(d).sort((a, b) => a - b), [5, 7, 12]);
    });

    await check('a library picture is drawn through the signed link; without one it is not drawn at all', () => {
        const d = normaliseSiteDefinition({ theme: { logoAssetId: 12 }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Coffee', image: { assetId: 5, alt: 'Our roastery' } } }] }] }).definition;
        const html = renderSitePage(d, '/', { ...live, assetUrl: signed }).html;
        assert.ok(html.includes(`<img src="${signed(5).replace(/&/g, '&amp;')}" alt="Our roastery"`));
        assert.ok(html.includes(`<a class="brand" href="/"><img src="${signed(12).replace(/&/g, '&amp;')}"`), 'the logo too');
        assert.ok(html.includes(`"logo":"${signed(12).replace(/&/g, '\\u0026')}"`), 'and in the structured data');
        const without = renderSitePage(d, '/', live).html;
        assert.ok(!without.includes('<img'), 'no link → no broken picture');
        assert.strictEqual(imageSrc({ url: 'https://x.example/a.jpg' }), 'https://x.example/a.jpg');
    });

    await check('siteAssetUrl is the emails\' permanent signed link, and fails quietly without a secret', () => {
        const prev = process.env.JWT_SECRET;
        process.env.JWT_SECRET = 'test-secret';
        assert.match(siteAssetUrl('https://bemoreswan.com/', 5)!, /^https:\/\/bemoreswan\.com\/api\/newsletter\/media\?a=5&s=[0-9a-f]{16}$/);
        delete process.env.JWT_SECRET;
        assert.strictEqual(siteAssetUrl('https://bemoreswan.com', 5), null);
        if (prev !== undefined) process.env.JWT_SECRET = prev;
    });

    await check('pictures that are not the workspace\'s are taken out, everywhere they appear', () => {
        const d = normaliseSiteDefinition({
            theme: { logoAssetId: 9 },
            pages: [{ title: 'Home', slug: '', sections: [
                { type: 'hero', props: { headline: 'Coffee', image: { assetId: 9, alt: 'x' } } },
                { type: 'products', props: { items: [{ name: 'Beans', image: { assetId: 9, alt: 'x' } }, { name: 'Mug', image: { assetId: 3, alt: 'y' } }] } },
            ] }],
        }).definition;
        const out = withoutAssets(d, new Set([9]));
        assert.deepStrictEqual(assetIdsIn(out), [3]);
        assert.strictEqual(out.theme.logoAssetId, null);
        const store = read('src/utils/site-store.ts');
        const fn = store.slice(store.indexOf('export async function verifySiteAssets'), store.indexOf('/**\n * Claim the AI draft'));
        assert.ok(fn.includes('eq(contentAssets.organisationId, orgId)') && fn.includes("r.assetType === 'image'") && fn.includes("r.status !== 'rejected'"));
        const apply = store.slice(store.indexOf('export async function applySiteOperations'), store.indexOf('export async function verifySiteAssets'));
        assert.ok(apply.indexOf('verifySiteAssets(') < apply.indexOf('db.update(sites)'), 'checked before every save');
    });

    await check('checkout shows a library picture through its link, never an empty address', () => {
        const row = { id: 1, organisationId: 1 } as SiteRow;
        const item = { name: 'Beans', description: null, price: 999, image: { url: '', alt: 'Bag', assetId: 6 } };
        const base = { origin: live.origin, site: row, sectionId: 's1', index: 0, item, collectAddress: false, backPath: '/' };
        assert.deepStrictEqual(checkoutParams({ ...base, imageUrl: signed(6) }).line_items![0].price_data!.product_data!.images, [signed(6)]);
        assert.strictEqual(checkoutParams({ ...base, imageUrl: null }).line_items![0].price_data!.product_data!.images, undefined);
    });

    console.log('\nThe editor');

    await check('every picture field and the logo use "Choose picture"; the web address is tucked away', () => {
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes('function pictureHtml('));
        assert.ok(ed.includes('data-site-pick=') && ed.includes('data-site-pick-item=') && ed.includes('data-site-logo-pick'));
        assert.ok(ed.includes('Use a web address instead'));
        assert.ok(ed.includes('window.MediaPicker.open('));
        assert.ok(!ed.includes('Logo (https address)'));
    });

    await check('the picker: upload by button, drag or paste, or choose from the library; flagged pictures refused', () => {
        const mp = read('src/components/media-picker.js');
        assert.ok(mp.includes('window.MediaPicker = { open, upload }'));
        assert.ok(mp.includes("addEventListener('drop'") && mp.includes("addEventListener('paste'") && mp.includes('type="file" accept="image/*"'));
        assert.ok(mp.includes("a.status !== 'rejected'") && mp.includes('window.gpUploadContentAsset'));
        assert.ok(mp.includes("document.removeEventListener('paste', onPaste)"), 'listeners go when the window closes');
        const ws = read('workspace.html');
        assert.ok(ws.indexOf('/src/components/media-picker.js') > 0 && ws.indexOf('/src/components/media-picker.js') < ws.indexOf('/src/components/assistant-site-editor.js'));
    });

    console.log('\nAdd your own words');

    const OWN = `About Willowbrook

We started roasting in a garage in Headingley in 2015, because we couldn't find coffee we wanted to drink.
Today we roast six days a week, for cafés across Yorkshire.

Do you deliver?
Yes — anywhere in the UK, usually within two days.

Can I visit?
Our roastery is open on Saturdays from 9 until 1.`;
    const page = (sections: unknown[]) => normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Coffee' } }] }, { title: 'About', slug: 'about', sections }] }).definition;

    await check('the text becomes numbered blocks: titles split from their paragraphs, PDF line-breaks joined', () => {
        const blocks = wordsToBlocks(OWN);
        assert.deepStrictEqual(blocks, [
            'About Willowbrook',
            'We started roasting in a garage in Headingley in 2015, because we couldn\'t find coffee we wanted to drink. Today we roast six days a week, for cafés across Yorkshire.',
            'Do you deliver?',
            'Yes — anywhere in the UK, usually within two days.',
            'Can I visit?',
            'Our roastery is open on Saturdays from 9 until 1.',
        ]);
        assert.strictEqual(tidyWords('  a \t b\r\n\n\n\nc  '), 'a b\n\nc');
    });

    await check('the model is shown numbered blocks and asked for a plan — it is told never to write a word', () => {
        const d = page([{ type: 'text', props: { heading: 'Our story', body: 'Placeholder' } }]);
        const pr = buildPlacementPrompt(d.pages[1], wordsToBlocks(OWN), 'replaces the story');
        assert.ok(pr.system.includes('never write, change, shorten or add any words'));
        assert.ok(pr.user.includes('[1] About Willowbrook') && pr.user.includes('<their_note>\nreplaces the story'));
        assert.ok(pr.user.includes('Use EVERY block exactly once'));
    });

    await check('a plan is built from the owner\'s own blocks — the words on the page are theirs, unchanged', () => {
        const d = page([{ type: 'text', props: { heading: 'Our story', body: 'Placeholder' } }]);
        const sid = d.pages[1].sections[0].id;
        const blocks = wordsToBlocks(OWN);
        const plan = readPlan({ summary: 'Story, then questions.', changes: [
            { op: 'update', sectionId: sid, heading: 1, body: [2] },
            { op: 'add_faq', after: sid, heading: null, items: [{ q: 3, a: [4] }, { q: 5, a: [6] }] },
        ] })!;
        const pr = assemblePlacement(d, d.pages[1].id, blocks, plan);
        assert.ok(!('error' in pr));
        if ('error' in pr) return;
        let work = d;
        for (const op of pr.ops) { const r = applySiteOperation(work, op, { maxPages: 5 }); assert.ok(r.ok, JSON.stringify(op)); if (r.ok) work = r.definition; }
        const secs = work.pages[1].sections;
        assert.deepStrictEqual(secs[0].props, { heading: 'About Willowbrook', body: blocks[1] });
        assert.strictEqual(secs[1].type, 'faq');
        assert.deepStrictEqual((secs[1].props as { items: unknown }).items, [{ q: 'Do you deliver?', a: blocks[3] }, { q: 'Can I visit?', a: blocks[5] }]);
        assert.ok(proposalKeepsEveryWord(blocks, pr));
    });

    await check('a block the plan leaves out is added at the end; a block used twice is used once', () => {
        const d = page([]);
        const blocks = wordsToBlocks(OWN);
        const pr = assemblePlacement(d, d.pages[1].id, blocks, { summary: '', changes: [{ op: 'add_text', after: null, heading: 1, body: [2, 2] }] });
        assert.ok(!('error' in pr));
        if ('error' in pr) return;
        assert.strictEqual(pr.preview.at(-1)!.label, 'The rest of your words, at the end of the page');
        assert.ok(proposalKeepsEveryWord(blocks, pr));
        const all = pr.preview.map((x) => x.text).join('\n');
        assert.strictEqual(all.split(blocks[1]).length - 1, 1, 'not duplicated');
    });

    await check('no plan at all (the model failed) still places every word, in order', () => {
        const d = page([]);
        const blocks = wordsToBlocks(OWN);
        const pr = assemblePlacement(d, d.pages[1].id, blocks, { summary: '', changes: [] });
        assert.ok(!('error' in pr) && proposalKeepsEveryWord(blocks, pr as never));
    });

    await check('text longer than a section holds is split across sections — never cut short', () => {
        const para = 'The beans are roasted slowly in small batches. '.repeat(40).trim();
        const long = Array.from({ length: 5 }, () => para).join('\n\n');
        const blocks = wordsToBlocks(long);
        const d = page([]);
        const pr = assemblePlacement(d, d.pages[1].id, blocks, { summary: '', changes: [{ op: 'add_text', after: null, heading: null, body: [1, 2, 3, 4, 5] }] });
        assert.ok(!('error' in pr));
        if ('error' in pr) return;
        assert.ok(pr.ops.length >= 3, 'split into several text sections');
        for (const op of pr.ops) assert.ok(String((op as { section: { props: { body: string } } }).section.props.body).length <= LIMITS.textBody);
        assert.strictEqual(pr.preview.map((x) => x.text).join('\n\n').replace(/\s+/g, ' '), blocks.join(' ').replace(/\s+/g, ' '));
    });

    await check('a plan naming sections that don\'t exist, or junk, is read defensively', () => {
        assert.strictEqual(readPlan('nope'), null);
        const p = readPlan({ changes: [{ op: 'rewrite', text: 'NEW WORDS' }, { op: 'add_text', body: ['1', 0, -2, 'x'] }] })!;
        assert.deepStrictEqual(p.changes, [{ op: 'add_text', after: null, heading: null, body: [1] }]);
        const d = page([]);
        const pr = assemblePlacement(d, d.pages[1].id, ['Hello there.'], { summary: '', changes: [{ op: 'update', sectionId: 'ghost', heading: null, body: [1] }] });
        assert.ok(!('error' in pr) && proposalKeepsEveryWord(['Hello there.'], pr as never));
    });

    await check('files: Word, PDF or text are read; anything else is refused in plain words', async () => {
        assert.strictEqual(fileKind('story.docx', ''), 'docx');
        assert.strictEqual(fileKind('menu.PDF', ''), 'pdf');
        assert.strictEqual(fileKind('notes.txt', 'text/plain'), 'text');
        assert.strictEqual(fileKind('photo.jpg', 'image/jpeg'), null);
        assert.strictEqual(await readWordsFile('a.txt', 'text/plain', Buffer.from('Hello, Yorkshire.')), 'Hello, Yorkshire.');
        await assert.rejects(readWordsFile('a.exe', 'application/octet-stream', Buffer.from('x')), /Word document/);
        await assert.rejects(readWordsFile('a.txt', 'text/plain', Buffer.alloc(5 * 1024 * 1024)), /too large/);
    });

    await check('placing words: capacity asked first, moderated, 1 task only once a proposal exists, nothing saved', () => {
        const store = read('src/utils/site-store.ts');
        const fn = store.slice(store.indexOf('export async function proposeOwnWords'), store.indexOf('// ── What the chat sees'));
        assert.ok(fn.indexOf('hasTaskCapacity(') < fn.indexOf('gatewayGenerate('));
        assert.ok(fn.indexOf("if ('error' in proposal) return") < fn.indexOf("recordCompletedWork(db, site.organisationId, 'site_words'"));
        assert.ok(!fn.includes('db.update(sites)'), 'a proposal saves nothing');
        const api = read('netlify/functions/sites.ts');
        const words = api.slice(api.indexOf("if (action === 'words')"), api.indexOf("if (action === 'orders')"));
        assert.ok(words.indexOf('enforcePromptModeration(') < words.indexOf('proposeOwnWords('));
        assert.ok(read('netlify.toml').includes('[functions.sites]\n  timeout = 26'));
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes('Your wording, unchanged') && ed.includes("action: 'words'") && ed.includes('Uses 1 task.'));
        assert.ok(ed.indexOf("t('[data-site-words-apply]')") > 0 && ed.includes('await apply(ops,'), 'Apply goes through the normal apply');
    });

    console.log('\nChat attachments');

    await check('attachments are checked before the turn\'s task is spent, documents are moderated', () => {
        const fn = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(fn.indexOf('readAttachments(db, orgId, body.attachments)') < fn.indexOf('consumeTaskCredit(db, orgId)'));
        assert.ok(fn.indexOf("source: 'chat_attachment'") < fn.indexOf('consumeTaskCredit(db, orgId)'));
        assert.ok(fn.includes('if (attached.length && route.acceptsAttachments)') && fn.includes('saveAttachments(db, orgId, session.id, userMessage.id, attached)'));
        assert.ok(fn.includes('acceptsAttachments: true,'), 'on for the Website Assistant');
        assert.ok(fn.includes("if (!typed && !attached.length) return json(400"), 'a message may be just files');
    });

    await check('a picture must be the workspace\'s own, a picture, and not refused; a document keeps only its words', () => {
        const src = read('src/utils/chat-attachments.ts');
        const fn = src.slice(src.indexOf('export async function readAttachments'), src.indexOf('export async function saveAttachments'));
        assert.ok(fn.includes('eq(contentAssets.organisationId, orgId)') && fn.includes("row.assetType !== 'image'") && fn.includes("row.status === 'rejected'"));
        assert.ok(fn.includes('readWordsFile(') && fn.includes('MAX_WORDS_CHARS') && fn.includes('ATTACHMENT_LIMITS.documentBytes'));
        assert.ok(read('db/z-chat-attachments.sql').includes("CHECK (kind IN ('image', 'document'))"));
    });

    await check('the model is told never to retype their words — it names the document, or quotes them exactly', () => {
        const fn = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(fn.includes('NEVER retype, shorten, tidy or reword it in a site_changes card. Emit a site_words card instead'));
        assert.ok(fn.includes('{"assetId": <id>, "alt": "<what the picture shows>"}'));
        assert.ok(fn.includes('"type": "site_words"'));
    });

    await check('a quote is used only if it really is in one of the owner\'s own messages in that conversation', () => {
        const src = read('src/utils/chat-attachments.ts');
        const fn = src.slice(src.indexOf('export async function quoteFromChat'));
        assert.ok(fn.includes('eq(chatSessions.organisationId, orgId)') && fn.includes("eq(chatMessages.role, 'user')") && fn.includes('.includes(q)'));
        const api = read('netlify/functions/sites.ts');
        const words = api.slice(api.indexOf("if (action === 'words')"), api.indexOf("if (action === 'orders')"));
        assert.ok(words.includes('attachmentText(db, orgId, attachmentId)') && words.includes('quoteFromChat(db, orgId, Number(body.chatSessionId), body.quote)'));
        assert.ok(words.indexOf('quoteFromChat(') < words.indexOf('proposeOwnWords('));
    });

    await check('the site_words card: place (preview, nothing saved), then Apply through the normal apply', () => {
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('site_words', renderSiteWordsCard)"));
        const card = reg.slice(reg.indexOf('function renderSiteWordsCard'), reg.indexOf("register('site_words'"));
        assert.ok(card.includes("new CustomEvent('site:words'") && card.includes("new CustomEvent('site:apply'") && card.includes('Your wording, unchanged'));
        assert.ok(card.indexOf("'site:words'") < card.indexOf("'site:apply'"));
        const chat = read('src/components/chat-session.js');
        assert.ok(chat.includes("sitePost({ action: 'words', assistantId, pageId: d.pageId, attachmentId: d.attachmentId, quote: d.quote, chatSessionId"));
        assert.ok(chat.includes("container.addEventListener('site:words', onSiteWords)") && chat.includes("container.removeEventListener('site:words', onSiteWords)"));
    });

    await check('the chat box: paperclip, drag and drop, paste — only for roles that take files; pictures go to the library', () => {
        const chat = read('src/components/chat-session.js');
        assert.ok(chat.includes("const ATTACH_ROLES = new Set(['website_assistant'])"));
        assert.ok(chat.includes('data-chat-attach') && chat.includes("container.addEventListener('drop', onDrop)") && chat.includes("inputEl.addEventListener('paste', onPaste)"));
        assert.ok(chat.includes('window.MediaPicker.upload(p.file)'));
        assert.ok(chat.includes("container.removeEventListener('drop', onDrop)"), 'listeners removed on destroy');
        assert.ok(read('assistant-chat.html').includes('/src/components/media-picker.js'));
    });

    console.log(`\n${passed}/${total} passed`);
}

void main();
