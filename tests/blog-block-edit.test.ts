// tests/blog-block-edit.test.ts — Blog Studio's docked chat (owner 2026-11-05): "Select" a paragraph,
// the assistant proposes ONE replacement (blog_block_edit), "Use this" swaps exactly that part.
//
// Run:  npx tsx tests/blog-block-edit.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { blogBlockEditFromUiElement, replaceBlock, splitBlocks } from '../src/utils/blog-block-edit';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

const ARTICLE = '## Why fresh beans matter\n\nCoffee goes stale within weeks of roasting.\nMost supermarket bags are months old.\n\n- Taste\n- Smell\n\n```\ncode block\n\nstill code\n```\n\nThanks for reading.';

check('blocks split like the editor: blank lines, but never inside a code fence', () => {
    assert.deepStrictEqual(splitBlocks(ARTICLE), ['## Why fresh beans matter', 'Coffee goes stale within weeks of roasting.\nMost supermarket bags are months old.', '- Taste\n- Smell', '```\ncode block\n\nstill code\n```', 'Thanks for reading.']);
});

check('only the selected block changes; spacing differences in the quote are forgiven', () => {
    const out = replaceBlock(ARTICLE, 'Coffee goes stale within weeks of roasting. Most supermarket bags are months old.', 'Coffee loses its flavour within weeks of roasting — and most supermarket bags are months old.');
    assert.ok(out);
    const before = splitBlocks(ARTICLE); const after = splitBlocks(out!);
    assert.strictEqual(after[1], 'Coffee loses its flavour within weeks of roasting — and most supermarket bags are months old.');
    assert.deepStrictEqual([after[0], after[2], after[3], after[4]], [before[0], before[2], before[3], before[4]], 'the rest word for word');
    assert.ok(replaceBlock(ARTICLE, '## Why fresh beans matter', '## Why fresh beans taste better')!.startsWith('## Why fresh beans taste better\n\n'));
});

check('nothing changes when the part isn\'t there, is ambiguous, or the replacement is empty', () => {
    assert.strictEqual(replaceBlock(ARTICLE, 'a sentence that was never written', 'x'), null);
    assert.strictEqual(replaceBlock('Same.\n\nSame.', 'Same.', 'Different.'), null, 'two identical blocks: refuse rather than guess');
    assert.strictEqual(replaceBlock(ARTICLE, 'Thanks for reading.', '   '), null);
});

check('the server refuses a live article and is tenant-scoped; the studio applies it in its editor when open', () => {
    const fn = read('netlify/functions/blog-block-edit.ts');
    assert.ok(fn.includes('requireTenant(event, db)') && fn.includes('eq(blogPosts.organisationId, ctx.organisationId)'));
    assert.ok(fn.includes("post.status === 'published'"));
    const studio = read('src/components/blog-studio-modal.js');
    assert.ok(studio.includes("document.addEventListener('blog:applyBlockEdit'") && studio.includes('state.editor.replaceBlockText(d.find, d.replace)'));
    assert.ok(studio.includes("message: 'About this part of my article #' + state.postId + ': the ' + kind"));
    assert.ok(studio.includes("state.chatPane = window.ChatPane.mount(el('bs-chat-host'), {"));
    const session = read('src/components/chat-session.js');
    assert.ok(session.includes("container.addEventListener('blog:blockEdit', onBlogBlockEdit);") && session.includes("container.removeEventListener('blog:blockEdit', onBlogBlockEdit);"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('blog_block_edit', renderBlogBlockEditCard);"));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('A PART THEY SELECTED') && chat.includes('"type": "blog_block_edit"'));
    assert.ok(read('src/components/markdown-editor.js').includes('replaceBlockText(find, replace) {'));
});

check('part of a block is swapped in place: a list keeps its line breaks', () => {
    const out = replaceBlock('Intro.\n\n- Taste\n- Smell\n- Price (per kg)', 'Smell', 'Aroma');
    assert.strictEqual(out, 'Intro.\n\n- Taste\n- Aroma\n- Price (per kg)');
    assert.strictEqual(replaceBlock('- Price (per kg)\n- Taste', 'Price (per kg)', 'Cost $1'), '- Cost $1\n- Taste', 'brackets and $ are plain text');
    assert.strictEqual(replaceBlock('One two\nthree.', 'two three', 'x'), 'One x.', 'whitespace-blind across a line break');
});

check('the card is checked and rebuilt: only its own fields, nothing without a part and a replacement', () => {
    assert.deepStrictEqual(
        blogBlockEditFromUiElement({ type: 'blog_block_edit', postId: '#41', find: ' Old. ', replace: ' New. ', summary: ' Why ', extra: 'dropped' }),
        { type: 'blog_block_edit', postId: 41, find: 'Old.', replace: 'New.', summary: 'Why' });
    assert.strictEqual(blogBlockEditFromUiElement({ type: 'blog_block_edit', postId: 41, find: 'Old.', replace: '  ' }), null);
    assert.strictEqual(blogBlockEditFromUiElement({ type: 'blog_block_edit', postId: 0, find: 'Old.', replace: 'New.' }), null);
    assert.strictEqual(blogBlockEditFromUiElement({ type: 'site_changes', postId: 41, find: 'Old.', replace: 'New.' }), null);
});

check('the blog route keeps the card (it rebuilds uiElement from a fixed list), and its words stay honest', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('blogAction ?? blogBlockEdit ?? pillarCard ?? profileCard'), 'the card is thrown away before it reaches the user');
    assert.ok(chat.includes('uiElement === blogBlockEdit'), 'the reply beside the card can claim the change is made');
    assert.ok(chat.includes('!blogAction && !blogBlockEdit && !profileCard && !pillarCard'), 'the reply is replaced by a "no draft" apology');
    assert.ok(chat.includes('eq(blogPosts.id, blogBlockReq.postId), eq(blogPosts.organisationId, orgId)'), 'a card for someone else\'s article');
});

check('a rewrite from the chat tells an open studio to save, lock and reload', () => {
    const session = read('src/components/chat-session.js');
    assert.ok(session.includes("'blog:rewriteStarting'") && session.includes("'blog:rewriteFinished'"));
    const studio = read('src/components/blog-studio-modal.js');
    assert.ok(studio.includes("document.addEventListener('blog:rewriteStarting'") && studio.includes("document.addEventListener('blog:rewriteFinished'"));
});

console.log(`\n${passed}/8 passed`);
