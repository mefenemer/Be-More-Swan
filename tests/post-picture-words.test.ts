// tests/post-picture-words.test.ts
// FR#6/7 (org 40, 2026-11-10): a user selected a post's picture and asked the assistant to change the
// words on it; told only "the picture", it could not. Now the selection carries the words (a branded
// card's own, or the photo's text boxes), and the post_text_edit card changes either — a card through
// the card editor's own save (edit-brand-card). Run:  npx tsx tests/post-picture-words.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { postPartCardFromUiElement } from '../src/utils/chat-post-parts';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const ws = read('workspace.html');

check('selecting the picture tells the assistant its words', () => {
    const at = ws.indexOf('function _pceChatPick(');
    const pick = ws.slice(at, ws.indexOf('_pceChatSync().then', at));
    assert.ok(pick.includes('It is a branded card; its words are'));
    assert.ok(pick.includes('Its text boxes:'));
    assert.ok(pick.includes('any words in it are part of the'));
});

check('the text-edit handler redraws a branded card through its own save', () => {
    const at = ws.indexOf("document.addEventListener('post:textEdit'");
    const h = ws.slice(at, ws.indexOf("document.addEventListener('post:pictureAsk'", at));
    assert.ok(h.includes('post.brandCard') && h.includes("_pceEl('pce-headline')"));
    assert.ok(h.includes('_pceFlushCardSave()'));
    assert.ok(h.indexOf('post.brandCard') < h.indexOf("That text box has changed since"), 'card checked before the text-box refusal');
    assert.ok(h.includes('d.replace.length > 120'));
    // The Wording box beside the picture shows the new words, not the old ones (staging check 2026-11-10).
    assert.ok(h.includes('_pceStyleMountedFor = null; _pceRenderTextStyle();'));
});

check('the card says what changed; the prompt covers the picture’s words', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('Change to the words on the picture') && reg.includes("say(message || 'Done — the text box is changed.')"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('"the picture" with its words listed, when they want those WORDS changed'));
});

check('a card-words edit is the same post_text_edit shape', () => {
    const c = postPartCardFromUiElement({ type: 'post_text_edit', postId: 7, find: 'Spring menu now on', replace: 'Summer menu now on' });
    assert.deepStrictEqual(c, { type: 'post_text_edit', postId: 7, find: 'Spring menu now on', replace: 'Summer menu now on', summary: null });
});

console.log(`\n${passed} passed, 0 failed\n`);
