// tests/repro-issue-95.test.ts — issue #95 (2026-11-26): "Text box outline colour won't change in post editor".
// The reporter asked the Social chat to make a text box's outline black; it said it could only change the
// words. The chat's post_text_edit card now carries a `style` (font colour, font, outline, background), and
// the chat is shown the open post's text boxes and how each looks. The browser half (the "Aa Style" door on
// the picture, the card applying a style) is e2e/repro-issue-95.spec.ts.
//
// Run:  npx tsx tests/repro-issue-95.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as parts from '../src/utils/chat-post-parts';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

check('"make the outline black": a style-only card survives, words untouched', () => {
    const card = parts.postPartCardFromUiElement({ type: 'post_text_edit', postId: 5727, find: 'Keep going', style: { boxStroke: 'black' }, summary: 'Black outline.' });
    assert.deepStrictEqual(card, { type: 'post_text_edit', postId: 5727, find: 'Keep going', style: { boxStroke: '#000000' }, summary: 'Black outline.' });
});

check('style is checked field by field: unknown font and bad colour dropped, null = off, opacity clamped', () => {
    const card = parts.postPartCardFromUiElement({ type: 'post_text_edit', postId: 1, find: 'Hi', style: {
        color: '#FFF', fontFamily: 'Papyrus', boxStroke: 'rgb(0,0,0)', boxFill: null, boxOpacity: 3, evil: '<script>',
    } }) as { style?: Record<string, unknown> } | null;
    assert.deepStrictEqual(card?.style, { color: '#ffffff', boxFill: null, boxOpacity: 1 });
    const impact = parts.postPartCardFromUiElement({ type: 'post_text_edit', postId: 1, find: 'Hi', style: { fontFamily: 'impact' } }) as { style?: Record<string, unknown> } | null;
    assert.deepStrictEqual(impact?.style, { fontFamily: 'Impact' });
    // Nothing usable left and no new words: no card at all, never a card that does nothing.
    assert.strictEqual(parts.postPartCardFromUiElement({ type: 'post_text_edit', postId: 1, find: 'Hi', style: { fontFamily: 'Papyrus' } }), null);
});

check('words-only cards keep their old shape exactly', () => {
    assert.deepStrictEqual(parts.postPartCardFromUiElement({ type: 'post_text_edit', postId: 41, find: 'Old', replace: 'New' }),
        { type: 'post_text_edit', postId: 41, find: 'Old', replace: 'New', summary: null });
});

check('the chat is shown the open post\'s text boxes, their words exactly and how each looks', () => {
    assert.strictEqual(typeof parts.describeTextBoxes, 'function', 'no way to list the boxes for the prompt');
    const lines = parts.describeTextBoxes([
        { id: 'a', text: 'Keep going', color: '#ffffff', fontFamily: 'Impact', boxStroke: null, boxFill: '#000000', boxOpacity: 0.5 },
        { id: 'b', text: '  ' },
        { id: 'c', text: 'Book now', boxStroke: '#EC4899' },
    ]);
    assert.deepStrictEqual(lines, [
        '“Keep going” (font colour #ffffff, font Impact, outline off, background #000000 at 50% opacity)',
        '“Book now” (font colour #ffffff, font Arial, outline #ec4899, background off)',
    ]);
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('imageOverlays: scheduledPosts.imageOverlays })'), 'the open post\'s boxes are never read');
    assert.ok(chat.includes('textBoxes: describeTextBoxes(targetRow.imageOverlays)'), 'the boxes never reach the prompt');
    assert.ok(chat.includes('ITS TEXT BOXES'), 'the prompt does not list the boxes');
    assert.ok(chat.includes('"boxStroke": "#rrggbb" or null (the box outline'), 'the prompt never offers the outline');
});

check('the card and the editor both carry the style through', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('(!replace && !style)'), 'the card is not drawn for a look-only change');
    assert.ok(reg.includes('replace: replace || null, style,'), 'the card never sends the style to the editor');
    const ws = read('workspace.html');
    assert.ok(ws.includes("const STYLE_KEYS = ['color', 'fontFamily', 'boxStroke', 'boxFill', 'boxOpacity'];"), 'the editor ignores the style');
    assert.ok(ws.includes('Object.assign(ov, before);'), 'a failed save leaves the new look on screen');
});

check('a box tapped on the picture offers its styling where the tap was', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes('_pcePaintCanvasStyleDoor(layer, nodes);'), 'tapping a box still offers nothing');
    const fn = ws.slice(ws.indexOf('function _pcePaintCanvasStyleDoor('), ws.indexOf('/** Watching the cut is not editing it. */'));
    assert.ok(fn.includes("b.setAttribute('data-pce-act', 'style-text');"), 'the door is not the same action as Aa');
    assert.ok(ws.includes('title="Font, colour, outline, background, emojis and animation"'), 'Aa still does not mention the outline');
    const times = ws.slice(ws.indexOf('function _rqApplyOverlayTimes('), ws.indexOf('// Paint a post\'s saved text overlays as a live layer'));
    assert.ok(times.includes("layer.querySelector('[data-pce-canvas-style]')"), 'the door floats over a video whose box is hidden at this moment');
    assert.ok(ws.includes('Its colours and font are set in the card’s own editor'), 'a style on a branded card is dropped without a word');
    assert.ok(read('src/components/image-overlay-editor.js').includes("sharedSect('look', 'Font, colour, outline and background'"),
        'the section holding the outline is still called "How it looks"');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
