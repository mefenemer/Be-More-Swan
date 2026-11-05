// tests/blog-add-images.test.ts
// "Add pictures" for an existing blog article (owner, 2026-11-04) — the pure parts: splitting the
// body without breaking columns or code, refusing bad spots, inserting without touching the words,
// carrying the request through the job brief, and the chat card shape.
// Run:  npx tsx tests/blog-add-images.test.ts

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { splitBlocks, cleanPlacements, insertPictures, MAX_ADDED_IMAGES } from '../src/utils/blog-add-images';
import { encodeInteractiveBrief, decodeInteractiveBrief } from '../src/utils/blog-interactive-brief';
import { blogActionFromUiElement } from '../src/utils/chat-blog-action';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const BODY = [
    '## Why it matters',
    'First paragraph about the subject.',
    ':::media{asset=7 type=image}',
    'Second paragraph.',
    '::::columns{cols=2}\n:::column\nLeft side.\n\nStill left.\n:::\n:::column\nRight.\n:::\n::::',
    '```\ncode\n\nmore code\n```',
    'Closing paragraph.',
].join('\n\n');

check('columns and fenced code stay whole even with blank lines inside', () => {
    const b = splitBlocks(BODY);
    assert.strictEqual(b.length, 7);
    assert.ok(b[4].text.startsWith('::::columns') && b[4].text.endsWith('::::') && b[4].media);
    assert.ok(b[5].text.startsWith('```') && !b[5].placeable);
    assert.ok(b[2].media && !b[2].placeable);
});

check('a spot next to an existing picture, on a non-text block, or repeated is refused', () => {
    const b = splitBlocks(BODY);
    const got = cleanPlacements([
        { after: 1, query: 'x' },        // block 2 is already a picture → refused
        { after: 2, query: 'x' },        // a picture itself → refused
        { after: 5, query: 'x' },        // code → refused
        { after: 6, query: 'end', alt: 'a "quoted" alt' },
        { after: 6, query: 'dup' },      // repeat → refused
        { after: 99, query: 'x' },       // out of range
        { after: 0, scene: 'a scene only' },
    ], b);
    assert.deepStrictEqual(got.map((p) => p.after), [0, 6]);
    assert.ok(!got[1].alt.includes('"'));
    assert.strictEqual(got[0].query, 'a scene only');   // a stock search still has words to use
    assert.strictEqual(got[0].scene, 'a scene only');
});

check('never more than the cap', () => {
    const b = splitBlocks(Array.from({ length: 10 }, (_, i) => `Para ${i}.`).join('\n\n'));
    const got = cleanPlacements(Array.from({ length: 10 }, (_, i) => ({ after: i, query: 'q' })), b);
    assert.strictEqual(got.length, MAX_ADDED_IMAGES);
});

check('inserting pictures keeps every word and adds only media lines', () => {
    const b = splitBlocks(BODY);
    const out = insertPictures(b, [{ after: 6, assetId: 42, alt: 'A view' }, { after: 0, assetId: 41, alt: '' }]);
    assert.strictEqual(out.replace(/\n*:::media\{asset=4[12][^}]*\}/g, ''), BODY.replace(/\n*$/, '') + '\n');
    assert.ok(out.includes(':::media{asset=42 type=image alt="A view"}'));
    assert.ok(out.indexOf('asset=41') > out.indexOf('## Why it matters') && out.indexOf('asset=41') < out.indexOf('First paragraph'));
});

check('the job brief carries the request, and an empty instruction means "you decide"', () => {
    const b = decodeInteractiveBrief(encodeInteractiveBrief({ topic: '', addImages: { source: 'ai', instruction: ' a café ' } }));
    assert.deepStrictEqual(b?.addImages, { source: 'ai', instruction: 'a café' });
    const blank = decodeInteractiveBrief(encodeInteractiveBrief({ topic: '', addImages: { source: 'stock' } }));
    assert.deepStrictEqual(blank?.addImages, { source: 'stock' });
    assert.strictEqual(decodeInteractiveBrief(encodeInteractiveBrief({ topic: '', addImages: { source: 'nope' as 'ai' } })), null);
});

check('the chat card: pictures needs no instruction, defaults to stock', () => {
    const r = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'pictures', postId: '#12' });
    assert.ok(r && r.action === 'pictures' && r.source === 'stock' && r.instruction === null);
    const ai = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'pictures', postId: 12, source: 'ai', instruction: 'two photos' });
    assert.strictEqual(ai?.source, 'ai');
    assert.strictEqual(ai?.instruction, 'two photos');
});

check('the blog Revise card has its own "What to change" box (it was in the social post card)', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    const blogCard = reg.slice(reg.indexOf('function renderBlogActionProposalCard'));
    const postCard = reg.slice(reg.indexOf('function renderPostActionProposalCard'), reg.indexOf('function renderBlogActionProposalCard'));
    assert.ok(blogCard.includes("ui.action === 'revise' ?") && blogCard.includes('data-bap-instruction'));
    assert.ok(!postCard.includes('data-bap-instruction'), 'the post card no longer carries the blog box');
    assert.ok(blogCard.includes("ui.action === 'pictures' ?"));
});

check('wired end to end: Studio button, request, worker, chat click', () => {
    assert.ok(read('src/components/blog-studio-modal.js').includes("addImages: { source: source"));
    assert.ok(read('netlify/functions/generate-blog.ts').includes('addImages,'));
    assert.ok(read('netlify/functions/process-blog-jobs.ts').includes('addImagesToBlog('));
    assert.ok(read('src/components/chat-session.js').includes("d.action === 'pictures'"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('| "pictures"'));
});

check('a blank AI image request in the Studio uses the article; the social box is optional', () => {
    assert.ok(read('netlify/functions/generate-ai-image.ts').includes('blogPostImageRequest(db, orgId'));
    const ws = read('workspace.html');
    assert.ok(ws.includes('id="gp-ai-gen-query"') && ws.includes('prompt: typed || _gpAiMediaPrompt || undefined'));
});

console.log(`\n${passed} passed, 0 failed\n`);
