// tests/brand-style-chat.test.ts
// Love Cat Studio's feedback, 2026-11-05: the brand style is seen and changed inside the Brand Designer, and talked
// through in chat; a flyer can be changed from chat without its contact details ever coming from a model.
//
// Run:  npx tsx tests/brand-style-chat.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { brandStyleFromUiElement } from '../src/utils/chat-brand-style';
import { briefEditFromUiElement, mergeFlyerWords } from '../src/utils/chat-brief-edit';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

const saved = {
    headline: 'Old headline', subheading: 'Old sub', points: ['One'], offer: '10% off', callToAction: 'Call us', dateLine: null,
    contact: { phone: '01632 960418', email: null, website: 'example.co.uk', address: null }, qr: { url: 'https://example.co.uk/', label: null },
};

console.log('brand style card');
check('only real colours and a font name that could go in a URL survive', () => {
    const c = brandStyleFromUiElement({ type: 'brand_style_proposal', primaryColor: '#FF6FA8', textColor: 'pink', fontFamily: 'Playfair Display', summary: ' Soft and elegant ' });
    assert.deepStrictEqual(c, { type: 'brand_style_proposal', summary: 'Soft and elegant', primaryColor: '#ff6fa8', fontFamily: 'Playfair Display' });
    assert.strictEqual(brandStyleFromUiElement({ type: 'brand_style_proposal', fontFamily: 'x&url=evil.com/a' }), null);
    assert.strictEqual(brandStyleFromUiElement({ type: 'brand_style_proposal', primaryColor: 'javascript:1' }), null);
    assert.strictEqual(brandStyleFromUiElement({ type: 'other', primaryColor: '#ffffff' }), null);
});

console.log('changing a flyer from chat');
check('the words change; the offer, contact details and QR link stay as saved', () => {
    const m = mergeFlyerWords(saved, { headline: 'New headline', points: ['A', 'B'] })!;
    assert.strictEqual(m.headline, 'New headline');
    assert.deepStrictEqual(m.points, ['A', 'B']);
    assert.strictEqual(m.subheading, 'Old sub');
    assert.strictEqual(m.offer, '10% off');
    assert.strictEqual(m.contact.phone, '01632 960418');
    assert.strictEqual(m.qr?.url, 'https://example.co.uk/');
});
check('a model cannot write contact details, an offer or a QR link through this', () => {
    const m = mergeFlyerWords(saved, { headline: 'Call 01632 960999 now', callToAction: 'Visit www.other.example', offer: 'FREE', contact: { phone: '01632 960000' }, qr: { url: 'https://evil.example' }, subheading: 'Fine words' })!;
    assert.strictEqual(m.headline, 'Old headline');
    assert.strictEqual(m.callToAction, 'Call us');
    assert.strictEqual(m.offer, '10% off');
    assert.strictEqual(m.contact.phone, '01632 960418');
    assert.strictEqual(m.qr?.url, 'https://example.co.uk/');
    assert.strictEqual(m.subheading, 'Fine words');
    assert.strictEqual(mergeFlyerWords(saved, { phone: '123' }), null);
});
check('a card carrying only words still reaches the merge', () => {
    assert.ok(briefEditFromUiElement({ type: 'visual_brief_edit', briefId: 5, flyerWords: { headline: 'x' } }));
    assert.strictEqual(briefEditFromUiElement({ type: 'visual_brief_edit', briefId: 5 }), null);
});
check('the server refuses a finished flyer, and a card with nothing valid in it', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(o.includes("!(isFlyer && brief.status === 'approved')"));
    assert.ok(o.includes("if (briefEdit && !flyerContent && !['message', 'mood', 'mustInclude', 'mustAvoid']"));
});

console.log('the prompt and the surfaces');
const prompt = read('netlify/functions/chat-orchestrator.ts');
check('the questions decide the design, which then starts with no card to confirm (owner 2026-11-05)', () => {
    for (const s of ['STARTING A NEW DESIGN', 'What do you need it for?', 'A printed flyer or poster', 'A short video clip', 'What should it be made from?', 'emit a visual_brief_proposal with "go": true', 'Choose the design yourself']) assert.ok(prompt.includes(s), s);
});
check('the chat talks style through, never calls an unset kit their brand, and never says it saved', () => {
    assert.ok(prompt.includes('THEIR BRAND STYLE') && prompt.includes('never describe that as their brand') && prompt.includes('so never say it has been saved'));
    assert.ok(read('src/utils/visual-briefs.ts').includes('no brand colours chosen yet, so designs use our black and white default'));
    assert.ok(prompt.includes('(!!brandStyle && uiElement === brandStyle)'), 'the reply cannot claim it is done');
});
check('Edit no longer leaves the page when the pop-up is there; the pop-up saves only what changed', () => {
    const tab = read('src/components/assistant-briefs.js');
    assert.ok(tab.includes('window.BrandStyleDialog.open(') && !tab.includes('data-brief-edit-guidelines'));
    const dlg = read('src/components/brand-style-dialog.js');
    assert.ok(dlg.includes('if (Object.keys(kitPatch).length) await call(\'PATCH\', kitPatch);') && dlg.includes('if (gChanged) await call('));
});
check('both places that set the font use the picker, and the page loads it', () => {
    const assets = read('assets.html');
    assert.ok(assets.includes('window.FontPicker.mount(el(\'bk-font-picker\')') && !assets.includes('type="text" id="bk-fontFamily"'));
    const ws = read('workspace.html');
    assert.ok(ws.indexOf('font-picker.js') > 0 && ws.indexOf('font-picker.js') < ws.indexOf('assistant-briefs.js') && ws.includes('brand-style-dialog.js'));
});
check('one list of fonts', () => {
    assert.ok(read('src/components/font-picker.js').includes('window.BlogFonts'));
    assert.ok(read('workspace.html').indexOf('platform-constants.js') < read('workspace.html').indexOf('font-picker.js'));
});

console.log(`\n${passed} checks passed`);
