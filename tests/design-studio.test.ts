// tests/design-studio.test.ts — the Brand Designer's editor (owner 2026-11-05: "preview on the left and chat pane on the
// right… change the background transparency, font, colours etc very much like in canva"). What a browser or a chat card
// sends is cleaned in src/utils/design-doc.ts; the questions go straight to a design in src/utils/brief-from-chat.ts.
//
// Run:  npx tsx tests/design-studio.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    applyDesignEdit, cropRect, designEditFromUiElement, designForChat, moveLayer, normaliseDesign, pageFill, type Design, type DesignLayer,
} from '../src/utils/design-doc';
import { AI_PICTURE_ANSWER, startableSources, userChoseAiPicture } from '../src/utils/brief-from-chat';
import { flyerDesign, imageSize, renderDesignPdfs, renderDesignPreview } from '../src/lib/design-render';
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

check('page transparency: cleaned from a browser, a design without it is solid, it fades to paper, and chat can set it', () => {
    assert.strictEqual(pageFill(stored()), '#f2aa00', 'a design from before this is untouched');
    assert.strictEqual(pageFill({ pageColor: '#000000', pageOpacity: 0.5 }), '#808080');
    assert.strictEqual(pageFill({ pageColor: '#14243a', pageOpacity: 0 }), '#ffffff');
    assert.strictEqual(normaliseDesign({ pageOpacity: 0.4, layers: [] }, stored()).pageOpacity, 0.4);
    assert.strictEqual(normaliseDesign({ pageOpacity: 9, layers: [] }, stored()).pageOpacity, 1);
    assert.strictEqual(normaliseDesign({ pageOpacity: 'x', layers: [] }, { ...stored(), pageOpacity: 0.3 }).pageOpacity, 0.3);
    const card = designEditFromUiElement({ type: 'design_edit', briefId: 4, optionId: 9, pageOpacity: 0.5 })!;
    assert.strictEqual(card.pageOpacity, 0.5);
    const { design, applied } = applyDesignEdit(stored(), card, { fromChat: true });
    assert.strictEqual(applied, 1);
    assert.strictEqual(design.pageOpacity, 0.5);
    assert.ok(designForChat(design).includes('page colour #f2aa00 at 50% strength'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"pageOpacity": 0.6'), 'the chat is told it can');
    assert.ok(read('src/components/disruptive-ui-registry.js').includes('ui.pageOpacity !== undefined'), 'a card with only this still draws');
});

// ── Pictures, shapes and the stack ───────────────────────────────────────────────────────────────

const picture = (id = 'p1'): DesignLayer => ({ id, kind: 'picture', role: 'picture', x: 0.2, y: 0.2, w: 0.5, h: 0.3, opacity: 1, ref: { source: 'own', storageKey: `org/1/${id}.jpg`, externalUrl: null, mimeType: 'image/jpeg', width: 800, height: 600 } });
const withPicture = (): Design => ({ ...stored(), layers: [...stored().layers, picture()] });

check('an added picture keeps the file the server gave it: a browser can move, crop and fade it, never point it elsewhere', () => {
    const d = normaliseDesign({ layers: [{ id: 'p1', kind: 'picture', x: 0.1, opacity: 0.5, crop: { zoom: 2, x: 0, y: 1 }, ref: { storageKey: 'org/2/secret.jpg', externalUrl: 'https://evil.example/x.jpg' } }] }, withPicture());
    const p = d.layers[0];
    assert.ok(p.kind === 'picture');
    assert.strictEqual(p.ref.storageKey, 'org/1/p1.jpg');
    assert.strictEqual(p.ref.externalUrl, null);
    assert.strictEqual(p.x, 0.1);
    assert.strictEqual(p.opacity, 0.5);
    assert.deepStrictEqual(p.crop, { zoom: 2, x: 0, y: 1 });
});

check('a browser cannot invent a picture, or copy one from anywhere but this design', () => {
    const invented = normaliseDesign({ layers: [{ id: 'mine', kind: 'picture', x: 0, y: 0, w: 1, h: 1, ref: { storageKey: 'org/2/secret.jpg' } }] }, withPicture());
    assert.ok(!invented.layers.some((l) => l.id === 'mine'));
    const stranger = normaliseDesign({ layers: [{ id: 'mine', kind: 'picture', copyOf: 'nope', ref: { storageKey: 'org/2/secret.jpg' } }] }, withPicture());
    assert.ok(!stranger.layers.some((l) => l.id === 'mine'));
    const copy = normaliseDesign({ layers: [{ id: 'p1', kind: 'picture' }, { id: 'mine', kind: 'picture', copyOf: 'p1', ref: { storageKey: 'org/2/secret.jpg' } }] }, withPicture());
    const c = copy.layers.find((l) => l.id === 'mine');
    assert.ok(c && c.kind === 'picture' && c.ref.storageKey === 'org/1/p1.jpg', 'a duplicate is of the held file');
    const ofPhoto = normaliseDesign({ photo: {}, layers: [{ id: 'mine', kind: 'picture', copyOf: 'photo', x: 0 }] }, stored());
    const m = ofPhoto.layers[0];
    assert.ok(m.kind === 'picture' && m.ref.storageKey === ref.storageKey, 'the main picture can be duplicated');
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, kind: 'picture', copyOf: 'p1' }));
    assert.strictEqual(normaliseDesign({ layers: many }, withPicture()).layers.length, 6, 'at most six added pictures');
});

check('a held layer taken off goes on the shelf, and can come back with its own file on the next save (Undo)', () => {
    const off = normaliseDesign({ layers: [] }, withPicture());
    assert.deepStrictEqual(off.removed?.layers.map((l) => l.id).sort(), ['p1', 'qr']);
    assert.strictEqual(off.removed?.photo?.ref.storageKey, ref.storageKey, 'the main picture too');
    const back = normaliseDesign({ photo: { x: 0 }, layers: [{ id: 'p1', kind: 'picture' }, { id: 'qr', kind: 'qr', src: 'https://evil.example/qr.png' }] }, off);
    const p = back.layers.find((l) => l.id === 'p1');
    const q = back.layers.find((l) => l.id === 'qr');
    assert.ok(p && p.kind === 'picture' && p.ref.storageKey === 'org/1/p1.jpg');
    assert.ok(q && q.kind === 'qr' && q.src === 'data:image/png;base64,AAAA', 'never the address a browser sent');
    assert.strictEqual(back.photo?.ref.storageKey, ref.storageKey);
    assert.strictEqual(back.removed?.layers.length, 0);
    assert.strictEqual(back.removed?.photo, null);
});

check('a new shape can be made, words and shapes only: nothing in a shape points anywhere', () => {
    const d = normaliseDesign({ layers: [{ id: 's1', kind: 'shape', round: true, color: 'url(x)', x: 0.1, y: 0.1, w: 0.2, h: 0.1, opacity: 0.5, src: 'https://evil.example/x.png' }] }, stored());
    const s = d.layers[0];
    assert.ok(s.kind === 'shape' && s.round && s.role === 'circle' && s.opacity === 0.5 && s.color === '#1f1e1b');
    assert.ok(!('src' in s));
});

check('italic, underline and line spacing are kept and held in range, and an old layer stays as it was', () => {
    const d = normaliseDesign({ layers: [{ id: 'headline', kind: 'text', italic: true, underline: true, lineHeight: 9 }, { id: 'contact', kind: 'text' }] }, stored());
    const [h, c] = d.layers;
    assert.ok(h.kind === 'text' && h.italic === true && h.underline === true && h.lineHeight === 3);
    assert.ok(c.kind === 'text' && !c.italic && !c.underline && c.lineHeight === 1.25);
});

check('the crop sum: always covers the frame, and zoom and position say which part shows', () => {
    // A 2:1 picture in a square frame: as tall as the frame, with half its width spare.
    const mid = cropRect(200, 100, 100, 100);
    assert.deepStrictEqual(mid, { left: -50, top: 0, width: 200, height: 100 });
    assert.strictEqual(Math.abs(cropRect(200, 100, 100, 100, { zoom: 1, x: 0, y: 0.5 }).left), 0);
    assert.strictEqual(cropRect(200, 100, 100, 100, { zoom: 1, x: 1, y: 0.5 }).left, -100);
    const zoomed = cropRect(200, 100, 100, 100, { zoom: 2, x: 0.5, y: 0.5 });
    assert.strictEqual(zoomed.width, 400);
    assert.strictEqual(zoomed.top, -50);
    // The browser draws the same thing from a zoomed box: see cropStyle in design-studio.js.
    assert.ok(read('src/components/design-studio.js').includes('left:${-(c.zoom - 1) * c.x * 100}%'));
});

check('layer order moves one step or to either end, and the end of the list is the front', () => {
    const ids = (l: DesignLayer[]) => l.map((x) => x.id).join();
    const list = () => [picture('a'), picture('b'), picture('c')];
    const t = (id: string, o: Parameters<typeof moveLayer>[2]) => { const l = list(); moveLayer(l, id, o); return ids(l); };
    assert.strictEqual(t('a', 'front'), 'b,c,a');
    assert.strictEqual(t('c', 'back'), 'c,a,b');
    assert.strictEqual(t('a', 'forward'), 'b,a,c');
    assert.strictEqual(t('c', 'backward'), 'a,c,b');
    assert.strictEqual(t('c', 'forward'), 'a,b,c');
    assert.strictEqual(t('a', 'backward'), 'a,b,c');
});

check('the chat can do the same: shapes, order, duplicate, crop, styles and put back, on a rebuilt card', () => {
    const card = designEditFromUiElement({
        type: 'design_edit', briefId: 4, optionId: 9, photoCrop: { zoom: 2, x: 0.1, y: 0.9 }, putBack: ['logo', 'bad id!'],
        shapes: [{ shape: 'line', y: 0.6, color: '#ff0000' }, { shape: 'hexagon' }],
        changes: [
            { layer: 'p1', crop: { zoom: 3, x: 0, y: 0 }, opacity: 0.4, order: 'back', duplicate: true, src: 'https://evil.example' },
            { layer: 'headline', italic: true, underline: true, lineHeight: 1.6, order: 'sideways' },
        ],
    })!;
    assert.deepStrictEqual(card.putBack, ['logo']);
    assert.strictEqual(card.shapes?.length, 1);
    const base: Design = { ...withPicture(), removed: { layers: [{ id: 'logo', kind: 'logo', role: 'logo', x: 0, y: 0, w: 0.3, h: 0.1, src: 'https://example.com/l.png' }], photo: null } };
    const { design } = applyDesignEdit(base, card, { fromChat: true });
    assert.deepStrictEqual(design.photo?.crop, { zoom: 2, x: 0.1, y: 0.9 });
    assert.ok(design.layers.some((l) => l.kind === 'logo'));
    assert.strictEqual(design.removed?.layers.length, 0);
    assert.ok(design.layers.some((l) => l.kind === 'shape' && l.role === 'line' && l.color === '#ff0000'));
    assert.strictEqual(design.layers[0].id, 'p1', 'sent to the back');
    const p = design.layers[0];
    assert.ok(p.kind === 'picture' && p.crop?.zoom === 3 && p.opacity === 0.4 && p.ref.storageKey === 'org/1/p1.jpg');
    assert.strictEqual(design.layers.filter((l) => l.kind === 'picture').length, 2, 'duplicated');
    const h = design.layers.find((l) => l.role === 'headline');
    assert.ok(h && h.kind === 'text' && h.italic === true && h.underline === true && h.lineHeight === 1.6);
    assert.ok(!('order' in (h as object)) && !('duplicate' in (h as object)), 'no stray fields on a text layer');
    assert.ok(designForChat(design).includes('picture (layer "p1")'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"+ Add picture"'), 'the chat says where a new picture is added');
    assert.ok(read('src/components/disruptive-ui-registry.js').includes('Array.isArray(ui.shapes)'));
});

check('a chat removal shelves a held layer, so it can come back', () => {
    const { design } = applyDesignEdit(withPicture(), { changes: [{ layer: 'qr', remove: true }], add: [] });
    assert.deepStrictEqual(design.removed?.layers.map((l) => l.id), ['qr']);
});

check('imageSize reads a PNG and a JPEG from their own bytes', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAAAAAAAAAA=', 'base64');
    assert.deepStrictEqual(imageSize(png), { width: 2, height: 3 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 1, 1, 0, 0]);
    assert.deepStrictEqual(imageSize(jpg), { width: 40, height: 30 });
    assert.strictEqual(imageSize(Buffer.from('not a picture at all, sorry')), null);
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

check('added pictures, crops, shapes and text styles draw to a preview and print PDFs', async () => {
    const { Resvg } = await import('@resvg/resvg-js');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="200" height="200" fill="#ff0000"/><rect x="200" width="200" height="200" fill="#0000ff"/></svg>';
    const bytes = Buffer.from(new Resvg(svg).render().asPng());
    const file = { bytes, mimeType: 'image/png', width: 400, height: 200 };
    const base: Design = {
        v: 1, kind: 'flyer', pageW: 148, pageH: 210, paperSize: 'A5', pageColor: '#ffffff', photo: null,
        layers: [
            { id: 'p1', kind: 'picture', role: 'picture', x: 0, y: 0, w: 0.5, h: 0.5, opacity: 1, ref: { storageKey: 'k', externalUrl: null, mimeType: 'image/png', width: 400, height: 200 }, crop: { zoom: 1, x: 0, y: 0.5 } },
            { id: 's1', kind: 'shape', role: 'shape', x: 0.6, y: 0.6, w: 0.2, h: 0.1, color: '#00ff00', round: false, opacity: 1 },
            { id: 't', kind: 'text', role: 'text', text: 'Slanted', x: 0.1, y: 0.8, w: 0.8, fontFamily: null, fontSizePct: 0.05, bold: true, italic: true, underline: true, lineHeight: 1.6, align: 'left', color: '#000000', boxFill: null, boxOpacity: 1 },
        ],
    };
    // Cropped to the picture's left: the frame shows red, and never its blue half.
    const left = await renderDesignPreview(base, null, new Map([['p1', file]]));
    const right = await renderDesignPreview({ ...base, layers: base.layers.map((l) => (l.kind === 'picture' ? { ...l, crop: { zoom: 1, x: 1, y: 0.5 } } : l)) }, null, new Map([['p1', file]]));
    assert.ok(!left.png.equals(right.png), 'the crop changes what is drawn');
    const noPicture = await renderDesignPreview(base, null);
    assert.ok(!noPicture.png.equals(left.png), 'the picture is drawn only when its file is there');
    const pdf = await renderDesignPdfs({ design: base, photo: null, pictures: new Map([['p1', file]]), title: 'T', bleedMm: 3 });
    assert.ok(pdf.printShop.subarray(0, 4).toString() === '%PDF' && pdf.home.length > 1000);
});

Promise.all(pending).then(() => console.log(`\n${passed} passed`));
