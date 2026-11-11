// tests/post-chat-pane.test.ts — the social post editor's docked chat (owner 2026-11-05): "Select" the
// caption, the picture or a text box. The browser side is e2e/post-editor-chat.spec.ts, with the model and
// every function stubbed, so what only the server does is checked here.
//
// Run:  npx tsx tests/post-chat-pane.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { postPartCardFromUiElement } from '../src/utils/chat-post-parts';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

const chat = read('netlify/functions/chat-orchestrator.ts');

check('the text box card is rebuilt: only its own fields, nothing without a part and new words', () => {
    assert.deepStrictEqual(
        postPartCardFromUiElement({ type: 'post_text_edit', postId: '#41', find: ' Old ', replace: ' New ', summary: ' Why ', extra: 'dropped' }),
        { type: 'post_text_edit', postId: 41, find: 'Old', replace: 'New', summary: 'Why' });
    assert.strictEqual(postPartCardFromUiElement({ type: 'post_text_edit', postId: 41, find: 'Old', replace: '  ' }), null);
    assert.strictEqual(postPartCardFromUiElement({ type: 'post_text_edit', postId: 0, find: 'Old', replace: 'New' }), null);
});

check('the picture card is rebuilt: a blank description is allowed, anything but video is a picture', () => {
    assert.deepStrictEqual(postPartCardFromUiElement({ type: 'post_picture', postId: 41, description: '', kind: 'gif', spend: true }),
        { type: 'post_picture', postId: 41, kind: 'image', description: '' });
    assert.strictEqual((postPartCardFromUiElement({ type: 'post_picture', postId: 41, kind: 'video' }) as { kind: string }).kind, 'video');
    assert.strictEqual(postPartCardFromUiElement({ type: 'site_picture', postId: 41 }), null);
});

check('the cards reach the user: only for this workspace\'s post, only with a post open, never half-formed', () => {
    assert.ok(chat.includes('eq(scheduledPosts.id, postPartReq.postId), eq(scheduledPosts.organisationId, orgId)'), 'a card for someone else\'s post');
    assert.ok(/const \[post\] = draftTarget \? await db\.select/.test(chat), 'a card with no open post to act through');
    assert.ok(chat.includes('[POST_TEXT_EDIT_TYPE, POST_PICTURE_TYPE].includes('), 'a half-formed card stored and redrawn on every reload');
});

check('the words beside the cards stay honest', () => {
    assert.ok(chat.includes('!postActionReq && !postPartCard && !profileCard && !pillarCard && replyClaimsPostSaved(content)'), 'the reply beside the card is replaced by an apology');
    assert.ok(chat.includes('(!!postPartCard && uiElement === postPartCard)'), 'the reply can claim the change is made');
    assert.ok(chat.includes('postPartCard?.type === POST_PICTURE_TYPE) content = pictureReply(content, true)'), 'the reply can say it is making a picture');
});

check('the model is told what it is looking at, and what it can still do', () => {
    assert.ok(chat.includes('THE POST THEY HAVE OPEN is #${target.id}'), '"make it punchier" with no caption to work from');
    assert.ok(chat.includes('scheduledPosts.caption, hashtags: scheduledPosts.hashtags'), 'the caption is not read for the prompt');
    assert.ok(chat.includes('"type": "post_text_edit"') && chat.includes('"type": "post_picture"'));
    // With the docked chat this is every turn beside a post, so a voiceover or approve card must survive.
    assert.ok(chat.includes('const postActionReq = route === ROUTES.social_media_manager ? postActionFromUiElement(uiElement) : null;'), 'action cards dropped whenever a post is open');
});

check('a card pressed in the chat can\'t be undone by the open editor', () => {
    const session = read('src/components/chat-session.js');
    assert.ok(session.includes("'post:actionStarting'") && session.includes("'post:actionFinished'"));
    const html = read('workspace.html');
    assert.ok(html.includes("document.addEventListener('post:actionStarting'") && html.includes("document.addEventListener('post:actionFinished'"));
    assert.ok(html.includes('_rqOpenPostReview(_rqReviewPostId, { refresh: true })'), 'the editor keeps the old caption, and saves it back');
});

check('the docked chat keeps its own target: the pop-up clearing the global one can\'t turn drafts into new posts', () => {
    const session = read('src/components/chat-session.js');
    assert.ok(session.includes("typeof props.draftTarget === 'function' ? props.draftTarget() : window.ChatDraftTarget"));
    assert.ok(read('src/components/chat-pane.js').includes('draftTarget: opts.draftTarget,'));
    assert.ok(read('workspace.html').includes('draftTarget: () => window.ChatDockedDraftTarget,'));
});

console.log(`\n${passed}/7 passed`);
