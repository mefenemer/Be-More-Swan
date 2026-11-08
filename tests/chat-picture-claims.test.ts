// tests/chat-picture-claims.test.ts — the Website Assistant may not say it is making or adding a
// picture: only its site_picture card does, on a click (staging 2026-11-05, verbatim replies below).
//
// Run:  npx tsx tests/chat-picture-claims.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pictureReply, replyClaimsPicture } from '../src/utils/confirm-card-reply';

let passed = 0;
const check = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; } };

check('the staging reply that promised a picture nobody made is caught', () => {
    const live = 'I\'m generating a dramatic film or cinema scene for that section now. Once it\'s created, I\'ll add it to your site and show you where it lands.';
    assert.ok(replyClaimsPicture(live), 'the verbatim staging reply');
    assert.ok(replyClaimsPicture('I\'m generating an image of a dramatic film scene for that section now. Once it\'s created, I\'ll add it to your site.'));
    assert.ok(replyClaimsPicture('I\'ll create a picture for the Stories section and add it.'));
    assert.ok(replyClaimsPicture('I\'ve added a photo of a film set to the About page.'));
    assert.ok(replyClaimsPicture('I\'m creating a short video of the harbour for your hero now.'), 'videos too');
});

check('ordinary replies are kept', () => {
    for (const ok of [
        'I\'ll add it to your home page — approve the card below.',
        'Here are three pictures to choose from on the card below.',
        'Once it\'s ready, your draft appears in the preview.',
        'Your About page has no picture yet — want one?',
    ]) assert.ok(!replyClaimsPicture(ok), ok);
});

check('with the card the reply points at it; without, it says plainly nothing was made', () => {
    const claim = 'I\'m creating an image for that now.';
    assert.match(pictureReply(claim, true), /choose “Create with AI” or “Find stock photos” on the card below/);
    assert.match(pictureReply(claim, false), /Nothing has been made or added/);
    assert.strictEqual(pictureReply('Choose one on the card below.', true), 'Choose one on the card below.');
});

check('the orchestrator applies it to the Website Assistant, and the prompt asks for the card at once', () => {
    const chat = readFileSync(path.resolve(__dirname, '../netlify/functions/chat-orchestrator.ts'), 'utf8');
    assert.ok(chat.includes("content = pictureReply(content, cardType === 'site_picture');"));
    assert.ok(chat.includes('emit a site_picture card straight away'));
    assert.ok(chat.includes('NEVER say you are creating, generating, finding or adding it'));
});

console.log(`\n${passed}/4 passed`);
