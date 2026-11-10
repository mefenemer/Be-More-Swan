// tests/video-scene-text.test.ts
// Text on a Video Producer scene (docs/video-producer-manual-controls-plan.md Phase 2, 2026-11-10): where,
// when, look, appears — chosen on the Change form or a chat card, defaulting to what the build always did.
//
// Run:  npx tsx tests/video-scene-text.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readSceneText, textWindow, textLook, textFont, textY, defaultTextPos, inkOn, textMeetsCaptions } from '../src/lib/scene-text';
import { sceneOverlays } from '../src/utils/video-producer';
import { enforceStoryboard, type Scene, type Storyboard, type VideoBrief } from '../src/lib/storyboard';
import { videoSceneRequestFromUiElement, videoSceneCard } from '../src/utils/chat-video-scene';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const scene = (o: Partial<Scene>): Scene => ({ id: 's1', beat: 'hook', voiceover: 'Our summer roast is back.', source: 'stock_video', targetS: 5, onScreenText: 'Summer roast', ...o });

check('only valid values are read', () => {
    assert.deepStrictEqual(readSceneText({ textPos: 'middle', textWhen: 'words', textStyle: 'brand', textAnim: 'pop' }), { textPos: 'middle', textWhen: 'words', textStyle: 'brand', textAnim: 'pop' });
    assert.deepStrictEqual(readSceneText({ textPos: 'left', textWhen: 'forever', textStyle: '<b>', textAnim: 'spin' }), {});
    assert.deepStrictEqual(readSceneText(null), {});
});

check('with nothing chosen, the overlay is exactly what the build made before', () => {
    const [o] = sceneOverlays([scene({})], [5]);
    assert.deepStrictEqual({ y: o.y, font: o.fontFamily, color: o.color, fill: o.boxFill, op: o.boxOpacity, anim: o.anim, s: o.startS, e: o.endS },
        { y: 0.2, font: 'Impact', color: '#FFFFFF', fill: '#000000', op: 0.55, anim: 'rise', s: 0, e: 5 });
    assert.strictEqual(sceneOverlays([scene({})], [5], 'top')[0].y, 0.7, 'captions at the top push the words down, as before');
    assert.strictEqual(defaultTextPos('top'), 'bottom');
});

check('where, when, look and appears reach the overlay', () => {
    const words = [{ start: 1.0, end: 1.4 }, { start: 1.5, end: 2.6 }, { start: 6.0, end: 6.5 }];
    const [o] = sceneOverlays([scene({ textPos: 'middle', textWhen: 'words', textStyle: 'brand', textAnim: 'pop' })], [5], 'bottom',
        { style: 'bar', accent: '#ffd400', aspect: 9 / 16 }, { brandFont: 'Georgia', words });
    assert.strictEqual(o.y, textY('middle'));
    assert.deepStrictEqual([o.startS, o.endS], [1, 2.9], 'only this scene’s words, plus a beat');
    assert.strictEqual(o.boxFill, '#FFD400');
    assert.strictEqual(o.color, '#000000', 'black on a light brand colour');
    assert.strictEqual(o.anim, 'pop');
    assert.strictEqual(o.fontFamily, 'Georgia');
});

check('timing windows', () => {
    assert.deepStrictEqual(textWindow('first', 10, 8), { startS: 10, endS: 13 });
    assert.deepStrictEqual(textWindow('last', 10, 8), { startS: 15, endS: 18 });
    assert.deepStrictEqual(textWindow('last', 10, 2), { startS: 10, endS: 12 }, 'a short scene shows it throughout');
    assert.deepStrictEqual(textWindow(undefined, 0, 20, { ownVideo: true }), { startS: 0, endS: 3 }, 'a title over your own take, as before');
    assert.deepStrictEqual(textWindow('words', 4, 5, { spoken: null }), { startS: 4, endS: 9 }, 'no words heard → the whole scene');
});

check('looks, ink and font', () => {
    assert.deepStrictEqual(textLook('plain', null), { color: '#FFFFFF', boxFill: '#000000', boxOpacity: 0.25 });
    assert.deepStrictEqual(textLook('brand', 'not a colour'), textLook('dark', null), 'no brand colour → dark box');
    assert.strictEqual(inkOn('#1a1a2e'), '#FFFFFF');
    assert.strictEqual(textFont('Playfair Display'), 'Impact', 'a font the render lacks falls back');
    assert.strictEqual(textFont('georgia'), 'Georgia');
    assert.strictEqual(textFont(null), 'Impact');
    assert.ok(textMeetsCaptions('bottom', 'bottom', true) && !textMeetsCaptions('bottom', 'bottom', false));
});

check('the storyboard keeps them only with words, and a branded card never gets an overlay', () => {
    const brief = { message: 'x', lengthS: 15, voiceover: true, allowAi: 'stock_only', shape: '9:16' } as unknown as VideoBrief;
    const sb = { title: 't', caption: 'c', scenes: [
        { beat: 'hook', voiceover: 'a', source: 'stock_video', onScreenText: 'Hi', textPos: 'bottom', textAnim: 'fade', targetS: 5 },
        { beat: 'value', voiceover: 'b', source: 'stock_video', textPos: 'bottom', targetS: 5 },
        { beat: 'cta', voiceover: 'c', source: 'stock_video', onScreenText: 'Book', textStyle: 'neon', targetS: 5 },
    ] } as unknown as Storyboard;
    const out = enforceStoryboard(sb, brief, [], []).storyboard.scenes;
    assert.strictEqual(out[0].textPos, 'bottom'); assert.strictEqual(out[0].textAnim, 'fade');
    assert.strictEqual(out[1].textPos, undefined, 'no words, no placement');
    assert.strictEqual(out[2].textStyle, undefined, 'an unknown style is dropped');
    assert.strictEqual(sceneOverlays([scene({ source: 'brand_card', textPos: 'middle' })], [5]).length, 0);
});

check('edit_scene takes them and null clears one', () => {
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes("for (const k of ['textPos', 'textWhen', 'textStyle', 'textAnim'] as const) {"));
    assert.ok(fn.includes('const v = readSceneText({ [k]: patch[k] })[k];'));
    assert.ok(fn.includes("brand: { accent: kit.primaryColor, font: textFont(kit.fontFamily) },"), 'the tab gets the colour and font for its preview');
});

check('chat: the scene card carries them, only what changes, never on a branded card', () => {
    const sb = { title: 't', caption: 'c', scenes: [scene({ textPos: 'top' }), scene({ id: 's2', source: 'brand_card' })] } as unknown as Storyboard;
    const req = videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 4, scene: 1, textPos: 'top', textWhen: 'last', textStyle: 'glitter' })!;
    const card = videoSceneCard(req, sb)!;
    assert.deepStrictEqual(card.patch, { textWhen: 'last' }, 'top is already so; glitter is not a style');
    const onCard = videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 4, scene: 2, textPos: 'middle' })!;
    assert.strictEqual(videoSceneCard(onCard, sb), null);
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"textWhen": "scene" | "first" | "last" | "words"'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("textWhen: ['When they show',"));
});

check('the tab: a Text group with a preview, and moving scenes that play and say so', () => {
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('${textGroupHtml(v, s, thumb, isVideo)}'));
    assert.ok(tab.includes('data-vid-text-preview'));
    assert.ok(tab.includes("That’s where the captions are — the two would overlap."));
    assert.ok(tab.includes('data-vid-hoverplay'));
    assert.ok(tab.includes("'▶ Moving' : 'Still'"));
});

check('help section is guarded with no semicolons in its body', () => {
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzz-video-scene-text.sql');
    assert.ok(!sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).includes(';'));
    assert.ok(sql.includes("AND content_md NOT LIKE '%## Text on a scene%'"));
});

console.log(`\n${passed} passed`);
