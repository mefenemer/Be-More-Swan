// tests/design-studio.test.ts — the Brand Designer's editor (owner 2026-11-05: "preview on the left and chat pane on the
// right… change the background transparency, font, colours etc very much like in canva"). What a browser or a chat card
// sends is cleaned in src/utils/design-doc.ts; the questions go straight to a design in src/utils/brief-from-chat.ts.
//
// Run:  npx tsx tests/design-studio.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    applyDesignEdit, designEditFromUiElement, designForChat, normaliseDesign, type Design,
} from '../src/utils/design-doc';
import { AI_PICTURE_ANSWER, startableSources, userChoseAiPicture } from '../src/utils/brief-from-chat';
import { flyerDesign, renderDesignPdfs, renderDesignPreview } from '../src/lib/design-render';
import { normaliseFlyerContent } from '../src/config/flyer-vocab';
import { normalizeBrandKit } from '../src/utils/brand-kit';
import { flyerPageStyle } from '../src/lib/flyer';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const pending: Promise<void>[] = [];
const check = (n: string, fn: () => void | Promise<void>) => {
    const run = async () => { try { await fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };
    pending.push(pending.length ? pending[pending.length - 1].then(run) : run());
};

const ref = { source: 'stock', storageKey: 'org/1/briefs/a.jpg', externalUrl: null, mimeType: 'image/jpeg', width: 1200, height: 800 };
const stored = (): Design => ({
    v: 1, kind: 'flyer', pageW: 148, pageH: 210, paperSize: 'A5', pageColor: '#f2aa00',
    photo: { x: 0, y: 0, w: 1, h: 0.4, opacity: 1, ref },
    layers: [
        { id: 'headline', kind: 'text', role: 'headline', text: 'Launch party', x: 0.1, y: 0.45, w: 0.8, fontFamily: 'Poppins', fontSizePct: 0.05, bold: true, align: 'left', color: '#14243a', boxFill: null, boxOpacity: 1 },
        { id: 'contact', kind: 'text', role: 'contact', text: '01632 960418', x: 0.1, y: 0.9, w: 0.5, fontFamily: null, fontSizePct: 0.015, bold: false, align: 'left', color: '#14243a', boxFill: null, boxOpacity: 1 },
        { id: 'offer', kind: 'text', role: 'offer', text: '10% off', x: 0.1, y: 0.8, w: 0.8, fontFamily: null, fontSizePct: 0.02, bold: true, align: 'left', color: '#ffffff', boxFill: '#14243a', boxOpacity: 1 },
        { id: 'qr', kind: 'qr', role: 'qr', x: 0.75, y: 0.85, w: 0.15, h: 0.1, src: 'data:image/png;base64,AAAA' },
    ],
});

// ── What the browser sends ────────────────────────────────────────────────────────────────────────

check('a browser can move, restyle and add words, and colours and fonts are cleaned', () => {
    const d = normaliseDesign({
        pageColor: '#ABCDEF',
        layers: [
            { id: 'headline', kind: 'text', text: 'Moved', x: 0.2, y: 0.1, color: 'red; background:url(x)', fontFamily: 'Playfair Display', boxFill: '#000000', boxOpacity: 0.5 },
            { id: 'mine', kind: 'text', text: 'New words', x: 0.3, y: 0.6 },
        ],
    }, stored());
    assert.strictEqual(d.pageColor, '#abcdef');
    const h = d.layers.find((l) => l.id === 'headline');
    assert.ok(h && h.kind === 'text');
    assert.strictEqual(h.text, 'Moved');
    assert.strictEqual(h.color, '#14243a', 'a colour that is not a colour keeps the old one');
    assert.strictEqual(h.fontFamily, 'Playfair Display');
    assert.strictEqual(h.boxFill, '#000000');
    assert.strictEqual(h.boxOpacity, 0.5);
    assert.ok(d.layers.some((l) => l.id === 'mine' && l.kind === 'text' && l.text === 'New words'));
});

check('the picture and the QR code can only ever be the ones the server put there', () => {
    const d = normaliseDesign({
        photo: { x: 0.1, y: 0.1, w: 0.5, h: 0.5, opacity: 0.4, ref: { storageKey: 'org/2/secret.jpg', externalUrl: 'https://evil.example/x.jpg' } },
        layers: [
            { id: 'qr', kind: 'qr', x: 0.5, y: 0.5, w: 0.2, h: 0.2, src: 'https://evil.example/qr.png' },
            { id: 'sneaky', kind: 'logo', x: 0, y: 0, w: 0.2, h: 0.2, src: 'https://evil.example/logo.png' },
        ],
    }, stored());
    assert.deepStrictEqual(d.photo?.ref, ref);
    assert.strictEqual(d.photo?.opacity, 0.4);
    const qr = d.layers.find((l) => l.id === 'qr');
    assert.ok(qr && qr.kind === 'qr' && qr.src === 'data:image/png;base64,AAAA' && qr.x === 0.5);
    assert.ok(!d.layers.some((l) => l.id === 'sneaky'), 'an image layer the server never made is dropped');
});

check('sizes and positions are held in range, and the layer count is capped', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, kind: 'text', text: 'x', fontSizePct: 9, x: 99 }));
    const d = normaliseDesign({ layers: many }, stored());
    assert.strictEqual(d.layers.length, 40);
    const l = d.layers[0];
    assert.ok(l.kind === 'text' && l.fontSizePct <= 0.3 && l.x <= 1.5);
});

// ── A change from the chat ────────────────────────────────────────────────────────────────────────

check('the design_edit card is rebuilt from what the model sent, and nothing to change is no card', () => {
    const c = designEditFromUiElement({ type: 'design_edit', briefId: '#4', optionId: 9, summary: ' Darker headline ', changes: [{ layer: 'headline', color: '#000', boxFill: null, onclick: 'x' }], add: [{ text: '  ' }] });
    assert.deepStrictEqual(c, { type: 'design_edit', briefId: 4, optionId: 9, summary: 'Darker headline', changes: [{ layer: 'headline', color: '#000000', boxFill: null }], add: [] });
    assert.strictEqual(designEditFromUiElement({ type: 'design_edit', briefId: 4, optionId: 9, changes: [{ layer: 'headline' }] }), null);
    assert.strictEqual(designEditFromUiElement({ type: 'design_edit', briefId: 0, optionId: 9, pageColor: '#fff' }), null);
});

check('a chat change lands on the named layer, by id or role, and can add words', () => {
    const c = designEditFromUiElement({ type: 'design_edit', briefId: 4, optionId: 9, pageColor: '#ffe4e1', photoOpacity: 0.6, changes: [{ layer: 'headline', text: 'Join us', boxFill: '#000000', boxOpacity: 0.5 }], add: [{ text: 'Free entry', y: 0.7 }] })!;
    const { design, applied } = applyDesignEdit(stored(), c, { fromChat: true });
    assert.strictEqual(applied, 4);
    assert.strictEqual(design.pageColor, '#ffe4e1');
    assert.strictEqual(design.photo?.opacity, 0.6);
    const h = design.layers.find((l) => l.role === 'headline');
    assert.ok(h && h.kind === 'text' && h.text === 'Join us' && h.boxFill === '#000000' && h.boxOpacity === 0.5);
    assert.ok(design.layers.some((l) => l.kind === 'text' && l.text === 'Free entry'));
});

check('chat can never reword or remove the contact details or the offer, only move or recolour them', () => {
    const c = designEditFromUiElement({ type: 'design_edit', briefId: 4, optionId: 9, changes: [
        { layer: 'contact', text: '0800 000 0000' },
        { layer: 'offer', text: '50% off everything', color: '#ff0000' },
        { layer: 'contact', remove: true },
    ] })!;
    const { design, applied } = applyDesignEdit(stored(), c, { fromChat: true });
    assert.strictEqual(applied, 1, 'only the offer colour lands');
    const contact = design.layers.find((l) => l.role === 'contact');
    const offer = design.layers.find((l) => l.role === 'offer');
    assert.ok(contact && contact.kind === 'text' && contact.text === '01632 960418');
    assert.ok(offer && offer.kind === 'text' && offer.text === '10% off' && offer.color === '#ff0000');
    // In the editor the user can still type them: no lock without fromChat.
    const own = applyDesignEdit(stored(), c);
    assert.ok(own.design.layers.some((l) => l.kind === 'text' && l.role === 'offer' && l.text === '50% off everything'));
});

check('a layer that is not on the design changes nothing', () => {
    const c = designEditFromUiElement({ type: 'design_edit', briefId: 4, optionId: 9, changes: [{ layer: 'nope', color: '#000000' }] })!;
    assert.strictEqual(applyDesignEdit(stored(), c).applied, 0);
});

check('the chat sees the design in words, with each part named the way a card names it', () => {
    const s = designForChat(stored());
    assert.ok(s.includes('page colour #f2aa00') && s.includes('headline "Launch party"') && s.includes('background #14243a at 100%'));
});

// ── The questions go straight to the design ───────────────────────────────────────────────────────

check('an AI picture is only made when the user\'s own latest answers chose it', () => {
    const answers = (pick: string) => `My answers:\nWhat should it be made from?: ${pick}`;
    assert.strictEqual(userChoseAiPicture([], answers(AI_PICTURE_ANSWER)), true);
    assert.strictEqual(userChoseAiPicture([], answers('A stock photo (free)')), false);
    // The model saying it never counts.
    assert.strictEqual(userChoseAiPicture([{ role: 'assistant', content: AI_PICTURE_ANSWER }], 'yes please'), false);
    // An earlier design's AI answer never pays for a later free one.
    assert.strictEqual(userChoseAiPicture([{ role: 'user', content: answers(AI_PICTURE_ANSWER) }, { role: 'user', content: answers('Just words and colours (free)') }], 'go on'), false);
    // Nor once they skipped the later questions.
    assert.strictEqual(userChoseAiPicture([{ role: 'user', content: answers(AI_PICTURE_ANSWER) }, { role: 'user', content: 'Skip the questions — use your best judgement from what you know about my business.' }], 'thanks'), false);
    // A follow-up after answering still counts the answers just given.
    assert.strictEqual(userChoseAiPicture([{ role: 'user', content: answers(AI_PICTURE_ANSWER) }], 'It is on 21 December'), true);
});

check('without that answer, only free sources start; AI video never starts from chat', () => {
    assert.deepStrictEqual(startableSources(['ai_image', 'stock', 'ai_video'], false), ['stock']);
    assert.deepStrictEqual(startableSources(['ai_image', 'stock', 'ai_video'], true), ['ai_image', 'stock']);
});

check('the route starts the design only on a "go" proposal, for this Brand Designer, with the user\'s own answer', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes("type === 'visual_brief_proposal' && (uiElement as { go?: unknown }).go === true"));
    assert.ok(chat.includes('aiChosen: userChoseAiPicture(history, message)'));
    assert.ok(chat.includes('eq(visualBriefs.id, req.briefId), eq(visualBriefs.organisationId, orgId)'));
    assert.ok(chat.includes('"${AI_PICTURE_ANSWER}" EXACTLY in those words'));
    const from = read('src/utils/brief-from-chat.ts');
    assert.ok(from.includes('enforcePromptModeration'), 'the same moderation as the button on a brief');
});

check('the browser opens the editor when a design starts, and a chat card changes the open design', () => {
    const session = read('src/components/chat-session.js');
    assert.ok(session.includes("startedUi.type === 'design_started'") && session.includes("'brief:openStudio'"));
    assert.ok(session.includes("action: 'apply_design_edit'"));
    const registry = read('src/components/disruptive-ui-registry.js');
    assert.ok(registry.includes("register('design_started'") && registry.includes("register('design_edit'"));
    assert.ok(read('workspace.html').includes('<script src="/src/components/design-studio.js"></script>'));
});

check('a flyer never starts with no words: "No words" is not offered for one, and its title becomes the headline', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('ONLY when it is not a printed flyer or poster, "No words"'));
    const from = read('src/utils/brief-from-chat.ts');
    assert.ok(from.includes("n.brief.purpose === FLYER_PURPOSE && !n.brief.flyerContent") && from.includes('normaliseFlyerContent({ headline: n.brief.title })'));
});

check('New brief opens a new conversation every time (owner 2026-11-05)', () => {
    const pane = read('src/components/chat-pane.js');
    assert.ok(pane.includes('sendFresh(text) {') && pane.includes('if (fresh) pane.sendFresh(text)'));
    assert.ok(read('src/components/assistant-briefs.js').includes("askChat('I need a new brief.', { fresh: true })"));
});

check('a resize never shows "Something went wrong": the editor sizes the page a frame later, and the catcher ignores the note', () => {
    // Owner 2026-11-05: adding words showed "ResizeObserver loop completed with undelivered notifications".
    const studio = read('src/components/design-studio.js');
    assert.ok(studio.includes('if (!w || w === roWidth) return;') && studio.includes('requestAnimationFrame(onResize);'));
    assert.ok(!studio.includes('new ResizeObserver(onResize)'), 'never resize from inside the callback');
    assert.ok(read('workspace.html').includes("if (/^ResizeObserver loop/.test(ev.message)) return;"));
});

// ── What prints is what was dragged ──────────────────────────────────────────────────────────────

check('a flyer becomes layers, and a changed design draws to a preview and print PDFs', async () => {
    const kit = normalizeBrandKit({ primaryColor: '#f2aa00', textColor: '#14243a', backgroundColor: '#ffffff', wordmark: 'BRIGHTSIDE', source: 'manual' });
    const n = normaliseFlyerContent({ headline: 'Launch party', subheading: 'Come and celebrate', callToAction: 'Book your place', contact: { phone: '01632 960418' }, qr: { url: 'https://example.co.uk/' } });
    assert.ok(n.ok);
    const d = await flyerDesign({ content: n.content, kit, paperSize: 'A5', layout: 'type_only', photo: null, orgName: 'B', style: flyerPageStyle('type_only', '#f2aa00', kit) });
    const roles = d.layers.map((l) => l.role);
    for (const r of ['headline', 'subheading', 'callToAction', 'contact', 'qr', 'wordmark']) assert.ok(roles.includes(r), `has ${r}`);
    const moved = applyDesignEdit(d, { changes: [{ layer: 'headline', y: 0.1, boxFill: '#000000', boxOpacity: 0.5, color: '#ffffff' }], add: [] }).design;
    const png = await renderDesignPreview(moved, null);
    assert.ok(png.png.length > 1000 && png.width > 0 && png.height > png.width, 'a portrait preview');
    const pdf = await renderDesignPdfs({ design: moved, photo: null, title: 'Launch', bleedMm: 3 });
    assert.ok(pdf.home.subarray(0, 4).toString() === '%PDF' && pdf.printShop.subarray(0, 4).toString() === '%PDF');
});

Promise.all(pending).then(() => console.log(`\n${passed} passed`));
