// tests/voiceover-everywhere.test.ts
// Voiceovers, captions and voice-timed text, reachable from the GUI AND from chat (owner, 2026-11-02):
// "The user should be able to chat this with their assistant to implement it or use the gui as
// standard", choose whether text follows the voice and how it is formatted, and choose from female
// and male voices in a range of languages.
//
// Pins: the chat card's request is checked and normalised before it is shown (a script, a real voice,
// a valid caption look); its click calls the SAME endpoint the post editor does; the Video Producer's
// brief carries the voice's language, the captions switch and the caption look from setup; and the
// render fingerprint changes when the look does (else a restyled post would reuse the old render).
//
// Run:  npx tsx tests/voiceover-everywhere.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { postActionFromUiElement } from '../src/utils/chat-post-action';
import { readBrief, withSetupDefaults } from '../src/utils/video-producer';
import { storyboardUserPrompt } from '../src/lib/storyboard';
import { voiceListForPrompt } from '../src/utils/chat-voice-options';
import { OFFERED_VOICES } from '../src/lib/tts';

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

check('a voiceover card needs a script; the voice and caption look are made valid', () => {
    assert.strictEqual(postActionFromUiElement({ type: 'post_action_proposal', action: 'voiceover', postId: 5 }), null, 'no script, no card');
    const r = postActionFromUiElement({
        type: 'post_action_proposal', action: 'voiceover', postId: '#5', script: '  **Pop in** this week https://x.y  ',
        voice: 'not_a_voice', captionStyle: { mode: 'word', size: 'gigantic' }, timeText: true,
    })!;
    assert.strictEqual(r.script, 'Pop in this week', 'cleaned like any voiceover script');
    assert.strictEqual(r.voice, 'british_woman', 'an invented voice becomes the default');
    assert.strictEqual(r.captions, true, 'captions on unless asked otherwise');
    assert.strictEqual(r.captionStyle!.mode, 'word');
    assert.strictEqual(r.captionStyle!.size, 'medium', 'an unknown size falls back');
    assert.strictEqual(r.timeText, true);
    const fr = postActionFromUiElement({ type: 'post_action_proposal', action: 'voiceover', postId: 5, script: 'Bonjour à tous', voice: 'fr_adina' })!;
    assert.strictEqual(fr.voice, 'fr_adina');
});

check('a captions card needs no script; time_text carries nothing else', () => {
    const c = postActionFromUiElement({ type: 'post_action_proposal', action: 'captions', postId: 9, captions: false })!;
    assert.strictEqual(c.captions, false);
    assert.strictEqual(c.script, null);
    const t = postActionFromUiElement({ type: 'post_action_proposal', action: 'time_text', postId: 9, script: 'ignored' })!;
    assert.strictEqual(t.action, 'time_text');
    assert.strictEqual((t as { script?: unknown }).script, undefined);
});

check('the card’s click goes through the post editor’s own endpoint', () => {
    const session = read('src/components/chat-session.js');
    const i = session.indexOf("d.action === 'voiceover' || d.action === 'captions' || d.action === 'time_text'");
    assert.ok(i > 0, 'chat-session handles the voice actions');
    const block = session.slice(i, i + 1800);
    assert.ok(block.includes("postActionCall('generate-voiceover'"), 'the same function the editor calls');
    assert.ok(block.includes("action: 'align'") && block.includes("action: 'captions'"));
    assert.ok(read('workspace.html').includes("JSON.stringify({ action: 'align', postId })"), 'the editor times text through the same action');
    // A reply beside an unpressed voice card must not claim it happened (confirm-card-reply.ts).
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes("['voiceover', 'captions', 'time_text'].includes(postAction.action)"));
});

check('the chat is told every offered voice and the caption choices', () => {
    const list = voiceListForPrompt();
    for (const v of OFFERED_VOICES) assert.ok(list.includes(v.id), v.id);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok((orch.match(/\$\{voiceOptionsBlock\(\)\}/g) || []).length >= 2, 'Social Media and Video Producer routes both carry the voice options');
    assert.ok(orch.includes('"voiceover" | "captions" | "time_text"'));
});

check('Video Producer: setup fills captions and their look; the brief keeps a real language only', () => {
    const b = withSetupDefaults({ message: 'Our autumn menu is here for everyone' }, { defaultCaptions: 'off', captionStyle: JSON.stringify({ position: 'top' }) });
    assert.strictEqual(b.captions, false);
    assert.deepStrictEqual(b.captionStyle, { position: 'top' });
    const r = readBrief({ ...b, language: 'xx' });
    assert.ok('brief' in r);
    if ('brief' in r) {
        assert.strictEqual(r.brief.language, null, 'an unknown language is dropped');
        assert.strictEqual(r.brief.captions, false);
        assert.strictEqual(r.brief.captionStyle!.position, 'top');
    }
    const fr = readBrief({ message: 'Notre menu d’automne est là', language: 'fr' });
    assert.ok('brief' in fr && fr.brief.language === 'fr');
});

check('a script in another language is asked for in that language', () => {
    const brief = { purpose: 'promo', lengthS: 30 as const, message: 'x'.repeat(20), voiceover: true, allowAi: 'stock_and_ai' as const };
    const p = storyboardUserPrompt({ brief, businessName: 'B', businessFacts: '', library: [], today: '2026-11-02', language: 'French' });
    assert.ok(p.includes('LANGUAGE: write every voiceover line, every onScreenText and the caption in French'));
    assert.ok(!storyboardUserPrompt({ brief, businessName: 'B', businessFacts: '', library: [], today: '2026-11-02', language: 'English' }).includes('LANGUAGE:'));
});

check('a restyled caption re-renders; the build passes the style and moves text off top captions', () => {
    const pr = read('src/lib/post-render.ts');
    assert.ok(pr.includes("a.captionStyle ? JSON.stringify(a.captionStyle) : ''"), 'the caption look is part of the render fingerprint');
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('captions: brief.captions !== false'));
    assert.ok(vp.includes("captionPosition === 'top' ? 0.7 : 0.2"));
});

console.log(`\n${passed} checks passed`);
