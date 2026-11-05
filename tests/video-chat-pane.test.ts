// tests/video-chat-pane.test.ts — the Video Producer's docked chat (owner 2026-11-05). The browser side is
// e2e/videos-chat.spec.ts, with the model and every function stubbed, so what only the server does is here.
//
// Run:  npx tsx tests/video-chat-pane.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { videoSceneCard, videoSceneRequestFromUiElement } from '../src/utils/chat-video-scene';
import type { Storyboard } from '../src/lib/storyboard';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

const chat = read('netlify/functions/chat-orchestrator.ts');
const sb = { title: 't', caption: 'c', scenes: [
    { id: 'a', beat: 'hook', source: 'stock_video', voiceover: 'First line.', onScreenText: 'Hi', keywords: 'coffee' },
    { id: 'b', beat: 'value', source: 'ai_image', voiceover: 'Second line.', prompt: 'a cup' },
] } as unknown as Storyboard;
const req = (ui: Record<string, unknown>) => videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 21, ...ui })!;

check('the request is shape-checked: nothing else the model sends gets through', () => {
    const r = req({ scene: 1, voiceover: ' New. ', assetId: 9, estimate: 0, summary: ' Why ' });
    assert.deepStrictEqual(r, { projectId: 21, scene: 1, summary: 'Why', voiceover: 'New.' });
    assert.strictEqual(videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 21, scene: 1 }), null, 'nothing to change');
    assert.strictEqual(videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 0, scene: 1, voiceover: 'x' }), null);
    assert.strictEqual(videoSceneRequestFromUiElement({ type: 'video_replan_proposal', projectId: 21, scene: 1, voiceover: 'x' }), null);
});

check('a source that needs their own picture is not offered', () => {
    assert.strictEqual(req({ scene: 1, source: 'product_photo', voiceover: 'x' }).source, undefined);
    assert.strictEqual(videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 21, scene: 1, source: 'product_photo' }), null);
});

check('the card names the real scene, and shows what is there now, not what the model says', () => {
    const c = videoSceneCard(req({ scene: 1, voiceover: 'New.', now: { voiceover: 'A lie' } }), sb)!;
    assert.strictEqual(c.sceneId, 'a');
    assert.deepStrictEqual(c.now, { voiceover: 'First line.', onScreenText: 'Hi' });
    assert.deepStrictEqual(c.patch, { voiceover: 'New.' });
});

check('no such scene, or nothing that would change, is no card', () => {
    assert.strictEqual(videoSceneCard(req({ scene: 3, voiceover: 'New.' }), sb), null);
    assert.strictEqual(videoSceneCard(req({ scene: 1, voiceover: 'First line.' }), sb), null);
    assert.strictEqual(videoSceneCard(req({ scene: 1, voiceover: 'New.' }), null), null);
});

check('what to show goes where that source reads it', () => {
    assert.deepStrictEqual(videoSceneCard(req({ scene: 1, picture: 'beans' }), sb)!.patch, { keywords: 'beans' });
    assert.deepStrictEqual(videoSceneCard(req({ scene: 2, picture: 'a mug' }), sb)!.patch, { prompt: 'a mug' });
    assert.deepStrictEqual(videoSceneCard(req({ scene: 1, source: 'ai_video', picture: 'a mug' }), sb)!.patch, { source: 'ai_video', prompt: 'a mug' });
});

check('on-screen words can be taken off', () => {
    assert.deepStrictEqual(videoSceneCard(req({ scene: 1, onScreenText: '' }), sb)!.patch, { onScreenText: '' });
});

check('the card is only for this workspace\'s video, while it can still be changed; its words stay honest', () => {
    assert.ok(chat.includes('eq(videoProjects.id, req.projectId), eq(videoProjects.organisationId, orgId)'));
    assert.ok(chat.includes("['planned', 'failed'].includes(project.status)"));
    assert.ok(chat.includes('(!!sceneEdit && uiElement === sceneEdit)'), 'the reply can claim the change is made');
});

check('the model sees the scenes it is asked to change', () => {
    assert.ok(read('src/utils/video-producer.ts').includes('• scene ${i + 1} (${s.beat}, ${s.source}): voiceover'));
});

check('a chat card never spends: the click is `edit_scene`, and only that', () => {
    const session = read('src/components/chat-session.js');
    const handler = session.slice(session.indexOf('function onVideoSceneEdit(e)'), session.indexOf('function onVideoCreate(e)'));
    assert.ok(handler.includes("action: 'edit_scene'"));
    assert.ok(!handler.includes("'build'"));
    assert.ok(session.includes("container.removeEventListener('video:sceneEdit', onVideoSceneEdit);"));
});

console.log(`\n${passed}/9 passed`);
